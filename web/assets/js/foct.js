// FoCT Virtual Labs - shared helpers (theme, toasts, dialogs, local files, system check)

const THEME_KEY = "foct.theme";

export function initTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch {}
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
}

export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  window.dispatchEvent(new CustomEvent("foct-theme", { detail: t }));
}

export function toggleTheme() {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}

// ------------------------------------------------------------------ toasts
let toastBox;
export function toast(msg, kind = "", ms = 3200) {
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.className = "foct-toasts";
    toastBox.setAttribute("role", "status");
    document.body.appendChild(toastBox);
  }
  const el = document.createElement("div");
  el.className = "foct-toast " + kind;
  el.textContent = msg;
  toastBox.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ------------------------------------------------------------------ dialogs
export function modal({ title, html = "", body = null, actions = [{ label: "OK", value: true, primary: true }] }) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "foct-modal-back";
    const box = document.createElement("div");
    box.className = "foct-modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const h = document.createElement("h2");
    h.textContent = title;
    box.appendChild(h);
    const content = document.createElement("div");
    if (body) content.appendChild(body); else content.innerHTML = html;
    box.appendChild(content);
    const row = document.createElement("div");
    row.className = "actions";
    const close = (v) => { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    for (const a of actions) {
      const b = document.createElement("button");
      b.className = "btn " + (a.primary ? "btn-primary" : "") + (a.danger ? " btn-stop" : "");
      b.textContent = a.label;
      b.onclick = () => close(typeof a.value === "function" ? a.value(box) : a.value);
      row.appendChild(b);
    }
    box.appendChild(row);
    back.appendChild(box);
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(null); });
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(back);
    (box.querySelector("input,textarea,select") || row.querySelector(".btn-primary") || row.lastChild)?.focus();
  });
}

export async function prompt(title, value = "", label = "") {
  const body = document.createElement("label");
  body.style.display = "grid";
  body.style.gap = ".35rem";
  body.innerHTML = `<span style="color:var(--muted)"></span><input class="foct-input" style="padding:.5rem .6rem;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface-2)">`;
  body.querySelector("span").textContent = label;
  const input = body.querySelector("input");
  input.value = value;
  setTimeout(() => { input.focus(); const dot = value.lastIndexOf("."); input.setSelectionRange(0, dot > 0 ? dot : value.length); });
  const done = new Promise((resolve) => input.addEventListener("keydown", (e) => { if (e.key === "Enter") resolve(true); }));
  const p = modal({ title, body, actions: [{ label: "Cancel", value: null }, { label: "OK", value: true, primary: true }] });
  const r = await Promise.race([p, done.then((v) => { document.querySelector(".foct-modal-back")?.remove(); return v; })]);
  return r ? input.value.trim() : null;
}

// ------------------------------------------------------------------ files on the student's PC
export const canPickFiles = "showSaveFilePicker" in window && window.isSecureContext;

/** Save text/bytes to the student's computer. Returns a file handle when the
 *  browser lets us write the same file again next time (Chrome/Edge over HTTPS). */
export async function saveToDisk(name, data, { handle = null, saveAs = false, mime = "text/plain", description = "File" } = {}) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (canPickFiles) {
    try {
      let h = handle;
      if (!h || saveAs) {
        const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
        h = await window.showSaveFilePicker({
          suggestedName: name,
          types: ext ? [{ description, accept: { [mime.split(";")[0] || "text/plain"]: [ext] } }] : undefined,
        });
      }
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      try { window.__foctExamSaved?.(h.name, blob); } catch {}   // exam mode: the teacher gets a copy (downloads are caught by exam.js)
      return { handle: h, name: h.name, method: "file" };
    } catch (e) {
      if (e && e.name === "AbortError") return null;
      console.warn("File System Access failed, falling back to download", e);
    }
  }
  downloadBlob(name, blob);
  return { handle: null, name, method: "download" };
}

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Let the student pick files from their computer. Resolves to [{name, file, handle}] */
export async function pickFiles({ accept = "", multiple = true } = {}) {
  if (canPickFiles && "showOpenFilePicker" in window) {
    try {
      const exts = accept.split(",").map((s) => s.trim()).filter((s) => s.startsWith("."));
      const handles = await window.showOpenFilePicker({
        multiple,
        types: exts.length ? [{ description: "Files", accept: { "text/plain": exts } }] : undefined,
        excludeAcceptAllOption: false,
      });
      return Promise.all(handles.map(async (h) => ({ name: h.name, file: await h.getFile(), handle: h })));
    } catch (e) {
      if (e && e.name === "AbortError") return [];
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.style.display = "none";
    input.onchange = () => { resolve([...input.files].map((f) => ({ name: f.name, file: f, handle: null }))); input.remove(); };
    input.oncancel = () => { resolve([]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

// ------------------------------------------------------------------ zip (store-only) for "download all"
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function makeZip(files) {
  // files: [{name, data: string|Uint8Array}]
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true); cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// ------------------------------------------------------------------ system check
export function browserInfo() {
  const ua = navigator.userAgent;
  const pick = (re, name) => { const m = ua.match(re); return m ? { name, version: parseInt(m[1], 10) } : null; };
  return pick(/Edg\/(\d+)/, "Edge") || pick(/OPR\/(\d+)/, "Opera") || pick(/Firefox\/(\d+)/, "Firefox") ||
    pick(/Chrome\/(\d+)/, "Chrome") || pick(/Version\/(\d+).*Safari/, "Safari") || { name: "Unknown browser", version: 0 };
}

export function systemCheck() {
  const wasm = typeof WebAssembly === "object";
  let wasmGC = false;
  try { wasmGC = wasm && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0])); } catch {}
  const jspi = wasm && typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
  return {
    browser: browserInfo(),
    wasm,
    wasmGC,
    jspi,
    isolated: !!window.crossOriginIsolated,
    secure: !!window.isSecureContext,
    fileAccess: canPickFiles,
    memoryGB: navigator.deviceMemory || null,
    cores: navigator.hardwareConcurrency || null,
  };
}

/** How interactive keyboard input reaches a running program. */
export function inputMode(cap = systemCheck()) {
  if (cap.jspi) return "jspi";
  if (cap.isolated) return "sab";
  return "batch";
}

// ------------------------------------------------------------------ privacy on shared lab PCs
export async function clearLabData() {
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  try {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((d) => new Promise((res) => {
        const r = indexedDB.deleteDatabase(d.name);
        r.onsuccess = r.onerror = r.onblocked = () => res();
      })));
    }
  } catch {}
  try { for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    for (const r of regs || []) await r.unregister();
  } catch {}
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

initTheme();
