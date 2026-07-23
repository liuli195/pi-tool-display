# Pi 0.81.1 历史工具渲染根因与修复方案

> 状态：供审阅，未修改产品代码
> 基线：`pi-tool-display` `main@e66bba92488d09a401acc2a4088d5131423bb9bf`
> 实际运行时：全局 `@earendil-works/pi-coding-agent@0.81.1`
> 项目测试依赖：本仓库锁定的 `@earendil-works/pi-coding-agent@0.80.3`

## 1. 结论摘要

### 已由一手源码和可运行探针确认

1. **0.81.1 冷启动的正常顺序是“先绑定扩展并完整等待 `session_start`，再构建历史聊天 UI”**。因此，只要 `pi-tool-display` 在自己的 `session_start` 中成功注册并取得工具所有权，冷启动历史行理论上应直接拿到当前注册 definition。冷启动全部失效不能归因于 Pi 0.81.1 把历史 UI 建在 `session_start` 之前；实际源码明确不是这个顺序。
2. **`/reload` 则故意反过来**：加载新扩展 factory、重建 runtime/registry，随后通过 `beforeSessionStart` 回调先 `rebuildChatFromMessages()`，最后才发出新的 `session_start(reason="reload")`。因此 reload 时历史 `ToolExecutionComponent` 必然先以“尚未执行本轮延迟注册”的 definition 构造。
3. **历史工具行保存的是构造时的 `toolDefinition` 快照**。后续 `pi.registerTool()` 会立即刷新 AgentSession 的 registry，但 Pi 0.81.1 没有把新 definition 回绑到既有 `ToolExecutionComponent`，也没有因 registry 变化自动 `invalidate()`/`updateDisplay()` 这些行。
4. **本地 0.80.3 与全局 0.81.1 的 class identity 分裂不是当前 Node CLI 的根因**。0.81.1 loader 明确把 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` alias 到全局 CLI 自己的模块；实测通过该 loader 加载扩展后：
   - `ToolExecutionComponent` 构造器 identity 相同；
   - prototype identity 相同；
   - `Text` identity 相同。
5. 当前 prototype patch 能让旧行在**下一次调用 `updateDisplay()` 时**动态找到当前 renderer，但它不能主动让旧行进入 `updateDisplay()`。这解释了 reload 后“部分行突然恢复、部分行仍旧”的核心不稳定性：恢复依赖后续主题 invalidation、展开状态切换或其他 UI 重建，而不是 registry 自身的确定性通知。
6. `grep` 与 `bash/edit/write` 的结构性差异是：Pi 0.81.1 默认 active tools 只有 `read/bash/edit/write`；`grep/find/ls` 默认关闭。当前项目又只为“当前 active 且当前 owner 为 builtin”的工具注册 wrapper。因此 reload 的 `session_start` 很容易注册 `bash/edit/write`，却跳过 `grep`。以后 `grep` 被激活并在 `before_agent_start` 注册时，新调用会拿到新 definition；既有 grep 行却不会因该注册自动更新。
7. 现有历史渲染测试是假阳性：它们在同一个本地 0.80.3 class 上安装 patch、构造行、手工调用 `setExpanded()`，恰好主动触发了真实运行时缺少的 `updateDisplay()`；它们没有跑 0.81.1 的 `InteractiveMode` 冷启动/reload 顺序，也把七个 built-in 全部设为 active。

### 修复方向

- **长期正确边界在 Pi 上游**：工具 registry 变化后，Pi 应自动把新 definition/rederer 回绑到已有工具行，或公开一个受支持的 `refreshToolRenderers()` API。扩展不应 patch 私有 `ToolExecutionComponent.prototype`。
- **本仓库临时兼容方案**：保留当前动态 resolver，但在每次成功注册 renderer 后，使用公开 UI 展开 API做一次无状态变化的“刷新脉冲”，强制现有工具行 `updateDisplay()`；同时覆盖 `session_start` 和 `before_agent_start`，以处理默认 inactive 的 grep/find/ls。此方案必须用全局 0.81.1 集成测试锁定，且标记为可删除兼容层。
- **不建议**把七个同名工具全部前移到 factory 无条件注册。虽然 `registerTool()` 在 factory 中是公开支持的，也能避开 cold/reload 时序，但它会在尚不能调用 `getAllTools()` 时抢占第三方同名工具的执行权，违反当前所有权保护目标。

## 2. 调研范围与一手来源

### 全局 Pi 0.81.1

- `C:/Users/liuli/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/package.json`
- `dist/core/extensions/loader.js`
- `dist/core/extensions/runner.js`
- `dist/core/agent-session.js`
- `dist/core/agent-session-runtime.js`
- `dist/modes/interactive/interactive-mode.js`
- `dist/modes/interactive/components/tool-execution.js`
- `dist/core/tools/{grep,bash,edit,write}.js`

### 官方文档 0.81.1

- `docs/extensions.md`
- `docs/packages.md`
- `docs/tui.md`

文档确认：

- async factory 会在 `session_start` 前完成；
- `registerTool()` 可在 factory 或启动后调用，启动后应立即刷新当前 session；
- 覆盖 built-in 时 renderer 按 call/result slot 继承；
- 核心 Pi 包应作为 peer，由 Pi 提供，不应捆绑；
- TUI `invalidate()` 是组件缓存刷新机制，但文档没有提供“工具 registry 变化后重建历史工具行”的公开 API。

### 本仓库

- `src/index.ts`
- `src/tool-overrides.ts`
- `src/tool-execution-patch.ts`
- `src/extension-lifecycle.ts`
- `tests/tool-execution-patch.test.ts`
- `tests/reload-behavior.test.ts`
- `tests/index-integration.test.ts`
- `package.json` / `package-lock.json`

## 3. 精确生命周期

### 3.1 扩展模块加载与 factory

0.81.1 `core/extensions/loader.js` 的关键事实：

1. loader 静态 import CLI 自己的 coding-agent/tui 模块；
2. Node 模式下建立 alias：
   - `@earendil-works/pi-coding-agent` → 全局包 `dist/index.js`；
   - `@earendil-works/pi-tui` → 全局 Pi 依赖的 tui entry；
3. 每次创建 jiti 时设置 `moduleCache: false`，reload 会重新执行扩展模块；
4. factory 执行期间 `pi.registerTool()` 合法，但 `getAllTools()`、`getActiveTools()` 等 action 尚未 bind，会抛出“runtime not initialized”；
5. factory 返回后，ResourceLoader 保存 extension handlers/tools；AgentSession 随后建立 ExtensionRunner 和 registry。

这意味着：

- 项目 `devDependency@0.80.3` 决定测试和直接 `tsx` 执行时的 class；
- 真正由全局 Pi loader 加载时，项目对 Pi 根包/TUI 根包的 import 被 alias 到 0.81.1；
- 版本错配仍会造成**测试覆盖错位和私有方法兼容风险**，但不是当前实际 CLI 的双 class 根因。

### 3.2 冷启动

精确顺序（`interactive-mode.js:init()`、`rebindCurrentSession()`、`agent-session.js:bindExtensions()`）：

```text
ResourceLoader 发现并执行全部 extension factory
  └─ pi-tool-display factory
      ├─ 安装 ToolExecutionComponent.prototype patch
      ├─ 注册 session_start / before_agent_start handlers
      └─ 尚未注册 built-in wrappers
AgentSession._buildRuntime()
  ├─ 建立 built-in definitions
  ├─ 建立 ExtensionRunner
  ├─ bind core actions
  └─ 建立初始 tool registry
InteractiveMode.init()
  ├─ 启动 TUI（使 session_start 可以开 UI）
  ├─ rebindCurrentSession()
  │   └─ bindCurrentSessionExtensions()
  │       └─ AgentSession.bindExtensions()
  │           ├─ emit session_start(reason=startup)，逐个 await handler
  │           │   └─ pi-tool-display 检查 active/owner 并 registerTool
  │           │       └─ runtime.refreshTools() 立即刷新 registry
  │           └─ resources_discover
  ├─ subscribeToAgent()
  └─ renderInitialMessages()
      └─ 为历史 toolCall new ToolExecutionComponent(
           ..., session.getToolDefinition(name), ...)
```

**推论**：在隔离环境里，冷启动历史行应使用项目注册的 definition。若实际全局扩展集合下“全部历史行仍 native”，必须在真实进程捕获以下之一：

- 当时工具不是 active；
- 当时 owner/sourceInfo 不是 builtin，项目按设计跳过；
- `registerTool` handler 抛错；
- definition 已注册但 renderer 对旧参数/旧 details 抛错并落入 Pi fallback。

不能再用“历史 UI 早于 `session_start`”解释冷启动，因为源码否定了它。

### 3.3 `/reload`

精确顺序（`interactive-mode.js:handleReloadCommand()`、`agent-session.js:reload()`）：

```text
InteractiveMode.handleReloadCommand()
  ├─ resetExtensionUI()
  └─ AgentSession.reload({ beforeSessionStart })
      ├─ emit old session_shutdown(reason=reload)
      │   └─ 项目恢复 prototype、清 runtime renderer publication
      ├─ settings.reload()
      ├─ ResourceLoader.reload()
      │   └─ 重新 import 模块、执行新 factory、重新安装 patch
      ├─ _buildRuntime(activeToolNames=旧 active set)
      │   └─ 此时新 factory 仍只注册了 handlers，尚无延迟 wrappers
      ├─ beforeSessionStart()
      │   └─ rebuildChatFromMessages()
      │       └─ 以此刻 registry 的 definition 构造全部历史行
      ├─ emit new session_start(reason=reload)
      │   └─ 项目此时才 registerTool，registry 变化
      └─ resources_discover(reason=reload)
InteractiveMode 继续：reload keybindings/theme、请求 render
```

因此 reload 的差异不是随机：

- 历史行在本轮 wrapper 注册前已经创建；
- `registerTool()` 只更新 AgentSession registry，不更改行内 `toolDefinition`；
- 当前 patch 在 `getCallRenderer/getResultRenderer` 时动态查询项目 publication，但旧行只有再次 `updateDisplay()` 才会调用这些方法；
- theme apply、Ctrl+O、某些设置重建会让部分行更新，因此用户看到多数 bash/edit/write 恢复；
- registry 变化本身没有自动刷新保证。

## 4. `ToolExecutionComponent` 的 renderer 解析

0.81.1 构造时保存：

- `toolDefinition`：`InteractiveMode` 从当前 session registry 查到的 definition；
- `builtInToolDefinition`：组件自行 `createAllToolDefinitions(cwd)[toolName]` 查到的内置 definition。

原生 `getCallRenderer/getResultRenderer` 规则：

1. 非 built-in 名称：使用注册 definition 的 renderer；
2. built-in 名称且没有注册 definition：使用 built-in renderer；
3. built-in 名称且有注册 definition：注册 definition 的 slot 优先，缺 slot 时继承 built-in slot。

这是官方文档所说的“执行覆盖与渲染覆盖按 slot 独立继承”。

但定义只在构造时传入。`render()` 不会每次回查 registry；它只渲染 `updateDisplay()` 已经放进 container 的子组件。因此仅 patch getter 仍缺少“何时重新执行 getter”的触发器。

## 5. grep 为什么不同

### 5.1 active tools

0.81.1 `AgentSession._buildRuntime()` 的默认 active names 明确为：

```text
read, bash, edit, write
```

`grep/find/ls` 是存在于 registry 的 built-in definition，但默认 inactive。CLI `--tools`、SDK/custom tools 或扩展运行时调用 `setActiveTools()` 才会激活它们。

本项目 `registerActiveBuiltInRenderers()` 同时要求：

- `pi.getActiveTools()` 包含名称；
- config 开启；
- 尚未注册；
- `pi.getAllTools()` 当前 owner 的 `sourceInfo.source === "builtin"`。

所以 reload 的 `session_start` 中：

- bash/edit/write 通常满足并被注册；
- grep 通常因 inactive 被跳过；
- grep 后来激活后，`before_agent_start` 才可能注册。

### 5.2 owner/sourceInfo

0.81.1 registry 构建规则是：

1. 先放全部 built-in wrappers；
2. 再按扩展加载顺序放 extension wrappers；
3. 同名后者覆盖前者；
4. `getAllTools()` 返回最终 owner 的 canonical `sourceInfo`。

本项目发布历史 renderer 时，又保存注册后 owner key，并在每次动态解析时确认当前 owner key 不变。于是存在三种 grep：

| 当前 grep owner | registered definition | active | 预期行为 |
|---|---|---:|---|
| builtin | builtin | 否 | 项目不注册；历史保持 Pi 原生 |
| pi-tool-display | 项目 wrapper | 是 | 新调用使用项目 renderer；旧行需主动 updateDisplay |
| 第三方/sdk | 第三方 definition | 视情况 | 项目按设计不接管；缺 renderer slot 时 Pi 继承 built-in grep renderer |

### 5.3 必须记录的真实证据

修复前的集成探针必须为每个阶段输出：

```json
{
  "phase": "startup-before|startup-after|reload-beforeSessionStart|reload-after|before_agent_start",
  "active": ["..."],
  "tool": {
    "name": "grep",
    "sourceInfo": {"source":"...","path":"...","scope":"...","origin":"..."},
    "rowToolDefinitionName": "...",
    "rowToolDefinitionHasRenderCall": true,
    "rowToolDefinitionHasRenderResult": true,
    "builtInDefinitionHasRenderCall": true,
    "builtInDefinitionHasRenderResult": true
  }
}
```

不能只打印工具名；名称不能证明 owner。

## 6. class identity / jiti 实测

使用全局 0.81.1 的 `dist/core/extensions/loader.js:loadExtensions()` 加载临时 TS 扩展；扩展 import `ToolExecutionComponent`/`Text` 并暴露引用，host 再与自身全局 import 比较。

已运行结果：

```json
{
  "errors": [],
  "extensionCount": 1,
  "toolExecutionSame": true,
  "toolExecutionProtoSame": true,
  "textSame": true,
  "hostVersion": "0.81.1"
}
```

又在隔离的真实 0.81.1 RPC runtime 中按顺序加载“before probe → 本项目 → after probe”，并显式启用七个 built-in：

- startup before：七个 owner 均为 `<builtin:name>`；
- startup after：七个 owner 均为 `D:\My Project\pi-tool-display\index.ts`；
- reload before/after：得到同样的 owner 转换；
- probe 在 host 的 `ToolExecutionComponent.prototype` 上看到了项目 patch symbol。

结论：

- alias 和 class identity 在标准全局 Node CLI 中正常；
- 隔离环境中的延迟注册也确实更新 owner；
- 仍需在“完整用户扩展集合 + TUI 历史 session”中记录 owner、active 和行内 definition，才能解释冷启动实测与标准顺序的偏差；修复不能把该偏差伪装成 class split。

## 7. 哪些现有测试是假阳性

### `tests/tool-execution-patch.test.ts`

1. import 的是仓库 `node_modules` 里的 0.80.3 `ToolExecutionComponent`，不是全局 0.81.1。
2. patch 与被测 component 天然在同一 class identity，不能发现 runtime alias/版本问题。
3. “pre-upgrade built-in rows”在注册后逐一调用 `setExpanded(false/true)`；该调用会触发 `updateDisplay()`，正好绕过真实 bug。
4. 测试直接构造 component，而不是经 `InteractiveMode.renderInitialMessages()`、`restoreChatBeforeSessionStart()`。
5. API stub 的 `getActiveTools()` 通常把七个 built-in 全设为 active，掩盖 grep/find/ls 默认 inactive。
6. owner/sourceInfo 是手写简化对象，没有真实 ResourceLoader 的 package scope/origin/baseDir 与多扩展加载顺序。
7. 没有断言 registry 更新后、**不调用 setExpanded/invalidate** 的既有行是否自动刷新。

### `tests/reload-behavior.test.ts`

1. 多次直接调用 extension factory 不等价于 `ResourceLoader.reload()`。
2. 没有执行 Pi 的 `session_shutdown → resourceLoader.reload → _buildRuntime → beforeSessionStart rebuild → session_start` 链。
3. “built-in tool overrides re-registered”主要通过手工调用 `before_agent_start`，不能证明 reload 历史行已重绑。
4. handler 累加在真实 reload 中不会发生；真实 loader 会建立新 extension objects/runtime，并使旧 API stale。

### `tests/index-integration.test.ts`

1. “lifecycle expected order”测试手工执行 `before_agent_start` 后才执行 `session_start`，与官方生命周期相反。
2. 没有历史 UI、没有 reload、没有真实 ToolExecution renderer fallback。
3. stub 不模拟 `registerTool()` 触发 `_refreshToolRegistry()` 和 sourceInfo ownership。

### 全套测试的共同缺口

- 没有以全局/矩阵版本运行；
- 没有真实 session JSONL fixture；
- 没有区分 cold/reload/new call；
- 没有同时检查 collapsed/expanded；
- 没有“零手工刷新”断言；
- 没有第三方同名 owner 与 built-in slot inheritance 的真实集成用例。

## 8. 最小可运行诊断与集成测试设计

### 8.1 目标

一个命令必须同时能对以下三条路径给出红/绿结果：

```bash
PI_0811_ROOT="C:/Users/liuli/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent" \
node --test tests/runtime/pi-0.81.1-history-rendering.integration.test.mjs
```

不调用模型、不依赖网络、不需要人工按键，目标运行时间小于 10 秒。

### 8.2 fixture

新建最小 session fixture，含每种工具一对 assistant `toolCall` + `toolResult`：

- bash：4 行 command、4 行 result；
- edit：超过 collapsed limit 的 diff；
- write：6 行 content；
- grep：3 个 match；
- 同名第三方 grep：一份带自定义 renderer，一份不带 renderer，用于 inheritance。

fixture 必须使用 0.81.1 `SessionManager` 写入，而不是手写不完整 JSONL；另保留一份旧参数形状 fixture 验证兼容。

### 8.3 三个场景

#### A. cold startup

1. 使用临时 `PI_CODING_AGENT_DIR`，只加载本项目和诊断 extension；
2. 用真实 0.81.1 ResourceLoader/AgentSession；
3. 建立 InteractiveMode，但替换 terminal 为内存 terminal，禁止真实 stdout；
4. `init()` 后直接读取 chat container 中的 ToolExecution rows；
5. 在**不调用 setExpanded/invalidate**前先断言 collapsed 输出；再切 expanded 断言完整输出。

#### B. reload

1. 保留 A 的同一 session；
2. 调用真实 `ctx.reload()` 或 `AgentSession.reload({beforeSessionStart})` + InteractiveMode reload 路径；
3. 在 `beforeSessionStart`、`session_start` 后、theme apply 后分别采样；
4. 断言 registry 变化后旧行自动更新，而不是测试主动刷新后才更新。

#### C. new call

1. 向 InteractiveMode 注入真实 `message_update/tool_execution_start/update/end` 事件；
2. 断言新 component 使用当前 owner definition；
3. 与同名历史行输出比较，必须一致。

### 8.4 必须同时验证的 identity/ownership

每个场景都断言：

- extension import class === host class；
- row `instanceof` host class；
- `getActiveTools()`；
- `getAllTools()` canonical sourceInfo；
- row captured definition 与 session current definition 是否同一对象；
- call/result slot 最终选中的函数来源；
- renderer 抛错时记录异常，禁止被 Pi 静默 fallback 掩盖。

测试诊断版可临时包装 renderer 并重新抛出带 `[HISTORY-DIAG]` 的错误；正式回归测试移除 instrumentation。

### 8.5 测试矩阵

| 维度 | 值 |
|---|---|
| Pi | 项目 0.80.3、全局 0.81.1；CI 再加 peer 最低版本 |
| 生命周期 | cold、reload、new call |
| 工具 | read、bash、edit、write、grep、find、ls |
| active | 启动即 active、启动 inactive 后动态 active |
| owner | builtin、pi-tool-display、第三方有 renderer、第三方缺一个 slot |
| UI | collapsed、expanded、theme invalidate 后 |
| 历史 | 当前 schema、旧 schema、aborted/error result |

## 9. 建议修复阶段

## 阶段 0：先锁定真实全局进程证据（不改变行为）

### 目的

解释冷启动实测为何偏离 0.81.1 标准顺序，并确认 grep 的实际 owner/active 转换。

### 计划改动文件

- `tests/runtime/pi-0.81.1-history-rendering.integration.test.mjs`
- `tests/fixtures/history-rendering-session.*`
- 可选：`tests/runtime/history-diagnostic-extension.ts`
- `package.json`：只增加显式 integration script，不把全局路径硬编码进普通 `npm test`

### 产出

- 一条可复现红测试；
- cold/reload/new 三份 phase trace；
- 确认 cold 失败属于 ownership/active、renderer exception，还是宿主实际不是所检查的 Node CLI。

### 停止条件

在未得到真实行内 definition 和 sourceInfo 前，不改注册时序。

## 阶段 1：本仓库最小临时兼容修复

### 方案

1. 保留 owner/sourceInfo 防护；
2. 每次 `registerActiveBuiltInRenderers()` 新增至少一个 renderer 后，触发现有行刷新；
3. 刷新必须覆盖 `session_start` 和 `before_agent_start`，后者处理 grep/find/ls 动态激活；
4. 优先使用公开 `ctx.ui.getToolsExpanded()/setToolsExpanded()`：读取当前值，切换一次并恢复，以触发所有 expandable tool rows 的 `setExpanded()`/`updateDisplay()`；若实测存在可见闪烁或漏行，再采用最小私有 fallback；
5. 刷新应只在实际新增注册时执行，避免每 turn 双重重绘；
6. 将兼容代码集中在 `tool-execution-patch.ts` 或单一 lifecycle helper，并标明删除条件：Pi 提供 registry-driven refresh 后删除。

### 计划改动文件

- `src/tool-overrides.ts`：返回本轮新注册 names；生命周期 handler 接收 `ctx` 并请求刷新
- `src/tool-execution-patch.ts`：保留动态 owner-aware resolver；必要时提供单一 refresh helper
- `tests/tool-execution-patch.test.ts`：补“不手工 setExpanded 不会更新”的红测试，再验证 refresh
- `tests/runtime/pi-0.81.1-history-rendering.integration.test.mjs`
- `package.json` / CI 配置：增加 0.81.1 integration job

### 不做

- 不无条件 factory 注册七个同名执行工具；
- 不用 `setTimeout` 猜时序；
- 不按工具名推断 owner；
- 不把 grep 特判为固定延迟；它只是动态 active 的代表。

## 阶段 2：收缩 private patch

在阶段 1 通过后：

1. 对新构造行完全依赖公开 `registerTool` renderer；
2. private prototype patch 只服务于“旧行保存旧 definition”兼容；
3. 加运行时版本/shape guard：`getCallRenderer/getResultRenderer` 不存在或签名改变时禁用 patch并提示，而不是静默写 prototype；
4. peerDependencies 加入并验证 `^0.81.0`，但不能仅改版本声明而不跑测试。

### 计划改动文件

- `src/tool-execution-patch.ts`
- `src/index.ts`
- `package.json`
- `README.md` / `CHANGELOG.md`
- 对应 unit/integration tests

## 阶段 3：Pi 上游长期修复

### 首选：registry 驱动的自动重绑

Pi 内部最小改动：

1. `ToolExecutionComponent` 增加公开/内部 `setToolDefinition(definition)`，更新字段并 `updateDisplay()`；
2. `AgentSession._refreshToolRegistry()` 在最终 registry 稳定后发出 `tool_registry_changed`（包含 changed names 或 definition resolver）；
3. `InteractiveMode` 维护/遍历当前历史与 pending tool rows，对匹配名称调用 `setToolDefinition(session.getToolDefinition(name))`；
4. reload 的 `beforeSessionStart` 顺序可以保留，以允许 `session_start` UI 对话看到聊天记录；随后 registry change 自动重绑即可。

### 备选公开 API

如果上游不愿自动事件，至少增加：

```ts
ctx.ui.refreshToolRenderers(names?: string[]): void
```

语义：

- 重新从当前 AgentSession registry 解析已有 ToolExecution rows；
- 保留 expanded 状态、row-local state、partial result、image state；
- 在非 TUI 模式 no-op；
- 不改变 active tools 或执行 owner。

### 更深但更干净的 API

增加独立 renderer registry，例如：

```ts
pi.registerToolRenderer(name, { renderCall, renderResult, renderShell }, options)
```

将“谁执行工具”与“谁装饰显示”彻底分离，明确优先级、slot inheritance 和 provenance。该方案最正确，但改动面大于本问题所需；应先实现自动重绑或 refresh API。

### 上游计划改动文件

- Pi `packages/coding-agent/src/core/agent-session.ts`
- Pi `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Pi `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- Pi extension API types/UI context
- Pi cold/reload/history integration tests
- `docs/extensions.md`：说明动态 renderer 对历史行的刷新保证

## 10. 风险与控制

| 风险 | 影响 | 控制 |
|---|---|---|
| 刷新脉冲造成 UI 闪烁 | reload/turn 开始时视觉跳动 | 同一 tick 内恢复原 expanded；仅新注册时执行；集成测试内存 terminal diff |
| 双次 updateDisplay 重启 bash spinner | timer 泄漏/重复动画 | 复用 `lastComponent`；保留现有 timer cleanup 测试并在 reload 集成测试计数 |
| 第三方同名工具被覆盖 | 执行语义改变，最高风险 | canonical sourceInfo + owner key；不做 factory 无条件注册 |
| owner 在动态加载后变化 | 历史行显示错误 renderer | 每次动态 resolver 重新确认当前 owner；registry refresh 后重绑 |
| grep inactive 时无 renderer | reload 后仍 native | 在 `before_agent_start` 注册后同样刷新；测试 inactive→active |
| 私有 Pi 方法变化 | 升级后静默失效 | runtime shape guard、0.81.1 job、失败时明确诊断 |
| renderer 对旧 schema 抛错 | Pi 静默 fallback，误判为未注册 | 集成诊断包装器记录真实异常；旧 schema fixture |
| 重建整个 chat 丢 row state | 展开、图片、partial 状态丢失 | 优先更新 definition，不整页 rebuild；若临时 rebuild，逐项验收状态 |

## 11. 回滚方案

### 本仓库临时修复回滚

1. 单提交实现阶段 1；不和 renderer 样式改动混合；
2. 出现闪烁、timer 或第三方冲突时，回滚该提交即可恢复 `e66bba9` 行为；
3. 配置增加的任何兼容开关默认不保留；优先代码回滚，避免永久配置债务；
4. integration test 和诊断 fixture保留，即使回滚行为修复也不删除。

### 上游方案回滚

- 自动 registry event 可通过内部 feature flag 暂停；
- `setToolDefinition()` 为增量 API，不破坏旧构造器；
- 若自动更新有回归，先停订阅 event，保留公开 refresh API供扩展显式调用。

## 12. 验收标准

### 功能

1. 全局 Pi 0.81.1 真进程冷启动同一历史 session：bash/edit/write/grep 按配置渲染；无需先 `/reload`、无需 Ctrl+O、无需主题切换。
2. `/reload` 后首帧稳定完成刷新；不能要求用户再触发一次 UI 操作。
3. reload 后 grep 即使启动时 inactive、随后才 active，也在注册完成后刷新历史 grep 行。
4. 新调用与同名历史调用的 collapsed/expanded 输出一致。
5. 第三方同名 owner 的 call/result renderer被保留；缺失 slot 按 Pi built-in inheritance 规则处理。
6. 当前第三方 owner 永远不被项目历史 publication 覆盖。
7. aborted/error/partial/image 行不丢失状态。

### 测试

1. 0.80.3 unit suite 全绿；
2. 全局 0.81.1 cold/reload/new integration 全绿；
3. 默认 active 与 all-active 两组全绿；
4. inactive→active grep 用例全绿；
5. class identity探针全绿；
6. 不允许测试通过手工 `setExpanded()` 掩盖“registry 后未自动刷新”；先断言自动刷新，再单独测展开。

### 性能与稳定性

- 单次 registry 变更最多刷新相关历史行一次；
- 无新增 interval/timer 泄漏；
- 500 个历史工具行 reload 不出现可感知卡顿或 O(n²) 重建；
- 无 renderer fallback 静默异常。

## 13. 推荐决策

建议批准以下顺序：

1. **先落阶段 0 的真实 0.81.1 集成红测试与 phase trace**，尤其确认完整扩展集合下冷启动 owner/active/renderer exception；
2. **阶段 1 用最小 refresh 脉冲止血**，不改变工具所有权策略；
3. 同时向 Pi 上游提交“registry 变化自动回绑已有 ToolExecution rows”改动；
4. 上游版本可用后删除 prototype patch 和 refresh 脉冲。

不建议批准“继续补更多 mock 单测”或“把延迟改成另一个 timeout”。当前缺陷来自真实生命周期和 UI definition 快照，必须在真实 0.81.1 seam 上锁定。
