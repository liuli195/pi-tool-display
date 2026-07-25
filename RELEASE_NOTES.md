# @pure/pi-tool-display 0.1.0

The first standalone release of `@pure/pi-tool-display` introduces a rendering-only architecture for compact Pi tool rows and trustworthy tool-provided diffs.

## Rendering without tool conflicts

Older designs gained display control by re-registering executable tools or wrapping their definitions. That made extension behavior sensitive to registration order and could cause ownership conflicts, stale wrappers after reload, late-registration races, or accidental changes to tool execution and settings.

This release moves presentation to Pi's final tool-row rendering seam. It never re-registers tools, wraps `execute`, replaces schemas, changes active tools, or mutates model/session data. Tool producers retain ownership and execution control; `@pure/pi-tool-display` only renders their existing calls and results.

The result is safer composition with Bash customizers, MCP adapters, permission systems, background-task extensions, and other packages that interact with the same tools. If a host shape is unsupported or a renderer fails, the extension fails open to Pi's native rendering without affecting execution.

## Highlights

- Rendering-only integration with no executable-tool ownership takeover
- Registration-order-independent display policy and reload-safe cleanup
- Compact rendering for Pi's built-in tools
- Configurable hidden, summary, preview, and expanded output modes
- Split and unified diff layouts
- Explicit display-only adapters for third-party tool renderers
- Reload-safe lifecycle and project-local configuration overlays
- Support for stable Pi releases from `0.81.1` onward

## Install

```bash
pi install git:github.com/liuli195/pi-tool-display@v0.1.0
```

See [README.md](README.md) for configuration and usage.
