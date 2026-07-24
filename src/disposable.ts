// Track cleanup callbacks for reload safety
let cleanupCallbacks: Array<() => void> = [];
const sessionCleanupCallbacks = new Set<() => void>();
let isDisposed = false;

export function registerCleanup(callback: () => void): void {
  if (isDisposed) {
    callback();
    return;
  }
  cleanupCallbacks.push(callback);
}

export function registerTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  registerCleanup(() => clearInterval(timer as ReturnType<typeof setInterval>));
}

export function registerSessionCleanup(callback: () => void): () => void {
  sessionCleanupCallbacks.add(callback);
  return () => sessionCleanupCallbacks.delete(callback);
}

export function disposeSession(): void {
  const callbacks = [...sessionCleanupCallbacks];
  sessionCleanupCallbacks.clear();
  for (let i = callbacks.length - 1; i >= 0; i--) {
    try { callbacks[i](); } catch (cleanupError) { void cleanupError; }
  }
}

export function disposeAll(): void {
  disposeSession();
  if (isDisposed) return;
  isDisposed = true;
  // Run in reverse order (LIFO)
  for (let i = cleanupCallbacks.length - 1; i >= 0; i--) {
    try { cleanupCallbacks[i](); } catch (cleanupError) { void cleanupError; }
  }
  cleanupCallbacks = [];
}

export function resetDisposed(): void {
  disposeAll();
  isDisposed = false;
}
