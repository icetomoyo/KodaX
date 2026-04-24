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

  it('should contain Large File Handling section', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('## Large File Handling (IMPORTANT)');
    expect(content).toContain('**RECOMMENDED LIMIT: 300 lines per write call**');
  });

  it('should contain Example approach for large files', async () => {
    const content = await fs.readFile(systemPromptPath, 'utf-8');
    expect(content).toContain('Example approach for large files:');
    expect(content).toContain('1. write file with basic structure/skeleton (under 300 lines)');
    expect(content).toContain('2. edit to add first major section');
    expect(content).toContain('3. edit to add second major section');
    expect(content).toContain('4. continue until complete');
  });

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
  const agentPath = path.join(process.cwd(), 'packages', 'coding', 'src', 'agent.ts');

  it('should contain first retry prompt with concise instruction', async () => {
    const content = await fs.readFile(agentPath, 'utf-8');
    expect(content).toContain('For large content, keep it concise (under 50 lines for write operations)');
  });

  it('should contain second retry prompt with detailed instructions', async () => {
    const content = await fs.readFile(agentPath, 'utf-8');
    expect(content).toContain('⚠️ CRITICAL: Your response was TRUNCATED again');
    expect(content).toContain('YOU MUST:');
    expect(content).toContain("For 'write' tool: Keep content under 50 lines");
    expect(content).toContain("For 'edit' tool: Keep new_string under 30 lines");
    expect(content).toContain('PROVIDE SHORT, COMPLETE PARAMETERS NOW');
  });

  it('should contain incompleteRetryCount conditional', async () => {
    const content = await fs.readFile(agentPath, 'utf-8');
    expect(content).toContain('if (incompleteRetryCount === 1)');
    expect(content).toContain('} else {');
  });
});

// ============== 源文件一致性测试 ==============

describe('Source File Consistency', () => {
  const systemPromptPath = path.join(process.cwd(), 'packages', 'coding', 'src', 'prompts', 'system.ts');

  it('should have SYSTEM_PROMPT in coding/prompts/system.ts', async () => {
    const systemPromptContent = await fs.readFile(systemPromptPath, 'utf-8');

    // Verify key sections exist
    const keySections = [
      '## Large File Handling (IMPORTANT)',
      'Example approach for large files:',
      '5. Common errors:',
      '## Editing Files',
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
