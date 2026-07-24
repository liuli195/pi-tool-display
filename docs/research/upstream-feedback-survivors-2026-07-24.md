# 上游 `MasuRii/pi-tool-display` 反馈在当前重构后的残留审计

- **审计对象**：上游仓库 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) 的全部 Issue、PR、Issue/PR 评论、PR review 与 inline review comment。
- **原始审计基线**：`main@4be77657339311093ef07b647d52004221e75416`，2026-07-24。
- **实施复核日期**：2026-07-25。

## 实施复核结论

| 上游反馈 | 最终状态 | 验证结果 |
| --- | --- | --- |
| #36 超长单行绕过预览限制 | **已解决** | 非 Diff 完整正文在最终组件按视觉行预算；Diff 按逻辑 Diff 行预算并报告省略视觉 Diff 行 |
| #14/#19 Bash 滚动跳底/闪烁 | **已解决** | 删除 spinner、elapsed tick、`setInterval` 和历史行定时 `invalidate()`；真实 runtime 断言无 animated frame |
| #20/PR #31 Pi 版本兼容 | **已解决** | peer 与 Host gate 支持所有稳定版 `>=0.81.1`；矩阵以 `0.81.1`、`0.82.0` 和 development 作为代表性验证点 |
| PR #27 project-local config | **已解决（只读 overlay）** | 仅 trusted project 读取；显式 global mutation 不持久化 overlay；嵌套 custom 字段保留 siblings |

最终验证结果：664/664 测试通过；development、Pi 0.81.1、Pi 0.82.0 的真实 runtime contract 全部通过。扩展禁用、session transition 与 reload 使用 owned disposer 恢复或重装 native display seam。验证矩阵是抽样资格验证，不会把支持范围收窄到这两个稳定版本。

## 原始审计发现（历史基线）

> 以下“当前证据”和“仍存在”判断冻结于原始审计基线 `4be7765`，不代表实施后的当前 HEAD；当前结论以文首“实施复核结论”为准。

### P1 — 预览预算按逻辑行计数，超长单行仍能填满 viewport（#36）

**上游证据**

- Issue body 明确指出 `previewLines`、`bashCollapsedLines`、`expandedPreviewMaxLines` 按换行符计数；10,000 字符且无换行的单行会被视为 1 行，但终端折行后可占数百个 visual rows：[Issue #36](https://github.com/MasuRii/pi-tool-display/issues/36)。

**当前证据**

- `buildPreviewText()` 先按 `splitLines()` 得到逻辑行，并由 `previewLines()` 截取；`renderPreviewText()` 和 `renderBashPreviewWithHints()` 仍将这个逻辑行预算传给 `Text`：[current `tool-overrides.ts` lines 118–140](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/tool-overrides.ts#L118-L140)、[lines 454–477](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/tool-overrides.ts#L454-L477)、[lines 569–586](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/tool-overrides.ts#L569-L586)。
- 只有 Bash `opencode` collapsed path 使用 `VisualLinePreviewComponent`；Bash `preview`、read/search/MCP/custom preview 与 expanded preview 仍走逻辑行预算：[current `tool-overrides.ts` lines 587–708](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/tool-overrides.ts#L587-L708)。
- 当前测试覆盖了普通长命令和多行 visual preview，但没有覆盖 10,000 字符无换行的 read/search/MCP/custom 或 Bash preview/expanded case：[`tests/bash-display.test.ts` lines 113–166](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/tests/bash-display.test.ts#L113-L166)、[`tests/pure-bash-display.test.ts` lines 1–40](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/tests/pure-bash-display.test.ts#L1-L40)。
- 当前 HEAD 的 runtime probe 已确认该缺口：单个 400 字符、无换行输出，`previewLines: 1`、render width 40 时，read、search、custom/MCP result renderer 各产生 10 个 visual rows；只有 Bash `opencode` collapsed 路径已用 `VisualLinePreviewComponent` 处理该维度。

**判断**：**仍存在，确认度高**。不仅是代码推导；当前 runtime probe 已直接确认 read/search/custom/MCP 的 visual-row 预算缺失。具体“填满 viewport”的规模取决于输出长度和终端宽度。

**建议**

- 复用并泛化现有 `VisualLinePreviewComponent`，覆盖 read、search、custom/MCP 及 Bash preview/expanded；不要实现第二套折行/宽度算法。
- 在 renderer 的最终组件边界按终端宽度计算 visual-row budget，并复用 Pi TUI 的 ANSI/Unicode/CJK/emoji 宽度能力。
- 增加一个最小回归矩阵：宽度 40、400 字符单行、`previewLines: 1`，以及宽度 20、10,000 字符单行的 collapsed/expanded case；断言 rendered rows 有上限、omission hint 只出现一次、原始 tool result/session bytes 不变。

### P1 — Bash spinner 仍用历史行定时器触发 `invalidate()`（#14、#19）

**上游证据**

- #14 报告长 Bash 输出期间用户滚动时终端反复跳回底部：[Issue #14](https://github.com/MasuRii/pi-tool-display/issues/14)。
- #19 给出更具体的机制：spinner 位于 message history，每个 timer tick 改变 off-screen 行并调用 `context.invalidate()`，可能造成全屏 repaint/flicker，且多个并行 Bash 会叠加定时器：[Issue #19](https://github.com/MasuRii/pi-tool-display/issues/19)。Issue 中建议使用 Pi 的 working-indicator slot 或直接删除 live tick。

**当前证据**

- 当前实现仍保留每个 tool-call 的 spinner state、`setInterval()` 与 `context.invalidate()`：[current `bash-display.ts` lines 23–40](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/bash-display.ts#L23-L40)、[lines 156–180](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/bash-display.ts#L156-L180)、[lines 234–249](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/bash-display.ts#L234-L249)。
- 当前代码把间隔从上游报告中的 80ms 调为 200ms，并增加了 session cleanup；这减少了压力和泄漏风险，但没有移除“历史行变更 → 全局 invalidate”这一根因。
- 现有测试主要验证 timer 数量、完成/cleanup 后清理与 reload 行为，不是滚动位置或实际 flicker：[current `tests/reload-behavior.test.ts` lines 600–660](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/tests/reload-behavior.test.ts#L600-L660)、[current `tests/real-runtime-contract.test.ts` lines 377–398](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/tests/real-runtime-contract.test.ts#L377-L398)。

**判断**：**机制仍存在，确认度高；屏幕症状确认度中等**。当前代码足以确认原报告的高风险重绘路径仍未消失，但本次没有真实交互滚动复现，不能声称每个 Pi 版本必然出现跳底/闪烁。

**建议**

- 最小方案是删除行内旋转与 elapsed live tick，依赖 Pi 已有的全局 working indicator，只在真实工具更新和结束时刷新；不要让历史 ToolExecution 行每 200ms 改写自身。Pi 官方如需定制也提供 [`ctx.ui.setWorkingIndicator()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/working-indicator.ts)。
- 增加真实 TUI contract：长 Bash 输出、用户滚动到历史位置、一个/多个并行 Bash，断言 viewport anchor 不变、timer 无残留。0.82.0 contract 虽已通过，但未覆盖交互滚动症状，不能替代该验证。

### P2 — peer dependency 对历史反馈涉及的 Pi 版本仍有安装缺口（#20、#31）

**上游证据**

- #20 的实际安装失败发生在 `@earendil-works/pi-coding-agent@0.74.1`，因为当时 `pi-tool-display@0.4.0` 要求 `^0.75.4`：[Issue #20](https://github.com/MasuRii/pi-tool-display/issues/20)。
- PR #31 明确把 MCP renderer 兼容问题定位到 Pi `0.80.6+`：[PR #31](https://github.com/MasuRii/pi-tool-display/pull/31)。
- PR #25 的更新日志也显示依赖曾从 `0.75.4` 逐步升级到 `0.79.8`：[PR #25](https://github.com/MasuRii/pi-tool-display/pull/25)。

**当前证据**

- 当前 package 只接受精确的 `0.74.0`、精确的 `0.80.3`、以及 `>=0.81.1`：[current `package.json` lines 73–77](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/package.json#L73-L77)。因此 `0.74.1` 和 `0.80.6`–`0.80.10` 等版本不满足 npm peer range，即使扩展理论上可以 native fallback，也可能在安装阶段先失败。
- 兼容矩阵声明了 development、0.81.1、0.82.0 与 0.74.0。本次独立验证中，637/637 non-real-runtime tests、typecheck、build、diff-check 通过，真实 Pi 0.82.0 contract 也通过；development、0.81.1 与 0.74.0 因缺少对应 runtime root 而跳过。已通过的 0.82.0 不能证明被 peer range 排除的历史版本可安装或可运行：[current `tests/real-runtime-contract.test.ts` lines 20–35](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/tests/real-runtime-contract.test.ts#L20-L35)、[`package.json` test script](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/package.json#L28-L31)。

**判断**：**仍存在，确认度高（peer range）；实际每个中间版本的 runtime 行为确认度中等**。问题已从“错误要求 0.75.x”变成“只允许少数已声明版本”，但 #20 的 `0.74.1` 安装失败形态仍可由当前 range 推导。

**建议**

- 支持所有稳定版 `>=0.81.1`，并在 README 中区分“支持范围”和“代表性验证矩阵”；不要把抽测版本误写为仅支持的精确版本。[README compatibility](https://github.com/liuli195/pi-tool-display/blob/main/README.md#L97-L103)。

### P3 — project-local config 尚未实现（PR #27）

**上游证据**

- PR #27 提议 `.pi/extensions/pi-tool-display/config.json`，project → global → defaults 的优先级，以及 `/tool-display reset|preset --project|--global`：[PR #27](https://github.com/MasuRii/pi-tool-display/pull/27)。该 PR 没有 actionable review comment，且仍为未合并状态。

**当前证据**

- 当前 config path 在模块加载时固定为 Pi agent 全局目录下的 `extensions/pi-tool-display/config.json`：[current `src/config-store.ts` lines 25–26](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/config-store.ts#L25-L26)。`loadToolDisplayConfig()`/`saveToolDisplayConfig()` 也只接收单个 config file，未实现 project/global merge：[current `src/config-store.ts` lines 231–277](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/src/config-store.ts#L231-L277)。
- README 只记录 global config path，并在 troubleshooting 中要求检查 global 文件：[current README lines 145–149](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/README.md#L145-L149)、[lines 343–347](https://github.com/liuli195/pi-tool-display/blob/4be77657339311093ef07b647d52004221e75416/README.md#L343-L347)。

**判断**：**仍存在，确认度高**。这是功能缺口/UX limitation，不是当前纯显示重构的必需部分。

**安全边界（必须遵守）**

Pi 官方 `extensions.md` 要求：project-local path 使用 `CONFIG_DIR_NAME` 而不是硬编码 `.pi`，并在读取应只对可信项目生效的配置前调用 `ctx.isProjectTrusted()`：[官方文档 `ctx.cwd` / `CONFIG_DIR_NAME`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ctxcwd)、[官方文档 `ctx.isProjectTrusted()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ctxisprojecttrusted)。本机安装的 0.82-ish docs 同样明确记载：`CONFIG_DIR_NAME` 位于 lines 952–963，`ctx.isProjectTrusted()` 位于 lines 966–970。

**建议**

- 若要实现：在 `session_start` 或等价拥有 `ctx` 的生命周期读取 global + `join(ctx.cwd, CONFIG_DIR_NAME, ...)` 的 project config；只有 `ctx.isProjectTrusted() === true` 才读取/合并项目文件。
- 不要继续在 extension factory 通过 `process.cwd()` 直接读仓库配置；这样既没有当前 session trust context，也会让 reload/session switch 使用 stale cwd。
- 保存操作也应有明确 scope：默认保持 global；project save/reset 必须是显式命令，且再次检查 trust，不要让 `/tool-display` 无意间写入不可信仓库。
- 先做最小 project read-only precedence；scope flags 与 project write 可以后置。项目配置本身不应改变工具、执行、context 或 session 内容。

## 证据与方法说明

### 数据范围

截至本报告时间，上游共审计 **37 个编号对象**：Issue #3/#5/#8/#14/#15/#17/#19/#20/#21/#23/#26/#29/#30/#33/#35/#36，以及 PR #1/#2/#4/#6/#7/#9/#10/#11/#12/#13/#16/#18/#22/#24/#25/#27/#28/#31/#32/#34/#37。包括已关闭、未合并、已合并、开放项目，不按 open/closed 过滤。

### 精确查询/API 方法

使用 GitHub CLI `gh 2.93.0` 调用 GitHub REST API，仓库均显式指定为 `MasuRii/pi-tool-display`：

```text
gh api 'repos/MasuRii/pi-tool-display/issues?state=all&per_page=100' --paginate
gh api 'repos/MasuRii/pi-tool-display/pulls?state=all&per_page=100' --paginate
```

对每个 `n = 1..37`：

```text
gh api 'repos/MasuRii/pi-tool-display/issues/{n}'
gh api 'repos/MasuRii/pi-tool-display/issues/{n}/comments?per_page=100'
```

对每个 PR：

```text
gh api 'repos/MasuRii/pi-tool-display/pulls/{n}/reviews?per_page=100'
gh api 'repos/MasuRii/pi-tool-display/pulls/{n}/comments?per_page=100'
gh api 'repos/MasuRii/pi-tool-display/pulls/{n}/files?per_page=100'
```

此外阅读了当前仓库的 `AGENTS.md`、`docs/agents/issue-tracker.md`、`docs/agents/domain.md`、`README.md`、`CHANGELOG.md`、`docs/spec/pure-display-tool-rendering.md`、`docs/research/pi-history-rendering-root-cause.md`，以及当前 commit 的 source/tests。仓库根目录没有 `CONTEXT.md`，`docs/adr/` 也不存在；没有因此创建文件或改变代码。

PR review 结果：绝大多数 PR 没有 review body 或 inline review comment；PR #10 有一个空 body 的 approval review：[review permalink](https://github.com/MasuRii/pi-tool-display/pull/10#pullrequestreview-4136230745)。有实质内容的反馈主要位于 issue comments/PR conversation，均在下方矩阵保留入口。

## 附录 A：完整 upstream coverage matrix

状态含义：

- **仍存在**：进入主表。
- **已由重构解决**：当前源码/测试显示原根因已移除；若依赖真实 runtime，单独标注验证限制。
- **obsolete/out of scope**：原建议已放弃、依赖更新已无意义，或与当前纯显示边界不冲突。
- **cannot verify**：当前静态证据不足以替代真实运行时复现；不把 skipped runtime 当作已解决。


| 编号  | 类型 / 主题                                      | 讨论与 review 入口                                                                                                                                                                                                                                                              | 当前状态                                 | 当前判断依据                                                                                                                           |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| #1  | Dependabot `file-type` 安全更新                  | [PR #1](https://github.com/MasuRii/pi-tool-display/pull/1)、[bot comment](https://github.com/MasuRii/pi-tool-display/pull/1#issuecomment-4047124118)                                                                                                                        | obsolete/out of scope                | bot 已说明依赖不再可更新；无产品反馈。                                                                                                            |
| #2  | 兼容 fork 的重复 thinking label                   | [PR #2](https://github.com/MasuRii/pi-tool-display/pull/2)                                                                                                                                                                                                                 | 已由重构解决 / obsolete                    | thinking-label 功能已移除；当前 `src/index.ts` 不注册相关 message/context handlers。                                                           |
| #3  | inline diff emphasis 被遮蔽                     | [Issue #3](https://github.com/MasuRii/pi-tool-display/issues/3)、[fix comment](https://github.com/MasuRii/pi-tool-display/issues/3#issuecomment-4049147085)                                                                                                                 | 已由重构解决                               | 上游已说明 commit `72ad294` 修复；当前保留 ANSI/diff 回归测试。                                                                                   |
| #4  | Dependabot `undici` 安全更新                     | [PR #4](https://github.com/MasuRii/pi-tool-display/pull/4)、[bot comment](https://github.com/MasuRii/pi-tool-display/pull/4#issuecomment-4109920044)                                                                                                                        | obsolete/out of scope                | bot 已说明依赖不再可更新。                                                                                                                  |
| #5  | 增加 hide/collapse/truncate 关键词                | [Issue #5](https://github.com/MasuRii/pi-tool-display/issues/5)、[实现 comment](https://github.com/MasuRii/pi-tool-display/issues/5#issuecomment-4101500452)                                                                                                                  | 已由重构解决                               | 当前 `package.json` keywords 含 `hide/collapse/truncate` 等。                                                                         |
| #6  | 支持 `PI_CODING_AGENT_DIR`                     | [PR #6](https://github.com/MasuRii/pi-tool-display/pull/6)                                                                                                                                                                                                                 | 已由重构解决                               | 当前 `src/agent-dir.ts`/config path 使用该环境变量解析。                                                                                     |
| #7  | Dependabot `brace-expansion`                 | [PR #7](https://github.com/MasuRii/pi-tool-display/pull/7)                                                                                                                                                                                                                 | obsolete/out of scope                | 无产品反馈。                                                                                                                           |
| #8  | RGB 颜色分量 `49` 误判背景 reset                     | [Issue #8](https://github.com/MasuRii/pi-tool-display/issues/8)、[comment](https://github.com/MasuRii/pi-tool-display/issues/8#issuecomment-4275690702)                                                                                                                     | 已由重构解决                               | 当前 ANSI 测试覆盖 foreground RGB preservation。                                                                                        |
| #9  | Dependabot `basic-ftp`                       | [PR #9](https://github.com/MasuRii/pi-tool-display/pull/9)、[bot comment](https://github.com/MasuRii/pi-tool-display/pull/9#issuecomment-4298720465)                                                                                                                        | obsolete/out of scope                | bot 已说明依赖不再可更新。                                                                                                                  |
| #10 | native user message box spacing/OSC          | [PR #10](https://github.com/MasuRii/pi-tool-display/pull/10)、[approval](https://github.com/MasuRii/pi-tool-display/pull/10#pullrequestreview-4136230745)                                                                                                                   | 已由重构解决                               | 当前 native user-message pipeline 与 OSC/嵌套 Markdown 测试仍在。                                                                          |
| #11 | Dependabot 两依赖更新                             | [PR #11](https://github.com/MasuRii/pi-tool-display/pull/11)、[bot comment](https://github.com/MasuRii/pi-tool-display/pull/11#issuecomment-4314387651)                                                                                                                     | obsolete/out of scope                | 无产品反馈；bot 已关闭。                                                                                                                   |
| #12 | Ctrl+O hint 与 expanded preview               | [PR #12](https://github.com/MasuRii/pi-tool-display/pull/12)                                                                                                                                                                                                               | 已由重构解决                               | 当前 README、Bash/search/read renderer 与 tests 保留展开/折叠行为。                                                                           |
| #13 | Shiki/multi-edit/diff visual upgrades        | [PR #13](https://github.com/MasuRii/pi-tool-display/pull/13)、[discussion](https://github.com/MasuRii/pi-tool-display/pull/13#issuecomment-4364352439)                                                                                                                      | obsolete/out of scope                | 作者明确决定放弃；当前 spec 也不要求该大改版。                                                                                                       |
| #14 | 长 Bash 输出时手动滚动跳底                             | [Issue #14](https://github.com/MasuRii/pi-tool-display/issues/14)                                                                                                                                                                                                          | **仍存在**                              | 与 #19 合并为 spinner/invalidate 残留；见主表。                                                                                             |
| #15 | MCP 注册时序、任意 top-level tool 太吵                | [Issue #15](https://github.com/MasuRii/pi-tool-display/issues/15)、[custom-tools comment](https://github.com/MasuRii/pi-tool-display/issues/15#issuecomment-4610096529)、[late-tool diagnosis](https://github.com/MasuRii/pi-tool-display/issues/15#issuecomment-4727855461) | 已由重构解决（runtime caveat）               | 当前有 `customToolOverrides` 与 disposable Renderer Adapter；不再靠 MCP heuristic。0.82.0 contract 已通过，但未覆盖全部 MCP producer/load-order 组合。 |
| #16 | Dependabot `fast-xml-builder`                | [PR #16](https://github.com/MasuRii/pi-tool-display/pull/16)                                                                                                                                                                                                               | obsolete/out of scope                | 无产品反馈。                                                                                                                           |
| #17 | 与 `pi-rtk` 的 `bash` ownership 冲突             | [Issue #17](https://github.com/MasuRii/pi-tool-display/issues/17)、[workaround comment](https://github.com/MasuRii/pi-tool-display/issues/17#issuecomment-4412539767)                                                                                                       | 已由重构解决                               | 当前 display seam 不注册/替换 executable tool。                                                                                          |
| #18 | MCP override 静默失效                            | [PR #18](https://github.com/MasuRii/pi-tool-display/pull/18)                                                                                                                                                                                                               | 已由重构解决（runtime caveat）               | 当前 Host Adapter + explicit adapter/catalog 取代 clone/registration 路径；0.82.0 contract 已通过，其他声明版本尚未运行。                              |
| #19 | spinner 定时器造成 pi-tui flicker                 | [Issue #19](https://github.com/MasuRii/pi-tool-display/issues/19)                                                                                                                                                                                                          | **仍存在**                              | 当前 `bash-display.ts:236–248` 仍为 `setInterval` + `invalidate()`；见主表。                                                              |
| #20 | latest Pi npm `ERESOLVE`                     | [Issue #20](https://github.com/MasuRii/pi-tool-display/issues/20)                                                                                                                                                                                                          | **仍存在**                              | 当前 peer range 仍排除 `0.74.1`；见主表。                                                                                                  |
| #21 | Bash 丢失 `shellPath/commandPrefix`            | [Issue #21](https://github.com/MasuRii/pi-tool-display/issues/21)、[fix PR #22](https://github.com/MasuRii/pi-tool-display/pull/22)                                                                                                                                         | 已由重构解决                               | 更根本地，当前扩展不重建 Bash executable、不包装 execution；shell settings 不会因显示而丢失。                                                              |
| #22 | Bash settings passthrough fix                | [PR #22](https://github.com/MasuRii/pi-tool-display/pull/22)                                                                                                                                                                                                               | 已由重构解决                               | 同 #21；执行边界已移除。                                                                                                                   |
| #23 | 小 tmux pane 的 large diff 闪烁                  | [Issue #23](https://github.com/MasuRii/pi-tool-display/issues/23)、[closure comment](https://github.com/MasuRii/pi-tool-display/issues/23#issuecomment-4877759144)                                                                                                          | 已由重构解决（runtime caveat）               | 当前 expanded diff 有 `expandedPreviewMaxLines` 与 omission hint；具体各真实 tmux 终端仍需 runtime contract。                                   |
| #24 | Dependabot `esbuild`                         | [PR #24](https://github.com/MasuRii/pi-tool-display/pull/24)                                                                                                                                                                                                               | obsolete/out of scope                | 依赖维护项，无上游产品反馈。                                                                                                                   |
| #25 | Dependabot coding-agent/protobufjs/ws        | [PR #25](https://github.com/MasuRii/pi-tool-display/pull/25)、[bot comment](https://github.com/MasuRii/pi-tool-display/pull/25#issuecomment-4872253177)                                                                                                                     | obsolete/out of scope                | 依赖维护项；当前兼容性另见 #20/#31。                                                                                                           |
| #26 | `find/ls` off-by-default 被激活                 | [Issue #26](https://github.com/MasuRii/pi-tool-display/issues/26)、[closure comment](https://github.com/MasuRii/pi-tool-display/issues/26#issuecomment-4878351402)                                                                                                          | 已由重构解决                               | 当前无 built-in re-registration/activation；display selection 与 ownership 分离。                                                        |
| #27 | project-level config 与 scope flags           | [PR #27](https://github.com/MasuRii/pi-tool-display/pull/27)                                                                                                                                                                                                               | **仍存在**                              | 当前只有 global config path；见主表。                                                                                                     |
| #28 | load-time renderer 以修复 restored history      | [PR #28](https://github.com/MasuRii/pi-tool-display/pull/28)                                                                                                                                                                                                               | cannot verify                        | 当前 Host Adapter/row seam 设计上替代 load-time registration，但历史 rows 的真实 0.81.x 首帧 contract 被跳过，不能把 mock tests 当成证明。                   |
| #29 | late owner 导致 built-in hard crash            | [Issue #29](https://github.com/MasuRii/pi-tool-display/issues/29)、[closure comment](https://github.com/MasuRii/pi-tool-display/issues/29#issuecomment-4878351407)                                                                                                          | 已由重构解决                               | 当前显示层不抢 executable ownership；不会再因 renderer 配置注册同名 tool。                                                                          |
| #30 | thinking finalization `theme.fg` 错误          | [Issue #30](https://github.com/MasuRii/pi-tool-display/issues/30)                                                                                                                                                                                                          | obsolete/out of scope                | thinking-label finalization 已删除；不存在该调用路径。                                                                                        |
| #31 | Pi 0.80.6+ MCP prototype patch               | [PR #31](https://github.com/MasuRii/pi-tool-display/pull/31)                                                                                                                                                                                                               | 已由重构解决（runtime caveat）               | 当前 producer adapter + Host Adapter 是纯显示路径；但 package 对 `0.80.6` 的 peer 安装缺口仍是主表兼容项。                                               |
| #32 | later extension tool 在注册前 decoration         | [PR #32](https://github.com/MasuRii/pi-tool-display/pull/32)                                                                                                                                                                                                               | 已由重构解决                               | 当前 consumer API 注册 display intent/adapter，不修改 frozen ToolDefinition；见 README API 说明。                                             |
| #33 | thinking label 修改内容、影响其他 extension           | [Issue #33](https://github.com/MasuRii/pi-tool-display/issues/33)、关联报告入口见 issue body                                                                                                                                                                                       | 已由重构解决                               | 当前已移除 thinking label/message/context mutation；纯显示 spec 明确禁止该行为。                                                                  |
| #34 | `pi-patty-bg-tasks` startup bash race        | [PR #34](https://github.com/MasuRii/pi-tool-display/pull/34)、[tracking comment](https://github.com/MasuRii/pi-tool-display/pull/34#issuecomment-5050977299)                                                                                                                | 已由重构解决                               | no registration/no ownership mutation；真实双包启动仍属于未提供 runtime root 的 contract caveat。                                               |
| #35 | 与 `pi-patty-bg-tasks` 的 bash 冲突              | [Issue #35](https://github.com/MasuRii/pi-tool-display/issues/35)                                                                                                                                                                                                          | 已由重构解决（runtime caveat）               | 当前不调用 registerTool 取得显示控制；源代码已去除根因。                                                                                              |
| #36 | 超长单行绕过 preview limit                         | [Issue #36](https://github.com/MasuRii/pi-tool-display/issues/36)                                                                                                                                                                                                          | **仍存在**                              | 当前 preview/search/MCP/custom 仍按逻辑行 slice；见主表。                                                                                    |
| #37 | upstream ownership fix（明确 intended for fork） | [PR #37](https://github.com/MasuRii/pi-tool-display/pull/37)、[closure comment](https://github.com/MasuRii/pi-tool-display/pull/37#issuecomment-5059417608)                                                                                                                 | obsolete/out of scope / 已由 fork 重构吸收 | 上游 comment 明确关闭原因是改动 intended for fork；当前 liuli fork 已吸收纯显示方向。                                                                   |


## 附录 B：验证限制

- 本次没有修改产品代码、配置或 GitHub issue；只新增本审计报告。
- 当前 HEAD 验证：637/637 non-real-runtime tests passed；typecheck/build/`git diff --check` passed；真实 Pi 0.82.0 contract passed。development、Pi 0.81.1 与 minimum-supported runtime 因缺少对应 `PI_RUNTIME_*_ROOT` 而 skipped。
- 因此：0.82.0 生命周期 contract 有真实运行时证据；仍不能据此证明 0.74.0/0.81.1、交互滚动 viewport、真实 tmux 或所有第三方包共存组合已解决。
- 报告中的“已由重构解决（runtime caveat）”表示当前源码已移除上游报告的旧根因，并非声称所有声明版本和组合均已验收。
