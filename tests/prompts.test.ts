/**
 * KodaX 提示词内容验证测试
 *
 * 确保工具与重试提示词的关键内容存在
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// ============== toolBash timeout message 测试 ==============

describe('toolBash Timeout Message Verification', () => {
  const bashToolPath = path.join(process.cwd(), 'packages', 'coding', 'src', 'tools', 'bash.ts');

  it('should contain all timeout suggestions', async () => {
    const content = await fs.readFile(bashToolPath, 'utf-8');
    expect(content).toContain('[Suggestion] The command took too long. Consider:');
    expect(content).toContain('Is this a watch/dev server? Run in a separate terminal.');
    expect(content).toContain('Can the task be broken into smaller steps?');
    expect(content).toContain('Is there an error causing it to hang?');
  });
});

// ============== Retry prompts 测试 ==============

describe('Retry Prompts Content Verification', () => {
  // FEATURE_100 P2 extracted the incomplete-tool-call retry prompts out
  // of agent.ts into the dedicated `incomplete-tool-retry.ts` module.
  const retryPath = path.join(
    process.cwd(),
    'packages',
    'coding',
    'src',
    'agent-runtime',
    'incomplete-tool-retry.ts',
  );

  it('should contain first retry prompt with concise instruction', async () => {
    const content = await fs.readFile(retryPath, 'utf-8');
    expect(content).toContain('For large content, keep it concise (under 50 lines for write operations)');
  });

  it('should contain second retry prompt with detailed instructions', async () => {
    const content = await fs.readFile(retryPath, 'utf-8');
    expect(content).toContain('⚠️ CRITICAL: Your response was TRUNCATED again');
    expect(content).toContain('YOU MUST:');
    expect(content).toContain("For 'write' tool: Keep content under 50 lines");
    expect(content).toContain("For 'edit' tool: Keep new_string under 30 lines");
    expect(content).toContain('PROVIDE SHORT, COMPLETE PARAMETERS NOW');
  });

  it('should branch on retry count (first attempt vs subsequent)', async () => {
    const content = await fs.readFile(retryPath, 'utf-8');
    // Module exposes `buildIncompleteToolRetryMessage(missing, retryCount)`
    // which branches on `retryCount === 1` for the gentler first prompt
    // and falls through to the CRITICAL escalation otherwise.
    expect(content).toContain('retryCount === 1');
  });
});
