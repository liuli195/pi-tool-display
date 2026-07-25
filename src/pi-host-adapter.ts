import type { ToolDisplayResolver } from "./tool-display-resolver.js";
import type { DisplayColorToken } from "./types.js";

type RendererSelector = (this: ToolRowHost, ...args: any[]) => ((...args: any[]) => any) | undefined;
type RowRenderer = (this: ToolRowHost, width: number) => string[];
interface ToolRowHost {
  toolName?: string;
  invalidate?: () => void;
  args?: Record<string, unknown>;
  result?: unknown;
  toolDefinition?: Record<string, unknown>;
  builtInToolDefinition?: Record<string, unknown>;
}
interface ToolSeparatorTheme { fg(color: string, text: string): string }
interface ToolSeparatorConfig {
  enableToolSeparator: boolean;
  toolSeparatorStyle: "dashed" | "solid";
  toolSeparatorColor: DisplayColorToken;
}
interface Installation {
  call: PropertyDescriptor;
  result: PropertyDescriptor;
  render: PropertyDescriptor;
  resolver: ToolDisplayResolver;
  getSeparatorConfig: () => ToolSeparatorConfig;
  getTheme: () => ToolSeparatorTheme | undefined;
  patchedCall: RendererSelector;
  patchedResult: RendererSelector;
  patchedRender: RowRenderer;
  active: boolean;
  rows: Set<ToolRowHost>;
  owner: object;
}
const STATE = Symbol.for("pi-tool-display.piHostAdapter.v1");
type HostPrototype = ToolRowHost & { getCallRenderer?: RendererSelector; getResultRenderer?: RendererSelector; render?: RowRenderer; [STATE]?: Installation };
export interface PiHostAdapterInstallation { readonly installed: boolean; dispose(): void }

const supportedVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 0 || minor > 81 || (minor === 81 && patch >= 1);
};
const noopInstallation = (): PiHostAdapterInstallation => ({ installed: false, dispose() {} });

export function installPiHostAdapter(
  host: object,
  resolver: ToolDisplayResolver,
  piVersion: string,
  diagnose: (message: string) => void = () => {},
  getSeparatorConfig: () => ToolSeparatorConfig = () => ({ enableToolSeparator: false, toolSeparatorStyle: "dashed", toolSeparatorColor: "borderMuted" }),
  getTheme: () => ToolSeparatorTheme | undefined = () => undefined,
): PiHostAdapterInstallation {
  try {
    const installation = install(host as HostPrototype, resolver, piVersion, getSeparatorConfig, getTheme);
    if (!installation.installed) diagnose(`pi-tool-display: unsupported Pi ${piVersion} tool-row renderer shape; using native rendering`);
    return installation;
  } catch {
    diagnose(`pi-tool-display: unsupported Pi ${piVersion} tool-row renderer shape; using native rendering`);
    return noopInstallation();
  }
}

function install(
  prototype: HostPrototype,
  resolver: ToolDisplayResolver,
  piVersion: string,
  getSeparatorConfig: () => ToolSeparatorConfig,
  getTheme: () => ToolSeparatorTheme | undefined,
): PiHostAdapterInstallation {
  const existing = ownState(prototype);
  if (existing && ownValue(prototype, "getCallRenderer") === existing.patchedCall && ownValue(prototype, "getResultRenderer") === existing.patchedResult && ownValue(prototype, "render") === existing.patchedRender) {
    const owner = {};
    existing.resolver = resolver;
    existing.getSeparatorConfig = getSeparatorConfig;
    existing.getTheme = getTheme;
    existing.owner = owner;
    return { installed: true, dispose: () => dispose(prototype, existing, owner) };
  }
  const call = Object.getOwnPropertyDescriptor(prototype, "getCallRenderer");
  const result = Object.getOwnPropertyDescriptor(prototype, "getResultRenderer");
  const render = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!supportedVersion(piVersion) || !Object.isExtensible(prototype) || !call || !result || !render || !("value" in call) || !("value" in result) || !("value" in render) ||
      typeof call.value !== "function" || typeof result.value !== "function" || typeof render.value !== "function" ||
      !call.configurable || !result.configurable || !render.configurable || !call.writable || !result.writable || !render.writable || existing) return noopInstallation();

  const originalCall = call.value as RendererSelector;
  const originalResult = result.value as RendererSelector;
  const originalRender = render.value as RowRenderer;
  const row = (instance: ToolRowHost) => ({
    toolName: String(instance.toolDefinition?.name ?? instance.builtInToolDefinition?.name ?? instance.toolName ?? ""),
    arguments: instance.args ?? {},
    label: typeof instance.toolDefinition?.label === "string" ? instance.toolDefinition.label : undefined,
    builtIn: instance.builtInToolDefinition?.name === (instance.toolDefinition?.name ?? instance.toolName),
  });
  const owner = {};
  const state = { call, result, render, resolver, getSeparatorConfig, getTheme, active: true, rows: new Set<ToolRowHost>(), owner } as Installation;
  const patchedCall: RendererSelector = function (...args: any[]) {
    const native = originalCall.apply(this, args);
    if (!state.active) return native;
    state.rows.add(this);
    return state.resolver.resolve(row(this), { call: native }).call;
  };
  const patchedResult: RendererSelector = function (...args: any[]) {
    const native = originalResult.apply(this, args);
    if (!state.active) return native;
    state.rows.add(this);
    return state.resolver.resolve(row(this), { result: native }).result;
  };
  const patchedRender: RowRenderer = function (width: number) {
    const lines = originalRender.call(this, width);
    if (!state.active) return lines;
    try {
      const config = state.getSeparatorConfig();
      if (!config.enableToolSeparator) return lines;
      const safeWidth = Math.max(0, Math.floor(width));
      if (safeWidth === 0) return lines;
      const separator = (config.toolSeparatorStyle === "solid" ? "─" : "╌").repeat(safeWidth);
      const theme = state.getTheme();
      return theme ? [...lines, theme.fg(config.toolSeparatorColor, separator)] : lines;
    } catch {
      return lines;
    }
  };
  state.patchedCall = patchedCall;
  state.patchedResult = patchedResult;
  state.patchedRender = patchedRender;

  try {
    Object.defineProperty(prototype, STATE, { value: state, configurable: true });
    Object.defineProperty(prototype, "getCallRenderer", { ...call, value: patchedCall });
    Object.defineProperty(prototype, "getResultRenderer", { ...result, value: patchedResult });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
  } catch {
    rollback(prototype, state);
    return { installed: false, dispose: () => dispose(prototype, state, owner) };
  }
  return { installed: true, dispose: () => dispose(prototype, state, owner) };
}

function ownState(prototype: HostPrototype): Installation | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, STATE);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownValue(prototype: HostPrototype, key: "getCallRenderer" | "getResultRenderer" | "render"): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function rollback(prototype: HostPrototype, state: Installation): void {
  try {
    if (ownValue(prototype, "render") === state.patchedRender) Object.defineProperty(prototype, "render", state.render);
  } catch {}
  try {
    if (ownValue(prototype, "getResultRenderer") === state.patchedResult) Object.defineProperty(prototype, "getResultRenderer", state.result);
  } catch {}
  try {
    if (ownValue(prototype, "getCallRenderer") === state.patchedCall) Object.defineProperty(prototype, "getCallRenderer", state.call);
  } catch {}
  if (ownValue(prototype, "getCallRenderer") === state.patchedCall || ownValue(prototype, "getResultRenderer") === state.patchedResult || ownValue(prototype, "render") === state.patchedRender) return;
  try { if (ownState(prototype) === state) delete prototype[STATE]; } catch {}
}

function dispose(prototype: HostPrototype, state: Installation, owner: object): void {
  if (state.owner !== owner) return;
  state.active = false;
  state.rows.clear();
  rollback(prototype, state);
}

export function invalidatePiHostAdapterRows(host: object): void {
  const state = ownState(host as HostPrototype);
  if (!state?.active) return;
  for (const row of state.rows) row.invalidate?.();
}
