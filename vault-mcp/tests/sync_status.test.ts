import { describe, expect, test } from "vitest";
import { evaluateSync, type SyncState } from "../src/lib/sync_status.js";

const base: SyncState = { lastWriteOkAt: null, lastWriteError: null, consecutiveWriteFailures: 0 };

describe("evaluateSync (write-health)", () => {
  test("stale when the last write failed", () => {
    const s = evaluateSync({ ...base, lastWriteError: "boom", consecutiveWriteFailures: 2 }, 1000);
    expect(s.stale).toBe(true);
  });

  test("not stale when the last write succeeded", () => {
    const s = evaluateSync({ ...base, lastWriteOkAt: 500, lastWriteError: null }, 1000);
    expect(s.stale).toBe(false);
  });

  test("lastWriteAgeSec is seconds since the last ok write", () => {
    expect(evaluateSync({ ...base, lastWriteOkAt: 10_000 }, 25_000).lastWriteAgeSec).toBe(15);
  });

  test("lastWriteAgeSec is null when no write has succeeded yet", () => {
    expect(evaluateSync({ ...base, lastWriteOkAt: null }, 25_000).lastWriteAgeSec).toBeNull();
  });
});
