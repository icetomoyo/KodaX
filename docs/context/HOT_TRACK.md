# 热轨快照

_生成时间: 2026-03-02 10:35_
_快照版本: v13_

---

## 1. 项目状态

### 当前目标
Issue 058 (Windows Terminal 闪烁) 实现失败，已回滚，需要新方案

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 054 - Skills LLM 集成 | **计划中** | 有完整实现计划 |
| Issue 055 - Built-in Skills 规范 | **Open** | Low 优先级 |
| Issue 058 - Windows Terminal 闪烁 | **失败回滚** | Alternate Buffer 方案不可行 |
| Issue 059 - Skills 延迟加载 | **已修复** | v0.4.8 |

### 当下阻塞
- **问题**: Issue 058 的 Alternate Buffer 方案失败，需研究新方案
- **尝试方向**: 升级 Ink 6.x、优化 Static 组件使用、参考 opencode 架构

---

## 2. 已确定接口（骨架）

### Issue 054 实现计划 (待执行)
```typescript
// packages/repl/src/skills/skill-expander.ts (新建)
export function expandSkillForLLM(
  skill: Skill,
  context: SkillContext
): { content: string; skill: Skill };

// XML 格式输出
// <skill name="code-review" location="/path/to/skill">
// [skill 完整内容，变量已解析]
// </skill>
```

```typescript
// packages/repl/src/interactive/commands.ts 修改
// executeSkillCommand 返回类型从 Promise<boolean>
// 改为 Promise<{ handled: boolean; skillContent?: string }>
```

### StreamingContext.tsx 批量更新 (已实现)
```typescript
const FLUSH_INTERVAL = 80; // 与 Spinner 同步

appendResponse: (text: string) => {
  pendingResponseText += text;
  scheduleFlush();
}
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| **手动 ANSI Alternate Buffer** | `\x1B[?1049h/l` 与 Ink 5.x 渲染机制冲突，导致闪烁更严重、滚动失效、终端历史丢失 | 2026-03-02 |
| CLI 多余参数设计 | --plan/-y/--allow/--deny/--config 冗余，仅需 --mode | 2026-02-26 |
| extractTextContent 返回 [Complex content] | 纯 tool_result 消息不应显示占位符，应返回空字符串过滤 | 2026-02-27 |
| thinking 块作为正式内容 | thinking 是 AI 内部思考，不应在 session 恢复时显示 | 2026-02-27 |
| pnpm install 破坏 npm workspaces | pnpm 不识别 npm workspaces，会将包移到 .ignored 导致 node_modules 损坏 | 2026-02-27 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| **Issue 058 完全回滚** | Alternate Buffer 实现使问题更严重，不如不做 | 2026-03-02 |
| Issue 047/048 仅用方案 B | 批量更新已解决问题，方案 A 边际收益低 | 2026-02-27 |
| FLUSH_INTERVAL = 80ms | 与 Spinner 动画同步，100ms 内感知为即时 | 2026-02-27 |
| 使用 npm 而非 pnpm | 项目使用 npm workspaces，pnpm 不兼容会破坏安装 | 2026-02-27 |

---

## 5. Issue 058 失败详情

**尝试方案**: 手动实现 Alternate Buffer 模式

**实现代码**:
```typescript
// InkREPL.tsx
if (useAlternateBuffer && process.stdout.isTTY) {
  process.stdout.write('\x1B[?1049h');  // Enter alternate screen buffer
}
// ... render ...
// onExit:
if (useAlternateBuffer && process.stdout.isTTY) {
  process.stdout.write('\x1B[?1049l');  // Exit alternate screen buffer
}
```

**失败现象**:
1. 闪烁问题未解决，反而更严重
2. 流式输出时无法滚动
3. 进入时清空整个终端历史
4. 退出时只保留 KodaX 会话内容，原终端历史丢失

**根因**: Gemini CLI 使用 forked `@jrichman/ink@6.4.11`，有内置 `alternateBuffer` 选项；KodaX 使用 Ink 5.x 无此功能，手动 ANSI 序列与 Ink 渲染冲突

**回滚**: `git reset --hard d754fe1`

---

## 6. 当前 Open Issues (5)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Critical | 054 | Agent Skills 系统未与 LLM 集成 |
| Medium | 058 | Windows Terminal 流式输出闪烁和滚动问题 |
| Low | 006 | 整数解析无范围检查 |
| Low | 055 | Built-in Skills 未完全符合 Agent Skills 规范 |
| Low | 013/014/015/017/018/039 | 代码质量问题 |

---

## 7. 下一步

### 优先级 1: Issue 054 (Critical)
执行已有计划：
1. 新建 `packages/repl/src/skills/skill-expander.ts`
2. 修改 `commands.ts` 的 `executeSkillCommand` 返回类型
3. 修改 `InkREPL.tsx` 处理 skill 内容注入
4. 可选：修改 `builder.ts` 注入技能列表到系统提示词

### 优先级 2: Issue 058 (Medium)
需要新方案，可选方向：
- 升级到 Ink 6.x (有 alternateBuffer 支持)
- 优化 Static 组件使用（将历史消息放入 Static）
- 参考 opencode 架构重新设计渲染系统

---

## 8. FEATURE_008 权限控制类型定义

```typescript
// packages/core/src/types.ts
export type PermissionMode = 'plan' | 'default' | 'accept-edits' | 'auto-in-project';

export interface KodaXOptions {
  permissionMode?: PermissionMode;
  confirmTools?: Set<string>;  // 向后兼容
  auto?: boolean;
}
```

---

*Token 数: ~1,100*
