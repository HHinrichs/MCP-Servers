import { describe, expect, test } from "vitest";
import { evaluateSync, type SyncState } from "../src/lib/sync_status.js";

const base: SyncState = {
  lastPushOkAt: null,
  lastPushError: null,
  lastPushAttemptAt: null,
  consecutivePushFailures: 0,
  ahead: 0,
  pendingMessages: 0,
};

describe("evaluateSync", () => {
  test("stale when commits are unpushed AND the last push failed", () => {
    const s = evaluateSync(
      { ...base, ahead: 3, lastPushError: "non-fast-forward", consecutivePushFailures: 2 },
      1000,
    );
    expect(s.stale).toBe(true);
  });

  test("not stale when everything is pushed (ahead 0)", () => {
    const s = evaluateSync({ ...base, ahead: 0, lastPushError: "stale error" }, 1000);
    expect(s.stale).toBe(false);
  });

  test("not stale when commits are ahead but the last push succeeded (normal debounce window)", () => {
    const s = evaluateSync({ ...base, ahead: 2, lastPushError: null }, 1000);
    expect(s.stale).toBe(false);
  });

  test("lastPushAgeSec is seconds since the last successful push", () => {
    const s = evaluateSync({ ...base, lastPushOkAt: 10_000 }, 25_000);
    expect(s.lastPushAgeSec).toBe(15);
  });

  test("lastPushAgeSec is null when there has never been a successful push", () => {
    const s = evaluateSync({ ...base, lastPushOkAt: null }, 25_000);
    expect(s.lastPushAgeSec).toBeNull();
  });
});
