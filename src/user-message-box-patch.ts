export type UserMessageRenderFn = (width: number) => string[];

const USER_MESSAGE_PATCH_OWNERS = new WeakSet<object>();

export interface PatchableUserMessagePrototype {
  render: UserMessageRenderFn;
  __piUserMessageOriginalRender?: UserMessageRenderFn;
  __piUserMessageOriginalRenderDescriptor?: PropertyDescriptor;
  __piUserMessageOriginalRenderWasOwn?: boolean;
  __piUserMessageNativePatched?: boolean;
  __piUserMessagePatchVersion?: number;
  __piUserMessagePatchOwner?: object;
  __piUserMessageInstalledRender?: UserMessageRenderFn;
  __piUserMessagePatchState?: { active: boolean };
  __piUserMessagePatchDispose?: () => void;
}

function clearPatchMetadata(prototype: PatchableUserMessagePrototype): void {
  delete prototype.__piUserMessageOriginalRender;
  delete prototype.__piUserMessageOriginalRenderDescriptor;
  delete prototype.__piUserMessageOriginalRenderWasOwn;
  delete prototype.__piUserMessageNativePatched;
  delete prototype.__piUserMessagePatchVersion;
  delete prototype.__piUserMessagePatchOwner;
  delete prototype.__piUserMessageInstalledRender;
  delete prototype.__piUserMessagePatchState;
  delete prototype.__piUserMessagePatchDispose;
}

export function unregisterUserMessageRenderPrototypePatch(
  prototype: PatchableUserMessagePrototype,
): void {
  if (prototype.__piUserMessagePatchDispose) {
    prototype.__piUserMessagePatchDispose();
    return;
  }
  const owner = prototype.__piUserMessagePatchOwner;
  if (owner && !USER_MESSAGE_PATCH_OWNERS.has(owner)) return;
  const installedRender = prototype.__piUserMessageInstalledRender;
  if (prototype.__piUserMessagePatchState) prototype.__piUserMessagePatchState.active = false;
  if (prototype.render === installedRender) {
    if (prototype.__piUserMessageOriginalRenderWasOwn && prototype.__piUserMessageOriginalRenderDescriptor) {
      Object.defineProperty(prototype, "render", prototype.__piUserMessageOriginalRenderDescriptor);
    } else {
      delete (prototype as Partial<PatchableUserMessagePrototype>).render;
    }
  }
  clearPatchMetadata(prototype);
}

export function patchUserMessageRenderPrototype(
  prototype: PatchableUserMessagePrototype,
  patchVersion: number,
  buildRender: (originalRender: UserMessageRenderFn) => UserMessageRenderFn,
): () => void {
  if (typeof prototype.render !== "function") return () => {};

  const currentOwner = prototype.__piUserMessagePatchOwner;
  if (
    !currentOwner
    && prototype.__piUserMessageNativePatched
    && prototype.__piUserMessagePatchVersion === patchVersion
    && prototype.__piUserMessageOriginalRender
  ) return () => {};
  if (currentOwner && USER_MESSAGE_PATCH_OWNERS.has(currentOwner) && prototype.__piUserMessagePatchDispose) {
    prototype.__piUserMessagePatchDispose();
  }

  const previousOriginalRender = prototype.__piUserMessageOriginalRender;
  if (typeof previousOriginalRender === "function" && previousOriginalRender !== prototype.render) {
    if (prototype.__piUserMessagePatchState) prototype.__piUserMessagePatchState.active = false;
    prototype.render = previousOriginalRender;
    clearPatchMetadata(prototype);
  }

  const originalRender = prototype.render;
  const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  const originalWasOwn = !!originalDescriptor;
  const owner = {};
  USER_MESSAGE_PATCH_OWNERS.add(owner);
  const state = { active: true };
  const patchedRender = buildRender(originalRender);
  const installedRender: UserMessageRenderFn = function (this: unknown, width: number): string[] {
    return (state.active ? patchedRender : originalRender).call(this, width);
  };
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    state.active = false;
    if (prototype.__piUserMessagePatchOwner !== owner) return;
    if (prototype.render === installedRender) {
      if (originalWasOwn && originalDescriptor) Object.defineProperty(prototype, "render", originalDescriptor);
      else delete (prototype as Partial<PatchableUserMessagePrototype>).render;
    }
    clearPatchMetadata(prototype);
  };

  prototype.render = installedRender;
  prototype.__piUserMessageOriginalRender = originalRender;
  prototype.__piUserMessageOriginalRenderDescriptor = originalDescriptor;
  prototype.__piUserMessageOriginalRenderWasOwn = originalWasOwn;
  prototype.__piUserMessageInstalledRender = installedRender;
  prototype.__piUserMessagePatchState = state;
  prototype.__piUserMessageNativePatched = true;
  prototype.__piUserMessagePatchVersion = patchVersion;
  prototype.__piUserMessagePatchOwner = owner;
  prototype.__piUserMessagePatchDispose = dispose;
  return dispose;
}
