/**
 * KodaX Prompts
 *
 * 提示词模块统一导出
 */

export { buildCapabilityContextSections } from './capability-sections.js';
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
