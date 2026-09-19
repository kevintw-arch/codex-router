import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-router-internal-service-key-with-sufficient-length";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Router exited early (${child.exitCode}).`);
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for Router.");
}

async function stop(child, stateDir) {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  rmSync(stateDir, { recursive: true, force: true });
}

test("stale repair requires the internal key after caller-path authentication", async () => {
  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "router-stale-repair-"));
  const catalogPath = path.join(stateDir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_ROUTER_PORT: String(port),
      MODEL_ROUTER_PORT: String(port),
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CATALOG: catalogPath,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_GATEWAY_HEALTH_URL: "http://127.0.0.1:9/health",
      CODEX_ROUTER_API_HEALTH_URL: "http://127.0.0.1:9/health",
      CODEX_ROUTER_OAUTH_HEALTH_URL: "http://127.0.0.1:9/health",
      CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: "http://127.0.0.1:9/health",
    },
    stdio: "ignore",
  });
  try {
    await waitForPort(port, child);
    const url = `${callerBaseUrl(port, CALLER_KEY)}/admin/repair/wethink`;
    const denied = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Router-Internal-Key": "wrong" },
      body: JSON.stringify({}),
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Codex-Router-Internal-Key": INTERNAL_KEY,
      },
      body: JSON.stringify({}),
    });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.deepEqual(
      { ok: body.ok, mode: body.mode, candidateCount: body.candidateCount, appliedCount: body.appliedCount },
      { ok: true, mode: "dry-run", candidateCount: 0, appliedCount: 0 },
    );
  } finally {
    await stop(child, stateDir);
  }
});
