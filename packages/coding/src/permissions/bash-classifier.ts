/**
 * KodaX Bash Command Risk Classifier
 *
 * Classifies bash commands into safe/normal/dangerous risk levels.
 * Pure function, no side effects.
 */

export type BashRiskLevel = 'safe' | 'normal' | 'dangerous';

export interface BashClassificationResult {
  readonly level: BashRiskLevel;
  readonly reason: string;
  readonly matchedPattern?: string;
}

export interface BashClassifierConfig {
  readonly safePatterns: readonly RegExp[];
  readonly dangerousPatterns: readonly RegExp[];
}

export const DEFAULT_SAFE_PATTERNS: readonly RegExp[] = [
  /^git\s+(status|log|diff|branch|show|remote|tag|stash\s+list|rev-parse|describe)\b/,
  /^(cat|head|tail|wc|sort|uniq|diff|file|which|type|where|grep)\b/,
  /^(ls|dir|pwd|echo|date|whoami|hostname|uname)\b/,
  /^(node|python|ruby|go|java|rustc|gcc)\s+--version\b/,
  /^npm\s+(list|ls|outdated|audit|test|run\s+test|run\s+lint|run\s+build|run\s+check|run\s+typecheck)\b/,
  /^npx\s+(tsc|vitest|jest|prettier|eslint|biome)\b/,
  /^(cargo|go)\s+(build|test|check|vet|version|fmt)\b/,
  /^(pip|pip3)\s+(list|show|freeze)\b/,
  /^(docker|podman)\s+(ps|images|logs|inspect)\b/,
  /^(kubectl|k)\s+(get|describe|logs)\b/,
];

export const DEFAULT_DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*r|-[a-z]*f|--force|--recursive)/i,
  /\bgit\s+(push\s+--force|push\s+-f\b|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+--staged\s+\.|branch\s+-D)/,
  /\bsudo\b/,
  /\bchmod\s+[0-7]*777\b/,
  /\b(mkfs|fdisk|dd\s+if=|format)\b/,
  /\bcurl\b.*\|\s*(bash|sh|zsh)\b/,
  /\b(drop\s+|truncate\s+|delete\s+from)\b/i,
  /\brm\s+-rf\s+[\/~]/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bgit\s+push\s+.*--force-with-lease\b/,
];

/**
 * Validate a regex pattern string for safety (ReDoS prevention).
 * Rejects patterns that are too long or have excessive nesting.
 */
function isSafeRegexPattern(pattern: string): boolean {
  if (pattern.length > 200) return false;
  // Reject patterns with excessive grouping that could cause catastrophic backtracking
  const groupCount = (pattern.match(/\(/g) ?? []).length;
  if (groupCount > 5) return false;
  // Reject nested quantifiers like (a+)+ or (a*)*
  if (/(\+|\*|\{)\)(\+|\*|\{)/.test(pattern)) return false;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function createBashClassifierConfig(
  userSafePatterns: readonly string[] = [],
  userDangerousPatterns: readonly string[] = [],
): BashClassifierConfig {
  const safeParsed = userSafePatterns
    .filter(isSafeRegexPattern)
    .map((p) => new RegExp(p));
  const dangerousParsed = userDangerousPatterns
    .filter(isSafeRegexPattern)
    .map((p) => new RegExp(p));
  return {
    safePatterns: [...DEFAULT_SAFE_PATTERNS, ...safeParsed],
    dangerousPatterns: [...DEFAULT_DANGEROUS_PATTERNS, ...dangerousParsed],
  };
}

export function classifyBashCommand(
  command: string,
  config: BashClassifierConfig = {
    safePatterns: DEFAULT_SAFE_PATTERNS,
    dangerousPatterns: DEFAULT_DANGEROUS_PATTERNS,
  },
): BashClassificationResult {
  const trimmed = command.trim();

  // Check dangerous first (higher priority)
  for (const pattern of config.dangerousPatterns) {
    if (pattern.test(trimmed)) {
      return {
        level: 'dangerous',
        reason: 'Matches dangerous command pattern',
        matchedPattern: pattern.source,
      };
    }
  }

  // Check safe
  for (const pattern of config.safePatterns) {
    if (pattern.test(trimmed)) {
      return {
        level: 'safe',
        reason: 'Matches safe command pattern',
        matchedPattern: pattern.source,
      };
    }
  }

  // Default: normal
  return {
    level: 'normal',
    reason: 'No matching pattern; follows permission mode',
  };
}
