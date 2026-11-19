/* FoCT Virtual Labs - exam mode.
   The lab server puts this script at the top of every page it sends, the labs' own pages and
   the third-party ones (Jupyter, Office, draw.io ...). The teacher switches exam mode on the
   server PC (http://localhost:8080/__exam/control). While it is on, each page:
     - blocks copy, cut and paste (keyboard, menus, the async clipboard API) and dropping text or
       files, in the page and in its frames;
     - shows a red frame and a watermark with the exam title, this PC's address and the time;
     - if the teacher asked students to sign in: asks for the student's name and enrolment number
       once per exam on this PC, then sends their work to the server -
         * lab drafts changed during the exam (C, C++, Java, Python, Lex & Yacc, SQL, MongoDB,
           SPICE, NetSim, Jupyter notebooks), at most once a minute and at once when the teacher
           collects;
         * every file saved or downloaded from a lab ("Saved files");
         * files handed in with the Submit files button ("Submitted files").
   It stops casual copying; it cannot stop someone who switches it off with developer tools. */
(() => {
  "use strict";
  if (window.__foctExamLoaded) return;
  window.__foctExamLoaded = true;

  const POLL_MS = 8000;
  const SYNC_MS = 60000;
  const KEY = "foct.exam";
  let isTop = false, canReadTop = false;
  try { isTop = window.top === window; void window.top.location.href; canReadTop = true; } catch { /* other origin */ }

  const ls = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
  };

  // ------------------------------------------------------------ state
  // The top page asks the server; frames use the top page's answer (read at the moment it matters).
  let state = { on: false };
  const saved = ls.get(KEY);
  if (saved && Date.now() - saved.at < 12 * 3600e3) state = saved;          // until the first answer
  let skew = 0;                                                             // server clock - this PC's clock (ms)
  let me = null;                                                            // { token, name, enrolment, folder }
  const meKey = () => `foct.exam.me.${state.id}`;
  const loadMe = () => { me = state.id ? ls.get(meKey()) : null; };
  loadMe();
  const topState = () => { try { return window.top.__foctExam; } catch { return undefined; } };
  const active = () => {
    if (isTop || !canReadTop) return !!state.on;
    const t = topState();
    return t ? !!t.on : !!state.on;
  };
  if (isTop) window.__foctExam = state;
  const topApi = () => { try { return window.top.__foctExamApi || null; } catch { return null; } };
  const collecting = () => {
    if (isTop || !canReadTop) return !!(state.on && state.register && me);
    const api = topApi();
    return !!(api && api.collecting());
  };

  async function poll() {
    const token = me ? me.token : null;
    try {
      const r = await fetch("/__exam", { cache: "no-store", headers: token ? { "X-FoCT-Token": token } : {} });
      if (r.ok) apply(await r.json(), token);
    } catch { /* server not reachable: keep the last state */ }
  }

  function apply(s, token) {
    const wasOn = !!state.on, wasId = state.id;
    skew = s.now * 1000 - Date.now();
    state = { on: !!s.on, title: String(s.title || ""), since: s.since || null, id: s.id || null,
              register: !!s.register, collect: s.collect || 0, client: String(s.client || ""), at: Date.now() };
    if (isTop) window.__foctExam = state;
    ls.set(KEY, state);
    if (state.id !== wasId || !me) loadMe();
    if (me && token === me.token && state.on && state.register && !s.you) { ls.del(meKey()); me = null; }   // the server no longer knows us
    if (me && s.you) me.saved = s.you.saved;
    render();
    if (isTop && wasOn !== state.on) {
      toast(state.on ? "Exam mode is on: copy and paste are turned off." : "Exam mode has ended.");
    }
    if (!isTop) return;
    if (state.on && state.register && !me) signIn();
    else closeSignIn();
    if (collecting()) {
      const k = `foct.exam.collected.${state.id}`;
      if (state.collect > (ls.get(k) || 0)) {          // the teacher is collecting: send everything now
        ls.set(k, state.collect);
        syncWork(state.collect);
      }
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

  // ------------------------------------------------------------ sending work to the teacher
  // cyrb53: a quick hash, to send only what changed.
  const hash = (str) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };

  // Drafts the labs keep in this browser (all labs share this site's storage).
  const CODE = { c: "C", cpp: "C++", java: "Java", python: "Python", lex: "Lex & Yacc" };
  const TEXT = { "foct.sql.draft": ["SQL", "query.sql"], "foct.mongo.draft": ["MongoDB", "script.js"],
                 "foct.spice.draft": ["SPICE", "circuit.cir"] };
  function readDrafts() {        // -> { storageKey: [{ path, data }] }
    const out = {};
    const raw = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    for (const [id, dir] of Object.entries(CODE)) {
      const d = ls.get(`foct.code.${id}`);
      if (d && Array.isArray(d.tabs)) {
        out[`foct.code.${id}`] = d.tabs.filter((t) => t && t.name).map((t) => ({ path: `${dir}/${t.name}`, data: String(t.text ?? "") }));
      }
    }
    for (const [k, [dir, name]] of Object.entries(TEXT)) {
      const v = raw(k);
      if (v != null) out[k] = [{ path: `${dir}/${name}`, data: v }];
    }
    const net = ls.get("foct.netsim.draft");
    if (net && net.net) out["foct.netsim.draft"] = [{ path: `Network/${net.name || "network.foctnet"}`, data: JSON.stringify(net.net, null, 1) }];
    return out;
  }
  const draftHash = (files) => hash(files.map((f) => f.path + "\0" + f.data).join("\0\0"));

  // Jupyter notebooks live in IndexedDB; take the ones changed since the exam started.
  async function readNotebooks() {
    const DB = "JupyterLite Storage - /apps/notebook/";
    try {
      if (!indexedDB.databases || !(await indexedDB.databases()).some((d) => d.name === DB)) return [];
      const db = await new Promise((res, rej) => { const r = indexedDB.open(DB); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      try {
        if (!db.objectStoreNames.contains("files")) return [];
        const all = await new Promise((res, rej) => {
          const r = db.transaction("files", "readonly").objectStore("files").getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        });
        const start = (state.since || 0) * 1000 - skew;
        const files = [];
        for (const f of all) {
          if (!f || f.type === "directory" || !f.path || Date.parse(f.last_modified || 0) < start) continue;
          let data;
          if (f.type === "notebook") data = JSON.stringify(f.content, null, 1) + "\n";
          else if (f.format === "base64") data = Uint8Array.from(atob(f.content || ""), (c) => c.charCodeAt(0));
          else data = typeof f.content === "string" ? f.content : JSON.stringify(f.content, null, 1);
          files.push({ path: `Jupyter/${f.path}`, data });
        }
        return files;
      } finally {
        db.close();
      }
    } catch {
      return [];
    }
  }

  async function send(path, body) {
    const r = await fetch("/__exam/upload", {
      method: "POST",
      headers: { "X-FoCT-Token": me.token, "X-FoCT-Path": encodeURIComponent(path), "Content-Type": "application/octet-stream" },
      body,
    });
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
      if (r.status === 403) { ls.del(meKey()); me = null; poll(); }
      throw new Error(msg);
    }
  }

  let syncing = null;
  function syncWork(collect) {      // send changed drafts and notebooks; tell the server when a collection is done
    if (!collecting()) return Promise.resolve();
    const run = (syncing || Promise.resolve()).then(async () => {
      if (!collecting()) return;
      const baseKey = `foct.exam.base.${state.id}`, sentKey = `foct.exam.sent.${state.id}`;
      const base = ls.get(baseKey, {}) || {};
      const sent = ls.get(sentKey, {}) || {};
      const files = [];
      for (const [k, list] of Object.entries(readDrafts())) {
        if (draftHash(list) !== base[k]) files.push(...list);           // changed during this exam
      }
      files.push(...await readNotebooks());
      let ok = true, count = 0;
      for (const f of files) {
        const h = typeof f.data === "string" ? hash(f.data) : hash(Array.from(f.data.subarray(0, 4096)).join(",") + f.data.length);
        if (sent[f.path] === h) continue;
        try {
          await send(f.path, f.data);
          sent[f.path] = h;
          count++;
        } catch {
          ok = false;
          if (!me) return;
        }
      }
      ls.set(sentKey, sent);
      if (ok && (count || collect)) markSent();
      if (!ok) setStatus("Not sent yet · retrying", true);
      if (collect && me) {
        try {
          await fetch("/__exam/done", { method: "POST", headers: { "Content-Type": "application/json", "X-FoCT-Token": me.token },
                                        body: JSON.stringify({ collect }) });
        } catch { /* the server will see us next time */ }
      }
    });
    syncing = run.catch(() => {});
    return run;
  }

  // Files saved or downloaded from any lab during the exam also go to the teacher.
  function capture(name, data) {
    if (!collecting() || !name) return;
    if (!isTop && canReadTop) { const api = topApi(); if (api) api.capture(name, data); return; }   // the top page sends it
    const path = `Saved files/${String(name).split(/[\\/]/).pop()}`;
    Promise.resolve(data).then((d) => send(path, d)).then(markSent).catch(() => setStatus("A saved file was not sent", true));
  }
  window.__foctExamSaved = capture;                  // called by the labs' own Save (foct.js)
  if (isTop) window.__foctExamApi = { capture, collecting };
  function captureAnchor(a) {
    if (!collecting() || a.__foctTaken) return;
    const href = a.href || "";
    if (!/^(blob:|data:)/.test(href) || !(a.hasAttribute("download") || href.startsWith("blob:"))) return;
    a.__foctTaken = true;
    setTimeout(() => { a.__foctTaken = false; }, 0);
    // Read the file now: pages often revoke the blob URL right after the click.
    capture(a.getAttribute("download") || "download", fetch(href).then((r) => r.blob()));
  }
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    try { captureAnchor(this); } catch { /* never block a download */ }
    return anchorClick.apply(this, args);
  };
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (a) captureAnchor(a);
  }, true);

  // ------------------------------------------------------------ look
  const CSS = `
.foct-exam-mark { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; background-repeat: repeat; }
.foct-exam-frame { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; box-shadow: inset 0 0 0 4px rgba(220, 38, 38, .9); }
.foct-exam-badge, .foct-exam-toast, .foct-exam-bar { position: fixed; z-index: 2147483647;
  font: 600 12px/1.25 "Segoe UI", Roboto, Arial, sans-serif; color: #fff; border-radius: 999px; }
.foct-exam-badge { right: 14px; bottom: 34px; padding: 7px 12px; letter-spacing: .05em; font-weight: 700; pointer-events: none;
  background: rgba(220, 38, 38, .92); box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
.foct-exam-bar { right: 14px; bottom: 34px; display: flex; align-items: center; gap: 10px; padding: 5px 5px 5px 12px; max-width: calc(100vw - 28px);
  background: rgba(185, 28, 28, .95); box-shadow: 0 4px 16px rgba(0, 0, 0, .3); }
.foct-exam-bar .who { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; font-weight: 700; }
.foct-exam-bar .st { white-space: nowrap; opacity: .85; font-weight: 500; }
.foct-exam-bar .st.warn { opacity: 1; color: #fde68a; }
.foct-exam-bar button { font: inherit; font-weight: 700; color: #b91c1c; background: #fff; border: 0; border-radius: 999px; padding: 5px 12px; cursor: pointer; }
.foct-exam-bar button:hover { background: #fee2e2; }
.foct-exam-toast { left: 50%; bottom: 84px; transform: translate(-50%, 8px); padding: 10px 18px; font-size: 14px; pointer-events: none;
  background: rgba(30, 27, 60, .94); box-shadow: 0 8px 24px rgba(0, 0, 0, .3); opacity: 0; transition: opacity .2s, transform .2s; }
.foct-exam-toast.show { opacity: 1; transform: translate(-50%, 0); }
.foct-exam-signin { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
  background: rgba(20, 16, 40, .72); backdrop-filter: blur(3px); font: 15px/1.45 "Segoe UI", Roboto, Arial, sans-serif; }
.foct-exam-signin form { width: min(440px, 100%); background: #fff; color: #1d1b33; border-radius: 16px; padding: 24px 24px 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .4); border-top: 6px solid #dc2626; }
.foct-exam-signin .k { font-size: 12px; font-weight: 700; letter-spacing: .08em; color: #dc2626; text-transform: uppercase; }
.foct-exam-signin h2 { font-size: 20px; margin: 4px 0 6px; line-height: 1.25; }
.foct-exam-signin p { margin: 0 0 14px; color: #55527a; font-size: 14px; }
.foct-exam-signin label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
.foct-exam-signin input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 11px; border: 1px solid #c9c6e0; border-radius: 9px; color: #1d1b33; background: #fff; }
.foct-exam-signin input:focus { outline: 2px solid #dc2626; outline-offset: 1px; }
.foct-exam-signin button { margin-top: 18px; width: 100%; font: inherit; font-weight: 700; color: #fff; background: #dc2626; border: 0; border-radius: 10px; padding: 11px; cursor: pointer; }
.foct-exam-signin button:disabled { opacity: .6; cursor: default; }
.foct-exam-signin .err { color: #b91c1c; font-size: 13px; min-height: 18px; margin-top: 8px; }
html.foct-exam .foct-bar { box-shadow: inset 0 0 0 9999px rgba(220, 38, 38, .10); }
html.foct-exam .foct-toasts { bottom: 80px; }   /* the labs' own messages stay above the exam bar */
html.foct-exam .foct-bar::after { background: linear-gradient(90deg, #dc2626, #f59e0b); }
@media print { .foct-exam-toast, .foct-exam-bar button, .foct-exam-signin { display: none; } }`;
  let styleEl, markEl, frameEl, badgeEl, barEl, toastEl, signEl, toastTimer, clockTimer, lastToast = "", lastToastAt = 0;
  const make = (cls, tag = "div") => { const d = document.createElement(tag); d.className = cls; return d; };
  const mount = (el) => { if (!el.isConnected) document.documentElement.appendChild(el); };
  function addStyle() {
    if (!styleEl) { styleEl = document.createElement("style"); styleEl.textContent = CSS; }
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hhmm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  function watermark() {
    const now = new Date();
    const when = now.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) + " " + hhmm(now);
    const line1 = state.title || "EXAM MODE";
    const who = me ? `${me.name} (${me.enrolment})` : "";
    const line2 = [state.title ? "EXAM MODE" : "", who, state.client, when].filter(Boolean).join("  ·  ");
    const size = Math.max(14, Math.min(30, Math.floor(1000 / Math.max(1, line1.length))));
    const size2 = Math.max(11, Math.min(16, Math.floor(900 / Math.max(1, line2.length))));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="320">`
      + `<g transform="rotate(-24 280 160)" text-anchor="middle" font-family="Segoe UI, Roboto, Arial, sans-serif" fill="#dc2626" fill-opacity="0.12">`
      + `<text x="280" y="152" font-size="${size}" font-weight="700">${esc(line1)}</text>`
      + `<text x="280" y="184" font-size="${size2}" font-weight="600">${esc(line2)}</text></g></svg>`;
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  }

  let status = { text: "", warn: false };
  function setStatus(text, warn = false) {
    status = { text, warn };
    if (barEl) { const st = barEl.querySelector(".st"); st.textContent = text; st.classList.toggle("warn", warn); }
  }
  function markSent() { setStatus(`Work sent ${hhmm(Date.now())}`); }

  function render() {
    document.documentElement.classList.toggle("foct-exam", active());
    if (!isTop) return;
    if (!state.on) {
      for (const el of [markEl, frameEl, badgeEl, barEl]) if (el) el.remove();
      clearInterval(clockTimer);
      clockTimer = null;
      return;
    }
    addStyle();
    if (!markEl) {
      markEl = make("foct-exam-mark"); frameEl = make("foct-exam-frame"); badgeEl = make("foct-exam-badge");
      for (const el of [markEl, frameEl, badgeEl]) el.setAttribute("aria-hidden", "true");
    }
    markEl.style.backgroundImage = watermark();
    [markEl, frameEl].forEach(mount);
    if (collecting()) {
      badgeEl.remove();
      if (!barEl) {
        barEl = make("foct-exam-bar");
        barEl.innerHTML = '<span class="who"></span><span class="st"></span><button type="button">Submit files</button>';
        barEl.querySelector("button").onclick = submitFiles;
      }
      barEl.querySelector(".who").textContent = `EXAM · ${me.name} · ${me.enrolment}`;
      if (!status.text && me.saved) setStatus(`Work sent ${hhmm(me.saved * 1000 - skew)}`);
      setStatus(status.text || "Your work is sent to your teacher automatically", status.warn);
      mount(barEl);
    } else {
      if (barEl) barEl.remove();
      badgeEl.textContent = "EXAM MODE · copy & paste off";
      mount(badgeEl);
    }
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
    if (!toastEl) { toastEl = make("foct-exam-toast"); toastEl.setAttribute("role", "status"); }
    toastEl.textContent = msg;
    mount(toastEl);
    void toastEl.offsetWidth;            // restart the fade-in
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }
  if (isTop) window.__foctExamToast = toast;

  // ------------------------------------------------------------ sign in and hand in
  function signIn() {
    if (signEl && signEl.isConnected) return;
    addStyle();
    signEl = make("foct-exam-signin");
    signEl.setAttribute("role", "dialog");
    signEl.setAttribute("aria-modal", "true");
    signEl.innerHTML = `<form novalidate>
      <div class="k">Exam &middot; FoCT Virtual Labs</div>
      <h2>${esc(state.title || "Exam")}</h2>
      <p>Enter your name and enrolment number to start. Your work in the labs is sent to your teacher automatically.</p>
      <label for="foctExamName">Full name</label>
      <input id="foctExamName" name="name" autocomplete="off" maxlength="80" required>
      <label for="foctExamEnrol">Enrolment no.</label>
      <input id="foctExamEnrol" name="enrolment" autocomplete="off" maxlength="40" required>
      <div class="err" role="alert"></div>
      <button type="submit">Start exam</button>
    </form>`;
    const form = signEl.querySelector("form"), err = signEl.querySelector(".err"), btn = signEl.querySelector("button");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = form.name.value.trim(), enrolment = form.enrolment.value.trim();
      if (name.length < 2) { err.textContent = "Please enter your full name."; form.name.focus(); return; }
      if (enrolment.length < 2) { err.textContent = "Please enter your enrolment number."; form.enrolment.focus(); return; }
      btn.disabled = true;
      err.textContent = "";
      try {
        const r = await fetch("/__exam/register", { method: "POST", headers: { "Content-Type": "application/json" },
                                                     body: JSON.stringify({ exam: state.id, name, enrolment }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Could not sign in. Ask your teacher.");
        // What is already in this browser does not count as this exam's work.
        const base = {};
        for (const [k, list] of Object.entries(readDrafts())) base[k] = draftHash(list);
        ls.set(`foct.exam.base.${state.id}`, base);
        me = { token: j.token, name: j.name, enrolment: j.enrolment, folder: j.folder, saved: null };
        ls.set(meKey(), me);
        closeSignIn();
        render();
        toast(`Welcome, ${j.name}. Your work is sent to your teacher automatically.`);
        poll();
      } catch (ex) {
        err.textContent = ex.message || "Could not sign in.";
        btn.disabled = false;
      }
    };
    // keep the keyboard inside the dialog
    signEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Tab") return;
      const f = [form.name, form.enrolment, btn];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }, true);
    const mountSign = () => { mount(signEl); setTimeout(() => form.name.focus(), 0); };
    if (document.body) mountSign(); else document.addEventListener("DOMContentLoaded", mountSign, { once: true });
  }
  function closeSignIn() { if (signEl) { signEl.remove(); signEl = null; } }

  function submitFiles() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      setStatus(`Sending ${files.length} file${files.length > 1 ? "s" : ""}…`);
      let sent = 0;
      for (const f of files) {
        try { await send(`Submitted files/${f.name}`, f); sent++; } catch (e) { toast(`${f.name}: ${e.message}`); }
      }
      if (sent) { markSent(); toast(`${sent} file${sent > 1 ? "s" : ""} sent to your teacher.`); }
      else setStatus("Files not sent", true);
    };
    input.click();
  }

  // other tabs on this PC signed in, or the identity was cleared
  window.addEventListener("storage", (e) => {
    if (e.key && e.key.startsWith("foct.exam.me.")) { loadMe(); render(); if (me) closeSignIn(); }
  });

  // ------------------------------------------------------------ start
  render();
  if (isTop || !canReadTop) {
    poll();
    setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
      else if (collecting()) syncWork(0);      // the student is leaving this page: send what changed
    });
  }
  if (isTop) setInterval(() => { if (collecting() && !document.hidden) syncWork(0); }, SYNC_MS);
})();
