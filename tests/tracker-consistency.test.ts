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
  currentVersion: string;
  plannedByVersion: Record<string, number>;
};

type IssueSummary = {
  total: number;
  open: number;
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
  return version
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

function parseFeatureRows(markdown: string): FeatureIndexRow[] {
  const inProgressSection = getSection(markdown, '进行中的 Feature');
  const plannedSection = getSection(markdown, '计划中的 Feature');
  const completedSection = getSection(markdown, '已完成 Feature');

  const inProgressRows = getMarkdownTableRows(inProgressSection).map((cells) => {
    const [id, title, planned, design] = cells;

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
      designPath: extractLinkPath(design),
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

  if (!currentVersion || [total, planned, inProgress, completed].some((value) => Number.isNaN(value))) {
    throw new Error('FEATURE_LIST.md 当前概况 section is incomplete');
  }

  const plannedByVersion = Object.fromEntries(
    getMarkdownTableRows(plannedByVersionPart).map((cells) => [
      stripMarkdown(cells[0]),
      Number(stripMarkdown(cells[1])),
    ])
  );

  return {
    total,
    planned,
    inProgress,
    completed,
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
    /- Total: (\d+) \((\d+) Open, (\d+) Resolved, (\d+) Partially Resolved, (\d+) Won't Fix\)/
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

  it('keeps feature overview aggregates in sync with the feature tables', () => {
    expect(featureOverview).not.toBeNull();

    const statusCounts = {
      Planned: featureRows.filter((row) => row.status === 'Planned').length,
      InProgress: featureRows.filter((row) => row.status === 'InProgress').length,
      Completed: featureRows.filter((row) => row.status === 'Completed').length,
    };
    const plannedByVersion = Object.fromEntries(
      [...featureRows]
        .filter((row) => row.status === 'Planned')
        .reduce((map, row) => {
          map.set(row.planned, (map.get(row.planned) ?? 0) + 1);
          return map;
        }, new Map<string, number>())
        .entries(),
    );

    expect(featureOverview?.total).toBe(featureRows.length);
    expect(featureOverview?.planned).toBe(statusCounts.Planned);
    expect(featureOverview?.inProgress).toBe(statusCounts.InProgress);
    expect(featureOverview?.completed).toBe(statusCounts.Completed);
    expect(featureOverview?.plannedByVersion).toEqual(plannedByVersion);
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

    await Promise.all(
      featureRows.map(async (row) => {
        const absoluteDesignPath = path.join(docsDir, row.designPath);
        await expect(fs.access(absoluteDesignPath)).resolves.toBeUndefined();
      })
    );
  });

  it('keeps known issue summary counts and highest priority open issue consistent', () => {
    const issueSummary = parseIssueSummary(knownIssuesMarkdown);
    const highestPriorityOpenIssue = selectHighestPriorityOpenIssue(issueRows);

    expect(issueSummary.total).toBe(issueRows.length);
    expect(issueSummary.open).toBe(issueRows.filter((row) => row.status === 'Open').length);
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
