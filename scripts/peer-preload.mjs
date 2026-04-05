#!/usr/bin/env node
// Peer preload helper.
//
// Runs on the peer machine (NOT the Mac) to pre-download a model into
// the local ~/.qvac/models cache, BEFORE any consumer requests it via
// delegate. This is useful when:
//
//   1. The consumer is on an unstable connection (mobile hotspot) and
//      we don't want a 1 GB download to fight with 5G jitter.
//   2. You want the first delegated completion to be instant instead
//      of blocking on a registry download.
//
// Works the same as loading a model normally via @qvac/sdk, but
// immediately unloads with clearStorage: false so the cache persists
// on disk for the next peer-provider.mjs run.
//
// Usage on the peer machine:
//   cd ~/qcode-peer
//   node peer-preload.mjs
//
// Env vars:
//   QCODE_PEER_MODEL  qwen3-1.7b | qwen3-4b | qwen3-8b (default: qwen3-1.7b)

import {
  loadModel,
  unloadModel,
  close,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
} from "@qvac/sdk";

const MODEL_KEY = (process.env.QCODE_PEER_MODEL ?? "qwen3-1.7b").toLowerCase();
const MODELS = {
  "qwen3-1.7b": QWEN3_1_7B_INST_Q4,
  "qwen3-4b": QWEN3_4B_INST_Q4_K_M,
  "qwen3-8b": QWEN3_8B_INST_Q4_K_M,
};
const model = MODELS[MODEL_KEY];
if (!model) {
  console.error(`unknown model "${MODEL_KEY}". options: ${Object.keys(MODELS).join(", ")}`);
  process.exit(1);
}

console.log(`preloading ${MODEL_KEY} (${model.name})...`);
const t0 = Date.now();
try {
  const modelId = await loadModel({
    modelSrc: model,
    modelType: "llm",
    modelConfig: { ctx_size: 2048, tools: true },
    onProgress: (p) => {
      const pct = p?.percentage ?? p?.percent;
      if (pct != null) console.log(`  ${Math.round(pct)}%`);
    },
  });
  console.log(`loaded in ${Date.now() - t0}ms, id=${modelId}`);
  await unloadModel({ modelId, clearStorage: false });
  console.log(`unloaded, model cached under ~/.qvac/models`);
} catch (e) {
  console.error(`FAILED: ${e?.message ?? e}`);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
}
await close();
process.exit(0);
