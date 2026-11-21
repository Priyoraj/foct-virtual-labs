// FoCT Virtual Labs - Packet Analyzer: Wireshark's dissectors (Wiregasm, WebAssembly) in a worker,
// so opening a big capture never freezes the page. Messages: { id, cmd, args } -> { id, result | error }.
import { Wiregasm, vectorToArray } from "/runtimes/wiregasm/module.js";
import loadWiregasm from "/runtimes/wiregasm/wiregasm.mjs";

const BASE = new URL("/runtimes/wiregasm/", self.location.origin).href;
const wg = new Wiregasm();
let ready = null;

const status = (text) => self.postMessage({ type: "status", text });

function b64(s) {
  const bin = atob(s || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const arr = (v) => (v && typeof v.size === "function" ? vectorToArray(v) : Array.isArray(v) ? v : []);

function tree(nodes) {
  return arr(nodes).map((n) => ({
    label: n.label, filter: n.filter, start: n.start, length: n.length, src: n.data_source_idx,
    type: n.type, fnum: n.fnum, children: tree(n.tree),
  }));
}

async function init() {
  status("Loading Wireshark …");
  await wg.init(loadWiregasm, {
    locateFile: (path) => BASE + path,
    handleStatus: (type, text) => { if (text) status(text); },
    print: () => {},
    printErr: (t) => console.debug("wiregasm:", t),
  });
  const columns = wg.columns();
  status("");
  return { columns };
}

const commands = {
  init: () => (ready ||= init()),
  async load(name, bytes) {
    await ready;
    const r = wg.load(name.replace(/[^\w.\-]+/g, "_") || "capture.pcap", bytes);
    if (r.code !== 0) throw new Error(r.error || "Wireshark could not read this file.");
    const s = r.summary;
    return { packets: s.packet_count, type: s.file_type, encap: s.file_encap_type, start: s.start_time, stop: s.stop_time, elapsed: s.elapsed_time };
  },
  frames(filter, skip = 0, limit = 0) {
    const r = wg.frames(filter || "", skip, limit);
    const frames = arr(r.frames).map((f) => ({ n: f.number, bg: f.bg, fg: f.fg, cols: arr(f.columns) }));
    return { frames, matched: r.matched };
  },
  frame(n) {
    const f = wg.frame(n);
    const out = {
      n: f.number,
      tree: tree(f.tree),
      sources: arr(f.data_sources).map((d) => ({ name: d.name, data: b64(d.data) })),
      follow: arr(f.follow).map((v) => arr(v)),
      comments: arr(f.comments),
    };
    return out;
  },
  check(filter) {
    const r = wg.testFilter(filter);
    return { ok: r.ok, error: r.error };
  },
  complete(prefix) {
    return wg.completeFilter(prefix).fields.slice(0, 40).map((f) => ({ field: f.field, name: f.name, type: f.type }));
  },
  follow(proto, filter) {
    const r = wg.follow(proto, filter);
    return {
      shost: r.shost, sport: r.sport, sbytes: r.sbytes, chost: r.chost, cport: r.cport, cbytes: r.cbytes,
      payloads: arr(r.payloads).map((p) => ({ n: p.number, server: !!p.server, data: b64(p.data) })),
    };
  },
  tap(taps) {
    const r = wg.tap(taps);
    if (r.error) throw new Error(r.error);
    return r.taps.map((t) => ({
      type: t.type, tap: t.tap, proto: t.proto,
      convs: t.convs ? t.convs.map((c) => ({ ...c })) : undefined,
      hosts: t.hosts ? t.hosts.map((h) => ({ ...h })) : undefined,
      objects: t.objects ? t.objects.map((o) => ({ ...o })) : undefined,
    }));
  },
  download(token) {
    const r = wg.download(token);
    if (r.error) throw new Error(r.error);
    return { file: r.download.file, mime: r.download.mime, data: b64(r.download.data) };
  },
};

self.onmessage = async (e) => {
  const { id, cmd, args = [] } = e.data || {};
  try {
    if (cmd !== "init") await (ready || commands.init());
    const result = await commands[cmd](...args);
    const transfer = [];
    if (result && result.sources) for (const s of result.sources) transfer.push(s.data.buffer);
    if (result && result.payloads) for (const p of result.payloads) transfer.push(p.data.buffer);
    if (result && result.data instanceof Uint8Array) transfer.push(result.data.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
