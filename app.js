/**
 * webapp/app.js
 * Collects device fingerprint via FingerprintJS and sends it to the Flask API.
 * Integrates with Telegram WebApp SDK.
 */

const API_BASE = window.API_BASE || "http://localhost:5000";

// ── Telegram WebApp init ──────────────────────────────────────────────────────
const tg = window.Telegram && window.Telegram.WebApp;

function getTelegramUserId() {
  try {
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
      return tg.initDataUnsafe.user.id;
    }
  } catch (e) {
    console.warn("Could not read Telegram user:", e);
  }
  // Fallback: read from URL ?user_id=...
  const params = new URLSearchParams(window.location.search);
  return params.get("user_id") || null;
}

// ── Fingerprint helpers ───────────────────────────────────────────────────────

/** Simple hash function (FNV-1a 32-bit) for combining strings. */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Collect browser/device signals. */
function collectSignals() {
  const nav = navigator;
  const scr = screen;

  const signals = {
    userAgent:        nav.userAgent || "",
    language:         nav.language  || nav.userLanguage || "",
    languages:        (nav.languages || []).join(","),
    platform:         nav.platform  || "",
    cookiesEnabled:   nav.cookieEnabled ? "1" : "0",
    doNotTrack:       nav.doNotTrack || "unknown",
    hardwareConcurrency: String(nav.hardwareConcurrency || 0),
    deviceMemory:     String(nav.deviceMemory || 0),
    screenWidth:      String(scr.width),
    screenHeight:     String(scr.height),
    colorDepth:       String(scr.colorDepth),
    pixelDepth:       String(scr.pixelDepth),
    timezone:         Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    timezoneOffset:   String(new Date().getTimezoneOffset()),
    touchPoints:      String(nav.maxTouchPoints || 0),
  };

  // Canvas fingerprint (lightweight)
  try {
    const canvas = document.createElement("canvas");
    const ctx    = canvas.getContext("2d");
    ctx.textBaseline = "top";
    ctx.font         = "14px Arial";
    ctx.fillText("BB🍦", 2, 2);
    signals.canvas = canvas.toDataURL().slice(-32);
  } catch (_) {
    signals.canvas = "unsupported";
  }

  // Audio context fingerprint (optional)
  try {
    const AudioCtx  = window.AudioContext || window.webkitAudioContext;
    const ctx       = new AudioCtx();
    const osc       = ctx.createOscillator();
    const analyser  = ctx.createAnalyser();
    const gain      = ctx.createGain();
    gain.gain.value = 0;   // mute
    osc.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    const buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(buf);
    signals.audio = fnv1a(buf.slice(0, 10).join(","));
    osc.stop();
    ctx.close();
  } catch (_) {
    signals.audio = "unsupported";
  }

  return signals;
}

/** Build a single fingerprint hash from all signals. */
function buildFingerprint(signals) {
  const str = Object.values(signals).join("|");
  // Two-pass hash for better distribution
  const h1 = fnv1a(str);
  const h2 = fnv1a(str.split("").reverse().join(""));
  return h1 + h2;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(msg, type = "info") {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg;
  el.className   = "status " + type;
}

function setLoading(loading) {
  const btn = document.getElementById("verify-btn");
  if (!btn) return;
  btn.disabled    = loading;
  btn.textContent = loading ? "Verifying…" : "✅ Verify Device";
}

function showDetails(signals) {
  const el = document.getElementById("details");
  if (!el) return;
  el.innerHTML = `
    <div class="detail-row"><span>🖥️ Screen</span><span>${signals.screenWidth}×${signals.screenHeight}</span></div>
    <div class="detail-row"><span>🌐 Language</span><span>${signals.language}</span></div>
    <div class="detail-row"><span>🕐 Timezone</span><span>${signals.timezone}</span></div>
    <div class="detail-row"><span>🖱️ Platform</span><span>${signals.platform}</span></div>
    <div class="detail-row"><span>💻 CPU Cores</span><span>${signals.hardwareConcurrency}</span></div>
  `;
}

// ── Main verification flow ────────────────────────────────────────────────────

async function verifyDevice() {
  setLoading(true);
  setStatus("Collecting device information…", "info");

  const userId = getTelegramUserId();
  if (!userId) {
    setStatus("❌ Could not identify your Telegram account. Please open this from the bot.", "error");
    setLoading(false);
    return;
  }

  // Collect signals
  const signals     = collectSignals();
  const fingerprint = buildFingerprint(signals);

  showDetails(signals);
  setStatus("Sending to server…", "info");

  // Send to Flask API
  try {
    const res  = await fetch(`${API_BASE}/verify`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ user_id: userId, fingerprint })
    });

    const json = await res.json();

    if (json.success) {
      if (json.already_verified) {
        setStatus("✅ Device already verified!", "success");
      } else {
        setStatus("✅ Device verified successfully! Go back to the bot.", "success");
      }

      // Tell the Telegram WebApp we're done
      if (tg) {
        tg.sendData(JSON.stringify({
          action:      "device_verified",
          user_id:     userId,
          fingerprint: fingerprint.slice(0, 8) + "…",
          success:     true
        }));
        setTimeout(() => tg.close(), 1500);
      }
    } else {
      setStatus("❌ " + (json.message || "Verification failed."), "error");
    }
  } catch (err) {
    console.error("Verify error:", err);
    setStatus("❌ Network error. Please check your connection and try again.", "error");
  } finally {
    setLoading(false);
  }
}

// ── Auto-run on page load ────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  // Expand Telegram WebApp
  if (tg) {
    tg.expand();
    tg.ready();
  }

  const btn = document.getElementById("verify-btn");
  if (btn) {
    btn.addEventListener("click", verifyDevice);
  }

  // Show user info if available
  if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
    const user = tg.initDataUnsafe.user;
    const nameEl = document.getElementById("user-name");
    if (nameEl) nameEl.textContent = user.first_name || "User";
  }
});
