// FoCT Virtual Labs - Packet Analyzer: open network captures and explore them with Wireshark's own
// protocol dissectors (Wiregasm: Wireshark compiled to WebAssembly), entirely inside the browser.
import { toast, modal, pickFiles, saveToDisk, toggleTheme, escapeHtml as esc } from "/assets/js/foct.js";
import { slicePackets, captureFormat } from "/assets/js/pcap.js";

const $ = (id) => document.getElementById(id);
const ROW = 24;                       // px per packet row
const MAX_ROWS = 200000;              // rows fetched for one filter
const MAX_FILE = 300 << 20;
const QUICK = ["arp", "icmp", "dns", "dhcp", "tcp", "udp", "http", "tls", "ftp"];
const WIDTHS = { "No.": "72px", Time: "104px", Source: "170px", Destination: "170px", Protocol: "88px", Length: "68px", Info: "minmax(260px, 1fr)" };
const RIGHT = new Set(["No.", "Time", "Length"]);

// ---------------------------------------------------------------- Wireshark, in a worker
const worker = new Worker("worker.js", { type: "module" });
const pending = new Map();
let nextId = 0;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "status") { if (m.text && !engineOk) engineState("busy", m.text); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
};
worker.onerror = (e) => { engineState("bad", "Wireshark could not start"); console.error(e); };
function call(cmd, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args });
  });
}

let engineOk = false;
let COLS = ["No.", "Time", "Source", "Destination", "Protocol", "Length", "Info"];
function engineState(state, text) {
  const c = $("engine");
  c.className = "chip " + state;
  c.innerHTML = `<span class="dot"></span>${esc(text)}`;
}
const started = performance.now();
const ready = call("init").then((r) => {
  engineOk = true;
  if (r && r.columns && r.columns.length) COLS = r.columns;
  engineState("ok", "Wireshark 4.6 ready");
  $("engine").title = `Wireshark's dissectors (Wiregasm) loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`;
  header();
}).catch((e) => { engineState("bad", "Wireshark could not start"); toast(e.message, "bad", 8000); throw e; });

// ---------------------------------------------------------------- state
let cap = null;          // { name, bytes, summary, sample }
let rows = [];           // packets shown: { n, bg, fg, cols }
let matched = 0;
let filterText = "";
let selN = 0;            // the selected packet's number
let detail = null;       // the selected packet's tree and bytes
let flat = [];           // tree nodes by id
let curSrc = 0;          // which data source the bytes pane shows
let hl = null;           // highlighted bytes { src, start, length }
let selNode = -1;
const expanded = new Set();
let samples = [];

// ---------------------------------------------------------------- opening captures
async function openBytes(name, bytes, sample = null) {
  if (!captureFormat(bytes) && !confirmOther(name)) return;
  engineState(engineOk ? "busy" : "busy", `Opening ${name} …`);
  try {
    await ready;
    const summary = await call("load", name, bytes);
    cap = { name, bytes, summary, sample };
    selN = 0; detail = null; filterText = ""; $("filter").value = ""; $("filter").className = "";
    $("empty").hidden = true;
    for (const id of ["btnStats", "btnSave"]) $(id).disabled = false;
    exercise(sample);
    try { sessionStorage.setItem("foct.packets.last", sample ? sample.file : ""); } catch { /* private mode */ }
    await refreshRows(true);
    engineState("ok", "Wireshark 4.6 ready");
  } catch (e) {
    engineState("ok", "Wireshark 4.6 ready");
    await modal({ title: "This file could not be opened", html: `<p>${esc(name)}: ${esc(e.message)}</p><p>The analyzer opens capture files saved by Wireshark, tcpdump and most other capture tools (.pcap, .pcapng).</p>` });
  }
}
function confirmOther(name) {
  // Wireshark reads many other formats too; let it try.
  return !!name;
}

async function openFile() {
  const files = await pickFiles({ accept: ".pcap,.pcapng,.cap,.pcap.gz,.pcapng.gz,.trc,.snoop", multiple: false });
  if (!files.length) return;
  const f = files[0].file;
  if (f.size > MAX_FILE) { toast(`${f.name} is larger than ${MAX_FILE >> 20} MB. Save a smaller part of it in Wireshark first.`, "bad", 6000); return; }
  openBytes(f.name, new Uint8Array(await f.arrayBuffer()));
}

async function openSample(s) {
  const r = await fetch("samples/" + s.file);
  if (!r.ok) { toast("This example is missing on the server.", "bad"); return; }
  openBytes(s.file, new Uint8Array(await r.arrayBuffer()), s);
}

// ---------------------------------------------------------------- packet list
function header() {
  $("plist").style.setProperty("--cols", COLS.map((c) => WIDTHS[c] || "120px").join(" "));
  $("phead").innerHTML = COLS.map((c) => `<span${RIGHT.has(c) ? ' style="text-align:right"' : ""}>${esc(c)}</span>`).join("");
  $("phead").style.setProperty("--cols", $("plist").style.getPropertyValue("--cols"));
}

async function refreshRows(first = false) {
  if (!cap) return;
  const r = await call("frames", filterText, 0, MAX_ROWS);
  rows = r.frames;
  matched = r.matched;
  let i = rows.findIndex((x) => x.n === selN);
  if (i < 0 && rows.length) i = 0;
  $("pbody").scrollTop = first ? 0 : $("pbody").scrollTop;
  renderRows();
  status();
  if (i >= 0) select(i, true); else { selN = 0; showDetail(null); }
}

const hex6 = (v) => "#" + ((v >>> 0) & 0xffffff).toString(16).padStart(6, "0");
const dark = () => document.documentElement.dataset.theme === "dark" ||
  (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

function rowStyle(r) {
  if (r.bg == null) return "";
  const bg = hex6(r.bg), fg = hex6(r.fg);
  if (dark()) return `background:color-mix(in srgb, ${bg} 24%, var(--surface));${(r.fg & 0xffffff) > 0x404040 ? `color:${fg}` : ""}`;
  return `background:${bg};color:${fg}`;
}

function renderRows() {
  const body = $("pbody");
  $("pspacer").style.height = rows.length * ROW + "px";
  const first = Math.max(0, Math.floor(body.scrollTop / ROW) - 8);
  const last = Math.min(rows.length, Math.ceil((body.scrollTop + body.clientHeight) / ROW) + 8);
  const box = $("prows");
  box.style.transform = `translateY(${first * ROW}px)`;
  let html = "";
  for (let i = first; i < last; i++) {
    const r = rows[i];
    html += `<div class="prow${r.n === selN ? " sel" : ""}" data-i="${i}" style="${rowStyle(r)}">` +
      r.cols.map((c, k) => `<span${RIGHT.has(COLS[k]) ? ' class="r"' : ""}>${esc(c)}</span>`).join("") + "</div>";
  }
  box.innerHTML = html;
}
$("pbody").addEventListener("scroll", () => requestAnimationFrame(renderRows), { passive: true });
new ResizeObserver(() => renderRows()).observe($("pbody"));

$("prows").addEventListener("mousedown", (e) => {
  const row = e.target.closest(".prow");
  if (row) { select(+row.dataset.i); $("pbody").focus(); }
});
$("prows").addEventListener("dblclick", () => { if (detail && detail.follow.length) followStream(); });

function select(i, quiet = false) {
  if (i < 0 || i >= rows.length) return;
  selN = rows[i].n;
  const body = $("pbody");
  if (i * ROW < body.scrollTop) body.scrollTop = i * ROW;
  else if ((i + 1) * ROW > body.scrollTop + body.clientHeight) body.scrollTop = (i + 1) * ROW - body.clientHeight;
  renderRows();
  loadDetail(selN);
  void quiet;
}

$("pbody").addEventListener("keydown", (e) => {
  const i = rows.findIndex((x) => x.n === selN);
  const page = Math.max(1, Math.floor($("pbody").clientHeight / ROW) - 1);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + page, PageUp: i - page, Home: 0, End: rows.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  select(Math.max(0, Math.min(rows.length - 1, to)));
});

let detailSeq = 0;
async function loadDetail(n) {
  const mine = ++detailSeq;
  try {
    const d = await call("frame", n);
    if (mine !== detailSeq) return;
    showDetail(d);
  } catch (e) {
    if (mine === detailSeq) $("pdetail").innerHTML = `<div class="none">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------- packet details
function nodeKey(nd, parent) { return parent + "/" + (nd.filter || nd.label.replace(/[:(].*$/s, "")).slice(0, 80); }

function showDetail(d) {
  detail = d;
  flat = [];
  selNode = -1;
  hl = null;
  $("btnFollow").disabled = !(d && d.follow.length);
  if (!d) {
    $("pdetail").innerHTML = '<div class="none">Select a packet to see its protocol layers.</div>';
    $("pbytes").innerHTML = '<div class="none">The packet\'s bytes appear here.</div>';
    return;
  }
  $("pdetail").innerHTML = tree(d.tree, 0, "");
  curSrc = 0;
  renderBytes();
}

function tree(nodes, depth, parent) {
  let html = "";
  for (const nd of nodes) {
    const k = nodeKey(nd, parent);
    const id = flat.push({ ...nd, key: k, depth }) - 1;
    const kids = nd.children.length;
    const open = kids && expanded.has(k);
    const expert = /^\[.*\]$/s.test(nd.label) || /^Expert Info/.test(nd.label);
    const label = esc(nd.label);
    html += `<div class="node${kids && !open ? " closed" : ""}" data-n="${id}"><span class="lbl" data-id="${id}" style="--d:${depth}">` +
      `<span class="tw">${kids ? (open ? "▾" : "▸") : ""}</span>` +
      `<span class="${depth === 0 ? "proto" : expert ? "warnlbl" : ""}">${label}</span>` +
      (nd.filter ? `<span class="af" data-af="${id}" title="Show only packets with ${esc(nd.filter)}">filter</span>` : "") +
      `</span>${kids ? `<div class="kids">${tree(nd.children, depth + 1, k)}</div>` : ""}</div>`;
  }
  return html;
}

function toggleNode(el) {
  const node = el.closest(".node");
  const nd = flat[+node.dataset.n];
  if (!nd.children.length) return;
  const open = node.classList.toggle("closed") === false;
  if (open) expanded.add(nd.key); else expanded.delete(nd.key);
  node.querySelector(":scope > .lbl .tw").textContent = open ? "▾" : "▸";
}

function pickNode(id, scroll = false) {
  $("pdetail").querySelector(".lbl.sel")?.classList.remove("sel");
  const lbl = $("pdetail").querySelector(`.lbl[data-id="${id}"]`);
  if (!lbl) return;
  lbl.classList.add("sel");
  selNode = id;
  const nd = flat[id];
  hl = nd.length > 0 ? { src: nd.src || 0, start: nd.start, length: nd.length } : null;
  if (hl && hl.src !== curSrc && detail.sources[hl.src]) curSrc = hl.src;
  renderBytes(true);
  if (scroll) lbl.scrollIntoView({ block: "nearest" });
}

$("pdetail").addEventListener("click", (e) => {
  const af = e.target.closest(".af");
  if (af) {
    const f = flat[+af.dataset.af].filter;
    const cur = $("filter").value.trim();
    applyFilter(e.shiftKey && cur ? `${cur} && ${f}` : f);
    return;
  }
  const lbl = e.target.closest(".lbl");
  if (!lbl) return;
  if (e.target.closest(".tw")) toggleNode(lbl);
  pickNode(+lbl.dataset.id);
});
$("pdetail").addEventListener("dblclick", (e) => { const lbl = e.target.closest(".lbl"); if (lbl && !e.target.closest(".af")) toggleNode(lbl); });

// ---------------------------------------------------------------- packet bytes
function renderBytes(keepScroll = false) {
  const box = $("pbytes");
  if (!detail || !detail.sources.length) { box.innerHTML = '<div class="none">No bytes for this packet.</div>'; return; }
  const top = box.scrollTop;
  const src = detail.sources[curSrc] || detail.sources[0];
  const data = src.data;
  const lim = Math.min(data.length, 1 << 20);
  const inHl = (o) => hl && hl.src === curSrc && o >= hl.start && o < hl.start + hl.length;
  let out = "";
  for (let off = 0; off < lim; off += 16) {
    let hx = "", asc = "";
    for (let j = 0; j < 16; j++) {
      const o = off + j;
      if (o >= lim) { hx += j === 8 ? "    " : "   "; continue; }
      const b = data[o], cls = inHl(o) ? ' class="hl"' : "";
      hx += (j === 8 ? "  " : " ") + `<i data-o="${o}"${cls}>${b.toString(16).padStart(2, "0")}</i>`;
      asc += `<i data-o="${o}"${cls}>${b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : "·"}</i>`;
    }
    out += `<span class="off">${off.toString(16).padStart(4, "0")}</span> ${hx}   ${asc}\n`;
  }
  const tabs = detail.sources.length > 1
    ? `<div class="btabs">${detail.sources.map((s, i) => `<button data-src="${i}" class="${i === curSrc ? "on" : ""}">${esc(s.name || "Frame")}</button>`).join("")}</div>`
    : "";
  box.innerHTML = tabs + `<div class="hex">${out}${data.length > lim ? "\n… (only the first 1 MB is shown)" : ""}</div>`;
  if (keepScroll) {
    box.scrollTop = top;
    const first = box.querySelector("i.hl");
    if (first) {
      const r = first.getBoundingClientRect(), b = box.getBoundingClientRect();
      if (r.top < b.top + 30 || r.bottom > b.bottom) first.scrollIntoView({ block: "center" });
    }
  }
}

$("pbytes").addEventListener("click", (e) => {
  const t = e.target.closest("[data-src]");
  if (t) { curSrc = +t.dataset.src; renderBytes(); return; }
  const b = e.target.closest("i[data-o]");
  if (!b || !detail) return;
  const o = +b.dataset.o;
  // the smallest field that holds this byte
  let best = -1;
  flat.forEach((nd, id) => {
    if ((nd.src || 0) === curSrc && nd.length > 0 && o >= nd.start && o < nd.start + nd.length &&
        (best < 0 || nd.length <= flat[best].length)) best = id;
  });
  if (best < 0) return;
  let el = $("pdetail").querySelector(`.lbl[data-id="${best}"]`)?.closest(".node")?.parentElement?.closest(".node");
  while (el) {                                  // open the layers above it
    if (el.classList.contains("closed")) toggleNode(el.querySelector(":scope > .lbl"));
    el = el.parentElement?.closest(".node");
  }
  pickNode(best, true);
});

// ---------------------------------------------------------------- display filter
const input = $("filter");
let checkTimer = 0, sugTimer = 0, sugIndex = -1, sugToken = null;

async function check() {
  const f = input.value.trim();
  if (!f) { input.className = ""; input.title = ""; return; }
  try {
    const r = await call("check", f);
    if (input.value.trim() !== f) return;
    input.className = r.ok ? "ok" : "bad";
    input.title = r.ok ? "" : r.error;
  } catch { /* engine not ready yet */ }
}

async function applyFilter(f) {
  f = (f ?? input.value).trim();
  hideSuggest();
  if (f) {
    await ready;
    const r = await call("check", f);
    if (!r.ok) { input.value = f; input.className = "bad"; toast(r.error || "This filter has a mistake.", "bad", 5000); return; }
  }
  input.value = f;
  input.className = f ? "ok" : "";
  filterText = f;
  if (!cap) { toast("Open a capture first."); return; }
  await refreshRows(true);
}

input.addEventListener("input", () => {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(check, 140);
  clearTimeout(sugTimer);
  sugTimer = setTimeout(suggest, 90);
});
input.addEventListener("keydown", (e) => {
  const box = $("suggest");
  if (!box.hidden && ["ArrowDown", "ArrowUp"].includes(e.key)) {
    e.preventDefault();
    const items = box.children;
    sugIndex = (sugIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    [...items].forEach((x, i) => x.classList.toggle("on", i === sugIndex));
    items[sugIndex].scrollIntoView({ block: "nearest" });
    return;
  }
  if (!box.hidden && (e.key === "Tab" || (e.key === "Enter" && sugIndex >= 0))) {
    e.preventDefault();
    takeSuggestion(box.children[Math.max(0, sugIndex)].dataset.f);
    return;
  }
  if (e.key === "Escape") { hideSuggest(); return; }
  if (e.key === "Enter") { e.preventDefault(); applyFilter(); }
});
input.addEventListener("blur", () => setTimeout(hideSuggest, 150));

async function suggest() {
  const before = input.value.slice(0, input.selectionStart);
  const m = /(^|[\s()!&|=<>~,])([A-Za-z_][\w.\-]*)$/.exec(before);
  const quoted = (before.match(/"/g) || []).length % 2 === 1;
  if (!m || quoted || m[2].length < 2 || !engineOk) return hideSuggest();
  const token = m[2];
  let list = [];
  try { list = await call("complete", token); } catch { return; }
  if (!input.value.slice(0, input.selectionStart).endsWith(token)) return;
  list = list.filter((x) => x.field !== token);
  if (!list.length) return hideSuggest();
  sugToken = token;
  sugIndex = -1;
  const box = $("suggest");
  box.innerHTML = list.map((x) => `<div role="option" data-f="${esc(x.field)}"><b>${esc(x.field)}</b><span>${esc(x.name || "")}</span></div>`).join("");
  box.hidden = false;
}
function hideSuggest() { clearTimeout(sugTimer); $("suggest").hidden = true; sugIndex = -1; }
function takeSuggestion(field) {
  const pos = input.selectionStart;
  const start = pos - sugToken.length;
  input.value = input.value.slice(0, start) + field + input.value.slice(pos);
  input.setSelectionRange(start + field.length, start + field.length);
  hideSuggest();
  input.focus();
  check();
}
$("suggest").addEventListener("mousedown", (e) => {
  const d = e.target.closest("[data-f]");
  if (d) { e.preventDefault(); takeSuggestion(d.dataset.f); }
});

$("btnApply").onclick = () => applyFilter();
$("btnClear").onclick = () => applyFilter("");
$("quick").innerHTML = QUICK.map((q) => `<button data-q="${q}" title="Show only ${q.toUpperCase()} packets">${q}</button>`).join("");
$("quick").onclick = (e) => { const b = e.target.closest("[data-q]"); if (b) applyFilter(b.dataset.q); };

// ---------------------------------------------------------------- follow a stream
function streamText(bytes) {
  let s = "";
  for (const b of bytes) s += b === 10 || b === 13 || b === 9 || (b >= 32 && b < 127) ? String.fromCharCode(b) : ".";
  return s;
}
function hexDump(bytes, base = 0) {
  let s = "";
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.subarray(off, off + 16);
    s += (base + off).toString(16).padStart(8, "0") + "  " + [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(48) +
      "  " + [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("") + "\n";
  }
  return s;
}

async function followStream() {
  if (!detail || !detail.follow.length) return;
  const cands = detail.follow;
  let pick = cands.findIndex((c) => c[0] === "HTTP");
  if (pick < 0) pick = 0;
  let mode = "ascii";
  const dlg = dialog("Follow stream", "", [
    { label: "Show only this stream", act: () => { close(); applyFilter(cands[pick][1]); } },
    { label: "Save as text", act: () => saveText() },
    { label: "Close", primary: true, act: () => close() },
  ]);
  const close = () => dlg.remove();
  let last = null;
  async function show() {
    const [proto, filter] = cands[pick];
    dlg.body.innerHTML = '<p class="none">Reading the stream …</p>';
    try { last = await call("follow", proto, filter); } catch (e) { dlg.body.innerHTML = `<p>${esc(e.message)}</p>`; return; }
    const r = last;
    // count each side's bytes from the payloads (sharkd's own counts name the two sides the other way round)
    r.cbytes = r.payloads.filter((p) => !p.server).reduce((n, p) => n + p.data.length, 0);
    r.sbytes = r.payloads.filter((p) => p.server).reduce((n, p) => n + p.data.length, 0);
    let html = "", total = 0;
    for (const p of r.payloads) {
      if (total > (2 << 20)) { html += "\n… (the rest is not shown)"; break; }
      total += p.data.length;
      html += `<span class="${p.server ? "s" : "c"}">${esc(mode === "hex" ? hexDump(p.data) : streamText(p.data))}</span>`;
    }
    dlg.title.textContent = `Follow ${proto} stream (${filter})`;
    dlg.body.innerHTML =
      (cands.length > 1 ? `<div class="tabs">${cands.map((c, i) => `<button data-c="${i}" class="${i === pick ? "on" : ""}">${esc(c[0])}</button>`).join("")}</div>` : "") +
      `<p style="margin:0 0 8px"><span class="stream"><span class="c">&nbsp;${esc(r.chost)}:${esc(r.cport)} → ${esc(r.shost)}:${esc(r.sport)} (${r.cbytes} bytes)&nbsp;</span> <span class="s">&nbsp;${esc(r.shost)}:${esc(r.sport)} → ${esc(r.chost)}:${esc(r.cport)} (${r.sbytes} bytes)&nbsp;</span></span>` +
      ` &nbsp; <label><input type="checkbox" id="fHex"${mode === "hex" ? " checked" : ""}> Hex dump</label></p>` +
      `<pre class="stream">${html || "(no data in this stream)"}</pre>`;
    dlg.body.querySelector("#fHex").onchange = (e) => { mode = e.target.checked ? "hex" : "ascii"; show(); };
    dlg.body.querySelectorAll("[data-c]").forEach((b) => { b.onclick = () => { pick = +b.dataset.c; show(); }; });
  }
  async function saveText() {
    if (!last) return;
    const text = last.payloads.map((p) => (mode === "hex" ? hexDump(p.data) : streamText(p.data))).join("");
    const base = cap.name.replace(/\.[^.]+$/, "");
    await saveToDisk(`${base}-stream.txt`, text, { mime: "text/plain", description: "Text" });
  }
  show();
}
$("btnFollow").onclick = followStream;

// ---------------------------------------------------------------- statistics
function dialog(title, html, actions) {
  const back = document.createElement("div");
  back.className = "dlg-back";
  back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true"><header><h2></h2></header><div class="body"></div><footer></footer></div>`;
  const d = back.firstChild;
  d.querySelector("h2").textContent = title;
  d.querySelector(".body").innerHTML = html;
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn btn-sm" + (a.primary ? " btn-primary" : "");
    b.textContent = a.label;
    b.onclick = a.act;
    d.querySelector("footer").appendChild(b);
  }
  back.addEventListener("mousedown", (e) => { if (e.target === back) back.remove(); });
  back.addEventListener("keydown", (e) => { if (e.key === "Escape") back.remove(); });
  document.body.appendChild(back);
  d.tabIndex = -1;
  d.focus();
  return { remove: () => back.remove(), body: d.querySelector(".body"), title: d.querySelector("h2"), foot: d.querySelector("footer") };
}

const num = (v) => Number(v || 0).toLocaleString("en-IN");
function bytesText(v) {
  v = Number(v || 0);
  return v < 1024 ? `${v} B` : v < 1 << 20 ? `${(v / 1024).toFixed(1)} KB` : `${(v / 1048576).toFixed(1)} MB`;
}

async function stats(kind) {
  if (!cap) return;
  const types = ["Ethernet", "IPv4", "IPv6", "TCP", "UDP"];
  const taps = {};
  types.forEach((t, i) => { taps["tap" + i] = `${kind}:${t}`; });
  let res;
  try { res = await call("tap", taps); } catch (e) { toast(e.message, "bad"); return; }
  let tab = res.findIndex((t) => (kind === "conv" ? t.convs : t.hosts)?.length && t.proto === "TCP");
  if (tab < 0) tab = Math.max(0, res.findIndex((t) => (kind === "conv" ? t.convs : t.hosts)?.length));
  const dlg = dialog(kind === "conv" ? "Conversations" : "Endpoints", "", [{ label: "Close", primary: true, act: () => dlg.remove() }]);
  const foot = document.createElement("span");
  foot.className = "note";
  foot.textContent = "Click a row to show only its packets.";
  dlg.foot.prepend(foot);
  function show() {
    const t = res[tab] || { convs: [], hosts: [] };
    const port = t.proto === "TCP" || t.proto === "UDP";
    let head, body;
    if (kind === "conv") {
      const list = [...(t.convs || [])].sort((a, b) => (b.txb + b.rxb) - (a.txb + a.rxb));
      head = `<tr><th>Address A</th>${port ? "<th>Port A</th>" : ""}<th>Address B</th>${port ? "<th>Port B</th>" : ""}<th>Packets</th><th>Bytes</th><th>A → B</th><th>B → A</th><th>Starts at (s)</th><th>Duration (s)</th></tr>`;
      body = list.map((c) => `<tr data-f="${esc(c.filter)}"><td>${esc(c.saddr)}</td>${port ? `<td>${esc(c.sport)}</td>` : ""}<td>${esc(c.daddr)}</td>${port ? `<td>${esc(c.dport)}</td>` : ""}` +
        `<td class="n">${num(c.txf + c.rxf)}</td><td class="n">${bytesText(c.txb + c.rxb)}</td><td class="n">${num(c.txf)} / ${bytesText(c.txb)}</td><td class="n">${num(c.rxf)} / ${bytesText(c.rxb)}</td>` +
        `<td class="n">${Number(c.start).toFixed(6)}</td><td class="n">${(c.stop - c.start).toFixed(4)}</td></tr>`).join("");
    } else {
      const list = [...(t.hosts || [])].sort((a, b) => (b.txb + b.rxb) - (a.txb + a.rxb));
      head = `<tr><th>Address</th>${port ? "<th>Port</th>" : ""}<th>Packets</th><th>Bytes</th><th>Sent</th><th>Received</th></tr>`;
      body = list.map((h) => `<tr data-f="${esc(h.filter)}"><td>${esc(h.host)}</td>${port ? `<td>${esc(h.port)}</td>` : ""}<td class="n">${num(h.txf + h.rxf)}</td><td class="n">${bytesText(h.txb + h.rxb)}</td>` +
        `<td class="n">${num(h.txf)} / ${bytesText(h.txb)}</td><td class="n">${num(h.rxf)} / ${bytesText(h.rxb)}</td></tr>`).join("");
    }
    dlg.body.innerHTML = `<div class="tabs">${res.map((x, i) => `<button data-t="${i}" class="${i === tab ? "on" : ""}">${esc(x.proto)} &middot; ${(kind === "conv" ? x.convs : x.hosts)?.length || 0}</button>`).join("")}</div>` +
      `<table class="st"><thead>${head}</thead><tbody>${body || '<tr><td colspan="10">None in this capture.</td></tr>'}</tbody></table>`;
    dlg.body.querySelectorAll("[data-t]").forEach((b) => { b.onclick = () => { tab = +b.dataset.t; show(); }; });
    dlg.body.querySelectorAll("tr[data-f]").forEach((r) => { r.style.cursor = "pointer"; r.onclick = () => { dlg.remove(); applyFilter(r.dataset.f); }; });
  }
  show();
}

async function objects() {
  if (!cap) return;
  let res;
  try { res = await call("tap", { tap0: "eo:http" }); } catch (e) { toast(e.message, "bad"); return; }
  const list = res[0]?.objects || [];
  const dlg = dialog("HTTP objects", list.length
    ? `<p style="margin-top:0">Files the web pages in this capture carried. Save one to look at it.</p><table class="st"><thead><tr><th>Packet</th><th>Host</th><th>Content type</th><th>Size</th><th>File name</th><th></th></tr></thead><tbody>` +
      list.map((o, i) => `<tr><td class="n">${o.pkt}</td><td>${esc(o.hostname)}</td><td>${esc(o.type)}</td><td class="n">${bytesText(o.len)}</td><td>${esc(o.filename)}</td><td><button class="btn btn-sm" data-o="${i}">Save</button></td></tr>`).join("") +
      "</tbody></table>"
    : "<p>This capture has no files sent over HTTP. (Over HTTPS they are encrypted and cannot be seen.)</p>",
  [{ label: "Close", primary: true, act: () => dlg.remove() }]);
  dlg.body.querySelectorAll("[data-o]").forEach((b) => {
    b.onclick = async () => {
      const o = list[+b.dataset.o];
      try {
        const d = await call("download", o._download);
        const name = (d.file || o.filename || "object").split(/[\\/]/).pop() || "object";
        await saveToDisk(name, new Blob([d.data], { type: d.mime || "application/octet-stream" }), { mime: d.mime || "application/octet-stream", description: "File" });
      } catch (e) { toast(e.message, "bad"); }
    };
  });
}

function summary() {
  if (!cap) return;
  const s = cap.summary;
  const t = (v) => (v ? new Date(v * 1000).toLocaleString("en-IN", { hour12: false }) : "-");
  dialog("Capture summary", `<dl class="sum">
    <dt>File</dt><dd>${esc(cap.name)} (${bytesText(cap.bytes.length)})</dd>
    <dt>Format</dt><dd>${esc(s.type || "-")}</dd>
    <dt>Link type</dt><dd>${esc(s.encap || "-")}</dd>
    <dt>Packets</dt><dd>${num(s.packets)}</dd>
    <dt>Shown now</dt><dd>${num(matched)}${filterText ? ` (filter: ${esc(filterText)})` : ""}</dd>
    <dt>First packet</dt><dd>${t(s.start)}</dd>
    <dt>Last packet</dt><dd>${t(s.stop)}</dd>
    <dt>Duration</dt><dd>${Number(s.elapsed || 0).toFixed(3)} s</dd></dl>`,
  [{ label: "Close", primary: true, act: (e) => e.target.closest(".dlg-back").remove() }]);
}

// ---------------------------------------------------------------- saving the packets shown
async function saveShown() {
  if (!cap) return;
  const fmt = captureFormat(cap.bytes);
  const out = slicePackets(cap.bytes, new Set(rows.map((r) => r.n)));
  if (!out) { toast("Only .pcap and .pcapng files can be cut into a new file.", "bad", 5000); return; }
  const base = cap.name.replace(/\.(pcapng|pcap|cap)$/i, "");
  const name = `${base}${filterText ? "-filtered" : "-copy"}.${fmt === "pcapng" ? "pcapng" : "pcap"}`;
  const r = await saveToDisk(name, out, { mime: "application/vnd.tcpdump.pcap", description: "Capture file" });
  if (r) toast(`Saved ${rows.length} packet${rows.length === 1 ? "" : "s"} as ${r.name}.`);
}
$("btnSave").onclick = saveShown;

// ---------------------------------------------------------------- examples and the exercise panel
function exercise(s) {
  const box = $("exercise");
  if (!s) { box.hidden = true; return; }
  box.innerHTML = `<button class="x" title="Hide" aria-label="Hide">✕</button><h3>${esc(s.title)}</h3><p>${esc(s.description)}</p>` +
    `<b>Try these filters</b><div class="fl2">${s.filters.map((f) => `<button data-f="${esc(f)}">${esc(f)}</button>`).join("")}</div>` +
    `<b style="display:block;margin-top:12px">Questions</b><ol>${s.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>`;
  box.hidden = false;
  box.querySelector(".x").onclick = () => { box.hidden = true; };
  box.querySelectorAll("[data-f]").forEach((b) => { b.onclick = () => applyFilter(b.dataset.f); });
}

async function loadSamples() {
  try { samples = await (await fetch("samples/samples.json", { cache: "no-cache" })).json(); } catch { samples = []; }
  $("sampleMenu").innerHTML = samples.map((s, i) => `<button data-s="${i}">${esc(s.title)}<small>${esc(s.file)} &middot; ${s.packets} packets</small></button>`).join("");
  $("sampleCards").innerHTML = samples.map((s, i) => `<button data-s="${i}"><b>${esc(s.title)}</b><small>${esc(s.description)}</small></button>`).join("");
  for (const box of [$("sampleMenu"), $("sampleCards")]) {
    box.onclick = (e) => { const b = e.target.closest("[data-s]"); if (b) { $("menuMore").hidden = true; openSample(samples[+b.dataset.s]); } };
  }
  let last = "";
  try { last = sessionStorage.getItem("foct.packets.last") || ""; } catch { /* private mode */ }
  const again = samples.find((s) => s.file === last);
  if (again) openSample(again);
}

// ---------------------------------------------------------------- menus, keys, panes
function menu(btnId, menuId) {
  const btn = $(btnId), m = $(menuId);
  btn.onclick = (e) => { e.stopPropagation(); for (const x of document.querySelectorAll(".menu")) if (x !== m) x.hidden = true; m.hidden = !m.hidden; };
  document.addEventListener("click", (e) => { if (!m.contains(e.target)) m.hidden = true; });
  m.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (!cmd) return;
    m.hidden = true;
    ({ help, theme: () => { toggleTheme(); renderRows(); }, summary, conv: () => stats("conv"), endpt: () => stats("endpt"), objects })[cmd]?.();
  });
}
menu("btnMore", "menuMore");
menu("btnStats", "menuStats");
$("btnOpen").onclick = openFile;

function help() {
  modal({
    title: "How to use the Packet Analyzer",
    html: `<p>This lab runs <b>Wireshark's own protocol dissectors</b> in your browser, so packets are decoded exactly as in Wireshark.</p>
    <ol>
      <li><b>Open</b> a capture (.pcap or .pcapng), drop one on the window, or pick an example from <b>Examples &amp; more</b>.</li>
      <li>Type a <b>display filter</b> such as <code>dns</code>, <code>ip.addr == 10.20.1.5</code> or <code>tcp.flags.syn == 1 &amp;&amp; tcp.flags.ack == 0</code> and press <kbd>Enter</kbd>. Green means the filter is right, red that it has a mistake; field names are suggested as you type.</li>
      <li>Click a packet to see its layers. Click a field to see its bytes below; <b>filter</b> next to a field shows only packets with that value (<kbd>Shift</kbd>+click adds it to the filter).</li>
      <li><b>Follow stream</b> (or double-click a packet) shows a whole TCP, UDP or HTTP conversation.</li>
      <li><b>Statistics</b> lists conversations, endpoints and files carried over HTTP.</li>
      <li><b>Save shown packets</b> keeps the filtered packets as a new capture file.</li>
    </ol>
    <p>Capturing live traffic needs Wireshark installed on the PC; a browser cannot do it. The <b>Network Simulator</b> can save the packets of a simulated network for this lab.</p>`,
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); openFile(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveShown(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "/") { e.preventDefault(); input.focus(); input.select(); }
});

// drag a capture onto the window
let dragDepth = 0;
document.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("empty").classList.add("drop"); } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("empty").classList.remove("drop"); } });
document.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  dragDepth = 0;
  $("empty").classList.remove("drop");
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  if (f.size > MAX_FILE) { toast(`${f.name} is too large.`, "bad"); return; }
  openBytes(f.name, new Uint8Array(await f.arrayBuffer()));
});

// resizable panes
function splitter(id, pane) {
  const s = $(id);
  s.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    s.classList.add("drag");
    const startY = e.clientY, startH = $(pane).getBoundingClientRect().height;
    const move = (ev) => { $(pane).style.flexBasis = Math.max(60, startH + ev.clientY - startY) + "px"; renderRows(); };
    const up = () => { s.classList.remove("drag"); s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); };
    s.addEventListener("pointermove", move);
    s.addEventListener("pointerup", up);
  });
}
splitter("split1", "plist");
splitter("split2", "pdetail");

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderRows);

function status() {
  if (!cap) { $("sFile").textContent = "No capture open"; $("sCount").textContent = ""; return; }
  const total = cap.summary.packets;
  $("sFile").innerHTML = `<b>${esc(cap.name)}</b> &middot; ${num(total)} packet${total === 1 ? "" : "s"} &middot; ${esc(cap.summary.type || "")}`;
  $("sCount").innerHTML = filterText
    ? `Shown: <b>${num(matched)}</b> (${total ? ((matched * 100) / total).toFixed(1) : 0}%)${rows.length < matched ? ` &middot; first ${num(rows.length)} listed` : ""}`
    : "";
}

header();
loadSamples();
