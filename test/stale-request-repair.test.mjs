import assert from "node:assert/strict";
import test from "node:test";

import {
  repairStaleWethink,
  staleWethinkCandidates,
} from "../src/stale-request-repair.mjs";

const NOW = 10_000_000;

function entry(overrides = {}) {
  return {
    requestId: overrides.requestId || "r-1",
    startedAt: overrides.startedAt ?? NOW - 10 * 60_000,
    provider: "wethink",
    model: "wethink/deepseek-v4.1-flash",
    threadId: "thread-1",
    sessionId: "session-1",
    isCompaction: false,
    clientGone: false,
    ...overrides,
  };
}

test("repair candidates include departed, superseded, or timed-out compactions", () => {
  const candidates = staleWethinkCandidates([
    entry({ requestId: "active", clientGone: false }),
    entry({ requestId: "departed", clientGone: true, threadId: "thread-2" }),
    entry({ requestId: "compaction", isCompaction: true, threadId: "thread-3" }),
    entry({ requestId: "newer", startedAt: NOW - 60_000, threadId: "thread-3" }),
    entry({ requestId: "timed-out-compaction", isCompaction: true, threadId: "thread-4" }),
    entry({ requestId: "other-provider", provider: "openai", clientGone: true }),
  ], { now: NOW, maxAgeMs: 5 * 60_000 });

  assert.deepEqual(
    candidates.map(({ summary, reason }) => [summary.requestId, reason]),
    [
      ["departed", "client_disconnected"],
      ["compaction", "superseded_compaction"],
      ["timed-out-compaction", "compaction_timeout"],
    ],
  );
});

test("parallel subagent threads are not collapsed by the root session", () => {
  const candidates = staleWethinkCandidates([
    entry({ requestId: "agent-a", threadId: "agent-a", sessionId: "root", isCompaction: true, startedAt: NOW - 60_000 }),
    entry({ requestId: "agent-b", threadId: "agent-b", sessionId: "root", isCompaction: false }),
  ], { now: NOW, maxAgeMs: 5 * 60_000 });
  assert.equal(candidates.length, 0);
});

test("repair client is dry-run by default and forwards apply explicitly", async () => {
  const requests = [];
  const response = await repairStaleWethink({
    routerPort: 43210,
    readCallerSecret: () => "caller-secret-012345678901234567890123",
    readInternalSecret: () => "internal-secret-012345678901234567890123",
    fetchImpl: async (url, options) => {
      requests.push({ url, options, payload: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, mode: "dry-run" }) };
    },
  });

  assert.equal(response.ok, true);
  assert.equal(requests[0].url, "http://127.0.0.1:43210/_codex-router/caller-secret-012345678901234567890123/v1/admin/repair/wethink");
  assert.equal(requests[0].payload.apply, false);
  assert.equal(requests[0].options.headers["X-Codex-Router-Internal-Key"], "internal-secret-012345678901234567890123");

  await repairStaleWethink({
    routerPort: 43210,
    readCallerSecret: () => "caller-secret-012345678901234567890123",
    readInternalSecret: () => "internal-secret-012345678901234567890123",
    apply: true,
    fetchImpl: async (_url, options) => {
      requests.push({ payload: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, mode: "apply" }) };
    },
  });
  assert.equal(requests.at(-1).payload.apply, true);
});
