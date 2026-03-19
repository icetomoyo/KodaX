import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

type FeatureIndexRow = {
  id: string;
  status: string;
  priority: string;
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

type FeatureSummary = {
  total: number;
  planned: number;
  inProgress: number;
  completed: number;
  priorities: Record<string, number>;
  currentVersion: string;
  nextRelease: {
    version: string;
    count: number;
    ids: string[];
    completed: number;
    inProgress: number;
  };
  futureReleases: Array<{
    version: string;
    ids: string[];
  }>;
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
  return value.replace(/\*\*/g, '').trim();
}

function extractLinkPath(markdownLink: string): string {
  const match = markdownLink.match(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/);

  if (!match) {
    throw new Error(`Expected markdown link but received: ${markdownLink}`);
  }

  return match[1];
}

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

function parseFeatureIndex(markdown: string): FeatureIndexRow[] {
  return getMarkdownTableRows(getSection(markdown, 'Feature Index')).map((cells) => {
    const [id, , status, priority, title, planned, released, design] = cells;

    return {
      id,
      status,
      priority,
      title,
      planned,
      released,
      designPath: extractLinkPath(design),
    };
  });
}

function parseVersionInfo(markdown: string): { currentRelease: string; plannedVersion: string } {
  const rows = getMarkdownTableRows(getSection(markdown, 'Version Info'));
  const entries = new Map(rows.map((cells) => [stripMarkdown(cells[0]), cells[1]]));

  const currentRelease = entries.get('Current Release');
  const plannedVersion = entries.get('Planned Version');

  if (!currentRelease || !plannedVersion) {
    throw new Error('Missing version info rows in FEATURE_LIST.md');
  }

  return { currentRelease, plannedVersion };
}

function parseFeatureSummary(markdown: string): FeatureSummary {
  const section = getSection(markdown, 'Summary');

  const totalMatch = section.match(
    /- Total: (\d+) \((\d+) Planned, (\d+) In Progress, (\d+) Completed\)/
  );
  const priorityMatch = section.match(
    /- By Priority: Critical: (\d+), High: (\d+), Medium: (\d+), Low: (\d+)/
  );
  const currentVersionMatch = section.match(/- Current Version: (v[\d.]+)/);
  const nextReleaseMatch = section.match(
    /- Next Release \((v[\d.]+)\): (\d+) features \(([^)]*)\), (\d+) completed, (\d+) in progress/
  );
  const futureReleasesMatch = section.match(/- Future Releases: (.+)/);

  if (
    !totalMatch ||
    !priorityMatch ||
    !currentVersionMatch ||
    !nextReleaseMatch ||
    !futureReleasesMatch
  ) {
    throw new Error('FEATURE_LIST.md summary format is incomplete');
  }

  const futureReleases = [...futureReleasesMatch[1].matchAll(/(v[\d.]+) \(([^)]*)\)/g)].map(
    (match) => ({
      version: match[1],
      ids: match[2]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    })
  );

  return {
    total: Number(totalMatch[1]),
    planned: Number(totalMatch[2]),
    inProgress: Number(totalMatch[3]),
    completed: Number(totalMatch[4]),
    priorities: {
      Critical: Number(priorityMatch[1]),
      High: Number(priorityMatch[2]),
      Medium: Number(priorityMatch[3]),
      Low: Number(priorityMatch[4]),
    },
    currentVersion: currentVersionMatch[1],
    nextRelease: {
      version: nextReleaseMatch[1],
      count: Number(nextReleaseMatch[2]),
      ids: nextReleaseMatch[3]
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      completed: Number(nextReleaseMatch[4]),
      inProgress: Number(nextReleaseMatch[5]),
    },
    futureReleases,
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

function groupFutureReleaseIds(rows: FeatureIndexRow[], nextVersion: string): Array<{ version: string; ids: string[] }> {
  const groupedRows = new Map<string, string[]>();

  for (const row of rows) {
    if (row.released !== '-' || row.planned === nextVersion) {
      continue;
    }

    const group = groupedRows.get(row.planned) ?? [];
    group.push(row.id);
    groupedRows.set(row.planned, group);
  }

  return [...groupedRows.entries()]
    .sort(([leftVersion], [rightVersion]) => compareVersions(leftVersion, rightVersion))
    .map(([version, ids]) => ({ version, ids }));
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
  let versionInfo: { currentRelease: string; plannedVersion: string } | null = null;
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
    featureRows = parseFeatureIndex(featureListMarkdown);
    versionInfo = parseVersionInfo(featureListMarkdown);
    issueRows = parseIssueIndex(knownIssuesMarkdown);
  });

  it('keeps feature version info and summary release pointers in sync', () => {
    expect(versionInfo).not.toBeNull();
    expect(versionInfo?.currentRelease).toBe(packageVersion);

    const featureSummary = parseFeatureSummary(featureListMarkdown);
    expect(featureSummary.currentVersion).toBe(packageVersion);
    expect(featureSummary.nextRelease.version).toBe(versionInfo?.plannedVersion);
  });

  it('keeps feature summary aggregates in sync with the feature index', () => {
    expect(versionInfo).not.toBeNull();

    const featureSummary = parseFeatureSummary(featureListMarkdown);
    const statusCounts = {
      Planned: featureRows.filter((row) => row.status === 'Planned').length,
      InProgress: featureRows.filter((row) => row.status === 'InProgress').length,
      Completed: featureRows.filter((row) => row.status === 'Completed').length,
    };
    const priorityCounts = {
      Critical: featureRows.filter((row) => row.priority === 'Critical').length,
      High: featureRows.filter((row) => row.priority === 'High').length,
      Medium: featureRows.filter((row) => row.priority === 'Medium').length,
      Low: featureRows.filter((row) => row.priority === 'Low').length,
    };
    const nextReleaseRows = featureRows.filter((row) => row.planned === versionInfo?.plannedVersion);

    expect(featureSummary.total).toBe(featureRows.length);
    expect(featureSummary.planned).toBe(statusCounts.Planned);
    expect(featureSummary.inProgress).toBe(statusCounts.InProgress);
    expect(featureSummary.completed).toBe(statusCounts.Completed);
    expect(featureSummary.priorities).toEqual(priorityCounts);
    expect(featureSummary.currentVersion).toBe(packageVersion);
    expect(featureSummary.nextRelease).toEqual({
      version: versionInfo?.plannedVersion,
      count: nextReleaseRows.length,
      ids: nextReleaseRows.map((row) => row.id),
      completed: nextReleaseRows.filter((row) => row.status === 'Completed').length,
      inProgress: nextReleaseRows.filter((row) => row.status === 'InProgress').length,
    });
    expect(featureSummary.futureReleases).toEqual(
      groupFutureReleaseIds(featureRows, versionInfo?.plannedVersion ?? '')
    );
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
