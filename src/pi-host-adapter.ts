import type { ToolDisplayResolver } from "./tool-display-resolver.js";

type RendererSelector = (this: ToolRowHost) => ((...args: any[]) => any) | undefined;
interface ToolRowHost {
  toolName?: string;
  args?: Record<string, unknown>;
  toolDefinition?: Record<string, unknown>;
  builtInToolDefinition?: Record<string, unknown>;
}
interface Installation {
  owner: object;
  call: PropertyDescriptor;
  result: PropertyDescriptor;
  patchedCall: RendererSelector;
  patchedResult: RendererSelector;
}
const STATE = Symbol.for("pi-tool-display.piHostAdapter.v1");
type HostPrototype = ToolRowHost & { getCallRenderer?: RendererSelector; getResultRenderer?: RendererSelector; [STATE]?: Installation };
export interface PiHostAdapterInstallation { readonly installed: boolean; dispose(): void }

const supportedVersion = (version: string) => /^0\.(?:74|75|77|78|79|80|81)\./.test(version);

export function installPiHostAdapter(host: object, resolver: ToolDisplayResolver, piVersion: string): PiHostAdapterInstallation {
  const prototype = host as HostPrototype;
  const existing = prototype[STATE];
  if (existing && prototype.getCallRenderer === existing.patchedCall && prototype.getResultRenderer === existing.patchedResult) {
    return { installed: true, dispose: () => dispose(prototype, existing) };
  }
  const call = Object.getOwnPropertyDescriptor(prototype, "getCallRenderer");
  const result = Object.getOwnPropertyDescriptor(prototype, "getResultRenderer");
  if (!supportedVersion(piVersion) || !call || !result || !("value" in call) || !("value" in result) ||
      typeof call.value !== "function" || typeof result.value !== "function" || !call.configurable || !result.configurable ||
      !call.writable || !result.writable || existing) return { installed: false, dispose() {} };

  const originalCall = call.value as RendererSelector;
  const originalResult = result.value as RendererSelector;
  const row = (instance: ToolRowHost) => ({
    toolName: String(instance.toolDefinition?.name ?? instance.builtInToolDefinition?.name ?? instance.toolName ?? ""),
    arguments: instance.args ?? {},
    label: typeof instance.toolDefinition?.label === "string" ? instance.toolDefinition.label : undefined,
    builtIn: instance.builtInToolDefinition?.name === (instance.toolDefinition?.name ?? instance.toolName),
  });
  const patchedCall: RendererSelector = function () {
    const native = originalCall.call(this);
    return resolver.resolve(row(this), { call: native }).call;
  };
  const patchedResult: RendererSelector = function () {
    const native = originalResult.call(this);
    return resolver.resolve(row(this), { result: native }).result;
  };
  const state: Installation = { owner: {}, call, result, patchedCall, patchedResult };
  Object.defineProperties(prototype, {
    getCallRenderer: { ...call, value: patchedCall },
    getResultRenderer: { ...result, value: patchedResult },
    [STATE]: { value: state, configurable: true },
  });
  return { installed: true, dispose: () => dispose(prototype, state) };
}

function dispose(prototype: HostPrototype, state: Installation): void {
  if (prototype.getCallRenderer === state.patchedCall) Object.defineProperty(prototype, "getCallRenderer", state.call);
  if (prototype.getResultRenderer === state.patchedResult) Object.defineProperty(prototype, "getResultRenderer", state.result);
  if (prototype[STATE] === state) delete prototype[STATE];
}
