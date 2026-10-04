import { performance } from "node:perf_hooks";

const STAGE_FIELDS = Object.freeze([
  "admissionWaitMs",
  "requestBuildMs",
  "upstreamHeadersWaitMs",
]);

// 僅接受已知階段的有限非負數值；未觀測的階段不補零。
export function sanitizeRequestStageTiming(value) {
  const timing = {};
  for (const field of STAGE_FIELDS) {
    const elapsed = value?.[field];
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      timing[field] = Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsed));
    }
  }
  return timing;
}

// 每個請求各建一個物件。同一階段重複量測會累計，包含失敗嘗試；
// operation 外的時間不計入，不保存請求、回傳值、錯誤內容或憑證。
export function createRequestStageTiming({ now = () => performance.now() } = {}) {
  const elapsed = Object.create(null);
  const readClock = () => {
    try {
      const value = now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      // 診斷故障不能改變原本操作的結果。
      return undefined;
    }
  };
  return {
    async measure(field, operation) {
      const known = STAGE_FIELDS.includes(field);
      const startedAt = known ? readClock() : undefined;
      try {
        return await operation();
      } finally {
        if (startedAt !== undefined) {
          const endedAt = readClock();
          if (endedAt !== undefined) {
            const duration = Math.max(0, endedAt - startedAt);
            elapsed[field] = Math.min(
              Number.MAX_SAFE_INTEGER,
              (elapsed[field] ?? 0) + duration,
            );
          }
        }
      }
    },
    snapshot() {
      return sanitizeRequestStageTiming(elapsed);
    },
  };
}
