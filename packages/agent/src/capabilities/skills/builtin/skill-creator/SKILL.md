---
name: skill-creator
description: 创建、修改、迁移、验证或打包 Skill，或优化其描述与评测时使用；也用于把已有工作流沉淀成可反复调用的代理能力。不用于普通一次性写作、代码实现或仅使用某项既有 Skill 完成业务任务。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Write, Edit, Bash(node *, npm *, npx *)"
argument-hint: "[skill-name-or-task]"
compatibility: "KodaX/Agent Skills directories; helpers are plain Node ESM. Model evaluation needs a separately configured, authorized SDK Provider."
---

# Skill Creator

复用当前会话已有的目标、样例、范围和授权，区分用户要创建/修改、验证、打包还是
评测。仅补齐会改变结果的缺失信息；小改描述不必扩展成完整模型评测。

下面的 scripts/ 与 references/ 都相对本 Skill 目录。保留目标工作区语境，执行
helper 时给脚本路径和目标路径，不假定当前目录就是 Skill 目录。

## 创建、修改与迁移

- 新建时先起草，或用 `node scripts/init-skill.js <name> --path <skills-dir>` 初始化，
  再按真实任务填写；已有 Skill 在原目录做必要修改。验证-only 只报告问题，不改文件。
- description 写任务与调用边界；默认开放模型发现。只有用户要求显式调用时才设
  `disable-model-invocation: true`。每个已启用 Skill 仍接受 `/<name>` 和 `/skill:<name>`；
  `user-invocable` 是兼容字段，不是执行权限。
- SKILL.md 保留共同方法和分支入口。机械步骤放 scripts/，分支细节放 references/，
  模板放 assets/；只有实际需要时才新增支持文件。内置脚本使用 plain Node ESM `.js`，
  `.ts` 需要相应构建链，不能假定被直接复制的 TypeScript 可以执行。
- allowed-tools 遵守当前宿主契约，例如 `Bash(npm *, node *)` 匹配完整命令文本，
  不是 `npm:*` 冒号前缀。Skill 声明不会授予宿主权限，仍执行原有授权与沙箱检查。
- 移植时核对工具、路径、依赖和事件语义，保留真正可用的行为。记录可核实的来源
  URL、revision、许可与改写范围；未核实的来源明确标未知，不追认一个上游版本。

完成后用 `node scripts/quick-validate.js <skill-dir>` 做结构检查，并核对正例、相邻
任务反例及支持文件引用。结构通过不等于真实触发或脚本执行已验证。交付实际修改
和证据；工具不足时继续有依据的起草/检查，明确未运行部分。

## 打包与分享

`node scripts/package-skill.js <skill-dir> --output <file.skill>` 校验并生成归档。
用户只要分享包时，交付归档和验证结果即可，不默认安装到个人技能库。

需要验证安装链路时，用临时隔离目录：
`node scripts/install-skill.js <file.skill> --dest <isolated-dir>`，再检查解包内容和引用。
仅在任务要求真实安装时写入用户指定目录，沿用已有授权；不以 --force 绕过同名冲突。

## 评测或优化描述

先读 [评测方法与命令](references/evaluation.md)，只执行需要的分支。

- quick-validate 是结构检查；run-trigger-eval 是单条描述的**语义筛查**，不是实际触发率。
- 真实触发需使用实际注册、可见的完整 catalog 和真实 skill 工具定义，记录是否真的
  调用了 skill；包含自然语言正例和相邻任务反例，不能以判断题分数代替调用证据。
- run-eval 是独立 SDK 执行，必须明确 Provider、model、cwd、输入/输出路径与预算；
  不自动继承 Space 当前会话凭据或工具。没有已授权模型能力时仍可完成静态工作。

需要运行结果评审时再加载 agents/grader.md、agents/analyzer.md 或 agents/comparator.md；
它们是该流程的私有契约，不需要创建通用 swarm 或独立后台任务。
