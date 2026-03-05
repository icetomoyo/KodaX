# 热轨快照

_生成时间: 2026-03-05 21:00_
_快照版本: v16_

---

## 1. 项目状态

### 当前目标
Feature 012 TUI 自动补全增强 - 收尾阶段

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 081 - 输入框抖动 | **已解决** | v0.5.11 |
| Enter 键行为优化 | **已解决** | v0.5.12 |
| Feature 012 | **InProgress** | 4/4 Goals 完成 |

### 当下阻塞
- **问题**: 无阻塞
- **下一步**: Feature 012 可标记完成

---

## 2. 已确定接口

### AutocompleteSuggestions 组件 (InkREPL.tsx)
```typescript
const SUGGESTIONS_RESERVE_HEIGHT = 8;

const AutocompleteSuggestions: React.FC = () => {
  const [hasEverShown, setHasEverShown] = useState(false);

  // useEffect 更新 hasEverShown，避免渲染期间 setState
  useEffect(() => {
    if (autocomplete?.state.visible && autocomplete.suggestions.length > 0) {
      setHasEverShown(true);
    }
  }, [autocomplete?.state.visible, autocomplete?.suggestions.length]);

  // hasEverShown=false: 不预留空间
  // hasEverShown=true: 始终预留 8 行
};
```

### InputPrompt Enter 键处理
```typescript
// Enter 键逻辑：补全列表可见时，接受补全并立即发送
if (key.name === "return") {
  if (isAutocompleteVisible) {
    const completion = handleEnter();
    if (completion) {
      // 计算补全后文本
      // 直接发送（不等待 setText）
      if (finalText.trim()) {
        addHistory(finalText);
        onSubmit(finalText);
        clear();
      }
    } else {
      handleSubmit(); // 无补全选中，直接发送当前文本
    }
    return true;
  }
  // ... 正常提交逻辑
}
```

### 布局顺序 (InkREPL.tsx)
```typescript
// 正确顺序：Input → Suggestions → Status
<Box flexDirection="column" flexShrink={0}>
  <Box><InputPrompt ... /></Box>
  <AutocompleteSuggestions />
  <Box marginTop={1}><StatusBar ... /></Box>
</Box>
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| **渲染期间调用 setState** | React 警告，应使用 useEffect | 2026-03-05 |
| **建议区域在输入栏上方** | 向上扩展导致输入框抖动 | 2026-03-05 |
| **一开始预留空间** | 无补全时空白，体验差 | 2026-03-05 |
| **Enter 只接受不发送** | 需按两次，体验差 | 2026-03-05 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| 建议区域在输入栏下方 | 向下扩展，不抖动 | 2026-03-05 |
| hasEverShown 延迟预留 | 首次出现后才预留空间 | 2026-03-05 |
| Enter 补全即发送 | 参考 claude-code，一键完成 | 2026-03-05 |
| useEffect 更新状态 | 避免渲染期间 setState 警告 | 2026-03-05 |

---

## 5. 本次会话新增内容

### Issue 081 - 输入框抖动修复
- **问题**: 补全列表行数变化时输入框上下移动
- **根因**: 建议区域高度变化导致布局重排
- **修复**:
  1. 移动建议区域到输入栏下方
  2. hasEverShown 状态控制空间预留
  3. 固定 8 行高度容器
- **发布**: v0.5.11

### Enter 键行为优化
- **问题**: 补全列表可见时，Enter 只接受补全，需再按一次发送
- **修复**: Enter 时计算补全后文本，直接发送
- **发布**: v0.5.12

---

*Token 数: ~550*
