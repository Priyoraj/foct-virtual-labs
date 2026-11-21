// FoCT Virtual Labs: small helpers for capture files (pcap and pcapng).
// The Network Simulator writes its packets as a pcap file; the Packet Analyzer cuts the packets a
// student filtered out of the file they opened.

/** Write packets as a classic pcap file. packets: [{ time (seconds, float), data: Uint8Array }] */
export function writePcap(packets, { linktype = 1, snaplen = 65535 } = {}) {
  const size = 24 + packets.reduce((n, p) => n + 16 + p.data.length, 0);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xa1b2c3d4, true);      // microsecond timestamps, little-endian
  dv.setUint16(4, 2, true);
  dv.setUint16(6, 4, true);
  dv.setUint32(16, snaplen, true);
  dv.setUint32(20, linktype, true);         // 1 = Ethernet
  let o = 24;
  for (const p of packets) {
    const sec = Math.floor(p.time);
    const usec = Math.min(999999, Math.round((p.time - sec) * 1e6));
    dv.setUint32(o, sec, true);
    dv.setUint32(o + 4, usec, true);
    dv.setUint32(o + 8, p.data.length, true);
    dv.setUint32(o + 12, p.data.length, true);
    buf.set(p.data, o + 16);
    o += 16 + p.data.length;
  }
  return buf;
}

/** The capture format of a file's first bytes: "pcap", "pcapng" or null. */
export function captureFormat(bytes) {
  if (bytes.length < 24) return null;
  const m = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if ([0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x4d3cb2a1].includes(m)) return "pcap";
  if (m === 0x0a0d0d0a) return "pcapng";
  return null;
}

/** A copy of a pcap or pcapng file with only the packets whose numbers (1-based, as Wireshark
 *  counts them) are in `keep`. Returns null for other file types. */
export function slicePackets(bytes, keep) {
  const fmt = captureFormat(bytes);
  if (fmt === "pcap") return slicePcap(bytes, keep);
  if (fmt === "pcapng") return slicePcapng(bytes, keep);
  return null;
}

function slicePcap(bytes, keep) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  const le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d;
  const parts = [bytes.subarray(0, 24)];
  let o = 24, n = 0;
  while (o + 16 <= bytes.length) {
    const len = dv.getUint32(o + 8, le);
    const end = o + 16 + len;
    if (end > bytes.length) break;
    if (keep.has(++n)) parts.push(bytes.subarray(o, end));
    o = end;
  }
  return join(parts);
}

function slicePcapng(bytes, keep) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  let o = 0, n = 0, le = true;
  while (o + 12 <= bytes.length) {
    if (dv.getUint32(o, true) === 0x0a0d0d0a) le = dv.getUint32(o + 8, true) === 0x1a2b3c4d;   // a section starts
    const type = dv.getUint32(o, le);
    const len = dv.getUint32(o + 4, le);
    if (len < 12 || o + len > bytes.length) break;
    const block = bytes.subarray(o, o + len);
    if (type === 6 || type === 3 || type === 2) {          // enhanced, simple and old packet blocks
      if (keep.has(++n)) parts.push(block);
    } else if (type !== 5) {                               // interface statistics would no longer be right
      parts.push(block);
    }
    o += len;
  }
  return join(parts);
}

function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
