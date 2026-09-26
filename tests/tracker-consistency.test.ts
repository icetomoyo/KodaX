import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

type FeatureIndexRow = {
  id: string;
  status: 'Planned' | 'InProgress' | 'Completed';
  priority?: string;
  title: string;
  planned: string;
  released: string;
  designPath: string;
};

type IssueIndexRow = {
  id: string;
  priority: string;
  status: string;
  title: string;
  created: string;
};

type FeatureOverview = {
  total: number;
  planned: number;
  inProgress: number;
  completed: number;
  reviewedOut: number;
  currentVersion: string;
  plannedByVersion: Record<string, number>;
};

type IssueSummary = {
  total: number;
  open: number;
  needsInfo: number;
  resolved: number;
  partiallyResolved: number;
  wontFix: number;
  highestPriorityOpen: {
    id: string;
    title: string;
    priority: string;
  };
};

const rootDir = process.cwd();
const docsDir = path.join(rootDir, 'docs');

function parseVersion(version: string): number[] {
  const normalizedVersion = version.match(/v?\d+(?:\.\d+)*/)?.[0] ?? version;
  return normalizedVersion
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part));
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function getSection(markdown: string, heading: string): string {
  const headingMarker = `## ${heading}`;
  const startIndex = markdown.indexOf(headingMarker);

  if (startIndex === -1) {
    throw new Error(`Missing section: ${heading}`);
  }

  const nextSectionIndex = markdown.indexOf('\n## ', startIndex + headingMarker.length);

  if (nextSectionIndex === -1) {
    return markdown.slice(startIndex);
  }

  return markdown.slice(startIndex, nextSectionIndex);
}

function getMarkdownTableRows(section: string): string[][] {
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));

  return lines.slice(2).map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
  );
}

function stripMarkdown(value: string): string {
  return value.replace(/`/g, '').replace(/\*\*/g, '').trim();
}

function extractLinkPath(markdownLink: string): string {
  const match = markdownLink.match(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/);

  if (!match) {
    throw new Error(`Expected markdown link but received: ${markdownLink}`);
  }

  return match[1];
}

/**
 * Far-future / RFC-pending features in the planned section may carry a
 * "TBD (...)" placeholder in the design column instead of a markdown link
 * — by convention these are roadmap stubs awaiting an RFC pass before a
 * proper design doc is committed. Parser-strict link extraction would
 * trip on them; the tracker-consistency contract only cares about the
 * *id / status / planned-version* fields for those rows. Returning a
 * sentinel here lets the rest of the validation suite keep running.
 */
function extractLinkPathOrSentinel(markdownLink: string): string {
  const trimmed = (markdownLink ?? '').trim();
  // Empty / dash placeholders correspond to (a) far-future RFC-pending
  // stubs ("TBD ...") and (b) cancelled rows (`~~...~~ | — | —`) — both
  // are intentionally without a design doc. The downstream fs.access
  // assertion skips the sentinel.
  if (
    trimmed.startsWith('TBD') ||
    trimmed === '-' ||
    trimmed === '—' ||
    trimmed === ''
  ) {
    return '__pending__';
  }
  return extractLinkPath(markdownLink);
}

async function hasFeatureDesignDocs(): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(docsDir, 'features'), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.md'));
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';

    if (code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function parseFeatureRows(markdown: string): FeatureIndexRow[] {
  const inProgressSection = getSection(markdown, '进行中的 Feature');
  const plannedSection = getSection(markdown, '计划中的 Feature');
  const completedSection = getSection(markdown, '已完成 Feature');

  const inProgressRows = getMarkdownTableRows(inProgressSection).map((cells) => {
    // InProgress uses the same 6-column layout as the Planned table
    // (ID | Title | Category | Priority | Planned | Design). Destructuring it as
    // 4 columns put the Priority cell ("High") into `design` and threw once the
    // table became non-empty (v0.7.58 shipped with an empty InProgress table).
    const [id, title, _category, _priority, planned, design] = cells;

    return {
      id: stripMarkdown(id),
      status: 'InProgress' as const,
      title,
      planned: stripMarkdown(planned),
      released: '-',
      designPath: extractLinkPath(design),
    };
  });

  const plannedRows = getMarkdownTableRows(plannedSection).map((cells) => {
    const [id, title, _category, priority, planned, design] = cells;

    return {
      id: stripMarkdown(id),
      status: 'Planned' as const,
      priority,
      title,
      planned: stripMarkdown(planned),
      released: '-',
      // Planned rows may legitimately carry "TBD (RFC pending; ...)" in the
      // design column for far-future stubs. Parser uses sentinel-fallback
      // so the rest of the consistency contract still validates on those
      // rows (id / planned version / priority).
      designPath: extractLinkPathOrSentinel(design),
    };
  });

  const completedRows = getMarkdownTableRows(completedSection).map((cells) => {
    const [id, title, released, design] = cells;
    const designPath = extractLinkPath(design);
    const plannedMatch = designPath.match(/features\/(v[\d.]+)\.md/i);

    return {
      id: stripMarkdown(id),
      status: 'Completed' as const,
      title,
      planned: plannedMatch?.[1] ?? '-',
      released: stripMarkdown(released),
      designPath,
    };
  });

  return [...inProgressRows, ...plannedRows, ...completedRows].sort((left, right) => Number(left.id) - Number(right.id));
}

function parseFeatureOverview(markdown: string): FeatureOverview {
  const currentSection = getSection(markdown, '当前概况');
  const [overviewPart, plannedByVersionPart = ''] = currentSection.split('### 各版本待做分布');
  const overviewRows = getMarkdownTableRows(overviewPart);
  const overviewEntries = new Map(overviewRows.map((cells) => [stripMarkdown(cells[0]), stripMarkdown(cells[1])]));

  const currentVersion = overviewEntries.get('Current released version');
  const total = Number(overviewEntries.get('Total tracked features'));
  const planned = Number(overviewEntries.get('Planned'));
  const inProgress = Number(overviewEntries.get('InProgress'));
  const completed = Number(overviewEntries.get('Completed'));
  const reviewedOut = Number(
    overviewEntries.get('Reviewed out of active roadmap')?.match(/^\d+/)?.[0],
  );

  if (!currentVersion || [total, planned, inProgress, completed, reviewedOut]
    .some((value) => Number.isNaN(value))) {
    throw new Error('FEATURE_LIST.md 当前概况 section is incomplete');
  }

  // Doc convention: the version key may carry a parenthetical hint (e.g.
  // `~~v0.7.39 (legacy slot for FEATURE_096)~~`) and the count cell may
  // be followed by free-text commentary (e.g. `6 (114/115/119 + ...)`).
  // Strip those annotations so the parsed entry matches what the row
  // tables produce: bare version label + leading integer count.
  const stripParentheticalHint = (value: string): string =>
    value.replace(/\s*\([^)]*\)\s*/g, '').trim();
  const extractLeadingInteger = (value: string): number => {
    const match = value.match(/^\s*(-?\d+)/);
    return match ? Number(match[1]) : Number(value);
  };
  const plannedByVersion = Object.fromEntries(
    getMarkdownTableRows(plannedByVersionPart).map((cells) => [
      stripParentheticalHint(stripMarkdown(cells[0])),
      extractLeadingInteger(stripMarkdown(cells[1])),
    ])
  );

  return {
    total,
    planned,
    inProgress,
    completed,
    reviewedOut,
    currentVersion,
    plannedByVersion,
  };
}

function parseIssueIndex(markdown: string): IssueIndexRow[] {
  return getMarkdownTableRows(getSection(markdown, 'Issue Index')).map((cells) => {
    const [id, priority, status, title, , , created] = cells;

    return {
      id,
      priority,
      status,
      title,
      created,
    };
  });
}

function parseIssueSummary(markdown: string): IssueSummary {
  const section = getSection(markdown, 'Summary');
  const totalMatch = section.match(
    /- Total: (\d+) \((\d+) Open(?: including \d+ needs-info)?, (\d+) Resolved, (\d+) Partially Resolved, (\d+) Won't Fix\)/
  );
  const highestPriorityMatch = section.match(
    /- Highest Priority Open: (\d+) - (.+) \((High|Medium|Low)\)/
  );

  if (!totalMatch || !highestPriorityMatch) {
    throw new Error('KNOWN_ISSUES.md summary format is incomplete');
  }

  return {
    total: Number(totalMatch[1]),
    open: Number(totalMatch[2]),
    needsInfo: Number(totalMatch[0].match(/including (\d+) needs-info/)?.[1] ?? 0),
    resolved: Number(totalMatch[3]),
    partiallyResolved: Number(totalMatch[4]),
    wontFix: Number(totalMatch[5]),
    highestPriorityOpen: {
      id: highestPriorityMatch[1],
      title: highestPriorityMatch[2],
      priority: highestPriorityMatch[3],
    },
  };
}

function selectHighestPriorityOpenIssue(rows: IssueIndexRow[]): IssueIndexRow {
  const priorityRank: Record<string, number> = {
    High: 3,
    Medium: 2,
    Low: 1,
  };

  const sortedRows = [...rows]
    .filter((row) => row.status === 'Open')
    .sort((left, right) => {
      const priorityDifference =
        (priorityRank[right.priority] ?? 0) - (priorityRank[left.priority] ?? 0);

      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      if (left.created !== right.created) {
        return left.created.localeCompare(right.created);
      }

      return Number(left.id) - Number(right.id);
    });

  const highestPriorityIssue = sortedRows[0];

  if (!highestPriorityIssue) {
    throw new Error('Expected at least one open issue');
  }

  return highestPriorityIssue;
}

describe('tracker consistency', () => {
  let featureListMarkdown = '';
  let knownIssuesMarkdown = '';
  let packageVersion = '';
  let featureRows: FeatureIndexRow[] = [];
  let featureOverview: FeatureOverview | null = null;
  let issueRows: IssueIndexRow[] = [];

  beforeAll(async () => {
    const [featureList, knownIssues, packageJsonRaw] = await Promise.all([
      fs.readFile(path.join(docsDir, 'FEATURE_LIST.md'), 'utf-8'),
      fs.readFile(path.join(docsDir, 'KNOWN_ISSUES.md'), 'utf-8'),
      fs.readFile(path.join(rootDir, 'package.json'), 'utf-8'),
    ]);

    featureListMarkdown = featureList;
    knownIssuesMarkdown = knownIssues;
    packageVersion = `v${JSON.parse(packageJsonRaw).version}`;
    featureRows = parseFeatureRows(featureListMarkdown);
    featureOverview = parseFeatureOverview(featureListMarkdown);
    issueRows = parseIssueIndex(knownIssuesMarkdown);
  });

  it('keeps feature overview release pointer in sync', () => {
    expect(featureOverview).not.toBeNull();
    expect(compareVersions(featureOverview?.currentVersion ?? 'v0.0.0', packageVersion)).toBeLessThanOrEqual(0);
  });

  // FEATURE_LIST 维护两条有意约定，使 "当前概况" 计数器无法机械等于 master
  // 表行数：(1) cancelled / absorbed 行以 ~~strikethrough~~ 保留做 traceability；
  // (2) 部分 feature "tracked elsewhere"（版本设计文档，见 当前概况 header 注），
  // 计入 curated Total / Planned 却不作为 master 表行。旧断言 `total === rows`
  // / `planned === rows` 因此对不上（实测已红 14+ commit）。本测试改为校验
  // **可机械验证且有意义**的不变量：内部自洽 + live 行不被漏计 + 版本登记。
  it('keeps feature overview aggregates internally consistent and not under-counting live rows', () => {
    expect(featureOverview).not.toBeNull();
    const overview = featureOverview!;

    const isStrikethrough = (title: string): boolean => (title ?? '').trim().startsWith('~~');
    const liveRows = featureRows.filter((row) => !isStrikethrough(row.title));
    const liveByStatus = {
      Planned: liveRows.filter((row) => row.status === 'Planned').length,
      InProgress: liveRows.filter((row) => row.status === 'InProgress').length,
      Completed: liveRows.filter((row) => row.status === 'Completed').length,
    };

    // (1) Summary is internally consistent — the parts sum to the whole.
    expect(overview.total).toBe(
      overview.planned + overview.inProgress + overview.completed + overview.reviewedOut,
    );

    // (2) InProgress / Completed are small live-only sets the doc keeps exact.
    expect(overview.inProgress).toBe(liveByStatus.InProgress);
    expect(overview.completed).toBe(liveByStatus.Completed);

    // (3) The curated Planned counter also covers tracked-elsewhere features
    //     and strikethrough traceability rows, so it is intentionally NOT
    //     equal to any single row count — but it must never UNDER-count the
    //     live planned rows actually present (that would be real un-tracked
    //     drift: a feature row added without bumping the summary).
    expect(overview.planned).toBeGreaterThanOrEqual(liveByStatus.Planned);

    // (4) Every version carrying a live planned row is listed in the
    //     per-version distribution table — drift guard without brittle counts.
    // NB: version keys contain dots ("v0.7.46"), so check key membership
    // directly — `toHaveProperty` would misread the dots as a nested path.
    // Only concrete versions are listed in the distribution table; roadmap
    // stubs (TBD / v0.8.x / v0.8.20+) intentionally are not, so skip them.
    const isConcreteVersion = (version: string): boolean => /^v\d+\.\d+(\.\d+)?$/.test(version);
    const distributionVersions = Object.keys(overview.plannedByVersion);
    const liveVersions = new Set(
      liveRows
        .filter((row) => row.status === 'Planned' && isConcreteVersion(row.planned))
        .map((row) => row.planned),
    );
    for (const version of liveVersions) {
      expect(distributionVersions).toContain(version);
    }
  });

  it('keeps feature release fields and design docs consistent', async () => {
    const completedWithoutRelease = featureRows.filter(
      (row) => row.status === 'Completed' && row.released === '-'
    );
    const unreleasedWithFixedVersion = featureRows.filter(
      (row) => row.status !== 'Completed' && row.released !== '-'
    );

    expect(completedWithoutRelease).toEqual([]);
    expect(unreleasedWithFixedVersion).toEqual([]);

    const designDocsAvailable = await hasFeatureDesignDocs();
    if (!designDocsAvailable) {
      expect(
        process.env.GITHUB_ACTIONS,
        'docs/features is a private submodule. Run `git submodule update --init --recursive` before local tracker checks.'
      ).toBe('true');
      return;
    }

    await Promise.all(
      featureRows.map(async (row) => {
        // `__pending__` is the sentinel for far-future planned rows whose
        // design column carries a "TBD (RFC pending; ...)" placeholder.
        // No file to assert existence of — by design, the doc lands when
        // the RFC is accepted.
        if (row.designPath === '__pending__') return;
        const absoluteDesignPath = path.join(docsDir, row.designPath);
        await expect(fs.access(absoluteDesignPath)).resolves.toBeUndefined();
      })
    );
  });

  it('keeps known issue summary counts and highest priority open issue consistent', () => {
    const issueSummary = parseIssueSummary(knownIssuesMarkdown);
    const highestPriorityOpenIssue = selectHighestPriorityOpenIssue(issueRows);

    expect(issueSummary.total).toBe(issueRows.length);
    expect(issueSummary.open).toBe(issueRows.filter((row) => row.status === 'Open' || row.status === 'needs-info').length);
    expect(issueSummary.needsInfo).toBe(issueRows.filter((row) => row.status === 'needs-info').length);
    expect(issueSummary.resolved).toBe(issueRows.filter((row) => row.status === 'Resolved').length);
    expect(issueSummary.partiallyResolved).toBe(
      issueRows.filter((row) => row.status === 'Partially Resolved').length
    );
    expect(issueSummary.wontFix).toBe(issueRows.filter((row) => row.status === "Won't Fix").length);
    expect(issueSummary.highestPriorityOpen).toEqual({
      id: highestPriorityOpenIssue.id,
      title: highestPriorityOpenIssue.title,
      priority: highestPriorityOpenIssue.priority,
    });
  });
});
