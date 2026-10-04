import assert from "node:assert/strict";
import test from "node:test";
import { isWethinkTensorFold, routedPreludeBudgetMs } from "../src/wethink-tensorfold-compat.mjs";

test("TensorFold 等待預算只套用兩個精確路由且維持上限", () => {
  const provider = {id:"wethink",protocol:"openai-responses"};
  const options = {baseMs:30000,requestBytes:4*113000};
  for (const upstreamModel of ["wethink/glm-5.3-flash","wethink/qwen3.8-flash-next"]) {
    const route={upstreamModel};
    assert.equal(isWethinkTensorFold(route,provider),true);
    assert.equal(routedPreludeBudgetMs(route,provider,options),199500);
    assert.equal(routedPreludeBudgetMs(route,provider,{...options,requestBytes:40_000_000}),600000);
    assert.equal(routedPreludeBudgetMs(route,provider,{...options,requestBytes:0}),30000);
  }
  for (const [route,p] of [[{upstreamModel:"wethink/deepseek-v4.1-flash"},provider],
    [{upstreamModel:"wethink/glm-5.3-flash"},{...provider,id:"other"}],
    [{upstreamModel:"wethink/glm-5.3-flash"},{...provider,protocol:"openai"}]]) {
    assert.equal(isWethinkTensorFold(route,p),false);
    assert.equal(routedPreludeBudgetMs(route,p,options),46950);
  }
});
