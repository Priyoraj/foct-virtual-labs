#!/usr/bin/env python3
"""Make the sample captures for the Packet Analyzer lab (web/apps/packets/samples).

Each capture is a small, made-up but realistic conversation in a lab network, written as a pcap
file that Wireshark (and so the Packet Analyzer) opens: ARP and ping, a web page (DNS, TCP and
HTTP), a TCP download that loses a segment, DHCP, an FTP login in clear text and the start of an
HTTPS (TLS 1.3) connection. samples.json lists them with things to try.

    python tools/make_captures.py

Only the standard library is needed. The output is the same on every run.
"""
import json
import random
import struct
import zlib
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "apps" / "packets" / "samples"
T0 = datetime(2026, 11, 23, 4, 30, tzinfo=timezone.utc).timestamp()     # 23 Nov 2026, 10:00 in India
rnd = random.Random(2026)


def mac(s):
    return bytes(int(x, 16) for x in s.split(":"))


def ip(s):
    return bytes(int(x) for x in s.split("."))


class Host:
    def __init__(self, name, addr, hw, ttl):
        self.name, self.ip, self.mac, self.ttl = name, addr, hw, ttl
        self.ipid = rnd.randrange(1000, 60000)


PC = Host("LAB-PC-37", "10.20.1.37", "18:66:da:3e:21:37", 128)        # a Dell PC running Windows
PC2 = Host("LAB-PC-38", "10.20.1.38", "18:66:da:3e:21:38", 128)
GW = Host("gateway", "10.20.1.1", "00:1b:54:c2:10:01", 255)           # a Cisco router: gateway, DHCP and DNS
SRV = Host("labs.foct.test", "10.20.1.5", "3c:d9:2b:5a:00:05", 64)    # an HP server running Linux
BCAST = "ff:ff:ff:ff:ff:ff"


def csum(b):
    if len(b) % 2:
        b += b"\0"
    s = sum(struct.unpack(f"!{len(b) // 2}H", b))
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return ~s & 0xFFFF


def eth(dst, src, etype, payload):
    return mac(dst) + mac(src) + struct.pack("!H", etype) + payload


def ipv4(src, dst_ip, proto, payload, src_ip=None, df=True):
    src.ipid = (src.ipid + 1) & 0xFFFF
    h = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), src.ipid, 0x4000 if df else 0, src.ttl, proto, 0,
                    ip(src_ip or src.ip), ip(dst_ip))
    return h[:10] + struct.pack("!H", csum(h)) + h[12:] + payload


def l4sum(src_ip, dst_ip, proto, seg):
    return csum(ip(src_ip) + ip(dst_ip) + struct.pack("!BBH", 0, proto, len(seg)) + seg)


def udp(src_ip, sport, dst_ip, dport, data):
    seg = struct.pack("!HHHH", sport, dport, 8 + len(data), 0) + data
    return seg[:6] + struct.pack("!H", l4sum(src_ip, dst_ip, 17, seg) or 0xFFFF) + seg[8:]


def tcp(src_ip, sport, dst_ip, dport, seq, ack, flags, win, data=b"", opts=b""):
    off = (20 + len(opts)) // 4
    seg = struct.pack("!HHIIBBHHH", sport, dport, seq & 0xFFFFFFFF, ack & 0xFFFFFFFF, off << 4, flags, win, 0, 0) + opts + data
    return seg[:16] + struct.pack("!H", l4sum(src_ip, dst_ip, 6, seg)) + seg[18:]


def icmp(kind, code, rest, data=b""):
    m = struct.pack("!BBH", kind, code, 0) + rest + data
    return m[:2] + struct.pack("!H", csum(m)) + m[4:]


def arp(op, smac, sip, tmac, tip):
    return struct.pack("!HHBBH", 1, 0x0800, 6, 4, op) + mac(smac) + ip(sip) + mac(tmac) + ip(tip)


class Capture:
    def __init__(self, start=0.0):
        self.t = T0 + start
        self.frames = []

    def add(self, frame, dt=0.0):
        self.t += dt
        self.frames.append((self.t, frame))

    def write(self, name):
        out = struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)
        for t, f in self.frames:
            sec = int(t)
            out += struct.pack("<IIII", sec, int(round((t - sec) * 1e6)) % 1000000, len(f), len(f)) + f
        (OUT / name).write_bytes(out)
        return len(self.frames)


FIN, SYN, RST, PSH, ACK = 1, 2, 4, 8, 16
SYN_OPTS = struct.pack("!BBH", 2, 4, 1460) + b"\x01\x01\x04\x02"             # MSS 1460, NOP, NOP, SACK permitted


class Tcp:
    """One TCP connection seen from the client's side of the lab network."""

    def __init__(self, cap, c, s, cport, sport, rtt=0.0006):
        self.cap, self.c, self.s, self.cport, self.sport, self.rtt = cap, c, s, cport, sport, rtt
        self.cseq, self.sseq = rnd.randrange(1 << 31), rnd.randrange(1 << 31)
        self.cwin, self.swin = 64240, 64240

    def seg(self, from_client, flags, data=b"", dt=0.0, opts=b"", seq=None):
        a, b = (self.c, self.s) if from_client else (self.s, self.c)
        ap, bp = (self.cport, self.sport) if from_client else (self.sport, self.cport)
        mine = self.cseq if from_client else self.sseq
        theirs = self.sseq if from_client else self.cseq
        pkt = tcp(a.ip, ap, b.ip, bp, mine if seq is None else seq, theirs if flags & ACK else 0, flags,
                  self.cwin if from_client else self.swin, data, opts)
        self.cap.add(eth(b.mac, a.mac, 0x0800, ipv4(a, b.ip, 6, pkt)), dt)
        if seq is None:
            step = len(data) + (1 if flags & (SYN | FIN) else 0)
            if from_client:
                self.cseq += step
            else:
                self.sseq += step

    def open(self, dt=0.0):
        self.seg(True, SYN, dt=dt, opts=SYN_OPTS)
        self.seg(False, SYN | ACK, dt=self.rtt, opts=SYN_OPTS)
        self.seg(True, ACK, dt=0.00012)

    def send(self, from_client, data, dt=0.0003, gap=0.00004):
        for i in range(0, len(data), 1460):
            part = data[i:i + 1460]
            last = i + 1460 >= len(data)
            self.seg(from_client, ACK | (PSH if last else 0), part, dt=dt if i == 0 else gap)

    def ack(self, from_client, dt=0.00015):
        self.seg(from_client, ACK, dt=dt)

    def close(self, dt=0.01):
        self.seg(True, FIN | ACK, dt=dt)
        self.seg(False, FIN | ACK, dt=self.rtt)
        self.seg(True, ACK, dt=0.0001)


def dns_name(n):
    return b"".join(bytes([len(p)]) + p.encode() for p in n.split(".")) + b"\0"


def dns_query(qid, name, qtype=1):
    return struct.pack("!HHHHHH", qid, 0x0100, 1, 0, 0, 0) + dns_name(name) + struct.pack("!HH", qtype, 1)


def dns_answer(qid, name, qtype, answers):
    msg = struct.pack("!HHHHHH", qid, 0x8180, 1, len(answers), 0, 0) + dns_name(name) + struct.pack("!HH", qtype, 1)
    for rtype, ttl, rdata in answers:
        msg += struct.pack("!HHHIH", 0xC00C, rtype, 1, ttl, len(rdata)) + rdata
    return msg


def png(w=48, h=48):
    """A small real PNG: the FoCT navy with a gold band."""
    rows = b""
    for y in range(h):
        rows += b"\0" + b"".join(bytes((246, 196, 0)) if 18 <= y < 30 else bytes((52, 46, 108)) for _ in range(w))

    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", w, h, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def http_response(status, ctype, body, extra=b""):
    head = (f"HTTP/1.1 {status}\r\nDate: Mon, 23 Nov 2026 04:30:01 GMT\r\nServer: Apache/2.4.62 (Ubuntu)\r\n"
            f"Content-Type: {ctype}\r\nContent-Length: {len(body)}\r\nKeep-Alive: timeout=5, max=100\r\n"
            f"Connection: Keep-Alive\r\n").encode() + extra + b"\r\n"
    return head + body


UA = b"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0"


# ------------------------------------------------------------------ the captures
def arp_ping():
    cap = Capture()
    cap.add(eth(BCAST, PC.mac, 0x0806, arp(1, PC.mac, PC.ip, "00:00:00:00:00:00", PC2.ip)))
    cap.add(eth(PC.mac, PC2.mac, 0x0806, arp(2, PC2.mac, PC2.ip, PC.mac, PC.ip)), 0.00031)
    payload = b"abcdefghijklmnopqrstuvwabcdefghi"                        # what Windows ping sends
    for seq in range(1, 5):
        cap.add(eth(PC2.mac, PC.mac, 0x0800, ipv4(PC, PC2.ip, 1, icmp(8, 0, struct.pack("!HH", 1, 40 + seq), payload))),
                0.0002 if seq == 1 else 1.0)
        cap.add(eth(PC.mac, PC2.mac, 0x0800, ipv4(PC2, PC.ip, 1, icmp(0, 0, struct.pack("!HH", 1, 40 + seq), payload))),
                0.00042 + seq * 0.00003)
    # a ping to an address with no PC: ARP gets no answer
    for k in range(3):
        cap.add(eth(BCAST, PC.mac, 0x0806, arp(1, PC.mac, PC.ip, "00:00:00:00:00:00", "10.20.1.99")), 1.0 if k == 0 else 0.5)
    return cap


def dns_http():
    cap = Capture()
    cap.add(eth(GW.mac, PC.mac, 0x0800, ipv4(PC, GW.ip, 17, udp(PC.ip, 53114, GW.ip, 53, dns_query(0x6b21, "labs.foct.test")))))
    cap.add(eth(GW.mac, PC.mac, 0x0800, ipv4(PC, GW.ip, 17, udp(PC.ip, 53115, GW.ip, 53, dns_query(0x6b22, "labs.foct.test", 28)))), 0.00005)
    cap.add(eth(PC.mac, GW.mac, 0x0800, ipv4(GW, PC.ip, 17, udp(GW.ip, 53, PC.ip, 53114,
            dns_answer(0x6b21, "labs.foct.test", 1, [(1, 300, ip(SRV.ip))])))), 0.0021)
    cap.add(eth(PC.mac, GW.mac, 0x0800, ipv4(GW, PC.ip, 17, udp(GW.ip, 53, PC.ip, 53115,
            dns_answer(0x6b22, "labs.foct.test", 28, [])))), 0.00011)
    c = Tcp(cap, PC, SRV, 50412, 80)
    c.open(0.0004)
    page = ("<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"><title>FoCT Virtual Labs</title></head>\n"
            "<body>\n<h1>Faculty of Computer Technology</h1>\n<img src=\"/images/logo.png\" alt=\"logo\">\n"
            "<p>Welcome to the computer lab. Notices for this week:</p>\n<ul>\n"
            + "".join(f"<li>Lab {i}: practical {i} of the Computer Networks course, room 30{i % 4}.</li>\n" for i in range(1, 40))
            + "</ul>\n</body>\n</html>\n").encode()
    c.send(True, b"GET /index.html HTTP/1.1\r\nHost: labs.foct.test\r\nUser-Agent: " + UA +
           b"\r\nAccept: text/html,application/xhtml+xml\r\nAccept-Language: en-IN,en;q=0.9\r\nConnection: keep-alive\r\n\r\n", dt=0.0001)
    c.ack(False, 0.0005)
    c.send(False, http_response("200 OK", "text/html; charset=UTF-8", page), dt=0.0021)
    c.ack(True)
    c.send(True, b"GET /images/logo.png HTTP/1.1\r\nHost: labs.foct.test\r\nUser-Agent: " + UA +
           b"\r\nAccept: image/avif,image/webp,image/png,*/*;q=0.8\r\nReferer: http://labs.foct.test/index.html\r\nConnection: keep-alive\r\n\r\n", dt=0.012)
    c.send(False, http_response("200 OK", "image/png", png()), dt=0.0011)
    c.ack(True)
    c.send(True, b"GET /favicon.ico HTTP/1.1\r\nHost: labs.foct.test\r\nUser-Agent: " + UA + b"\r\nConnection: keep-alive\r\n\r\n", dt=0.03)
    nf = b"<html><body><h1>Not Found</h1></body></html>\n"
    c.send(False, http_response("404 Not Found", "text/html", nf), dt=0.0009)
    c.ack(True)
    c.close(5.0)
    return cap


def tcp_loss():
    cap = Capture()
    c = Tcp(cap, PC, SRV, 50433, 80, rtt=0.0011)
    c.open()
    c.send(True, b"GET /results.csv HTTP/1.1\r\nHost: labs.foct.test\r\nUser-Agent: " + UA + b"\r\nConnection: keep-alive\r\n\r\n", dt=0.0001)
    rows = "roll_no,name,marks\n" + "".join(f"ADTU/2023/BCA/{n:03d},Student {n},{rnd.randrange(35, 100)}\n" for n in range(1, 460))
    data = http_response("200 OK", "text/csv", rows.encode())
    segs = [data[i:i + 1460] for i in range(0, len(data), 1460)]
    base = c.sseq
    lost = 3                                   # the 4th segment never reaches this PC
    t_first = 0.0024
    for k, part in enumerate(segs):
        seq = base + k * 1460
        if k == lost:
            cap.t += 0.00005
            continue
        flags = ACK | (PSH if k == len(segs) - 1 else 0)
        c.seg(False, flags, part, dt=t_first if k == 0 else 0.00005, seq=seq)
        if k == lost + 1 or k > lost + 1:
            if k <= lost + 4:                  # the client keeps asking for the missing bytes: duplicate ACKs
                cap.add(eth(SRV.mac, PC.mac, 0x0800, ipv4(PC, SRV.ip, 6, tcp(PC.ip, 50433, SRV.ip, 80, c.cseq, base + lost * 1460, ACK, 64240))), 0.00004)
        elif k % 2 == 1:
            cap.add(eth(SRV.mac, PC.mac, 0x0800, ipv4(PC, SRV.ip, 6, tcp(PC.ip, 50433, SRV.ip, 80, c.cseq, seq + len(part), ACK, 64240))), 0.00004)
    # the server resends the missing segment after three duplicate ACKs (fast retransmission)
    c.seg(False, ACK, segs[lost], dt=0.0012, seq=base + lost * 1460)
    c.sseq = base + len(data)
    c.ack(True, 0.00006)
    c.close(2.0)
    return cap


def dhcp_msg(op, xid, mtype, yiaddr="0.0.0.0", opts=()):
    m = struct.pack("!BBBBIHH4s4s4s4s", op, 1, 6, 0, xid, 0, 0x8000, ip("0.0.0.0"), ip(yiaddr),
                    ip(GW.ip if op == 2 else "0.0.0.0"), ip("0.0.0.0"))
    m += mac(PC.mac) + b"\0" * 10 + b"\0" * 64 + b"\0" * 128 + bytes((99, 130, 83, 99))
    for code, val in ((53, bytes([mtype])),) + tuple(opts):
        m += bytes((code, len(val))) + val
    return m + b"\xff"


def dhcp():
    cap = Capture()
    xid = 0x3c9a51e7
    client = ((61, b"\x01" + mac(PC.mac)), (12, b"LAB-PC-37"), (60, b"MSFT 5.0"),
              (55, bytes((1, 3, 6, 15, 31, 33, 43, 44, 46, 47, 119, 121, 249, 252))))
    server = ((54, ip(GW.ip)), (51, struct.pack("!I", 86400)), (1, ip("255.255.255.0")), (3, ip(GW.ip)),
              (6, ip(GW.ip)), (15, b"foct.test"))
    zero = Host("unconfigured", "0.0.0.0", PC.mac, 128)
    cap.add(eth(BCAST, PC.mac, 0x0800, ipv4(zero, "255.255.255.255", 17, udp("0.0.0.0", 68, "255.255.255.255", 67, dhcp_msg(1, xid, 1, opts=client)), df=False)))
    cap.add(eth(BCAST, GW.mac, 0x0800, ipv4(GW, "255.255.255.255", 17, udp(GW.ip, 67, "255.255.255.255", 68, dhcp_msg(2, xid, 2, PC.ip, server)), df=False)), 0.0018)
    req = ((50, ip(PC.ip)), (54, ip(GW.ip))) + client
    cap.add(eth(BCAST, PC.mac, 0x0800, ipv4(zero, "255.255.255.255", 17, udp("0.0.0.0", 68, "255.255.255.255", 67, dhcp_msg(1, xid, 3, opts=req)), df=False)), 0.0021)
    cap.add(eth(BCAST, GW.mac, 0x0800, ipv4(GW, "255.255.255.255", 17, udp(GW.ip, 67, "255.255.255.255", 68, dhcp_msg(2, xid, 5, PC.ip, server)), df=False)), 0.0015)
    # with its new address the PC checks nobody else uses it (gratuitous ARP)
    cap.add(eth(BCAST, PC.mac, 0x0806, arp(1, PC.mac, "0.0.0.0", "00:00:00:00:00:00", PC.ip)), 0.05)
    cap.add(eth(BCAST, PC.mac, 0x0806, arp(1, PC.mac, PC.ip, "00:00:00:00:00:00", PC.ip)), 1.0)
    return cap


def ftp_login():
    cap = Capture()
    c = Tcp(cap, PC, SRV, 50461, 21)
    c.open()
    talk = [(False, b"220 (vsFTPd 3.0.5) FoCT lab file server\r\n"), (True, b"USER student37\r\n"),
            (False, b"331 Please specify the password.\r\n"), (True, b"PASS Lab@2026\r\n"),
            (False, b"230 Login successful.\r\n"), (True, b"SYST\r\n"), (False, b"215 UNIX Type: L8\r\n"),
            (True, b"PWD\r\n"), (False, b"257 \"/home/student37\" is the current directory\r\n"),
            (True, b"QUIT\r\n"), (False, b"221 Goodbye.\r\n")]
    for i, (from_client, line) in enumerate(talk):
        c.send(from_client, line, dt=0.0009 if not from_client else (0.8 + 0.4 * (i % 3)))
        c.ack(not from_client, 0.0002)
    c.seg(False, FIN | ACK, dt=0.0003)
    c.seg(True, ACK, dt=0.0001)
    c.seg(True, FIN | ACK, dt=0.0002)
    c.seg(False, ACK, dt=0.0005)
    return cap


def ext(kind, body):
    return struct.pack("!HH", kind, len(body)) + body


def client_hello(sni):
    name = sni.encode()
    exts = (ext(0, struct.pack("!HBH", len(name) + 3, 0, len(name)) + name)                  # server name
            + ext(10, struct.pack("!H", 6) + struct.pack("!HHH", 0x001d, 0x0017, 0x0018))   # groups: x25519, P-256, P-384
            + ext(11, b"\x01\x00")                                                           # point formats
            + ext(13, struct.pack("!H", 8) + struct.pack("!HHHH", 0x0403, 0x0804, 0x0401, 0x0805))
            + ext(16, struct.pack("!H", 12) + b"\x02h2\x08http/1.1")                         # ALPN
            + ext(43, b"\x04\x03\x04\x03\x03")                                               # versions: TLS 1.3, 1.2
            + ext(45, b"\x01\x01")
            + ext(51, struct.pack("!HHH", 38, 0x001d, 32) + rnd.randbytes(32)))             # key share
    suites = struct.pack("!H", 10) + struct.pack("!HHHHH", 0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f)
    body = b"\x03\x03" + rnd.randbytes(32) + b"\x20" + rnd.randbytes(32) + suites + b"\x01\x00" + struct.pack("!H", len(exts)) + exts
    hs = b"\x01" + struct.pack("!I", len(body))[1:] + body
    return b"\x16\x03\x01" + struct.pack("!H", len(hs)) + hs


def server_hello(session_id):
    exts = ext(43, b"\x03\x04") + ext(51, struct.pack("!HH", 0x001d, 32) + rnd.randbytes(32))
    body = b"\x03\x03" + rnd.randbytes(32) + b"\x20" + session_id + struct.pack("!H", 0x1301) + b"\x00" + struct.pack("!H", len(exts)) + exts
    hs = b"\x02" + struct.pack("!I", len(body))[1:] + body
    return b"\x16\x03\x03" + struct.pack("!H", len(hs)) + hs


def app_data(n):
    return b"\x17\x03\x03" + struct.pack("!H", n) + rnd.randbytes(n)


def tls():
    cap = Capture()
    cap.add(eth(GW.mac, PC.mac, 0x0800, ipv4(PC, GW.ip, 17, udp(PC.ip, 53188, GW.ip, 53, dns_query(0x1f3d, "portal.foct.test")))))
    cap.add(eth(PC.mac, GW.mac, 0x0800, ipv4(GW, PC.ip, 17, udp(GW.ip, 53, PC.ip, 53188,
            dns_answer(0x1f3d, "portal.foct.test", 1, [(1, 300, ip(SRV.ip))])))), 0.0019)
    c = Tcp(cap, PC, SRV, 50480, 443)
    c.open(0.0003)
    ch = client_hello("portal.foct.test")
    c.send(True, ch, dt=0.0002)
    c.ack(False, 0.0004)
    c.send(False, server_hello(ch[44:76]) + b"\x14\x03\x03\x00\x01\x01" + app_data(1180) + app_data(286) + app_data(53), dt=0.0011)
    c.ack(True)
    c.send(True, b"\x14\x03\x03\x00\x01\x01" + app_data(53), dt=0.0009)
    c.send(True, app_data(412), dt=0.0004)                   # the request: nobody on the network can read it
    c.ack(False, 0.0003)
    c.send(False, app_data(1350) + app_data(1120), dt=0.0031)
    c.ack(True)
    c.close(3.0)
    return cap


SAMPLES = [
    ("arp-ping.pcap", arp_ping, "ARP and ping on the lab network",
     "LAB-PC-37 finds the hardware address of LAB-PC-38 with ARP, pings it four times, then tries an address no PC has.",
     ["arp", "icmp", "icmp.type == 8", "eth.dst == ff:ff:ff:ff:ff:ff"],
     ["What MAC address does LAB-PC-38 have, and which company made its network card?",
      "How long did the first ping take to come back (look at the Time column)?",
      "Why does the PC send three ARP requests at the end, and why is there no ping after them?"]),
    ("dns-http.pcap", dns_http, "A web page: DNS, TCP and HTTP",
     "The PC looks up labs.foct.test, opens a TCP connection to port 80 and loads a page, its logo and a missing favicon.",
     ["dns", "tcp.flags.syn == 1", "http.request", "http.response.code == 404", "tcp.stream eq 0"],
     ["Which IP address did DNS give for labs.foct.test, and how long may the PC keep it (TTL)?",
      "Find the three packets of the TCP handshake. Which ports do the two sides use?",
      "Follow the HTTP stream: what status code came back for /favicon.ico?",
      "Use Statistics > HTTP objects to save the logo the page loaded."]),
    ("tcp-loss.pcap", tcp_loss, "TCP: a lost segment and its retransmission",
     "A download of results.csv loses one segment. The PC sends duplicate ACKs and the server sends the segment again.",
     ["tcp.analysis.flags", "tcp.analysis.duplicate_ack", "tcp.analysis.retransmission || tcp.analysis.fast_retransmission"],
     ["Which packet shows that a segment was not captured?", "How many duplicate ACKs did the PC send?",
      "What sequence number did the retransmitted segment carry?"]),
    ("dhcp.pcap", dhcp, "DHCP: a PC gets its address",
     "Discover, Offer, Request and Acknowledge, then the PC checks with ARP that nobody else uses its new address.",
     ["dhcp", "dhcp.option.dhcp == 5", "arp"],
     ["Which IP address, subnet mask, gateway and DNS server did the PC get?",
      "How long is the lease?", "Why are the DHCP messages sent to 255.255.255.255?"]),
    ("ftp-login.pcap", ftp_login, "FTP: a password in clear text",
     "A student logs in to an FTP server. FTP sends everything, the password included, as plain text.",
     ["ftp", "ftp.request.command == \"PASS\"", "tcp.port == 21"],
     ["Follow the TCP stream: what user name and password were sent?",
      "Why should a lab use SFTP or FTPS instead of FTP?"]),
    ("tls-handshake.pcap", tls, "HTTPS: what TLS keeps private",
     "The PC opens an HTTPS connection with TLS 1.3. The server name is visible in the Client Hello; the page itself is encrypted.",
     ["tls", "tls.handshake.type == 1", "tls.handshake.extensions_server_name"],
     ["Which server name (SNI) did the PC ask for?", "Which cipher suite did the server choose?",
      "Can you read the page or the request? Compare with the HTTP and FTP captures."]),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for name, make, title, desc, filters, questions in SAMPLES:
        n = make().write(name)
        index.append({"file": name, "title": title, "description": desc, "packets": n, "filters": filters, "questions": questions})
        print(f"  {name}: {n} packets")
    (OUT / "samples.json").write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
