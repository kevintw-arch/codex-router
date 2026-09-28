import assert from "node:assert/strict";
import test from "node:test";

import { createProviderInflightQueue } from "../src/provider-inflight-queue.mjs";

test("ordinary requests wait in FIFO order without exceeding active capacity", async () => {
  const queue = createProviderInflightQueue({
    provider: "wethink",
    maxActive: 1,
    maxQueued: 2,
    maxQueuedBytes: 1_000,
    queueTimeoutMs: 1_000,
  });
  const releaseFirst = await queue.acquire();
  const order = [];
  const second = queue.acquire().then((release) => {
    order.push("second");
    return release;
  });
  const third = queue.acquire().then((release) => {
    order.push("third");
    return release;
  });

  assert.deepEqual(queue.snapshot(), {
    active: 1,
    queued: 2,
    queuedBytes: 0,
    maxActive: 1,
    maxQueued: 2,
    maxQueuedBytes: 1_000,
    queueTimeoutMs: 1_000,
  });
  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(order, ["second"]);
  assert.equal(queue.snapshot().active, 1);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(order, ["second", "third"]);
  releaseThird();
  assert.equal(queue.snapshot().active, 0);
});

test("the waiting limit returns a bounded service-unavailable error", async () => {
  const queue = createProviderInflightQueue({
    provider: "wethink",
    maxActive: 1,
    maxQueued: 1,
    maxQueuedBytes: 1_000,
    queueTimeoutMs: 1_000,
  });
  const release = await queue.acquire();
  const waiting = queue.acquire();

  await assert.rejects(queue.acquire(), (error) => {
    assert.equal(error.code, "ERR_PROVIDER_QUEUE_FULL");
    assert.equal(error.status, 503);
    assert.equal(error.active, 1);
    assert.equal(error.queued, 1);
    return true;
  });
  release();
  (await waiting)();
});

test("a canceled waiter is removed and does not consume a slot", async () => {
  const queue = createProviderInflightQueue({
    provider: "wethink",
    maxActive: 1,
    maxQueued: 1,
    maxQueuedBytes: 1_000,
    queueTimeoutMs: 1_000,
  });
  const release = await queue.acquire();
  const controller = new AbortController();
  const waiting = queue.acquire({ signal: controller.signal });
  controller.abort();

  await assert.rejects(waiting, (error) => error.name === "AbortError");
  assert.equal(queue.snapshot().queued, 0);
  release();
  assert.equal(queue.snapshot().active, 0);
});

test("a waiter times out and is removed from the bounded queue", async () => {
  const queue = createProviderInflightQueue({
    provider: "wethink",
    maxActive: 1,
    maxQueued: 1,
    maxQueuedBytes: 1_000,
    queueTimeoutMs: 20,
  });
  const release = await queue.acquire();

  await assert.rejects(queue.acquire(), (error) => {
    assert.equal(error.code, "ERR_PROVIDER_QUEUE_TIMEOUT");
    assert.equal(error.status, 504);
    return true;
  });
  assert.equal(queue.snapshot().queued, 0);
  release();
  assert.equal(queue.snapshot().active, 0);
});

test("priority compaction jumps ordinary waiters without exceeding active capacity", async () => {
  const queue = createProviderInflightQueue({
    provider: "wethink",
    maxActive: 1,
    maxQueued: 2,
    maxQueuedBytes: 1_000,
    queueTimeoutMs: 1_000,
  });
  const releaseFirst = await queue.acquire();
  let ordinaryAdmitted = false;
  const ordinary = queue.acquire().then((release) => {
    ordinaryAdmitted = true;
    return release;
  });
  const priorityWaiting = queue.acquire({ priority: true });

  assert.equal(queue.snapshot().active, 1);
  assert.equal(queue.snapshot().queued, 2);
  releaseFirst();
  const releasePriorityWaiting = await priorityWaiting;
  assert.equal(queue.snapshot().active, 1);
  assert.equal(queue.snapshot().queued, 1);
  assert.equal(ordinaryAdmitted, false);
  releasePriorityWaiting();
  const releaseOrdinary = await ordinary;
  releaseOrdinary();
  assert.equal(queue.snapshot().active, 0);
});

test("queued request bytes are bounded and released when a waiter is admitted", async () => {
  const queue = createProviderInflightQueue({
    provider: "wethink",
    maxActive: 1,
    maxQueued: 3,
    maxQueuedBytes: 10,
    queueTimeoutMs: 1_000,
  });
  const release = await queue.acquire();
  const waiting = queue.acquire({ weightBytes: 7 });

  await assert.rejects(queue.acquire({ weightBytes: 4 }), (error) => {
    assert.equal(error.code, "ERR_PROVIDER_QUEUE_FULL");
    assert.equal(error.queuedBytes, 7);
    assert.equal(error.maxQueuedBytes, 10);
    return true;
  });
  release();
  const releaseWaiting = await waiting;
  assert.equal(queue.snapshot().queuedBytes, 0);
  releaseWaiting();
  assert.equal(queue.snapshot().active, 0);
});
