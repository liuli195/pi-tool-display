# Transcript Decorations

## Outcome

`pi-tool-display` SHALL provide a small, Theme-aware presentation policy for tool separators and native USER message borders while preserving the pure-display non-interference contract.

## Configuration interface

The effective `ToolDisplayConfig` SHALL include:

```ts
enableToolSeparator: boolean;
toolSeparatorStyle: "dashed" | "solid";
toolSeparatorColor: DisplayColorToken;
userMessageBorderColor: DisplayColorToken;
```

`DisplayColorToken` SHALL accept exactly:

```text
border
borderAccent
borderMuted
accent
muted
dim
```

Defaults SHALL be:

```json
{
  "enableToolSeparator": true,
  "toolSeparatorStyle": "dashed",
  "toolSeparatorColor": "borderMuted",
  "userMessageBorderColor": "border"
}
```

Invalid values SHALL normalize to the corresponding default. Global configuration, trusted project overlays, explicit configuration patches, saving, examples and the interactive settings interface SHALL preserve these fields according to the existing configuration lifecycle contract.

## Tool separator behavior

When `enableToolSeparator` is true, every tool row SHALL render exactly one trailing separator, including tools whose call, result and shell presentation are otherwise entirely native.

- `dashed` SHALL render the selected dashed single-column glyph.
- `solid` SHALL render the selected solid single-column glyph.
- The separator SHALL use the current render-time Theme and `toolSeparatorColor`.
- The separator SHALL fit the available render width and SHALL NOT emit an over-width line.
- A non-positive width SHALL be handled without throwing.
- Partial and final result updates SHALL replace the rendered separator rather than accumulate separators.
- Disabling the separator SHALL preserve the selected renderer output without added separator rows.
- Tools without a matching built-in rule, explicit custom override or producer Renderer Adapter SHALL retain their native call, result and shell presentation, with the separator as the sole added decoration.
- Decoration or renderer failures SHALL fail open without hiding original tool content.

The separator SHALL be added once at the highest practical final tool-row presentation seam shared by all tools. Individual built-in and custom renderer implementations SHALL NOT each implement their own separator policy. The implementation SHALL NOT reproduce or fork Pi's native result fallback merely to append the separator.

## USER border behavior

When the native USER message box is enabled, it SHALL render two solid horizontal border rows instead of a rounded box.

- The top row SHALL begin with exactly one `─`, followed by the accent-styled ` user ` title, then enough `─` glyphs to fill the available render width.
- The bottom row SHALL consist entirely of `─` glyphs filling the same available render width.
- Both rows SHALL have the same visible width and SHALL NOT exceed the available render width.
- The renderer SHALL NOT emit rounded corners or left/right vertical USER border glyphs.
- Content SHALL retain one column of left indentation and use the width freed by removing vertical borders. One blank background row SHALL separate the content from each horizontal border so the borders align with the USER background block's top and bottom edges.
- Both horizontal border rows SHALL use the current value of `userMessageBorderColor` through the current Pi Theme. The ` user ` title SHALL retain its existing accent styling.

USER background, content, Markdown rendering and native bypass behavior SHALL otherwise remain unchanged. Changing only `userMessageBorderColor` SHALL invalidate any cached final USER output even when message content, width and Theme object identity are unchanged. Theme changes SHALL continue to recolor the border without reload.

## Preset behavior

All built-in display presets SHALL use the same default decoration values. Applying or resetting a preset SHALL produce those default decoration values, and preset detection SHALL account for all four decoration fields consistently with the existing complete-config preset model.

## Non-interference

These decorations SHALL affect TUI presentation only. They SHALL NOT:

- register, activate, deactivate, replace or reorder tools;
- modify ToolDefinition identity or fields;
- wrap or alter tool execution;
- modify arguments, updates, results, errors or event order;
- modify model-visible context, messages or session serialization;
- read workspace files for presentation;
- add Pi-private Host Adapter coupling beyond the minimum final tool-row presentation seam required to decorate every tool.

Unsupported host shapes and renderer failures SHALL retain Pi native presentation under the existing native fallback policy.

## Compatibility

Colors SHALL be expressed only as the six supported Pi Theme tokens. Direct Hex, RGB, ANSI, arbitrary Theme token and terminal-specific color configuration are out of scope.

The implementation SHALL rely on Pi/TUI visible-width behavior and SHALL NOT introduce terminal-brand detection. If the initially selected dashed glyph fails width qualification on supported terminals, the implementation MAY use ASCII `-` as the dashed glyph without expanding the public configuration interface.
