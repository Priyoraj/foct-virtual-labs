#!/usr/bin/env python3
"""
FoCT Virtual Labs - LAN web server.

Serves the ./web folder to every PC on the lab network. All compiling and
running happens inside each student's browser, so the server only sends
files: it never receives, runs or stores student work.

    python server/serve.py                 # http://<this-pc>:8080
    python server/serve.py --port 80
    python server/serve.py --https         # also https://<this-pc>:8443 (see README)

Only the Python 3.8+ standard library is needed.
"""
import argparse
import datetime
import email.utils
import hashlib
import http.server
import json
import os
import posixpath
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from pathlib import Path

VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WEB = ROOT / "web"
CERT_DIR = Path(__file__).resolve().parent / "certs"

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp",
    ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
    ".zip": "application/zip", ".whl": "application/zip", ".tar": "application/x-tar",
    ".gz": "application/gzip", ".bin": "application/octet-stream", ".data": "application/octet-stream",
    ".pdf": "application/pdf", ".ipynb": "application/json; charset=utf-8",
    ".py": "text/x-python; charset=utf-8", ".c": "text/plain; charset=utf-8",
    ".cpp": "text/plain; charset=utf-8", ".h": "text/plain; charset=utf-8",
    ".java": "text/plain; charset=utf-8", ".crt": "application/x-x509-ca-cert",
    ".cer": "application/x-x509-ca-cert", ".webmanifest": "application/manifest+json",
    ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".csv": "text/csv; charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# Apps that load third-party pages/frames and must not be cross-origin isolated.
NOT_ISOLATED = ("/apps/drawio/", "/apps/office/")

# Third-party folders installed by tools/setup.py. Each has a .foct-version marker, and their
# files only change when setup installs a new version, so browsers may keep them (see send_file).
MANAGED = ("/runtimes/", "/vendor/", "/apps/notebook/", "/apps/office/", "/apps/drawio/", "/apps/circuit/")
# FoCT's own files inside those folders: edited by hand, so always revalidated.
OWN_IN_MANAGED = ("/runtimes/javabox/host.html", "/runtimes/javabox/host.js", "/runtimes/javabox/FoctServer.java")
RT_COOKIE = "foct_rt"
RT_MAX_AGE = 30 * 24 * 3600


class RuntimeGeneration:
    """A short hash of every .foct-version marker; it changes whenever tools/setup.py installs or
    updates a third-party component. Re-read at most every 5 seconds."""

    def __init__(self):
        self.lock = threading.Lock()
        self.root, self.checked, self.value = None, -1e9, ""

    def get(self, root):
        now = time.monotonic()
        if root != self.root or now - self.checked > 5:
            with self.lock:
                if root != self.root or now - self.checked > 5:
                    h = hashlib.sha1()
                    for m in sorted(root.glob("*/*/.foct-version")):
                        try:
                            h.update(m.relative_to(root).as_posix().encode() + b"\0" + m.read_bytes() + b"\0")
                        except OSError:
                            pass
                    self.root, self.checked, self.value = root, now, h.hexdigest()[:12]
        return self.value


GENERATION = RuntimeGeneration()


# ---------------------------------------------------------------- exam mode
# Every page the server sends gets web/assets/js/exam.js. It polls /__exam; while exam mode is
# on, the page blocks copy and paste and shows an exam watermark. Exam mode is switched on the
# server PC at /__exam/control and survives a server restart (server/exam-state.json).
EXAM_FILE = Path(__file__).resolve().parent / "exam-state.json"
EXAM_CONTROL = Path(__file__).resolve().parent / "exam-control.html"
EXAM_TAG = b'<script src="/assets/js/exam.js"></script>'
EXAM_TAG_VERSION = "x1"   # change with EXAM_TAG so browsers replace pages they cached with the old tag
HEAD_RE = re.compile(rb"<head(?:\s[^>]*)?>", re.I)
HTML_RE = re.compile(rb"<html(?:\s[^>]*)?>", re.I)
DOCTYPE_RE = re.compile(rb"\s*<!doctype[^>]*>", re.I)


def add_exam_tag(page):
    """Put the exam script first in <head>, so it is in place before the page's own scripts."""
    m = HEAD_RE.search(page, 0, 65536) or HTML_RE.search(page, 0, 65536) or DOCTYPE_RE.match(page)
    at = m.end() if m else 0
    return page[:at] + EXAM_TAG + page[at:]


class ExamMode:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.state = {"on": False, "title": "", "since": None}
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.state.update(on=bool(saved.get("on")), title=str(saved.get("title") or "")[:120],
                              since=saved.get("since"))
        except (OSError, ValueError, AttributeError):
            pass

    def get(self):
        with self.lock:
            return dict(self.state)

    def set(self, on, title):
        with self.lock:
            if on != self.state["on"]:
                self.state["since"] = time.time() if on else None
            self.state["on"], self.state["title"] = on, title[:120]
            try:
                self.path.write_text(json.dumps(self.state), encoding="utf-8")
            except OSError:
                pass
            return dict(self.state)


EXAM = ExamMode(EXAM_FILE)


class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.started = time.time()
        self.requests = 0
        self.bytes = 0
        self.clients = {}

    def add(self, ip, nbytes):
        with self.lock:
            self.requests += 1
            self.bytes += nbytes
            self.clients[ip] = time.time()

    def snapshot(self):
        with self.lock:
            now = time.time()
            active = sum(1 for t in self.clients.values() if now - t < 300)
            return {"requests": self.requests, "mb_sent": round(self.bytes / 1e6, 1),
                    "active_pcs_5min": active, "pcs_seen": len(self.clients),
                    "uptime_min": round((now - self.started) / 60, 1)}


STATS = Stats()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FoCT-Virtual-Labs/" + VERSION
    sys_version = ""
    timeout = 120
    web_root = DEFAULT_WEB
    verbose = False
    info = {}

    # ------------------------------------------------------------ routing
    def do_GET(self):
        self.handle_request(head=False)

    def do_HEAD(self):
        self.handle_request(head=True)

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path == "/__exam":
            return self.exam_post()
        self.deny()

    def deny(self):
        self.close_connection = True   # the request body is not read
        self.send_simple(405, "This server does not accept uploads. Your files stay on your computer.")

    do_PUT = do_DELETE = do_PATCH = deny

    def handle_request(self, head):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if path == "/__status":
            body = json.dumps(dict(self.info, **STATS.snapshot(), version=VERSION,
                                   secure=isinstance(self.connection, ssl.SSLSocket)), indent=1)
            return self.send_simple(200, body, "application/json; charset=utf-8", head=head)
        if path == "/__exam":
            body = json.dumps(dict(EXAM.get(), client=self.client_address[0], now=time.time()))
            return self.send_simple(200, body, "application/json; charset=utf-8", head=head)
        if path == "/__exam/control":
            if not self.is_local():
                return self.send_simple(403, "Exam mode can only be switched on the server PC.", head=head, page=True)
            try:
                page = EXAM_CONTROL.read_text(encoding="utf-8")
            except OSError:
                return self.send_simple(404, "Not found", head=head, page=True)
            return self.send_simple(200, page, "text/html; charset=utf-8", head=head)
        target = self.resolve(path)
        if target is None:
            return self.send_simple(404, "Not found", head=head, page=True)
        if target.is_dir():
            if not path.endswith("/"):
                loc = path + "/" + (("?" + url.query) if url.query else "")
                self.send_response(301)
                self.send_header("Location", urllib.parse.quote(loc, safe="/?=&%:"))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            target = target / "index.html"
            if not target.is_file():
                return self.send_simple(404, "Not found", head=head, page=True)
        self.send_file(target, path, head)

    def resolve(self, path):
        norm = posixpath.normpath(path)
        parts = [p for p in norm.split("/") if p and p not in (".", "..")]
        if any(p.startswith(".") and p not in (".well-known",) for p in parts):
            return None  # hide .foct-version, .git and friends
        target = self.web_root.joinpath(*parts)
        try:
            target.resolve().relative_to(self.web_root.resolve())
        except ValueError:
            return None
        return target if target.exists() else None

    # ------------------------------------------------------------ sending
    def common_headers(self, path):
        self.send_header("X-Content-Type-Options", "nosniff")
        if not path.startswith(NOT_ISOLATED):
            # Lets the IDEs use SharedArrayBuffer (interactive input) when served over HTTPS.
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

    def send_file(self, target, path, head):
        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        encoding, send_path, page = None, target, None
        accept = self.headers.get("Accept-Encoding", "")
        try:
            st = target.stat()
            if ctype.startswith("text/html") and self.wants_page():
                page = add_exam_tag(target.read_bytes())   # small, sent uncompressed
            else:
                for enc, ext in (("br", ".br"), ("gzip", ".gz")):
                    if enc in accept:
                        cand = target.with_name(target.name + ext)
                        if cand.is_file() and cand.stat().st_mtime >= st.st_mtime - 1:
                            encoding, send_path = enc, cand
                            break
            size = len(page) if page is not None else send_path.stat().st_size
        except OSError:
            return self.send_simple(404, "Not found", head=head, page=True)

        variant = EXAM_TAG_VERSION if page is not None else (encoding or "id")
        etag = f'W/"{int(st.st_mtime)}-{st.st_size}-{variant}"'
        last_mod = email.utils.formatdate(st.st_mtime, usegmt=True)
        caching = self.caching_headers(path, ctype)
        if self.not_modified(etag, st.st_mtime):
            self.send_response(304)
            self.send_header("ETag", etag)
            for name, value in caching:
                self.send_header(name, value)
            self.common_headers(path)
            self.send_header("Content-Length", "0")
            self.end_headers()
            STATS.add(self.client_address[0], 0)
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Last-Modified", last_mod)
        self.send_header("ETag", etag)
        if encoding:
            self.send_header("Content-Encoding", encoding)
        for name, value in caching:
            self.send_header(name, value)
        if target.suffix.lower() in (".crt", ".cer"):
            self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
        self.common_headers(path)
        self.end_headers()
        sent = 0
        if not head and page is not None:
            try:
                self.wfile.write(page)
                sent = len(page)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, socket.timeout):
                self.close_connection = True
        elif not head:
            try:
                with open(send_path, "rb") as f:
                    while True:
                        chunk = f.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        sent += len(chunk)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, socket.timeout):
                self.close_connection = True
        STATS.add(self.client_address[0], sent)

    def caching_headers(self, path, ctype):
        """Pages and FoCT's own files are revalidated on every visit (a cheap 304), so edits show
        at once. Third-party runtime files are kept by the browser for 30 days without asking,
        which spares the server thousands of requests when a whole lab opens Jupyter at once.
        They are tied to the runtime generation: every page sets it as a cookie, and the files
        are cached with "Vary: Cookie". After setup installs a new version the cookie changes,
        the cached copies stop matching, and browsers fetch the new files, never a mix."""
        gen = GENERATION.get(self.web_root)
        if ctype.startswith("text/html"):
            return [("Cache-Control", "no-cache"), ("Vary", "Accept-Encoding, Sec-Fetch-Dest"),
                    ("Set-Cookie", f"{RT_COOKIE}={gen}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly")]
        if path.startswith(MANAGED) and path not in OWN_IN_MANAGED:
            # Without the current cookie (first visit, cookies blocked) fall back to revalidating.
            keep = self.cookie(RT_COOKIE) == gen
            return [("Cache-Control", f"max-age={RT_MAX_AGE}" if keep else "no-cache"),
                    ("Vary", "Accept-Encoding, Cookie")]
        return [("Cache-Control", "no-cache"), ("Vary", "Accept-Encoding")]

    def wants_page(self):
        """True when the browser is opening the HTML as a page or frame (not reading it as data)."""
        dest = self.headers.get("Sec-Fetch-Dest")
        if dest:
            return dest in ("document", "iframe", "frame", "embed", "object")
        return "text/html" in self.headers.get("Accept", "")

    def is_local(self):
        """The request comes from the server PC itself."""
        ip = self.client_address[0]
        return ip.startswith("127.") or ip == "::1" or ip in (self.info.get("lan_ips") or [])

    def exam_post(self):
        # Only the server PC may switch exam mode. The custom header stops other web pages
        # (cross-site requests) from doing it through the administrator's browser.
        if (not self.is_local() or self.headers.get("X-FoCT-Admin") != "1"
                or self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")):
            self.close_connection = True
            return self.send_simple(403, "Exam mode can only be switched on the server PC.")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if not 0 < n <= 4096:
                raise ValueError
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict) or "on" not in data:
                raise ValueError
            state = EXAM.set(bool(data["on"]), str(data.get("title") or "").strip())
        except (ValueError, TypeError):
            self.close_connection = True
            return self.send_simple(400, "Send JSON like {\"on\": true, \"title\": \"...\"}.")
        title = f": {state['title']}" if state["on"] and state["title"] else ""
        print(f"{time.strftime('%H:%M')}  EXAM MODE {'ON' if state['on'] else 'OFF'}{title}", flush=True)
        self.send_simple(200, json.dumps(state), "application/json; charset=utf-8")

    def cookie(self, name):
        for part in self.headers.get("Cookie", "").split(";"):
            key, _, value = part.strip().partition("=")
            if key == name:
                return value
        return None

    def not_modified(self, etag, mtime):
        inm = self.headers.get("If-None-Match")
        if inm:
            return etag in [t.strip() for t in inm.split(",")] or inm.strip() == "*"
        ims = self.headers.get("If-Modified-Since")
        if ims:
            try:
                since = email.utils.parsedate_to_datetime(ims)
                if since.tzinfo is None:
                    since = since.replace(tzinfo=datetime.timezone.utc)
                return int(mtime) <= since.timestamp()
            except (TypeError, ValueError, IndexError, OverflowError):
                return False
        return False

    def send_simple(self, code, text, ctype="text/plain; charset=utf-8", head=False, page=False):
        if page:
            ctype = "text/html; charset=utf-8"
            text = ("<!doctype html><meta charset=utf-8><title>%d</title>"
                    "<body style='font:16px system-ui;margin:3rem;color:#352f6e'>"
                    "<h1>%d &middot; %s</h1><p><a href='/'>Back to FoCT Virtual Labs</a></p>"
                    % (code, code, text))
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.common_headers(urllib.parse.urlsplit(self.path).path)
        self.end_headers()
        if not head:
            self.wfile.write(body)
        STATS.add(self.client_address[0], len(body))

    # ------------------------------------------------------------ logging
    def log_request(self, code="-", size="-"):
        try:
            code = int(code)
        except (TypeError, ValueError):
            code = 0
        if self.verbose or code >= 400:
            super().log_request(code, size)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s  %s\n" % (time.strftime("%H:%M:%S"), self.client_address[0], fmt % args))


class LabServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 256
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError,
                            socket.timeout, ssl.SSLError, TimeoutError)):
            return  # a browser tab was closed mid-download; nothing to report
        super().handle_error(request, client_address)


class TLSLabServer(LabServer):
    """HTTPS variant: the TLS handshake runs in the per-connection thread."""

    def __init__(self, addr, handler, ctx):
        super().__init__(addr, handler)
        self.ctx = ctx

    def finish_request(self, request, client_address):
        request.settimeout(30)
        try:
            tls = self.ctx.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return  # e.g. a PC that has not trusted the lab certificate yet
        try:
            self.RequestHandlerClass(tls, client_address, self)
        finally:
            try:
                tls.close()
            except OSError:
                pass


def lan_addresses():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; picks the LAN interface
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.") and not ip.startswith("169.254.")]


def start(server, name):
    t = threading.Thread(target=server.serve_forever, name=name, daemon=True)
    t.start()
    return t


def main():
    ap = argparse.ArgumentParser(description="FoCT Virtual Labs LAN server")
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on (default: all)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("FOCT_PORT", 8080)))
    ap.add_argument("--https", action="store_true", help="also serve HTTPS (creates a lab certificate)")
    ap.add_argument("--https-port", type=int, default=int(os.environ.get("FOCT_HTTPS_PORT", 8443)))
    ap.add_argument("--cert", help="use your own certificate (PEM) instead of the lab one")
    ap.add_argument("--key", help="private key (PEM) for --cert")
    ap.add_argument("--root", default=str(DEFAULT_WEB), help="folder to serve")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args()

    web_root = Path(args.root).resolve()
    if not (web_root / "index.html").is_file():
        sys.exit(f"Cannot find {web_root / 'index.html'}")
    missing = [n for n in ("runtimes/pyodide", "runtimes/clang", "vendor/monaco")
               if not (web_root / n).is_dir()]
    if missing:
        print("WARNING: some runtimes are missing (%s).\n"
              "         Run  python tools/setup.py  once, with internet, to install them.\n" % ", ".join(missing))

    Handler.web_root = web_root
    Handler.verbose = args.verbose
    host = socket.gethostname()
    ips = lan_addresses()
    Handler.info = {"hostname": host, "http_port": args.port,
                    "https_port": args.https_port if args.https else None, "lan_ips": ips}

    try:
        http_srv = LabServer((args.host, args.port), Handler)
    except OSError as e:
        sys.exit(f"Cannot listen on port {args.port}: {e}\nTry another port:  python server/serve.py --port 8090")
    start(http_srv, "http")

    https_srv = None
    if args.https:
        cert, key = args.cert, args.key
        if not cert:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import make_cert
            cert, key = make_cert.ensure(ips, host)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        try:
            https_srv = TLSLabServer((args.host, args.https_port), Handler, ctx)
        except OSError as e:
            sys.exit(f"Cannot listen on port {args.https_port}: {e}")
        start(https_srv, "https")

    line = "=" * 64
    print(line)
    print(" FoCT Virtual Labs  -  Faculty of Computer Technology, ADtU")
    print(line)
    print(f" On this computer :  http://localhost:{args.port}/")
    for ip in ips:
        print(f" On the lab LAN   :  http://{ip}:{args.port}/")
    print(f" By name          :  http://{host}:{args.port}/")
    if https_srv:
        for ip in ips or ["localhost"]:
            print(f" Secure (HTTPS)   :  https://{ip}:{args.https_port}/")
        print("   (each PC must trust the lab certificate once - see Help > Secure mode)")
    print(f" Exam mode        :  http://localhost:{args.port}/__exam/control  (on this PC only)")
    print(line)
    print(" Students only need a browser (Chrome / Edge / Firefox). Their files are")
    print(" saved on their own PC; nothing is uploaded here. Press Ctrl+C to stop.")
    print(line, flush=True)
    exam = EXAM.get()
    if exam["on"]:
        print(f" EXAM MODE IS ON{': ' + exam['title'] if exam['title'] else ''}  (end it on the page above)", flush=True)

    last = None
    try:
        while True:
            time.sleep(60)
            s = STATS.snapshot()
            if s["requests"] != last:
                last = s["requests"]
                print(f"{time.strftime('%H:%M')}  active PCs (5 min): {s['active_pcs_5min']:3d}   "
                      f"requests: {s['requests']}   sent: {s['mb_sent']} MB", flush=True)
    except KeyboardInterrupt:
        print("\nStopping ...")
        http_srv.shutdown()
        if https_srv:
            https_srv.shutdown()


if __name__ == "__main__":
    main()
