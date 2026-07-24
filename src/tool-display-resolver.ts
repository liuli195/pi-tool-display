import { Text } from "@earendil-works/pi-tui";
import type { ToolDisplayConfig } from "./types.js";
import { RendererAdapterConflict, type DisplayPlan, type NativeRendererSlots, type RendererCatalog, type ToolRenderer, type ToolRowDescriptor } from "./renderer-catalog.js";

export interface ToolDisplayResolver {
  resolve(row: ToolRowDescriptor, native: NativeRendererSlots): DisplayPlan;
}

export type ToolDisplayDiagnostic =
  | { readonly kind: "adapter-conflict"; readonly toolName: string; readonly adapters: readonly { id: string; kind: "generic" | "mcp" }[]; readonly error: unknown }
  | { readonly kind: "renderer-failure"; readonly toolName: string; readonly slot: "call" | "result"; readonly error: unknown }
  | { readonly kind: "resolver-failure"; readonly toolName: string; readonly error: unknown };
export type ToolDisplayDiagnosticSink = (diagnostic: ToolDisplayDiagnostic) => void;

function failOpen(custom: ToolRenderer | undefined, native: ToolRenderer | undefined, diagnose: (error: unknown) => void): ToolRenderer | undefined {
  if (!custom || custom === native) return custom ?? native;
  return function (this: unknown, ...args: any[]) {
    const owner = this;
    const fallback = () => native?.apply(owner, args) ?? new Text("Tool display unavailable.", 0, 0);
    let failed = false;
    let rendered: any;
    try { rendered = custom.apply(owner, args); }
    catch (error) { diagnose(error); return fallback(); }
    if (!rendered || typeof rendered.render !== "function") return rendered;
    return {
      render(width: number) {
        if (failed) return fallback().render(width);
        try { return rendered.render(width); }
        catch (error) { failed = true; diagnose(error); return fallback().render(width); }
      },
      invalidate() {
        if (failed) return;
        try { rendered.invalidate?.(); }
        catch (error) { failed = true; diagnose(error); }
      },
    };
  };
}

export function createToolDisplayResolver(
  getConfig: () => Readonly<ToolDisplayConfig>,
  catalog: RendererCatalog,
  onDiagnostic: ToolDisplayDiagnosticSink = () => {},
): ToolDisplayResolver {
  const diagnosed = new Set<string>();
  let source: Readonly<ToolDisplayConfig> | undefined;
  let snapshot: Readonly<ToolDisplayConfig> | undefined;
  const diagnose = (key: string, diagnostic: ToolDisplayDiagnostic) => {
    if (!diagnosed.has(key)) { diagnosed.add(key); onDiagnostic(diagnostic); }
  };
  return {
    resolve(row, native) {
      try {
        const config = getConfig();
        if (config !== source) {
          source = config;
          snapshot = Object.freeze({
            ...config,
            builtInToolDisplays: Object.freeze({ ...config.builtInToolDisplays }),
            customToolOverrides: Object.freeze(Object.fromEntries(Object.entries(config.customToolOverrides).map(([name, override]) => [name, Object.freeze({ ...override })]))),
          });
        }
        const selected = catalog.resolve(Object.freeze({ ...row, arguments: Object.freeze({ ...row.arguments }) }), snapshot!, native);
        if (!selected) return native;
        return {
          ...selected,
          call: failOpen(selected.call, native.call, error => diagnose(`renderer:${row.toolName}:call`, { kind: "renderer-failure", toolName: row.toolName, slot: "call", error })),
          result: failOpen(selected.result, native.result, error => diagnose(`renderer:${row.toolName}:result`, { kind: "renderer-failure", toolName: row.toolName, slot: "result", error })),
        };
      } catch (error) {
        const diagnostic: ToolDisplayDiagnostic = error instanceof RendererAdapterConflict
          ? { kind: "adapter-conflict", toolName: error.toolName, adapters: error.adapters, error }
          : { kind: "resolver-failure", toolName: row.toolName, error };
        diagnose(`${diagnostic.kind}:${row.toolName}`, diagnostic);
        return native;
      }
    },
  };
}
