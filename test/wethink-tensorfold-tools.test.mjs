import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "tensorfold-test-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "tensorfold-test-internal-key-with-sufficient-length";
const PATCH = "*** Begin Patch\n*** Add File: tensorfold-proof.txt\n+工具內容可逆\n*** End Patch";
const NAMESPACE = "mcp__test_calculator";
const TOOL_NAME = "sum";
const ROUTES = [
  ["wethink", "wethink/glm-5.3-flash"],
  ["wethink", "wethink/qwen3.8-flash-next"],
  ["wethink", "wethink/deepseek-v4.1-flash"],
  ["wethink", "wethink/qwen3.8-flash-next-canary"],
  ["opencode-zen-responses", "wethink/glm-5.3-flash"],
  ["opencode-zen-responses", "wethink/qwen3.8-flash-next"],
];

function payload(model, stream) {
  return {
    model, stream,
    tools: [
      { type: "web_search" },
      { type: "custom", name: "apply_patch", description: "套用客戶端修補。" },
      { type: "custom", name: "opaque_custom", description: "傳遞原始文字。" },
      {
        type: "namespace", name: NAMESPACE, description: "測試計算工具。",
        tools: [{
          type: "function", name: TOOL_NAME, description: "計算總和。",
          parameters: {
            type: "object", properties: { value: { type: "number" } },
            required: ["value"], additionalProperties: false,
          },
        }],
      },
      {
        type: "tool_search", execution: "client", description: "搜尋工具。",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ],
    tool_choice: { type: "function", namespace: NAMESPACE, name: TOOL_NAME },
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "呼叫工具。" }] },
      { type: "custom_tool_call", name: "apply_patch", call_id: "history-patch", input: PATCH },
      { type: "custom_tool_call_output", call_id: "history-patch", output: "修補完成。" },
      { type: "custom_tool_call", name: "opaque_custom", call_id: "history-custom", input: "原始文字" },
      { type: "custom_tool_call_output", call_id: "history-custom", output: "文字已接收。" },
      { type: "function_call", namespace: NAMESPACE, name: TOOL_NAME, call_id: "history-namespace", arguments: '{"value":2}' },
      { type: "function_call_output", call_id: "history-namespace", output: "2" },
    ],
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function sse(body) {
  const events = [];
  for (const [output_index, item] of body.output.entries()) {
    events.push({ type: "response.output_item.added", output_index, item: { ...item, arguments: "" } });
    const midpoint = Math.floor(item.arguments.length / 2);
    for (const delta of [item.arguments.slice(0, midpoint), item.arguments.slice(midpoint)]) {
      events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta });
    }
    events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments });
    events.push({ type: "response.output_item.done", output_index, item });
  }
  events.push({ type: "response.completed", response: body });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function harness(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "wethink-tensorfold-tools-"));
  const models = ROUTES.map(([provider, upstreamModel], index) => ({
    slug: `${provider}/tensorfold-fixture-${index}`,
    provider, upstreamModel, gatewayModel: `tensorfold-fixture-${index}`,
    displayName: `工具橋接測試 ${index}`, description: "隔離路由測試。",
    listed: true, priority: 500, contextWindow: 131072, autoCompact: 111411,
    defaultEffort: "high", reasoningLevels: [{ effort: "high", description: "推理" }],
    inputModalities: ["text"], compHash: `tensorfold-fixture-${index}`,
  }));
  const userModels = path.join(directory, "user-models.json");
  writeFileSync(userModels, JSON.stringify({ version: 1, models }));
  const requests = [];
  const gateway = http.createServer(async (request, response) => {
    if (request.url !== "/v1/responses") return sendJson(response, 404, { error: "未預期的路徑。" });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const sent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(sent);
    const strict = models.slice(0, 2).some((model) => model.gatewayModel === sent.model);
    if (strict && sent.tools.some((tool) => tool.type !== "function")) {
      return sendJson(response, 400, { error: { message: "僅接受 function 工具。" } });
    }
    const patchTool = sent.tools.find((tool) => tool.description?.startsWith("套用客戶端修補。"));
    const namespaceTool = sent.tools.find((tool) => tool.description === "計算總和。");
    const output = strict ? [
      { type: "function_call", id: `fc_patch_${requests.length}`, call_id: `call_patch_${requests.length}`, name: patchTool.name, arguments: JSON.stringify({ input: PATCH }) },
      { type: "function_call", id: `fc_sum_${requests.length}`, call_id: `call_sum_${requests.length}`, name: namespaceTool.name, arguments: '{"value":7}' },
    ] : [{ type: "message", id: "msg_negative", role: "assistant", status: "completed", content: [{ type: "output_text", text: "保留原生工具。", annotations: [] }] }];
    const body = { id: `resp_${requests.length}`, object: "response", status: "completed", output };
    if (!sent.stream) return sendJson(response, 200, body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(sse(body));
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  const routerPort = await openPort();
  const child = spawn(process.execPath, [path.join(root, "src/router.mjs")], {
    cwd: root,
    env: {
      ...process.env, MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
      MODEL_ROUTER_USER_MODELS: userModels, CODEX_ROUTER_PORT: String(routerPort),
      CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY, CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
      CODEX_ROUTER_GLM_STABLE_TOOL_ORDER: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await new Promise((resolve) => gateway.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = callerBaseUrl(routerPort, CALLER_KEY);
  const deadline = Date.now() + 10_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Router 提前結束：${errors}`);
    try {
      if ((await fetch(`${base}/models`)).ok) break;
    } catch { /* 等待隔離 listener。 */ }
    assert.ok(Date.now() < deadline, `Router 未啟動：${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    models, requests,
    async post(body, extraHeaders = {}) {
      const response = await fetch(`${base}/responses`, {
        method: "POST", headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body),
      });
      const wire = await response.text();
      assert.equal(response.status, 200, `${wire}\n${errors}`);
      if (!body.stream) return { output: JSON.parse(wire).output, events: [] };
      const events = wire.split("\n").filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
      assert.equal(events.some((event) => event.type === "error" || event.type === "response.failed"), false, wire);
      return { output: events.find((event) => event.type === "response.completed").response.output, events };
    },
  };
}

test("WeThink TensorFold 兩個精確路由可逆轉接 custom 與 namespace 工具及歷史", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  for (const model of h.models.slice(0, 2)) {
    for (const stream of [false, true]) {
      const original = payload(model.slug, stream);
      const result = await h.post(original);
      const sent = h.requests.at(-1);
      assert.ok(sent.tools.every((tool) => tool.type === "function"));
      assert.ok(sent.tools.some((tool) => tool.parameters?.properties?.input));
      assert.ok(sent.tools.some((tool) => tool.name === "tool_search"));
      assert.equal(sent.tool_choice.namespace, undefined);
      assert.equal(sent.tool_choice.name, `${NAMESPACE}__${TOOL_NAME}`);
      assert.ok(sent.input.every((item) => !["custom_tool_call", "custom_tool_call_output"].includes(item.type)));
      for (const [call_id, input] of [["history-patch", PATCH], ["history-custom", "原始文字"]]) {
        assert.deepEqual(JSON.parse(sent.input.find((item) => item.type === "function_call" && item.call_id === call_id).arguments), { input });
        assert.ok(sent.input.some((item) => item.type === "function_call_output" && item.call_id === call_id));
      }
      assert.equal(sent.input.find((item) => item.call_id === "history-namespace").name, `${NAMESPACE}__${TOOL_NAME}`);
      const [patch, namespaceCall] = result.output;
      assert.equal(patch.type, "custom_tool_call");
      assert.equal(patch.name, "apply_patch");
      assert.equal(patch.input, PATCH);
      assert.equal(Object.hasOwn(patch, "arguments"), false);
      assert.equal(namespaceCall.namespace, NAMESPACE);
      assert.equal(namespaceCall.name, TOOL_NAME);
      assert.equal(namespaceCall.arguments, '{"value":7}');
      if (stream) {
        assert.equal(result.events.filter((event) => event.type === "response.custom_tool_call_input.delta").map((event) => event.delta).join(""), PATCH);
        assert.equal(result.events.find((event) => event.type === "response.custom_tool_call_input.done").input, PATCH);
      }
      await h.post({
        ...original, tool_choice: { type: "custom", name: "apply_patch" },
        input: [...original.input, patch, { type: "custom_tool_call_output", call_id: patch.call_id, output: "客戶端已執行。" }, namespaceCall, { type: "function_call_output", call_id: namespaceCall.call_id, output: "7" }],
      });
      const replay = h.requests.at(-1);
      assert.equal(replay.tool_choice.type, "function");
      assert.deepEqual(JSON.parse(replay.input.find((item) => item.type === "function_call" && item.call_id === patch.call_id).arguments), { input: PATCH });
      assert.equal(replay.input.find((item) => item.type === "function_call" && item.call_id === namespaceCall.call_id).name, `${NAMESPACE}__${TOOL_NAME}`);
      assert.equal(replay.input.find((item) => item.type === "function_call_output" && item.call_id === patch.call_id).output, "客戶端已執行。");
    }
  }
});

test("其他 WeThink 模型與相同 upstream 的其他 provider 保留原生工具 bytes", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  for (const model of h.models.slice(2)) {
    const original = payload(model.slug, false);
    await h.post(original);
    const sent = h.requests.at(-1);
    for (const field of ["tools", "input", "tool_choice"]) {
      assert.equal(JSON.stringify(sent[field]), JSON.stringify(original[field]), `${model.provider}/${model.upstreamModel}: ${field}`);
    }
  }
});

test("GLM 聊天內轉接後的工具穩定排列，新增 MCP 定義不影響可逆呼叫", { timeout: 30_000 }, async (t) => {
  const h = await harness(t);
  const headers = { "thread-id": "00000000-0000-4000-8000-000000000011" };
  const original = payload(h.models[0].slug, true);
  await h.post(original, headers);
  const first = h.requests.at(-1).tools;
  const inventory = original.tools.map(value => value.type === "namespace"
    ? { ...value, tools: [...value.tools, { type: "function", name: "new_tool", parameters: { type: "object" } }] }
    : value).reverse();
  const result = await h.post({ ...original, tools: inventory }, headers);
  const current = h.requests.at(-1);
  assert.deepEqual(current.tools.slice(0, first.length), first);
  assert.equal(current.tools.at(-1).name, `${NAMESPACE}__new_tool`);
  assert.equal(current.tools.length, first.length + 1);
  assert.equal(result.output[0].type, "custom_tool_call");
  assert.equal(result.output[0].input, PATCH);
  assert.equal(result.output[1].namespace, NAMESPACE);
  assert.equal(current.tool_choice.name, `${NAMESPACE}__${TOOL_NAME}`);
  assert.deepEqual(original, payload(h.models[0].slug, true));
});
