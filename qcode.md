# qcode - project memory

This file is loaded by qcode on every session and injected into the system prompt.
Keep it short (<2k tokens). Model-agnostic by design.

## What this project is

qcode is a local coding agent that runs on the user's Mac via @qvac/sdk (Tether's
official SDK, v0.8.3). Controlled from iPhone via a PWA served by an Express daemon.
Multi-modal: voice input (Whisper), vision (Qwen3-VL), and delegated inference (P2P)
are all opt-in features.

**Stack**: TypeScript + Node 22+, ESM strict, `@qvac/sdk` for inference, Express for HTTP,
vanilla JS PWA (no build step). Design system matches qvac.tether.io (Inconsolata mono +
#16E3C1 mint accent).

**Primary model**: Qwen3 1.7B Q4 via SDK registry. Native tool calling via
`completion({ tools })` with Zod schemas. The SDK handles chat template formatting.

**Architecture**: a capability router dispatches each request to the best backend:
local (full agent loop with Qwen3 1.7B) or delegated peer (via @qvac/sdk P2P over
Hyperswarm). Add a new backend by implementing `AgentBackend` and calling
`router.register()`.

## Code conventions

- ES modules only. 2-space indent. Prettier defaults.
- No `any` in TypeScript (strict mode). Use `unknown` + narrowing.
- No abbreviations (`userName`, not `usrNm`). No narrative comments.
- Small, targeted changes. Never rewrite working code.
- Every new backend file goes in `src/agent/backends/`.
- Every new frontend logic goes in `public/app.js` (vanilla JS, no framework).

## Directory layout

- `src/agent/` - agent loop, executor, models (SDK wrapper), prompt, tool-schemas, router, memory, condense
- `src/agent/backends/` - local-llm.ts (tier 1), delegated-peer.ts (tier 2)
- `src/server/` - Express routes, SSE, auth, sessions, features, voice, vision, model-provider
- `src/tools/` - tools the agent can call (read/write/list/grep/bash/diff/propose_plan)
- `src/state/` - disk persistence
- `src/utils/` - paths, logger
- `public/` - PWA (index.html, app.js, style.css)
- `docs/` - PROJECT-STATUS.md, PEER-SETUP.md, DEMO-SCRIPT.md
- `scripts/` - peer-provider.mjs, smoke-test.sh, multi-turn-test.sh
- `.qcode-state/` - runtime state (auth-key, features.json, sessions.json), gitignored

## Key modules

- `src/agent/loop.ts` - ReAct loop. SDK native tool calling + fallback text parser.
  Context window management (sliding window, token budget). Reflection nudge after
  2 consecutive failures. Strips Qwen3 `<think>` blocks.
- `src/agent/tool-schemas.ts` - Zod schemas for 8 tools, passed as `ToolInput[]`.
- `src/agent/models.ts` - `QvacSdkBackend` wraps @qvac/sdk. Loads from registry
  constants, file paths, or delegate config. Consumes tokenStream + toolCallStream.
- `src/agent/prompt.ts` - compact system prompt (~500 tokens). No tool catalog prose.
- `src/agent/backends/delegated-peer.ts` - routes heavy tasks to peer backend via P2P.
- `src/server/index.ts` - daemon entry. Boots SDK, loads model, optional fire-and-forget
  peer load via mutable `peerBackendRef` holder.
- `src/server/features.ts` - opt-in features (voice, vision, delegated). SDK downloads on demand.
- `public/app.js` - PWA with SSE streaming, lastEventId tracking, voice, model picker.

## Things to NOT touch unless asked

- `qcode.md` (this file) - project memory for the agent.
- `models/` - external assets (gitignored).
- `.qcode-state/` - runtime state.

## Critical constraints

- **8 GB M3 Mac target**. Context window budget is ~8192 tokens total. System prompt + docs
  must stay under 3k combined. Sliding window + token budget in loop.ts enforces this.
- **Local models, not Claude**. Qwen3 1.7B via @qvac/sdk. Enforce behavior programmatically.
- **All features are opt-in**. Whisper/vision/delegated downloads happen only on explicit
  user enable. Respect `isFeatureEnabled(id)` in gates.
- **Permission modes matter**: writes and bash are gated except in `auto-writes` and `yolo`.
