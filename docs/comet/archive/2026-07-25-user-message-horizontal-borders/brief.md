# Outcome

将原生 USER 消息的圆角卡片边框改为上下两条等宽实线，同时保留顶部的 `user` 标题。

# Scope

- 顶线采用 `─ user ─…`：标题左侧恰好 1 个横线字符，标题文本两侧各 1 个空格，右侧横线动态补齐总宽度。
- 底线采用横线字符动态铺满相同总宽度。
- 移除左右竖线与四个圆角。
- USER 内容保留 1 列左侧缩进，不再为已移除的左右边框预留宽度。
- 移除卡片内部上下空白 padding，使内容紧邻上下边线。
- 保留现有 `userMessageBorderColor` 配色能力。

# Non-goals

- 不增加新的配置字段或通用装饰抽象。
- 不改变工具分隔线。
- 不改变 USER Markdown、背景色、启停、缓存、窄宽度回退和原生回退契约，除本变更明确涉及的宽度与 padding 外。

# Acceptance examples

宽度足够时，结构为：

```text
─ user ─────────────────────────────────
 用户内容
────────────────────────────────────────
```

- 顶线与底线的可见宽度相等，并等于渲染可用宽度。
- 改变终端宽度时，标题右侧横线自动增减。
- 输出不包含 `╭`、`╮`、`╰`、`╯` 或作为 USER 边框的 `│`。
- 配置不同 `userMessageBorderColor` 时，两条线使用对应 Pi Theme token；`user` 继续使用 accent 样式。

# Constraints and invariants

- 使用现有 USER 消息 renderer seam；不新增模块。
- 使用 TUI 的 `visibleWidth`/`truncateToWidth` 维持 ANSI 与 Unicode 可见宽度正确性。
- 非正宽度、过窄宽度与 renderer 异常继续安全回退。
- 仅影响 TUI 展示，不影响消息内容、序列化或模型上下文。

# Decisions

- 用户确认保留 `user` 标题。
- 用户确认标题左侧保留恰好 1 个横线字符。
- 用户指出并要求上下横线总长度一致；右侧横线按总宽度动态补齐。
- 用户通过最终 demo 确认采用该样式。
- 用户已确认完整目标：顶线 `─ user ─…`、底线等宽实线、无圆角和左右竖线、内容左缩进 1 列且无上下空白 padding。

# Open questions

无。

# Verification expectations

- 更新 USER renderer 单元测试，覆盖结构、等宽、颜色、内容宽度和无旧边框字符。
- 运行仓库 fast 构建与验证入口。
