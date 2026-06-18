export interface SyncState {
  /** ms epoch of the last successful origin write, or null if none yet this process. */
  lastWriteOkAt: number | null;
  /** Error message of the most recent write, or null if it succeeded. */
  lastWriteError: string | null;
  /** Consecutive failed writes (reset to 0 on success). */
  consecutiveWriteFailures: number;
}

export interface SyncStatus extends SyncState {
  /** Seconds since the last successful write, or null if none yet this process. */
  lastWriteAgeSec: number | null;
  /** True when the last write attempt failed (token expired, GitHub down, …). */
  stale: boolean;
}

/**
 * Derive the reportable sync status from raw write-health state. Writes are
 * origin-first and synchronous, so there is no "ahead" notion anymore — a stall
 * is simply "the last write failed", surfaced via /healthz `sync.stale`.
 */
export function evaluateSync(state: SyncState, now: number): SyncStatus {
  const lastWriteAgeSec =
    state.lastWriteOkAt === null ? null : Math.max(0, Math.round((now - state.lastWriteOkAt) / 1000));
  const stale = state.lastWriteError !== null;
  return { ...state, lastWriteAgeSec, stale };
}
