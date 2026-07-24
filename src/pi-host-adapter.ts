import type { ToolDisplayResolver } from "./tool-display-resolver.js";

type RendererSelector = (this: ToolRowHost, ...args: any[]) => ((...args: any[]) => any) | undefined;
interface ToolRowHost {
  toolName?: string;
  args?: Record<string, unknown>;
  toolDefinition?: Record<string, unknown>;
  builtInToolDefinition?: Record<string, unknown>;
}
interface Installation {
  call: PropertyDescriptor;
  result: PropertyDescriptor;
  patchedCall: RendererSelector;
  patchedResult: RendererSelector;
}
const STATE = Symbol.for("pi-tool-display.piHostAdapter.v1");
type HostPrototype = ToolRowHost & { getCallRenderer?: RendererSelector; getResultRenderer?: RendererSelector; [STATE]?: Installation };
export interface PiHostAdapterInstallation { readonly installed: boolean; dispose(): void }

const supportedVersion = (version: string) => /^0\.(?:74|75|77|78|79|80|81)\./.test(version);
const noopInstallation = (): PiHostAdapterInstallation => ({ installed: false, dispose() {} });

export function installPiHostAdapter(
  host: object,
  resolver: ToolDisplayResolver,
  piVersion: string,
  diagnose: (message: string) => void = () => {},
): PiHostAdapterInstallation {
  try {
    const installation = install(host as HostPrototype, resolver, piVersion);
    if (!installation.installed) diagnose(`pi-tool-display: unsupported Pi ${piVersion} tool-row renderer shape; using native rendering`);
    return installation;
  } catch {
    diagnose(`pi-tool-display: unsupported Pi ${piVersion} tool-row renderer shape; using native rendering`);
    return noopInstallation();
  }
}

function install(prototype: HostPrototype, resolver: ToolDisplayResolver, piVersion: string): PiHostAdapterInstallation {
  const existing = ownState(prototype);
  if (existing && ownValue(prototype, "getCallRenderer") === existing.patchedCall && ownValue(prototype, "getResultRenderer") === existing.patchedResult) {
    return { installed: true, dispose: () => dispose(prototype, existing) };
  }
  const call = Object.getOwnPropertyDescriptor(prototype, "getCallRenderer");
  const result = Object.getOwnPropertyDescriptor(prototype, "getResultRenderer");
  if (!supportedVersion(piVersion) || !Object.isExtensible(prototype) || !call || !result || !("value" in call) || !("value" in result) ||
      typeof call.value !== "function" || typeof result.value !== "function" || !call.configurable || !result.configurable ||
      !call.writable || !result.writable || existing) return noopInstallation();

  const originalCall = call.value as RendererSelector;
  const originalResult = result.value as RendererSelector;
  const row = (instance: ToolRowHost) => ({
    toolName: String(instance.toolDefinition?.name ?? instance.builtInToolDefinition?.name ?? instance.toolName ?? ""),
    arguments: instance.args ?? {},
    label: typeof instance.toolDefinition?.label === "string" ? instance.toolDefinition.label : undefined,
    builtIn: instance.builtInToolDefinition?.name === (instance.toolDefinition?.name ?? instance.toolName),
  });
  const patchedCall: RendererSelector = function (...args: any[]) {
    const native = originalCall.apply(this, args);
    return resolver.resolve(row(this), { call: native }).call;
  };
  const patchedResult: RendererSelector = function (...args: any[]) {
    const native = originalResult.apply(this, args);
    return resolver.resolve(row(this), { result: native }).result;
  };
  const state: Installation = { call, result, patchedCall, patchedResult };

  try {
    Object.defineProperty(prototype, STATE, { value: state, configurable: true });
    Object.defineProperty(prototype, "getCallRenderer", { ...call, value: patchedCall });
    Object.defineProperty(prototype, "getResultRenderer", { ...result, value: patchedResult });
  } catch {
    rollback(prototype, state);
    return { installed: false, dispose: () => dispose(prototype, state) };
  }
  return { installed: true, dispose: () => dispose(prototype, state) };
}

function ownState(prototype: HostPrototype): Installation | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, STATE);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownValue(prototype: HostPrototype, key: "getCallRenderer" | "getResultRenderer"): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function rollback(prototype: HostPrototype, state: Installation): void {
  try {
    if (ownValue(prototype, "getResultRenderer") === state.patchedResult) Object.defineProperty(prototype, "getResultRenderer", state.result);
  } catch {}
  try {
    if (ownValue(prototype, "getCallRenderer") === state.patchedCall) Object.defineProperty(prototype, "getCallRenderer", state.call);
  } catch {}
  if (ownValue(prototype, "getCallRenderer") === state.patchedCall || ownValue(prototype, "getResultRenderer") === state.patchedResult) return;
  try { if (ownState(prototype) === state) delete prototype[STATE]; } catch {}
}

function dispose(prototype: HostPrototype, state: Installation): void {
  rollback(prototype, state);
}
