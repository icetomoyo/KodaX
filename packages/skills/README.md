# @kodax/skills

Skills 标准实现，零外部依赖。

## 概述

`@kodax/skills` 是 KodaX 的 Skills 系统实现，提供：
- Skills 发现和加载
- Skills 执行
- 自然语言触发
- 内置 Skills

这个包完全独立，零外部依赖，可以被其他项目使用。

## 安装

```bash
npm install @kodax/skills
```

## 内置 Skills

| Skill | Description | Trigger Keywords |
|-------|-------------|------------------|
| code-review | Code review and quality analysis | 审查代码, review, 检查代码 |
| tdd | Test-driven development workflow | 测试, test, tdd |
| git-workflow | Git commit and workflow | 提交代码, commit, git |

## 使用示例

### Skills 发现

```typescript
import { discoverSkills, DiscoveredSkill } from '@kodax/skills';

// 扫描目录中的 Skills
const skills = await discoverSkills([
  './skills',
  '~/.kodax/skills',
]);

console.log(`Found ${skills.length} skills:`);
skills.forEach(skill => {
  console.log(`- ${skill.name}: ${skill.description}`);
});
```

### Skills 执行

```typescript
import { executeSkill, SkillContext } from '@kodax/skills';

const context: SkillContext = {
  workingDirectory: process.cwd(),
  messages: [],
  options: {},
};

// 执行 Skill
const result = await executeSkill('code-review', context);
console.log(result.output);
```

### 自然语言触发

```typescript
import { resolveSkill, SkillMatch } from '@kodax/skills';

// 从自然语言输入匹配 Skill
const input = '帮我审查这段代码';
const match: SkillMatch | null = resolveSkill(input);

if (match) {
  console.log(`Matched skill: ${match.skill.name}`);
  console.log(`Confidence: ${match.confidence}`);
}
```

### 自定义 Skill

创建自定义 Skill 文件 `~/.kodax/skills/my-skill/SKILL.md`:

```markdown
# My Custom Skill

## Description
A custom skill for my workflow.

## Trigger Keywords
my-task, custom, 自定义任务

## Instructions
1. First, analyze the code structure
2. Then, identify potential improvements
3. Finally, provide recommendations

## Examples
- "帮我执行自定义任务"
- "run my custom task"
```

## Skill 文件结构

```
~/.kodax/skills/
├── my-skill/
│   ├── SKILL.md          # Skill 定义（必需）
│   └── templates/        # 可选模板文件
│       └── example.md
```

## API 导出

```typescript
// 发现
export { discoverSkills, DiscoveredSkill };

// 执行
export { executeSkill, SkillExecutor, SkillContext, SkillResult };

// 解析
export { resolveSkill, SkillMatch };

// 加载
export { loadSkill, SkillLoader };

// 注册
export { registerSkill, getSkillRegistry };

// 类型
export type {
  Skill,
  SkillDefinition,
  SkillTrigger,
};

// 内置 Skills
export { BUILTIN_SKILLS };
```

## 依赖

零外部依赖。

## License

MIT
