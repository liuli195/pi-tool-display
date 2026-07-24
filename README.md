<div align="center">

# pi-tool-display

[![npm version](https://img.shields.io/npm/v/pi-tool-display?style=for-the-badge)](https://www.npmjs.com/package/pi-tool-display)
[![License](https://img.shields.io/github/license/liuli195/pi-tool-display?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Y8Y01PSSVR)

A pure TUI display wrapper for the [Pi coding agent](https://github.com/mariozechner/pi).

`pi-tool-display` keeps tool rows compact, renders trustworthy tool-provided diffs, and improves the native user prompt box without changing tools, model context, messages, or sessions.

<img width="1360" height="752" alt="image" src="https://github.com/user-attachments/assets/777944a2-18b2-4642-b035-2c703a5abb1b" />

<img width="978" height="670" alt="image" src="https://github.com/user-attachments/assets/122b69ce-6c99-4aaa-ba93-236f97a1d8b4" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/7d5e36d3-cbe1-4d54-8bed-ae3dbdef870c" />
<img width="1919" height="566" alt="image" src="https://github.com/user-attachments/assets/68a1619b-62da-480f-8de3-2af441ccf6ff" />
<img width="1919" height="550" alt="image" src="https://github.com/user-attachments/assets/1d3f0b38-a5b5-47fc-b54b-8b55cc2bfaf1" />

</div>

## Features

- **Compact built-in tool rendering** for `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`
- **Opt-in MCP-style rendering** with hidden, summary, and preview modes through custom tool overrides
- **Opt-in custom tool overrides** for noisy extension tools, defaulting to generic rendering unless `kind: "mcp"` is selected
- **Adaptive edit/write diffs** with split or unified layouts, syntax highlighting, inline emphasis, and narrow-pane width clamping
- **Trustworthy diff rendering only** from explicit patches or before/after data already supplied by the tool; missing diffs are never reconstructed
- **Progressive collapsed diff hints** that shorten automatically on small terminal widths instead of overflowing
- **Hashline-anchor diff gutters** that preserve `LINE#HASH` labels from anchored read/edit output when those lines are rendered in diffs
- **Three presets**: `opencode`, `balanced`, and `verbose`
- **Optional native user message box** with markdown-aware rendering and safer ANSI/background handling
- **Per-tool display toggles** that never change tool ownership or execution
- **Explicit third-party rendering** through `customToolOverrides` or producer adapters; MCP-like tools are never auto-detected for styling
- **Capability-aware RTK settings** that appear only when the optimizer is available
- **Adapter API for renderer consumers** through the `pi-tool-display/tool-display-api-consumer` subpath export

## Installation

### Local extension folder

Place this folder in one of Pi's auto-discovery locations:

```text
# Global default (when PI_CODING_AGENT_DIR is unset)
~/.pi/agent/extensions/pi-tool-display

# Project-specific
.pi/extensions/pi-tool-display
```

### npm package

```bash
pi install npm:pi-tool-display
```

### Git repository

```bash
pi install git:github.com/liuli195/pi-tool-display
```

## Usage

### Interactive settings

Open the settings modal:

```text
/tool-display
```

The modal exposes the day-to-day controls most people change regularly:

- preset profile
- read and grep/find/ls output modes
- preview line count
- Bash output, command, and error modes with their line limits
- diff layout and indicator modes
- RTK compaction hints (when RTK is available)
- native user message box toggle

JSON-only controls include the extension master switch, debug logging, built-in and custom-tool selection, the fallback output mode for explicit MCP producer adapters, expanded preview limit, split-width threshold, collapsed logical diff-line limit, diff wrapping, and truncation hints.

### Direct commands

```text
/tool-display show                    # Show the current display-policy summary
/tool-display reset                   # Reset to the default opencode preset
/tool-display preset opencode         # Apply opencode preset
/tool-display preset balanced         # Apply balanced preset
/tool-display preset verbose          # Apply verbose preset
```

### Tool display adapter API

Other extensions can opt into `pi-tool-display` rendering without directly depending on its load order by importing the consumer helper:

```ts
import { registerRendererAdapter } from "pi-tool-display/tool-display-api-consumer";

const dispose = registerRendererAdapter({
  id: "my-extension:mcp",
  toolName: "my_mcp_tool",
  kind: "mcp",
});
// Dispose during extension shutdown or reload.
dispose();
```

Registration is display-only, deterministic, disposable, and does not expose or mutate the executable tool definition, schema, ownership, active state, or execution. Retain the returned disposer even when registering before `pi-tool-display` loads: after the pending intent is drained, that same disposer delegates to the live registration and remains idempotent before or after the drain.

The deprecated `decorateToolForDisplay(tool, adapter)` migration facade registers the same display intent and returns the exact original tool unchanged. Its registration lasts only for the current `pi-tool-display` load epoch; repeated calls for the same tool and adapter ID in that epoch replace the previous intent, and consumers must call it again after reload. New integrations should retain the disposer from `registerRendererAdapter` instead.

## Compatibility

Supported Pi versions are exactly `0.74.0`, `0.80.3` (the repository development runtime), and `0.81.1`, the versions exercised by the release matrix. Any other version or incompatible private TUI shape emits one concise debug diagnostic and keeps Pi's native rendering and execution.

## Presets

| Preset | Read Output | Search Output | Explicit MCP Adapter Default | Bash Output | Preview Lines | Bash Lines |
|--------|-------------|---------------|------------------------------|-------------|---------------|------------|
| `opencode` | hidden | hidden | hidden | opencode | 8 | 10 |
| `balanced` | summary | count | summary | summary | 8 | 10 |
| `verbose` | preview | preview | preview | preview | 12 | 20 |

- **`opencode`** (default): minimal inline-only display; tool results stay collapsed
- **`balanced`**: compact summaries with line counts and match totals; bash shows line count only
- **`verbose`**: larger previews for read/search/MCP/bash output

### Bash Output Modes

| Mode | Behavior |
|------|----------|
| `opencode` | Classic collapsed output using the `bashCollapsedLines` visual-row limit with expansion hint |
| `summary` | Shows only line count (e.g., "↳ 3 lines returned") — no output displayed |
| `preview` | Shows actual output lines using `previewLines` limit |

## Configuration

Runtime configuration is stored at:

```text
Default global path: ~/.pi/agent/extensions/pi-tool-display/config.json
Actual global path: $PI_CODING_AGENT_DIR/extensions/pi-tool-display/config.json when PI_CODING_AGENT_DIR is set
```

A starter template is included at `config/config.example.json`.

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch; set to `false` and reload to disable the extension |
| `debug` | boolean | `false` | Opt-in file logging for extension diagnostics; preserved by `/tool-display` saves |
| `builtInToolDisplays` | object | all `true` | Enable display formatting for each built-in tool |
| `customToolOverrides` | object | `{}` | Explicit opt-in rendering rules for non-built-in extension tools |
| `enableNativeUserMessageBox` | boolean | `true` | Enable bordered user prompt rendering |
| `readOutputMode` | string | `"hidden"` | `hidden`, `summary`, or `preview` |
| `searchOutputMode` | string | `"hidden"` | `hidden`, `count`, or `preview` |
| `mcpOutputMode` | string | `"hidden"` | Fallback `hidden`, `summary`, or `preview` mode for explicitly registered MCP producer adapters; it does not discover or opt tools into rendering |
| `previewLines` | number | `8` | Lines shown in collapsed preview mode |
| `expandedPreviewMaxLines` | number | `4000` | Max expanded source lines for read/search/MCP/Bash previews; expanded diffs use it as a rendered-row bound |
| `bashOutputMode` | string | `"opencode"` | `opencode` (collapse), `summary` (line count), or `preview` (show lines) |
| `bashCollapsedLines` | number | `10` | Visual rows shown for collapsed Bash output in opencode mode |
| `bashCommandMode` | string | `"preview"` | Bash command display: `full`, `summary`, or `preview` |
| `bashCommandPreviewLines` | number | `3` | Visual command lines shown in preview mode; Ctrl+O expands the full command |
| `bashErrorOutputMode` | string | `"preview"` | Failed Bash output: `full`, `summary`, or `preview`; the failure header always remains visible |
| `bashErrorPreviewLines` | number | `3` | Visual error lines shown in preview mode; Ctrl+O expands the error output |
| `diffViewMode` | string | `"auto"` | `auto`, `split`, or `unified` |
| `diffIndicatorMode` | string | `"bars"` | `bars` (vertical indicators), `classic` (+/- markers), or `none` |
| `diffSplitMinWidth` | number | `120` | Minimum width before auto mode prefers split diffs |
| `diffCollapsedLines` | number | `24` | Logical diff content lines shown when collapsed; headers, metadata, and wrapped continuations do not consume the limit |
| `diffWordWrap` | boolean | `true` | Wrap long diff lines when needed |
| `showTruncationHints` | boolean | `false` | Show truncation indicators for compacted output |
| `showRtkCompactionHints` | boolean | `false` | Show RTK compaction hints when RTK metadata exists |

### Built-in display selection

Use `builtInToolDisplays` to select which built-in rows this extension formats:

```json
{
  "builtInToolDisplays": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  }
}
```

Set an entry to `false` to keep Pi's native renderer. Changes made through `/tool-display` apply immediately; manual `config.json` edits require `/reload`. Display selection never changes tool ownership, activation, definitions, or execution. Legacy `registerToolOverrides` input remains supported and is not rewritten merely by loading it.

### Custom tool overrides

Use `customToolOverrides` when another extension registers a noisy top-level tool and you want `pi-tool-display` to compact its result output. Custom overrides are explicit opt-in only: unlisted or disabled tools keep their original renderers, and native call renderers are preserved by default.

```json
{
  "customToolOverrides": {
    "ide_find_symbol": {
      "enabled": true,
      "kind": "generic",
      "outputMode": "summary"
    },
    "custom_mcp_gateway": {
      "enabled": true,
      "kind": "mcp",
      "outputMode": "preview"
    }
  }
}
```

Each entry supports:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Whether `pi-tool-display` should decorate this custom tool |
| `kind` | string | `"generic"` | `generic` for plain compact output, or `mcp` for MCP-style call labels and result handling |
| `outputMode` | string | `"summary"` | `hidden`, `summary`, or `preview` for this custom tool's result output |
| `overrideCallRenderer` | boolean | `false` | Replace the tool's native call renderer with the generic or MCP call renderer |

Boolean shorthand is also accepted:

```json
{
  "customToolOverrides": {
    "ide_find_symbol": true,
    "noisy_tool_to_leave_alone": false
  }
}
```

Notes:

- Built-in tool names (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) are ignored here; use `builtInToolDisplays` for those.
- With `overrideCallRenderer: true`, `generic` call rendering shows the tool name and argument count.
- With `overrideCallRenderer: true`, `mcp` call rendering understands MCP proxy-style arguments such as `tool`, `server`, `search`, `describe`, and `connect`.
- Overrides are selected at render time, so they work regardless of tool registration or extension load order.

### Example config

```json
{
  "enabled": true,
  "debug": false,
  "builtInToolDisplays": {
    "read": true,
    "grep": true,
    "find": true,
    "ls": true,
    "bash": true,
    "edit": true,
    "write": true
  },
  "customToolOverrides": {
    "ide_find_symbol": {
      "enabled": true,
      "kind": "generic",
      "outputMode": "summary"
    },
    "custom_mcp_gateway": {
      "enabled": true,
      "kind": "mcp",
      "outputMode": "preview"
    }
  },
  "enableNativeUserMessageBox": true,
  "readOutputMode": "summary",
  "searchOutputMode": "count",
  "mcpOutputMode": "summary",
  "previewLines": 12,
  "expandedPreviewMaxLines": 4000,
  "bashOutputMode": "opencode",
  "bashCollapsedLines": 15,
  "bashCommandMode": "preview",
  "bashCommandPreviewLines": 3,
  "bashErrorOutputMode": "preview",
  "bashErrorPreviewLines": 3,
  "diffViewMode": "auto",
  "diffIndicatorMode": "bars",
  "diffSplitMinWidth": 120,
  "diffCollapsedLines": 24,
  "diffWordWrap": true,
  "showTruncationHints": false,
  "showRtkCompactionHints": false
}
```

### Debug logging

Debug logging is disabled by default. Set `debug` to `true` in the extension root `config.json` only when collecting diagnostics; missing or non-`true` values are treated as `false`. When enabled, diagnostics are appended to `debug/debug.log` under a runtime-created `debug/` directory, and no debug output is written to the terminal.

## Rendering notes

### Edit and write diffs

`edit` and `write` results use the same diff renderer. In `auto` mode the extension chooses split or unified layout based on available width. Collapsed limits count logical diff content lines, so split headers, trusted omission metadata, and wrapped continuations do not consume the budget. Expanded limits still count rendered rows to keep small panes bounded.

Partial `edit` calls can render a diff only from explicit old/new text supplied by the call. `write` calls show neutral content summaries unless the tool supplies trustworthy diff evidence. Rendering never reads the workspace to reconstruct a preimage or infer create/overwrite semantics.

When diff input includes Pi anchored read lines such as `12#AB:content`, the renderer treats the anchor as line metadata and displays the `LINE#HASH` label in the gutter while keeping the content aligned for split, unified, and compact diff layouts.

### Write summaries

When content is available, `write` call summaries include line count and byte size information inline so you can quickly see the size of the pending write before expanding the result.

### Native user message box

When enabled, user prompts render inside a bordered box using Pi's native user message component. The renderer preserves markdown content more safely and normalizes ANSI/background handling to avoid odd nested background artifacts.

## Capability detection

The extension does not probe tool metadata to identify MCP tools. MCP-style rendering is enabled only by an exact `customToolOverrides` entry or an explicit producer adapter.

RTK controls remain capability-aware:

- **RTK optimizer available**: the modal exposes an RTK compaction-hints toggle
- **RTK optimizer unavailable**: the RTK control is hidden and RTK compaction hints are disabled

This keeps the RTK UI aligned with the current environment. Explicit producer adapters may still register dynamically; unconfigured tools remain native.

## Troubleshooting

### Reload safety

`/reload` is fully supported. On reload, the extension removes its display patches, timers, and Adapter registrations before reinstalling the current display policy. It never re-registers tools. No manual cleanup is needed.

### Display conflicts

Set `builtInToolDisplays.<tool>` to `false` to retain Pi's native renderer for that built-in. Display selection is independent of the executable tool's owner. Modal changes apply immediately; manual JSON edits require `/reload`. Use `/tool-display show` to inspect the effective display state.

### Config not loading

If your settings are not being applied:

1. Check that the global Pi tool-display config exists (default: `~/.pi/agent/extensions/pi-tool-display/config.json`, respects `PI_CODING_AGENT_DIR`)
2. Make sure the JSON is valid
3. Run `/tool-display show` to inspect the current display-policy summary

### MCP or custom tool rendering not appearing

Add the exact third-party tool name under `customToolOverrides`. Use `kind: "generic"` for ordinary tools and `kind: "mcp"` for MCP proxy or direct tools. MCP tools are not detected or intercepted separately.

### RTK setting missing

The RTK control appears only when the optimizer is available. MCP-style tools are configured manually under `customToolOverrides`; there is no auto-detected MCP control.

## Project structure

```text
pi-tool-display/
├── index.ts                         # Extension entrypoint for Pi auto-discovery
├── src/
│   ├── index.ts                     # Bootstrap and extension registration
│   ├── capabilities.ts              # RTK capability detection
│   ├── config-command.ts            # Single lazy /tool-display registration entry
│   ├── config-modal.ts              # /tool-display settings UI and command handling
│   ├── config-store.ts              # Config load/save and normalization
│   ├── disposable.ts                # Reload-safe cleanup registry for display patches and timers
│   ├── diff-renderer.ts             # Edit/write diff rendering engine
│   ├── line-width-safety.ts         # Width clamping helpers for narrow panes
│   ├── pi-host-adapter.ts           # Supported Pi host-shape qualification
│   ├── presets.ts                   # Preset definitions and matching
│   ├── render-utils.ts              # Shared rendering helpers
│   ├── tool-display-resolver.ts     # Pure display-policy resolution
│   ├── tool-display-runtime.ts      # Reload-safe renderer runtime
│   ├── tool-execution-patch.ts      # Final tool-row display seam
│   ├── tool-overrides.ts            # Built-in, MCP, and custom display renderers plus Adapter API
│   ├── types.ts                     # Shared config and type definitions
│   ├── user-message-box-markdown.ts # Markdown extraction for user message rendering
│   ├── user-message-box-native.ts   # Native user message box registration
│   ├── user-message-box-patch.ts    # Safe native render patching helpers
│   ├── user-message-box-renderer.ts # User message border renderer
│   ├── user-message-box-utils.ts    # ANSI/background normalization helpers
│   ├── write-display-utils.ts       # Write summary helpers
│   └── zellij-modal.ts              # Modal UI primitives
├── config/
│   └── config.example.json          # Starter config template
└── tests/
    ├── ansi-utils.test.ts           # ANSI utility tests including foreground RGB preservation
    ├── bash-display.test.ts         # Bash display and spinner tests
    ├── capabilities-edge.test.ts    # Capability detection edge cases
    ├── config-modal.test.ts         # Config modal tests
    ├── custom-tool-overrides.test.ts # Opt-in custom tool override tests
    ├── debug-logger-edge.test.ts    # Debug logger edge cases
    ├── diff-renderer-ansi.test.ts   # ANSI/background handling tests for diff rendering
    ├── diff-renderer-edge.test.ts   # Diff renderer edge case tests
    ├── diff-renderer-width.test.ts  # Width and background coverage tests for diff rendering
    ├── index-integration.test.ts    # Integration tests for extension lifecycle
    ├── presets-edge.test.ts         # Preset edge case tests
    ├── reload-behavior.test.ts      # Reload-safe cleanup and re-registration tests
    └── tool-ui-utils.test.ts        # Utility tests for user message and diff helpers
```

## Development

```bash
# Type check
npm run build

# Run the local real-runtime contract (missing optional runtimes are skipped)
npm run test:contract:local

# Full three-runtime matrix and complete verification
# See docs/ownership-verification.md for required PI_RUNTIME_* roots.
npm test
npm run typecheck
npm run build
git diff --check
```

## Related Pi Extensions

- [pi-image-tools](https://github.com/MasuRii/pi-image-tools) — Image attachment and inline preview for the Pi TUI
- [pi-hide-messages](https://github.com/MasuRii/pi-hide-messages) — Hide older chat messages without losing context
- [pi-startup-redraw-fix](https://github.com/MasuRii/pi-startup-redraw-fix) — Fix terminal redraw glitches on startup
- [pi-permission-system](https://github.com/MasuRii/pi-permission-system) — Permission enforcement for tool and command access

## License

[MIT](LICENSE)
