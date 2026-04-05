// qcode PWA: chat-style UI. Vanilla JS, no build step.
const LS_KEY = "qcode.key";
const LS_ROOT = "qcode.projectRoot";
const LS_MODE = "qcode.mode";
const LS_SIDEBAR = "qcode.sidebar";
const LS_ONBOARDED = "qcode.onboarded";

const $ = (id) => document.getElementById(id);
const els = {
  setup: $("setup"), app: $("app"), onboarding: $("onboarding"),
  reopenOnboardingBtn: $("reopenOnboarding"),
  obStep1: $("obStep1"), obStep2: $("obStep2"), obStep3: $("obStep3"), obStep4: $("obStep4"),
  obNext1: $("obNext1"), obNext2: $("obNext2"), obNext3: $("obNext3"), obFinish: $("obFinish"),
  obBack2: $("obBack2"), obBack3: $("obBack3"), obBack4: $("obBack4"),
  obKeyInput: $("obKeyInput"), obRootInput: $("obRootInput"), obBrowseBtn: $("obBrowseBtn"),
  obFeatureList: $("obFeatureList"),
  obModelList: $("obModelList"), obRamInfo: $("obRamInfo"),
  keyInput: $("keyInput"), rootInput: $("rootInput"), browseBtn: $("browseBtn"), saveSetup: $("saveSetup"),
  setupClose: $("setupClose"),
  settingsFeatureList: $("settingsFeatureList"),
  tabs: document.querySelectorAll(".tabs .tab"),
  tabConfig: $("tab-config"), tabFeatures: $("tab-features"),
  sidebar: $("sidebar"), sidebarList: $("sidebarList"), toggleSidebarBtn: $("toggleSidebarBtn"),
  newChatBtn: $("newChatBtn"), settingsBtn: $("settingsBtn"),
  msgInput: $("msgInput"), sendBtn: $("sendBtn"), stopBtn: $("stopBtn"), contextLine: $("contextLine"),
  camBtn: $("camBtn"),
  micBtn: $("micBtn"), waveform: $("waveform"),
  events: $("events"), chatMeta: $("chatMeta"), copyChatBtn: $("copyChatBtn"), downloadChatBtn: $("downloadChatBtn"),
  modelBtn: $("modelBtn"),
  agentIndicator: $("agentIndicator"), agentDot: $("agentDot"), agentStateLabel: $("agentStateLabel"),
  modelBackdrop: $("modelBackdrop"), modelClose: $("modelClose"), modelList: $("modelList"),
  peerList: $("peerList"),
  peerConfigBackdrop: $("peerConfigBackdrop"), peerConfigClose: $("peerConfigClose"),
  peerStatusLine: $("peerStatusLine"),
  peerTopicInput: $("peerTopicInput"), peerPubkeyInput: $("peerPubkeyInput"),
  peerLocationInput: $("peerLocationInput"),
  peerConnectBtn: $("peerConnectBtn"), peerDisconnectBtn: $("peerDisconnectBtn"),
  downloadList: $("downloadList"), downloadProgress: $("downloadProgress"),
  backdrop: $("approvalBackdrop"), approvalTitle: $("approvalTitle"), approvalDetail: $("approvalDetail"),
  approveBtn: $("approveBtn"), rejectBtn: $("rejectBtn"),
  folderBackdrop: $("folderBackdrop"), folderClose: $("folderClose"), folderPath: $("folderPath"),
  folderList: $("folderList"), folderSelect: $("folderSelect"),
  modeButtons: document.querySelectorAll(".mode-bar .mode"),
};

let state = {
  key: localStorage.getItem(LS_KEY) || "",
  projectRoot: localStorage.getItem(LS_ROOT) || "",
  mode: localStorage.getItem(LS_MODE) || "ask",
  sessionId: null,          // currently attached session
  sessionStatus: null,      // running | done | error | stopped | awaiting_approval | null
  eventSource: null,
  pendingApproval: null,
  currentFolderPath: null,
  thinkingEl: null,         // live-streaming token element (pre inside current turn)
  currentTurn: null,        // DOM element for the current iteration
  // Highest server event id seen on this session. Passed as ?since= when the
  // stream is reopened on a continue, so the server does NOT replay events
  // from previous turns. Without this, the client receives the previous
  // turn's done event during replay, which triggers closeStream() mid-replay
  // and hides the current turn's events. Reset to 0 on new session.
  lastEventId: 0,
};

// ─── URL hash bootstrap ───
(function loadFromHash() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const k = params.get("key"); const r = params.get("root");
  if (k) { state.key = k; localStorage.setItem(LS_KEY, k); }
  if (r) { state.projectRoot = r; localStorage.setItem(LS_ROOT, r); }
  history.replaceState(null, "", location.pathname);
})();

// ─── Screen switching ───
function hideAll() {
  els.setup.hidden = true; els.app.hidden = true; els.onboarding.hidden = true;
}
function showOnboarding() {
  hideAll();
  els.onboarding.hidden = false;
  showObStep(1);
  els.obKeyInput.value = state.key; els.obRootInput.value = state.projectRoot;
}
function showSetup() {
  hideAll();
  els.setup.hidden = false;
  els.keyInput.value = state.key; els.rootInput.value = state.projectRoot;
}
function showApp() {
  hideAll();
  els.app.hidden = false;
  els.contextLine.textContent = "📁 " + state.projectRoot;
  syncModeButtons(); syncSidebar(); refreshSidebar();
}

function showObStep(n) {
  els.obStep1.hidden = n !== 1;
  els.obStep2.hidden = n !== 2;
  els.obStep3.hidden = n !== 3;
  els.obStep4.hidden = n !== 4;
}

// ─── Onboarding wizard ───
// Re-trigger the wizard from Settings (tab config). Closes the settings
// screen and shows step 1 of the 4-step onboarding. The existing key/root
// stay cached so the user can breeze through or re-configure.
if (els.reopenOnboardingBtn) {
  els.reopenOnboardingBtn.addEventListener("click", () => {
    els.setup.hidden = true;
    els.app.hidden = true;
    els.onboarding.hidden = false;
    showObStep(1);
    // Pre-fill the wizard with current values if any
    if (state.key && els.obKeyInput) els.obKeyInput.value = state.key;
    if (state.projectRoot && els.obRootInput) els.obRootInput.value = state.projectRoot;
  });
}

els.obNext1.addEventListener("click", () => showObStep(2));
els.obBack2.addEventListener("click", () => showObStep(1));
els.obBack3.addEventListener("click", () => showObStep(2));
els.obBack4.addEventListener("click", () => showObStep(3));
els.obNext2.addEventListener("click", () => {
  const k = els.obKeyInput.value.trim();
  const r = els.obRootInput.value.trim();
  if (!k) { alert("please paste the auth key"); els.obKeyInput.focus(); return; }
  if (!r) { alert("please set a project root"); els.obRootInput.focus(); return; }
  state.key = k; state.projectRoot = r;
  localStorage.setItem(LS_KEY, k); localStorage.setItem(LS_ROOT, r);
  loadLLMCatalog();
  showObStep(3);
});
els.obNext3.addEventListener("click", () => {
  loadFeatures();
  showObStep(4);
});

// ─── LLM catalog with RAM-based recommendations ───
async function loadLLMCatalog(targetEl) {
  const target = targetEl || els.obModelList;
  target.innerHTML = '<p class="muted small">checking your system…</p>';
  try {
    const [sysRes, catRes] = await Promise.all([
      fetch("/system/info", { headers: { "x-qcode-key": state.key } }),
      fetch("/downloads/catalog", { headers: { "x-qcode-key": state.key } }),
    ]);
    if (!sysRes.ok || !catRes.ok) { target.innerHTML = `<p class="muted small">failed to load catalog</p>`; return; }
    const sys = await sysRes.json();
    const data = await catRes.json();
    if (els.obRamInfo) els.obRamInfo.textContent = `your ${sys.totalRamGB} GB ${sys.arch === "arm64" ? "Apple Silicon" : ""} Mac`;
    target.innerHTML = "";

    // Badge colors by fit
    const fitStyle = {
      "recommended": { color: "var(--qvac-green)", label: "✓ recommended" },
      "tight":       { color: "var(--warn)",       label: "⚠ tight, may swap" },
      "wont-fit":    { color: "var(--bad)",        label: "✗ won't fit" },
    };
    const qualityBadge = {
      fast:     "fast",
      balanced: "balanced",
      strong:   "strong",
    };

    // Sort: recommended first, then tight, then wont-fit
    const order = { "recommended": 0, "tight": 1, "wont-fit": 2 };
    data.catalog.sort((a, b) => (order[a.fit] - order[b.fit]) || a.sizeGB - b.sizeGB);

    for (const m of data.catalog) {
      const fit = m.fit ? fitStyle[m.fit] : null;
      const qualityLabel = m.quality ? (qualityBadge[m.quality] || m.quality) : "";
      const ramLine = m.recommendedRamGB != null ? `${m.sizeGB} GB download · needs ${m.recommendedRamGB}+ GB RAM` : `${m.sizeGB} GB download`;
      const desc = m.description ? escapeHtml(m.description) : "";
      const item = document.createElement("div");
      item.className = "feature-card" + (m.installed ? " active" : "");
      item.style.cursor = "pointer";
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
              <strong style="font-family:var(--mono)">${escapeHtml(m.name)}</strong>
              ${qualityLabel ? `<span class="badge" style="font-size:9px;padding:2px 6px;border:1px solid var(--qvac-border-teal);border-radius:3px;color:var(--qvac-muted);font-family:var(--mono);text-transform:uppercase">${escapeHtml(qualityLabel)}</span>` : ""}
            </div>
            ${desc ? `<div class="meta" style="color:var(--qvac-muted);font-size:11px;line-height:1.4">${desc}</div>` : ""}
            <div class="meta" style="color:var(--qvac-muted);font-size:10px;margin-top:4px;font-family:var(--mono)">${ramLine}</div>
            ${fit ? `<div class="meta" style="color:${fit.color};font-size:11px;margin-top:6px;font-family:var(--mono)">${fit.label}${m.installed ? " · ✓ already downloaded" : ""}</div>` : (m.installed ? `<div class="meta" style="color:var(--qvac-green);font-size:11px;margin-top:6px;font-family:var(--mono)">✓ already downloaded</div>` : "")}
          </div>
          <button class="dl-btn primary" ${m.fit === "wont-fit" || m.installed ? "disabled" : ""} style="font-size:11px;padding:6px 12px;white-space:nowrap">${m.installed ? "installed" : "download"}</button>
        </div>`;
      if (!m.installed && m.fit !== "wont-fit") {
        item.querySelector(".dl-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          e.target.textContent = "downloading…";
          e.target.disabled = true;
          try {
            const r = await fetch("/downloads/start", {
              method: "POST",
              headers: { "content-type": "application/json", "x-qcode-key": state.key },
              body: JSON.stringify({ id: m.id }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            toast(`downloading ${m.name}…`, "var(--warn)");
            // Poll for completion
            const poll = setInterval(async () => {
              const s = await fetch("/downloads/status", { headers: { "x-qcode-key": state.key } });
              const sd = await s.json();
              if (!sd.active || sd.active.status !== "downloading") {
                clearInterval(poll);
                if (sd.active?.status === "done") toast(`${m.name} installed`, "var(--qvac-green)");
                else toast(`download failed`, "var(--bad)");
                loadLLMCatalog(target);
              } else {
                const mb = Math.round(sd.active.sizeBytes / 1e6);
                e.target.textContent = `${mb} MB…`;
              }
            }, 1200);
          } catch (err) {
            toast(`failed: ${err.message || err}`, "var(--bad)");
            e.target.textContent = "download"; e.target.disabled = false;
          }
        });
      }
      target.appendChild(item);
    }
  } catch (e) {
    target.innerHTML = `<p class="muted small">error: ${escapeHtml(String(e))}</p>`;
  }
}
els.obBrowseBtn.addEventListener("click", () => {
  if (!els.obKeyInput.value.trim()) { alert("paste auth key first"); els.obKeyInput.focus(); return; }
  state.key = els.obKeyInput.value.trim();
  localStorage.setItem(LS_KEY, state.key);
  folderPickerTarget = els.obRootInput;
  openFolderPicker(els.obRootInput.value.trim() || null);
});
els.obFinish.addEventListener("click", () => {
  localStorage.setItem(LS_ONBOARDED, "1");
  showApp(); checkHealth();
});

async function loadFeatures() {
  els.obFeatureList.innerHTML = '<p class="muted small">loading features…</p>';
  try {
    const res = await fetch("/features", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) { els.obFeatureList.innerHTML = `<p class="muted small">failed: HTTP ${res.status}</p>`; return; }
    const data = await res.json();
    els.obFeatureList.innerHTML = "";
    for (const def of data.catalog) {
      const st = data.states.find(s => s.id === def.id) || { enabled: false, status: "off", downloadProgress: null };
      const totalMB = Math.round(def.models.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
      const pct = Math.round((st.downloadProgress ?? 0) * 100);
      const statusLabel =
        st.status === "installing" ? `⬇ installing ${pct}%` :
        st.status === "ready"      ? "✓ already downloaded" :
        st.status === "error"      ? `✗ ${st.error ?? "error"}` :
        `${totalMB} MB download`;
      const statusColor =
        st.status === "ready"      ? "var(--qvac-green)" :
        st.status === "installing" ? "var(--warn)" :
        st.status === "error"      ? "var(--bad)" : "var(--qvac-muted)";
      const item = document.createElement("div");
      item.className = "feature-card" + (st.status === "ready" ? " active" : "");
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:10px">
          <div style="flex:1">
            <div><span style="margin-right:6px">${def.icon}</span><strong>${escapeHtml(def.name)}</strong></div>
            <div class="meta" style="color:var(--qvac-muted);font-size:11px;line-height:1.4">${escapeHtml(def.description)}</div>
            <div class="meta" style="color:${statusColor};font-size:11px;margin-top:6px;font-family:var(--mono)">${escapeHtml(statusLabel)}</div>
          </div>
          <label class="ob-toggle">
            <input type="checkbox" data-feature="${def.id}" ${st.enabled ? "checked" : ""} />
            <span class="ob-toggle-slider"></span>
          </label>
        </div>`;
      item.querySelector("input[type=checkbox]").addEventListener("change", async (e) => {
        const on = e.target.checked;
        const url = `/features/${def.id}/${on ? "enable" : "disable"}`;
        await fetch(url, { method: "POST", headers: { "x-qcode-key": state.key } });
        // Refresh after a short delay to pick up new status
        setTimeout(loadFeatures, 500);
      });
      els.obFeatureList.appendChild(item);
    }
  } catch (e) {
    els.obFeatureList.innerHTML = `<p class="muted small">error: ${escapeHtml(String(e))}</p>`;
  }
}

els.saveSetup.addEventListener("click", () => {
  const k = els.keyInput.value.trim(); const r = els.rootInput.value.trim();
  if (!k) { alert("please paste the auth key from your terminal"); els.keyInput.focus(); return; }
  if (!r) { alert("please set a project root (tap 'browse' to pick one)"); els.rootInput.focus(); return; }
  state.key = k; state.projectRoot = r;
  localStorage.setItem(LS_KEY, k); localStorage.setItem(LS_ROOT, r);
  showApp(); checkHealth();
});
els.settingsBtn.addEventListener("click", showSetup);
els.setupClose.addEventListener("click", () => {
  if (state.key && state.projectRoot) showApp();
  // Refresh the cached vision readiness so the camera button picks up
  // any toggle the user just made in the Features tab.
  refreshVisionReady();
});

// ─── Settings tabs ───
els.tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    els.tabs.forEach(t => t.classList.toggle("active", t === tab));
    els.tabConfig.hidden = target !== "config";
    els.tabFeatures.hidden = target !== "features";
    if (target === "features") loadSettingsFeatures();
  });
});

let featuresPollTimer = null;
function scheduleFeaturesPoll(ms) {
  if (featuresPollTimer) clearTimeout(featuresPollTimer);
  featuresPollTimer = setTimeout(loadSettingsFeatures, ms);
}

function toast(msg, color = "var(--qvac-green)") {
  const t = document.createElement("div");
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--qvac-black);border:1px solid ${color};color:${color};padding:10px 16px;border-radius:8px;font-family:var(--mono);font-size:13px;z-index:1000;box-shadow:0 8px 24px rgba(0,0,0,0.5);animation:fadeIn 140ms ease-out;`;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity 200ms"; setTimeout(() => t.remove(), 250); }, 2000);
}

async function loadSettingsFeatures() {
  const target = els.settingsFeatureList;
  if (!target.children.length) target.innerHTML = '<p class="muted small">loading…</p>';
  try {
    const res = await fetch("/features", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) { target.innerHTML = `<p class="muted small">failed: HTTP ${res.status}</p>`; return; }
    const data = await res.json();
    target.innerHTML = "";
    for (const def of data.catalog) {
      const st = data.states.find(s => s.id === def.id) || { enabled: false, status: "off", downloadProgress: null };
      const totalMB = Math.round(def.models.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
      const pct = Math.round((st.downloadProgress ?? 0) * 100);
      const statusLabel =
        st.status === "installing" ? `⬇ installing ${pct}%` :
        st.status === "ready"      ? "✓ ready, downloaded & active" :
        st.status === "error"      ? `✗ ${st.error ?? "error"}` :
        "off, not downloaded";
      const statusColor =
        st.status === "ready"      ? "var(--qvac-green)" :
        st.status === "installing" ? "var(--warn)" :
        st.status === "error"      ? "var(--bad)" : "var(--qvac-muted)";
      const item = document.createElement("div");
      item.className = "feature-card" + (st.status === "ready" ? " active" : "");
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;gap:12px">
          <div style="flex:1">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <span style="font-size:16px">${def.icon}</span>
              <strong style="font-family:var(--mono)">${escapeHtml(def.name)}</strong>
            </div>
            <div class="meta" style="color:var(--qvac-muted);font-size:11px;line-height:1.4">${escapeHtml(def.description)}</div>
            ${totalMB > 0 ? `<div class="meta" style="color:var(--qvac-muted);font-size:10px;margin-top:4px;font-family:var(--mono)">${totalMB} MB</div>` : ""}
            <div class="feature-status" style="color:${statusColor};font-size:11px;margin-top:6px;font-family:var(--mono)">${escapeHtml(statusLabel)}</div>
            ${st.status === "installing" ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
          </div>
          <label class="ob-toggle">
            <input type="checkbox" data-feature="${def.id}" ${st.enabled ? "checked" : ""} />
            <span class="ob-toggle-slider"></span>
          </label>
        </div>`;
      // For the delegated-inference feature, add a "Configure peer..."
      // button that opens the peer config modal. The main toggle still
      // enables/disables the feature itself; the configure action is
      // separate because it requires topic + pubkey + model choice.
      if (def.id === "delegated") {
        const configBtn = document.createElement("button");
        configBtn.type = "button";
        configBtn.textContent = "configure peer…";
        configBtn.className = "peer-configure-btn";
        configBtn.style.cssText = "margin-top:8px;font-family:var(--mono);font-size:11px;padding:5px 10px;background:transparent;border:1px solid var(--qvac-border-teal);border-radius:5px;color:var(--qvac-green);cursor:pointer";
        configBtn.addEventListener("click", (e) => { e.stopPropagation(); openPeerConfig(); });
        item.querySelector("div[style*='flex:1']").appendChild(configBtn);
      }
      const checkbox = item.querySelector("input[type=checkbox]");
      checkbox.addEventListener("change", async (e) => {
        const on = e.target.checked;
        // Optimistic UI: immediately update the status line
        const statusEl = item.querySelector(".feature-status");
        if (on) {
          statusEl.textContent = "⬇ installing…";
          statusEl.style.color = "var(--warn)";
        } else {
          statusEl.textContent = "off, disabled";
          statusEl.style.color = "var(--qvac-muted)";
          item.classList.remove("active");
        }
        try {
          const url = `/features/${def.id}/${on ? "enable" : "disable"}`;
          const r = await fetch(url, { method: "POST", headers: { "x-qcode-key": state.key } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          toast(`${def.name} ${on ? "enabled" : "disabled"}`, "var(--qvac-green)");
        } catch (err) {
          toast(`failed: ${err.message || err}`, "var(--bad)");
          checkbox.checked = !on; // revert
        }
        scheduleFeaturesPoll(500);
      });
      target.appendChild(item);
    }
    // Keep polling while any feature is installing
    if (data.states.some(s => s.status === "installing")) {
      scheduleFeaturesPoll(1200);
    }
  } catch (e) {
    target.innerHTML = `<p class="muted small">error: ${escapeHtml(String(e))}</p>`;
  }
}

// ─── Delegated peer configuration modal ───
// Reads + writes .qcode-state/peer-config.json through the server. The
// modal form stays in sync with the server state via a short poll while
// it is open, so the user sees status change from idle → connecting →
// connected (or error) in real time after clicking "connect".
let peerPollTimer = null;
function setPeerStatusDisplay(status, detail, connectedAt) {
  if (!els.peerStatusLine) return;
  els.peerStatusLine.className = "peer-status-line is-" + status;
  const text = els.peerStatusLine.querySelector(".peer-status-text");
  text.textContent = status;
  // Append a relative time when connected, or the error text otherwise.
  const existing = els.peerStatusLine.querySelector(".peer-status-detail");
  if (existing) existing.remove();
  if (detail) {
    const d = document.createElement("span");
    d.className = "peer-status-detail";
    d.textContent = detail;
    els.peerStatusLine.appendChild(d);
  } else if (status === "connected" && connectedAt) {
    const d = document.createElement("span");
    d.className = "peer-status-detail";
    const secs = Math.round((Date.now() - connectedAt) / 1000);
    d.textContent = secs < 60 ? `connected ${secs}s ago` : `connected ${Math.round(secs / 60)}m ago`;
    els.peerStatusLine.appendChild(d);
  }
}
async function fetchPeerConfig() {
  const res = await fetch("/features/delegated/config", { headers: { "x-qcode-key": state.key } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
// Known-good defaults for the "reference" peer-provider setup: deterministic
// topic hardcoded in scripts/peer-provider.mjs, deterministic pubkey derived
// from seed 0000...0042 (the value hardcoded in scripts/qcode-peer.service).
// When a user first opens the config modal with no saved state, we pre-fill
// these so they can just click connect. If they run a custom peer-provider
// with a different seed, they override these manually.
const PEER_DEFAULT_TOPIC  = "71636f64652d706565722d64656d6f2d323032362d30342d313500000000000b";
const PEER_DEFAULT_PUBKEY = "7374d29e898c1cc248984abfbdcbdcda591442373f5a7c48df48ab0258db2348";

async function openPeerConfig() {
  els.peerConfigBackdrop.hidden = false;
  try {
    const data = await fetchPeerConfig();
    const c = data.config || {};
    els.peerTopicInput.value = c.topic || PEER_DEFAULT_TOPIC;
    els.peerPubkeyInput.value = c.providerPublicKey || PEER_DEFAULT_PUBKEY;
    els.peerLocationInput.value = c.location || "home server";
    setPeerStatusDisplay(data.status || "idle", data.error || null, data.connectedAt);
    // Start polling while the modal is open so status reflects live
    // progress of the handshake probe (idle → connecting → connected).
    if (peerPollTimer) clearInterval(peerPollTimer);
    peerPollTimer = setInterval(async () => {
      if (els.peerConfigBackdrop.hidden) {
        clearInterval(peerPollTimer); peerPollTimer = null; return;
      }
      try {
        const next = await fetchPeerConfig();
        setPeerStatusDisplay(next.status || "idle", next.error || null, next.connectedAt);
      } catch { /* keep polling */ }
    }, 1500);
  } catch (e) {
    toast(`failed to read peer config: ${e.message || e}`, "var(--bad)");
  }
}
function closePeerConfig() {
  els.peerConfigBackdrop.hidden = true;
  if (peerPollTimer) { clearInterval(peerPollTimer); peerPollTimer = null; }
}
els.peerConfigClose.addEventListener("click", closePeerConfig);
els.peerConfigBackdrop.addEventListener("click", (e) => {
  if (e.target === els.peerConfigBackdrop) closePeerConfig();
});
els.peerConnectBtn.addEventListener("click", async () => {
  const body = {
    enabled: true,
    topic: els.peerTopicInput.value.trim(),
    providerPublicKey: els.peerPubkeyInput.value.trim(),
    location: els.peerLocationInput.value.trim() || "Remote peer",
  };
  els.peerConnectBtn.disabled = true;
  try {
    const r = await fetch("/features/delegated/config", {
      method: "POST",
      headers: { "content-type": "application/json", "x-qcode-key": state.key },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(`connect failed: ${data.error || `HTTP ${r.status}`}`, "var(--bad)");
      return;
    }
    setPeerStatusDisplay(data.status || "connecting", data.error || null, null);
    toast("peer config saved, probing handshake…", "var(--qvac-green)");
  } catch (e) {
    toast(`connect error: ${e.message || e}`, "var(--bad)");
  } finally {
    els.peerConnectBtn.disabled = false;
  }
});
els.peerDisconnectBtn.addEventListener("click", async () => {
  els.peerDisconnectBtn.disabled = true;
  try {
    const r = await fetch("/features/delegated/disconnect", {
      method: "POST",
      headers: { "x-qcode-key": state.key },
    });
    if (!r.ok) {
      toast(`disconnect failed: HTTP ${r.status}`, "var(--bad)");
      return;
    }
    setPeerStatusDisplay("idle", null, null);
    toast("peer disconnected", "var(--qvac-muted)");
  } catch (e) {
    toast(`disconnect error: ${e.message || e}`, "var(--bad)");
  } finally {
    els.peerDisconnectBtn.disabled = false;
  }
});
// ─── Sidebar ───
function syncSidebar() {
  const collapsed = localStorage.getItem(LS_SIDEBAR) === "collapsed";
  els.sidebar.classList.toggle("collapsed", collapsed);
}
els.toggleSidebarBtn.addEventListener("click", () => {
  // On mobile: toggle open class. On desktop: toggle collapsed class.
  const isMobile = window.innerWidth <= 768;
  if (isMobile) els.sidebar.classList.toggle("open");
  else {
    const collapsed = !els.sidebar.classList.contains("collapsed");
    els.sidebar.classList.toggle("collapsed", collapsed);
    localStorage.setItem(LS_SIDEBAR, collapsed ? "collapsed" : "open");
  }
});
els.newChatBtn.addEventListener("click", () => {
  state.sessionId = null; state.sessionStatus = null;
  closeStream(); els.events.innerHTML = ""; state.thinkingEl = null;
  els.sidebar.classList.remove("open");
  els.msgInput.focus();
  renderActiveSidebar();
});

async function refreshSidebar() {
  try {
    const res = await fetch("/sessions", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) return;
    const { sessions } = await res.json();
    if (!sessions.length) { els.sidebarList.innerHTML = '<p class="muted small" style="padding:8px">no sessions yet</p>'; return; }
    els.sidebarList.innerHTML = "";
    for (const s of sessions) {
      const item = document.createElement("div");
      item.className = `sidebar-item status-${s.status}`;
      item.dataset.sid = s.id;
      if (s.id === state.sessionId) item.classList.add("active");
      const when = new Date(s.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      item.innerHTML = `
        <div class="sidebar-item-main">
          ${escapeHtml(s.prompt.slice(0, 40))}
          <span class="when">${when} · ${s.mode || "ask"}</span>
        </div>
        <button class="sidebar-item-del" title="delete this chat" aria-label="delete chat">✕</button>`;
      item.querySelector(".sidebar-item-main").addEventListener("click", () => loadSession(s.id));
      item.querySelector(".sidebar-item-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(s.id);
      });
      els.sidebarList.appendChild(item);
    }
  } catch {}
}
function renderActiveSidebar() {
  document.querySelectorAll(".sidebar-item").forEach(el => {
    el.classList.toggle("active", el.dataset.sid === state.sessionId);
  });
}

// Minimal, safe-enough markdown renderer for assistant replies.
// Supported: headings (# ## ###), bold (**), italic (*), inline code (`),
// fenced code blocks (```), links, bullet lists, numbered lists, line
// breaks. All user content is escaped FIRST so raw HTML never runs. No
// third-party lib kept for the "local-first, small bundle" ethos.
function renderMarkdown(src) {
  if (!src) return "";
  // Escape HTML entities first. All transformations below produce known
  // safe HTML tags, so we can insert them after this initial escape.
  const escapeHtmlLocal = (s) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  // Extract fenced code blocks FIRST and replace them with placeholders,
  // so the rest of the transformations don't touch their contents.
  const codeBlocks = [];
  let s = src.replace(/```([\w-]*)?\n([\s\S]*?)```/g, (_m, lang, code) => {
    const i = codeBlocks.length;
    codeBlocks.push({ lang: lang || "", code: escapeHtmlLocal(code.replace(/\n$/, "")) });
    return `§§CODEBLOCK${i}§§`;
  });

  s = escapeHtmlLocal(s);

  // Small models (Qwen3 1.7B especially) often emit numbered lists on a
  // single line: "1. foo 2. bar 3. baz". Insert a newline before each
  // " N. " pattern where N is 1-20 so the list regex below can catch it.
  // Limit to 1-20 to avoid accidentally splitting " 2026. " (year).
  s = s.replace(/([^\n]) ([1-9]|1[0-9]|20)\. (?=[^\n])/g, "$1\n$2. ");

  // Headings (must be on their own line)
  s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^# (.+)$/gm, "<h2>$1</h2>");

  // Bold and italic. Bold first so ** isn't misread as two *.
  s = s.replace(/\*\*([^\*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\*])\*([^\*\n]+)\*/g, "$1<em>$2</em>");

  // Inline code
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Links [text](url). We only allow http, https, mailto.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered lists: lines starting with "- " or "* "
  s = s.replace(/(?:^|\n)((?:[\-\*] .+\n?)+)/g, (match) => {
    const items = match.trim().split("\n").map(l => l.replace(/^[\-\*] /, "")).map(l => `<li>${l}</li>`).join("");
    return `\n<ul>${items}</ul>`;
  });

  // Ordered lists: lines starting with "1. " "2. " etc. (loose match)
  s = s.replace(/(?:^|\n)((?:\d+\. .+\n?)+)/g, (match) => {
    const items = match.trim().split("\n").map(l => l.replace(/^\d+\. /, "")).map(l => `<li>${l}</li>`).join("");
    return `\n<ol>${items}</ol>`;
  });

  // Line breaks: double newline = paragraph, single newline = <br> inside paragraph
  s = s.split(/\n{2,}/).map(para => {
    // Don't wrap block-level elements in <p>
    if (/^\s*<(h[234]|ul|ol|pre|blockquote)/.test(para)) return para;
    return `<p>${para.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");

  // Restore code blocks
  s = s.replace(/§§CODEBLOCK(\d+)§§/g, (_m, i) => {
    const { lang, code } = codeBlocks[Number(i)];
    const cls = lang ? ` class="lang-${lang}"` : "";
    return `<pre><code${cls}>${code}</code></pre>`;
  });

  return s;
}

// Custom confirm modal matching the QVAC design. Returns a Promise
// that resolves to true (confirmed) or false (cancelled). Replaces the
// native window.confirm so the UX stays consistent with the rest of
// the PWA (dark backdrop, mint primary, destructive variant). Handles
// Escape to cancel and Enter to confirm.
function showConfirm({ title, body, okLabel = "confirm", cancelLabel = "cancel", danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById("confirmBackdrop");
    const titleEl = document.getElementById("confirmTitle");
    const bodyEl = document.getElementById("confirmBody");
    const okBtn = document.getElementById("confirmOk");
    const cancelBtn = document.getElementById("confirmCancel");
    if (!backdrop || !titleEl || !bodyEl || !okBtn || !cancelBtn) {
      // Graceful fallback if the modal markup is missing
      resolve(window.confirm(`${title}\n\n${body}`));
      return;
    }
    titleEl.textContent = title;
    bodyEl.textContent = body;
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle("danger", !!danger);
    backdrop.hidden = false;

    function cleanup(result) {
      backdrop.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === backdrop) cleanup(false); }
    function onKey(e) {
      if (e.key === "Escape") cleanup(false);
      else if (e.key === "Enter") cleanup(true);
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    cancelBtn.focus();
  });
}

// Delete a chat from history. Aborts it server-side if still running,
// then removes from the in-memory store and persists. If the deleted
// session is the currently loaded one, the chat panel is cleared.
async function deleteChat(sessionId) {
  const confirmed = await showConfirm({
    title: "delete this chat?",
    body: "this removes the session and its events from history. cannot be undone.",
    okLabel: "delete",
    cancelLabel: "keep it",
    danger: true,
  });
  if (!confirmed) return;
  try {
    const res = await fetch(`/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "x-qcode-key": state.key },
    });
    if (!res.ok) {
      const err = await res.text();
      toast("delete failed: " + err.slice(0, 200), "var(--bad)");
      return;
    }
    if (state.sessionId === sessionId) {
      closeStream();
      state.sessionId = null;
      state.lastEventId = 0;
      els.events.innerHTML = "";
      els.chatMeta.textContent = "";
    }
    await refreshSidebar();
  } catch (e) {
    toast("delete error: " + (e.message || e), "var(--bad)");
  }
}

async function loadSession(sessionId) {
  closeStream(); els.events.innerHTML = ""; state.thinkingEl = null;
  els.sidebar.classList.remove("open");
  state.sessionId = sessionId;
  state.lastEventId = 0;   // reset stream cursor for the newly loaded session
  renderActiveSidebar();
  try {
    const res = await fetch(`/sessions/${sessionId}/snapshot?since=0`, { headers: { "x-qcode-key": state.key } });
    if (!res.ok) { addEvent("error", { message: `HTTP ${res.status}` }); return; }
    const data = await res.json();
    state.sessionStatus = data.status;
    // Re-render all events (including the user's original prompt)
    const sessionDetail = await fetch(`/sessions/${sessionId}`, { headers: { "x-qcode-key": state.key } }).then(r => r.json()).catch(() => null);
    if (sessionDetail?.session?.prompt) addEvent("user_msg", { content: sessionDetail.session.prompt });
    for (const evt of data.events) {
      if (typeof evt.id === "number" && evt.id > state.lastEventId) state.lastEventId = evt.id;
      addEvent(evt.type, evt.data);
    }
    if (!data.closed) { openStream(sessionId); setRunning(true); } else { setRunning(false); }
  } catch (e) { addEvent("error", { message: String(e) }); }
}

// ─── Mode selector ───
function syncModeButtons() {
  els.modeButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.mode === state.mode));
}
els.modeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode;
    localStorage.setItem(LS_MODE, state.mode);
    syncModeButtons();
  });
});

// ─── Folder picker ───
async function openFolderPicker(atPath) {
  const key = state.key || els.keyInput.value.trim();
  if (!key) { alert("paste the auth key first, then tap browse"); els.keyInput.focus(); return; }
  els.folderBackdrop.hidden = false;
  els.folderList.innerHTML = '<p class="muted small">loading…</p>';
  try {
    const url = atPath ? `/fs/list?path=${encodeURIComponent(atPath)}` : "/fs/list";
    const res = await fetch(url, { headers: { "x-qcode-key": key } });
    if (!res.ok) { els.folderList.innerHTML = `<p class="muted">error: HTTP ${res.status}</p>`; return; }
    const data = await res.json();
    state.currentFolderPath = data.path;
    els.folderPath.textContent = data.displayPath;
    els.folderList.innerHTML = "";
    if (data.parent) {
      const up = document.createElement("div");
      up.className = "folder-entry parent";
      up.innerHTML = `<span>⬆</span><span>${escapeHtml(data.parentDisplay)}</span>`;
      up.addEventListener("click", () => openFolderPicker(data.parent));
      els.folderList.appendChild(up);
    }
    for (const e of data.entries) {
      const item = document.createElement("div");
      item.className = "folder-entry";
      item.innerHTML = `<span>📁</span><span>${escapeHtml(e.name)}</span>`;
      item.addEventListener("click", () => openFolderPicker(e.path));
      els.folderList.appendChild(item);
    }
    if (data.entries.length === 0) els.folderList.innerHTML += '<p class="muted small" style="padding:8px">(no sub-folders)</p>';
  } catch (e) { els.folderList.innerHTML = `<p class="muted">error: ${escapeHtml(String(e))}</p>`; }
}
let folderPickerTarget = null; // which input receives the chosen path
els.browseBtn.addEventListener("click", () => {
  folderPickerTarget = els.rootInput;
  openFolderPicker((els.rootInput.value.trim() || state.projectRoot) || null);
});
els.folderClose.addEventListener("click", () => { els.folderBackdrop.hidden = true; });
els.folderSelect.addEventListener("click", () => {
  if (!state.currentFolderPath) return;
  const target = folderPickerTarget || els.rootInput;
  target.value = state.currentFolderPath;
  els.folderBackdrop.hidden = true;
});

// ─── Health + model state ───
async function checkHealth() {
  try {
    const res = await fetch("/health");
    const j = await res.json();
    if (j.status !== "ok") throw new Error();
  } catch {
    els.modelBtn.textContent = "offline";
    els.modelBtn.className = "tag tag-btn bad";
    setAgentState("idle");
    return;
  }
  await refreshModelState();
}
async function refreshModelState() {
  if (!state.key) return;
  try {
    const res = await fetch("/models", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) return;
    const data = await res.json();
    // A peer model can be the active backend via forcePeer: it's not in
    // data.models, it's in data.peers. Check both so the top bar
    // doesn't show "no model" while a peer is actually handling
    // completions.
    const activePeer = (data.peers ?? []).find(p => p.active);
    const activeLocal = data.models.find(m => m.active);
    const label = activePeer
      ? `${activePeer.modelName} · peer`
      : activeLocal
        ? activeLocal.displayName
        : "no model";
    const status = data.state.status;
    const isReady = activePeer ? true : status === "ready";
    els.modelBtn.textContent = isReady ? label : status === "starting" || status === "stopping" ? "loading…" : status === "error" ? "error" : label;
    els.modelBtn.className = "tag tag-btn " + (isReady ? "ready" : status === "error" ? "bad" : "loading");
  } catch {}
}

// ─── Model switcher ───
els.modelBtn.addEventListener("click", openModelPicker);
els.modelClose.addEventListener("click", () => { els.modelBackdrop.hidden = true; });
async function openModelPicker() {
  els.modelBackdrop.hidden = false;
  els.modelList.innerHTML = '<p class="muted small">loading…</p>';
  try {
    const res = await fetch("/models", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) { els.modelList.innerHTML = `<p class="muted">HTTP ${res.status}</p>`; return; }
    const data = await res.json();
    els.modelList.innerHTML = "";
    if (data.models.length === 0) {
      els.modelList.innerHTML = '<p class="muted small">no installed models, download one below</p>';
    } else { els.modelList.innerHTML = ""; }
    for (const m of data.models) {
      const item = document.createElement("div");
      item.className = "model-entry" + (m.active ? " active" : "");
      item.innerHTML = `
        <div>
          <div>${escapeHtml(m.displayName)}</div>
          <div class="meta">${m.sizeGB} GB · ${escapeHtml(m.name)} · <span style="color:var(--qvac-muted)">on this Mac</span></div>
        </div>
        ${m.active ? '<span class="active-badge">active</span>' : '<button class="switch-btn">switch</button>'}`;
      if (!m.active) {
        item.querySelector(".switch-btn").addEventListener("click", (e) => { e.stopPropagation(); switchModel(m.name); });
      }
      els.modelList.appendChild(item);
    }
    renderPeers(data.peers || []);
    await refreshDownloadCatalog();
  } catch (e) { els.modelList.innerHTML = `<p class="muted">error: ${escapeHtml(String(e))}</p>`; }
}

// Render the P2P peers section of the model picker. Shows each configured
// peer with its model, location, and connection status. The action button
// is disabled when the peer is not connected (the daemon is still waiting
// for the Hyperswarm handshake, or the peer-provider is not running).
function renderPeers(peers) {
  if (!els.peerList) return;
  els.peerList.innerHTML = "";
  if (peers.length === 0) {
    els.peerList.innerHTML = '<p class="muted small" style="padding:8px">no peer configured. open Settings → Features → configure peer to add one.</p>';
    return;
  }
  for (const p of peers) {
    const connected = p.status === "connected";
    const active = p.active === true;
    const loading = p.loading === true;
    const cached = p.cached === true;
    const dotColor = loading ? "var(--warn)" : (connected && cached) ? "var(--qvac-green)" : "var(--qvac-muted)";
    const statusLabel = loading
      ? "loading…"
      : active
        ? "active"
        : !connected
          ? "peer offline"
          : cached
            ? "ready"
            : "not on peer yet";
    const sizeLabel = p.approxSizeGB > 0 ? `${p.approxSizeGB} GB · ` : "";
    const item = document.createElement("div");
    item.className = "model-entry" + (active ? " active" : "");
    // Switch is only exposed for cached peer models. Uncached ones get
    // a "pre-download via CLI" button that copies the command (the
    // delegate-mode download inside loadModel is not reliable for
    // multi-GB models because the Hyperswarm RPC times out mid-stream).
    const btnLabel = loading
      ? "loading…"
      : active
        ? "active"
        : (connected && cached)
          ? "switch"
          : connected
            ? "pre-download"
            : "unavailable";
    const btnDisabled = !connected || active || loading;
    const btnTitle = active
      ? "this peer model handles every request — pick a local model to revert"
      : loading
        ? "peer is loading this model, wait…"
        : !connected
          ? "peer offline or still handshaking"
          : cached
            ? "load this model on the peer and route every request to it"
            : "model not on the peer yet. click to copy the CLI command that pre-downloads it";
    item.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};display:inline-block;${connected && cached ? "box-shadow:0 0 6px " + dotColor : ""}"></span>
          <strong>${escapeHtml(p.modelName)}</strong>
        </div>
        <div class="meta">${sizeLabel}${escapeHtml(p.location)} · ${escapeHtml(p.transport)} · <span style="color:${dotColor}">${statusLabel}</span></div>
      </div>
      <button class="switch-btn peer-switch-btn" data-peer-id="${escapeHtml(p.id)}" data-cached="${cached ? "1" : "0"}" ${btnDisabled ? "disabled" : ""} title="${escapeHtml(btnTitle)}">${btnLabel}</button>`;
    const btn = item.querySelector(".peer-switch-btn");
    if (btn && connected && !active && !loading) {
      if (cached) {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await fetch("/models/switch", {
              method: "POST",
              headers: { "content-type": "application/json", "x-qcode-key": state.key },
              body: JSON.stringify({ model: p.id }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok && r.status !== 202) {
              toast(`switch failed: ${data.error || `HTTP ${r.status}`}`, "var(--bad)"); return;
            }
            toast(`loading ${p.modelName} on peer…`, "var(--qvac-green)");
            const start = Date.now();
            while (Date.now() - start < 2 * 60 * 60 * 1000) {
              await new Promise(r => setTimeout(r, 1500));
              const s = await fetch("/models", { headers: { "x-qcode-key": state.key } });
              if (!s.ok) break;
              const d = await s.json();
              const me = (d.peers ?? []).find(x => x.id === p.id);
              if (me && me.active) { toast(`peer ready (${p.modelName})`, "var(--qvac-green)"); break; }
              if (d.peerStatus === "error") { toast(`peer load error`, "var(--bad)"); break; }
            }
            await openModelPicker();
            await refreshModelState();
          } catch (e) {
            toast(`switch error: ${e.message || e}`, "var(--bad)");
          } finally {
            btn.disabled = false;
          }
        });
      } else {
        // Uncached peer model: clicking copies the CLI pre-download
        // command. Downloading through delegate mode is unreliable for
        // big models (the Hyperswarm RPC times out during the download),
        // so we surface the reliable path instead of letting the user
        // click switch and hit a partial download failure.
        btn.addEventListener("click", async () => {
          const modelKey = p.id.replace(/^peer:/, "");
          // Use `;` not `&&` so the final start always runs even if the
          // middle download fails. Otherwise a timeout on the QVAC
          // registry side would leave peer-provider stopped and the user
          // has to remember to restart it manually.
          const cmd = `ssh -t tom@192.168.10.25 'sudo systemctl stop qcode-peer' ; ssh tom@192.168.10.25 'cd ~/qcode-peer && QCODE_PEER_MODEL=${modelKey} node peer-preload.mjs' ; ssh -t tom@192.168.10.25 'sudo systemctl start qcode-peer'`;
          // Try the modern API first, fall back to a hidden textarea
          // because some browsers (Brave with strict settings, older
          // contexts) reject navigator.clipboard on http://localhost.
          let copied = false;
          try {
            await navigator.clipboard.writeText(cmd);
            copied = true;
          } catch {
            try {
              const ta = document.createElement("textarea");
              ta.value = cmd;
              ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
              document.body.appendChild(ta);
              ta.select();
              copied = document.execCommand("copy");
              document.body.removeChild(ta);
            } catch { /* fall through */ }
          }
          if (copied) {
            toast(`CLI command copied — paste in a terminal to pre-download ${p.modelName}`, "var(--qvac-green)");
          } else {
            // Last-resort: show the command in an alert so the user can
            // select it with the system dialog.
            window.prompt(`copy failed, select + copy the command below:`, cmd);
          }
        });
      }
    }
    els.peerList.appendChild(item);
  }
}

async function refreshDownloadCatalog() {
  try {
    const res = await fetch("/downloads/catalog", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) return;
    const data = await res.json();
    els.downloadList.innerHTML = "";
    // Sort: recommended > tight > wont-fit
    const order = { "recommended": 0, "tight": 1, "wont-fit": 2 };
    const notInstalled = data.catalog.filter(x => !x.installed)
      .sort((a, b) => (order[a.fit] - order[b.fit]) || a.sizeGB - b.sizeGB);
    const fitStyle = {
      "recommended": { color: "var(--qvac-green)", label: "✓ recommended" },
      "tight":       { color: "var(--warn)",       label: "⚠ tight" },
      "wont-fit":    { color: "var(--bad)",        label: "✗ won't fit" },
    };
    for (const m of notInstalled) {
      const fit = m.fit ? fitStyle[m.fit] : null;
      const ramLine = m.recommendedRamGB != null ? `${m.sizeGB} GB · needs ${m.recommendedRamGB}+ GB RAM` : `${m.sizeGB} GB`;
      const item = document.createElement("div");
      item.className = "model-entry";
      item.style.alignItems = "flex-start";
      item.innerHTML = `
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <strong style="font-size:12px">${escapeHtml(m.name)}</strong>
            ${m.quality ? `<span style="font-size:9px;padding:1px 5px;border:1px solid var(--qvac-border-teal);border-radius:3px;color:var(--qvac-muted);text-transform:uppercase;font-family:var(--mono)">${escapeHtml(m.quality)}</span>` : ""}
          </div>
          <div class="meta" style="font-size:10px;margin-top:2px">${ramLine}</div>
          ${fit ? `<div class="meta" style="color:${fit.color};font-size:10px;margin-top:2px">${fit.label}</div>` : ""}
        </div>
        <button class="switch-btn download-btn" ${m.fit === "wont-fit" ? "disabled" : ""} data-id="${escapeHtml(m.id)}">⬇ download</button>`;
      if (m.fit !== "wont-fit") {
        item.querySelector(".download-btn").addEventListener("click", (e) => { e.stopPropagation(); startDownload(m.id); });
      }
      els.downloadList.appendChild(item);
    }
    if (notInstalled.length === 0) {
      els.downloadList.innerHTML = '<p class="muted small" style="padding:8px">all recommended models already downloaded</p>';
    }
    if (data.active && data.active.status === "downloading") {
      showDownloadProgress(data.active);
      pollDownloadProgress();
    }
  } catch {}
}

async function startDownload(id) {
  try {
    const res = await fetch("/downloads/start", {
      method: "POST",
      headers: { "content-type": "application/json", "x-qcode-key": state.key },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) { const err = await res.text(); addEvent("error", { message: `download failed: HTTP ${res.status}: ${err.slice(0, 200)}` }); return; }
    const data = await res.json();
    showDownloadProgress(data.job);
    pollDownloadProgress();
  } catch (e) { addEvent("error", { message: String(e) }); }
}

function showDownloadProgress(job) {
  const mb = Math.round(job.sizeBytes / 1_000_000);
  els.downloadProgress.textContent = `⬇ downloading ${job.filename}: ${mb} MB` + (job.status === "done" ? " ✓" : job.status === "error" ? ` ✗ ${job.error}` : "…");
  els.downloadProgress.hidden = false;
}

let downloadPollTimer = null;
function pollDownloadProgress() {
  if (downloadPollTimer) return;
  downloadPollTimer = setInterval(async () => {
    try {
      const res = await fetch("/downloads/status", { headers: { "x-qcode-key": state.key } });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.active) { clearInterval(downloadPollTimer); downloadPollTimer = null; els.downloadProgress.hidden = true; return; }
      showDownloadProgress(data.active);
      if (data.active.status === "done" || data.active.status === "error") {
        clearInterval(downloadPollTimer); downloadPollTimer = null;
        if (data.active.status === "done") { openModelPicker(); }
        setTimeout(() => { els.downloadProgress.hidden = true; }, 3000);
      }
    } catch {}
  }, 1500);
}
async function switchModel(modelName) {
  els.modelBackdrop.hidden = true;
  els.modelBtn.textContent = "loading…";
  els.modelBtn.className = "tag tag-btn loading";
  try {
    const res = await fetch("/models/switch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-qcode-key": state.key },
      body: JSON.stringify({ model: modelName }),
    });
    if (!res.ok) { addEvent("error", { message: `switch failed: HTTP ${res.status}` }); return; }
    // Poll /models until status becomes ready or error
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      await new Promise(r => setTimeout(r, 1000));
      await refreshModelState();
      const statusTxt = els.modelBtn.textContent;
      if (statusTxt !== "loading…" && !statusTxt.includes("loading")) break;
    }
  } catch (e) { addEvent("error", { message: String(e) }); }
}

// ─── Running state ───
function setRunning(running) {
  els.stopBtn.hidden = !running;
  els.sendBtn.disabled = running;
  state.sessionStatus = running ? "running" : state.sessionStatus;
}

// ─── Send (new session OR continue) ───
async function sendMessage() {
  const content = els.msgInput.value.trim();
  if (!content || !state.key || !state.projectRoot) return;
  if (els.sendBtn.disabled) return;

  els.msgInput.value = "";
  const isContinue = state.sessionId && state.sessionStatus && state.sessionStatus !== "running" && state.sessionStatus !== "awaiting_approval";
  closeStream();
  setRunning(true);

  try {
    if (isContinue) {
      addEvent("user_msg", { content });
      const res = await fetch(`/sessions/${state.sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-qcode-key": state.key },
        body: JSON.stringify({ content, mode: state.mode }),
      });
      if (!res.ok) { addEvent("error", { message: `HTTP ${res.status}: ${await res.text()}` }); setRunning(false); return; }
      openStream(state.sessionId);
    } else {
      // New session: clear the events pane BEFORE adding the first user_msg,
      // otherwise the user sees their prompt twice (the bubble added pre-clear
      // used to be duplicated by a second addEvent call after the clear).
      els.events.innerHTML = "";
      addEvent("user_msg", { content });
      state.lastEventId = 0;   // fresh stream, replay from start
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-qcode-key": state.key },
        body: JSON.stringify({ prompt: content, projectRoot: state.projectRoot, mode: state.mode }),
      });
      if (!res.ok) { addEvent("error", { message: `HTTP ${res.status}: ${await res.text()}` }); setRunning(false); return; }
      const { sessionId } = await res.json();
      state.sessionId = sessionId;
      openStream(sessionId);
      refreshSidebar();
    }
  } catch (err) { addEvent("error", { message: String(err) }); setRunning(false); }
}
els.sendBtn.addEventListener("click", sendMessage);
els.msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});

// ─── Stop ───
els.stopBtn.addEventListener("click", async () => {
  if (!state.sessionId) return;
  try {
    await fetch(`/sessions/${state.sessionId}/stop`, { method: "POST", headers: { "x-qcode-key": state.key } });
  } catch (e) { addEvent("error", { message: String(e) }); }
});

// ─── Voice input (whisper via @qvac/sdk) ───
let voiceState = {
  recording: false,
  stream: null,
  recorder: null,
  chunks: [],
  audioCtx: null,
  analyser: null,
  rafId: null,
};

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // Browsers block mic access on insecure contexts. localhost/127.0.0.1 are
    // considered secure, but http://<hostname>.local and http://<lan-ip> are not.
    const host = location.hostname;
    const isSecure = window.isSecureContext;
    const hint = isSecure
      ? "your browser does not support audio recording."
      : `mic requires https. open qcode via http://127.0.0.1:3000 on your Mac, or use Tailscale (https://100.x.x.x) from your iPhone. current host: ${host}`;
    toast(hint, "var(--bad)");
    addEvent("error", { message: `mic: ${hint}` });
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceState.stream = stream;
    // Live waveform via Web Audio
    const AC = window.AudioContext || window.webkitAudioContext;
    voiceState.audioCtx = new AC();
    const source = voiceState.audioCtx.createMediaStreamSource(stream);
    const analyser = voiceState.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    voiceState.analyser = analyser;
    drawWaveform();

    const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    voiceState.recorder = mr;
    voiceState.chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size > 0) voiceState.chunks.push(e.data); };
    mr.onstop = onRecordingStop;
    mr.start();
    voiceState.recording = true;
    els.micBtn.classList.add("recording");
    els.waveform.hidden = false;
  } catch (e) {
    toast(`mic error: ${e.message || e}`, "var(--bad)");
  }
}

async function stopRecording() {
  if (!voiceState.recording || !voiceState.recorder) return;
  voiceState.recording = false;
  els.micBtn.classList.remove("recording");
  try { voiceState.recorder.stop(); } catch { /* noop */ }
}

async function onRecordingStop() {
  // Tear down audio graph
  if (voiceState.rafId) cancelAnimationFrame(voiceState.rafId);
  voiceState.rafId = null;
  if (voiceState.stream) voiceState.stream.getTracks().forEach(t => t.stop());
  voiceState.stream = null;
  if (voiceState.audioCtx) { try { await voiceState.audioCtx.close(); } catch { /* noop */ } }
  voiceState.audioCtx = null; voiceState.analyser = null;
  els.waveform.hidden = true;

  const blob = new Blob(voiceState.chunks, { type: "audio/webm" });
  if (blob.size < 2000) { toast("recording too short", "var(--warn)"); return; }

  // POST to /transcribe
  const placeholder = els.msgInput.value;
  els.msgInput.value = "⏳ transcribing…";
  els.msgInput.disabled = true;
  try {
    const res = await fetch("/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm", "x-qcode-key": state.key },
      body: blob,
    });
    if (!res.ok) {
      const err = await res.text();
      toast(`transcription failed: HTTP ${res.status}`, "var(--bad)");
      addEvent("error", { message: `/transcribe: ${err.slice(0, 200)}` });
      els.msgInput.value = placeholder;
      return;
    }
    const data = await res.json();
    const text = (data.text || "").trim();
    if (!text) { toast("no speech detected", "var(--warn)"); els.msgInput.value = placeholder; return; }
    els.msgInput.value = placeholder ? `${placeholder} ${text}` : text;
    els.msgInput.focus();
  } catch (e) {
    toast(`transcription error: ${e.message || e}`, "var(--bad)");
    els.msgInput.value = placeholder;
  } finally {
    els.msgInput.disabled = false;
  }
}

function drawWaveform() {
  const ctx = els.waveform.getContext("2d");
  const analyser = voiceState.analyser;
  if (!ctx || !analyser) return;
  const W = els.waveform.width = els.waveform.offsetWidth * devicePixelRatio;
  const H = els.waveform.height = els.waveform.offsetHeight * devicePixelRatio;
  const data = new Uint8Array(analyser.frequencyBinCount);
  const step = () => {
    if (!voiceState.analyser) return;
    analyser.getByteTimeDomainData(data);
    ctx.fillStyle = "#171817";
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.strokeStyle = "#16E3C1";
    ctx.beginPath();
    const slice = W / data.length;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * H) / 2;
      if (i === 0) ctx.moveTo(i * slice, y);
      else ctx.lineTo(i * slice, y);
    }
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    voiceState.rafId = requestAnimationFrame(step);
  };
  step();
}

// Press-and-hold (mobile) + click-to-toggle (desktop)
let micHoldTimer = null;
els.micBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  micHoldTimer = setTimeout(() => { micHoldTimer = "held"; startRecording(); }, 150);
});
els.micBtn.addEventListener("pointerup", (e) => {
  e.preventDefault();
  if (micHoldTimer === "held") {
    stopRecording();
  } else if (micHoldTimer) {
    clearTimeout(micHoldTimer);
    // Short tap → toggle mode
    if (voiceState.recording) stopRecording(); else startRecording();
  }
  micHoldTimer = null;
});
els.micBtn.addEventListener("pointercancel", () => {
  if (micHoldTimer === "held") stopRecording();
  micHoldTimer = null;
});

// ─── Vision input (camera / photo via POST /vision) ───
// Hidden file input that opens the native camera on iOS or file picker on desktop.
const camFileInput = document.createElement("input");
camFileInput.type = "file";
camFileInput.accept = "image/*";
camFileInput.setAttribute("capture", "environment");
camFileInput.style.display = "none";
document.body.appendChild(camFileInput);

// Cache vision-ready state so the click handler can fire the native
// file input synchronously. iOS Safari rejects .click() calls that
// happen AFTER an async await, because the user-gesture context is
// lost between ticks. We refresh the cache on load, on settings
// reopen, and after toggling the vision feature.
let visionReady = false;
async function refreshVisionReady() {
  if (!state.key) { visionReady = false; return; }
  try {
    const res = await fetch("/features", { headers: { "x-qcode-key": state.key } });
    if (!res.ok) { visionReady = false; return; }
    const data = await res.json();
    const vision = data.states.find(s => s.id === "vision");
    visionReady = !!(vision && vision.enabled && vision.status === "ready");
  } catch {
    visionReady = false;
  }
}
refreshVisionReady();

els.camBtn.addEventListener("click", () => {
  if (!visionReady) {
    toast("enable vision in settings first", "var(--warn)");
    // Kick off a refresh in case the user just enabled it; we'll be
    // ready next click.
    refreshVisionReady();
    return;
  }
  camFileInput.value = "";
  // Synchronous .click() while still inside the user-gesture tick:
  // iOS Safari accepts this and opens the native camera/photo picker.
  camFileInput.click();
});

camFileInput.addEventListener("change", async () => {
  const file = camFileInput.files && camFileInput.files[0];
  if (!file) return;

  // Read the prompt from the composer (if user typed something), else use default
  const userPrompt = els.msgInput.value.trim();
  const prompt = userPrompt || "Describe this image in detail";

  // Clear the prompt input if we consumed it
  if (userPrompt) els.msgInput.value = "";

  // Show a user bubble with the prompt + image indicator
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const userDiv = document.createElement("div");
  userDiv.className = "event user_msg";
  userDiv.dataset.ts = ts;
  userDiv.innerHTML = `<span class="label">you</span><span class="ts">${ts}</span><span>${escapeHtml(prompt)} [image: ${escapeHtml(file.name)}]</span>`;
  els.events.appendChild(userDiv);
  userDiv.scrollIntoView({ behavior: "smooth", block: "end" });

  // Show a loading bubble
  const loadDiv = document.createElement("div");
  loadDiv.className = "event assistant_reply";
  loadDiv.dataset.ts = ts;
  loadDiv.innerHTML = `<span class="label">qcode</span><span class="ts">${ts}</span><div class="reply-body vision-loading">analyzing image...</div>`;
  els.events.appendChild(loadDiv);
  loadDiv.scrollIntoView({ behavior: "smooth", block: "end" });

  // Pulse the camera button while processing
  els.camBtn.classList.add("processing");

  try {
    const buf = await file.arrayBuffer();
    const headers = {
      "content-type": file.type || "image/png",
      "x-qcode-key": state.key,
      "x-qcode-prompt": encodeURIComponent(prompt),
    };
    // Tell the server which project root the session should be pinned to.
    // Without it, the server falls back to process.cwd() which is usually
    // the qcode repo itself, fine but wrong for a user working elsewhere.
    if (state.projectRoot) headers["x-qcode-project-root"] = state.projectRoot;
    // If a session is already loaded, append this vision turn to it so
    // the other device (which may be viewing the same session) receives
    // the user_msg + reply events through SSE. Without this header,
    // every vision call made a fresh session and cross-device sync
    // broke: Mac viewing session X could not see an iPhone vision turn
    // that had just created session Y.
    if (state.sessionId) headers["x-qcode-session-id"] = state.sessionId;
    const res = await fetch("/vision", {
      method: "POST",
      headers,
      body: buf,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      loadDiv.remove();
      toast("vision failed: " + (err.error || `HTTP ${res.status}`), "var(--bad)");
      return;
    }
    const data = await res.json();
    // Replace the loading bubble with the actual result
    const resultTs = new Date();
    const rts = `${String(resultTs.getHours()).padStart(2, "0")}:${String(resultTs.getMinutes()).padStart(2, "0")}`;
    loadDiv.dataset.ts = rts;
    loadDiv.querySelector(".ts").textContent = rts;
    const body = loadDiv.querySelector(".reply-body");
    body.classList.remove("vision-loading");
    body.innerHTML = renderMarkdown(data.text || "(no response)");
    // The vision endpoint persists each interaction as its own session so
    // it shows up in the sidebar history. Wire the current view to that
    // new session id so follow-up interactions stay in the same turn
    // log, and refresh the sidebar so the entry appears.
    if (data.sessionId && !state.sessionId) {
      state.sessionId = data.sessionId;
      state.lastEventId = 0;
    }
    refreshSidebar();
  } catch (e) {
    loadDiv.remove();
    toast("vision error: " + (e.message || e), "var(--bad)");
  } finally {
    els.camBtn.classList.remove("processing");
  }
});

// ─── Agent state indicator ───
function setAgentState(agentState, hint) {
  if (!els.agentIndicator) return;
  // Strip all state-* classes
  els.agentIndicator.className = "agent-indicator state-" + agentState;
  const label = hint ? `${agentState.replace(/_/g, " ")} · ${hint}` : agentState.replace(/_/g, " ");
  els.agentStateLabel.textContent = label;
}

// ─── SSE stream ───
function openStream(sessionId) {
  closeStream();
  // Pass ?since=<lastEventId> so the server does NOT replay events we've
  // already seen. Critical for continue: without this, the server replays
  // the previous turn's done event during reconnect, which triggers
  // closeStream() mid-replay and hides the current turn's events.
  const url = `/sessions/${sessionId}/stream?key=${encodeURIComponent(state.key)}&since=${state.lastEventId || 0}`;
  const es = new EventSource(url);
  state.eventSource = es;
  const handle = (e) => {
    try {
      const evt = JSON.parse(e.data);
      // Track the highest event id we've seen. Events arrive in order per
      // SSE, so evt.id monotonically increases. Used for ?since= on reconnect.
      if (typeof evt.id === "number" && evt.id > state.lastEventId) state.lastEventId = evt.id;
      if (evt.type === "token") { appendThinking(evt.data); return; }
      if (evt.type === "iteration") state.thinkingEl = null;
      if (evt.type === "state") {
        setAgentState(evt.data.state, evt.data.hint);
        // Router emits "thinking" state with a hint like "routing via instant"
        // when it dispatches. Show it in the task-progress route slot so the
        // user sees which backend is handling the turn.
        if (evt.data.hint && typeof evt.data.hint === "string" && evt.data.hint.startsWith("routing via ")) {
          const turn = ensureCurrentTurn();
          const routeEl = turn.querySelector(".tp-route");
          if (routeEl) routeEl.textContent = "· " + evt.data.hint.slice("routing via ".length);
        }
        return;
      }
      addEvent(evt.type, evt.data);
      if (evt.type === "approval_request") { setAgentState("waiting_approval"); showApproval(sessionId, evt.data); }
      if (evt.type === "done" || evt.type === "error") {
        closeStream(); setRunning(false);
        state.sessionStatus = evt.type === "done" ? "done" : "error";
        setAgentState(evt.type === "done" ? "done" : "idle");
        refreshSidebar();
        // Re-subscribe to the same session after a short delay so any
        // follow-up turn triggered from ANOTHER device (e.g. iPhone
        // typing while Mac watches) streams in live instead of
        // requiring a manual chat switch. Uses lastEventId to avoid
        // replaying events we already saw.
        if (state.sessionId === sessionId) {
          setTimeout(() => {
            if (state.sessionId === sessionId && !state.eventSource) openStream(sessionId);
          }, 600);
        }
      }
    } catch {}
  };
  for (const t of ["iteration","token","assistant_text","tool_call","tool_result","approval_request","approval_resolved","state","user_msg","done","error"]) {
    es.addEventListener(t, handle);
  }
}
function closeStream() { if (state.eventSource) { state.eventSource.close(); state.eventSource = null; } }

// ─── Live thinking tokens (no-op in collapsed UI) ───
// Tokens are dropped on the floor in the compact UI. The task-progress row
// shows WHAT the agent is doing via tool_call events, which is enough.
function appendThinking(_token) { /* suppressed */ }

// ─── Compact task progress ───
// Instead of stacking a turn-row per iteration, we maintain ONE updating
// "task progress" line while the agent works. The detailed step list is
// hidden behind an optional expand toggle on the final result card.
// `state.taskSteps` accumulates the per-iteration steps so they can be
// revealed on demand.

function startNewTurn() {
  // Reset the step log (this is called per iteration. We treat the very
  // first iteration as the task start, and subsequent ones as step updates).
  if (!state.currentTurn) {
    const div = document.createElement("div");
    div.className = "task-progress";
    div.innerHTML = `
      <span class="tp-dot"></span>
      <span class="tp-label">thinking…</span>
      <span class="tp-route"></span>
      <span class="tp-counter"></span>`;
    els.events.appendChild(div);
    div.scrollIntoView({ behavior: "smooth", block: "end" });
    state.currentTurn = div;
    state.taskSteps = [];
    state.taskIteration = 0;
  }
  state.taskIteration++;
  updateTaskCounter();
}

function ensureCurrentTurn() {
  if (state.currentTurn) return state.currentTurn;
  const div = document.createElement("div");
  div.className = "task-progress";
  div.innerHTML = `
    <span class="tp-dot"></span>
    <span class="tp-label">thinking…</span>
    <span class="tp-route"></span>
    <span class="tp-counter"></span>`;
  els.events.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  state.currentTurn = div;
  state.taskSteps = [];
  state.taskIteration = 0;
  return div;
}

function updateTaskCounter() {
  if (!state.currentTurn) return;
  const counter = state.currentTurn.querySelector(".tp-counter");
  if (counter) counter.textContent = state.taskIteration > 1 ? `step ${state.taskIteration}` : "";
}

function updateTurnCall(_turn, toolName, args) {
  if (!state.currentTurn) return;
  const label = state.currentTurn.querySelector(".tp-label");
  const human = humanizeToolCall(toolName, args);
  if (label) label.textContent = human;
  state.taskSteps.push({ tool: toolName, args, label: human, status: "running" });
}

function renderTaskResult(summary, steps) {
  const div = document.createElement("div");
  div.className = "task-result";
  const count = steps.length;
  div.innerHTML = `
    <div class="tr-head">
      <span class="tr-icon">✓</span>
      <span class="tr-summary"></span>
      ${count > 0 ? `<span class="tr-expand">${count} step${count > 1 ? "s" : ""}</span>` : ""}
    </div>
    <div class="tr-detail"></div>`;
  // The summary from the agent is the final reply() text, which may
  // contain markdown (bold, lists, code). Render it so **x** shows as
  // bold, backticks as inline code, etc.
  div.querySelector(".tr-summary").innerHTML = renderMarkdown(summary);
  const expand = div.querySelector(".tr-expand");
  const detail = div.querySelector(".tr-detail");
  for (const s of steps) {
    const row = document.createElement("div");
    row.className = "tr-step";
    row.textContent = `${s.status === "fail" ? "✗" : "→"} ${s.label}`;
    detail.appendChild(row);
  }
  if (expand) {
    expand.addEventListener("click", () => div.classList.toggle("expanded"));
  }
  els.events.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
}

function humanizeToolCall(toolName, args) {
  const a = args || {};
  switch (toolName) {
    case "read_file":   return `reading ${a.path}`;
    case "write_file":  return `writing ${a.path}`;
    case "list_dir":    return `listing ${a.path || "."}`;
    case "grep":        return `searching "${a.pattern}"`;
    case "bash":        return `running \`${String(a.command || "").slice(0, 40)}\``;
    case "diff":        return `computing diff`;
    case "propose_plan":return `proposing plan`;
    case "reply":       return `replying`;
    case "done":        return `finishing`;
    default:            return toolName;
  }
}

function updateTurnResult(_turn, toolName, result) {
  if (toolName === "done" || toolName === "reply") {
    // reply/done get their own rendering elsewhere. Keep the progress row
    // around so the done handler can swap it for a result card.
    return;
  }
  // Mark the last step as finished and update the label briefly with result
  const last = state.taskSteps[state.taskSteps.length - 1];
  if (last) {
    last.status = (result && result.ok === false) ? "fail" : "ok";
    last.result = result;
  }
  return;
}

// Legacy code below still receives tool_result and tries to render details.
// We short-circuit above; keep the rest as a no-op branch so the old code
// path doesn't crash if something hits it.
function __legacyTurnResult(turn, toolName, result) {
  if (toolName === "done" || toolName === "reply") { return; }
  const r = result || {};
  const ok = r.ok === true;
  turn.classList.remove("running");
  turn.classList.add(ok ? "ok" : "fail");
  const head = turn.querySelector(".turn-head");
  head.querySelector(".arrow").textContent = "→";
  let sum = "";
  if (!ok) sum = r.error || "fail";
  else if (toolName === "list_dir" && r.entries) sum = `${r.entries.length} entries`;
  else if (toolName === "read_file" && r.bytes) sum = `${r.bytes} bytes`;
  else if (toolName === "grep" && r.matches) {
    const lines = String(r.matches).split("\n").filter(Boolean).length;
    sum = String(r.matches).startsWith("(no matches)") ? "no matches" : `${lines} matches`;
  }
  else if (toolName === "bash" && r.exitCode != null) sum = `exit ${r.exitCode}`;
  else if (toolName === "write_file" && r.bytesWritten != null) {
    sum = `${r.created ? "created" : "updated"} · ${r.bytesWritten}b`;
    // If the file looks openable in a browser, offer a preview link.
    if (r.path && /\.(html?|css|js|json|md|txt|svg|png|jpe?g|gif)$/i.test(r.path)) {
      const url = `/files/${encodeURIComponent(r.path).replace(/%2F/g, "/")}?key=${encodeURIComponent(state.key)}`;
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "👁 open";
      a.style.cssText = "margin-left:10px;font-size:11px;color:var(--tool-in);text-decoration:none;padding:2px 8px;border:1px solid var(--border);border-radius:4px;";
      head.querySelector(".summary").appendChild(document.createTextNode(" "));
      head.querySelector(".summary").appendChild(a);
    }
  }
  else if (toolName === "propose_plan" && r.steps) sum = `${r.steps.length} steps`;
  else sum = ok ? "ok" : "fail";
  head.querySelector(".summary").textContent = sum;

  // Append detailed body
  const body = turn.querySelector(".turn-body");
  let detail = "";
  if (toolName === "list_dir" && r.entries) detail = r.entries.map(e => `${e.type === "dir" ? "📁" : "📄"} ${e.name}`).join("  ");
  else if (toolName === "read_file" && r.content) detail = String(r.content).slice(0, 3000);
  else if (toolName === "grep" && r.matches) detail = String(r.matches).slice(0, 2000);
  else if (toolName === "bash") detail = String(r.stdout ?? "").trim() || String(r.stderr ?? "").trim();
  else if (toolName === "propose_plan" && r.steps) detail = r.steps.map((s,i) => `${i+1}. ${s}`).join("\n");
  if (detail) {
    const pre = document.createElement("pre");
    pre.textContent = detail;
    body.appendChild(pre);
  }
}

// ─── Event rendering: iterations collapse into one row, standalone events (user/done/error/approval) render full-width. ───
function addEvent(type, data) {
  if (type === "token") return;
  // "state" events only drive the agent indicator pill and routing slot.
  // They're handled in the live SSE handler via setAgentState; they should
  // NOT render a visible box, in particular during snapshot replay of a
  // past session where the live handler never ran.
  if (type === "state") return;
  // Turn-collapsing: iteration creates a turn; tool_call/tool_result populate it; assistant_text is noise.
  if (type === "iteration") { startNewTurn(); return; }
  if (type === "tool_call") { if (state.currentTurn) updateTurnCall(state.currentTurn, data.tool, data.args); return; }
  if (type === "tool_result") { if (state.currentTurn) updateTurnResult(state.currentTurn, data.tool, data.result); return; }
  if (type === "assistant_text") return;
  // Dedup user_msg events. The sender device rendered its own bubble
  // locally when the user hit send; the server then broadcast the same
  // user_msg through SSE so OTHER devices see it. When that echo comes
  // back to the sender, we'd render a duplicate. If the last rendered
  // event is an identical user_msg bubble, skip this one.
  if (type === "user_msg") {
    const last = els.events.lastElementChild;
    if (last && last.classList.contains("user_msg")) {
      const lastText = last.querySelector("span:last-child")?.textContent?.trim();
      if (lastText && lastText === String(data.content || "").trim()) return;
    }
  }

  const div = document.createElement("div");
  div.className = `event ${type}`;
  // Timestamp for debugging and export. Shown as a subtle label on hover.
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  div.dataset.ts = ts;
  let label = type, body = "";
  switch (type) {
    case "user_msg": label = "you"; body = data.content || ""; break;
    case "approval_request":
      label = "approval";
      if (data.action === "plan") body = `plan (${data.steps.length} steps)`;
      else if (data.action === "write_file") body = `write ${data.path}`;
      else body = `bash ${data.command}`;
      break;
    case "approval_resolved": label = "resolved"; body = data.decision; break;
    case "done":
      // If this done was actually a reply() call, render it as an assistant
      // chat bubble. The in-progress task row is removed.
      if (data.reply) {
        if (state.currentTurn && state.currentTurn.parentElement) state.currentTurn.remove();
        state.currentTurn = null; state.taskSteps = []; state.taskIteration = 0;
        const div2 = document.createElement("div");
        div2.className = "event assistant_reply";
        div2.dataset.ts = ts;
        div2.innerHTML = `<span class="label">qcode</span><span class="ts">${ts}</span><div class="reply-body"></div>`;
        div2.querySelector(".reply-body").innerHTML = renderMarkdown(data.summary || "");
        els.events.appendChild(div2);
        div2.scrollIntoView({ behavior: "smooth", block: "end" });
        return;
      }
      // Real task done: swap the in-progress row for a result card.
      if (state.currentTurn && state.currentTurn.parentElement) state.currentTurn.remove();
      state.currentTurn = null;
      renderTaskResult(data.summary || "done", state.taskSteps || []);
      state.taskSteps = []; state.taskIteration = 0;
      return;
    case "error": label = "error"; body = data.message || JSON.stringify(data); break;
  }
  if (body.includes("\n")) {
    const [first, ...rest] = body.split("\n");
    div.innerHTML = `<span class="label">${label}</span><span class="ts">${ts}</span><span>${escapeHtml(first)}</span><pre>${escapeHtml(rest.join("\n"))}</pre>`;
  } else {
    div.innerHTML = `<span class="label">${label}</span><span class="ts">${ts}</span><span>${escapeHtml(body)}</span>`;
  }
  els.events.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ─── Approval modal ───
function showApproval(sessionId, data) {
  state.pendingApproval = { approvalId: data.approvalId, sessionId };
  if (data.action === "write_file") {
    els.approvalTitle.textContent = `approve write: ${data.path}`;
    els.approvalDetail.innerHTML = colorizeDiff(data.diff);
  } else if (data.action === "bash") {
    els.approvalTitle.textContent = `approve bash command`;
    els.approvalDetail.textContent = "$ " + data.command;
  } else if (data.action === "plan") {
    els.approvalTitle.textContent = `approve plan (${data.steps.length} steps)`;
    els.approvalDetail.textContent = `${data.rationale}\n\n` + data.steps.map((s,i) => `${i+1}. ${s}`).join("\n");
  }
  els.backdrop.hidden = false;
}
function hideApproval() { els.backdrop.hidden = true; state.pendingApproval = null; }
async function sendApproval(decision) {
  if (!state.pendingApproval) return;
  const { approvalId, sessionId } = state.pendingApproval; hideApproval();
  try {
    const res = await fetch(`/sessions/${sessionId}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qcode-key": state.key },
      body: JSON.stringify({ approvalId, decision }),
    });
    if (!res.ok) addEvent("error", { message: `approval failed: HTTP ${res.status}` });
  } catch (e) { addEvent("error", { message: `approval network error: ${String(e)}` }); }
}
els.approveBtn.addEventListener("click", () => sendApproval("approve"));
els.rejectBtn.addEventListener("click", () => sendApproval("reject"));

// ─── Chat export helpers ───
function buildChatMarkdown() {
  const lines = [`# qcode session\n`, `Model: ${els.modelBtn?.textContent ?? "unknown"}`, `Date: ${new Date().toISOString().slice(0, 19)}`, ""];
  for (const el of els.events.children) {
    const ts = el.dataset.ts ? `[${el.dataset.ts}] ` : "";
    if (el.classList.contains("task-progress") || el.classList.contains("task-result")) {
      const summary = el.querySelector(".tr-summary")?.textContent?.trim() ?? el.querySelector(".tp-label")?.textContent?.trim() ?? "";
      if (summary) lines.push(`${ts}**[agent]** ${summary}`);
      const bodyPres = el.querySelectorAll("pre");
      for (const pre of bodyPres) {
        const content = pre.textContent?.trim() ?? "";
        if (content) lines.push("```\n" + content + "\n```");
      }
      continue;
    }
    if (el.classList.contains("turn")) {
      const head = el.querySelector(".turn-head");
      const toolName = head?.querySelector(".tool-name")?.textContent?.trim() ?? "";
      const summary = head?.querySelector(".summary")?.textContent?.trim() ?? "";
      lines.push(`${ts}**[${toolName}]** ${summary}`);
      const bodyPres = el.querySelectorAll(".turn-body pre");
      for (const pre of bodyPres) {
        const content = pre.textContent?.trim() ?? "";
        if (content) lines.push("```\n" + content + "\n```");
      }
      continue;
    }
    const label = el.querySelector(".label")?.textContent?.trim() ?? "";
    const replyBody = el.querySelector(".reply-body")?.textContent?.trim() ?? "";
    const text = replyBody || (el.textContent?.trim().replace(label, "").trim() ?? "");
    if (label && text) lines.push(`${ts}**[${label}]** ${text}`);
  }
  return lines.join("\n\n");
}

// Copy to clipboard
els.copyChatBtn.addEventListener("click", async () => {
  const payload = buildChatMarkdown();
  try {
    await navigator.clipboard.writeText(payload);
    const orig = els.copyChatBtn.textContent;
    els.copyChatBtn.textContent = "\u2713";
    setTimeout(() => { els.copyChatBtn.textContent = orig; }, 1200);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = payload; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
    els.copyChatBtn.textContent = "\u2713";
    setTimeout(() => { els.copyChatBtn.textContent = "\uD83D\uDCCB"; }, 1200);
  }
});

// Download as .md file
if (els.downloadChatBtn) {
  els.downloadChatBtn.addEventListener("click", () => {
    const md = buildChatMarkdown();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qcode-session-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function colorizeDiff(text) {
  return escapeHtml(text).split("\n").map(line => {
    if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="add">${line}</span>`;
    if (line.startsWith("-") && !line.startsWith("---")) return `<span class="del">${line}</span>`;
    if (line.startsWith("@@")) return `<span class="hunk">${line}</span>`;
    return line;
  }).join("\n");
}

// ─── Boot ───
const isOnboarded = localStorage.getItem(LS_ONBOARDED) === "1";
if (!isOnboarded) {
  showOnboarding();
} else if (!state.key || !state.projectRoot) {
  showSetup();
} else {
  showApp();
}
checkHealth();
setInterval(checkHealth, 10_000);
setInterval(() => { if (state.key) refreshSidebar(); }, 5_000);
