// FoCT NetSim - editor, simulation playback and inspector.
import { Network, TYPES, describe, layers, runCommand, ipToInt, parseMask, intToIp, maskToPrefix, prefixToMask } from "./engine.js";
import { EXAMPLES } from "./examples.js";
import { toast, modal, saveToDisk, pickFiles, downloadBlob, toggleTheme, escapeHtml, currentTheme } from "/assets/js/foct.js";
import { writePcap } from "/assets/js/pcap.js";

const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const svg = $("canvas");
const DRAFT = "foct.netsim.draft";

let net = new Network();
let tool = "select";
let placeType = null;
let selected = null;
let cableFrom = null;
let pingFrom = null;
let drag = null;
let playing = true;
let speed = 3;
let simTime = 0;
let events = [];
let selEvent = null;
let fileHandle = null;
let fileName = "network.foctnet";
let busy = new Set();              // devices running a command
let insTab = "config";

// ------------------------------------------------------------------ icons
const COLORS = { pc: "#3949ab", laptop: "#5e35b1", server: "#00796b", router: "#c2185b", switch: "#0277bd", hub: "#6d6d6d" };
function icon(type) {
  const c = COLORS[type];
  switch (type) {
    case "pc": return `<rect x="-19" y="-18" width="38" height="27" rx="3" fill="${c}"/><rect x="-15" y="-14" width="30" height="19" rx="1.5" fill="#d9e6ff"/><rect x="-4" y="9" width="8" height="6" fill="${c}"/><rect x="-12" y="14" width="24" height="4" rx="2" fill="${c}"/>`;
    case "laptop": return `<rect x="-16" y="-17" width="32" height="22" rx="3" fill="${c}"/><rect x="-12.5" y="-13.5" width="25" height="15" rx="1.5" fill="#e3dcff"/><path d="M-22 6h44l-4 7h-36z" fill="${c}"/>`;
    case "server": return `<rect x="-14" y="-21" width="28" height="40" rx="3" fill="${c}"/><rect x="-9" y="-15" width="18" height="4" rx="1" fill="#c8f1ea"/><rect x="-9" y="-7" width="18" height="4" rx="1" fill="#c8f1ea"/><rect x="-9" y="1" width="18" height="4" rx="1" fill="#c8f1ea"/><circle cx="6" cy="12" r="2" fill="#7CFC9A"/>`;
    case "router": return `<ellipse cx="0" cy="6" rx="22" ry="9" fill="#8e0f42"/><rect x="-22" y="-6" width="44" height="12" fill="${c}"/><ellipse cx="0" cy="-6" rx="22" ry="9" fill="#e25a8e"/><path d="M-12 -9l6 3M12 -3l-6-3M-6 -3l-6 3M6 -9l6 3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
    case "switch": return `<rect x="-24" y="-12" width="48" height="24" rx="4" fill="${c}"/><path d="M-14 -4h20l-4-4M14 4h-20l4 4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "hub": return `<rect x="-22" y="-11" width="44" height="22" rx="4" fill="${c}"/><circle cx="-12" cy="0" r="2.5" fill="#fff"/><circle cx="-4" cy="0" r="2.5" fill="#fff"/><circle cx="4" cy="0" r="2.5" fill="#fff"/><circle cx="12" cy="0" r="2.5" fill="#fff"/>`;
  }
  return "";
}

// ------------------------------------------------------------------ palette
function buildPalette() {
  const box = $("devicePalette");
  for (const [type, t] of Object.entries(TYPES)) {
    const b = document.createElement("button");
    b.className = "devbtn";
    b.dataset.type = type;
    b.title = `Add a ${t.label}`;
    b.innerHTML = `<svg viewBox="-26 -24 52 48">${icon(type)}</svg><span>${t.label}</span>`;
    b.onclick = () => setTool("place", type);
    box.appendChild(b);
  }
  for (const b of document.querySelectorAll(".tool")) b.onclick = () => setTool(b.dataset.tool);
}

const HINTS = {
  select: "Drag devices to move them. Click a device to configure it; double-click to open its terminal.",
  cable: "Click the first device, then the second. The next free ports are used.",
  ping: "Click the device that sends the ping, then the device to ping.",
  delete: "Click a device or a cable to remove it.",
  place: "Click the workspace to place the device. Hold Shift to place several.",
};

function setTool(t, type = null) {
  tool = t;
  placeType = type;
  cableFrom = null;
  pingFrom = null;
  $("rubber").setAttribute("hidden", "");
  for (const b of document.querySelectorAll(".tool")) b.classList.toggle("active", b.dataset.tool === t);
  for (const b of document.querySelectorAll(".devbtn")) b.classList.toggle("active", t === "place" && b.dataset.type === type);
  svg.className.baseVal = "canvas tool-" + t;
  $("toolHint").textContent = HINTS[t];
  render();
}

// ------------------------------------------------------------------ rendering
function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

function render() {
  const L = $("links"), D = $("devices");
  L.textContent = "";
  D.textContent = "";
  for (const link of net.links) {
    const a = link.a.device, b = link.b.device;
    const g = el("g", { class: "link" }, L);
    el("line", { class: "hit", x1: a.x, y1: a.y, x2: b.x, y2: b.y }, g);
    el("line", { class: "wire", x1: a.x, y1: a.y, x2: b.x, y2: b.y }, g);
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    for (const [i, s, d] of [[link.a, a, 1], [link.b, b, -1]]) {
      const ox = s.x + (dx / len) * 34 * d, oy = s.y + (dy / len) * 34 * d;
      el("circle", { class: "led", cx: ox, cy: oy, r: 3.2 }, g);
      const t = el("text", { class: "port", x: s.x + (dx / len) * 52 * d, y: s.y + (dy / len) * 52 * d - 4 }, g);
      t.textContent = i.name;
    }
    g.addEventListener("pointerdown", (e) => {
      if (tool === "delete") {
        e.stopPropagation();
        net.disconnect(link);
        changed(`Cable ${a.name} \u2013 ${b.name} removed.`);
      }
    });
  }
  for (const d of net.devices) {
    const g = el("g", { class: "dev" + (d === selected ? " selected" : "") + (d === cableFrom?.device || d === pingFrom ? " pending" : ""), transform: `translate(${d.x},${d.y})` }, D);
    el("circle", { class: "halo", r: 32 }, g);
    const ic = el("g", {}, g);
    ic.innerHTML = icon(d.type);
    const label = el("text", { class: "label", y: 38 }, g);
    label.textContent = d.name;
    const ip = d.ifaces.find((i) => i.ip)?.ip;
    if (ip && (d.info.host || d.info.router)) {
      const sub = el("text", { class: "sub", y: 52 }, g);
      sub.textContent = d.info.router ? `${d.ifaces.filter((i) => i.ip).length} interfaces` : ip;
    }
    g.addEventListener("pointerdown", (e) => onDevicePointer(e, d));
    g.addEventListener("dblclick", () => { select(d); showTab("terminal"); });
  }
  $("empty").hidden = net.devices.length > 0;
  drawPackets();
}

const PKT_COLORS = { ARP: "#f5b300", "echo-request": "#2f7bf6", "echo-reply": "#22a35a", "time-exceeded": "#e8590c", unreachable: "#d6336c" };
function pktColor(fr) {
  return fr.type === "ARP" ? PKT_COLORS.ARP : PKT_COLORS[fr.payload.data.type] || "#888";
}

function drawPackets() {
  const P = $("packets");
  P.textContent = "";
  for (const ev of net.queue) {
    if (ev.kind !== "deliver") continue;
    const a = ev.from.device, b = ev.iface.device;
    const span = Math.max(0.0001, ev.time - ev.start);
    const t = Math.min(1, Math.max(0, (simTime - ev.start) / span));
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    const g = el("g", { class: "pkt", transform: `translate(${x - 9},${y - 6})` }, P);
    el("rect", { width: 18, height: 12, rx: 2, fill: pktColor(ev.frame) }, g);
    el("path", { class: "flap", d: "M0 0 L9 7 L18 0" }, g);
  }
}

// ------------------------------------------------------------------ pointer handling
function point(e) {
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDevicePointer(e, d) {
  e.stopPropagation();
  if (tool === "select") {
    select(d);
    const p = point(e);
    drag = { d, dx: p.x - d.x, dy: p.y - d.y, moved: false };
    svg.setPointerCapture(e.pointerId);
  } else if (tool === "delete") {
    if (selected === d) selected = null;
    net.removeDevice(d);
    changed(`${d.name} deleted.`);
    renderInspector();
  } else if (tool === "cable") {
    const free = d.freeIface();
    if (!free) { toast(`${d.name} has no free ports.`, "bad"); return; }
    if (!cableFrom) {
      cableFrom = free;
      const r = $("rubber");
      r.setAttribute("x1", d.x); r.setAttribute("y1", d.y); r.setAttribute("x2", d.x); r.setAttribute("y2", d.y);
      r.removeAttribute("hidden");
      $("toolHint").textContent = `Now click the device to connect to ${d.name} (${free.name}).`;
      render();
    } else if (cableFrom.device === d) {
      setTool("cable");
    } else {
      const a = cableFrom;
      if (net.connect(a, free)) changed(`Connected ${a.device.name} ${a.name} \u2194 ${d.name} ${free.name}.`);
      setTool("cable");
    }
  } else if (tool === "ping") {
    if (!pingFrom) {
      if (!(d.info.host || d.info.router)) { toast("Choose a PC, laptop, server or router to send the ping.", "bad"); return; }
      pingFrom = d;
      $("toolHint").textContent = `Now click the device that ${d.name} should ping.`;
      render();
    } else {
      const target = d.ifaces.find((i) => i.ipInt !== null);
      const src = pingFrom;
      setTool("ping");
      if (!target) { toast(`${d.name} has no IP address to ping.`, "bad"); return; }
      select(src);
      showTab("terminal");
      execute(src, `ping ${target.ip} -n 2`);
    }
  } else if (tool === "place") {
    select(d);
  }
}

svg.addEventListener("pointerdown", (e) => {
  if (tool === "place" && placeType) {
    const p = point(e);
    const d = net.addDevice(placeType, p.x, p.y);
    select(d);
    changed(`${d.name} added. Configure it on the right.`);
    if (!e.shiftKey) setTool("select");
  } else if (tool === "select") {
    select(null);
  } else if (tool === "cable" && cableFrom) {
    setTool("cable");
  }
});

svg.addEventListener("pointermove", (e) => {
  const p = point(e);
  if (drag) {
    const r = svg.getBoundingClientRect();
    drag.d.x = Math.min(r.width - 30, Math.max(30, p.x - drag.dx));
    drag.d.y = Math.min(r.height - 50, Math.max(30, p.y - drag.dy));
    drag.moved = true;
    render();
  } else if (tool === "cable" && cableFrom) {
    $("rubber").setAttribute("x2", p.x);
    $("rubber").setAttribute("y2", p.y);
  }
});

svg.addEventListener("pointerup", () => {
  if (drag?.moved) saveDraft();
  drag = null;
});

// ------------------------------------------------------------------ inspector
function select(d) {
  selected = d;
  render();
  renderInspector();
}

function showTab(t) {
  insTab = t;
  for (const b of document.querySelectorAll(".itab")) b.classList.toggle("active", b.dataset.tab === t);
  for (const s of document.querySelectorAll(".insp-body > section")) s.hidden = s.dataset.tab !== t;
  renderInspector();
  if (t === "terminal") setTimeout(() => $("termInput").focus(), 0);
}

function renderInspector() {
  renderConfig();
  renderTerminal();
  renderTables();
  renderProblems();
}

function field(label, value, onChange, opts = {}) {
  const row = document.createElement("div");
  row.className = "row";
  const id = "f" + Math.random().toString(36).slice(2, 8);
  row.innerHTML = `<label for="${id}">${escapeHtml(label)}</label><input id="${id}" ${opts.readonly ? "readonly" : ""} placeholder="${escapeHtml(opts.placeholder || "")}">`;
  const input = row.querySelector("input");
  input.value = value || "";
  const validate = () => input.classList.toggle("bad", !!opts.check && input.value.trim() !== "" && !opts.check(input.value.trim()));
  validate();
  input.addEventListener("input", validate);
  input.addEventListener("change", () => { onChange?.(input.value.trim()); });
  return row;
}

const isIp = (s) => ipToInt(s) !== null;
const isMask = (s) => parseMask(s) !== null;
function normMask(s) {
  const m = parseMask(s);
  return m === null ? s : intToIp(m);
}

function renderConfig() {
  const box = $("configPane");
  box.textContent = "";
  box.className = "cfg";
  if (!selected) {
    box.innerHTML = `<h3>Network</h3>
      <p class="muted">${net.devices.length} devices, ${net.links.length} cables.</p>
      <p class="muted">Select a device to set its name and IP addresses. Double-click a device to open its terminal.</p>
      <h4>Quick start</h4>
      <ol class="muted" style="padding-left:18px;line-height:1.6">
        <li>Add two PCs and a switch.</li>
        <li>Connect them with the <b>Cable</b> tool.</li>
        <li>Give the PCs addresses in the same subnet, e.g. 192.168.1.10/24 and 192.168.1.20/24.</li>
        <li>Open PC1&rsquo;s <b>Terminal</b> and type <code>ping 192.168.1.20</code>.</li>
      </ol>`;
    return;
  }
  const d = selected;
  const h = document.createElement("h3");
  h.innerHTML = `<svg viewBox="-26 -24 52 48" width="34" height="30">${icon(d.type)}</svg>${escapeHtml(d.info.label)}`;
  box.appendChild(h);
  box.appendChild(field("Name", d.name, (v) => { if (v) { d.name = v; changed(); } }));
  if (d.info.host) {
    const i = d.ifaces[0];
    box.appendChild(field("IPv4 address", i.ip, (v) => { i.ip = v; changed(); }, { check: isIp, placeholder: "192.168.1.10" }));
    box.appendChild(field("Subnet mask", i.mask, (v) => { i.mask = normMask(v); changed(); renderConfig(); }, { check: isMask, placeholder: "255.255.255.0 or /24" }));
    box.appendChild(field("Default gateway", d.gateway, (v) => { d.gateway = v; changed(); }, { check: isIp, placeholder: "192.168.1.1" }));
    box.appendChild(field("MAC address", i.mac, null, { readonly: true }));
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = i.link ? `Port ${i.name} is connected to ${i.peer.device.name} (${i.peer.name}).` : `Port ${i.name} is not connected.`;
    box.appendChild(p);
  } else if (d.info.router) {
    const h4 = document.createElement("h4");
    h4.textContent = "Interfaces";
    box.appendChild(h4);
    for (const i of d.ifaces) {
      const b = document.createElement("div");
      b.className = "ifbox";
      b.innerHTML = `<div class="ifname"><span>${i.name}</span><span class="muted">${i.link ? "\u25CF up \u2192 " + escapeHtml(i.peer.device.name) : "\u25CB not connected"}</span></div>`;
      b.appendChild(field("IP address", i.ip, (v) => { i.ip = v; changed(); }, { check: isIp }));
      b.appendChild(field("Subnet mask", i.mask, (v) => { i.mask = normMask(v); changed(); renderConfig(); }, { check: isMask, placeholder: "255.255.255.0 or /24" }));
      b.appendChild(field("MAC", i.mac, null, { readonly: true }));
      box.appendChild(b);
    }
    const h5 = document.createElement("h4");
    h5.textContent = "Static routes";
    box.appendChild(h5);
    const tbl = document.createElement("table");
    tbl.className = "tbl";
    tbl.innerHTML = "<tr><th>Network</th><th>Mask</th><th>Next hop</th><th></th></tr>";
    d.routes.forEach((r, k) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(r.network)}</td><td>/${maskToPrefix(parseMask(r.mask) ?? 0)}</td><td>${escapeHtml(r.nextHop)}</td><td><button class="btn btn-ghost btn-sm" title="Remove route">\u2715</button></td>`;
      tr.querySelector("button").onclick = () => { d.routes.splice(k, 1); changed("Route removed."); renderConfig(); };
      tbl.appendChild(tr);
    });
    const add = document.createElement("tr");
    add.innerHTML = `<td><input placeholder="10.0.3.0"></td><td><input placeholder="/24"></td><td><input placeholder="172.16.0.2"></td><td><button class="btn btn-sm">Add</button></td>`;
    add.querySelector("button").onclick = () => {
      const [n, m, nh] = [...add.querySelectorAll("input")].map((x) => x.value.trim());
      if (!isIp(n) || !isMask(m) || !isIp(nh)) { toast("Enter a network address, a mask (e.g. /24) and a next-hop IP.", "bad"); return; }
      const mask = parseMask(m);
      d.routes.push({ network: intToIp((ipToInt(n) & mask) >>> 0), mask: intToIp(mask), nextHop: nh });
      changed("Static route added.");
      renderConfig();
    };
    tbl.appendChild(add);
    box.appendChild(tbl);
    const tip = document.createElement("p");
    tip.className = "muted";
    tip.innerHTML = "Tip: a default route is network <code>0.0.0.0</code> with mask <code>/0</code>.";
    box.appendChild(tip);
  } else {
    const h4 = document.createElement("h4");
    h4.textContent = "Ports";
    box.appendChild(h4);
    const tbl = document.createElement("table");
    tbl.className = "tbl";
    tbl.innerHTML = "<tr><th>Port</th><th>Connected to</th></tr>" + d.ifaces.map((i) =>
      `<tr><td>${i.name}</td><td>${i.link ? escapeHtml(i.peer.device.name + " " + i.peer.name) : "\u2014"}</td></tr>`).join("");
    box.appendChild(tbl);
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = d.info.hub
      ? "A hub is a layer-1 device: every frame it receives is repeated out of all other ports."
      : "A switch learns which MAC address is behind each port and forwards frames only where they need to go. See its MAC table under Tables.";
    box.appendChild(p);
  }
  const del = document.createElement("button");
  del.className = "btn btn-sm";
  del.style.marginTop = "14px";
  del.textContent = `Delete ${d.name}`;
  del.onclick = () => { net.removeDevice(d); selected = null; changed(`${d.name} deleted.`); renderInspector(); };
  box.appendChild(del);
}

function promptFor(d) {
  return d.info.router ? `${d.name}#` : d.info.l2 ? `${d.name}#` : `C:\\${d.name}>`;
}

function renderTerminal() {
  const term = $("term");
  const d = selected;
  if (!d) {
    term.textContent = "Select a device to use its command line.";
    $("termInput").disabled = true;
    $("termPrompt").textContent = ">";
    return;
  }
  term.textContent = d.output.join("\n") || (d.info.hub ? "A hub has no command line." : `${d.name} command line. Type 'help' for the list of commands.`);
  term.scrollTop = term.scrollHeight;
  $("termPrompt").textContent = promptFor(d);
  $("termInput").disabled = d.info.hub || busy.has(d);
}

function renderTables() {
  const box = $("tablesPane");
  const d = selected;
  if (!d) { box.innerHTML = `<p class="muted">Select a device to see its ARP cache, MAC address table or routing table.</p>`; return; }
  let html = "";
  if (d.info.host || d.info.router) {
    html += `<h4 class="cfg">ARP cache</h4>`;
    html += d.arp.size ? `<table class="tbl"><tr><th>IP address</th><th>MAC address</th><th>Port</th></tr>${[...d.arp].map(([ip, e]) => `<tr><td>${intToIp(ip)}</td><td>${e.mac}</td><td>${e.iface.name}</td></tr>`).join("")}</table>` : `<p class="muted">Empty. It fills in when this device talks to its neighbours.</p>`;
  }
  if (d.info.router) {
    const rows = [];
    for (const i of d.ifaces) if (i.configured && i.link) rows.push(["C", `${intToIp((i.ipInt & i.maskInt) >>> 0)}/${maskToPrefix(i.maskInt)}`, "directly connected", i.name]);
    for (const r of d.routes) rows.push(["S", `${r.network}/${maskToPrefix(parseMask(r.mask) ?? 0)}`, `via ${r.nextHop}`, ""]);
    html += `<h4 class="cfg" style="margin-top:14px">Routing table</h4>`;
    html += rows.length ? `<table class="tbl"><tr><th></th><th>Network</th><th>Next hop</th><th>Port</th></tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</table>` : `<p class="muted">Empty. Configure interfaces and connect cables.</p>`;
  }
  if (d.info.l2) {
    html += `<h4 class="cfg">MAC address table</h4>`;
    html += d.macTable.size ? `<table class="tbl"><tr><th>MAC address</th><th>Port</th></tr>${[...d.macTable].map(([mac, i]) => `<tr><td>${mac}</td><td>${i.name}</td></tr>`).join("")}</table>` : `<p class="muted">Empty. The switch learns source MAC addresses as frames arrive.</p>`;
  }
  if (d.info.hub) html = `<p class="muted">A hub keeps no tables.</p>`;
  box.innerHTML = html;
}

function renderProblems() {
  const list = net.problems();
  const box = $("problems");
  box.hidden = !list.length;
  box.innerHTML = list.length ? `<strong>Check your configuration</strong><ul style="margin:4px 0 0;padding-left:18px">${list.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : "";
}

// ------------------------------------------------------------------ terminal
$("termForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const d = selected;
  const line = $("termInput").value;
  if (!d || busy.has(d)) return;
  $("termInput").value = "";
  execute(d, line);
});

const history = [];
let hIndex = 0;
$("termInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && history.length) { hIndex = Math.max(0, hIndex - 1); $("termInput").value = history[hIndex]; e.preventDefault(); }
  if (e.key === "ArrowDown" && history.length) { hIndex = Math.min(history.length, hIndex + 1); $("termInput").value = history[hIndex] || ""; e.preventDefault(); }
});

function execute(d, line) {
  if (line.trim()) { history.push(line); hIndex = history.length; }
  d.print(`${promptFor(d)}${line}`);
  busy.add(d);
  renderTerminal();
  if (!playing && /^(ping|tracert|traceroute)\b/i.test(line.trim())) toast("The simulation is paused: press Play or Step to send the packets.");
  runCommand(d, line, () => {
    busy.delete(d);
    if (d === selected) { renderTerminal(); $("termInput").focus(); }
  });
}

function onPrint({ device }) {
  if (device === selected && insTab === "terminal") renderTerminal();
}

// ------------------------------------------------------------------ packet list
function onSend(ev) {
  const fr = ev.frame;
  const entry = { t: ev.start, from: ev.from, to: ev.iface, frame: structuredClone(stripFrame(fr)), color: pktColor(fr), kind: fr.type === "ARP" ? "ARP" : "ICMP" };
  events.push(entry);
  if (events.length > 1500) events.splice(0, 300);
  appendEvent(entry);
}

function stripFrame(fr) {
  return { src: fr.src, dst: fr.dst, type: fr.type, payload: fr.payload };
}

function appendEvent(entry) {
  if ((entry.kind === "ARP" && !$("fArp").checked) || (entry.kind === "ICMP" && !$("fIcmp").checked)) return;
  const list = $("evList");
  const row = document.createElement("div");
  row.className = "ev-row";
  row.setAttribute("role", "option");
  row.innerHTML = `<span>t=${entry.t}</span><span>${escapeHtml(entry.from.device.name)} \u2192 ${escapeHtml(entry.to.device.name)}</span><span class="what"><span class="sw" style="background:${entry.color}"></span>${escapeHtml(describe(entry.frame))}</span>`;
  row.onclick = () => {
    list.querySelector(".sel")?.classList.remove("sel");
    row.classList.add("sel");
    showEvent(entry);
  };
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  list.appendChild(row);
  while (list.childElementCount > 800) list.firstElementChild.remove();
  if (stick) list.scrollTop = list.scrollHeight;
}

function showEvent(entry) {
  selEvent = entry;
  const L = layers(entry.frame);
  $("evDetail").innerHTML = `<div><b>${escapeHtml(entry.from.device.name)}</b> (${escapeHtml(entry.from.name)}) \u2192 <b>${escapeHtml(entry.to.device.name)}</b> (${escapeHtml(entry.to.name)}) at t=${entry.t}</div>` +
    L.map((l) => `<h5>${escapeHtml(l.name)}</h5><table>${l.fields.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join("")}</table>`).join("");
}

function rebuildEventList() {
  $("evList").textContent = "";
  for (const e of events) appendEvent(e);
}

$("fArp").onchange = $("fIcmp").onchange = rebuildEventList;
$("btnClearEv").onclick = () => { events = []; rebuildEventList(); $("evDetail").innerHTML = `<p class="muted">Click a packet to see its headers.</p>`; };
$("btnToggleEv").onclick = () => $("events").classList.toggle("collapsed");

// ------------------------------------------------------------------ simulation clock
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (playing) {
    if (speed >= 1000) {
      let n = 0;
      while (!net.idle && n++ < 4000) net.stepEvent();
      simTime = net.time;
    } else {
      simTime += dt * speed;
      if (net.idle) simTime = Math.max(simTime, net.time);
      if (!net.idle && net.nextTime > simTime + 50) simTime = net.nextTime - 1; // skip long quiet gaps
      net.runUntil(Math.floor(simTime * 1000) / 1000);
    }
  }
  drawPackets();
  $("clock").textContent = `t = ${Math.floor(simTime)}${playing ? "" : "  (paused)"}`;
  requestAnimationFrame(frame);
}

function setPlaying(p) {
  playing = p;
  const b = $("btnPlay");
  b.innerHTML = p ? "&#10073;&#10073; Pause" : "&#9654; Play";
  b.classList.toggle("paused", !p);
}

$("btnPlay").onclick = () => setPlaying(!playing);
$("btnStep").onclick = () => {
  setPlaying(false);
  const t = net.nextTime;
  if (t === Infinity) { toast("Nothing to simulate. Run a command such as ping first."); return; }
  simTime = t;
  net.runUntil(t);
  if (selected) renderTables();
};
$("speed").onchange = (e) => { speed = +e.target.value; };
$("btnReset").onclick = () => {
  net.resetState();
  busy.clear();
  simTime = net.time;
  toast("ARP caches, MAC tables and packets in flight cleared.");
  renderInspector();
};

// ------------------------------------------------------------------ files
function changed(msg) {
  render();
  renderProblems();
  if (msg) toast(msg);
  saveDraft();
}

function saveDraft() {
  try { localStorage.setItem(DRAFT, JSON.stringify({ name: fileName, net: net.toJSON() })); } catch {}
}

function attach(newNet) {
  net = newNet;
  net.on("send", onSend);
  net.on("print", onPrint);
  net.on("arrive", () => { if (selected && insTab === "tables") renderTables(); });
  net.on("reset", () => renderInspector());
  selected = null;
  busy.clear();
  events = [];
  simTime = 0;
  rebuildEventList();
  render();
  renderInspector();
}

async function saveFile(saveAs = false) {
  const json = JSON.stringify(net.toJSON(), null, 1);
  const r = await saveToDisk(fileName, json, { handle: fileHandle, saveAs, mime: "application/json", description: "FoCT NetSim network" });
  if (!r) return;
  fileHandle = r.handle;
  if (r.name) fileName = r.name;
  toast(r.method === "file" ? `Saved ${fileName}.` : `${fileName} downloaded to your Downloads folder.`);
}

async function openFile() {
  const [f] = await pickFiles({ accept: ".foctnet,.json", multiple: false });
  if (!f) return;
  try {
    attach(Network.fromJSON(JSON.parse(await f.file.text())));
    fileName = f.name;
    fileHandle = f.handle;
    saveDraft();
    toast(`Opened ${f.name}.`);
  } catch (e) {
    toast("Could not open that file: " + e.message, "bad");
  }
}

function loadExample(name) {
  const ex = EXAMPLES[name];
  attach(Network.fromJSON(ex.data));
  fileName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".foctnet";
  fileHandle = null;
  saveDraft();
  modal({ title: name, html: `<p>${escapeHtml(ex.note)}</p>` });
}

async function exportPng() {
  const r = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true);
  clone.setAttribute("width", r.width);
  clone.setAttribute("height", r.height);
  const dark = currentTheme() === "dark";
  const css = `.grid-dot{fill:${dark ? "#3c3a5a" : "#cfcce3"}}.label{font:600 12px sans-serif;fill:${dark ? "#ecebf7" : "#1d1a38"};text-anchor:middle}.sub{font:11px monospace;fill:#777;text-anchor:middle}.link line{stroke:#888;stroke-width:2.5}.link .hit{stroke:transparent}.port{font:10px monospace;fill:#999;text-anchor:middle}.led{fill:#2fbf71}.halo{fill:none;stroke:none}`;
  const style = document.createElementNS(NS, "style");
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", dark ? "#121120" : "#ffffff");
  clone.insertBefore(bg, clone.firstChild);
  const data = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = r.width * 2; c.height = r.height * 2;
    const ctx = c.getContext("2d");
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0);
    c.toBlob((b) => downloadBlob(fileName.replace(/\.foctnet$/, "") + ".png", b), "image/png");
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data);
}

function help() {
  modal({
    title: "How to use the network simulator",
    html: `<ul style="padding-left:18px;line-height:1.7;margin:0">
      <li><b>Add devices</b> from the left, <b>connect</b> them with the Cable tool and set IP addresses in <b>Configure</b>.</li>
      <li>Use a device&rsquo;s <b>Terminal</b>: <code>ipconfig</code>, <code>ping 192.168.1.20</code>, <code>tracert 10.0.3.10</code>, <code>arp -a</code>; on routers <code>show ip route</code>; on switches <code>show mac address-table</code>.</li>
      <li>Packets move along the cables: <span style="color:#f5b300">&#9632;</span> ARP, <span style="color:#2f7bf6">&#9632;</span> ICMP echo request, <span style="color:#22a35a">&#9632;</span> echo reply, <span style="color:#e8590c">&#9632;</span> time exceeded, <span style="color:#d6336c">&#9632;</span> unreachable.</li>
      <li><b>Pause</b> and <b>Step</b> to follow one hop at a time; click a packet in the list below to see its Ethernet, ARP, IP and ICMP headers.</li>
      <li><b>Reset</b> empties ARP caches and MAC tables so you can watch learning happen again.</li>
      <li><b>Save</b> keeps the network on your computer as a <code>.foctnet</code> file; <b>Open</b> loads it again. Nothing is stored on the lab server.</li>
    </ul>`,
  });
}

// ------------------------------------------------------------------ packets as a capture file
// The packet list written as real Ethernet frames, so the Packet Analyzer (or Wireshark) can open it.
const ICMP_DATA = new TextEncoder().encode("abcdefghijklmnopqrstuvwabcdefghi");   // what Windows ping sends
const macBytes = (m) => (m || "00:00:00:00:00:00").split(":").map((x) => parseInt(x, 16) || 0);
const ipBytes = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function csum(b) {
  let s = 0;
  for (let i = 0; i < b.length; i += 2) s += (b[i] << 8) + (b[i + 1] || 0);
  while (s >> 16) s = (s & 0xffff) + (s >>> 16);
  return ~s & 0xffff;
}
let ipId = 0x2400;
function ipHeader(src, dst, ttl, len) {
  ipId = (ipId + 1) & 0xffff;
  const h = [0x45, 0, len >> 8, len & 255, ipId >> 8, ipId & 255, 0, 0, Math.max(0, Math.min(255, ttl)), 1, 0, 0, ...ipBytes(src), ...ipBytes(dst)];
  const c = csum(h);
  h[10] = c >> 8; h[11] = c & 255;
  return h;
}
function icmpBytes(ic, p) {
  const echo = ic.type === "echo-request" || ic.type === "echo-reply";
  const type = { "echo-request": 8, "echo-reply": 0, "time-exceeded": 11, unreachable: 3 }[ic.type] ?? 8;
  const code = ic.type === "unreachable" ? (ic.what === "net" ? 0 : 1) : 0;
  let m;
  if (echo) {
    m = [type, code, 0, 0, (ic.id >> 8) & 255, ic.id & 255, (ic.seq >> 8) & 255, ic.seq & 255, ...ICMP_DATA];
  } else {    // an error carries the start of the packet it is about
    const a = ic.about || {};
    const inner = [8, 0, 0, 0, ((a.id || 0) >> 8) & 255, (a.id || 0) & 255, ((a.seq || 0) >> 8) & 255, (a.seq || 0) & 255];
    const ic2 = csum([...inner, ...ICMP_DATA]);
    inner[2] = ic2 >> 8; inner[3] = ic2 & 255;
    m = [type, code, 0, 0, 0, 0, 0, 0, ...ipHeader(a.src ?? p.dst, a.dst ?? p.src, a.ttl ?? 1, 20 + 8 + ICMP_DATA.length), ...inner];
  }
  const c = csum(m);
  m[2] = c >> 8; m[3] = c & 255;
  return m;
}
function frameBytes(fr) {
  let body, type;
  if (fr.type === "ARP") {
    const a = fr.payload;
    type = 0x0806;
    body = [0, 1, 8, 0, 6, 4, 0, a.op === "request" ? 1 : 2, ...macBytes(a.senderMac), ...ipBytes(a.senderIp), ...macBytes(a.targetMac), ...ipBytes(a.targetIp)];
  } else {
    const p = fr.payload;
    type = 0x0800;
    const icmp = icmpBytes(p.data || {}, p);
    body = [...ipHeader(p.src, p.dst, p.ttl, 20 + icmp.length), ...icmp];
  }
  const out = [...macBytes(fr.dst), ...macBytes(fr.src), type >> 8, type & 255, ...body];
  while (out.length < 60) out.push(0);            // Ethernet's minimum frame size
  return new Uint8Array(out);
}

async function savePcap() {
  const dev = selected;
  const list = events.filter((e) => !dev || e.from.device === dev || e.to.device === dev);
  if (!list.length) {
    toast(dev ? `${dev.name} has not sent or received any packets yet.` : "No packets yet: ping something first.");
    return;
  }
  const t0 = Math.floor(Date.now() / 1000);
  const seen = new Set();
  const packets = [];
  for (const e of list) {
    // a frame passing through the selected device shows once, as on a single network card
    const key = dev ? `${e.t}|${JSON.stringify(e.frame)}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    packets.push({ time: t0 + e.t / 1000, data: frameBytes(e.frame) });     // one tick = 1 ms
  }
  const name = `${(dev ? dev.name : "network").replace(/[^\w.-]+/g, "_")}.pcap`;
  const r = await saveToDisk(name, writePcap(packets), { mime: "application/vnd.tcpdump.pcap", description: "Capture file" });
  if (r) toast(`Saved ${packets.length} packets as ${r.name}. Open it in the Packet Analyzer.`);
}

// ------------------------------------------------------------------ menu, keys, boot
function initMenu() {
  const menu = $("menu"), btn = $("btnMore"), ex = $("examples");
  for (const name of Object.keys(EXAMPLES)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = () => { menu.hidden = true; loadExample(name); };
    ex.appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  menu.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (!cmd) return;
    menu.hidden = true;
    ({ png: exportPng, pcap: savePcap, help, theme: toggleTheme })[cmd]?.();
  });
  $("loadExample").onclick = (e) => { e.preventDefault(); loadExample(Object.keys(EXAMPLES)[1]); };
}

document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(e.shiftKey); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); openFile(); return; }
  if (typing) return;
  if (e.key === "Escape") setTool("select");
  else if (e.key === "v") setTool("select");
  else if (e.key === "c") setTool("cable");
  else if (e.key === "p") setTool("ping");
  else if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
  else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
    const d = selected;
    net.removeDevice(d);
    selected = null;
    changed(`${d.name} deleted.`);
    renderInspector();
  }
});

for (const b of document.querySelectorAll(".itab")) b.onclick = () => showTab(b.dataset.tab);
$("btnNew").onclick = async () => {
  if (net.devices.length) {
    const ok = await modal({ title: "Start a new network?", html: "<p>The current network will be cleared from this page. Save it first if you want to keep it.</p>", actions: [{ label: "Cancel", value: false }, { label: "New network", value: true, primary: true }] });
    if (!ok) return;
  }
  attach(new Network());
  fileName = "network.foctnet";
  fileHandle = null;
  saveDraft();
};
$("btnOpen").onclick = openFile;
$("btnSave").onclick = () => saveFile();

buildPalette();
initMenu();
try {
  const draft = JSON.parse(localStorage.getItem(DRAFT) || "null");
  if (draft?.net) { attach(Network.fromJSON(draft.net)); fileName = draft.name || fileName; }
  else attach(net);
} catch { attach(new Network()); }
setTool("select");
requestAnimationFrame(frame);
window.addEventListener("resize", render);
