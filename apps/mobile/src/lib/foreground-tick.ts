/**
 * One tick of useSync's 60 s foreground timer (L18a). Sync runs every tick
 * (syncNow skips itself offline). The workspace is retried only when the
 * phone is online: a retry publishes loading before it fails again offline,
 * so an offline screen showing Try again (the rental detail) flickered to a
 * spinner every minute. Coming back online still retries at once (useSync's
 * network listener), and a tapped Try again still shows loading.
 *
 * Dependencies injected, so vitest drives it without the native modules.
 */
export async function foregroundTick(deps: {
  syncNow: () => Promise<unknown>;
  retryWorkspace: () => Promise<unknown>;
  isOnline: () => Promise<boolean>;
}): Promise<void> {
  void deps.syncNow();
  if (await deps.isOnline()) await deps.retryWorkspace();
}
