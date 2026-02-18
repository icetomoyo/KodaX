/**
 * Plan Mode 主逻辑
 */

import { runKodaX, KodaXOptions } from '../core/index.js';
import { planStorage, ExecutionPlan } from './plan-storage.js';
import chalk from 'chalk';
import * as readline from 'readline';

// 延迟创建 readline 接口，避免与 REPL 层冲突导致字符重复
let rl: readline.Interface | null = null;

function getReadline(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdout.isTTY ?? true,
    });
  }
  return rl;
}

async function confirm(message: string): Promise<boolean> {
  return new Promise(resolve => {
    getReadline().question(`${message} (y/n) `, answer => {
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// 生成计划提示词
const PLAN_GENERATION_PROMPT = `You are in PLAN MODE. Do not execute any tools yet.

Analyze the user's request and create a detailed execution plan.

Respond with a simple text plan in this format:

PLAN: <Brief title>

Steps:
1. [ACTION] <description> - <target file/command>
2. [ACTION] <description> - <target file/command>
...

Available actions: READ, WRITE, EDIT, BASH, EXPLAIN

Example:
PLAN: Add User Authentication

Steps:
1. [READ] Check current project structure - .
2. [READ] Check dependencies - package.json
3. [WRITE] Create auth middleware - src/middleware/auth.ts
4. [EDIT] Add auth routes - src/routes/index.ts
5. [EXPLAIN] Explain how to use the new auth system
`;

async function generatePlan(prompt: string, options: KodaXOptions): Promise<string> {
  // 临时修改系统提示来生成计划
  const planOptions: KodaXOptions = {
    ...options,
    maxIter: 1,  // 只生成计划，不执行工具
  };

  const result = await runKodaX(planOptions,
    prompt + '\n\n[SYSTEM: Please generate a plan only, do not execute any tools. Respond with the plan format specified in your instructions.]'
  );

  return result.lastText || '';
}

// 简单解析文本计划
function parsePlanText(text: string, originalPrompt: string): ExecutionPlan {
  const lines = text.split('\n');
  const title = lines.find(l => l.startsWith('PLAN:'))?.replace('PLAN:', '').trim()
    || 'Untitled Plan';

  const steps: ExecutionPlan['steps'] = [];
  let stepId = 0;

  for (const line of lines) {
    // 匹配: 1. [READ] description - target
    const match = line.match(/^\d+\.\s*\[([A-Z]+)\]\s*(.+?)(?:\s+-\s+(.+))?$/);
    if (match) {
      steps.push({
        id: `step-${stepId++}`,
        description: match[2].trim(),
        tool: match[1].toLowerCase(),
        input: match[3] ? { path: match[3].trim() } : undefined,
        status: 'pending'
      });
    }
  }

  return {
    id: `plan-${Date.now()}`,
    title,
    originalPrompt,
    steps,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// 展示计划
function displayPlan(plan: ExecutionPlan): void {
  console.log(chalk.cyan('\n╔══════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan(`║  📋 ${plan.title.padEnd(55)}║`));
  console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════╝\n'));

  console.log(chalk.bold('Steps:'));
  plan.steps.forEach((step, i) => {
    const iconMap: Record<string, string> = {
      read: '📖',
      write: '✏️',
      edit: '🔧',
      bash: '⚡',
      explain: '💡'
    };
    const icon = step.tool ? iconMap[step.tool] || '•' : '•';

    const status = step.status === 'done' ? chalk.green(' ✓') :
                   step.status === 'skipped' ? chalk.yellow(' ⊘') :
                   step.status === 'failed' ? chalk.red(' ✗') : '';

    console.log(`  ${i + 1}. ${icon} ${step.description}${status}`);
    if (step.input?.path) {
      console.log(chalk.dim(`     Target: ${step.input.path}`));
    }
  });

  const progress = plan.steps.filter(s => s.status === 'done').length;
  console.log(chalk.dim(`\nProgress: ${progress}/${plan.steps.length} completed\n`));
}

// 执行计划
async function executePlan(
  plan: ExecutionPlan,
  options: KodaXOptions
): Promise<void> {
  console.log(chalk.cyan('\n📋 Executing plan...\n'));

  const pendingSteps = plan.steps.filter(s => s.status === 'pending');

  for (const step of pendingSteps) {
    console.log(chalk.dim(`\n[Step ${plan.steps.indexOf(step) + 1}/${plan.steps.length}]`));
    console.log(`${step.description}`);

    const shouldExecute = await confirm('Execute this step?');

    if (!shouldExecute) {
      step.status = 'skipped';
      await planStorage.save(plan);
      continue;
    }

    try {
      // 执行步骤
      const stepOptions: KodaXOptions = {
        ...options,
        beforeToolExecute: async (tool, input) => {
          console.log(chalk.dim(`  Using tool: ${tool}`));
          return true;
        }
      };

      await runKodaX(stepOptions, `Execute this step: ${step.description}`);

      step.status = 'done';
      step.executedAt = new Date().toISOString();
      await planStorage.save(plan);

      console.log(chalk.green('  ✓ Done'));

    } catch (error) {
      step.status = 'failed';
      await planStorage.save(plan);
      console.log(chalk.red(`  ✗ Failed: ${error}`));

      const continuePlan = await confirm('Continue with next step?');
      if (!continuePlan) break;
    }
  }

  console.log(chalk.cyan('\n📋 Plan execution completed\n'));
}

// 主入口
export async function runWithPlanMode(
  prompt: string,
  options: KodaXOptions
): Promise<void> {
  // 1. 检查未完成计划
  const pending = await planStorage.findPending();
  if (pending) {
    const progress = pending.steps.filter(s => s.status === 'done').length;
    const resume = await confirm(
      `📋 Found pending plan: ${pending.title}\n` +
      `Progress: ${progress}/${pending.steps.length}\n` +
      `Resume?`
    );

    if (resume) {
      displayPlan(pending);
      return executePlan(pending, options);
    }
  }

  // 2. 生成新计划
  console.log(chalk.dim('\n📝 Generating plan...\n'));
  const planText = await generatePlan(prompt, options);

  if (!planText || planText.trim().length === 0) {
    console.log(chalk.red('Failed to generate plan. Please try again.'));
    return;
  }

  const plan = parsePlanText(planText, prompt);

  if (plan.steps.length === 0) {
    console.log(chalk.yellow('No actionable steps found in the plan.'));
    return;
  }

  // 3. 保存计划
  await planStorage.save(plan);

  // 4. 展示并确认
  displayPlan(plan);
  const confirmed = await confirm('Execute this plan?');

  if (!confirmed) {
    console.log(chalk.dim('\nPlan saved. Use "/plan resume" to continue.\n'));
    return;
  }

  // 5. 执行
  await executePlan(plan, options);
}

// 列出所有计划
export async function listPlans(): Promise<void> {
  const plans = await planStorage.list();

  if (plans.length === 0) {
    console.log(chalk.dim('\nNo saved plans\n'));
    return;
  }

  console.log(chalk.cyan('\n📋 Saved Plans:\n'));
  plans.forEach(p => {
    const progress = p.steps.filter(s => s.status === 'done').length;
    const total = p.steps.length;
    const status = progress === total ? chalk.green('completed') :
                   progress > 0 ? chalk.yellow('in progress') : chalk.dim('pending');
    console.log(`  ${p.id.slice(0, 8)}  ${p.title.slice(0, 40).padEnd(42)}  ${progress}/${total}  [${status}]`);
  });
  console.log();
}

// 恢复指定计划
export async function resumePlan(planId: string, options: KodaXOptions): Promise<void> {
  const plan = await planStorage.load(planId);
  if (!plan) {
    console.log(chalk.red('\nPlan not found\n'));
    return;
  }

  displayPlan(plan);
  const confirmed = await confirm('Resume this plan?');

  if (confirmed) {
    await executePlan(plan, options);
  }
}

// 清除已完成计划
export async function clearCompletedPlans(): Promise<void> {
  const plans = await planStorage.list();
  const completed = plans.filter(p =>
    p.steps.every(s => s.status === 'done' || s.status === 'skipped')
  );

  for (const p of completed) {
    await planStorage.delete(p.id);
  }

  console.log(chalk.dim(`\nCleared ${completed.length} completed plans\n`));
}
