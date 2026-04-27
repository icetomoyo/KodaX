/**
 * KodaX 提示词内容验证测试
 *
 * 确保 coding/prompts/ 和 cli/ 中的提示词关键内容存在
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// ============== SYSTEM_PROMPT 测试 ==============

describe('SYSTEM_PROMPT Content Verification', () => {
  const systemPromptPath = path.join(process.cwd(), 'packages', 'coding', 'src', 'prompts', 'system.ts');

  // Note: The standalone "Large File Handling" section was folded into
  // the broader "Tool Usage" guidance (read offset/limit + edit-over-rewrite
  // hints) during a prompt-cleanup pass. Tool Usage now carries the
  // equivalent constraints — verified by the Tool Usage section test below.

  it('should contain Error Handling section with Common errors', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('## Error Handling');
    expect(content).toContain('5. Common errors:');
    expect(content).toContain('"Missing required parameter \'X\'"');
    expect(content).toContain('"File not found"');
    expect(content).toContain('"String not found"');
    expect(content).toContain('When a shell command fails, prefer this recovery order:');
    expect(content).toContain('Only create a helper script');
  });

  it('should contain Editing Files section', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('## Editing Files');
    expect(content).toContain('Always read the file first');
    expect(content).toContain('Make precise, targeted edits');
    expect(content).toContain('Preserve the existing code style');
  });

  it('should contain Shell Commands section with Cross-Platform Notes', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('## Tool Usage');
    expect(content).toContain('Prefer specialized tools over shell for file operations:');
    expect(content).toContain('When multiple read-only tool calls are independent, emit them in the same response so parallel mode can run them together');
    expect(content).toContain('Only serialize tool calls when a later call depends on an earlier result');
    expect(content).toContain('Do NOT create temporary scripts or scratch files in the project root');
    expect(content).toContain('## Shell Commands');
    expect(content).toContain('Reserve shell commands for terminal operations');
    expect(content).toContain('### Cross-Platform Notes');
    // Check for platform-specific command hints
    expect(content).toContain('move');
    expect(content).toContain('mv');
    expect(content).toContain('dir');
    expect(content).toContain('ls');
    expect(content).toContain('del');
    expect(content).toContain('rm');
  });

  it('should contain mkdir instructions with Chinese error hint', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('Directories are created automatically');
    expect(content).toContain('NEVER use');  // Without exact backticks
    expect(content).toContain('mkdir');
    expect(content).toContain('不是内部或外部命令');
    expect(content).toContain('not recognized');
  });

  it('should contain Multi-step Tasks section', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('## Multi-step Tasks');
    expect(content).toContain('Track your progress');
    expect(content).toContain('Break complex tasks into smaller steps');
  });

  it('should contain Plan Before Action section', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('## Plan Before Action');
    expect(content).toContain('First explain your understanding of the task');
    expect(content).toContain('Outline your approach');
    expect(content).toContain('Consider potential issues');
    expect(content).toContain('Then execute step by step');
    expect(content).toContain('For simple read-only tasks');
  });

  it('should contain {context} placeholder', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('{context}');
  });
});

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

// ============== 源文件一致性测试 ==============

describe('Source File Consistency', () => {
  const systemPromptPath = path.join(process.cwd(), 'packages', 'coding', 'src', 'prompts', 'system.ts');

  it('should have SYSTEM_PROMPT in coding/prompts/system.ts', async () => {
    const systemPromptContent = await fs.readFile(systemPromptPath, 'utf-8');

    // Verify key sections exist. "Large File Handling" was folded into
    // Tool Usage; the read-bounding / parallel-tool guidance now lives there.
    const keySections = [
      '5. Common errors:',
      '## Editing Files',
      '## Tool Usage',
      'Read is intentionally bounded:',
      '### Cross-Platform Notes',
      '不是内部或外部命令',
      '## Multi-step Tasks',
      '## Plan Before Action',
    ];

    for (const section of keySections) {
      expect(systemPromptContent).toContain(section);
    }
  });
});
