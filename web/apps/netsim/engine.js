// FoCT NetSim - network model and packet-level simulation.
// Layers modelled: Ethernet (switch MAC learning, hub repeating), ARP, IPv4 forwarding with
// longest-prefix match, ICMP echo / time-exceeded / unreachable (ping and traceroute), DHCP-free
// static addressing. Time is measured in abstract "ticks": one tick per cable hop.

export const HOP = 1;            // ticks to cross a cable
export const ARP_TIMEOUT = 12;   // ticks to wait for an ARP reply
export const PING_INTERVAL = 8;  // ticks between echo requests
export const PING_TIMEOUT = 24;  // ticks before "Request timed out."

export const TYPES = {
  pc:     { label: "PC",     ports: 1, prefix: "Fa0",    host: true },
  laptop: { label: "Laptop", ports: 1, prefix: "Fa0",    host: true },
  server: { label: "Server", ports: 1, prefix: "Fa0",    host: true },
  router: { label: "Router", ports: 4, prefix: "Gig0/",  router: true },
  switch: { label: "Switch", ports: 8, prefix: "Fa0/",   l2: true },
  hub:    { label: "Hub",    ports: 6, prefix: "Port ",  hub: true },
};

// ------------------------------------------------------------------ addressing helpers
export function ipToInt(s) {
  if (typeof s !== "string") return null;
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
export const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
export function prefixToMask(p) { return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0; }
export function maskToPrefix(m) {
  let p = 0;
  while (p < 32 && (m & (0x80000000 >>> p))) p++;
  return prefixToMask(p) === m ? p : -1;
}
export function parseMask(s) {
  if (s == null || s === "") return null;
  if (/^\/?\d{1,2}$/.test(String(s).trim())) {
    const p = parseInt(String(s).replace("/", ""), 10);
    return p <= 32 ? prefixToMask(p) : null;
  }
  const m = ipToInt(s);
  return m !== null && maskToPrefix(m) >= 0 ? m : null;
}
export const sameNet = (a, b, mask) => ((a & mask) >>> 0) === ((b & mask) >>> 0);
export const BROADCAST_MAC = "FF:FF:FF:FF:FF:FF";

let macSeq = Math.floor(Math.random() * 0xffff);
export function newMac() {
  macSeq = (macSeq + 1) & 0xffffff;
  const r = () => Math.floor(Math.random() * 256);
  return ["00", "1F", "C3", r(), (macSeq >> 8) & 255, macSeq & 255]
    .map((x) => (typeof x === "number" ? x.toString(16).padStart(2, "0") : x).toUpperCase()).join(":");
}

// ------------------------------------------------------------------ model
export class Iface {
  constructor(device, name) {
    this.device = device;
    this.name = name;
    this.mac = newMac();
    this.ip = "";
    this.mask = "";
    this.link = null;
    this.up = true;
  }
  get ipInt() { return ipToInt(this.ip); }
  get maskInt() { return parseMask(this.mask); }
  get configured() { return this.ipInt !== null && this.maskInt !== null; }
  get peer() { return this.link ? (this.link.a === this ? this.link.b : this.link.a) : null; }
}

export class Device {
  constructor(net, type, name, x, y) {
    this.net = net;
    this.id = net.nextId++;
    this.type = type;
    this.name = name;
    this.x = x;
    this.y = y;
    const t = TYPES[type];
    this.ifaces = [];
    for (let i = 0; i < t.ports; i++) {
      const n = t.host ? t.prefix : t.router ? t.prefix + i : t.prefix + (i + 1);
      this.ifaces.push(new Iface(this, n));
    }
    this.gateway = "";
    this.routes = [];          // routers: {network, mask, nextHop}
    this.arp = new Map();      // ip(int) -> {mac, iface}
    this.macTable = new Map(); // switches: mac -> iface
    this.pending = [];         // packets waiting for ARP: {ip, packet, iface, since}
    this.output = [];          // terminal lines
    this.procs = new Set();
  }
  get info() { return TYPES[this.type]; }
  iface(name) { return this.ifaces.find((i) => i.name === name); }
  freeIface() { return this.ifaces.find((i) => !i.link); }
  print(line) {
    this.output.push(line);
    if (this.output.length > 500) this.output.splice(0, this.output.length - 500);
    this.net.emit("print", { device: this, line });
  }
  ownsIp(ip) { return this.ifaces.some((i) => i.ipInt === ip); }
}

export class Link {
  constructor(a, b) { this.a = a; this.b = b; a.link = this; b.link = this; }
}

// ------------------------------------------------------------------ the network
export class Network {
  constructor() {
    this.devices = [];
    this.links = [];
    this.nextId = 1;
    this.time = 0;
    this.queue = [];      // {time, kind:'deliver'|'timer', ...}
    this.seq = 0;
    this.listeners = {};
    this.counts = {};
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { for (const f of this.listeners[ev] || []) f(data); }

  // ---------------------------------------------------------------- editing
  addDevice(type, x, y, name) {
    this.counts[type] = (this.counts[type] || 0) + 1;
    let n = this.counts[type];
    let label = name || TYPES[type].label + n;
    while (!name && this.devices.some((d) => d.name === label)) label = TYPES[type].label + ++n;
    const d = new Device(this, type, label, x, y);
    this.devices.push(d);
    this.emit("change");
    return d;
  }

  removeDevice(d) {
    for (const i of d.ifaces) if (i.link) this.disconnect(i.link);
    this.devices = this.devices.filter((x) => x !== d);
    this.queue = this.queue.filter((e) => e.device !== d && e.iface?.device !== d && e.from?.device !== d);
    this.emit("change");
  }

  connect(a, b) {
    if (!a || !b || a.link || b.link || a.device === b.device) return null;
    const l = new Link(a, b);
    this.links.push(l);
    this.emit("change");
    return l;
  }

  disconnect(link) {
    link.a.link = null;
    link.b.link = null;
    this.links = this.links.filter((l) => l !== link);
    this.queue = this.queue.filter((e) => e.link !== link);
    this.emit("change");
  }

  /** Forget dynamic state (ARP caches, MAC tables, running pings) - like power-cycling. */
  resetState() {
    this.queue = [];
    for (const d of this.devices) {
      d.arp.clear();
      d.macTable.clear();
      d.pending = [];
      d.procs.clear();
    }
    this.emit("reset");
  }

  // ---------------------------------------------------------------- event loop
  schedule(ev) {
    ev.id = ++this.seq;
    this.queue.push(ev);
    this.queue.sort((x, y) => x.time - y.time || x.id - y.id);
  }

  timer(delay, fn, device) { this.schedule({ kind: "timer", time: this.time + delay, fn, device }); }

  get idle() { return this.queue.length === 0; }
  get nextTime() { return this.queue.length ? this.queue[0].time : Infinity; }

  /** Process every event due at or before t. */
  runUntil(t) {
    while (this.queue.length && this.queue[0].time <= t) this.stepEvent();
    this.time = Math.max(this.time, Math.floor(t));   // simulated time is counted in whole ticks
  }

  /** Process exactly one event (step-by-step mode). */
  stepEvent() {
    const ev = this.queue.shift();
    if (!ev) return null;
    this.time = Math.max(this.time, ev.time);
    if (ev.kind === "timer") ev.fn();
    else if (ev.kind === "deliver") {
      this.emit("arrive", ev);
      if (ev.iface.link === ev.link && ev.iface.up) receive(ev.iface.device, ev.iface, ev.frame);
    }
    return ev;
  }

  /** Put a frame on the cable attached to `iface`. */
  send(iface, frame) {
    const peer = iface.peer;
    if (!peer || !iface.up) return false;
    frame.uid ||= ++this.seq;
    const ev = { kind: "deliver", time: this.time + HOP, start: this.time, from: iface, iface: peer, link: iface.link, frame };
    this.schedule(ev);
    this.emit("send", ev);
    return true;
  }

  // ---------------------------------------------------------------- serialisation
  toJSON() {
    return {
      format: "foct-netsim", version: 1,
      devices: this.devices.map((d) => ({
        id: d.id, type: d.type, name: d.name, x: Math.round(d.x), y: Math.round(d.y),
        gateway: d.gateway || undefined,
        routes: d.routes.length ? d.routes : undefined,
        ifaces: d.ifaces.map((i) => ({ name: i.name, mac: i.mac, ip: i.ip || undefined, mask: i.mask || undefined })),
      })),
      links: this.links.map((l) => [l.a.device.id, l.a.name, l.b.device.id, l.b.name]),
    };
  }

  static fromJSON(data) {
    if (!data || data.format !== "foct-netsim") throw new Error("This is not a FoCT NetSim file.");
    const net = new Network();
    const byId = new Map();
    for (const dd of data.devices) {
      if (!TYPES[dd.type]) continue;
      const d = new Device(net, dd.type, dd.name, dd.x, dd.y);
      d.gateway = dd.gateway || "";
      d.routes = (dd.routes || []).map((r) => ({ network: r.network, mask: r.mask, nextHop: r.nextHop }));
      dd.ifaces?.forEach((fi, k) => {
        const i = d.ifaces[k];
        if (!i) return;
        if (fi.mac) i.mac = fi.mac;
        i.ip = fi.ip || "";
        i.mask = fi.mask || "";
      });
      net.devices.push(d);
      byId.set(dd.id, d);
      net.counts[d.type] = (net.counts[d.type] || 0) + 1;
    }
    net.nextId = Math.max(0, ...net.devices.map((d) => d.id)) + 1;
    for (const [a, an, b, bn] of data.links || []) {
      const ia = byId.get(a)?.iface(an), ib = byId.get(b)?.iface(bn);
      if (ia && ib) net.connect(ia, ib);
    }
    return net;
  }

  // ---------------------------------------------------------------- checks
  problems() {
    const out = [];
    const seen = new Map();
    for (const d of this.devices) {
      for (const i of d.ifaces) {
        if (!i.ip && !i.mask) continue;
        if (i.ipInt === null) out.push(`${d.name} ${i.name}: "${i.ip}" is not a valid IPv4 address.`);
        if (i.maskInt === null) out.push(`${d.name} ${i.name}: "${i.mask}" is not a valid subnet mask.`);
        if (i.ipInt !== null) {
          const k = i.ipInt;
          if (seen.has(k)) out.push(`IP address conflict: ${i.ip} is used by ${seen.get(k)} and ${d.name}.`);
          else seen.set(k, d.name);
        }
      }
      if (d.info.host && d.gateway) {
        const g = ipToInt(d.gateway), i = d.ifaces[0];
        if (g === null) out.push(`${d.name}: default gateway "${d.gateway}" is not a valid address.`);
        else if (i.configured && !sameNet(g, i.ipInt, i.maskInt)) out.push(`${d.name}: the default gateway ${d.gateway} is not in its own subnet.`);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ frames & packets
function frame(src, dst, type, payload) { return { src, dst, type, payload }; }
function ipPacket(src, dst, proto, data, ttl = 64) { return { src, dst, proto, ttl, data }; }

export function describe(fr) {
  if (fr.type === "ARP") {
    const a = fr.payload;
    return a.op === "request" ? `ARP who has ${intToIp(a.targetIp)}? tell ${intToIp(a.senderIp)}`
      : `ARP ${intToIp(a.senderIp)} is at ${a.senderMac}`;
  }
  const p = fr.payload, ic = p.data;
  const what = {
    "echo-request": `ICMP echo request seq=${ic.seq}`,
    "echo-reply": `ICMP echo reply seq=${ic.seq}`,
    "time-exceeded": "ICMP time exceeded",
    unreachable: `ICMP destination ${ic.what} unreachable`,
  }[ic.type] || "IPv4";
  return `${what}  ${intToIp(p.src)} → ${intToIp(p.dst)}  TTL=${p.ttl}`;
}

export function layers(fr) {
  const L = [{
    name: "Ethernet II", fields: [["Destination MAC", fr.dst], ["Source MAC", fr.src], ["EtherType", fr.type === "ARP" ? "0x0806 (ARP)" : "0x0800 (IPv4)"]],
  }];
  if (fr.type === "ARP") {
    const a = fr.payload;
    L.push({ name: "ARP", fields: [["Operation", a.op === "request" ? "1 (request)" : "2 (reply)"], ["Sender MAC", a.senderMac], ["Sender IP", intToIp(a.senderIp)], ["Target MAC", a.targetMac], ["Target IP", intToIp(a.targetIp)]] });
  } else {
    const p = fr.payload, ic = p.data;
    L.push({ name: "IPv4", fields: [["Source IP", intToIp(p.src)], ["Destination IP", intToIp(p.dst)], ["TTL", p.ttl], ["Protocol", "1 (ICMP)"]] });
    const t = { "echo-request": "8 (echo request)", "echo-reply": "0 (echo reply)", "time-exceeded": "11 (time exceeded)", unreachable: "3 (destination unreachable)" }[ic.type];
    const f = [["Type", t]];
    if (ic.seq != null) f.push(["Identifier", ic.id], ["Sequence", ic.seq]);
    if (ic.what) f.push(["Code", ic.what === "net" ? "0 (net unreachable)" : "1 (host unreachable)"]);
    L.push({ name: "ICMP", fields: f });
  }
  return L;
}

// ------------------------------------------------------------------ device behaviour
function receive(dev, iface, fr) {
  const net = dev.net;
  const t = dev.info;
  if (t.hub) {
    for (const o of dev.ifaces) if (o !== iface && o.link) net.send(o, { ...fr, uid: 0 });
    return;
  }
  if (t.l2) {
    dev.macTable.set(fr.src, iface);
    const out = fr.dst === BROADCAST_MAC ? null : dev.macTable.get(fr.dst);
    if (out) { if (out !== iface) net.send(out, { ...fr, uid: 0 }); }
    else for (const o of dev.ifaces) if (o !== iface && o.link) net.send(o, { ...fr, uid: 0 });
    return;
  }
  // hosts and routers
  if (fr.dst !== iface.mac && fr.dst !== BROADCAST_MAC) return; // not for me
  if (fr.type === "ARP") return handleArp(dev, iface, fr.payload);
  if (fr.type === "IPv4") return handleIp(dev, iface, fr.payload);
}

function handleArp(dev, iface, a) {
  const net = dev.net;
  if (iface.configured && a.targetIp === iface.ipInt) {
    dev.arp.set(a.senderIp, { mac: a.senderMac, iface, time: net.time });
    if (a.op === "request") {
      net.send(iface, frame(iface.mac, a.senderMac, "ARP",
        { op: "reply", senderMac: iface.mac, senderIp: iface.ipInt, targetMac: a.senderMac, targetIp: a.senderIp }));
    }
    flushPending(dev, a.senderIp);
  } else if (a.op === "reply" && dev.arp.has(a.senderIp) === false && dev.pending.some((p) => p.ip === a.senderIp)) {
    dev.arp.set(a.senderIp, { mac: a.senderMac, iface, time: net.time });
    flushPending(dev, a.senderIp);
  }
}

function flushPending(dev, ip) {
  const ready = dev.pending.filter((p) => p.ip === ip);
  dev.pending = dev.pending.filter((p) => p.ip !== ip);
  const entry = dev.arp.get(ip);
  for (const p of ready) dev.net.send(p.iface, frame(p.iface.mac, entry.mac, "IPv4", p.packet));
}

/** Choose the outgoing interface and next-hop IP for a destination. */
export function route(dev, dst) {
  if (dev.info.host) {
    const i = dev.ifaces[0];
    if (!i.configured) return null;
    if (sameNet(dst, i.ipInt, i.maskInt) || dst === 0xffffffff) return { iface: i, nextHop: dst };
    const gw = ipToInt(dev.gateway);
    return gw !== null ? { iface: i, nextHop: gw, viaGateway: true } : null;
  }
  // router: longest prefix match over connected networks and static routes
  let best = null;
  for (const i of dev.ifaces) {
    if (!i.configured || !i.link) continue;
    const pfx = maskToPrefix(i.maskInt);
    if (sameNet(dst, i.ipInt, i.maskInt) && (!best || pfx > best.pfx)) best = { iface: i, nextHop: dst, pfx, kind: "C" };
  }
  for (const r of dev.routes) {
    const n = ipToInt(r.network), m = parseMask(r.mask), nh = ipToInt(r.nextHop);
    if (n === null || m === null || nh === null) continue;
    const pfx = maskToPrefix(m);
    if (!sameNet(dst, n, m) || (best && best.pfx >= pfx)) continue;
    const out = dev.ifaces.find((i) => i.configured && i.link && sameNet(nh, i.ipInt, i.maskInt));
    if (out) best = { iface: out, nextHop: nh, pfx, kind: "S" };
  }
  return best;
}

/** Send an IPv4 packet from a device (resolves ARP as needed). */
export function sendIp(dev, packet, onFail) {
  const net = dev.net;
  const r = route(dev, packet.dst);
  if (!r) { onFail?.("no-route"); return false; }
  const entry = dev.arp.get(r.nextHop);
  if (entry && entry.iface === r.iface) {
    net.send(r.iface, frame(r.iface.mac, entry.mac, "IPv4", packet));
    return true;
  }
  const already = dev.pending.some((p) => p.ip === r.nextHop);
  dev.pending.push({ ip: r.nextHop, packet, iface: r.iface, since: net.time });
  if (!already) {
    net.send(r.iface, frame(r.iface.mac, BROADCAST_MAC, "ARP",
      { op: "request", senderMac: r.iface.mac, senderIp: r.iface.ipInt, targetMac: "00:00:00:00:00:00", targetIp: r.nextHop }));
  }
  net.timer(ARP_TIMEOUT, () => {
    const left = dev.pending.filter((p) => p.ip === r.nextHop && p.packet === packet);
    if (!left.length) return;
    dev.pending = dev.pending.filter((p) => p.packet !== packet);
    onFail?.("arp", r);
  }, dev);
  return true;
}

function handleIp(dev, iface, p) {
  const net = dev.net;
  if (dev.ownsIp(p.dst) || (p.dst === 0xffffffff)) {
    const ic = p.data;
    if (ic.type === "echo-request") {
      const src = dev.info.router ? p.dst : iface.ipInt;
      sendIp(dev, ipPacket(src, p.src, "ICMP", { type: "echo-reply", id: ic.id, seq: ic.seq, sent: ic.sent }));
    } else {
      for (const proc of dev.procs) proc.onIcmp?.(p);
    }
    return;
  }
  if (!dev.info.router) return; // hosts do not forward
  if (p.ttl <= 1) {
    icmpError(dev, iface, p, { type: "time-exceeded" });
    return;
  }
  const fwd = { ...p, ttl: p.ttl - 1 };
  const ok = sendIp(dev, fwd, (why) => icmpError(dev, iface, p, { type: "unreachable", what: why === "no-route" ? "net" : "host" }));
  void ok;
}

function icmpError(dev, iface, orig, ic) {
  if (orig.data.type !== "echo-request") return; // never answer an error with an error
  const src = iface.ipInt;
  sendIp(dev, ipPacket(src, orig.src, "ICMP", { ...ic, about: { id: orig.data.id, seq: orig.data.seq, src: orig.src, dst: orig.dst, ttl: orig.ttl } }));
}

// ------------------------------------------------------------------ ping / traceroute processes
let echoId = 1;

export function ping(dev, target, count = 4, onDone) {
  const net = dev.net;
  const dst = ipToInt(target);
  if (dst === null) { dev.print(`Ping request could not find host ${target}. Please check the name and try again.`); onDone?.(); return; }
  const out = route(dev, dst);
  const srcIface = out ? out.iface : dev.ifaces.find((i) => i.configured);
  if (!srcIface || !srcIface.configured) { dev.print("PING: transmit failed. General failure. (Configure an IP address first.)"); onDone?.(); return; }
  const id = echoId++;
  const stats = { sent: 0, received: 0, rtts: [] };
  let seq = 0, outstanding = null, finished = false;
  dev.print("");
  dev.print(`Pinging ${target} with 32 bytes of data:`);

  const finish = () => {
    if (finished) return;
    finished = true;
    dev.procs.delete(proc);
    const lost = stats.sent - stats.received;
    dev.print("");
    dev.print(`Ping statistics for ${target}:`);
    dev.print(`    Packets: Sent = ${stats.sent}, Received = ${stats.received}, Lost = ${lost} (${Math.round((lost / stats.sent) * 100)}% loss),`);
    if (stats.rtts.length) {
      const min = Math.min(...stats.rtts), max = Math.max(...stats.rtts);
      const avg = Math.round(stats.rtts.reduce((x, y) => x + y, 0) / stats.rtts.length);
      dev.print("Approximate round trip times in milli-seconds:");
      dev.print(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
    }
    onDone?.(stats);
  };
  const advance = () => {
    outstanding = null;
    if (seq >= count) finish();
    else net.timer(PING_INTERVAL, sendOne, dev);
  };
  const proc = {
    onIcmp(p) {
      const ic = p.data;
      const ref = ic.type === "echo-reply" ? ic : ic.about;
      if (outstanding === null || !ref || ref.id !== id || ref.seq !== outstanding) return;
      if (ic.type === "echo-reply") {
        const rtt = Math.max(1, Math.round(net.time - ic.sent));
        stats.received++;
        stats.rtts.push(rtt);
        dev.print(`Reply from ${intToIp(p.src)}: bytes=32 time=${rtt}ms TTL=${p.ttl}`);
      } else if (ic.type === "unreachable") {
        dev.print(`Reply from ${intToIp(p.src)}: Destination ${ic.what} unreachable.`);
      } else if (ic.type === "time-exceeded") {
        dev.print(`Reply from ${intToIp(p.src)}: TTL expired in transit.`);
      }
      advance();
    },
  };
  dev.procs.add(proc);

  function sendOne() {
    if (finished) return;
    seq++;
    stats.sent++;
    const mySeq = seq;
    outstanding = mySeq;
    if (dev.ownsIp(dst)) {
      stats.received++;
      stats.rtts.push(1);
      dev.print(`Reply from ${target}: bytes=32 time<1ms TTL=64`);
      advance();
      return;
    }
    const pkt = ipPacket(srcIface.ipInt, dst, "ICMP", { type: "echo-request", id, seq: mySeq, sent: net.time });
    sendIp(dev, pkt, (why) => {
      if (outstanding !== mySeq) return;
      if (why === "no-route") dev.print("PING: transmit failed. General failure. (No route or default gateway.)");
      else dev.print(`Reply from ${intToIp(srcIface.ipInt)}: Destination host unreachable.`);
      advance();
    });
    net.timer(PING_TIMEOUT, () => {
      if (outstanding !== mySeq) return;
      dev.print("Request timed out.");
      advance();
    }, dev);
  }
  sendOne();
}

export function traceroute(dev, target, onDone) {
  const net = dev.net;
  const dst = ipToInt(target);
  if (dst === null) { dev.print(`Unable to resolve target system name ${target}.`); onDone?.(); return; }
  const out = route(dev, dst);
  if (!out) { dev.print("Transmit error: no route to the destination (check the default gateway)."); onDone?.(); return; }
  const id = echoId++;
  dev.print("");
  dev.print(`Tracing route to ${target} over a maximum of 15 hops`);
  dev.print("");
  let ttl = 0, done = false, current = null;
  const proc = {
    onIcmp(p) {
      const ic = p.data;
      const ref = ic.type === "echo-reply" ? ic : ic.about;
      if (!current || !ref || ref.id !== id || ref.seq !== current.seq) return;
      const rtt = Math.max(1, Math.round(net.time - current.sent));
      const hop = String(current.ttl).padStart(3);
      if (ic.type === "unreachable") {
        dev.print(`${hop}   ${String(rtt).padStart(3)} ms    ${intToIp(p.src)}  reports: Destination ${ic.what} unreachable.`);
        return finish();
      }
      dev.print(`${hop}   ${String(rtt).padStart(3)} ms    ${intToIp(p.src)}`);
      current = null;
      if (ic.type === "echo-reply") finish(); else probe();
    },
  };
  const finish = () => {
    if (done) return;
    done = true;
    dev.procs.delete(proc);
    dev.print("");
    dev.print("Trace complete.");
    onDone?.();
  };
  const probe = () => {
    if (done) return;
    ttl++;
    if (ttl > 15) return finish();
    const seq = ttl;
    current = { ttl, seq, sent: net.time };
    sendIp(dev, ipPacket(out.iface.ipInt, dst, "ICMP", { type: "echo-request", id, seq, sent: net.time }, ttl), () => {
      dev.print(`${String(ttl).padStart(3)}     *        Destination host unreachable.`);
      finish();
    });
    net.timer(PING_TIMEOUT, () => {
      if (done || !current || current.seq !== seq) return;
      dev.print(`${String(ttl).padStart(3)}     *        Request timed out.`);
      current = null;
      probe();
    }, dev);
  };
  dev.procs.add(proc);
  probe();
}

// ------------------------------------------------------------------ command line
export function runCommand(dev, line, done) {
  const args = line.trim().split(/\s+/).filter(Boolean);
  if (!args.length) return done();
  const cmd = args[0].toLowerCase();
  const p = (s) => dev.print(s);
  const t = dev.info;
  const ipOf = (i) => i.ip || "unassigned", maskOf = (i) => i.mask || "";

  if (cmd === "help" || cmd === "?") {
    if (t.host) p("Commands: ipconfig  ping <ip> [-n count]  tracert <ip>  arp -a  arp -d  cls  help");
    else if (t.router) p("Commands: show ip route  show ip interface brief  show arp  ping <ip>  traceroute <ip>  clear arp  help");
    else if (t.l2) p("Commands: show mac address-table  clear mac address-table  help");
    else p("A hub has no configuration: it repeats every frame to all other ports.");
    return done();
  }
  if (cmd === "cls" || cmd === "clear" && args[1] !== "arp" && args[1] !== "mac") { dev.output = []; dev.net.emit("print", { device: dev, clear: true }); return done(); }

  if (t.host || t.router) {
    if (cmd === "ping") {
      const n = args.indexOf("-n");
      const count = n > 0 ? Math.max(1, Math.min(20, parseInt(args[n + 1], 10) || 4)) : 4;
      const target = args.find((a, k) => k > 0 && a !== "-n" && args[k - 1] !== "-n");
      if (!target) { p("Usage: ping <ip address> [-n count]"); return done(); }
      return ping(dev, target, count, () => done());
    }
    if (cmd === "tracert" || cmd === "traceroute") {
      if (!args[1]) { p(`Usage: ${cmd} <ip address>`); return done(); }
      return traceroute(dev, args[1], () => done());
    }
    if ((cmd === "arp" && args[1] === "-a") || (cmd === "show" && args[1] === "arp")) {
      if (!dev.arp.size) p("No ARP Entries Found.");
      else {
        p("  Internet Address      Physical Address      Interface");
        for (const [ip, e] of dev.arp) p(`  ${intToIp(ip).padEnd(22)}${e.mac.padEnd(22)}${e.iface.name}`);
      }
      return done();
    }
    if ((cmd === "arp" && args[1] === "-d") || (cmd === "clear" && args[1] === "arp")) { dev.arp.clear(); p("ARP cache cleared."); return done(); }
  }
  if (t.host && cmd === "ipconfig") {
    const i = dev.ifaces[0];
    p("");
    p(`Ethernet adapter ${i.name}:`);
    p("");
    p(`   Physical Address. . . . . . . . : ${i.mac}`);
    p(`   IPv4 Address. . . . . . . . . . : ${ipOf(i)}`);
    p(`   Subnet Mask . . . . . . . . . . : ${maskOf(i)}`);
    p(`   Default Gateway . . . . . . . . : ${dev.gateway || ""}`);
    if (!i.link) p("   Media State . . . . . . . . . . : Media disconnected");
    return done();
  }
  if (t.router && cmd === "show" && args[1] === "ip" && args[2] === "route") {
    p("Codes: C - connected, S - static");
    p("");
    let any = false;
    for (const i of dev.ifaces) {
      if (!i.configured || !i.link) continue;
      any = true;
      const net = intToIp((i.ipInt & i.maskInt) >>> 0);
      p(`C    ${net}/${maskToPrefix(i.maskInt)} is directly connected, ${i.name}`);
    }
    for (const r of dev.routes) {
      const m = parseMask(r.mask);
      any = true;
      p(`S    ${r.network}/${m === null ? "?" : maskToPrefix(m)} [1/0] via ${r.nextHop}`);
    }
    if (!any) p("(routing table is empty: configure interface addresses and connect cables)");
    return done();
  }
  if (t.router && cmd === "show" && args[1] === "ip" && /^int/.test(args[2] || "")) {
    p("Interface        IP-Address       Mask              Status");
    for (const i of dev.ifaces) p(`${i.name.padEnd(17)}${ipOf(i).padEnd(17)}${(maskOf(i) || "-").padEnd(18)}${i.link ? "up" : "down"}`);
    return done();
  }
  if (t.l2 && cmd === "show" && args[1] === "mac") {
    p("          Mac Address Table");
    p("-------------------------------------------");
    p("Vlan    Mac Address           Ports");
    p("----    -----------           -----");
    if (!dev.macTable.size) p("(empty - the switch learns addresses as frames arrive)");
    for (const [mac, i] of dev.macTable) p(`   1    ${mac.padEnd(22)}${i.name}`);
    return done();
  }
  if (t.l2 && cmd === "clear" && args[1] === "mac") { dev.macTable.clear(); p("MAC address table cleared."); return done(); }
  p(`'${args[0]}' is not recognized. Type 'help' for the list of commands.`);
  done();
}
