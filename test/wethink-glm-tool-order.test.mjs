import assert from "node:assert/strict";
import test from "node:test";
import { GlmToolOrder } from "../src/wethink-glm-tool-order.mjs";

const provider = { id: "wethink", protocol: "openai-responses" };
const route = { upstreamModel: "wethink/glm-5.3-flash" };
const threadId = "00000000-0000-4000-8000-000000000001";
const tool = name => ({ type: "function", name, parameters: { type: "object" } });
const base = { provider, route, threadId };
const names = tools => tools.map(value => value.name);

test("首次順序不變；同集合重排恢復，新增工具只放尾端", () => {
  const order = new GlmToolOrder();
  const first = [tool("A"), tool("plain")];
  assert.equal(order.arrange({ ...base, tools: first }), first);
  assert.deepEqual(names(order.arrange({ ...base, tools: [first[1], first[0]] })), ["A", "plain"]);
  const B = tool("B");
  assert.deepEqual(order.arrange({ ...base, tools: [first[0], B, first[1]] }), [...first, B]);
});

test("198 增至 224 個工具不搬移既有定義，且完整保留本次集合", () => {
  const order = new GlmToolOrder();
  const first = Array.from({ length: 198 }, (_, index) => tool(`t${index}`));
  const added = Array.from({ length: 26 }, (_, index) => tool(`new${index}`));
  order.arrange({ ...base, tools: first });
  const current = [...added, ...first.slice().reverse()];
  const result = order.arrange({ ...base, tools: current });
  assert.deepEqual(result, [...first, ...added]);
  assert.equal(result.length, current.length);
  assert.deepEqual(new Set(result), new Set(current));
});

test("定義更新、刪除及呼叫名稱完全遵守本次 inventory，不修改來源", () => {
  const order = new GlmToolOrder();
  const first = [tool("A"), tool("B"), tool("C")];
  order.arrange({ ...base, tools: first });
  const changed = Object.freeze({ ...tool("A"), description: "新版 schema", strict: true });
  const current = Object.freeze([first[2], changed]);
  assert.deepEqual(order.arrange({ ...base, tools: current }), [changed, first[2]]);
  assert.deepEqual(current, [first[2], changed]);
});

test("聊天隔離、未知工具／重名／其他路由／沒有聊天 ID 均不調整", () => {
  const order = new GlmToolOrder();
  order.arrange({ ...base, tools: [tool("A"), tool("B")] });
  const tools = [tool("B"), tool("A")];
  for (const options of [
    { threadId: "00000000-0000-4000-8000-000000000002" },
    { threadId: undefined }, { threadId: "不合法" },
    { route: { upstreamModel: "wethink/qwen3.8-flash-next" } },
    { provider: { id: "other", protocol: "openai-responses" } },
    { provider: { id: "wethink", protocol: "chat-completions" } },
  ]) assert.equal(order.arrange({ ...base, ...options, tools }), tools);
  for (const invalid of [[tool("A"), tool("A")], [{ type: "custom", name: "A" }, tool("B")], [tool("x".repeat(257))]]) {
    assert.equal(order.arrange({ ...base, tools: invalid }), invalid);
  }
});

test("TTL、LRU 與工具數上限限制記憶體；重試排列位元組固定", () => {
  const order = new GlmToolOrder({ maxSessions: 1, maxTools: 2, ttlMs: 10 });
  order.arrange({ ...base, tools: [tool("A"), tool("B")], now: 0 });
  const current = [tool("B"), tool("A")];
  const first = order.arrange({ ...base, tools: current, now: 1 });
  assert.equal(JSON.stringify(order.arrange({ ...base, tools: current, now: 2 })), JSON.stringify(first));
  assert.equal(order.arrange({ ...base, tools: current, now: 12 }), current);
  order.arrange({ ...base, threadId: "00000000-0000-4000-8000-000000000002", tools: current, now: 13 });
  assert.equal(order.sessions.size, 1);
  assert.equal(order.arrange({ ...base, tools: current, now: 14 }), current);
  const oversized = [tool("A"), tool("B"), tool("C")];
  assert.equal(order.arrange({ ...base, tools: oversized }), oversized);
  const newInventory = [tool("C"), tool("B")];
  assert.equal(order.arrange({ ...base, tools: newInventory, now: 15 }), newInventory);
  assert.equal(order.sessions.values().next().value.order.size, 2);
});
