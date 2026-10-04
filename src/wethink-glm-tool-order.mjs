// 只保留同一聊天的工具名稱順序，不保存 prompt、schema 或憑證。
// 不補回已移除的工具；定義更新一律取自本次請求。
export class GlmToolOrder {
  constructor({ maxSessions = 64, maxTools = 512, ttlMs = 20 * 60_000 } = {}) {
    this.maxSessions = maxSessions;
    this.maxTools = maxTools;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  arrange({ tools, route, provider, threadId, now = Date.now() }) {
    if (provider?.id !== "wethink" || provider.protocol !== "openai-responses" ||
        route?.upstreamModel !== "wethink/glm-5.3-flash" ||
        typeof threadId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId) ||
        !Array.isArray(tools) || tools.length === 0 || tools.length > this.maxTools) return tools;
    const names = tools.map(tool => tool?.type === "function" ? tool.name : undefined);
    if (names.some(name => typeof name !== "string" || !name || name.length > 256) ||
        new Set(names).size !== names.length) return tools;

    for (const [key, state] of this.sessions) {
      if (now - state.seen >= this.ttlMs) this.sessions.delete(key);
    }
    const key = `${route.upstreamModel}:${threadId.toLowerCase()}`;
    let state = this.sessions.get(key);
    const newNames = state ? names.filter(name => !state.order.has(name)) : names;
    if (!state || state.order.size + newNames.length > this.maxTools) {
      state = { order: new Map(names.map((name, index) => [name, index])), seen: now };
      this.sessions.delete(key);
      this.sessions.set(key, state);
      while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
      return tools;
    }
    for (const name of newNames) state.order.set(name, state.order.size);
    state.seen = now;
    this.sessions.delete(key);
    this.sessions.set(key, state);
    const arranged = [...tools].sort((a, b) => state.order.get(a.name) - state.order.get(b.name));
    return arranged.every((tool, index) => tool === tools[index]) ? tools : arranged;
  }
}

export const glmToolOrder = new GlmToolOrder();
