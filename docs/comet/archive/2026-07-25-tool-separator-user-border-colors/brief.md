# Outcome

在现有透明工具背景效果上，为 `pi-tool-display` 管理的工具行增加可单独启停、可选择虚线/实线和 Theme token 颜色的结束分隔线，并允许配置原生 USER 消息框的边框 Theme token；所有变化仅影响 TUI presentation。

# Scope

- 新增四个顶层配置字段：
  - `enableToolSeparator: boolean`
  - `toolSeparatorStyle: "dashed" | "solid"`
  - `toolSeparatorColor: DisplayColorToken`
  - `userMessageBorderColor: DisplayColorToken`
- 可选颜色限定为 Pi Theme 的六个前景语义 token：`border`、`borderAccent`、`borderMuted`、`accent`、`muted`、`dim`。
- 默认值分别为 `true`、`"dashed"`、`"borderMuted"`、`"border"`。
- 当 `enableToolSeparator` 开启时，对所有工具行统一追加工具分隔线，包括未配置的第三方工具；工具原有 call、result、shell 和执行行为保持不变，分隔线是唯一允许添加到原生 presentation 的全局装饰。
- 在现有 USER message renderer 的 `colorBorder` seam 读取配置颜色，标题仍使用 `accent`。
- 将四项配置接入规范化、全局/可信项目 overlay、保存、设置 Modal、配置摘要、示例配置和文档。
- 保持 reload、即时配置更新、Theme 切换和 native fallback 行为。

# Non-goals

- 不支持 Hex、RGB、ANSI 颜色、任意 Theme token 或自定义分隔字符。
- 不支持分隔线宽度、margin、粗细、位置或按工具单独配置。
- 不建立通用 Transcript Decoration Module 或装饰注册表。
- 不修改工具定义、工具执行、schema、参数、结果、Agent context、消息或 session 数据。
- 除为所有工具行增加最终分隔线所需的最小 Host Adapter presentation seam 外，不扩展 Pi 私有耦合。
- 不改变 USER 标题颜色、背景、padding、Markdown 或框线样式。
- 不自动探测终端或字体。

# Acceptance examples

- 默认配置下，一个已有 result 的工具块末尾显示一条 `borderMuted` 颜色的虚线；虚线使用单列字符并在给定宽度内安全渲染。
- `enableToolSeparator: false` 时，工具 renderer 的输出与未启用分隔线时一致，不增加空行或包装开销。
- `toolSeparatorStyle: "solid"` 时使用实线；`"dashed"` 时使用虚线。
- 修改 `toolSeparatorColor` 后，下一次重绘使用当前 Theme 对应 token 的颜色；不缓存旧 ANSI。
- 未配置的第三方工具保持其原生 call、result 和 shell presentation，并在工具行结束后获得与其他工具相同的单条分隔线。
- `userMessageBorderColor: "accent"` 时，USER 框的顶边、底边和左右边使用当前 Theme 的 `accent`；` user ` 标题仍按原有 `accent` 规则渲染。
- 同一 USER message、相同宽度和 Theme 下仅改变 `userMessageBorderColor`，缓存必须失效并输出新颜色。
- 非法 style 或 color 值归一化为各自默认值；合法值可完成 load/save 和可信项目 overlay round trip。
- `/reload` 不重复包装分隔线；关闭扩展或 renderer 失败时保留 Pi 原生 presentation。
- 安装扩展前后，工具注册、激活列表、定义、执行、参数、结果、事件顺序、模型上下文和 session JSONL 保持不变。

# Constraints and invariants

- 遵守 `pure-display-tool-rendering`：唯一工具 presentation seam 仍是 Tool Display Resolver；Pi Host Adapter 只负责私有宿主适配。
- 分隔线必须位于所有工具行都经过的最终 presentation seam；不能只依赖 Renderer Catalog 命中规则。
- 分隔线不逐个修改 read/search/Bash/edit/write/custom renderer，也不得复制 Pi 的原生 result fallback 行为。
- 分隔线异常只能跳过装饰或走现有 native fallback，不能隐藏原工具内容。
- `Component.render(width)` 的每一行 `visibleWidth` 不得超过 `width`；`width <= 0` 安全返回。
- Theme token 在渲染时解析，不能在安装或配置加载时预计算 ANSI。
- USER 最终输出缓存 key 必须包含边框颜色 token。
- 配置修改通过显式 patch 持久化，可信项目 overlay 不得泄漏进全局配置。
- 不新增运行时依赖。

# Decisions

- 使用四个配置字段，分隔线有独立启停开关。
- 分隔线样式只支持 `dashed` 和 `solid`。
- 颜色只支持六个 Pi Theme token，不支持直接颜色值。
- 默认配置为：启用、虚线、`borderMuted`、USER 边框 `border`。
- 工具分隔线放在最终 result 后，而不是下一工具 call 前。
- 开关开启时装饰所有工具；未匹配工具除新增分隔线外保持原生 presentation。
- USER 边框留在现有 User Message Renderer；工具分隔线使用能够覆盖完整工具行的最小最终 Seam，不建立统一 Transcript Decoration Module。
- 四个装饰字段作为 presentation 配置参与 preset 的完整配置结果；所有内置 preset 使用相同默认装饰值。
- 用户已确认修订后的全局行为：开启分隔线时所有工具（含未配置第三方工具）都显示分隔线。

# Open questions

无。

# Verification expectations

- 配置测试：四字段合法值、非法回退、save/load、可信 project overlay、显式 patch。
- Resolver 测试：enable on/off、dashed/solid、六种 token、宽度安全、partial/final 更新、native fallback、只包装一次、未匹配工具原生。
- USER renderer 测试：完整边框颜色、标题不变、颜色变更缓存失效、Theme 变更、异常 fail-open、Markdown/ANSI/性能回归。
- Modal/preset 测试：四项配置可见、mutation 正确、默认值和 preset round trip 正确。
- 运行 `npm run typecheck` 与完整测试套件。
- 运行仓库现有真实 Pi runtime contract/required qualification，验证 reload、Theme 重绘和 pure-display 非干扰契约。
