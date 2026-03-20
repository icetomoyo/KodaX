# FEATURE_010 Phase 4 - 人工测试指导

## 功能概述

**功能名称**: @kodax/core → @kodax/coding 重命名
**版本**: v0.5.3
**测试日期**: 2026-03-02
**测试人员**: [待填写]

**功能描述**:
将 `@kodax/core` 包重命名为 `@kodax/coding`，完成 FEATURE_010 架构拆分的最后阶段。此次更改涉及：
- 目录重命名: `packages/core/` → `packages/coding/`
- 包名称更新: `@kodax/core` → `@kodax/coding`
- 全局导入路径更新
- 依赖关系调整

---

## 测试环境

### 前置条件
- Node.js >= 18.0.0
- 已运行 `npm install` 安装依赖
- 已运行 `npm run build` 构建所有包

### 构建验证
```bash
# 清理并重新构建（按依赖顺序）
npm run clean:packages
npm run build:packages  # 已更新为按依赖顺序构建
npm run build
```

**注意**: `build:packages` 已更新为按依赖顺序构建：
1. @kodax/ai + @kodax/skills (无内部依赖)
2. @kodax/agent (依赖 ai)
3. @kodax/coding (依赖 ai, agent, skills)
4. @kodax/repl (依赖 coding, skills)

---

## 测试用例

### TC-001: 包结构验证

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 检查 `packages/` 目录结构
2. 确认 `packages/core/` 不存在
3. 确认 `packages/coding/` 存在

**预期效果**:
- [ ] `packages/core/` 目录已删除
- [ ] `packages/coding/` 目录存在
- [ ] `packages/coding/package.json` 的 name 为 `@kodax/coding`

**验证命令**:
```bash
# 列出 packages 目录
ls packages/
# 应显示: agent  ai  coding  repl  skills

# 检查包名 (Windows 兼容)
node -e "console.log(require('./packages/coding/package.json').name)"
# 应显示: @kodax/coding
```

---

### TC-002: 依赖关系验证

**优先级**: 高
**类型**: 正向测试

**测试步骤**:
1. 检查 root `package.json` 依赖
2. 检查 `@kodax/repl` 的依赖
3. 检查 `@kodax/coding` 的依赖

**预期效果**:
- [ ] root `package.json` 依赖 `@kodax/coding`
- [ ] `@kodax/repl` 依赖 `@kodax/coding`
- [ ] `@kodax/coding` 依赖 `@kodax/agent` 和 `@kodax/skills`

**验证命令**:
```bash
# 检查 root 依赖 (Windows 兼容)
node -e "console.log(JSON.stringify(require('./package.json').dependencies, null, 2))"

# 检查 repl 依赖
node -e "console.log(JSON.stringify(require('./packages/repl/package.json').dependencies, null, 2))"

# 检查 coding 依赖
node -e "console.log(JSON.stringify(require('./packages/coding/package.json').dependencies, null, 2))"
```

---

### TC-003: CLI 启动测试

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已完成构建

**测试步骤**:
1. 运行 CLI 帮助命令
2. 检查是否有模块加载错误

**预期效果**:
- [ ] CLI 正常启动
- [ ] 显示帮助信息
- [ ] 无模块找不到错误

**验证命令**:
```bash
node dist/kodax_cli.js --help
```

---

### TC-004: REPL 启动测试

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 已设置 `ANTHROPIC_API_KEY` 环境变量

**测试步骤**:
1. 启动 REPL
2. 检查启动日志
3. 确认无错误信息

**预期效果**:
- [ ] REPL 正常启动
- [ ] 显示欢迎信息
- [ ] 状态栏正常显示
- [ ] 无 `Cannot find module '@kodax/core'` 错误

**验证命令**:
```bash
npm run dev
# 或
node dist/kodax_cli.js
```

---

### TC-005: 基本对话功能测试

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- REPL 已启动
- 有可用的 API Key

**测试步骤**:
1. 在 REPL 中输入: `你好，请自我介绍`
2. 等待 AI 响应
3. 确认响应正常显示

**预期效果**:
- [ ] AI 正常响应
- [ ] 流式输出正常
- [ ] 无运行时错误

---

### TC-006: 工具调用测试

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- REPL 已启动

**测试步骤**:
1. 输入: `请读取 package.json 文件的内容`
2. 等待工具调用和响应
3. 确认文件内容正确显示

**预期效果**:
- [ ] 正确调用 read 工具
- [ ] 文件内容正常显示
- [ ] 工具结果显示正确

---

### TC-007: 会话管理测试

**优先级**: 中
**类型**: 正向测试

**前置条件**:
- REPL 已启动
- 有历史会话

**测试步骤**:
1. 输入 `/sessions` 查看会话列表
2. 输入 `/resume <session-id>` 恢复会话
3. 确认历史消息正确加载

**预期效果**:
- [ ] 会话列表正常显示
- [ ] 会话恢复成功
- [ ] 历史上下文正确

---

### TC-008: 单元测试验证

**优先级**: 中
**类型**: 正向测试

**测试步骤**:
1. 运行所有单元测试
2. 检查测试结果

**预期效果**:
- [ ] 大部分测试通过
- [ ] 无模块加载相关错误
- [ ] 路径相关测试失败已知（需要更新测试文件）

**验证命令**:
```bash
npm test
```

---

## 边界用例

### BC-001: 导入路径兼容性
- 测试从 `@kodax/coding` 导入是否正常
- 测试类型定义是否正确导出
- 测试 re-export 是否正常工作

### BC-002: 旧代码兼容性
- 如果有外部代码依赖 `@kodax/core`，需要更新为 `@kodax/coding`
- 检查是否有遗漏的 `@kodax/core` 引用

**验证命令** (Windows 兼容):
```bash
# 使用 findstr (Windows)
findstr /s /i "@kodax/core" packages\*.ts packages\*.tsx packages\*.json

# 或使用 Node.js (跨平台)
node -e "const fs=require('fs');const path=require('path');const files=fs.readdirSync('packages',{recursive:true});files.forEach(f=>{const fp=path.join('packages',f);if(fs.statSync(fp).isFile()&&/\.(ts|tsx|json)$/.test(fp)){const c=fs.readFileSync(fp,'utf8');if(c.includes('@kodax/core'))console.log(fp)}})"
# 应该没有结果（除了可能的注释或文档）
```

---

## 回归测试重点

由于此次更改是重命名，需要重点验证：

1. **模块加载**: 确保所有模块正确从 `@kodax/coding` 加载
2. **类型系统**: 确保 TypeScript 类型定义正确
3. **运行时**: 确保运行时无模块找不到错误
4. **功能完整性**: 确保所有原有功能正常工作

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 8 | - | - | - |

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

---

*测试指导生成时间: 2026-03-02*
*Feature ID: FEATURE_010 Phase 4*
