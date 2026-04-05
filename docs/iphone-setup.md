# qcode — iPhone Setup (5 minutes)

> Open qcode on your iPhone to control your Mac's coding agent from anywhere.

---

## Step 1 — on your Mac, start the daemon

One command — the daemon auto-launches QVAC Fabric LLM as a child process:

```bash
cd ~/code/qcode
npm run serve
```

You'll see QVAC Fabric LLM boot (~5s), then a banner with your URLs and auth key.

You will see a banner like this:

```
────────────────────────────────────────────────────────────────
qcode daemon ready
────────────────────────────────────────────────────────────────
  local:     http://127.0.0.1:3000
  LAN:       http://192.168.10.20:3000  ← open this on your iPhone (same WiFi)
  auth key:  pwa-test-key-abcdef123456
  env:       QCODE_KEY=pwa-test-key-abcdef123456
────────────────────────────────────────────────────────────────
  📱 iPhone deep-link (auto-fills key + project root):
    http://192.168.10.20:3000/#key=XXXX&root=/Users/you/code/qcode
────────────────────────────────────────────────────────────────
```

**Keep both terminals open** while using qcode.

---

## Step 2 — on your iPhone (same WiFi as the Mac)

1. Make sure your iPhone is on the **same WiFi network** as your Mac.
2. Open **Safari**.
3. Type the **deep-link URL** from the banner. It looks like:
   ```
   http://192.168.10.20:3000/#key=...&root=/Users/you/code/qcode
   ```
   (the deep-link auto-fills the auth key and project root — you don't have to paste them)
4. You should see the qcode interface load with a dark theme and status dot turning green.

> If the page fails to load: verify iPhone + Mac are on the same WiFi, Mac's firewall
> isn't blocking port 3000, and both terminal servers are still running.

---

## Step 3 — add to home screen (optional, makes it feel like an app)

1. Tap the **Share** button in Safari (square with arrow up).
2. Scroll down, tap **Add to Home Screen**.
3. Name it "qcode" → tap **Add**.
4. Now you have a qcode icon on your home screen. Launch it — it opens full-screen, no
   browser chrome, feels native.

---

## Step 4 — use it

1. Type a task in the textarea. Examples:
   - `list the files in src/`
   - `add a console.log saying "hello" at the top of src/cli.ts`
   - `grep for TODO in src/ and summarize what's left to do`
2. Tap **run**.
3. Watch events stream in real-time:
   - blue border: tool calls (`read_file`, `list_dir`, etc.)
   - green border: tool results
   - **yellow border + popup**: approval needed (write_file, dangerous bash)
4. When the approval popup appears, **review the diff** and tap **approve** or **reject**.
5. Session finishes when you see a green `done` banner.

---

## Away from home WiFi? Use Tailscale

The instructions above work when your iPhone is on the same WiFi as the Mac. To use
qcode from anywhere (train, coffee shop, another country):

1. Install **Tailscale** on both your Mac and iPhone (free, 2 minutes):
   - Mac: `brew install --cask tailscale`
   - iPhone: App Store → Tailscale
2. Sign in with the same account on both.
3. Replace the LAN IP (`192.168.10.20`) in the URL with your Mac's **Tailscale IP**
   (shown in the Tailscale menubar app, e.g. `100.x.y.z`).
4. That's it. qcode works identically over Tailscale, encrypted end-to-end.

---

## Security notes

- The auth key is required for every API call. Without it, the daemon returns **401**.
- Your code never leaves your Mac. The model runs locally (via QVAC Fabric LLM).
- The iPhone only sees tool results, not your full codebase.
- Every **write** and every **non-allowlisted bash command** requires you to tap approve.
- The project root you set at startup is a **sandbox** — qcode cannot read or write
  files outside it. Attempted escapes throw an error.
- If your phone gets lost: open the daemon terminal and `Ctrl+C` the server. All
  sessions die with it, all pending approvals auto-reject after 5 minutes.
