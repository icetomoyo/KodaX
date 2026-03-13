# KodaX 产品需求文档 (PRD)

> 极致轻量化 Coding Agent - TypeScript 实现

---

## 1. 产品概述

### 1.1 产品定位

KodaX 是一个极致轻量化的 Coding Agent，采用 TypeScript 实现，支持 7 种 LLM 提供商。

**核心价值主张**：
- **极致轻量** - 5层架构，每层可独立使用
- **多模型支持** - 支持 Anthropic、OpenAI、Google 等 7 种提供商
- **安全可控** - 4 种权限模式，细粒度工具确认
- **可扩展** - 自定义 Provider、Tool、Skill

### 1.2 目标用户

| 用户类型 | 使用场景 | 核心需求 |
|---------|---------|---------|
| 独立开发者 | 日常编码辅助 | 快速、低成本、多模型选择 |
| 团队开发 | 代码审查、重构 | 一致性、可配置、权限控制 |
| DevOps | CI/CD 集成 | 自动化、无人值守、长运行 |
| AI 研究者 | Agent 实验 | 可扩展、模块化、独立使用各层 |

### 1.3 核心特性

| 特性 | 说明 | 优先级 |
|------|------|--------|
| 多 Provider 支持 | 7 种 LLM 提供商，统一接口 | P0 |
| 交互式 REPL | Ink/React UI，流式输出 | P0 |
| 8 种工具 | Read, Write, Edit, Bash, Glob, Grep, Undo, Diff | P0 |
| 4 种权限模式 | plan, default, accept-edits, auto-in-project | P0 |
| 会话管理 | 保存/恢复/列表/删除 | P1 |
| Thinking Mode | 支持 Claude/Kimi/智谱 | P1 |
| 并行工具执行 | 多工具并行，提升效率 | P1 |
| Skills 系统 | 自然语言触发，自定义扩展 | P1 |
| 长运行模式 | Feature 跟踪，自动继续 | P2 |
| Agent Team | 多 Agent 并行执行 | P2 |

---

## 2. 技术约束

### 2.1 技术栈

| 层级 | 技术 | 版本要求 |
|------|------|---------|
| Runtime | Node.js | >= 20.0.0 |
| Language | TypeScript | >= 5.3.0 |
| CLI Framework | Ink (React for CLI) | ^4.x |
| Test | Vitest | ^1.2.0 |
| Package Manager | npm workspaces | - |

### 2.2 许可证约束

- ✅ 仅使用 Apache/BSD/MIT 许可证的依赖
- ❌ 禁止 GPL/SSPL 许可证

### 2.3 架构约束

- 每个包必须独立可用
- 禁止循环依赖
- 测试覆盖率 >= 80%

---

## 3. 功能需求

### 3.1 AI Layer (@kodax/ai)

**需求描述**: 独立的 LLM 抽象层，可被其他项目复用

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Provider 抽象 | 统一的 Provider 接口 | P0 |
| 流式输出 | 统一的流式输出接口 | P0 |
| 错误处理 | 统一的错误类型体系 | P0 |
| Provider 注册表 | 动态注册/获取 Provider | P1 |
| Thinking 支持 | 支持 thinking 模式 | P1 |

### 3.2 Agent Layer (@kodax/agent)

**需求描述**: 通用 Agent 框架，会话管理和消息处理

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 会话管理 | 创建/保存/恢复/删除 | P0 |
| 消息处理 | 消息构建/压缩 | P0 |
| Token 估算 | 估算消息 Token 数量 | P1 |

### 3.3 Skills Layer (@kodax/skills)

**需求描述**: Skills 标准实现，零外部依赖

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Skill 发现 | 自动发现用户/项目 Skills | P1 |
| Skill 执行 | 加载并执行 Skill | P1 |
| 自然语言触发 | 根据关键词自动匹配 | P2 |
| 内置 Skills | code-review, tdd, git-workflow | P2 |

### 3.4 Coding Layer (@kodax/coding)

**需求描述**: Coding Agent，包含工具和 Prompts

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 8 种工具 | read, write, edit, bash, glob, grep, undo, diff | P0 |
| 系统提示词 | 角色定义、工具说明、约束 | P0 |
| Agent 循环 | 思考-行动-观察循环 | P0 |
| Promise 信号 | COMPLETE/BLOCKED/DECIDE | P2 |

### 3.5 REPL Layer (@kodax/repl)

**需求描述**: 完整的交互式终端体验

| 功能 | 说明 | 优先级 |
|------|------|--------|
| Ink UI | React 组件化终端 UI | P0 |
| 权限控制 | 4 种权限模式 | P0 |
| 内置命令 | /help, /mode, /exit, /clear 等 | P0 |
| 自动补全 | 命令、文件、技能补全 | P1 |
| 主题系统 | dark, warp 主题 | P2 |
| Project Mode | /project 命令组 | P2 |

---

## 4. 非功能需求

### 4.1 性能

| 指标 | 目标 | 测试方法 |
|------|------|---------|
| 首次响应时间 | < 3 秒 | 手动测试 |
| 并行工具效率 | 比顺序快 2x+ | 对比测试 |
| 内存占用 | < 200MB (空闲) | 监控工具 |

### 4.2 可用性

| 指标 | 目标 |
|------|------|
| 测试覆盖率 | >= 80% |
| 类型安全 | 无 any 类型 |
| 文档完整 | 所有公共 API 有注释 |

### 4.3 兼容性

| 平台 | 支持级别 |
|------|---------|
| Windows 10+ | ✅ 完全支持 |
| macOS 12+ | ✅ 完全支持 |
| Linux (Ubuntu 20+) | ✅ 完全支持 |

---

## 5. 成功指标

### 5.1 v0.5.x 阶段目标

- [x] 7 种 Provider 正常工作
- [x] 交互式 REPL 稳定运行
- [x] 8 种工具全部可用
- [x] 测试覆盖率达到 80%+

### 5.2 v0.6.x 阶段目标

- [ ] Agent Team 并行执行
- [ ] 更多内置 Skills
- [ ] 插件系统

### 5.3 长期目标

- [ ] VSCode 扩展集成
- [ ] Web UI 版本
- [ ] 云端同步

---

## 6. 里程碑

| 版本 | 日期 | 主要特性 |
|------|------|---------|
| v0.5.0 | 2026-02 | 5层架构重构完成 |
| v0.5.33 | 2026-03 | 自动补全系统、7种 Provider |
| v0.6.0 | TBD | Agent Team、插件系统 |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| LLM API 变更 | 高 | Provider 抽象层隔离 |
| 依赖安全漏洞 | 高 | 定期安全审计 |
| Token 限制 | 中 | 消息压缩策略 |
| 并发竞争 | 中 | 顺序执行保护 |

---

## 附录: 术语表

| 术语 | 定义 |
|------|------|
| Provider | LLM 提供商的抽象实现 |
| Tool | Agent 可调用的工具 |
| Skill | 预定义的任务模板 |
| Session | 持久化的对话上下文 |
| REPL | Read-Eval-Print Loop 交互式终端 |
