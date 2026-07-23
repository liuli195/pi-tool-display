export type RuntimeToolDefinition = Record<string, unknown> & { name?: string };
export type ToolRenderer = (...args: any[]) => any;

export interface RendererAdapter {
  id: string;
  toolName: string;
  kind: "generic" | "mcp";
  outputMode?: "hidden" | "summary" | "preview";
  overrideCallRenderer?: boolean;
  renderCall?: ToolRenderer;
  renderResult?: ToolRenderer;
}
export interface ToolDisplayAdapter {
  id?: string;
  kind?: "read" | "edit" | "mcp" | "generic";
  overrideExistingRenderers?: boolean;
  renderCall?: ToolRenderer;
  renderResult?: ToolRenderer;
}
export interface ToolDisplayApi {
  version: 1;
  registerAdapter(adapter: RendererAdapter): () => void;
  /** @deprecated Use registerAdapter. Returns the exact original tool unchanged. */
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
}
export interface DecorateToolForDisplayOptions { suppressDecorateErrors?: boolean }
export declare function getToolDisplayApi(): ToolDisplayApi | undefined;
export declare function registerRendererAdapter(adapter: RendererAdapter): () => void;
/** @deprecated Use registerRendererAdapter. */
export declare function queueToolDisplayDecoration<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): void;
/** @deprecated Use registerRendererAdapter. Returns the exact original tool unchanged. */
export declare function decorateToolForDisplay<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter, options?: DecorateToolForDisplayOptions): T;
/** @deprecated Use registerRendererAdapter. Returns the exact original tool unchanged. */
export declare function decorateMcpToolForDisplay<T extends RuntimeToolDefinition>(tool: T): T;
