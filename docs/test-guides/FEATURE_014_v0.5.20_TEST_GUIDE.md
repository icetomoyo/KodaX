# Feature 014: Project Mode Enhancement - 人工测试指导

## 功能概述

**功能名称**: Project Mode Enhancement (项目模式增强)
**Feature ID**: FEATURE_014
**版本**: v0.5.20
**测试日期**: 2026-03-07
**测试人员**: [待填写]

**功能描述**:

重新设计 `/project` 命令系统，采用 AI-First 和 Prompt-Driven 方法，提供更智能、更安全的项目管理体验。

**核心改进**:
1. **AI-Driven Edit Command** - 自然语言编辑 features
2. **Safe Reset Command** - 安全删除项目文件
3. **AI-Powered Analysis** - 智能项目分析
4. **Tab Completion** - `#<n>` 语法补全
5. **Compact Help** - 更简洁的帮助信息

---

## 测试环境

### 前置条件
- ✅ KodaX REPL 已安装并可用
- ✅ Node.js >= 18.0.0
- ✅ Git 仓库（用于测试 project init）
- ✅ AI 提供商已配置（Claude/OpenAI）

### 测试账号/配置
- AI Provider: Claude Sonnet 4.6 / OpenAI GPT-4
- API Key: [已配置]
- 工作目录: 测试用的 Git 仓库

### 浏览器/环境要求
- 终端: 支持 ANSI 颜色的现代终端
- Shell: bash / zsh / PowerShell
- 操作系统: Windows / macOS / Linux

---

## 测试用例

### TC-001: Feature Index 语法解析

**优先级**: 高
**类型**: 正向测试 / UI测试

**前置条件**:
- REPL 正常启动
- 存在至少一个项目（有 feature_list.json）

**测试步骤**:
1. 运行 `/project status --features` 查看现有 features
2. 尝试命令：`/project next #0`
3. 尝试命令：`/project edit #1 "测试"`
4. 尝试命令：`/project next 2`（向后兼容）

**预期效果**:
- [ ] `#0` 语法正确解析为第一个 feature
- [ ] `#1` 语法正确解析为第二个 feature
- [ ] 向后兼容的数字格式 `2` 仍然工作
- [ ] 错误的 index（如 `#999`）给出友好提示

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-002: Project Edit - 单个 Feature 操作

**优先级**: 高
**类型**: 正向测试 / 负向测试

**前置条件**:
- 项目已初始化
- 至少有一个待完成的 feature

**测试步骤**:

**2.1 标记为完成**
```bash
/project edit #0 "标记为完成"
```

**2.2 标记为跳过**
```bash
/project edit #1 "跳过"
```

**2.3 修改描述**
```bash
/project edit #2 "修改描述为：新的描述文本"
```

**2.4 添加步骤**
```bash
/project edit #2 "添加步骤：编写单元测试"
```

**2.5 删除 feature**
```bash
/project edit #3 "删除"
```

**2.6 无效操作**
```bash
/project edit #999 "标记为完成"
```

**预期效果**:
- [ ] "标记为完成" 成功且有确认提示
- [ ] "跳过" 成功且有确认提示
- [ ] "修改描述" 成功且显示新描述
- [ ] "添加步骤" 成功且步骤追加到末尾
- [ ] "删除" 成功且需要确认
- [ ] 无效 index 返回错误信息
- [ ] feature_list.json 文件正确更新

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-003: Project Edit - 全局操作

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 项目有多个已完成的 features
- 项目有多个已跳过的 features

**测试步骤**:

**3.1 删除所有已完成的**
```bash
/project edit "删除所有已完成的"
```

**3.2 删除所有已跳过的**
```bash
/project edit "删除所有已跳过的"
```

**3.3 AI 辅助复杂操作**
```bash
/project edit "重新按优先级排序"
```

**预期效果**:
- [ ] "删除所有已完成的" 显示数量并需要确认
- [ ] "删除所有已跳过的" 显示数量并需要确认
- [ ] 复杂操作触发 AI 分析（显示建议）
- [ ] 全局操作不误删项目代码文件

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-004: Project Edit - AI 辅助

**优先级**: 中
**类型**: 功能测试

**前置条件**:
- AI 提供商已配置且可用

**测试步骤**:
```bash
/project edit #0 "拆分为两个子功能"
```

**预期效果**:
- [ ] 显示 "Processing with AI assistance..."
- [ ] AI 返回分析结果（文本建议）
- [ ] 提示用户复杂操作需要手动编辑 feature_list.json
- [ ] 不会自动执行拆分操作

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-005: Project Reset - 清空进度

**优先级**: 高
**类型**: 正向测试 / 安全测试

**前置条件**:
- 项目已初始化
- PROGRESS.md 文件存在且有内容

**测试步骤**:
```bash
/project reset
```
然后选择 "yes" 确认

**预期效果**:
- [ ] 显示提示：将清空 PROGRESS.md
- [ ] 显示将保留的文件列表（feature_list.json, session_plan.md）
- [ ] 需要用户确认
- [ ] 确认后清空 PROGRESS.md（文件仍存在但内容为空）
- [ ] 显示成功消息

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-006: Project Reset --all - 删除所有文件

**优先级**: 高
**类型**: 正向测试 / 安全测试

**前置条件**:
- 项目已初始化
- 以下文件存在：
  - feature_list.json
  - PROGRESS.md
  - .kodax/session_plan.md
  - .kodax/settings.json（或其他配置）

**测试步骤**:
```bash
/project reset --all
```
然后选择 "yes" 确认

**预期效果**:
- [ ] 显示 ⚠️ 警告符号
- [ ] 明确列出将删除的 3 个文件
- [ ] 明确说明 **不删除** 的内容：
  - [ ] `.kodax/` 文件夹
  - [ ] `.kodax/settings.json`
  - [ ] 项目代码（src/, package.json 等）
- [ ] 需要用户确认
- [ ] 确认后删除 3 个文件
- [ ] `.kodax/` 文件夹仍然存在
- [ ] 显示删除成功数量

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-007: Project Reset - 取消操作

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- 项目已初始化

**测试步骤**:
```bash
/project reset --all
```
然后选择 "no" 取消

**预期效果**:
- [ ] 显示确认提示
- [ ] 选择 "no" 后显示 "Cancelled."
- [ ] 任何文件都未被删除

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-008: Project Reset - 安全边界

**优先级**: 高
**类型**: 安全测试

**前置条件**:
- 项目根目录有以下内容：
  - feature_list.json
  - PROGRESS.md
  - .kodax/session_plan.md
  - .kodax/settings.json
  - .kodax/memory/（目录）
  - src/（源代码目录）
  - package.json

**测试步骤**:
```bash
/project reset --all
# 确认删除
```
然后检查项目根目录

**预期效果**:
- [ ] **只删除** 3 个项目管理文件
- [ ] `.kodax/` 文件夹保留
- [ ] `.kodax/settings.json` 保留
- [ ] `.kodax/memory/` 保留
- [ ] `src/` 目录完整保留
- [ ] `package.json` 保留
- [ ] 其他所有项目文件完整保留

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-009: Project Analyze - 默认分析

**优先级**: 中
**类型**: 功能测试

**前置条件**:
- 项目已初始化
- AI 提供商已配置

**测试步骤**:
```bash
/project analyze
```

**预期效果**:
- [ ] 显示项目统计信息（total, completed, pending, skipped）
- [ ] 显示进度百分比
- [ ] AI 分析包含：
  - [ ] 进度评估
  - [ ] 风险分析
  - [ ] 优先级建议
  - [ ] 时间估算
  - [ ] 质量检查
- [ ] 分析结果清晰易读
- [ ] 提示可使用自定义分析

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-010: Project Analyze - 自定义分析

**优先级**: 中
**类型**: 功能测试

**前置条件**:
- 项目已初始化
- AI 提供商已配置

**测试步骤**:
```bash
/project analyze "哪些功能风险最高？"
```

**预期效果**:
- [ ] 显示 "Custom Analysis: 哪些功能风险最高？"
- [ ] AI 分析针对用户问题回答
- [ ] 分析结果具体且有帮助

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-011: Project Analyze - 无 AI 模式

**优先级**: 低
**类型**: 负向测试

**前置条件**:
- 项目已初始化
- AI 提供商未配置或不可用

**测试步骤**:
```bash
/project analyze
```

**预期效果**:
- [ ] 显示 "[Warning] AI analysis not available in current mode"
- [ ] 显示基本分析：
  - [ ] 待完成功能数量
  - [ ] 项目阶段评估（早期/中期/接近完成）
- [ ] 不会崩溃或报错

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-012: Tab 补全 - Feature Index

**优先级**: 中
**类型**: UI测试

**前置条件**:
- 项目已初始化
- 至少有 3 个 features
- REPL 支持 Tab 补全

**测试步骤**:
1. 输入：`/project edit #` 然后按 **Tab**
2. 输入：`/project next #` 然后按 **Tab**
3. 输入：`/project edit #1` 然后按 **Tab**（查看是否补全更多）

**预期效果**:
- [ ] `/project edit #` + Tab 显示补全列表：`#0`, `#1`, `#2`...
- [ ] 每个补全项显示 feature 描述
- [ ] `/project next #` + Tab 同样显示补全
- [ ] 补全响应时间 < 500ms
- [ ] 补全按 index 排序

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-013: Tab 补全 - 选项补全

**优先级**: 中
**类型**: UI测试

**前置条件**:
- REPL 支持 Tab 补全

**测试步骤**:
1. 输入：`/project status --` 然后按 **Tab**
2. 输入：`/project init --` 然后按 **Tab**
3. 输入：`/project auto --` 然后按 **Tab**

**预期效果**:
- [ ] `/project status --` + Tab 显示：`--features`, `--progress`
- [ ] `/project init --` + Tab 显示：`--append`, `--overwrite`
- [ ] `/project auto --` + Tab 显示：`--max=`, `--confirm`
- [ ] 每个选项显示描述

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-014: Tab 补全 - 性能

**优先级**: 低
**类型**: 性能测试

**前置条件**:
- 项目有大量 features（> 20 个）

**测试步骤**:
1. 输入：`/project edit #` 按 **Tab**
2. 测量补全显示时间

**预期效果**:
- [ ] 补全响应时间 < 500ms
- [ ] 最多显示 20 个建议
- [ ] 使用缓存（第二次补全更快）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-015: 紧凑帮助信息

**优先级**: 中
**类型**: UI测试

**前置条件**:
- REPL 正常启动

**测试步骤**:
```bash
/project
/project --help
```

**预期效果**:
- [ ] 显示紧凑格式的帮助信息
- [ ] 所有命令在一行内显示参数
- [ ] 包含 "Edit Command" 示例
- [ ] 包含 "Reset Command" 说明
- [ ] 包含 "Feature Index" 说明
- [ ] 包含 "Quick Examples"
- [ ] 总行数 < 30 行（紧凑）

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-016: 向后兼容性 - 旧命令

**优先级**: 高
**类型**: 正向测试

**前置条件**:
- 项目已初始化

**测试步骤**:
1. 运行：`/project list`
2. 运行：`/project progress`
3. 运行：`/project mark 0 done`

**预期效果**:
- [ ] `/project list` 显示 deprecated 警告，但仍然工作
- [ ] `/project progress` 显示 deprecated 警告，但仍然工作
- [ ] `/project mark 0 done` 正常工作
- [ ] 所有旧命令行为未改变

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-017: 参数验证 - parseAutoOptions

**优先级**: 中
**类型**: 边界测试 / 负向测试

**前置条件**:
- 项目已初始化

**测试步骤**:
```bash
/project auto --max=5
/project auto --max=abc
/project auto --max=-10
/project auto --max=0
```

**预期效果**:
- [ ] `--max=5` 正常工作，限制为 5 次
- [ ] `--max=abc` 不崩溃，视为无限制（0）
- [ ] `--max=-10` 不崩溃，视为无限制（0）
- [ ] `--max=0` 视为无限制

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-018: 错误处理 - 无项目

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- 当前目录没有项目（无 feature_list.json）

**测试步骤**:
```bash
/project edit #0 "测试"
/project reset
/project analyze
```

**预期效果**:
- [ ] 所有命令都显示友好错误："[No project found]"
- [ ] 提示使用 `/project init` 初始化
- [ ] 不会崩溃

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-019: 错误处理 - Feature 不存在

**优先级**: 中
**类型**: 负向测试

**前置条件**:
- 项目已初始化
- 只有 3 个 features（#0, #1, #2）

**测试步骤**:
```bash
/project edit #999 "标记为完成"
/project next #999
```

**预期效果**:
- [ ] 显示错误："[Error] Feature #999 not found"
- [ ] 不会崩溃
- [ ] feature_list.json 未被修改

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

### TC-020: 完整工作流程

**优先级**: 高
**类型**: 集成测试

**前置条件**:
- 空的测试目录
- AI 提供商已配置

**测试步骤**:

**Step 1: 初始化项目**
```bash
/project init "构建用户管理系统"
```

**Step 2: 查看状态**
```bash
/project status
/project status --features
```

**Step 3: 编辑 features**
```bash
/project edit #0 "修改描述为：用户注册"
/project edit #1 "添加步骤：验证邮箱"
```

**Step 4: 执行 feature**
```bash
/project next #0
```

**Step 5: 标记完成**
```bash
/project edit #0 "标记为完成"
```

**Step 6: 分析项目**
```bash
/project analyze
```

**Step 7: 清理**
```bash
/project reset --all
```

**预期效果**:
- [ ] 所有步骤按顺序执行成功
- [ ] 每步输出清晰易懂
- [ ] feature_list.json 状态正确
- [ ] 最终 `reset --all` 清理干净

**实际结果**: [待填写]
**是否通过**: [ ] Pass / [ ] Fail

---

## 边界用例

### BC-001: 空项目（0 features）
```bash
/project init "空项目" → 手动删除所有 features → /project status
```
**预期**: 显示 "0 completed, 0 pending, 0 skipped"，不崩溃

---

### BC-002: 大量 features（> 100）
```bash
# 手动创建 100+ features
/project status --features
```
**预期**: 正常显示，无性能问题

---

### BC-003: Feature 描述包含特殊字符
```bash
/project edit #0 "修改描述为：包含 <>&\"' 特殊字符"
```
**预期**: 正确保存和显示，JSON 转义正确

---

### BC-004: Feature 描述超长
```bash
/project edit #0 "修改描述为：[500字符的描述]"
```
**预期**: 正确处理，无截断或错误

---

### BC-005: 并发操作（两个终端同时操作）
- 终端 1: `/project edit #0 "标记为完成"`
- 终端 2: `/project edit #1 "标记为完成"`

**预期**: 后执行的操作覆盖前一个（无文件锁，符合设计）

---

### BC-006: 只读文件系统
```bash
# 设置 feature_list.json 为只读
chmod -w feature_list.json
/project edit #0 "标记为完成"
```
**预期**: 显示错误信息，不崩溃

---

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|--------|------|------|------|
| 20 + 6 边界 | - | - | - |

**测试覆盖维度**:
- ✅ 正向测试：正常功能流程
- ✅ 负向测试：错误处理、边界情况
- ✅ 安全测试：文件删除安全性
- ✅ UI测试：Tab 补全、帮助信息
- ✅ 性能测试：补全响应时间
- ✅ 集成测试：完整工作流
- ✅ 兼容性测试：旧命令向后兼容

**重点测试区域**:
1. 🔴 **安全性** - `/project reset --all` 只删除 3 个文件
2. 🔴 **数据完整性** - feature_list.json 正确更新
3. 🟡 **用户体验** - Tab 补全、错误提示
4. 🟡 **AI 功能** - edit、analyze 的 AI 分析

**测试结论**: [待填写]

**发现的问题**: [如有问题请在此记录]

**建议**:
- [ 填写对功能的建议或改进意见 ]

---

*测试指导生成时间: 2026-03-07*
*Feature ID: FEATURE_014*
*版本: v0.5.20*
