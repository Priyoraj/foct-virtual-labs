/* FoCT Virtual Labs - exam mode.
   The lab server puts this script at the top of every page it sends, the labs' own pages and
   the third-party ones (Jupyter, Office, draw.io ...). The administrator switches exam mode on
   the server PC (http://localhost:8080/__exam/control). While it is on, each page:
     - blocks copy, cut and paste (keyboard, menus, the async clipboard API) and dropping text or
       files, in the page and in its frames;
     - shows a red frame and a watermark with the exam title, this PC's address and the time.
   It stops casual copying; it cannot stop someone who switches it off with developer tools. */
(() => {
  "use strict";
  if (window.__foctExamLoaded) return;
  window.__foctExamLoaded = true;

  const POLL_MS = 8000;
  const KEY = "foct.exam";
  let isTop = false, canReadTop = false;
  try { isTop = window.top === window; void window.top.location.href; canReadTop = true; } catch { /* other origin */ }

  // ------------------------------------------------------------ state
  // The top page asks the server; frames use the top page's answer (read at the moment it matters).
  let state = { on: false };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && Date.now() - saved.at < 12 * 3600e3) state = saved;   // until the first answer
  } catch { /* storage blocked */ }
  const topState = () => { try { return window.top.__foctExam; } catch { return undefined; } };
  const active = () => {
    if (isTop || !canReadTop) return !!state.on;
    const t = topState();
    return t ? !!t.on : !!state.on;
  };
  if (isTop) window.__foctExam = state;

  async function poll() {
    try {
      const r = await fetch("/__exam", { cache: "no-store", credentials: "same-origin" });
      if (r.ok) apply(await r.json());
    } catch { /* server not reachable: keep the last state */ }
  }

  function apply(s) {
    const was = !!state.on;
    state = { on: !!s.on, title: String(s.title || ""), client: String(s.client || ""), since: s.since || null, at: Date.now() };
    if (isTop) window.__foctExam = state;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked */ }
    render();
    if (isTop && was !== state.on) {
      toast(state.on ? "Exam mode is on: copy and paste are turned off." : "Exam mode has ended.");
    }
  }

  // ------------------------------------------------------------ clipboard
  const hasSelection = (e) => {
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) {
      try { return t.selectionEnd > t.selectionStart; } catch { return false; }
    }
    const sel = document.getSelection();
    return !!(sel && String(sel).length);
  };
  function block(e, say) {
    if (!active()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (say) toast("Copy and paste are turned off during the exam.");
  }
  // Capture listeners on window run before any editor (Monaco, CodeMirror, ONLYOFFICE) sees the event.
  window.addEventListener("copy", (e) => block(e, hasSelection(e)), true);
  window.addEventListener("cut", (e) => block(e, hasSelection(e)), true);
  window.addEventListener("paste", (e) => block(e, true), true);
  window.addEventListener("beforeinput", (e) => {
    if (/^insertFrom(Paste|Drop|YankPaste)/.test(e.inputType || "")) block(e, true);
  }, true);
  window.addEventListener("drop", (e) => block(e, true), true);
  window.addEventListener("dragover", (e) => {
    if (active()) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; }
  }, true);
  window.addEventListener("dragstart", (e) => {
    const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
    if (types.includes("text/plain") || types.includes("text/html")) block(e, false);
  }, true);
  // The async Clipboard API (secure pages only) does not fire events, so wrap it.
  const cb = navigator.clipboard;
  if (cb) {
    for (const m of ["read", "readText", "write", "writeText"]) {
      if (typeof cb[m] !== "function") continue;
      const original = cb[m].bind(cb);
      try {
        cb[m] = (...args) => (active()
          ? Promise.reject(new DOMException("The clipboard is turned off during the exam.", "NotAllowedError"))
          : original(...args));
      } catch { /* read-only in this browser */ }
    }
  }

  // ------------------------------------------------------------ look
  const CSS = `
.foct-exam-mark { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; background-repeat: repeat; }
.foct-exam-frame { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; box-shadow: inset 0 0 0 4px rgba(220, 38, 38, .9); }
.foct-exam-badge, .foct-exam-toast { position: fixed; z-index: 2147483647; pointer-events: none;
  font: 700 12px/1.2 "Segoe UI", Roboto, Arial, sans-serif; color: #fff; border-radius: 999px; }
.foct-exam-badge { right: 14px; bottom: 14px; padding: 7px 12px; letter-spacing: .05em; background: rgba(220, 38, 38, .92);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
.foct-exam-toast { left: 50%; bottom: 56px; transform: translate(-50%, 8px); padding: 10px 18px; font-size: 14px; font-weight: 600;
  background: rgba(30, 27, 60, .94); box-shadow: 0 8px 24px rgba(0, 0, 0, .3); opacity: 0; transition: opacity .2s, transform .2s; }
.foct-exam-toast.show { opacity: 1; transform: translate(-50%, 0); }
html.foct-exam .foct-bar { box-shadow: inset 0 0 0 9999px rgba(220, 38, 38, .10); }
html.foct-exam .foct-bar::after { background: linear-gradient(90deg, #dc2626, #f59e0b); }
@media print { .foct-exam-toast { display: none; } }`;
  let styleEl, markEl, frameEl, badgeEl, toastEl, toastTimer, clockTimer, lastToast = "", lastToastAt = 0;
  const make = (cls) => { const d = document.createElement("div"); d.className = cls; d.setAttribute("aria-hidden", "true"); return d; };
  const mount = (el) => { if (!el.isConnected) document.documentElement.appendChild(el); };
  function addStyle() {
    if (!styleEl) { styleEl = document.createElement("style"); styleEl.textContent = CSS; }
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function watermark() {
    const now = new Date();
    const when = now.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) + " "
      + now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const line1 = state.title || "EXAM MODE";
    const line2 = [state.title ? "EXAM MODE" : "", state.client, when].filter(Boolean).join("  ·  ");
    const size = Math.max(14, Math.min(30, Math.floor(1000 / Math.max(1, line1.length))));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320">`
      + `<g transform="rotate(-24 280 160)" text-anchor="middle" font-family="Segoe UI, Roboto, Arial, sans-serif" fill="#dc2626" fill-opacity="0.12">`
      + `<text x="280" y="152" font-size="${size}" font-weight="700">${esc(line1)}</text>`
      + `<text x="280" y="186" font-size="16" font-weight="600">${esc(line2)}</text></g></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  }

  function render() {
    document.documentElement.classList.toggle("foct-exam", active());
    if (!isTop) return;
    if (!state.on) {
      for (const el of [markEl, frameEl, badgeEl]) if (el) el.remove();
      clearInterval(clockTimer);
      clockTimer = null;
      return;
    }
    addStyle();
    if (!markEl) { markEl = make("foct-exam-mark"); frameEl = make("foct-exam-frame"); badgeEl = make("foct-exam-badge"); }
    badgeEl.textContent = "EXAM MODE · copy & paste off";
    markEl.style.backgroundImage = watermark();
    [markEl, frameEl, badgeEl].forEach(mount);
    if (!clockTimer) clockTimer = setInterval(() => { if (state.on) markEl.style.backgroundImage = watermark(); }, 30000);
  }

  function toast(msg) {
    if (!isTop) {
      try { if (window.top.__foctExamToast) window.top.__foctExamToast(msg); } catch { /* other origin */ }
      return;
    }
    if (msg === lastToast && Date.now() - lastToastAt < 2000) return;
    lastToast = msg;
    lastToastAt = Date.now();
    addStyle();
    if (!toastEl) { toastEl = make("foct-exam-toast"); toastEl.setAttribute("role", "status"); toastEl.removeAttribute("aria-hidden"); }
    toastEl.textContent = msg;
    mount(toastEl);
    void toastEl.offsetWidth;            // restart the fade-in
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }
  if (isTop) window.__foctExamToast = toast;

  // ------------------------------------------------------------ start
  render();
  if (isTop || !canReadTop) {
    poll();
    setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  }
})();
