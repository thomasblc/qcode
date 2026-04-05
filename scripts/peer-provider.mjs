#!/usr/bin/env node
// qcode peer provider.
//
// Runs on a second machine (Debian mini PC in our setup) and exposes a
// @qvac/sdk delegated-inference provider over Hyperswarm P2P. It does NOT
// pre-load a model: when the Mac consumer calls loadModel({ modelSrc, delegate }),
// the SDK forwards the modelSrc to this provider, which loads it locally
// on demand and answers completions.
//
// Setup on Debian (or any Linux/macOS box with Node 22+):
//   mkdir -p ~/qcode-peer && cd ~/qcode-peer
//   npm init -y
//   npm install @qvac/sdk bare-ffmpeg
//   # copy peer-provider.mjs here (scp, cyberduck, heredoc, ...)
//   node peer-provider.mjs
//
// IMPORTANT: you must install `bare-ffmpeg` explicitly. The @qvac/sdk
// dep chain pulls in @qvac/decoder-audio, which requires bare-ffmpeg as a
// native module. In some npm install orderings (e.g. after npm init -y
// with a non-empty parent node_modules), bare-ffmpeg gets pruned and the
// SDK worker crashes at boot with:
//   "MODULE_NOT_FOUND: Cannot find module 'bare-ffmpeg' imported from
//    .../node_modules/@qvac/decoder-audio/index.js"
// The fix is a one-liner: `npm install bare-ffmpeg`. The package ships
// prebuilt binaries for linux-x64, linux-arm64, darwin-arm64/x64, and
// ios/android, so no ffmpeg system install is needed.
//
// Env vars:
//   QCODE_PEER_TOPIC         64-char hex topic (default = qcode fixed topic)
//   QCODE_PEER_SEED          64-char hex seed for deterministic identity
//   QCODE_PEER_ALLOWED_KEYS  comma-separated consumer pubkeys (default: allow all)
//
// The script prints its PROVIDER PUBLIC KEY on startup. Copy that to the
// Mac side as QCODE_PEER_PUBKEY and set QCODE_PEER_ENABLED=1 to activate.

import { startQVACProvider } from "@qvac/sdk";

// Default topic: 64 hex chars, deterministic so both sides agree.
// Derived from "qcode-peer-demo-2026-04-15" as SHA-256 prefix (documented
// here so anyone can regenerate it). Override via QCODE_PEER_TOPIC if needed.
const DEFAULT_TOPIC = "71636f64652d706565722d64656d6f2d323032362d30342d313500000000000b";

const topic = (process.env.QCODE_PEER_TOPIC ?? DEFAULT_TOPIC).toLowerCase();
if (topic.length !== 64 || !/^[0-9a-f]+$/.test(topic)) {
  console.error(`QCODE_PEER_TOPIC must be a 64-char hex string (got ${topic.length} chars)`);
  process.exit(1);
}

const seed = process.env.QCODE_PEER_SEED;
if (seed) {
  if (seed.length !== 64 || !/^[0-9a-f]+$/.test(seed)) {
    console.error("QCODE_PEER_SEED must be a 64-char hex string");
    process.exit(1);
  }
  process.env["QVAC_HYPERSWARM_SEED"] = seed;
}

const allowedKeysRaw = process.env.QCODE_PEER_ALLOWED_KEYS ?? "";
const allowedKeys = allowedKeysRaw.split(",").map(s => s.trim()).filter(Boolean);

const border = "─".repeat(64);
console.log(`\n${border}`);
console.log("qcode peer provider");
console.log(border);
console.log(`  topic:     ${topic}`);
console.log(`  seed:      ${seed ? "set (deterministic identity)" : "random"}`);
console.log(`  firewall:  ${allowedKeys.length > 0 ? `allow [${allowedKeys.length} keys]` : "allow all"}`);
console.log(border);
console.log("starting provider...");

try {
  const response = await startQVACProvider({
    topic,
    firewall: allowedKeys.length > 0 ? { mode: "allow", publicKeys: allowedKeys } : undefined,
  });

  const pubKey = response?.publicKey ?? "(missing from response)";

  console.log(`${border}`);
  console.log("  PROVIDER PUBLIC KEY:");
  console.log(`  ${pubKey}`);
  console.log(`${border}`);
  console.log("  Mac consumer setup (copy/paste on the Mac):");
  console.log(`    export QCODE_PEER_TOPIC="${topic}"`);
  console.log(`    export QCODE_PEER_PUBKEY="${pubKey}"`);
  console.log(`    export QCODE_PEER_ENABLED=1`);
  console.log(`    npm run serve`);
  console.log(`${border}`);
  console.log("  The provider does NOT preload a model. It loads models on");
  console.log("  demand when the consumer calls loadModel({ modelSrc, delegate }).");
  console.log("  First completion will block until the model is downloaded here.");
  console.log(`${border}`);
  console.log("  Provider is running. Press Ctrl+C to stop.");
  console.log(`${border}\n`);
} catch (e) {
  console.error("startQVACProvider failed:", e?.message ?? e);
  process.exit(1);
}

process.on("SIGINT", () => {
  console.log("\nprovider stopped (SIGINT)");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\nprovider stopped (SIGTERM)");
  process.exit(0);
});

// Keep the process alive
process.stdin.resume();
