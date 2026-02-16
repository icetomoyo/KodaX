/**
 * KodaX 提示词内容验证测试
 *
 * 确保 kodax_core.ts 和 kodax_cli.ts 中的提示词关键内容存在
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// ============== SYSTEM_PROMPT 测试 ==============

describe('SYSTEM_PROMPT Content Verification', () => {
  const kodaxCorePath = path.join(process.cwd(), 'src', 'kodax_core.ts');

  it('should contain Large File Handling section', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Large File Handling (IMPORTANT)');
    expect(content).toContain('**RECOMMENDED LIMIT: 300 lines per write call**');
  });

  it('should contain Example approach for large files', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('Example approach for large files:');
    expect(content).toContain('1. write file with basic structure/skeleton (under 300 lines)');
    expect(content).toContain('2. edit to add first major section');
    expect(content).toContain('3. edit to add second major section');
    expect(content).toContain('4. continue until complete');
  });

  it('should contain Error Handling section with Common errors', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Error Handling');
    expect(content).toContain('5. Common errors:');
    expect(content).toContain('"Missing required parameter \'X\'"');
    expect(content).toContain('"File not found"');
    expect(content).toContain('"String not found"');
  });

  it('should contain Editing Files section', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Editing Files');
    expect(content).toContain('Always read the file first');
    expect(content).toContain('Make precise, targeted edits');
    expect(content).toContain('Preserve the existing code style');
  });

  it('should contain Shell Commands section with Cross-Platform Notes', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Shell Commands');
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
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('Directories are created automatically');
    expect(content).toContain('NEVER use');  // Without exact backticks
    expect(content).toContain('mkdir');
    expect(content).toContain('不是内部或外部命令');
    expect(content).toContain('not recognized');
  });

  it('should contain Multi-step Tasks section', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Multi-step Tasks');
    expect(content).toContain('Track your progress');
    expect(content).toContain('Break complex tasks into smaller steps');
  });

  it('should contain Plan Before Action section', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Plan Before Action');
    expect(content).toContain('First explain your understanding of the task');
    expect(content).toContain('Outline your approach');
    expect(content).toContain('Consider potential issues');
    expect(content).toContain('Then execute step by step');
    expect(content).toContain('For simple read-only tasks');
  });

  it('should contain {context} placeholder', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('{context}');
  });
});

// ============== LONG_RUNNING_PROMPT 测试 ==============

describe('LONG_RUNNING_PROMPT Content Verification', () => {
  const kodaxCorePath = path.join(process.cwd(), 'src', 'kodax_core.ts');

  it('should contain Long-Running Task Mode section', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Long-Running Task Mode');
    expect(content).toContain('At the start of EACH session, follow these steps:');
  });

  it('should contain all 6 steps', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('1. Note the Working Directory from context');
    expect(content).toContain('2. Read git logs');
    expect(content).toContain('3. Read feature_list.json and pick ONE incomplete feature');
    expect(content).toContain('4. **Write a session plan**');
    expect(content).toContain('5. Execute the plan step by step');
    expect(content).toContain('6. End session with: git commit');
  });

  it('should contain IMPORTANT Rules', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('IMPORTANT Rules:');
    // Check for key rule concepts (without exact backticks)
    expect(content).toContain('passes');
    expect(content).toContain('Leave codebase in clean state');
    expect(content).toContain('Work on ONE feature at a time');
    expect(content).toContain('verify features work end-to-end');
  });

  it('should contain Session Planning template', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Session Planning (CRITICAL for Quality)');
    expect(content).toContain('# Session Plan');
    expect(content).toContain('**Date**:');
    expect(content).toContain('**Feature**:');
    expect(content).toContain('## Understanding');
    expect(content).toContain('## Approach');
    expect(content).toContain('## Steps');
    expect(content).toContain('## Considerations');
    expect(content).toContain('## Risks');
  });

  it('should contain Efficiency Rules', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Efficiency Rules (CRITICAL)');
    expect(content).toContain('Each session MUST complete at least ONE full feature');
    expect(content).toContain('Minimum meaningful code change per session: 50+ lines');
    expect(content).toContain('A single-page display task should be completed in ONE session');
  });

  it('should contain Promise Signals', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('## Promise Signals (Ralph-Loop Style)');
    expect(content).toContain('<promise>COMPLETE</promise>');
    expect(content).toContain('<promise>BLOCKED:reason</promise>');
    expect(content).toContain('<promise>DECIDE:question</promise>');
  });
});

// ============== buildInitPrompt 测试 ==============

describe('buildInitPrompt Content Verification', () => {
  const kodaxCliPath = path.join(process.cwd(), 'src', 'kodax_cli.ts');

  it('should contain feature definition', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**What is a Feature?**');
    expect(content).toContain('A feature is a COMPLETE, TESTABLE functionality');
    expect(content).toContain('~50-300 lines per feature');
  });

  it('should contain Feature Count Guidelines', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('Feature Count Guidelines');
    expect(content).toContain('Simple task');
    expect(content).toContain('Medium task');
    expect(content).toContain('Complex task');
  });

  it('should contain DO/DON\'T sections', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**DO:**');
    expect(content).toContain('Split by user-facing features');
    expect(content).toContain('**DO NOT:**');
    expect(content).toContain('Split by technical layers');
  });

  it('should contain GOOD/BAD examples', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**Examples of GOOD features:**');
    expect(content).toContain('**Examples of BAD features:**');
    expect(content).toContain('User authentication (register, login, logout)');
    expect(content).toContain('Add HTML structure');
  });

  it('should contain PROGRESS.md template', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('2. **PROGRESS.md**');
    expect(content).toContain('# Progress Log');
    expect(content).toContain('### Completed');
    expect(content).toContain('### Next Steps');
  });

  it('should contain git commit instructions', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('git add .');
    expect(content).toContain('git commit');
    expect(content).toContain('Initial commit');
  });
});

// ============== --append prompt 测试 ==============

describe('--append Prompt Content Verification', () => {
  const kodaxCliPath = path.join(process.cwd(), 'src', 'kodax_cli.ts');

  it('should contain existing features warning', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**Existing Features** (DO NOT modify these');
    expect(content).toContain('Do NOT delete or modify existing features');
  });

  it('should contain task steps', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**Your Task**:');
    expect(content).toContain('1. Read the existing feature_list.json');
    expect(content).toContain('2. Create NEW features');
    expect(content).toContain('3. Use the EDIT tool to APPEND');
    expect(content).toContain('4. Add a new section to PROGRESS.md');
  });

  it('should contain New Feature Guidelines', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**New Feature Guidelines:**');
    expect(content).toContain('5-10 NEW features');
    expect(content).toContain('completable in 1 session');
    expect(content).toContain('"passes": false');
  });

  it('should contain JSON example', async () => {
    const content = await fs.readFile(kodaxCliPath, 'utf-8');
    expect(content).toContain('**Example of appending to feature_list.json:**');
    expect(content).toContain('Old:');
    expect(content).toContain('New:');
  });
});

// ============== toolBash timeout message 测试 ==============

describe('toolBash Timeout Message Verification', () => {
  const kodaxCorePath = path.join(process.cwd(), 'src', 'kodax_core.ts');

  it('should contain all timeout suggestions', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('[Suggestion] The command took too long. Consider:');
    expect(content).toContain('Is this a watch/dev server? Run in a separate terminal.');
    expect(content).toContain('Can the task be broken into smaller steps?');
    expect(content).toContain('Is there an error causing it to hang?');
  });
});

// ============== Retry prompts 测试 ==============

describe('Retry Prompts Content Verification', () => {
  const kodaxCorePath = path.join(process.cwd(), 'src', 'kodax_core.ts');

  it('should contain first retry prompt with concise instruction', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('For large content, keep it concise (under 50 lines for write operations)');
  });

  it('should contain second retry prompt with detailed instructions', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('⚠️ CRITICAL: Your response was TRUNCATED again');
    expect(content).toContain('YOU MUST:');
    expect(content).toContain("For 'write' tool: Keep content under 50 lines");
    expect(content).toContain("For 'edit' tool: Keep new_string under 30 lines");
    expect(content).toContain('PROVIDE SHORT, COMPLETE PARAMETERS NOW');
  });

  it('should contain incompleteRetryCount conditional', async () => {
    const content = await fs.readFile(kodaxCorePath, 'utf-8');
    expect(content).toContain('if (incompleteRetryCount === 1)');
    expect(content).toContain('} else {');
  });
});

// ============== 源文件一致性测试 ==============

describe('Source File Consistency', () => {
  const kodaxPath = path.join(process.cwd(), 'src', 'kodax.ts');
  const kodaxCorePath = path.join(process.cwd(), 'src', 'kodax_core.ts');
  const kodaxCliPath = path.join(process.cwd(), 'src', 'kodax_cli.ts');

  it('should have SYSTEM_PROMPT in both files', async () => {
    const kodaxContent = await fs.readFile(kodaxPath, 'utf-8');
    const kodaxCoreContent = await fs.readFile(kodaxCorePath, 'utf-8');

    // Verify key sections exist in both
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
      expect(kodaxContent).toContain(section);
      expect(kodaxCoreContent).toContain(section);
    }
  });

  it('should have LONG_RUNNING_PROMPT in both files', async () => {
    const kodaxContent = await fs.readFile(kodaxPath, 'utf-8');
    const kodaxCoreContent = await fs.readFile(kodaxCorePath, 'utf-8');

    const keySections = [
      '## Long-Running Task Mode',
      '## Session Planning (CRITICAL for Quality)',
      '## Efficiency Rules (CRITICAL)',
      '## Promise Signals (Ralph-Loop Style)',
    ];

    for (const section of keySections) {
      expect(kodaxContent).toContain(section);
      expect(kodaxCoreContent).toContain(section);
    }
  });

  it('should have buildInitPrompt in both files', async () => {
    const kodaxContent = await fs.readFile(kodaxPath, 'utf-8');
    const kodaxCliContent = await fs.readFile(kodaxCliPath, 'utf-8');

    const keySections = [
      'What is a Feature?',
      'Feature Count Guidelines',
      'DO:',
      'DO NOT:',
      'Examples of GOOD features:',
      'Examples of BAD features:',
      'PROGRESS.md',
    ];

    for (const section of keySections) {
      expect(kodaxContent).toContain(section);
      expect(kodaxCliContent).toContain(section);
    }
  });

  it('should have --append prompt in both files', async () => {
    const kodaxContent = await fs.readFile(kodaxPath, 'utf-8');
    const kodaxCliContent = await fs.readFile(kodaxCliPath, 'utf-8');

    const keySections = [
      '**Existing Features** (DO NOT modify these',
      '**New Feature Guidelines:**',
      '**Example of appending to feature_list.json:**',
    ];

    for (const section of keySections) {
      expect(kodaxContent).toContain(section);
      expect(kodaxCliContent).toContain(section);
    }
  });
});
