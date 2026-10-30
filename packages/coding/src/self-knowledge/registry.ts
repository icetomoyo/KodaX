/**
 * FEATURE_218 — the bundled KodaX self-manual registry.
 *
 * Drift discipline: dynamic facts (the provider list, the default provider)
 * are imported from live constants in `@kodax-ai/llm`, never copied as string
 * literals. A drift-guard test (registry.test.ts) asserts the providers topic
 * covers every provider in provider-capabilities.json.
 */

import {
  KODAX_PROVIDER_SNAPSHOTS,
  KODAX_DEFAULT_PROVIDER,
} from "@kodax-ai/llm";

import type { KodaXManualTopic, KodaXManualTopicId } from "./types.js";
import { loadManualTopics } from './manual-topics.js';

/** Live provider names — drift-proof source for the `providers` topic. */
const PROVIDER_NAMES: readonly string[] = Object.keys(KODAX_PROVIDER_SNAPSHOTS);
const PROVIDER_LIST = PROVIDER_NAMES.join(", ");
const PROVIDER_AUTH_LINES = Object.entries(KODAX_PROVIDER_SNAPSHOTS)
  .map(([name, snapshot]) =>
    snapshot.capabilityProfile.transport === "cli-bridge"
      ? `- ${name}: authenticate with the provider CLI (no KodaX API-key env var).`
      : `- ${name}: ${snapshot.apiKeyEnv}`,
  )
  .join("\n");

/** Canonical topic order (also the index ordering). */
export const MANUAL_TOPIC_IDS: readonly KodaXManualTopicId[] = [
  "overview",
  "license",
  "install",
  "quickstart",
  "providers",
  "custom-providers",
  "config",
  "permissions",
  "sandbox",
  "commands",
  "tools",
  "agents",
  "skills",
  "extensions",
  "mcp",
  "a2a",
  "repo-intelligence",
  "sessions",
  "compaction",
  "memory",
  "doctor",
  "sdk",
  "troubleshooting",
];

/**
 * FEATURE_221 — the base topics that describe UNDERLYING KodaX MECHANISMS a
 * product built on the SDK inherits (provider/config/permission/tool/MCP/A2A/
 * skill/extension/session/repo-intel/SDK behavior). A white-label consumer who
 * fully replaces the manual (`selfManual.baseTopics = []`) can pass THIS list
 * instead to keep the agent able to accurately explain the mechanisms it stands
 * on — e.g. `selfManual.baseTopics = [...KODAX_UNDERLYING_CAPABILITY_TOPICS]`.
 *
 * Excluded from this set (KodaX-CLI-specific UX, not mechanisms a product
 * inherits): overview / license / install / quickstart / commands / agents / doctor /
 * troubleshooting. It is a recommended STARTING POINT — a consumer is free to
 * pass any explicit subset of `MANUAL_TOPIC_IDS`.
 */
export const KODAX_UNDERLYING_CAPABILITY_TOPICS: readonly KodaXManualTopicId[] =
  [
    "providers",
    "custom-providers",
    "config",
    "permissions",
    "sandbox",
    "tools",
    "skills",
    "extensions",
    "mcp",
    "a2a",
    "repo-intelligence",
    "sessions",
    "compaction",
    "sdk",
  ];

const tokens: Readonly<Record<string, string>> = {
  PROVIDER_COUNT: String(PROVIDER_NAMES.length), PROVIDER_LIST,
  PROVIDER_AUTH_LINES, DEFAULT_PROVIDER: KODAX_DEFAULT_PROVIDER,
};
const TOPICS: readonly KodaXManualTopic[] = loadManualTopics().map(topic => ({
  ...topic,
  body: topic.body.join('\n').replace(/\{\{(PROVIDER_COUNT|PROVIDER_LIST|PROVIDER_AUTH_LINES|DEFAULT_PROVIDER)\}\}/g,
    (_match, key: string) => tokens[key]!),
}));

export const MANUAL_REGISTRY: Readonly<
  Record<KodaXManualTopicId, KodaXManualTopic>
> = Object.freeze(
  Object.fromEntries(TOPICS.map((t) => [t.id, t])) as Record<
    KodaXManualTopicId,
    KodaXManualTopic
  >,
);

/** Exposed for drift-guard tests (providers topic must cover every provider). */
export const MANUAL_PROVIDER_NAMES = PROVIDER_NAMES;
