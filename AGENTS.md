# AGENTS.md — Agent 软件开发工作指南

## 核心原则

本项目遵循 `agent-dev-workflow` skill 规范。详细内容请查阅：

- **Skill 位置**：`.claude/skills/agent-dev-workflow/SKILL.md`
- **完整规范**：`.claude/skills/agent-dev-workflow/references/`

## 快速参考

### 开发流程

```
需求理解 → 项目分析 → GitHub 调研 → 需求拆解 → Agent 分工 → 子任务执行 → 验收 → 测试 → 合并 → 交付
```

### 用户反馈修复流程

```
用户反馈 → 问题分析 → 任务拆解 → 分配任务执行 Agent → 修复执行 → 验收 → 交付
```

**重要原则**：用户校验后的 BUG 修复和功能完善，也必须按照规范流程分配给任务执行 Agent 执行，流程统筹 Agent 不直接修复。

### Agent 角色

- **流程统筹 Agent（主 Agent）**：负责整体方向、任务分配、验收和交付
- **任务执行 Agent（子 Agent）**：负责执行分配的任务，不越界
- **质量验证 Agent（测试 Agent）**：负责验证修改范围内的功能

GUI 展示时使用上述稳定职能名称，并与当前任务状态同时显示，例如：`流程统筹 Agent｜工作中`。

### 关键规则

1. 不臆想需求，有依据才行动
2. UPDATE.MD 是版本计划的事实来源
3. 默认只开发下一版本
4. 子任务必须定义明确的边界和验收标准
5. 任务执行 Agent 完成后必须提供标准化报告
6. 用户反馈的 BUG 和未完成内容，必须分配给任务执行 Agent 修复

### 任务边界格式

```
任务：<描述>
负责：<范围>
允许修改：<文件列表>
禁止修改：<文件列表>
依赖：<依赖项>
修改范围：<实际允许变更的模块、文件或功能>
影响范围：<直接调用链、依赖模块、资源、数据或用户流程>
测试目标：<需要验证的行为和风险>
测试边界：<本次默认不覆盖的范围；如需全量回归需明确说明>
验收标准：<标准列表>
```

流程统筹 Agent 分配任务时，必须根据实际任务填写“修改范围、影响范围、测试目标和测试边界”。质量验证 Agent 在用户未明确要求全量回归时，默认依据这些信息进行定向测试，不得仅因项目规模或惯例一味执行全量测试。测试范围扩大时必须记录扩大的范围及理由。

### 完成报告格式

```
任务：<描述>
修改文件：<列表>
完成内容：<列表>
测试结果：<内容>
实际测试范围：<已执行的修改范围、直接影响链路和冒烟验证>
未测试范围及原因：<未覆盖范围和原因；无则填写“无”>
发现的问题：<内容>
额外修改：<有/无>
需要主 Agent 注意：<内容>
```

## 详细规范

如需了解详细规范，请查阅 skill 文档：

- 开发流程详情 → [references/development-workflow.md](.claude/skills/agent-dev-workflow/references/development-workflow.md)
- 版本管理规范 → [references/version-management.md](.claude/skills/agent-dev-workflow/references/version-management.md)
- Agent 角色职责 → [references/agent-roles.md](.claude/skills/agent-dev-workflow/references/agent-roles.md)
- 测试规范 → [references/testing.md](.claude/skills/agent-dev-workflow/references/testing.md)
- 交付规范 → [references/delivery.md](.claude/skills/agent-dev-workflow/references/delivery.md)
