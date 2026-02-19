/**
 * KodaX 项目命令处理器
 *
 * 处理 /project 命令组的所有子命令
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { runKodaX, KodaXOptions } from '../core/index.js';
import { ProjectStorage } from './project-storage.js';
import {
  ProjectFeature,
  ProjectStatistics,
  isAllCompleted,
} from './project-state.js';
import {
  InteractiveContext,
  createInteractiveContext,
} from './context.js';
import {
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import { buildInitPrompt } from '../cli/utils.js';

// 延迟创建 readline 接口
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

async function question(prompt: string): Promise<string> {
  return new Promise(resolve => {
    getReadline().question(prompt, resolve);
  });
}

/**
 * 获取项目存储实例
 */
function getProjectStorage(): ProjectStorage {
  return new ProjectStorage(process.cwd());
}

/**
 * 打印项目帮助
 */
function printProjectHelp(): void {
  console.log(chalk.cyan('\n/project - Project Long-Running Task Management\n'));
  console.log('Commands:');
  console.log(chalk.dim('  /project init <task>     ') + 'Initialize a long-running project');
  console.log(chalk.dim('  /project status          ') + 'Show project status and progress');
  console.log(chalk.dim('  /project next            ') + 'Execute next pending feature');
  console.log(chalk.dim('  /project auto            ') + 'Enter auto-continue mode');
  console.log(chalk.dim('  /project pause           ') + 'Pause auto-continue mode');
  console.log(chalk.dim('  /project list            ') + 'List all features');
  console.log(chalk.dim('  /project mark <n> [done|skip]') + 'Mark feature status');
  console.log(chalk.dim('  /project progress        ') + 'View PROGRESS.md');
  console.log();
  console.log('Aliases: /proj, /p');
  console.log();
}

/**
 * 显示项目状态
 */
async function projectStatus(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const stats = await storage.getStatistics();
  const next = await storage.getNextPendingFeature();

  // 状态条
  const barLength = 20;
  const completedBars = Math.round((stats.percentage / 100) * barLength);
  const bar = '█'.repeat(completedBars) + '░'.repeat(barLength - completedBars);

  console.log(chalk.cyan('\nProject Status:'));
  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(`  Total Features:   ${stats.total}`);
  console.log(`  Completed:        ${chalk.green(stats.completed.toString())}  [${bar} ${stats.percentage}%]`);
  console.log(`  Pending:          ${chalk.yellow(stats.pending.toString())}`);
  console.log(`  Skipped:          ${chalk.dim(stats.skipped.toString())}`);
  console.log(chalk.dim('  ─────────────────────────────────────'));

  if (next) {
    console.log(chalk.cyan(`\nNext Feature (Index ${next.index}):`));
    const desc = next.feature.description || next.feature.name || 'Unnamed';
    console.log(chalk.white(`  ${desc}`));
    if (next.feature.steps?.length) {
      console.log(chalk.dim(`  Steps: ${next.feature.steps.length}`));
    }
  } else if (stats.pending === 0) {
    console.log(chalk.green('\n  ✓ All features completed or skipped'));
  }

  console.log();
}

/**
 * 初始化项目
 */
async function projectInit(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<void> {
  const storage = getProjectStorage();

  // 检查是否已存在
  if (await storage.exists()) {
    const hasAppend = args.includes('--append');
    const hasOverwrite = args.includes('--overwrite');

    if (!hasAppend && !hasOverwrite) {
      console.log(chalk.yellow('\n[Project already exists]'));
      console.log(chalk.dim('Use --append to add features or --overwrite to replace\n'));
      return;
    }

    if (hasOverwrite) {
      const confirmed = await confirm('Overwrite existing project?');
      if (!confirmed) {
        console.log(chalk.dim('\nCancelled\n'));
        return;
      }
    }
  }

  // 获取任务描述
  const taskArgs = args.filter(a => !a.startsWith('--'));
  const task = taskArgs.join(' ').trim();

  if (!task) {
    console.log(chalk.yellow('\nUsage: /project init <task description>'));
    console.log(chalk.dim('Example: /project init "TypeScript + Express REST API"\n'));
    return;
  }

  console.log(chalk.dim('\n📝 Initializing project...\n'));

  try {
    // 调用 CLI 的 buildInitPrompt 函数
    const initPrompt = buildInitPrompt(task);

    // 获取 KodaX 选项
    const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;

    // 执行初始化
    const result = await runKodaX(
      {
        ...options,
        session: {
          ...options.session,
          initialMessages: context.messages,
        },
      },
      initPrompt
    );

    // 更新上下文消息
    context.messages = result.messages;

    console.log(chalk.green('\n✓ Project initialized'));
    console.log(chalk.dim(`  Created: feature_list.json, PROGRESS.md\n`));

    // 显示状态
    await projectStatus();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Error] ${err.message}\n`));
  }
}

/**
 * 执行下一个功能
 */
async function projectNext(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const next = await storage.getNextPendingFeature();
  if (!next) {
    console.log(chalk.green('\n✓ All features completed or skipped\n'));
    return;
  }

  // 解析选项
  const hasNoConfirm = args.includes('--no-confirm');
  const indexArg = args.find(a => a.startsWith('--index='));
  const explicitIndex = indexArg ? parseInt(indexArg.split('=')[1] ?? '0', 10) : null;

  // 如果指定了索引，使用指定的
  const targetIndex = explicitIndex !== null ? explicitIndex : next.index;
  const feature = await storage.getFeatureByIndex(targetIndex);

  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${targetIndex} not found\n`));
    return;
  }

  // 显示功能信息
  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.cyan(`\nNext Feature (Index ${targetIndex}):`));
  console.log(chalk.white(`  ${desc}`));

  if (feature.steps?.length) {
    console.log(chalk.dim('\n  Planned steps:'));
    feature.steps.forEach((step, i) => {
      console.log(chalk.dim(`    ${i + 1}. ${step}`));
    });
  }

  console.log();

  // 确认执行
  if (!hasNoConfirm) {
    const confirmed = await confirm('Execute this feature?');
    if (!confirmed) {
      console.log(chalk.dim('\nCancelled\n'));
      return;
    }
  }

  console.log(chalk.dim('\n[Executing...]\n'));

  try {
    // 更新开始时间
    await storage.updateFeatureStatus(targetIndex, {
      startedAt: new Date().toISOString(),
    });

    // 获取 KodaX 选项
    const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;

    // 执行功能
    const prompt = `Continue implementing the project. Focus on this feature:

${desc}

${feature.steps?.length ? 'Planned steps:\n' + feature.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''}

After completing this feature, update feature_list.json to mark it as passes: true.`;

    const result = await runKodaX(
      {
        ...options,
        session: {
          ...options.session,
          initialMessages: context.messages,
        },
      },
      prompt
    );

    // 更新上下文消息
    context.messages = result.messages;

    // 检查是否完成（通过读取更新后的 feature_list.json）
    const updatedFeature = await storage.getFeatureByIndex(targetIndex);
    if (updatedFeature?.passes) {
      await storage.updateFeatureStatus(targetIndex, {
        completedAt: new Date().toISOString(),
      });
      console.log(chalk.green('\n✓ Feature completed\n'));
    } else {
      console.log(chalk.yellow('\n⚠ Feature may not be fully completed'));
      console.log(chalk.dim('Check the result and manually mark with /project mark <index> done\n'));
    }

    // 显示进度
    const stats = await storage.getStatistics();
    console.log(chalk.dim(`Progress: ${stats.completed}/${stats.total} [${stats.percentage}%]\n`));

  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Error] ${err.message}\n`));
  }
}

/**
 * 自动继续模式
 */
let autoContinueRunning = false;

async function projectAuto(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  if (autoContinueRunning) {
    console.log(chalk.yellow('\n[Auto-continue already running]'));
    console.log(chalk.dim('Use /project pause to stop\n'));
    return;
  }

  // 解析选项
  const hasNoConfirm = args.includes('--no-confirm');
  const maxArg = args.find(a => a.startsWith('--max='));
  const maxRuns = maxArg ? parseInt(maxArg.split('=')[1] ?? '10', 10) : 0; // 0 = unlimited

  const stats = await storage.getStatistics();
  let runCount = 0;

  console.log(chalk.cyan('\nAuto-Continue Mode'));
  console.log(chalk.dim(`  Max runs: ${maxRuns || 'unlimited'}`));
  console.log(chalk.dim(`  Confirm each: ${hasNoConfirm ? 'no' : 'yes'}`));
  console.log(chalk.dim(`  Remaining: ${stats.pending} features`));
  console.log();

  autoContinueRunning = true;

  while (autoContinueRunning) {
    const next = await storage.getNextPendingFeature();
    if (!next) {
      console.log(chalk.green('\n✓ All features completed\n'));
      break;
    }

    runCount++;
    if (maxRuns > 0 && runCount > maxRuns) {
      console.log(chalk.yellow('\nMax runs reached\n'));
      break;
    }

    const desc = next.feature.description || next.feature.name || 'Unnamed';
    console.log(chalk.cyan(`[${runCount}] ${desc}`));

    // 确认
    if (!hasNoConfirm) {
      const answer = await question('Execute? (y/n/s=skip/q=quit) ');
      const action = answer.toLowerCase().trim();

      if (action === 'q' || action === 'quit') {
        console.log(chalk.dim('\nPaused\n'));
        break;
      }
      if (action === 's' || action === 'skip') {
        await storage.updateFeatureStatus(next.index, { skipped: true });
        console.log(chalk.dim('  Skipped\n'));
        continue;
      }
      if (!action.startsWith('y')) {
        console.log(chalk.dim('  Skipped\n'));
        continue;
      }
    }

    // 执行
    try {
      const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;

      const prompt = `Continue implementing the project. Focus on this feature:

${desc}

After completing, update feature_list.json to mark it as passes: true.`;

      const result = await runKodaX(
        {
          ...options,
          session: {
            ...options.session,
            initialMessages: context.messages,
          },
        },
        prompt
      );

      context.messages = result.messages;

      const updatedFeature = await storage.getFeatureByIndex(next.index);
      if (updatedFeature?.passes) {
        console.log(chalk.green('  ✓ Completed\n'));
      } else {
        console.log(chalk.yellow('  ⚠ May need review\n'));
      }

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.log(chalk.red(`  ✗ Error: ${err.message}\n`));

      const continueAfter = await confirm('Continue with next feature?');
      if (!continueAfter) {
        break;
      }
    }
  }

  autoContinueRunning = false;
}

/**
 * 暂停自动继续
 */
async function projectPause(): Promise<void> {
  if (autoContinueRunning) {
    autoContinueRunning = false;
    console.log(chalk.cyan('\n[Auto-continue paused]\n'));
  } else {
    console.log(chalk.yellow('\n[Auto-continue not running]\n'));
  }
}

/**
 * 列出所有功能
 */
async function projectList(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const features = await storage.listFeatures();
  const stats = await storage.getStatistics();

  console.log(chalk.cyan(`\nFeatures (${stats.total} total):\n`));

  features.forEach((f, i) => {
    const status = f.passes
      ? chalk.green('✓')
      : f.skipped
        ? chalk.dim('⊘')
        : chalk.yellow('○');

    const desc = f.description || f.name || 'Unnamed';
    const preview = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;

    console.log(`  ${status} ${chalk.dim(`${i}.`)} ${preview}`);
  });

  console.log();
  console.log(chalk.dim(`  Legend: ✓ completed  ○ pending  ⊘ skipped\n`));
}

/**
 * 标记功能状态
 */
async function projectMark(args: string[]): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const index = parseInt(args[0] ?? '', 10);
  const status = (args[1] ?? '').toLowerCase();

  if (isNaN(index)) {
    console.log(chalk.yellow('\nUsage: /project mark <index> [done|skip]'));
    console.log(chalk.dim('Example: /project mark 3 done\n'));
    return;
  }

  const feature = await storage.getFeatureByIndex(index);
  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${index} not found\n`));
    return;
  }

  const updates: Partial<ProjectFeature> = {};

  if (status === 'done') {
    updates.passes = true;
    updates.completedAt = new Date().toISOString();
  } else if (status === 'skip') {
    updates.skipped = true;
  } else {
    console.log(chalk.yellow('\nUsage: /project mark <index> [done|skip]'));
    console.log(chalk.dim('Example: /project mark 3 done\n'));
    return;
  }

  await storage.updateFeatureStatus(index, updates);

  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.green(`\n✓ Marked feature ${index} as ${status}`));
  console.log(chalk.dim(`  ${desc}\n`));
}

/**
 * 查看进度文件
 */
async function projectProgress(): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]\n'));
    return;
  }

  const progress = await storage.readProgress();

  if (!progress) {
    console.log(chalk.dim('\n[PROGRESS.md is empty]\n'));
    return;
  }

  console.log(chalk.cyan('\nPROGRESS.md:\n'));
  console.log(chalk.dim('─'.repeat(50)));
  // 只显示最后 50 行
  const lines = progress.split('\n');
  const displayLines = lines.slice(-50);
  console.log(displayLines.join('\n'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log();
}

/**
 * 主入口：处理 /project 命令
 */
export async function handleProjectCommand(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<void> {
  const subCommand = args[0]?.toLowerCase();

  switch (subCommand) {
    case 'init':
    case 'i':
      await projectInit(args.slice(1), context, callbacks, currentConfig);
      break;

    case 'status':
    case 'st':
    case 'info':
      await projectStatus();
      break;

    case 'next':
    case 'n':
      await projectNext(args.slice(1), context, callbacks, currentConfig);
      break;

    case 'auto':
    case 'a':
      await projectAuto(args.slice(1), context, callbacks, currentConfig);
      break;

    case 'pause':
      await projectPause();
      break;

    case 'list':
    case 'l':
      await projectList();
      break;

    case 'mark':
    case 'm':
      await projectMark(args.slice(1));
      break;

    case 'progress':
    case 'p':
      await projectProgress();
      break;

    default:
      printProjectHelp();
  }
}

/**
 * 检测并显示项目提示
 */
export async function detectAndShowProjectHint(): Promise<boolean> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    return false;
  }

  const stats = await storage.getStatistics();

  console.log(chalk.cyan('  📁 Long-running project detected'));
  console.log(chalk.dim(`    ${stats.completed}/${stats.total} features completed [${stats.percentage}%]`));
  console.log(chalk.dim('    Use /project status to view progress'));
  console.log(chalk.dim('    Use /project next to work on next feature'));
  console.log();

  return true;
}
