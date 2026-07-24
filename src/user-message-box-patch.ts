export type UserMessageRenderFn = (width: number) => string[];

const USER_MESSAGE_PATCH_OWNER = {};

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
}

export function unregisterUserMessageRenderPrototypePatch(
  prototype: PatchableUserMessagePrototype,
): void {
  if (prototype.__piUserMessagePatchOwner !== USER_MESSAGE_PATCH_OWNER) return;
  const installedRender = prototype.__piUserMessageInstalledRender;
  const state = prototype.__piUserMessagePatchState;
  if (state) state.active = false;
  if (prototype.render === installedRender) {
    if (prototype.__piUserMessageOriginalRenderWasOwn && prototype.__piUserMessageOriginalRenderDescriptor) {
      Object.defineProperty(prototype, "render", prototype.__piUserMessageOriginalRenderDescriptor);
    } else {
      delete (prototype as Partial<PatchableUserMessagePrototype>).render;
    }
  }

  delete prototype.__piUserMessageOriginalRender;
  delete prototype.__piUserMessageOriginalRenderDescriptor;
  delete prototype.__piUserMessageOriginalRenderWasOwn;
  delete prototype.__piUserMessageNativePatched;
  delete prototype.__piUserMessagePatchVersion;
  delete prototype.__piUserMessagePatchOwner;
  delete prototype.__piUserMessageInstalledRender;
  delete prototype.__piUserMessagePatchState;
}

export function patchUserMessageRenderPrototype(
  prototype: PatchableUserMessagePrototype,
  patchVersion: number,
  buildRender: (originalRender: UserMessageRenderFn) => UserMessageRenderFn,
): void {
  if (typeof prototype.render !== "function") {
    return;
  }

  const previousOriginalRender = prototype.__piUserMessageOriginalRender;
  const hasPreviousPatch = typeof previousOriginalRender === "function"
    && previousOriginalRender !== prototype.render;
  const isCurrentPatch = prototype.__piUserMessagePatchOwner === USER_MESSAGE_PATCH_OWNER;
  let restoredStalePatch = false;

  if (hasPreviousPatch && !isCurrentPatch) {
    if (prototype.__piUserMessagePatchState) prototype.__piUserMessagePatchState.active = false;
    prototype.render = previousOriginalRender;
    delete prototype.__piUserMessageOriginalRender;
    delete prototype.__piUserMessageOriginalRenderDescriptor;
    delete prototype.__piUserMessageOriginalRenderWasOwn;
    delete prototype.__piUserMessageNativePatched;
    delete prototype.__piUserMessagePatchVersion;
    delete prototype.__piUserMessagePatchOwner;
    delete prototype.__piUserMessageInstalledRender;
    delete prototype.__piUserMessagePatchState;
    restoredStalePatch = true;
  }

  if (
    !restoredStalePatch
    && prototype.__piUserMessageNativePatched
    && prototype.__piUserMessagePatchVersion === patchVersion
    && typeof prototype.__piUserMessageOriginalRender === "function"
  ) {
    return;
  }

  if (!prototype.__piUserMessageOriginalRender) {
    prototype.__piUserMessageOriginalRender = prototype.render;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
    prototype.__piUserMessageOriginalRenderWasOwn = !!descriptor;
    prototype.__piUserMessageOriginalRenderDescriptor = descriptor;
  }

  const originalRender = prototype.__piUserMessageOriginalRender;
  if (!originalRender) return;

  const patchedRender = buildRender(originalRender);
  const state = { active: true };
  prototype.render = function (this: unknown, width: number): string[] {
    return (state.active ? patchedRender : originalRender).call(this, width);
  };
  prototype.__piUserMessageInstalledRender = prototype.render;
  prototype.__piUserMessagePatchState = state;
  prototype.__piUserMessageNativePatched = true;
  prototype.__piUserMessagePatchVersion = patchVersion;
  prototype.__piUserMessagePatchOwner = USER_MESSAGE_PATCH_OWNER;
}
