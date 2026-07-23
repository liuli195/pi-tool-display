import type { ToolDisplayConfig } from "./types.js";
import type { DisplayPlan, NativeRendererSlots, RendererCatalog, ToolRenderer, ToolRowDescriptor } from "./renderer-catalog.js";

export interface ToolDisplayResolver {
  resolve(row: ToolRowDescriptor, native: NativeRendererSlots): DisplayPlan;
}

function failOpen(custom: ToolRenderer | undefined, native: ToolRenderer | undefined): ToolRenderer | undefined {
  if (!custom || custom === native || !native) return custom ?? native;
  return (...args: any[]) => {
    try { return custom(...args); }
    catch { return native(...args); }
  };
}

export function createToolDisplayResolver(
  getConfig: () => Readonly<ToolDisplayConfig>,
  catalog: RendererCatalog,
): ToolDisplayResolver {
  return {
    resolve(row, native) {
      try {
        const config = getConfig();
        const snapshot = Object.freeze({
          ...config,
          registerToolOverrides: Object.freeze({ ...config.registerToolOverrides }),
          customToolOverrides: Object.freeze({ ...config.customToolOverrides }),
        });
        const selected = catalog.resolve(Object.freeze({ ...row, arguments: Object.freeze({ ...row.arguments }) }), snapshot, native);
        if (!selected) return native;
        return { ...selected, call: failOpen(selected.call, native.call), result: failOpen(selected.result, native.result) };
      } catch {
        return native;
      }
    },
  };
}
