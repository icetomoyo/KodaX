import type { KodaXMessage, KodaXTaskResultMetadata } from '@kodax-ai/llm';

/** Display facts; older deliveries may lack task identity or terminal status. */
export interface KodaXTaskResultReport extends Omit<KodaXTaskResultMetadata, 'taskId' | 'status' | 'summary'> {
  readonly taskId?: string;
  readonly status: KodaXTaskResultMetadata['status'] | 'unknown';
  readonly summary: string;
  readonly reportFormat: 'markdown';
}

type ResultMessage = Pick<KodaXMessage, 'content' | '_source' | '_taskResult' | '_taskResults'>;
interface LegacyReports {
  readonly reports: KodaXTaskResultReport[];
  readonly enveloped: boolean;
  readonly sourceHints: ReadonlyMap<KodaXTaskResultReport, KodaXTaskResultReport['source']>;
}

function status(value: unknown): KodaXTaskResultReport['status'] {
  if (value === 'interrupted') return 'cancelled';
  return value === 'completed' || value === 'failed' || value === 'cancelled' ? value : 'unknown';
}

/** Decode transport escaping once; literal entity text in a report stays literal. */
function decodeXml(text: string): string {
  const entities: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (entity, name: string) => entities[name] ?? entity);
}

function legacyReports(message: ResultMessage): LegacyReports {
  const sourceHints = new Map<KodaXTaskResultReport, KodaXTaskResultReport['source']>();
  if (message._source !== 'agent-completed' && message._source !== 'task-completed') return { reports: [], enveloped: false, sourceHints };
  const text = typeof message.content === 'string' ? message.content
    : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  const reports: KodaXTaskResultReport[] = [];
  const pattern = /<(agent-completed|task-completed)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of text.matchAll(pattern)) {
    const attributes = new Map([...match[2]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map(attribute => [attribute[1]!, decodeXml(attribute[2] ?? attribute[3] ?? '')]));
    const taskId = attributes.get('turn_id') ?? attributes.get('task_id');
    const report: KodaXTaskResultReport = { type: 'task_result', source: attributes.get('source') === 'workflow' ? 'workflow' : 'child_task',
      ...(taskId ? { taskId } : {}), ...(attributes.get('run_id') ? { runId: attributes.get('run_id') } : {}),
      ...(attributes.get('path') ? { title: attributes.get('path') } : {}),
      status: status(attributes.get('state') ?? attributes.get('status')), reportFormat: 'markdown',
      summary: decodeXml(match[3]!.replace(/^\r?\n/, '').replace(/\r?\n$/, '')) };
    reports.push(report);
    const source = attributes.get('source');
    if (source === 'workflow' || source === 'child_task') sourceHints.set(report, source);
  }
  return reports.length ? { reports, enveloped: true, sourceHints } : { reports: [{ type: 'task_result', source: 'child_task', status: 'unknown',
    reportFormat: 'markdown', summary: text }], enveloped: false, sourceHints };
}

/** Metadata owns report text/state. Only explicitly sourced old envelopes are parsed. */
export function readTaskResultReports(message: ResultMessage): KodaXTaskResultReport[] {
  const metadata: unknown[] = [...(message._taskResult === undefined ? [] : [message._taskResult]),
    ...(Array.isArray(message._taskResults) ? message._taskResults : [])];
  const parsed = legacyReports(message);
  const legacy = parsed.reports;
  const compatible = (old: KodaXTaskResultReport, current: Pick<KodaXTaskResultReport, 'source' | 'runId'>): boolean =>
    (!parsed.sourceHints.has(old) || parsed.sourceHints.get(old) === current.source)
    && (old.runId === undefined || current.runId === undefined || old.runId === current.runId);
  const reports: KodaXTaskResultReport[] = [];
  const identities = new Set<string>();
  const replacements = new Map<KodaXTaskResultReport, KodaXTaskResultReport>();
  for (const value of metadata) {
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== 'task_result' || record.source !== 'workflow' && record.source !== 'child_task') continue;
    const taskId = typeof record.taskId === 'string' && record.taskId ? record.taskId : undefined;
    const runId = typeof record.runId === 'string' ? record.runId : undefined;
    const identity = taskId ? JSON.stringify([record.source, runId, taskId]) : undefined;
    if (identity && identities.has(identity)) continue;
    if (identity) identities.add(identity);
    const identityFields: Pick<KodaXTaskResultReport, 'source' | 'runId'> = { source: record.source, runId };
    const fallback = (taskId ? legacy.find(report => report.taskId === taskId && compatible(report, identityFields)) : undefined)
      ?? (metadata.length === 1 && legacy.length === 1 && legacy[0]!.taskId === undefined
        && compatible(legacy[0]!, identityFields) ? legacy[0] : undefined);
    const report: KodaXTaskResultReport = { type: 'task_result', source: record.source, ...(taskId ? { taskId } : {}),
      ...(runId !== undefined ? { runId } : {}), status: status(record.status), reportFormat: 'markdown',
      ...(typeof record.title === 'string' ? { title: record.title } : {}),
      ...(Array.isArray(record.artifactRefs) && record.artifactRefs.every(ref => typeof ref === 'string')
        ? { artifactRefs: [...record.artifactRefs] } : {}),
      summary: typeof record.summary === 'string' ? record.summary : fallback?.summary ?? '' };
    reports.push(report);
    if (fallback) replacements.set(fallback, report);
  }
  if (reports.length === 0) return legacy;
  if (!parsed.enveloped) return reports;
  const before = new Map<KodaXTaskResultReport, KodaXTaskResultReport[]>();
  const trailing: KodaXTaskResultReport[] = [];
  let following: KodaXTaskResultReport | undefined;
  // Metadata order is authoritative; model-only envelopes can be budgeted/reordered.
  for (let index = legacy.length - 1; index >= 0; index--) {
    const old = legacy[index]!;
    const report = replacements.get(old) ?? reports.find(candidate => old.taskId !== undefined && candidate.taskId === old.taskId
      && compatible(old, candidate));
    if (report) following = report;
    else if (following) before.set(following, [old, ...(before.get(following) ?? [])]);
    else trailing.unshift(old);
  }
  return [...reports.flatMap(report => [...(before.get(report) ?? []), report]), ...trailing];
}
