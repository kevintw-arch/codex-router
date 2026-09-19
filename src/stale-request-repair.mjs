import { readFileSync } from "node:fs";

import { assertCallerSecret, callerBaseUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, INTERNAL_SECRET_PATH, PORTS } from "./paths.mjs";

// A repair must be conservative by default. A long-running response is not
// stale merely because it is old; the candidate rules below require either a
// departed client or a newer request for the same Codex thread.
export const DEFAULT_STALE_REPAIR_AGE_MS = 5 * 60_000;
export const DEFAULT_CLIENT_GONE_GRACE_MS = 15_000;
export const MAX_STALE_REPAIR_AGE_MS = 24 * 60 * 60_000;
export const MIN_STALE_REPAIR_AGE_MS = 30_000;

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function normalizeRepairOptions({
  now = Date.now(),
  maxAgeMs = DEFAULT_STALE_REPAIR_AGE_MS,
  clientGoneGraceMs = DEFAULT_CLIENT_GONE_GRACE_MS,
} = {}) {
  const age = Math.min(
    MAX_STALE_REPAIR_AGE_MS,
    Math.max(MIN_STALE_REPAIR_AGE_MS, finitePositive(maxAgeMs, DEFAULT_STALE_REPAIR_AGE_MS)),
  );
  const grace = Math.min(
    age,
    Math.max(1_000, finitePositive(clientGoneGraceMs, DEFAULT_CLIENT_GONE_GRACE_MS)),
  );
  return { now: finitePositive(now, Date.now()), maxAgeMs: age, clientGoneGraceMs: grace };
}

function threadKey(entry) {
  // Subagents share a root session but have distinct thread IDs. Prefer the
  // leaf thread so a compaction in one agent cannot cancel another agent's
  // active turn. Session ID is only the fallback for older clients that did
  // not send a thread header.
  const threadId = typeof entry?.threadId === "string" ? entry.threadId.trim() : "";
  if (threadId) return `thread:${threadId}`;
  const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId.trim() : "";
  if (sessionId) return `session:${sessionId}`;
  return undefined;
}

function entryAge(entry, now) {
  const startedAt = Number(entry?.startedAt);
  return Number.isFinite(startedAt) && startedAt > 0 ? Math.max(0, now - startedAt) : 0;
}

function safeLabel(value, fallback = undefined) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 160) : fallback;
}

export function summarizeRepairEntry(entry, { now = Date.now() } = {}) {
  const summary = {
    requestId: String(entry?.requestId ?? entry?.id ?? ""),
    ageMs: entryAge(entry, now),
    provider: safeLabel(entry?.provider, "unknown"),
    ...(safeLabel(entry?.model) ? { model: safeLabel(entry.model) } : {}),
    ...(safeLabel(entry?.sessionName) ? { sessionName: safeLabel(entry.sessionName) } : {}),
    ...(safeLabel(entry?.threadId) ? { threadId: safeLabel(entry.threadId) } : {}),
    ...(safeLabel(entry?.sessionId) ? { sessionId: safeLabel(entry.sessionId) } : {}),
    ...(entry?.isSubagent ? { isSubagent: true } : {}),
    ...(entry?.isCompaction ? { isCompaction: true } : {}),
    ...(entry?.clientGone ? { clientGone: true } : {}),
  };
  return summary;
}

/**
 * Return only requests that are safe candidates for the Wethink stale repair.
 *
 * This is deliberately pure so the safety boundary can be tested without
 * starting a live Router. The caller decides whether to abort the returned
 * entries (dry-run never does).
 */
export function staleWethinkCandidates(entries, options = {}) {
  const normalized = normalizeRepairOptions(options);
  const list = [...entries].filter(Boolean);
  const latestByThread = new Map();
  for (const entry of list) {
    if (entry.provider !== "wethink") continue;
    const key = threadKey(entry);
    if (!key) continue;
    const startedAt = Number(entry.startedAt) || 0;
    const current = latestByThread.get(key);
    if (!current || startedAt > current.startedAt) {
      latestByThread.set(key, { startedAt, requestId: entry.requestId ?? entry.id });
    }
  }

  return list
    .filter((entry) => entry.provider === "wethink")
    .map((entry) => {
      const ageMs = entryAge(entry, normalized.now);
      if (ageMs < normalized.maxAgeMs) return undefined;
      const key = threadKey(entry);
      const latest = key ? latestByThread.get(key) : undefined;
      const superseded = Boolean(
        entry.isCompaction &&
        latest &&
        String(latest.requestId) !== String(entry.requestId ?? entry.id) &&
        latest.startedAt > (Number(entry.startedAt) || 0),
      );
      const departed = Boolean(entry.clientGone && ageMs >= normalized.clientGoneGraceMs);
      // A compaction that remains connected can still be wedged forever: the
      // client waits for the compacted response, while the upstream slot never
      // returns. Treat the configured stale age as its hard upper bound so a
      // repair run can release that slot without requiring a second request on
      // the same thread.
      const timedOutCompaction = Boolean(entry.isCompaction && ageMs >= normalized.maxAgeMs);
      if (!departed && !superseded && !timedOutCompaction) return undefined;
      return {
        entry,
        reason: departed
          ? "client_disconnected"
          : superseded
            ? "superseded_compaction"
            : "compaction_timeout",
        summary: summarizeRepairEntry(entry, { now: normalized.now }),
      };
    })
    .filter(Boolean);
}

export async function repairStaleWethink({
  fetchImpl = globalThis.fetch,
  readCallerSecret = () => readFileSync(CALLER_SECRET_PATH, "utf8"),
  readInternalSecret = () => readFileSync(INTERNAL_SECRET_PATH, "utf8"),
  routerPort = PORTS.router,
  apply = false,
  maxAgeMs,
  clientGoneGraceMs,
  timeoutMs = 5_000,
} = {}) {
  let callerSecret;
  let internalSecret;
  try {
    callerSecret = assertCallerSecret(readCallerSecret().trim());
    internalSecret = assertCallerSecret(readInternalSecret().trim());
  } catch {
    return {
      ok: false,
      status: 0,
      error: "The local router repair credentials are unavailable.",
    };
  }

  let response;
  try {
    response = await fetchImpl(`${callerBaseUrl(routerPort, callerSecret)}/admin/repair/wethink`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Codex-Router-Internal-Key": internalSecret,
      },
      body: JSON.stringify({ apply: Boolean(apply), maxAgeMs, clientGoneGraceMs }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      error: timedOut ? "Router repair request timed out." : "Router repair endpoint is unreachable.",
    };
  }
  const raw = await response.json().catch(() => ({}));
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { ...body, ok: response.ok && body.ok !== false, status: response.status };
}
