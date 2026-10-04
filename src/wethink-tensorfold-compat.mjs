import { preludeBudgetMs } from "./empty-completion-guard.mjs";

export function isWethinkTensorFold(route, provider) {
  return provider?.id === "wethink" && provider.protocol === "openai-responses" &&
    ["wethink/glm-5.3-flash", "wethink/qwen3.8-flash-next"].includes(route?.upstreamModel);
}

// 實跑約 113k-token CLI 輸入需要 63–99 秒；沿用有界限的保護，
// 只給精確 TensorFold 路由每估計 1k tokens 1.5 秒的輸入等待預算。
export function routedPreludeBudgetMs(route, provider, options) {
  return preludeBudgetMs({ ...options,
    ...(isWethinkTensorFold(route, provider) ? { perThousandTokensMs: 1500 } : {}),
  });
}
