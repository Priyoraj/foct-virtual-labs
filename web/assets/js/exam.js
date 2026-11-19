/* FoCT Virtual Labs - exam mode.
   The lab server puts this script at the top of every page it sends, the labs' own pages and
   the third-party ones (Jupyter, Office, draw.io ...). The teacher switches exam mode on the
   server PC (http://localhost:8080/__exam/control). While it is on, each page:
     - blocks copy, cut and paste (keyboard, menus, the async clipboard API) and dropping text or
       files, in the page and in its frames;
     - shows a red frame and a watermark with the exam title, the student, this PC's address and
       the time, and a countdown when the exam has a time limit;
     - with the teacher's options: blocks opening files and the IDE's example programs, the
       right-click menu, developer-tools and view-source keys and printing; notices leaving the
       exam window, leaving full screen, large insertions in an editor and a second screen;
     - checks itself every few seconds: developer tools open, or a protection removed, locks the
       exam on this PC until everything is back to normal (or the teacher lets the student back in);
     - shows "not part of the exam" on labs the teacher did not choose, "time is up" at the end,
       and messages from the teacher;
     - if students sign in: asks for name, enrolment number (and the exam code), then sends their
       work to the server: lab drafts changed during the exam (C, C++, Java, Python, Lex & Yacc,
       SQL, MongoDB, SPICE, NetSim, Jupyter), every file saved or downloaded from a lab, and files
       handed in with Submit files.
   The server enforces its part itself (which labs are served, and only to signed-in PCs that keep
   checking in and are not locked). What runs here stops casual cheating; someone who rewrites
   this script with developer tools could still get around it, so strict exams should also turn
   developer tools off with the browser policy DeveloperToolsAvailability = 2. */
(() => {
  "use strict";
  if (window.__foctExamLoaded) return;
  window.__foctExamLoaded = true;

  const POLL_MS = 8000;
  const SYNC_MS = 60000;
  const CHECK_MS = 3000;
  const KEY = "foct.exam";
  let isTop = false, canReadTop = false;
  try { isTop = window.top === window; void window.top.location.href; canReadTop = true; } catch { /* other origin */ }

  const store = (s) => ({
    get(k, d = null) { try { const v = s.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { s.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
    del(k) { try { s.removeItem(k); } catch { /* storage blocked */ } },
  });
  let ls, ss;
  try { ls = store(localStorage); ss = store(sessionStorage); } catch { ls = ss = store({ getItem: () => null, setItem() {}, removeItem() {} }); }

  // ------------------------------------------------------------ state
  // The top page asks the server; frames use the top page's answer (read at the moment it matters).
  let state = { on: false };
  const saved = ls.get(KEY);
  if (saved && Date.now() - saved.at < 12 * 3600e3) state = saved;          // until the first answer
  let skew = 0;                                                             // server clock - this PC's clock (ms)
  let me = null;                                                            // { token, name, enrolment, folder }
  let serverLock = null, localLock = null;
  const meKey = () => `foct.exam.me.${state.id}`;
  const loadMe = () => { me = state.id ? ls.get(meKey()) : null; };
  loadMe();
  const topState = () => { try { return window.top.__foctExam; } catch { return undefined; } };
  const S = () => (isTop || !canReadTop ? state : (topState() || state));
  const active = () => !!S().on;
  const opts = () => S().opts || {};
  if (isTop) window.__foctExam = state;
  const topApi = () => { try { return isTop ? null : window.top.__foctExamApi || null; } catch { return null; } };
  const collecting = () => {
    if (isTop || !canReadTop) return !!(state.on && state.register && me);
    const api = topApi();
    return !!(api && api.collecting());
  };
  const currentLock = () => serverLock || localLock;
  const serverNow = () => Date.now() + skew;

  const CODE_LABS = ["c", "cpp", "java", "python", "lex"];
  function labOf(pathname, search) {
    if (pathname.startsWith("/apps/code/")) {
      const l = new URLSearchParams(search || "").get("lang");
      return CODE_LABS.includes(l) ? l : "c";
    }
    const m = /^\/apps\/(notebook|sql|mongo|cdtools|spice|circuit|netsim|drawio|office)\//.exec(pathname);
    return m ? (m[1] === "notebook" ? "jupyter" : m[1]) : null;
  }
  const PAGE_LAB = labOf(location.pathname, location.search);
  const labAllowed = (lab) => !lab || !S().labs || S().labs.includes(lab);

  // The exam helper (exam-helper.vbs) opens the exam in its own full-screen Edge with ?foctk=<key>;
  // the key shows the server that this is the helper's browser (needed to sign in).
  const KKEY = "foct.exam.kiosk";
  if (isTop) {
    try {
      const u = new URL(location.href);
      const k = u.searchParams.get("foctk");
      if (k) { ls.set(KKEY, k); u.searchParams.delete("foctk"); history.replaceState(history.state, "", u); }
    } catch { /* old browser */ }
  }
  const kioskKey = () => ls.get(KKEY) || "";
  let agent = { ok: true, ready: true, kiosk: true, problem: "" };
  const helperOk = () => !(state.opts && state.opts.helper) || (agent.ok && agent.ready && agent.kiosk);

  async function poll() {
    const token = me ? me.token : null;
    const headers = { "X-FoCT-Kiosk": kioskKey() };
    if (token) headers["X-FoCT-Token"] = token;
    try {
      const r = await fetch("/__exam", { cache: "no-store", headers });
      if (r.ok) apply(await r.json(), token);
    } catch { /* server not reachable: keep the last state */ }
  }

  function apply(s, token) {
    const wasOn = !!state.on, wasId = state.id, wasUp = !!state.timeup;
    skew = s.now * 1000 - Date.now();
    state = { on: !!s.on, title: String(s.title || ""), since: s.since || null, id: s.id || null,
              register: !!s.register, collect: s.collect || 0, client: String(s.client || ""),
              labs: Array.isArray(s.labs) ? s.labs : null, code: !!s.code, ends_at: s.ends_at || null,
              timeup: !!s.timeup, opts: s.opts || {}, message: s.message || null, at: Date.now() };
    if (isTop) window.__foctExam = state;
    ls.set(KEY, state);
    if (state.id !== wasId || !me) loadMe();
    if (me && token === me.token && state.on && state.register && !s.you) { ls.del(meKey()); me = null; }   // the server no longer knows us
    if (me && s.you) { me.saved = s.you.saved; serverLock = s.you.locked || null; }
    if (!state.on) { serverLock = localLock = null; }
    agent = s.agent || { ok: true, ready: true, kiosk: true, problem: "" };
    render();
    if (isTop && wasOn !== state.on) {
      toast(state.on ? "Exam mode is on: copy and paste are turned off." : "Exam mode has ended.");
    }
    if (!isTop) return;
    if (state.on && state.timeup && !wasUp) toast("Time is up.");
    if (state.on && state.register && !me && !state.timeup && labAllowed(PAGE_LAB) && helperOk()) signIn();
    else closeSignIn();
    if (collecting()) {
      const k = `foct.exam.collected.${state.id}`;
      if (state.collect > (ls.get(k) || 0)) {          // the teacher is collecting: send everything now
        ls.set(k, state.collect);
        syncWork(state.collect);
      }
    }
    showMessage();
  }

  // ------------------------------------------------------------ reporting incidents
  const blockedCounts = {};
  function countBlocked(what) {
    if (!isTop) { const api = topApi(); if (api) api.count(what); return; }
    blockedCounts[what] = (blockedCounts[what] || 0) + 1;
  }
  async function report(kind, detail = "", extra = {}) {   // -> the lock the server now has for us
    if (!isTop) { const api = topApi(); return api ? api.report(kind, detail, extra) : null; }
    if (!me || !state.on) return null;
    try {
      const r = await fetch("/__exam/event", {
        method: "POST", headers: { "Content-Type": "application/json", "X-FoCT-Token": me.token },
        body: JSON.stringify({ kind, detail, ...extra }),
      });
      if (r.ok) { serverLock = (await r.json()).locked || null; render(); }
    } catch { /* reported again next time */ }
    return serverLock;
  }
  function flushBlocked() {
    for (const [what, count] of Object.entries(blockedCounts)) {
      delete blockedCounts[what];
      if (me) report("blocked", what, { count });
    }
  }

  // ------------------------------------------------------------ clipboard, dropping, dragging
  const hasSelection = (e) => {
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) {
      try { return t.selectionEnd > t.selectionStart; } catch { return false; }
    }
    const sel = document.getSelection();
    return !!(sel && String(sel).length);
  };
  function block(e, say, what) {
    if (!active()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.__foctCanary) return;                        // our own self-test
    if (what) countBlocked(what);
    if (say) toast(say === true ? "Copy and paste are turned off during the exam." : say);
  }
  // Capture listeners on window run before any editor (Monaco, CodeMirror, ONLYOFFICE) sees the event.
  window.addEventListener("copy", (e) => { const s = hasSelection(e); block(e, s, s && "copy"); }, true);
  window.addEventListener("cut", (e) => { const s = hasSelection(e); block(e, s, s && "copy"); }, true);
  window.addEventListener("paste", (e) => block(e, true, "paste"), true);
  window.addEventListener("beforeinput", (e) => {
    if (/^insertFrom(Paste|Drop|YankPaste)/.test(e.inputType || "")) block(e, true, "paste");
  }, true);
  window.addEventListener("drop", (e) => block(e, true, "drop"), true);
  window.addEventListener("dragover", (e) => {
    if (active()) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; }
  }, true);
  window.addEventListener("dragstart", (e) => {
    const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
    if (types.includes("text/plain") || types.includes("text/html")) block(e, false);
  }, true);
  // The async Clipboard API (secure pages only) does not fire events, so wrap it.
  const cbWrapped = {};
  const cb = navigator.clipboard;
  if (cb) {
    for (const m of ["read", "readText", "write", "writeText"]) {
      if (typeof cb[m] !== "function") continue;
      const original = cb[m].bind(cb);
      try {
        cb[m] = cbWrapped[m] = (...args) => (active()
          ? Promise.reject(new DOMException("The clipboard is turned off during the exam.", "NotAllowedError"))
          : original(...args));
      } catch { /* read-only in this browser */ }
    }
  }

  // ------------------------------------------------------------ opening files, examples, keys, printing
  const OPEN_MSG = "Opening files is turned off during the exam. Use Submit files to hand in a file.";
  const blockOpen = () => active() && opts().block_open;
  const blockKeys = () => active() && opts().block_keys;
  const inputClick = HTMLInputElement.prototype.click;
  function ourInputClick(...args) {
    if (this.type === "file" && !this.__foctSubmit && blockOpen()) { countBlocked("open"); toast(OPEN_MSG); return undefined; }
    return inputClick.apply(this, args);
  }
  HTMLInputElement.prototype.click = ourInputClick;
  for (const fn of ["showOpenFilePicker", "showDirectoryPicker"]) {
    if (typeof window[fn] !== "function") continue;
    const original = window[fn].bind(window);
    window[fn] = (...args) => {
      if (!blockOpen()) return original(...args);
      countBlocked("open");
      toast(OPEN_MSG);
      return Promise.reject(new DOMException("Opening files is turned off during the exam.", "AbortError"));
    };
  }
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !blockOpen()) return;
    if (t.tagName === "INPUT" && t.type === "file" && !t.__foctSubmit) {
      e.preventDefault(); e.stopImmediatePropagation(); countBlocked("open"); toast(OPEN_MSG);
    } else if (location.pathname.startsWith("/apps/code/") && t.closest && t.closest("#examples button, #examples a")) {
      e.preventDefault(); e.stopImmediatePropagation(); countBlocked("example");
      toast("Example programs are not available during the exam.");
    }
  }, true);
  window.addEventListener("keydown", (e) => {
    const cover = coverEl();
    if (cover && !cover.contains(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!blockKeys()) return;
    const k = (e.key || "").toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    const devtools = e.key === "F12" || (ctrl && e.shiftKey && ["i", "j", "c"].includes(k))
      || (e.metaKey && e.altKey && ["i", "j", "c", "u"].includes(k)) || (e.ctrlKey && !e.shiftKey && !e.altKey && k === "u");
    const print = ctrl && !e.shiftKey && k === "p";
    if (!devtools && !print) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    countBlocked(print ? "print" : "devtoolskey");
    toast(print ? "Printing is turned off during the exam." : "Developer tools are turned off during the exam.");
  }, true);
  window.addEventListener("contextmenu", (e) => {        // the browser's menu (with Inspect) goes; the labs' own menus stay
    if (blockKeys()) { e.preventDefault(); countBlocked("rightclick"); }
  }, true);
  const origPrint = window.print;
  window.print = function () {
    if (blockKeys()) { countBlocked("print"); toast("Printing is turned off during the exam."); return undefined; }
    return origPrint.call(window);
  };

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
  function ourAnchorClick(...args) {
    try { captureAnchor(this); } catch { /* never block a download */ }
    return anchorClick.apply(this, args);
  }
  HTMLAnchorElement.prototype.click = ourAnchorClick;
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (a) captureAnchor(a);
  }, true);

  // ------------------------------------------------------------ leaving the exam, full screen, editors, screens
  // Every lab tab on this PC notes when it has the focus, so moving between lab tabs is not "leaving".
  const FOCUS = "foct.exam.focus", AWAY = "foct.exam.away";
  const tabId = Math.random().toString(36).slice(2);
  const watching = () => isTop && collecting() && !state.timeup;
  function markFocus() { if (isTop && document.hasFocus() && !document.hidden) ls.set(FOCUS, { tab: tabId, at: Date.now() }); }
  let awayTimer = 0;
  function maybeLeft() {
    if (!watching()) return;
    clearTimeout(awayTimer);
    awayTimer = setTimeout(() => {
      if (document.hasFocus() && !document.hidden) return;                // back already
      const f = ls.get(FOCUS);
      if (f && f.tab !== tabId && Date.now() - f.at < 2500) return;      // another lab tab has the focus
      if (!ls.get(AWAY)) ls.set(AWAY, { since: Date.now() - 1500, exam: state.id });
    }, 1500);
  }
  async function back() {
    markFocus();
    const a = ls.get(AWAY);
    if (!a || !watching()) return;
    ls.del(AWAY);
    if (a.exam !== state.id) return;
    const secs = (Date.now() - a.since) / 1000;
    if (secs < 2) return;
    const n = (ls.get(`foct.exam.left.${state.id}`) || 0) + 1;
    ls.set(`foct.exam.left.${state.id}`, n);
    await report("left", `${Math.round(secs)} s away`, { secs });
    if (opts().leave !== "log" && !currentLock()) {
      banner("warn", `You left the exam window (${n === 1 ? "once" : n + " times"}). This is reported to your teacher.`
        + (opts().leave === "lock" ? ` After ${opts().leave_limit || 3} times the exam is paused on this PC.` : ""));
    }
  }
  window.addEventListener("blur", maybeLeft);
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", () => (document.hidden ? maybeLeft() : back()));
  if (isTop) setInterval(markFocus, 1000);

  const fsNeeded = () => isTop && active() && opts().fullscreen && !state.timeup && (!state.register || !!me);
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && fsNeeded()) report("fullscreen", "left full screen");
    render();
  });

  let monacoHooked = false;
  function hookMonaco() {                                // text that appears 200+ characters at once
    const m = window.monaco;
    if (monacoHooked || !m || !m.editor || !m.editor.onDidCreateModel) return;
    monacoHooked = true;
    const watch = (model) => model.onDidChangeContent((e) => {
      if (!active() || e.isFlush || e.isUndoing || e.isRedoing) return;
      const big = Math.max(0, ...e.changes.map((c) => (c.text || "").length));
      if (big >= 200) report("bigins", `${big} characters at once`);
    });
    m.editor.getModels().forEach(watch);
    m.editor.onDidCreateModel(watch);
  }

  let twoScreens = false;
  function checkScreens() {                              // only offered by browsers on secure (HTTPS) pages
    if (!isTop || !("isExtended" in screen) || !collecting()) return;
    const ext = !!screen.isExtended;
    if (ext && !twoScreens) report("screen2", "a second screen is connected");
    twoScreens = ext;
  }
  try { if (screen.addEventListener) screen.addEventListener("change", checkScreens); } catch { /* not supported */ }

  // ------------------------------------------------------------ self-checks: developer tools and removed protections
  // A paused "debugger" statement takes measurable time - it pauses only while developer tools are open.
  const trap = (() => { try { return new Function("debugger"); } catch { return null; } })();   // eslint-disable-line no-new-func
  function devtoolsOpen() {
    if (!trap) return false;
    const t = performance.now();
    trap();
    return performance.now() - t > 120;
  }
  let canaryEl = null;
  function brokenProtection() {        // -> what was changed, or ""
    if (!canaryEl) { canaryEl = document.createElement("div"); canaryEl.hidden = true; canaryEl.setAttribute("aria-hidden", "true"); }
    mount(canaryEl);
    for (const type of ["paste", "copy", "drop"]) {
      let ev;
      try { ev = type === "drop" ? new DragEvent("drop", { bubbles: true, cancelable: true }) : new ClipboardEvent(type, { bubbles: true, cancelable: true }); } catch { continue; }
      ev.__foctCanary = true;
      canaryEl.dispatchEvent(ev);
      if (!ev.defaultPrevented) return `${type} protection removed`;
    }
    if (cbWrapped.readText && navigator.clipboard && navigator.clipboard.readText !== cbWrapped.readText) return "clipboard protection replaced";
    if (HTMLAnchorElement.prototype.click !== ourAnchorClick) return "download capture replaced";
    if (HTMLInputElement.prototype.click !== ourInputClick) return "file-open protection replaced";
    if (isTop) {
      for (const [el, what] of [[markEl, "watermark"], [frameEl, "exam frame"]]) {
        if (!el || !el.__foctShown) continue;
        if (!el.isConnected) return `${what} removed`;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity < 0.5
            || (el === markEl && !/svg/.test(cs.backgroundImage))) return `${what} hidden`;
      }
      if (styleEl && styleEl.__foctShown && (!styleEl.isConnected || styleEl.disabled || (styleEl.sheet && styleEl.sheet.disabled))) {
        return "exam styles removed";
      }
    }
    return "";
  }
  let lastTamper = "", normalStreak = 0;
  async function tamper(kind, detail) {
    if (!isTop) { const api = topApi(); if (api) api.tamper(kind, detail); return; }
    const sig = kind + detail;
    if (sig === lastTamper) return;                      // reported already
    lastTamper = sig;
    if (me && state.register) await report(kind, detail);
    else if (opts().tamper_lock) localLock = { reason: kind === "devtools" ? "Developer tools were opened" : `Exam protection changed (${detail})`, auto: true };
    render();
  }
  async function backToNormal() {
    lastTamper = "";
    if (localLock) { localLock = null; render(); }
    if (serverLock && serverLock.auto && me) {
      try {
        const r = await fetch("/__exam/ok", { method: "POST", headers: { "X-FoCT-Token": me.token } });
        if (r.ok) serverLock = (await r.json()).locked || null;
      } catch { /* try again on the next check */ }
      render();
    }
  }
  function runChecks() {
    if (!active() || (state.register && !me && isTop)) { normalStreak = 0; return; }
    if (isTop) hookMonaco();
    const dt = isTop && devtoolsOpen();
    const broken = brokenProtection();
    if (broken && isTop) render();                       // put the watermark back
    if (dt) tamper("devtools", "");
    else if (broken) tamper("tamper", broken);
    if (dt || broken) { normalStreak = 0; return; }
    if (isTop && lastTamper && !currentLock()) lastTamper = "";
    const L = isTop && currentLock();
    if (L && L.auto && ++normalStreak >= 3) { normalStreak = 0; backToNormal(); }
  }

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
.foct-exam-bar .left { white-space: nowrap; font-weight: 700; font-variant-numeric: tabular-nums; }
.foct-exam-bar .left.soon { color: #fde68a; }
.foct-exam-bar .st { white-space: nowrap; opacity: .85; font-weight: 500; }
.foct-exam-bar .st.warn { opacity: 1; color: #fde68a; }
.foct-exam-bar button { font: inherit; font-weight: 700; color: #b91c1c; background: #fff; border: 0; border-radius: 999px; padding: 5px 12px; cursor: pointer; }
.foct-exam-bar button:hover { background: #fee2e2; }
.foct-exam-toast { left: 50%; bottom: 84px; transform: translate(-50%, 8px); padding: 10px 18px; font-size: 14px; pointer-events: none;
  background: rgba(30, 27, 60, .94); box-shadow: 0 8px 24px rgba(0, 0, 0, .3); opacity: 0; transition: opacity .2s, transform .2s; }
.foct-exam-toast.show { opacity: 1; transform: translate(-50%, 0); }
.foct-exam-signin, .foct-exam-curtain { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
  background: rgba(20, 16, 40, .72); backdrop-filter: blur(3px); font: 15px/1.45 "Segoe UI", Roboto, Arial, sans-serif; }
.foct-exam-curtain { background: rgba(20, 16, 40, .9); }
.foct-exam-signin form, .foct-exam-curtain .card { width: min(460px, 100%); background: #fff; color: #1d1b33; border-radius: 16px; padding: 24px 24px 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .4); border-top: 6px solid #dc2626; }
.foct-exam-signin .k, .foct-exam-curtain .k, .foct-exam-msg .k { font-size: 12px; font-weight: 700; letter-spacing: .08em; color: #dc2626; text-transform: uppercase; }
.foct-exam-signin h2, .foct-exam-curtain h2 { font-size: 20px; margin: 4px 0 6px; line-height: 1.25; }
.foct-exam-signin p, .foct-exam-curtain p { margin: 0 0 14px; color: #55527a; font-size: 14px; }
.foct-exam-signin label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
.foct-exam-signin input { width: 100%; box-sizing: border-box; font: inherit; padding: 9px 11px; border: 1px solid #c9c6e0; border-radius: 9px; color: #1d1b33; background: #fff; }
.foct-exam-signin input:focus { outline: 2px solid #dc2626; outline-offset: 1px; }
.foct-exam-signin button, .foct-exam-curtain button, .foct-exam-curtain a.btn { display: block; box-sizing: border-box; margin-top: 18px; width: 100%; font: inherit; font-weight: 700;
  color: #fff; background: #dc2626; border: 0; border-radius: 10px; padding: 11px; cursor: pointer; text-align: center; text-decoration: none; }
.foct-exam-curtain a.btn { background: #342e6c; }
.foct-exam-signin button:disabled { opacity: .6; cursor: default; }
.foct-exam-signin .err { color: #b91c1c; font-size: 13px; min-height: 18px; margin-top: 8px; }
.foct-exam-msg { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647; width: min(560px, calc(100vw - 28px));
  background: #fff; color: #1d1b33; border-radius: 14px; padding: 14px 16px; box-shadow: 0 16px 50px rgba(0, 0, 0, .35); border-left: 6px solid #dc2626;
  font: 14px/1.45 "Segoe UI", Roboto, Arial, sans-serif; display: flex; gap: 14px; align-items: flex-start; }
.foct-exam-msg.warn { border-left-color: #f59e0b; }
.foct-exam-msg .txt { flex: 1; white-space: pre-wrap; }
.foct-exam-msg button { font: inherit; font-weight: 700; color: #fff; background: #342e6c; border: 0; border-radius: 9px; padding: 7px 16px; cursor: pointer; }
.foct-exam-off { opacity: .35 !important; filter: grayscale(1); pointer-events: none !important; }
html.foct-exam .foct-bar { box-shadow: inset 0 0 0 9999px rgba(220, 38, 38, .10); }
html.foct-exam .foct-toasts { bottom: 80px; }   /* the labs' own messages stay above the exam bar */
html.foct-exam .foct-bar::after { background: linear-gradient(90deg, #dc2626, #f59e0b); }
@media print {
  .foct-exam-toast, .foct-exam-bar button, .foct-exam-signin, .foct-exam-msg { display: none; }
  html.foct-exam.foct-exam-noprint body { display: none !important; }
  html.foct-exam.foct-exam-noprint::after { content: "Printing is turned off during the exam."; display: block; padding: 40px; font: 20px sans-serif; }
}`;
  let styleEl, markEl, frameEl, badgeEl, barEl, toastEl, signEl, curtainEl, toastTimer, clockTimer;
  let lastToast = "", lastToastAt = 0;
  const make = (cls, tag = "div") => { const d = document.createElement(tag); d.className = cls; return d; };
  const mount = (el) => { if (!el.isConnected) document.documentElement.appendChild(el); };
  const coverEl = () => (curtainEl && curtainEl.isConnected ? curtainEl : signEl && signEl.isConnected ? signEl : null);
  function addStyle() {
    if (!styleEl) { styleEl = document.createElement("style"); styleEl.textContent = CSS; }
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
    styleEl.__foctShown = true;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hhmm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  };
  const timeLeft = () => (state.ends_at && !state.timeup ? state.ends_at * 1000 - serverNow() : null);

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

  // which blocking screen this page needs now, or null
  function curtainFor() {
    if (!isTop || !state.on) return null;
    if (!labAllowed(PAGE_LAB)) {
      return { kind: "notlab", title: "This lab is not part of the exam", home: true,
               text: "Your teacher has chosen which labs can be used during this exam." };
    }
    if (state.timeup) {
      return { kind: "timeup", title: "Time is up",
               text: me ? "Your work has been sent to your teacher. You can stop now." : "The time for this exam is over." };
    }
    if (state.opts && state.opts.helper) {
      if (!agent.ok) {
        return { kind: "helper", title: "Run the exam helper first", download: true,
                 text: "This exam needs the FoCT exam helper on this PC. Open “FoCT exam helper” (your teacher may have put it on the desktop), "
                     + "or download it below and open it. It closes other programs and opens the exam in its own full-screen window." };
      }
      if (!agent.ready) {
        return { kind: "helper", title: "The exam helper is starting", text: agent.problem || "Wait a moment; the exam opens in its own full-screen window." };
      }
      if (!agent.kiosk) {
        return { kind: "kiosk", title: "Use the exam window",
                 text: "The exam helper has opened the exam in its own full-screen window. Close this browser and use that one." };
      }
    }
    if (state.register && !me) return null;               // the sign-in card shows instead
    const L = currentLock();
    if (L) {
      return { kind: "lock", title: "Exam paused on this PC",
               text: `${L.reason}. ` + (L.auto ? "Close the developer tools and undo any changes. This screen unlocks by itself when everything is back to normal."
                                               : "Your teacher will let you back in.")
                     + (me ? " Your teacher has been notified. Work you did before this is safe." : "") };
    }
    if (fsNeeded() && !document.fullscreenElement) {
      return { kind: "fullscreen", title: "The exam runs in full screen", button: "Continue in full screen",
               text: "Leaving full screen is reported to your teacher." };
    }
    return null;
  }
  function renderCurtain() {
    const c = curtainFor();
    if (!c) { if (curtainEl) { curtainEl.remove(); curtainEl = null; } return; }
    addStyle();
    const sig = c.kind + "|" + c.text;
    if (!curtainEl || curtainEl.dataset.sig !== sig) {
      if (!curtainEl) { curtainEl = make("foct-exam-curtain"); curtainEl.setAttribute("role", "alertdialog"); curtainEl.setAttribute("aria-modal", "true"); }
      curtainEl.dataset.sig = sig;
      curtainEl.innerHTML = `<div class="card"><div class="k">Exam &middot; ${esc(state.title || "FoCT Virtual Labs")}</div>
        <h2>${esc(c.title)}</h2><p>${esc(c.text)}</p>
        ${c.button ? `<button type="button">${esc(c.button)}</button>` : ""}${c.home ? '<a class="btn" href="/">Back to the labs</a>' : ""}
        ${c.download ? '<a class="btn" href="/exam-helper.vbs">Download the exam helper</a>' : ""}</div>`;
      const b = curtainEl.querySelector("button");
      if (b) b.onclick = () => { document.documentElement.requestFullscreen().catch(() => toast("Press F11 or allow full screen.")); };
      setTimeout(() => { const f = curtainEl && curtainEl.querySelector("button, a"); if (f) f.focus(); }, 0);
    }
    const put = () => mount(curtainEl);
    if (document.body) put(); else document.addEventListener("DOMContentLoaded", put, { once: true });
  }

  function render() {
    document.documentElement.classList.toggle("foct-exam", active());
    document.documentElement.classList.toggle("foct-exam-noprint", blockKeys());
    if (!isTop) return;
    renderCurtain();
    markPortal();
    if (!state.on) {
      for (const el of [markEl, frameEl, badgeEl, barEl]) if (el) { el.remove(); el.__foctShown = false; }
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
    [markEl, frameEl].forEach((el) => { mount(el); el.__foctShown = true; });
    if (collecting()) {
      badgeEl.remove();
      if (!barEl) {
        barEl = make("foct-exam-bar");
        barEl.innerHTML = '<span class="who"></span><span class="left"></span><span class="st"></span><button type="button">Submit files</button>';
        barEl.querySelector("button").onclick = submitFiles;
      }
      barEl.querySelector(".who").textContent = `EXAM · ${me.name} · ${me.enrolment}`;
      if (!status.text && me.saved) setStatus(`Work sent ${hhmm(me.saved * 1000 - skew)}`);
      setStatus(status.text || "Your work is sent to your teacher automatically", status.warn);
      mount(barEl);
    } else {
      if (barEl) barEl.remove();
      mount(badgeEl);
    }
    tickClock();
    if (!clockTimer) clockTimer = setInterval(tickClock, 1000);
  }

  let warned = {};
  function tickClock() {
    if (!state.on) return;
    const left = timeLeft();
    const text = left == null ? "" : `${clock(left)} left`;
    if (barEl && barEl.isConnected) {
      const el = barEl.querySelector(".left");
      el.textContent = text;
      el.classList.toggle("soon", left != null && left < 10 * 60e3);
    } else if (badgeEl) {
      badgeEl.textContent = "EXAM MODE · copy & paste off" + (text ? ` · ${text}` : "");
    }
    if (left != null) {
      for (const [mins, msg] of [[10, "10 minutes left. Save your work."], [1, "1 minute left."]]) {
        const k = `${state.id}:${mins}`;
        if (left <= mins * 60e3 && left > (mins * 60e3 - 60e3) && !warned[k]) { warned[k] = true; banner("warn", msg); }
      }
      if (left <= 0) poll();                             // the server confirms "time is up"
    }
    if (Date.now() % 30000 < 1000 && markEl) markEl.style.backgroundImage = watermark();
  }

  function markPortal() {                                // grey out the labs that are not part of the exam
    if (location.pathname !== "/" && location.pathname !== "/index.html") return;
    const grey = () => document.querySelectorAll("a[href^='/apps/']").forEach((a) => {
      const u = new URL(a.getAttribute("href"), location.origin);
      const off = active() && !labAllowed(labOf(u.pathname, u.search));
      a.classList.toggle("foct-exam-off", off);
      if (off) a.title = "Not part of this exam";
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", grey, { once: true }); else grey();
  }

  function toast(msg) {
    if (!isTop) { const api = topApi(); if (api) api.toast(msg); return; }
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

  let bannerEl = null;
  function banner(kind, text, onOk) {                    // a notice at the top with an OK button
    if (!isTop) return;
    addStyle();
    if (bannerEl) bannerEl.remove();
    bannerEl = make(`foct-exam-msg ${kind === "warn" ? "warn" : ""}`);
    bannerEl.setAttribute("role", "alert");
    bannerEl.innerHTML = `<div class="txt"><div class="k">${kind === "warn" ? "Exam" : "Message from your teacher"}</div>${esc(text)}</div><button type="button">OK</button>`;
    const el = bannerEl;
    el.querySelector("button").onclick = () => { el.remove(); if (bannerEl === el) bannerEl = null; if (onOk) onOk(); };
    const put = () => mount(el);
    if (document.body) put(); else document.addEventListener("DOMContentLoaded", put, { once: true });
  }
  function showMessage() {
    const m = state.message;
    if (!isTop || !state.on || !m || !m.text) return;
    const k = `foct.exam.msg.${state.id}`;
    if (ls.get(k) === m.id || (bannerEl && bannerEl.dataset.msg === m.id)) return;
    banner("msg", m.text, () => ls.set(k, m.id));
    bannerEl.dataset.msg = m.id;
  }

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
      ${state.code ? '<label for="foctExamCode">Exam code (on the board)</label><input id="foctExamCode" name="code" autocomplete="off" inputmode="numeric" maxlength="12" required>' : ""}
      <div class="err" role="alert"></div>
      <button type="submit">Start exam</button>
    </form>`;
    const form = signEl.querySelector("form"), err = signEl.querySelector(".err"), btn = signEl.querySelector("button");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = form.name.value.trim(), enrolment = form.enrolment.value.trim(), code = form.code ? form.code.value.trim() : "";
      if (name.length < 2) { err.textContent = "Please enter your full name."; form.name.focus(); return; }
      if (enrolment.length < 2) { err.textContent = "Please enter your enrolment number."; form.enrolment.focus(); return; }
      if (form.code && !code) { err.textContent = "Please enter the exam code."; form.code.focus(); return; }
      btn.disabled = true;
      err.textContent = "";
      try {
        const r = await fetch("/__exam/register", { method: "POST", headers: { "Content-Type": "application/json" },
                                                     body: JSON.stringify({ exam: state.id, name, enrolment, code, kiosk: kioskKey() }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Could not sign in. Ask your teacher.");
        // What is already in this browser does not count as this exam's work.
        const base = {};
        for (const [k, list] of Object.entries(readDrafts())) base[k] = draftHash(list);
        ls.set(`foct.exam.base.${state.id}`, base);
        me = { token: j.token, name: j.name, enrolment: j.enrolment, folder: j.folder, saved: null };
        ls.set(meKey(), me);
        ss.set("foct.exam.welcome", j.name);
        location.reload();          // the labs load now that the server knows this PC
      } catch (ex) {
        err.textContent = ex.message || "Could not sign in.";
        btn.disabled = false;
      }
    };
    // keep the keyboard inside the dialog
    signEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Tab") return;
      const f = Array.from(form.querySelectorAll("input, button"));
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
    input.__foctSubmit = true;
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
    if (e.key && e.key.startsWith("foct.exam.me.")) { loadMe(); if (me) location.reload(); else render(); }
  });

  if (isTop) window.__foctExamApi = { capture, collecting, count: countBlocked, report, tamper, toast };

  // ------------------------------------------------------------ start
  render();
  if (isTop) {
    const welcome = ss.get("foct.exam.welcome");
    if (welcome) { ss.del("foct.exam.welcome"); setTimeout(() => toast(`Welcome, ${welcome}. Your work is sent to your teacher automatically.`), 400); }
  }
  if (isTop || !canReadTop) {
    poll();
    setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) poll();
      else if (collecting()) syncWork(0);      // the student is leaving this page: send what changed
    });
  }
  if (isTop) {
    setInterval(() => { if (collecting() && !document.hidden) syncWork(0); }, SYNC_MS);
    setInterval(flushBlocked, 15000);
    setInterval(checkScreens, 20000);
    setTimeout(checkScreens, 3000);
  }
  setInterval(runChecks, CHECK_MS);
})();
