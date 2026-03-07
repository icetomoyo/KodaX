/**
 * KodaX 项目命令处理器
 *
 * 处理 /project 命令组的所有子命令
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { runKodaX, KodaXOptions, KodaXMessage } from '@kodax/coding';
import { ProjectStorage } from './project-storage.js';
import {
  ProjectFeature,
} from './project-state.js';
import {
  InteractiveContext,
} from './context.js';
import {
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import { buildInitPrompt } from '../common/utils.js';

// ============== 运行时状态管理 ==============

/**
 * 项目运行时状态
 *
 * 用于管理 auto-continue 模式的状态。
 * 设计为模块级单例，因为 REPL 会话中只会有一个自动继续循环。
 */
class ProjectRuntimeState {
  private _autoContinueRunning = false;

  get autoContinueRunning(): boolean {
    return this._autoContinueRunning;
  }

  setAutoContinueRunning(value: boolean): void {
    this._autoContinueRunning = value;
  }

  /** 重置所有状态（用于测试或会话重置） */
  reset(): void {
    this._autoContinueRunning = false;
  }
}

// 模块级单例
export const projectRuntimeState = new ProjectRuntimeState();

// ============== 辅助函数 ==============

/**
 * 创建确认提示函数
 */
function createConfirmFn(rl: readline.Interface): (message: string) => Promise<boolean> {
  return (message: string): Promise<boolean> => {
    return new Promise(resolve => {
      rl.question(`${message} (y/n) `, answer => {
        resolve(answer.trim().toLowerCase().startsWith('y'));
      });
    });
  };
}

/**
 * 创建问题提示函数
 */
function createQuestionFn(rl: readline.Interface): (prompt: string) => Promise<string> {
  return (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, resolve);
    });
  };
}

/**
 * 获取项目存储实例
 */
function getProjectStorage(): ProjectStorage {
  return new ProjectStorage(process.cwd());
}

/**
 * 解析 feature index，支持 #<n> 和 <n> 两种格式
 *
 * @param arg - 用户输入的参数（如 "#3" 或 "3"）
 * @returns 解析后的数字，无效输入返回 null
 */
function parseFeatureIndex(arg: string): number | null {
  // 支持 #3 格式
  if (arg.startsWith('#')) {
    const num = parseInt(arg.slice(1), 10);
    return isNaN(num) ? null : num;
  }

  // 支持 3 格式（向后兼容）
  const num = parseInt(arg, 10);
  return isNaN(num) ? null : num;
}

/**
 * 显示功能信息
 */
function displayFeatureInfo(feature: ProjectFeature, index: number): void {
  const desc = feature.description || feature.name || 'Unnamed';
  console.log(chalk.cyan(`\nNext Feature (Index ${index}):`));
  console.log(chalk.white(`  ${desc}`));

  if (feature.steps?.length) {
    console.log(chalk.dim('\n  Planned steps:'));
    feature.steps.forEach((step, i) => {
      console.log(chalk.dim(`    ${i + 1}. ${step}`));
    });
  }
  console.log();
}

/**
 * 构建 feature 执行的提示词
 *
 * @param desc - Feature 描述
 * @param steps - Feature 步骤（可选）
 * @param userPrompt - 用户提供的额外指导（可选）
 */
function buildFeaturePrompt(desc: string, steps?: string[], userPrompt?: string): string {
  const stepsSection = steps?.length
    ? `\n\nPlanned steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';

  const userSection = userPrompt
    ? `\n\nAdditional requirements:\n${userPrompt}`
    : '';

  return `Continue implementing the project. Focus on this feature:

${desc}${stepsSection}${userSection}

After completing this feature, update feature_list.json to mark it as passes: true.`;
}

/**
 * 执行单个功能
 */
async function executeSingleFeature(
  feature: ProjectFeature,
  index: number,
  context: InteractiveContext,
  options: KodaXOptions,
  userPrompt?: string
): Promise<{ success: boolean; messages: KodaXMessage[] }> {
  const desc = feature.description || feature.name || 'Unnamed';
  const prompt = buildFeaturePrompt(desc, feature.steps, userPrompt);

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

  return {
    success: true,
    messages: result.messages,
  };
}

// ============== 命令处理函数 ==============

/**
 * 打印项目帮助（紧凑格式）
 */
export function printProjectHelp(): void {
  console.log(chalk.cyan('\n/project - Project Management\n'));

  console.log(chalk.bold('Commands:'));
  console.log(chalk.cyan('  init') + chalk.dim(' <task> [--append|--overwrite]') + '  Initialize project');
  console.log(chalk.cyan('  status') + chalk.dim(' [prompt] [--features|--progress]') + '  View status');
  console.log(chalk.cyan('  next') + chalk.dim(' [prompt|#index] [--no-confirm]') + '  Run next/specific feature');
  console.log(chalk.cyan('  auto') + chalk.dim(' [prompt] [--max=N|--confirm]') + '  Auto-run all');
  console.log(chalk.cyan('  edit') + chalk.dim(' [#index] <prompt>') + '  AI-driven editing');
  console.log(chalk.cyan('  reset') + chalk.dim(' [--all]') + '  Clear progress or delete files');
  console.log(chalk.cyan('  analyze') + chalk.dim(' [prompt]') + '  AI-powered analysis');
  console.log(chalk.dim('  mark <n> [done|skip]  [deprecated: use edit instead]'));
  console.log(chalk.dim('  list, progress        [deprecated: use status --features/--progress]'));

  console.log();
  console.log(chalk.bold('Edit Command:'));
  console.log(chalk.dim('  Single:  /project edit #3 "标记为完成"'));
  console.log(chalk.dim('  Global:  /project edit "删除所有已完成的"'));
  console.log(chalk.dim('  Actions: complete, skip, delete, modify description, add steps'));

  console.log();
  console.log(chalk.bold('Reset Command:'));
  console.log(chalk.dim('  /project reset        Clear PROGRESS.md (keep features)'));
  console.log(chalk.dim('  /project reset --all  Delete all 3 project files'));
  console.log(chalk.yellow('  ⚠️  Only deletes files created by /project init'));

  console.log();
  console.log(chalk.bold('Feature Index:'));
  console.log(chalk.dim('  Use #<number> to reference features (e.g., #0, #3, #5)'));

  console.log();
  console.log(chalk.bold('Quick Examples:'));
  console.log(chalk.dim('  /p init "Build API" → /p status → /p next → /p auto'));
  console.log(chalk.dim('  /p edit #3 "标记完成"  |  /p edit "删除已跳过的"'));
  console.log(chalk.dim('  /p analyze  |  /p analyze "风险评估"'));

  console.log();
  console.log(chalk.dim('Aliases: /proj, /p  |  For detailed help, read docs/features/v0.5.20.md'));
  console.log();
}

/**
 * 显示项目状态
 */
async function projectStatus(args: string[]): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  // 解析选项
  const showFeatures = args.includes('--features');
  const showProgress = args.includes('--progress');
  const guidance = args.filter(a => !a.startsWith('--')).join(' ');

  // 如果有 guidance，提示 AI 分析功能待实现
  if (guidance) {
    console.log(chalk.cyan('\n/project status - AI-Powered Analysis'));
    console.log(chalk.dim('\n[AI analysis coming in future release]'));
    console.log(chalk.dim(`Your request: "${guidance}"`));
    console.log(chalk.dim('For now, use --features or --progress options.\n'));
    return;
  }

  // 如果指定了 --features 或 --progress，显示对应内容
  if (showFeatures) {
    await projectList();
    if (showProgress) {
      console.log(); // 分隔
      await projectProgress();
    }
    return;
  }

  if (showProgress) {
    await projectProgress();
    return;
  }

  // 默认：显示简洁状态概览
  const stats = await storage.getStatistics();
  const next = await storage.getNextPendingFeature();

  // 状态条
  const barLength = 20;
  const completedBars = Math.round((stats.percentage / 100) * barLength);
  const bar = '█'.repeat(completedBars) + '░'.repeat(barLength - completedBars);

  console.log(chalk.cyan('\n📊 Project Status'));
  console.log(chalk.dim('  ────────────────────────────'));
  console.log(`  ✓ ${stats.completed}/${stats.total} completed (${stats.percentage}%)  [${bar}]`);
  console.log(`  ⏳ ${stats.pending} pending, ${stats.skipped} skipped`);

  if (next) {
    const desc = next.feature.description || next.feature.name || 'Unnamed';
    const preview = desc.length > 60 ? desc.slice(0, 57) + '...' : desc;
    console.log(chalk.cyan(`\nNext: #${next.index} - ${preview}`));
  } else if (stats.pending === 0) {
    console.log(chalk.green('\n  ✓ All features completed or skipped'));
  }

  console.log();
  console.log(chalk.dim('Use --features or --progress for detailed view'));
  console.log();
}

/**
 * 初始化项目
 */
async function projectInit(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>
): Promise<{ projectInitPrompt: string } | void> {
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

  // 构建 init prompt，返回给 InkREPL 处理
  // 这样可以使用正确的流式事件处理器
  const initPrompt = buildInitPrompt(task);
  return { projectInitPrompt: initPrompt };
}

/**
 * 执行下一个功能
 */
async function projectNext(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>
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

  // 解析选项和用户 prompt
  const hasNoConfirm = args.includes('--no-confirm');
  const indexArg = args.find(a => a.startsWith('--index='));

  // 支持 #<n> 语法
  let explicitIndex: number | null = null;
  if (indexArg) {
    explicitIndex = parseInt(indexArg.split('=')[1] ?? '0', 10);
  } else if (args.length > 0 && !args[0]!.startsWith('--')) {
    // 检查第一个参数是否是 #<n> 格式
    const parsed = parseFeatureIndex(args[0]!);
    if (parsed !== null) {
      explicitIndex = parsed;
    }
  }

  // 提取用户 prompt（所有非选项参数，排除 index）
  const userPrompt = args
    .filter(a => !a.startsWith('--') && a !== args.find(arg => parseFeatureIndex(arg!) !== null))
    .join(' ')
    .trim();

  // 如果指定了索引，使用指定的
  const targetIndex = explicitIndex !== null ? explicitIndex : next.index;
  const feature = await storage.getFeatureByIndex(targetIndex);

  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature at index ${targetIndex} not found\n`));
    return;
  }

  // 显示功能信息
  displayFeatureInfo(feature, targetIndex);

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
    const options = callbacks.createKodaXOptions?.();
    if (!options) {
      console.log(chalk.red('\n[Error] KodaX options not available\n'));
      return;
    }

    // 执行功能
    const result = await executeSingleFeature(feature, targetIndex, context, options, userPrompt);
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
 * 解析 auto 命令选项
 */
function parseAutoOptions(args: string[]): { hasConfirm: boolean; maxRuns: number } {
  const hasConfirm = args.includes('--confirm');
  const maxArg = args.find(a => a.startsWith('--max='));

  if (maxArg) {
    const parsed = parseInt(maxArg.split('=')[1] ?? '10', 10);
    // 验证：NaN 或负数都视为无限制（0）
    const maxRuns = isNaN(parsed) || parsed < 0 ? 0 : parsed;
    return { hasConfirm, maxRuns };
  }

  return { hasConfirm, maxRuns: 0 }; // 0 = unlimited
}

/**
 * 处理自动继续模式的用户输入
 */
type AutoAction = 'yes' | 'no' | 'skip' | 'quit';

function parseAutoAction(answer: string): AutoAction {
  const action = answer.toLowerCase().trim();
  if (action === 'q' || action === 'quit') return 'quit';
  if (action === 's' || action === 'skip') return 'skip';
  if (action.startsWith('y')) return 'yes';
  return 'no';
}

/**
 * 自动继续模式
 */
async function projectAuto(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  _currentConfig: CurrentConfig,
  confirm: (message: string) => Promise<boolean>,
  question: (prompt: string) => Promise<string>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  if (projectRuntimeState.autoContinueRunning) {
    console.log(chalk.yellow('\n[Auto-continue already running]'));
    console.log(chalk.dim('Use /project pause to stop\n'));
    return;
  }

  // 解析选项和用户 prompt
  const { hasConfirm, maxRuns } = parseAutoOptions(args);

  // 提取用户 prompt（所有非选项参数）
  const userPrompt = args
    .filter(arg => !arg.startsWith('--'))
    .join(' ')
    .trim();

  const stats = await storage.getStatistics();
  let runCount = 0;

  console.log(chalk.cyan('\nAuto-Continue Mode'));
  console.log(chalk.dim(`  Max runs: ${maxRuns || 'unlimited'}`));
  console.log(chalk.dim(`  Confirm each: ${hasConfirm ? 'yes' : 'no'}`));
  if (userPrompt) {
    console.log(chalk.dim(`  User guidance: ${userPrompt}`));
  }
  console.log(chalk.dim(`  Remaining: ${stats.pending} features`));
  console.log();

  projectRuntimeState.setAutoContinueRunning(true);

  try {
    while (projectRuntimeState.autoContinueRunning) {
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

      // 确认（仅在 --confirm 模式下）
      if (hasConfirm) {
        const answer = await question('Execute? (y/n/s=skip/q=quit) ');
        const action = parseAutoAction(answer);

        if (action === 'quit') {
          console.log(chalk.dim('\nPaused\n'));
          break;
        }
        if (action === 'skip') {
          await storage.updateFeatureStatus(next.index, { skipped: true });
          console.log(chalk.dim('  Skipped\n'));
          continue;
        }
        if (action === 'no') {
          console.log(chalk.dim('  Skipped\n'));
          continue;
        }
      }

      // 执行
      try {
        const options = callbacks.createKodaXOptions?.();
        if (!options) {
          console.log(chalk.red('\n[Error] KodaX options not available\n'));
          break;
        }
        const result = await executeSingleFeature(next.feature, next.index, context, options, userPrompt);
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
  } finally {
    projectRuntimeState.setAutoContinueRunning(false);
  }
}

/**
 * 暂停自动继续
 */
async function projectPause(): Promise<void> {
  if (projectRuntimeState.autoContinueRunning) {
    projectRuntimeState.setAutoContinueRunning(false);
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
 * AI 驱动的万能编辑命令
 *
 * 支持两种模式：
 * 1. 单个 feature 编辑：/project edit #3 "修改描述为 xxx"
 * 2. 全局编辑：/project edit "重新按优先级排序"
 */
async function projectEdit(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  if (args.length === 0) {
    console.log(chalk.yellow('\nUsage: /project edit [#index] <prompt>'));
    console.log(chalk.dim('\nExamples:'));
    console.log(chalk.dim('  Single feature:  /project edit #3 "修改描述为 xxx"'));
    console.log(chalk.dim('  Global edit:     /project edit "重新按优先级排序"'));
    console.log(chalk.dim('  Mark complete:   /project edit #3 "标记为完成"'));
    console.log(chalk.dim('  Delete feature:  /project edit #3 "删除"\n'));
    return;
  }

  // 检查第一个参数是否是 #index
  const firstArg = args[0];
  const isIndexBased = firstArg && parseFeatureIndex(firstArg) !== null;

  if (isIndexBased) {
    // 单个 feature 编辑
    const index = parseFeatureIndex(firstArg!)!;
    const guidance = args.slice(1).join(' ').trim();

    if (!guidance) {
      console.log(chalk.yellow('\n[Error] Please provide edit instructions'));
      console.log(chalk.dim('Example: /project edit #3 "修改描述"\n'));
      return;
    }

    await editSingleFeature(index, guidance, storage, context, callbacks, confirm);
  } else {
    // 全局编辑
    const guidance = args.join(' ').trim();
    await editGlobal(guidance, storage, context, callbacks, confirm);
  }
}

/**
 * 编辑单个 feature
 */
async function editSingleFeature(
  index: number,
  guidance: string,
  storage: ProjectStorage,
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const feature = await storage.getFeatureByIndex(index);
  if (!feature) {
    console.log(chalk.red(`\n[Error] Feature #${index} not found\n`));
    return;
  }

  console.log(chalk.cyan(`\n/project edit #${index}`));
  console.log(chalk.dim(`Current: ${feature.description || feature.name || 'Unnamed'}`));
  console.log(chalk.dim(`Instruction: "${guidance}"`));
  console.log();

  // 简单的意图识别（基于关键词）
  const lowerGuidance = guidance.toLowerCase();

  // 1. 删除操作
  if (lowerGuidance.includes('删除') || lowerGuidance.includes('delete')) {
    const confirmed = await confirm(`Delete feature #${index}?`);
    if (confirmed) {
      const data = await storage.loadFeatures();
      if (data) {
        data.features.splice(index, 1);
        await storage.saveFeatures(data);
        console.log(chalk.green(`✓ Deleted feature #${index}\n`));
      }
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
    return;
  }

  // 2. 标记为完成
  if (lowerGuidance.includes('完成') || lowerGuidance.includes('complete') || lowerGuidance.includes('done')) {
    const confirmed = await confirm(`Mark feature #${index} as completed?`);
    if (confirmed) {
      await storage.updateFeatureStatus(index, {
        passes: true,
        completedAt: new Date().toISOString(),
      });
      console.log(chalk.green(`✓ Marked feature #${index} as completed\n`));
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
    return;
  }

  // 3. 标记为跳过
  if (lowerGuidance.includes('跳过') || lowerGuidance.includes('skip')) {
    const confirmed = await confirm(`Mark feature #${index} as skipped?`);
    if (confirmed) {
      await storage.updateFeatureStatus(index, {
        skipped: true,
      });
      console.log(chalk.green(`✓ Marked feature #${index} as skipped\n`));
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
    return;
  }

  // 4. 修改描述
  if (lowerGuidance.includes('描述') || lowerGuidance.includes('description')) {
    // 提取新描述（去除"描述"、"修改"等关键词）
    let newDesc = guidance
      .replace(/修改|更改|更新|描述|description|为|to/gi, '')
      .trim();

    if (newDesc) {
      const confirmed = await confirm(`Update description to: "${newDesc}"?`);
      if (confirmed) {
        await storage.updateFeatureStatus(index, {
          description: newDesc,
        });
        console.log(chalk.green(`✓ Updated feature #${index} description\n`));
      } else {
        console.log(chalk.dim('\nCancelled.\n'));
      }
    } else {
      console.log(chalk.yellow('\n[Error] Please specify the new description'));
      console.log(chalk.dim('Example: /project edit #3 "修改描述为：新的功能描述"\n'));
    }
    return;
  }

  // 5. 添加步骤
  if (lowerGuidance.includes('步骤') || lowerGuidance.includes('step')) {
    const stepText = guidance
      .replace(/添加|增加|步骤|step/gi, '')
      .trim();

    if (stepText) {
      const newSteps = feature.steps ? [...feature.steps] : [];
      newSteps.push(stepText);

      const confirmed = await confirm(`Add step: "${stepText}"?`);
      if (confirmed) {
        await storage.updateFeatureStatus(index, {
          steps: newSteps,
        });
        console.log(chalk.green(`✓ Added step to feature #${index}\n`));
      } else {
        console.log(chalk.dim('\nCancelled.\n'));
      }
    } else {
      console.log(chalk.yellow('\n[Error] Please specify the step'));
      console.log(chalk.dim('Example: /project edit #3 "添加步骤：编写单元测试"\n'));
    }
    return;
  }

  // 6. 通用修改（使用 AI 辅助）
  console.log(chalk.cyan('Processing with AI assistance...'));

  // 对于复杂的修改请求，调用 AI 来理解意图
  const options = callbacks.createKodaXOptions?.();
  if (options) {
    const prompt = `Analyze this feature edit request and suggest changes:

Feature #${index}:
${JSON.stringify(feature, null, 2)}

User instruction: "${guidance}"

Please analyze the user's intent and suggest what fields should be updated.
Format your response as a brief explanation of what you understood and what changes you recommend.`;

    try {
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

      console.log(chalk.dim('\nAI Analysis:'));
      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.content) {
        const content = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');
        console.log(chalk.dim(content));
      }

      console.log(chalk.yellow('\nNote: Complex edits require manual feature_list.json editing.'));
      console.log(chalk.dim('Simple operations (complete, skip, delete, description) are automated.\n'));
    } catch (error) {
      console.log(chalk.yellow('\n[Warning] AI analysis failed'));
      console.log(chalk.dim('Please edit feature_list.json manually.\n'));
    }
  } else {
    console.log(chalk.yellow('\n[Error] AI options not available'));
    console.log(chalk.dim('Please edit feature_list.json manually.\n'));
  }
}

/**
 * 全局编辑（AI 驱动）
 */
async function editGlobal(
  guidance: string,
  storage: ProjectStorage,
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  console.log(chalk.cyan('\n/project edit - Global Edit'));
  console.log(chalk.dim(`Instruction: "${guidance}"`));
  console.log();

  const features = await storage.loadFeatures();
  if (!features) {
    console.log(chalk.red('\n[Error] Failed to load features\n'));
    return;
  }

  // 全局操作目前支持有限的几种
  const lowerGuidance = guidance.toLowerCase();

  // 1. 删除所有已完成的
  if (lowerGuidance.includes('删除') && (lowerGuidance.includes('完成') || lowerGuidance.includes('completed'))) {
    const completedCount = features.features.filter(f => f.passes).length;
    const confirmed = await confirm(`Delete ${completedCount} completed features?`);

    if (confirmed) {
      features.features = features.features.filter(f => !f.passes);
      await storage.saveFeatures(features);
      console.log(chalk.green(`✓ Deleted ${completedCount} completed features\n`));
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
    return;
  }

  // 2. 删除所有已跳过的
  if (lowerGuidance.includes('删除') && (lowerGuidance.includes('跳过') || lowerGuidance.includes('skipped'))) {
    const skippedCount = features.features.filter(f => f.skipped).length;
    const confirmed = await confirm(`Delete ${skippedCount} skipped features?`);

    if (confirmed) {
      features.features = features.features.filter(f => !f.skipped);
      await storage.saveFeatures(features);
      console.log(chalk.green(`✓ Deleted ${skippedCount} skipped features\n`));
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
    return;
  }

  // 3. 使用 AI 辅助复杂操作
  console.log(chalk.cyan('Processing with AI assistance...'));

  const options = callbacks.createKodaXOptions?.();
  if (options) {
    const prompt = `Analyze this global feature list edit request:

Current features (${features.features.length} total):
${JSON.stringify(features.features, null, 2)}

User instruction: "${guidance}"

Please analyze what changes are needed and provide:
1. A brief explanation of your understanding
2. What specific changes you recommend
3. Any potential issues or considerations

Note: Complex operations like reordering, merging, or splitting features require manual editing of feature_list.json.`;

    try {
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

      console.log(chalk.dim('\nAI Analysis:'));
      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.content) {
        const content = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');
        console.log(chalk.dim(content));
      }

      console.log(chalk.yellow('\nNote: Global edits are complex and require manual feature_list.json editing.'));
      console.log(chalk.dim('Automated operations: delete completed, delete skipped.\n'));
    } catch (error) {
      console.log(chalk.yellow('\n[Warning] AI analysis failed'));
      console.log(chalk.dim('Please edit feature_list.json manually.\n'));
    }
  } else {
    console.log(chalk.yellow('\n[Error] AI options not available'));
    console.log(chalk.dim('Please edit feature_list.json manually.\n'));
  }
}

/**
 * AI 驱动的项目分析
 */
async function projectAnalyze(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks
): Promise<void> {
  const storage = getProjectStorage();

  if (!(await storage.exists())) {
    console.log(chalk.yellow('\n[No project found]'));
    console.log(chalk.dim('Use /project init <task> to initialize a project\n'));
    return;
  }

  const guidance = args.join(' ').trim();
  const stats = await storage.getStatistics();
  const features = await storage.loadFeatures();

  if (!features) {
    console.log(chalk.red('\n[Error] Failed to load features\n'));
    return;
  }

  console.log(chalk.cyan('\n/project analyze - AI-Powered Project Analysis'));
  console.log(chalk.dim('─'.repeat(50)));
  console.log(chalk.dim(`Total: ${stats.total} | Completed: ${stats.completed} | Pending: ${stats.pending} | Skipped: ${stats.skipped}`));
  console.log(chalk.dim(`Progress: ${stats.percentage}%`));
  console.log();

  // 如果没有 AI 选项，显示基本分析
  const options = callbacks.createKodaXOptions?.();
  if (!options) {
    console.log(chalk.yellow('[Warning] AI analysis not available in current mode'));
    console.log(chalk.dim('\nBasic Analysis:'));
    console.log(chalk.dim(`  • ${stats.pending} features remaining`));

    if (stats.percentage > 75) {
      console.log(chalk.green('  • Project is nearly complete!'));
    } else if (stats.percentage > 50) {
      console.log(chalk.cyan('  • Good progress, keep going!'));
    } else if (stats.percentage > 25) {
      console.log(chalk.yellow('  • Steady progress, continue working'));
    } else {
      console.log(chalk.yellow('  • Project is in early stages'));
    }

    console.log();
    return;
  }

  // 默认分析（无 guidance）
  if (!guidance) {
    console.log(chalk.cyan('Running comprehensive project analysis...'));
    console.log();

    const prompt = `Analyze this software project and provide insights:

Project Statistics:
- Total features: ${stats.total}
- Completed: ${stats.completed} (${stats.percentage}%)
- Pending: ${stats.pending}
- Skipped: ${stats.skipped}

Pending features:
${JSON.stringify(features.features.filter(f => !f.passes && !f.skipped).slice(0, 10), null, 2)}

Please provide:
1. **Progress Assessment**: Overall project health and momentum
2. **Risk Analysis**: Potential blockers or risky features
3. **Priority Recommendations**: Which features should be tackled next
4. **Time Estimation**: Rough estimate of remaining work (based on feature complexity)
5. **Quality Check**: Any patterns or issues you notice

Keep your analysis concise and actionable.`;

    try {
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

      const lastMessage = result.messages[result.messages.length - 1];
      if (lastMessage?.content) {
        const content = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');
        console.log(content);
      }

      console.log();
      console.log(chalk.dim('─'.repeat(50)));
      console.log(chalk.dim('Use /project analyze "your question" for custom analysis'));
      console.log();
    } catch (error) {
      console.log(chalk.red('\n[Error] Analysis failed'));
      console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
      console.log();
    }
    return;
  }

  // 自定义分析（有 guidance）
  console.log(chalk.cyan(`Custom Analysis: "${guidance}"`));
  console.log();

  const prompt = `Analyze this software project based on the user's specific question:

Project Statistics:
- Total features: ${stats.total}
- Completed: ${stats.completed} (${stats.percentage}%)
- Pending: ${stats.pending}
- Skipped: ${stats.skipped}

All features:
${JSON.stringify(features.features, null, 2)}

User's question: "${guidance}"

Please provide a detailed and helpful analysis addressing the user's specific question.`;

  try {
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

    const lastMessage = result.messages[result.messages.length - 1];
    if (lastMessage?.content) {
      const content = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content.map(c => ('text' in c ? c.text : '') || '').join('');
      console.log(content);
    }

    console.log();
  } catch (error) {
    console.log(chalk.red('\n[Error] Analysis failed'));
    console.log(chalk.dim(error instanceof Error ? error.message : String(error)));
    console.log();
  }
}

/**
 * 重置项目（安全删除）
 */
async function projectReset(
  args: string[],
  confirm: (message: string) => Promise<boolean>
): Promise<void> {
  const storage = getProjectStorage();
  const isAll = args.includes('--all');

  if (isAll) {
    console.log(chalk.yellow('\n⚠️  This will DELETE all project management files:'));
    console.log();
    console.log(chalk.cyan('Files to be deleted:'));
    console.log(chalk.dim('  📄 feature_list.json'));
    console.log(chalk.dim('  📄 PROGRESS.md'));
    console.log(chalk.dim('  📄 .kodax/session_plan.md'));
    console.log();
    console.log(chalk.green('✓ Safe: .kodax/ folder and other config files are preserved'));
    console.log(chalk.green('✓ Your project code is SAFE (src/, package.json, etc.)'));
    console.log(chalk.red('✗ This action cannot be undone!'));
    console.log();

    const confirmed = await confirm('Delete all project management files?');
    if (confirmed) {
      const result = await storage.deleteProjectManagementFiles();

      console.log();
      if (result.deleted > 0) {
        console.log(chalk.green(`✓ Deleted ${result.deleted} project management file(s)`));
      }
      if (result.failed > 0) {
        console.log(chalk.red(`✗ Failed to delete ${result.failed} file(s)`));
      }
      console.log();
      console.log(chalk.dim('Use /project init to start a new project'));
      console.log();
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
  } else {
    // 默认：只清空 PROGRESS.md
    console.log(chalk.cyan('\nThis will clear the progress log (PROGRESS.md).'));
    console.log(chalk.dim('  ✓ feature_list.json will be preserved'));
    console.log(chalk.dim('  ✓ .kodax/session_plan.md will be preserved'));
    console.log(chalk.dim('  ✓ All features will remain intact'));
    console.log();

    const confirmed = await confirm('Clear progress log?');
    if (confirmed) {
      await storage.clearProgress();
      console.log(chalk.green('\n✓ Progress log cleared'));
      console.log(chalk.dim('Use /project status to continue tracking progress'));
      console.log();
    } else {
      console.log(chalk.dim('\nCancelled.\n'));
    }
  }
}

/**
 * 主入口：处理 /project 命令
 */
export async function handleProjectCommand(
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<{ projectInitPrompt: string } | void> {
  const subCommand = args[0]?.toLowerCase();

  // 确定确认函数的来源
  // 优先使用 callbacks.confirm (Ink UI)，其次使用 readline (传统 REPL)
  const rl = callbacks.readline;
  const hasConfirm = !!callbacks.confirm;

  // 对于需要交互的命令，检查是否有确认能力
  if (['init', 'next', 'auto', 'edit', 'reset'].includes(subCommand ?? '')) {
    if (!hasConfirm && !rl) {
      console.log(chalk.red(`\n[Error] /project ${subCommand} is not available in the current UI mode`));
      console.log(chalk.dim('This command requires interactive input which is not supported.\n'));
      return;
    }
  }

  // 创建辅助函数 - 优先使用 callbacks.confirm
  const confirm: (message: string) => Promise<boolean> = hasConfirm
    ? callbacks.confirm!
    : rl
      ? createConfirmFn(rl)
      : async () => false;
  const question = rl ? createQuestionFn(rl) : async () => '';

  switch (subCommand) {
    case 'init':
    case 'i':
      return await projectInit(args.slice(1), context, callbacks, currentConfig, confirm);

    case 'status':
    case 'st':
    case 'info':
      await projectStatus(args.slice(1));
      break;

    case 'next':
    case 'n':
      await projectNext(args.slice(1), context, callbacks, currentConfig, confirm);
      break;

    case 'auto':
    case 'a':
      await projectAuto(args.slice(1), context, callbacks, currentConfig, confirm, question);
      break;

    case 'pause':
      await projectPause();
      break;

    case 'edit':
    case 'e':
      await projectEdit(args.slice(1), context, callbacks, confirm);
      break;

    case 'reset':
      await projectReset(args.slice(1), confirm);
      break;

    case 'list':
    case 'l':
      console.log(chalk.dim('\n[Deprecated] Use /project status --features instead\n'));
      await projectList();
      break;

    case 'mark':
    case 'm':
      await projectMark(args.slice(1));
      break;

    case 'progress':
    case 'p':
      console.log(chalk.dim('\n[Deprecated] Use /project status --progress instead\n'));
      await projectProgress();
      break;

    case 'analyze':
      await projectAnalyze(args.slice(1), context, callbacks);
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
