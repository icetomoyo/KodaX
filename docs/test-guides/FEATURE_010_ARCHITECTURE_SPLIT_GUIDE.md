# Feature 010: Architecture Split - 人工测试指导

## 功能概述

**功能名称**: 架构拆分 - Skills 独立包
**版本**: 0.5.0
**测试日期**: 2026-03-02
**测试人员**: [待填写]

**功能描述**:
将 Skills 系统从 `@kodax/repl` 中独立为 `@kodax/skills` 包，实现零外部依赖的 Agent Skills 标准实现。

**架构变更**:
- 新增 `@kodax/skills` 包（零外部依赖）
- 更新 `@kodax/repl` 使用 `@kodax/skills` 依赖
- 移除 `packages/repl/src/skills` 目录

---

## 测试环境

### 前置条件
- Node.js >= 18.0.0
- 已运行 `npm install` 安装依赖
- 当前分支: `feature/010-skills-package`

### 构建命令
```bash
# 构建所有包
npm run build:packages

# 或单独构建
npm run build -w @kodax/skills
npm run build -w @kodax/repl
npm run build
```

---

## 测试用例

### TC-001: @kodax/skills 包构建

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 执行 `npm run build -w @kodax/skills`
2. 检查 `packages/skills/dist/` 目录

**预期效果**:
- [ ] 构建成功，无编译错误
- [ ] `packages/skills/dist/` 目录包含以下文件:
  - `index.js`, `index.d.ts`
  - `types.js`, `types.d.ts`
  - `discovery.js`, `discovery.d.ts`
  - `skill-loader.js`, `skill-loader.d.ts`
  - `skill-registry.js`, `skill-registry.d.ts`
  - `skill-resolver.js`, `skill-resolver.d.ts`
  - `executor.js`, `executor.d.ts`
  - `skill-expander.js`, `skill-expander.d.ts`
  - `builtin/` 目录（包含 3 个内置技能: code-review, git-workflow, tdd）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: @kodax/skills 零外部依赖验证

**优先级**: 高
**类型**: 验证测试

**测试步骤**:
1. 查看 `packages/skills/package.json`
2. 确认 `dependencies` 字段为空对象 `{}`

**预期效果**:
- [ ] `dependencies` 为空（只有 devDependencies）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: REPL 包构建（包含 skills 依赖）

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 执行 `npm run build -w @kodax/repl`
2. 检查 `packages/repl/dist/` 目录
3. 确认无编译错误

**预期效果**:
- [ ] 构建成功
- [ ] `packages/repl/dist/` 正常生成
- [ ] 无 TypeScript 编译错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: 旧 skills 目录已移除

**优先级**: 高
**类型**: 验证测试

**测试步骤**:
1. 检查 `packages/repl/src/skills` 目录

**预期效果**:
- [ ] 目录不存在（已被移除）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: Skills 包功能测试 - 发现技能

**优先级**: 高
**类型**: 功能测试

**测试步骤**:
1. 运行以下命令测试技能发现:
```bash
node -e "
import('./packages/skills/dist/index.js').then(async (skills) => {
  await skills.initializeSkillRegistry(process.cwd());
  const registry = skills.getSkillRegistry();
  const allSkills = registry.list();
  console.log('Discovered skills:', allSkills.length);
  for (const skill of allSkills) {
    console.log('  -', skill.name);
  }
});
"
```

**预期效果**:
- [ ] 输出发现的技能数量（至少 3 个内置技能 + 可能的用户级技能）
- [ ] 显示 3 个内置技能:
  - code-review
  - git-workflow
  - tdd
- [ ] 可能显示用户级技能（如果 `~/.kodax/skills/` 中有）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: REPL CLI 启动测试

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 执行 `npm run build` 构建完整项目
2. 执行 `node dist/kodax_cli.js --help`

**预期效果**:
- [ ] CLI 正常启动
- [ ] 显示帮助信息

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: REPL 交互模式启动（需 TTY）

**优先级**: 中
**类型**: 交互测试

**测试步骤**:
1. 在终端中执行 `npm run dev`
2. 观察启动日志

**预期效果**:
- [ ] REPL 正常启动
- [ ] 无模块加载错误
- [ ] 无 skill registry 初始化错误

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: /skills 命令测试

**优先级**: 高
**类型**: 功能测试

**测试步骤**:
1. 启动 REPL: `npm run dev`
2. 输入 `/skills` 命令
3. 观察输出

**预期效果**:
- [ ] 显示可用技能列表
- [ ] 技能列表至少包含 3 个内置技能（code-review, git-workflow, tdd）
- [ ] 显示格式正确（名称 + 描述）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: 技能调用测试

**优先级**: 高
**类型**: 功能测试

**测试步骤**:
1. 启动 REPL: `npm run dev`
2. 输入 `/skill:code-review` 调用技能
3. 观察响应

**预期效果**:
- [ ] 技能被正确加载
- [ ] AI 收到技能上下文
- [ ] 返回相应响应

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: 包依赖关系验证

**优先级**: 中
**类型**: 验证测试

**测试步骤**:
1. 查看 `packages/repl/package.json`
2. 确认依赖中包含 `@kodax/skills`

**预期效果**:
- [ ] `dependencies` 包含 `"@kodax/skills": "*"`

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: 空 projectRoot 参数
- 传入 `undefined` 或空字符串初始化 skill registry
- 应该使用默认路径，不报错

### BC-002: 不存在的技能调用
- 调用 `/skill:non-existent-skill`
- 应返回 "Skill not found" 错误

### BC-003: 项目级技能覆盖
- 在项目 `.kodax/skills/` 创建同名技能
- 应覆盖内置技能

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 10 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

---

## 回归测试要点

1. **模块导入**: 所有从 `@kodax/skills` 的导入正常工作
2. **类型导出**: TypeScript 类型定义正确导出
3. **单例模式**: `getSkillRegistry()` 返回同一个实例
4. **技能发现**: 多路径优先级正确（project > user > builtin）

---

*测试指导生成时间: 2026-03-02*
*Feature ID: 010*
