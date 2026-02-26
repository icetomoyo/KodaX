# 热轨快照

_生成时间: 2026-02-26 21:00_
_快照版本: v8_

---

## 1. 项目状态

### 当前目标
FEATURE_008 权限控制体系改进设计完成

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 045 - Thinking 内容闪烁 | 已修复 | v0.4.4 |
| Issue 016 - InkREPL 重构 | 已修复 | v0.4.4, 994→819 行 |
| Issue 019 - Session ID 显示 | 已修复 | v0.4.4 |
| FEATURE_008 - 权限控制体系 | **设计完成** | v0.5.0, 待实现 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### FEATURE_008 权限控制类型定义
```typescript
// packages/core/src/types.ts
export type PermissionMode = 'plan' | 'default' | 'accept-edits' | 'auto-in-project';

export interface KodaXOptions {
  permissionMode?: PermissionMode;  // 新增
  confirmTools?: Set<string>;       // 保留向后兼容
  auto?: boolean;
}

export interface KodaXToolExecutionContext {
  permissionMode: PermissionMode;
  projectRoot: string;  // 用于判断项目内外
}
```

### 权限计算函数
```typescript
// packages/core/src/tools/permission.ts
export function computeConfirmTools(mode: PermissionMode): Set<string>
export function isAlwaysConfirmPath(targetPath: string, projectRoot: string): boolean
```

### 配置文件格式
```json
// ~/.kodax/config.json (用户级)
// .kodax/config.local.json (项目级)
{
  "permission": {
    "mode": "accept-edits",
    "allowedPatterns": [{ "pattern": "Bash(git log:*)", "addedBy": "user-confirm" }],
    "deniedPatterns": []
  }
}
```

### 确认提示组件
```tsx
// [y] Yes (this time only)
// [Y] Yes always (only for this project)  // 非永久保护区域
// [n] No
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| CLI 多余参数设计 | --plan/-y/--allow/--deny/--config 冗余，仅需 --mode | 2026-02-26 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| 四级模式替代 code/ask | 更细粒度控制 | 2026-02-26 |
| auto-in-project 允许项目内危险命令 | 用户明确信任项目 | 2026-02-26 |
| .kodax/ 永久保护 | 配置文件涉及自动化，需额外确认 | 2026-02-26 |
| default 模式 [Y] 自动切换 accept-edits | 简化用户操作 | 2026-02-26 |
| 仅 --mode 参数 | 简化 CLI，其他参数冗余 | 2026-02-26 |

---

## 5. 新旧机制映射

| 新模式 | confirmTools | auto | 说明 |
|--------|--------------|------|------|
| `plan` | 所有修改工具 | - | 阻止执行 |
| `default` | [bash,write,edit] | false | 当前默认 |
| `accept-edits` | [bash] | false | 文件自动 |
| `auto-in-project` | [] | true | 项目内全auto |

---

## 6. 项目模式权限映射

| 场景 | 命令 | 权限模式 |
|------|------|----------|
| CLI 项目自动执行 | `--auto-continue` | `auto-in-project` |
| CLI 快速模式 | `--mode auto-in-project` | `auto-in-project` |
| REPL 项目自动执行 | `/project auto` | `auto-in-project` |

---

## 7. 永久保护区域

以下路径**永远需要确认**，不受任何配置影响：
- `.kodax/` - 项目配置目录
- `~/.kodax/` - 用户配置目录
- 项目外路径

---

## 8. 当前 Open Issues (11)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Medium | 036 | React 状态同步潜在问题 |
| Medium | 037 | 两套键盘事件系统冲突 |
| Low | 001-006, 013-015, 017-018, 039 | 代码质量问题 |

---

## 9. FEATURE_008 需要修改/创建的文件

```
修改:
├── packages/core/src/types.ts           # PermissionMode 类型
├── packages/core/src/tools/registry.ts  # 权限检查逻辑
├── packages/repl/src/interactive/commands.ts    # /mode 命令
├── packages/repl/src/interactive/project-commands.ts  # /project auto
├── src/kodax_cli.ts                     # --mode 参数

创建:
├── packages/core/src/tools/permission.ts        # computeConfirmTools
├── packages/repl/src/common/permission-config.ts
├── packages/repl/src/ui/components/ConfirmPrompt.tsx
└── src/cli-permission.ts
```

---

*Token 数: ~1,200*
