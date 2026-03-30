import type { KodaXSessionTreeNode } from '@kodax/coding';

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
