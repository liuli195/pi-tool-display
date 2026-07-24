import {
  type ExtensionAPI,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  patchNativeUserMessagePrototype,
  type PatchableUserMessagePrototype,
  type UserMessageTheme,
} from "./user-message-box-renderer.js";
import { unregisterUserMessageRenderPrototypePatch } from "./user-message-box-patch.js";
import type { ToolDisplayConfig } from "./types.js";

function getUserMessagePrototype(): PatchableUserMessagePrototype {
  return UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
}

export default function registerNativeUserMessageBox(
  _pi: ExtensionAPI,
  getConfig: () => ToolDisplayConfig,
  theme: UserMessageTheme | undefined,
): () => void {
  const prototype = getUserMessagePrototype();
  patchNativeUserMessagePrototype(
    prototype,
    () => theme,
    () => getConfig().enableNativeUserMessageBox,
  );

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregisterUserMessageRenderPrototypePatch(prototype);
  };
}
