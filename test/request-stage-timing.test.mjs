import assert from "node:assert/strict";
import test from "node:test";

import { createProviderInflightQueue } from "../src/provider-inflight-queue.mjs";
import {
  createRequestStageTiming,
  sanitizeRequestStageTiming,
} from "../src/request-stage-timing.mjs";

test("三階段分開累計，不包含階段外空檔，並保留回傳值", async () => {
  let clock = 1_000;
  const timing = createRequestStageTiming({ now: () => clock });
  assert.deepEqual(timing.snapshot(), {});
  const result = {};
  assert.equal(await timing.measure("admissionWaitMs", () => {
    clock += 7;
    return result;
  }), result);
  clock += 9_000;
  await timing.measure("requestBuildMs", () => { clock += 11; });
  await timing.measure("requestBuildMs", () => { clock += 3; });
  await timing.measure("upstreamHeadersWaitMs", () => { clock += 13; });
  await timing.measure("upstreamHeadersWaitMs", () => { clock += 17; });
  assert.deepEqual(timing.snapshot(), {
    admissionWaitMs: 7,
    requestBuildMs: 14,
    upstreamHeadersWaitMs: 30,
  });
  const snapshot = timing.snapshot();
  snapshot.admissionWaitMs = 999;
  assert.equal(timing.snapshot().admissionWaitMs, 7);
});

test("真實佇列可區分立即取得名額與等待，不改動名額釋放", async () => {
  let clock = 1_000;
  const queue = createProviderInflightQueue({ provider: "wethink", maxActive: 1 });
  const immediate = createRequestStageTiming({ now: () => clock });
  const queued = createRequestStageTiming({ now: () => clock });
  const releaseFirst = await immediate.measure("admissionWaitMs", () => queue.acquire());
  let releaseWaiting;
  try {
    const waiting = queued.measure("admissionWaitMs", () => queue.acquire());
    assert.equal(queue.snapshot().queued, 1);
    assert.deepEqual(queued.snapshot(), {});
    clock += 250;
    releaseFirst();
    releaseWaiting = await waiting;
    assert.equal(immediate.snapshot().admissionWaitMs, 0);
    assert.equal(queued.snapshot().admissionWaitMs, 250);
    assert.equal(queue.snapshot().active, 1);
    assert.equal(queue.snapshot().queued, 0);
  } finally {
    releaseFirst();
    releaseWaiting?.();
  }
  assert.equal(queue.snapshot().active, 0);
});

test("取消等待仍計量，保留原錯誤且不占用或遺漏名額", async () => {
  let clock = 100;
  const queue = createProviderInflightQueue({ provider: "wethink", maxActive: 1 });
  const release = await queue.acquire();
  const timing = createRequestStageTiming({ now: () => clock });
  const controller = new AbortController();
  const cancellation = new Error("測試取消");
  try {
    const waiting = timing.measure("admissionWaitMs", () => queue.acquire({
      signal: controller.signal, weightBytes: 77,
    }));
    const rejected = assert.rejects(waiting, (error) => error === cancellation);
    clock += 18;
    controller.abort(cancellation);
    await rejected;
    assert.deepEqual(timing.snapshot(), { admissionWaitMs: 18 });
    assert.equal(queue.snapshot().queued, 0);
    assert.equal(queue.snapshot().queuedBytes, 0);
    assert.equal(queue.snapshot().active, 1);
  } finally {
    release();
  }
  assert.equal(queue.snapshot().active, 0);
});

test("佇列拒絕、同步建構例外及非同步上游例外保留原結果", async () => {
  let clock = 0;
  const timing = createRequestStageTiming({ now: () => clock });
  const queue = createProviderInflightQueue({ provider: "wethink", maxActive: 1, maxQueued: 0 });
  const release = await queue.acquire();
  try {
    await assert.rejects(timing.measure("admissionWaitMs", () => queue.acquire()),
      (error) => error.code === "ERR_PROVIDER_QUEUE_FULL");
    assert.equal(timing.snapshot().admissionWaitMs, 0);
    assert.equal(queue.snapshot().active, 1);
  } finally {
    release();
  }
  const buildError = new Error("測試建構失敗");
  await assert.rejects(timing.measure("requestBuildMs", () => {
    clock += 4;
    throw buildError;
  }), (error) => error === buildError);
  const upstreamError = new Error("測試上游失敗");
  await assert.rejects(timing.measure("upstreamHeadersWaitMs", async () => {
    clock += 21;
    throw upstreamError;
  }), (error) => error === upstreamError);
  assert.deepEqual(timing.snapshot(), {
    admissionWaitMs: 0, requestBuildMs: 4, upstreamHeadersWaitMs: 21,
  });
});

test("診斷時鐘失敗或無效不影響回傳值與原始錯誤", async () => {
  for (const failedRead of [1, 2]) {
    let reads = 0;
    const timing = createRequestStageTiming({ now: () => {
      reads += 1;
      if (reads === failedRead) throw new Error("測試時鐘失敗");
      return 100;
    } });
    const result = {};
    assert.equal(await timing.measure("requestBuildMs", () => result), result);
    assert.deepEqual(timing.snapshot(), {});
  }
  for (const value of [NaN, Infinity, "100"]) {
    const timing = createRequestStageTiming({ now: () => value });
    const failure = new Error("原始例外");
    await assert.rejects(timing.measure("upstreamHeadersWaitMs", () => {
      throw failure;
    }), (error) => error === failure);
    assert.deepEqual(timing.snapshot(), {});
  }
});

test("快照只含三個有限非負數值，未觀測保持缺值", async () => {
  const timing = createRequestStageTiming({ now: () => 100 });
  const returned = { content: "測試內容", key: "測試憑證" };
  assert.equal(await timing.measure("未登錄階段", () => returned), returned);
  assert.deepEqual(timing.snapshot(), {});
  assert.deepEqual(sanitizeRequestStageTiming({
    admissionWaitMs: 0, requestBuildMs: 2.6, upstreamHeadersWaitMs: 1e99,
    content: "測試內容", key: "測試憑證", other: 123,
  }), { admissionWaitMs: 0, requestBuildMs: 3, upstreamHeadersWaitMs: Number.MAX_SAFE_INTEGER });
  for (const value of [undefined, null, NaN, Infinity, -1, "2", true]) {
    assert.deepEqual(sanitizeRequestStageTiming({ admissionWaitMs: value }), {});
  }
  let clock = 100;
  const backwards = createRequestStageTiming({ now: () => clock });
  await backwards.measure("requestBuildMs", () => { clock = 90; });
  assert.deepEqual(backwards.snapshot(), { requestBuildMs: 0 });
});

test("預設使用單調時鐘且可安全量測空操作", async () => {
  const timing = createRequestStageTiming();
  await timing.measure("requestBuildMs", () => undefined);
  const snapshot = timing.snapshot();
  assert.equal(Object.keys(snapshot).length, 1);
  assert.ok(Number.isFinite(snapshot.requestBuildMs));
  assert.ok(snapshot.requestBuildMs >= 0);
});
