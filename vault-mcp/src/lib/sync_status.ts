export interface SyncState {
  /** ms epoch of the last successful push, or null if none yet this process. */
  lastPushOkAt: number | null;
  /** Error message of the most recent push attempt, or null if it succeeded. */
  lastPushError: string | null;
  /** ms epoch of the most recent push attempt (success or failure). */
  lastPushAttemptAt: number | null;
  /** Consecutive failed push attempts (reset to 0 on success). */
  consecutivePushFailures: number;
  /** Local commits not yet on origin/main. */
  ahead: number;
  /** Write messages queued but not yet committed. */
  pendingMessages: number;
}

export interface SyncStatus extends SyncState {
  /** Seconds since the last successful push, or null if none yet this process. */
  lastPushAgeSec: number | null;
  /** True when there are unpushed commits AND the last push attempt failed. */
  stale: boolean;
}

/**
 * Derive the reportable sync status from raw push-tracking state.
 *
 * `stale` is intentionally narrow: being a few commits ahead is normal (the
 * push debounce window). It only counts as a stall when there is something to
 * push AND the last push attempt actually failed — that is the silent-wedge
 * signal that went unnoticed for days in the 2026-06-13 incident.
 */
export function evaluateSync(state: SyncState, now: number): SyncStatus {
  const lastPushAgeSec =
    state.lastPushOkAt === null
      ? null
      : Math.max(0, Math.round((now - state.lastPushOkAt) / 1000));
  const stale = state.ahead > 0 && state.lastPushError !== null;
  return { ...state, lastPushAgeSec, stale };
}
