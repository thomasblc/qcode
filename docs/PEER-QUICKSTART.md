# qcode peer quickstart

P2P delegated inference: run a bigger model on another machine, use it from qcode on your Mac via Hyperswarm. The Mac keeps all tool execution local (filesystem, shell, etc.); only the LLM completions are remote.

This doc covers the WORKING FLOW. For known limitations + UX gaps, see the bottom.

## One-time setup (10 min)

### A. Debian peer machine

Requires: any Linux/macOS box with Node 22+, a LAN IP reachable from the Mac. GPU not required but drastically slows inference if absent.

```bash
# From the Mac, copy the provider + service files
cd /Users/thomasblanc/1_app/qcode
scp scripts/peer-provider.mjs scripts/qcode-peer.service scripts/install-peer-service.sh tom@<peer-ip>:~/qcode-peer/

# SSH with a TTY so sudo works interactively
ssh -t tom@<peer-ip> 'cd ~/qcode-peer && sudo bash install-peer-service.sh'
```

What the install script does:
- Kills any manually-started peer-provider to avoid hypercore-storage lock collision
- Copies `qcode-peer.service` to `/etc/systemd/system/`
- Enables + starts the service
- Prints status

After this, peer-provider runs as a system service: auto-starts on boot, restarts on crash, logs to `~/qcode-peer/peer-provider.log`.

### B. Mac

Start qcode normally:
```bash
cd /Users/thomasblanc/1_app/qcode
npm run serve
```

Open the PWA (http://127.0.0.1:3000 or the Bonjour URL printed), go to Settings → Features → "Delegated inference" toggle → "configure peer…".

Fields are pre-filled with defaults matching the deterministic seed in `qcode-peer.service`:
- Topic: `71636f64652d706565722d64656d6f2d323032362d30342d313500000000000b`
- Pubkey: `7374d29e898c1cc248984abfbdcbdcda591442373f5a7c48df48ab0258db2348`
- Location: `home server` (editable)

Click **connect**. Status goes orange → green in ~10s. The server runs a handshake probe (load Qwen3 1.7B on peer + immediate unload) to verify reachability. That probe marks `qwen3-1.7b` as cached.

Config persists in `.qcode-state/peer-config.json`. Subsequent qcode restarts auto-probe on boot.

## Daily flow (once setup is done)

1. Click the **model** button at the top of the main UI
2. You see three sections:
   - **LOCAL · THIS MAC**: Qwen3 1.7B / 4B on your Mac, click `switch` to use local
   - **REMOTE · P2P PEERS**: Qwen3 1.7B / 4B / 8B on the peer
     - Models marked **"ready"** (green dot) are cached on peer → `switch` works
     - Models marked **"not on peer yet"** (grey dot) → click `pre-download` to copy the CLI command to clipboard, paste in a terminal. After CLI finishes, the model flips to cached on next connect.
   - **DOWNLOAD MORE**: local-only models to download on the Mac
3. Click `switch` on any peer model
   - Cached: ready in 5-10s
   - Peer loads model into RAM, qcode sets `forcePeer=true` on the backend ref
   - Top bar shows "Qwen3 XB · peer" (green, ready)
4. Every chat message now routes to the peer. Tool calls (fs read/write, shell) still run on the Mac.

To revert: click `switch` on any local model. `forcePeer` goes back to false, completions stay local.

## Pre-download a model to the peer (CLI required for big models)

Delegate-mode download from the UI is unreliable for multi-GB models (the Hyperswarm RPC connection times out mid-stream). The reliable path is peer-preload.mjs running LOCALLY on the peer.

When you click `pre-download` on an uncached peer model in the UI, qcode copies this command to your clipboard (replace `<modelKey>` as shown):

```bash
ssh -t tom@<peer-ip> 'sudo systemctl stop qcode-peer' && \
ssh tom@<peer-ip> 'cd ~/qcode-peer && QCODE_PEER_MODEL=<modelKey> node peer-preload.mjs' && \
ssh -t tom@<peer-ip> 'sudo systemctl start qcode-peer'
```

The stop/start is required because peer-provider and peer-preload.mjs both lock the same hypercore-storage corestore (RocksDB file lock).

After the CLI finishes, the model is cached. You still need to tell qcode it's cached — either:
- Click `switch` on it in the UI: the switch will succeed (cached) and auto-add the key to `cachedPeerModels`
- Or edit the JSON directly:
  ```bash
  node -e 'const f=".qcode-state/peer-config.json"; const fs=require("fs"); const c=JSON.parse(fs.readFileSync(f)); c.cachedPeerModels=Array.from(new Set([...(c.cachedPeerModels||[]), "qwen3-8b"])); fs.writeFileSync(f, JSON.stringify(c, null, 2));'
  ```

## Architecture

### Components

- **peer-provider.mjs** (Debian, systemd): starts a @qvac/sdk provider on a Hyperswarm topic, auto-restarts. Loads models on demand when Mac requests via delegate.
- **qcode daemon** (Mac, `npm run serve`): Express + @qvac/sdk. Has two backends:
  - Local `QvacSdkBackend` (primary): the active local model
  - Peer `QvacSdkBackend` with `delegate: {topic, pubkey}` (secondary): loaded when user switches to a peer model
- **Router** (`src/agent/router.ts`): picks backend per request. `DelegatedPeerBackend.canHandle` returns true if `forcePeer` flag is set OR the task looks heavy (prompt > 300 chars or matches keywords like "refactor", "rewrite", "@peer").

### State

- `.qcode-state/peer-config.json`: `{ enabled, topic, providerPublicKey, location, cachedPeerModels[] }`
- `peerBackendRef` (in-memory): `{ ref, status, connectedAt, forcePeer, activeModelKey, loadStatus, ... }`

### Code map

- [src/server/peer-config.ts](../src/server/peer-config.ts): config persistence, `probePeer()` (handshake verification), `switchPeerModel()` (loads + keeps + marks cached, aborts stale via `loadAttemptId`), `unloadPeerBackend()`
- [src/server/peer-routes.ts](../src/server/peer-routes.ts): GET/POST `/features/delegated/config`, POST `/features/delegated/disconnect`
- [src/server/models-routes.ts](../src/server/models-routes.ts): GET `/models` (local + peer options with cached flag), POST `/models/switch` (handles `peer:qwen3-8b`-style ids)
- [src/agent/backends/delegated-peer.ts](../src/agent/backends/delegated-peer.ts): DelegatedPeerBackend, checks `forcePeer` or `looksHeavy()`
- [scripts/peer-provider.mjs](../scripts/peer-provider.mjs): QVAC provider on Debian
- [scripts/peer-preload.mjs](../scripts/peer-preload.mjs): local download helper on Debian (not via delegate)
- [scripts/qcode-peer.service](../scripts/qcode-peer.service): systemd unit
- [scripts/install-peer-service.sh](../scripts/install-peer-service.sh): one-shot installer

## Health / reset

```bash
# is peer service running?
ssh tom@<peer-ip> 'systemctl --no-pager status qcode-peer | head -10'

# live peer logs
ssh tom@<peer-ip> 'tail -f ~/qcode-peer/peer-provider.log'

# what's cached on peer?
ssh tom@<peer-ip> 'ls -lh ~/.qvac/models/ ~/llm-models/'

# qcode thinks?
curl -s -H "x-qcode-key: $(cat .qcode-state/auth-key)" http://127.0.0.1:3000/features/delegated/config | python3 -m json.tool
curl -s -H "x-qcode-key: $(cat .qcode-state/auth-key)" http://127.0.0.1:3000/models | python3 -m json.tool
```

Full reset:
```bash
# Mac
pkill -9 -f "tsx src/server/index.ts" ; pkill -9 -f bare-runtime ; sleep 2
rm -f .qcode-state/peer-config.json

# Debian
ssh -t tom@<peer-ip> 'sudo systemctl restart qcode-peer'

# back up
cd /Users/thomasblanc/1_app/qcode && npm run serve
```

Then hard-refresh PWA (Cmd+Shift+R) + redo the connect step.

## Known limitations + UX gaps

These are NOT fixed. They're the known rough edges of the current implementation.

1. **UI download for big models is unreliable**. When you click a peer model with cached=false, the reliable path is to copy the CLI command. Doing it through the UI's delegate-mode loadModel would trigger a multi-GB download inside a Hyperswarm RPC that times out.

2. **Cache detection is based on internal tracking, not actual peer state**. If you delete `~/.qvac/models/xxx.gguf` on Debian manually, qcode still thinks it's cached until next switch fails. False positive possible.

3. **Probe uses Qwen3 1.7B as handshake test**. If the peer doesn't have it cached, first `connect` triggers a ~1 min download of 1.7B. Subsequent connects are ~10s.

4. **No progress for delegate downloads**. The @qvac/sdk doesn't reliably forward `onProgress` events through delegate mode, so the UI shows 0% while the peer downloads. Only elapsed time advances. This is why we recommend CLI for downloads.

5. **Peer-provider and peer-preload can't run concurrently**. They both lock the same hypercore-storage RocksDB corestore. The CLI pre-download command wraps stop/start systemd to handle this.

6. **No SSH automation from qcode to peer**. Pre-downloads and status checks require the user to copy commands and run them manually. An SSH-from-daemon feature would enable true one-click operation but requires SSH config in qcode state.

7. **Perf on CPU-only peer is slower than local GPU**. With no GPU on Debian, even a 1.7B model runs ~3x slower per token than Mac's Metal GPU. The peer is valuable only for models that don't fit locally (14B+). For small models, local Mac wins.

8. **No custom path UI**. The `peer:path` code path exists in types but isn't surfaced in the model picker. You can only select pre-defined registry constants (1.7B, 4B, 8B).

See the end of the interview prep chat log for discussion + proposals for each.
