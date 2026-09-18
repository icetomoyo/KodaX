import type { KodaXSessionTreeNode } from '@kodax-ai/agent';
import type { ClientLineageSummary } from '@kodax-ai/coding/client-contract';

/** The terminal owns layout; Host entries supply only bounded content facts. */
export function formatClientSessionTree(lineage: ClientLineageSummary | null): string[] {
  if (!lineage) return ['[No session tree available for this session]'];
  const entries = new Map(lineage.entries.map(entry => [entry.id, entry]));
  const visible = lineage.entries.filter(entry => ['message', 'compaction', 'branch_summary', 'archive_marker'].includes(entry.type));
  const visibleIds = new Set(visible.map(entry => entry.id));
  const labels = new Map<string, string>();
  for (const entry of lineage.entries) {
    if (entry.type === 'label' && entry.targetId) {
      if (entry.label) labels.set(entry.targetId, entry.label); else labels.delete(entry.targetId);
    }
  }
  const active = new Set<string>();
  for (let id = lineage.activeEntryId; id && !active.has(id); id = entries.get(id)?.parentId ?? null) active.add(id);
  const children = new Map<string | null, typeof visible>();
  for (const entry of visible) {
    const parent = entry.parentId && visibleIds.has(entry.parentId) ? entry.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | null, depth: number): void => {
    for (const entry of children.get(parent) ?? []) {
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      const preview = entry.preview ?? '';
      const label = labels.get(entry.id);
      lines.push(`${'  '.repeat(depth)}${active.has(entry.id) ? '*' : ' '} ${entry.id.slice(0, 12)}  ${entry.role ?? entry.type}: ${preview.slice(0, 48)}${preview.length > 48 ? '...' : ''}${label ? ` [${label}]` : ''}`);
      visit(entry.id, depth + 1);
    }
  };
  visit(null, 0);
  return lines;
}

function summarizeEntry(entry: KodaXSessionTreeNode['entry']): string {
  switch (entry.type) {
    case 'message': {
      const content = typeof entry.message.content === 'string'
        ? entry.message.content
        : '[complex content]';
      const preview = content.replace(/\s+/g, ' ').trim();
      return `${entry.message.role}: ${preview.slice(0, 48)}${preview.length > 48 ? '...' : ''}`;
    }
    case 'compaction':
      return `compaction: ${entry.summary.slice(0, 48)}${entry.summary.length > 48 ? '...' : ''}`;
    case 'branch_summary':
      return `branch: ${entry.summary.slice(0, 48)}${entry.summary.length > 48 ? '...' : ''}`;
    case 'archive_marker':
      return `archived: ${entry.summary.slice(0, 48)}${entry.summary.length > 48 ? '...' : ''}`;
    default: {
      const exhaustiveCheck: never = entry;
      return exhaustiveCheck;
    }
  }
}

function formatNode(
  node: KodaXSessionTreeNode,
  prefix: string,
  isLast: boolean,
  lines: string[],
): void {
  const connector = prefix ? (isLast ? '\\- ' : '|- ') : '';
  const activeMarker = node.active ? '*' : ' ';
  const shortId = node.entry.id.slice(0, 12);
  const label = node.label ? ` [${node.label}]` : '';
  lines.push(`${prefix}${connector}${activeMarker} ${shortId}  ${summarizeEntry(node.entry)}${label}`);

  const nextPrefix = prefix + (prefix ? (isLast ? '   ' : '|  ') : '');
  node.children.forEach((child: KodaXSessionTreeNode, index: number) => {
    formatNode(child, nextPrefix, index === node.children.length - 1, lines);
  });
}

export function formatSessionTree(nodes: KodaXSessionTreeNode[]): string[] {
  const lines: string[] = [];
  nodes.forEach((node: KodaXSessionTreeNode, index: number) => {
    formatNode(node, '', index === nodes.length - 1, lines);
  });
  return lines;
}
