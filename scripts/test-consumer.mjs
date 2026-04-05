#!/usr/bin/env node
// Minimal consumer test. Tries loadModel with delegate and prints what
// happens. Runs against the same topic+pubkey the qcode daemon uses.
//
// Usage:
//   cd /Users/thomasblanc/1_app/qcode
//   QCODE_PEER_PUBKEY=<peer-key> node scripts/test-consumer.mjs

import { loadModel, completion, close, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";

const TOPIC = process.env.QCODE_PEER_TOPIC ?? "71636f64652d706565722d64656d6f2d323032362d30342d313500000000000b";
const PUBKEY = process.env.QCODE_PEER_PUBKEY;
const MODEL_PATH = process.env.QCODE_PEER_MODEL_PATH ?? "";

if (!PUBKEY) {
  console.error("set QCODE_PEER_PUBKEY first");
  process.exit(1);
}

// If a path is provided, send it as modelSrc to the peer. Otherwise use
// the default registry constant (which triggers a download on the peer).
const modelSrc = MODEL_PATH || QWEN3_1_7B_INST_Q4;

console.log(`topic:    ${TOPIC}`);
console.log(`pubkey:   ${PUBKEY}`);
console.log(`modelSrc: ${MODEL_PATH ? MODEL_PATH : "QWEN3_1_7B_INST_Q4 (registry)"}`);
console.log("calling loadModel with delegate, 60s timeout...");

const t0 = Date.now();
try {
  const modelId = await loadModel({
    modelSrc,
    modelType: "llm",
    modelConfig: { ctx_size: 2048, tools: true },
    delegate: {
      topic: TOPIC,
      providerPublicKey: PUBKEY,
      timeout: 60_000,
      fallbackToLocal: false,
    },
    onProgress: (p) => {
      const pct = p?.percentage ?? p?.percent;
      if (pct != null) console.log(`  download: ${Math.round(pct)}%`);
    },
  });
  console.log(`loaded in ${Date.now() - t0}ms, modelId=${modelId}`);

  console.log("running a completion to verify delegation...");
  const result = completion({
    modelId,
    history: [{ role: "user", content: "Say just 'hello' and nothing else." }],
    stream: true,
  });

  let text = "";
  for await (const token of result.tokenStream) {
    text += token;
    process.stdout.write(token);
  }
  console.log();
  console.log(`completion done, total: ${text.length} chars`);
} catch (e) {
  const elapsed = Date.now() - t0;
  console.error(`FAILED after ${elapsed}ms:`, e?.message ?? e);
  if (e?.stack) console.error(e.stack);
}

await close();
process.exit(0);
