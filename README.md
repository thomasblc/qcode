# qcode

A local coding agent that runs on your Mac, controllable from your iPhone PWA, with P2P delegated inference to a stronger model on another machine. Built on `@qvac/sdk`. No cloud, no account, no data leaves your hardware.

## What it does

- **Local agent loop**: reads your code, proposes changes, runs commands, shows diffs. All tool execution is local.
- **Native SDK tool calling**: uses `@qvac/sdk`'s `completion({ tools })` with Zod schemas. The SDK handles chat template formatting, tool call parsing, and structured output. A fallback parser catches models that emit tool calls as plain text.
- **Multi-turn memory**: conversations carry context across turns with sliding-window truncation and token-budget management.
- **Peer delegation via P2P**: offload to a stronger model running on another machine over `@qvac/sdk`'s Hyperswarm transport. Configure from the PWA settings, pick the peer model from the main model picker, switch on demand. Tool execution stays on the Mac.
- **Voice (Whisper) and vision (Qwen3-VL)**: both run locally on the Mac via the SDK registry, enabled with a toggle in settings.

## Demo

Video: [`docs/qcode-demo.mp4`](./docs/qcode-demo.mp4).

## Architecture

```
iPhone (Safari PWA)                    Mac (Node/Express daemon, :3000)
+-----------------+     HTTP/SSE       +------------------------------+
| qcode PWA       | <---------------->| qcode daemon                 |
| vanilla JS,     |                   |                              |
| no install      |                   |  capability router           |
+-----------------+                   |    |                         |
                                      |    +-- local-llm backend     |
                                      |    |   Qwen3 1.7B / 4B       |
                                      |    |   (@qvac/sdk, local)    |
                                      |    |                         |
                                      |    +-- delegated-peer backend|
                                      |        uses peer over P2P    |
                                      |                              |
                                      |  tools: read, write, list,   |
                                      |  grep, bash, diff, plan      |
                                      +------------------------------+
                                               |
                                      Hyperswarm P2P (optional)
                                               |
                                      +------------------------------+
                                      | Peer (Linux/Mac)             |
                                      | peer-provider.mjs as service |
                                      | Qwen3 1.7B / 4B / 8B         |
                                      +------------------------------+
```

**Flow**: the PWA sends a task via HTTP. The daemon's capability router picks the backend (local or peer, based on the user's selection in the model picker and a "heavy task" heuristic). The agent loop calls `completion({ tools })` on `@qvac/sdk`, gets back structured tool calls, executes them against local files, pushes results as `role: "tool"` messages, and loops until the model calls `reply()`. Events stream back to the PWA via SSE.

## SDK capabilities used

| `@qvac/sdk` feature | How qcode uses it |
|---|---|
| `loadModel` | Loads Qwen3 1.7B from the SDK registry on boot. Accepts registry constants, file paths, or delegate config. |
| `completion` (streaming) | Called with `{ history, tools, stream: true }`. Consumes `tokenStream` and `toolCallStream` concurrently. |
| `completion` (tools) | Passes Zod schemas as `ToolInput[]`. SDK injects tools into the model's native chat template. |
| `toolCallStream` | Reads structured `{ name, arguments }` tool calls parsed by the SDK. |
| `cancel` | Wired to the PWA stop button via `AbortSignal`. |
| `loadModel` (delegate) | Routes completions to a P2P peer via `delegate: { topic, providerPublicKey }`. |
| `startQVACProvider` | Runs on the peer machine (see `scripts/peer-provider.mjs`). |
| `loadModel` (whisper) | Loads `WHISPER_BASE_Q8_0` on demand when voice is enabled. |
| `loadModel` (vision) | Loads `QWEN3VL_2B_MULTIMODAL_Q4_K` on demand when vision is enabled. |
| Model registry | Uses `QWEN3_1_7B_INST_Q4`, `QWEN3_4B_INST_Q4_K_M`, `QWEN3_8B_INST_Q4_K_M`. SDK downloads + caches under `~/.qvac/models/`. |

## Quick start (Mac, local only)

```bash
git clone https://github.com/thomasblc/qcode.git
cd qcode
npm install
npm run serve
```

The daemon boots `@qvac/sdk`, downloads Qwen3 1.7B (~1 GB) from the SDK registry on first run, and starts the HTTP daemon + PWA on port 3000.

Open `http://127.0.0.1:3000/`. The boot banner prints a Bonjour URL (e.g. `http://your-mac.local:3000/`) for iPhone access over the same LAN.

### Voice + vision

Toggle in the PWA Settings → Features panel. First enable downloads the weights from the SDK registry (~82 MB for Whisper, ~1.5 GB for Qwen3-VL + projector).

### P2P delegated inference

Full guide: [docs/PEER-QUICKSTART.md](./docs/PEER-QUICKSTART.md).

Short version:

1. On the peer machine (any Linux/Mac box with Node 22+, a LAN IP reachable from your Mac):
   ```bash
   scp scripts/peer-provider.mjs scripts/qcode-peer.service scripts/install-peer-service.sh user@peer:~/qcode-peer/
   ssh -t user@peer 'cd ~/qcode-peer && sudo bash install-peer-service.sh'
   ```
   This installs peer-provider as a systemd service so it auto-starts on boot.
2. On the Mac, in the PWA: Settings → Features → toggle "Delegated inference" → configure peer → connect.
3. Main model picker → REMOTE · P2P PEERS → click `switch` on any cached peer model. The peer handles completions, tools still run locally.

The config persists in `.qcode-state/peer-config.json` and survives daemon restarts.

### Environment overrides (legacy, optional)

| Variable | Default | Purpose |
|---|---|---|
| `QCODE_PORT` | `3000` | HTTP port |
| `QCODE_MODEL` | (none) | Path to a local `.gguf` file (bypasses registry) |
| `QCODE_REGISTRY_MODEL` | `qwen3-1.7b` | `qwen3-1.7b`, `qwen3-4b`, `llama-tool-calling` |
| `QCODE_LLAMA_CTX` | `8192` | Context window size |
| `QCODE_PEER_ENABLED` + `QCODE_PEER_TOPIC` + `QCODE_PEER_PUBKEY` | unset | Legacy peer config (prefer UI-based setup) |

## Project structure

```
src/
  agent/
    loop.ts                 ReAct loop (native tool calling + fallback parser)
    models.ts               QvacSdkBackend, LlamaServerBackend (legacy)
    tool-schemas.ts         Zod schemas for tools
    prompt.ts               System prompt (~500 tokens)
    router.ts               Capability router
    runtime-context.ts      Injects model/env info into the system prompt
    backends/
      local-llm.ts          Tier 1: local model
      delegated-peer.ts     Tier 2: P2P to peer
  server/
    index.ts                Daemon entry, SDK boot, probe peer at startup
    routes.ts               HTTP endpoints, session lifecycle
    peer-config.ts          Peer state, probe + switch model + unload
    peer-routes.ts          GET/POST /features/delegated/config, disconnect
    models-routes.ts        /models, /models/switch (handles peer: ids)
    sse.ts                  SSE event channels
    sessions.ts             Session + project store
    features.ts             Opt-in features (voice, vision, delegated)
    voice.ts                Whisper transcription endpoint
    vision.ts               Vision analysis endpoint
    auth.ts                 Shared-secret auth (timing-safe)
  tools/                    read_file, write_file, list_dir, grep, bash, diff, propose_plan
  state/                    Disk persistence
public/
  index.html                PWA shell
  app.js                    Chat UI, SSE, voice, model picker, peer config modal
  style.css                 Inconsolata mono + mint accent
scripts/
  peer-provider.mjs         QVAC provider for delegation (runs on peer)
  peer-preload.mjs          Pre-download a model locally on the peer
  qcode-peer.service        systemd unit for peer auto-start
  install-peer-service.sh   One-shot installer for the service
  test-consumer.mjs         End-to-end delegation smoke test
  smoke-test.sh             Quick agent round-trip test
docs/
  PEER-QUICKSTART.md        Full peer delegation + model switching guide
  DEMO-SCRIPT.md            Demo recording script
  iphone-setup.md           iPhone PWA setup
```

## Tools

| Tool | Description | Approval |
|---|---|---|
| `read_file` | Read a file from the project | Never |
| `write_file` | Write/overwrite a file (full content) | Yes (shows diff) |
| `list_dir` | List directory entries | Never |
| `grep` | ripgrep search with line numbers | Never |
| `bash` | Shell command from project root | Yes for non-allowlisted |
| `diff` | Unified diff between two strings | Never |
| `propose_plan` | Multi-step plan (plan-first mode only) | Yes |
| `reply` | Plain text reply, ends the turn | Never |

## Permission modes

| Mode | Writes | Bash | Use case |
|---|---|---|---|
| `ask` (default) | Approve each | Approve each | Real work |
| `plan-first` | Approve plan, then auto | Approve each | Complex tasks |
| `auto-writes` | Auto-approved | Approve each | Trusted writes |
| `yolo` | Auto-approved | Auto-approved | Demos only |

## Technical decisions

**Qwen3 1.7B as the default.** The SDK's chat template system has first-class support for Qwen3's native `<tool_call>` format. When you pass `tools` to `completion()`, the SDK injects them into the Qwen3 chat template and parses structured tool calls from the output. Reliable out of the box. Qwen3 1.7B fits in ~1 GB of RAM.

**Fallback tool-call parser.** Some models (Qwen2.5 Coder, smaller Qwen3 variants) emit tool calls as `<tool_call>JSON</tool_call>` text or bare JSON. The fallback in `loop.ts` uses brace-balanced extraction to catch these when the SDK's native path misses them.

**Multi-turn memory.** The loop always rebuilds messages with a fresh system prompt, strips old system messages, applies a 20-message sliding window, and drops oldest non-system messages to fit a 6k-token budget (leaving ~2k for system prompt + tools in an 8192-ctx window).

**Hyperswarm same-LAN behavior.** When the Mac and peer share a public IP, `hyperdht` takes a local-address shortcut (see `matchAddress()` in the hyperdht source): it matches peers by subnet and connects directly over 192.168.x.x, bypassing NAT traversal entirely. Same-LAN setups work without any extra config.

## Known limitations

- **Model quality on complex code.** Qwen3 1.7B handles simple tasks (read, write, grep, single-file edits) reliably. Multi-file refactors benefit from peer delegation to a larger model (4B / 8B).
- **Delegate-mode downloads can stall for multi-GB models.** The SDK's Hyperswarm RPC can time out during long registry downloads through delegate mode. Workaround: pre-download on the peer with `peer-preload.mjs` (see [docs/PEER-QUICKSTART.md](./docs/PEER-QUICKSTART.md)). The UI's `pre-download` button copies the right command to your clipboard.
- **Peer cache detection is opportunistic.** qcode tracks which peer models are cached in `peer-config.json`, populated on successful probe + switch. If you delete `.gguf` files on the peer manually, qcode doesn't auto-detect (would require an SSH or custom-RPC listing).
- **GPU on AMD peer.** `@qvac/sdk`'s bundled llama.cpp is CPU-only. An AMD integrated GPU present on the peer (e.g. Vega via Cezanne) is not used. A Vulkan-enabled build of llama.cpp would unlock it.
- **No CORS / CSRF.** Daemon binds to `0.0.0.0` with a shared-secret auth key. Safe for LAN + Tailscale, not for raw public internet.

## License

MIT. See [LICENSE](./LICENSE).
