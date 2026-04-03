/**
 * KodaX Prompts
 *
 * 提示词模块统一导出
 */

export { SYSTEM_PROMPT } from './system.js';
export { LONG_RUNNING_PROMPT } from './long-running.js';
export { buildSystemPrompt, buildSystemPromptSnapshot } from './builder.js';
export {
  PROMPT_SECTION_REGISTRY,
  buildPromptSnapshot,
  createPromptSection,
  orderPromptSections,
  renderPromptSections,
  type KodaXPromptSectionSlot,
  type KodaXPromptSectionStability,
  type KodaXPromptSectionDefinition,
  type KodaXPromptSection,
  type KodaXPromptSnapshotMetadata,
  type KodaXPromptSnapshot,
} from './sections.js';
