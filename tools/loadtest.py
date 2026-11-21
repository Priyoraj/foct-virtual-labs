#!/usr/bin/env python3
"""Load test for a FoCT Virtual Labs server: many PCs at once.

    python tools/loadtest.py lab --pcs 500 --lab c            # 500 PCs open the C lab together, empty caches
    python tools/loadtest.py lab --pcs 500 --lab c --warm     # the same with the files already cached
    python tools/loadtest.py exam --pcs 500 --minutes 3       # an exam: 500 exam helpers checking in every 3 s,
                                                              # students polling every 8 s and sending work

"lab" can run on any PC (add --server http://<lab server>:8080) and then includes the network. "exam" runs on
the lab server PC only: it starts a test exam, gives every simulated PC its own loopback address
(127.0.x.y), ends the exam and deletes its test folder afterwards. It refuses to start while an exam runs.
Standard library only.
"""
import argparse
import asyncio
import json
import multiprocessing as mp
import os
import random
import shutil
import statistics
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MONACO = ["/vendor/monaco/vs/" + f for f in (
    "assets/editor.worker-_vAIFJDs.js", "basic-languages/monaco.contribution.js", "css.worker-BInK4lsP.js",
    "editor-BdtEMBbM.js", "editor/editor.main.css", "editor/editor.main.js", "editorWorkerHost-B_VpI68A.js",
    "html.worker-C1TNvQ72.js", "index-DZH_zysX.js", "json.worker-Bp7U0-9w.js", "loader.js",
    "monaco.contribution-BuX2NvO2.js", "monaco.contribution-C7tY_xnl.js", "monaco.contribution-CY2lwFI8.js",
    "monaco.contribution-D1-wBxcq.js", "nls.messages-loader.js", "toggleHighContrast-DuqAmExZ.js", "ts.worker-BLYAhMkX.js")]
COMMON = ["/assets/brand/adtu-seal.png", "/assets/brand/favicon-32.png", "/assets/css/foct.css", "/assets/js/exam.js",
          "/assets/js/foct.js"]
IDE = ["/apps/code/console.js", "/apps/code/hints.js", "/apps/code/ide.css", "/apps/code/ide.js", "/apps/code/langs.js",
       "/apps/code/lexyacc-examples.js", "/apps/code/runners/java-support.js", "/apps/code/runners/runners.js",
       "/apps/code/runners/stdin.js"]
# What a browser with an empty cache loads to open each lab (recorded in Edge, Nov 2026).
LABS = {
    "portal": ["/", "/assets/brand/adtu-logo.png"] + COMMON,
    "c": ["/apps/code/?lang=c"] + IDE + COMMON + MONACO + ["/vendor/monaco/vs/cpp-CkKPQIni.js",
          "/apps/code/runners/clang-support.js", "/apps/code/runners/clang-worker.js", "/apps/code/runners/lexyacc.js",
          "/apps/code/runners/wasi.js", "/runtimes/clang/bundle.js", "/runtimes/clang/llvm-resources.tar",
          "/runtimes/clang/llvm.core.wasm", "/runtimes/clang/llvm.core2.wasm", "/runtimes/clang/llvm.core3.wasm",
          "/runtimes/clang/llvm.core4.wasm"],
    "python": ["/apps/code/?lang=python"] + IDE + COMMON + MONACO + ["/vendor/monaco/vs/python-CasA8BlK.js",
               "/apps/code/runners/python-worker.js", "/runtimes/pyodide/pyodide-lock.json", "/runtimes/pyodide/pyodide.asm.mjs",
               "/runtimes/pyodide/pyodide.asm.wasm", "/runtimes/pyodide/pyodide.mjs", "/runtimes/pyodide/python_stdlib.zip",
               "/runtimes/pywheels/index.json"],
    "packets": ["/apps/packets/", "/apps/packets/app.js", "/apps/packets/packets.css", "/apps/packets/samples/samples.json",
                "/apps/packets/worker.js", "/assets/js/pcap.js", "/runtimes/wiregasm/module.js",
                "/runtimes/wiregasm/wiregasm.data", "/runtimes/wiregasm/wiregasm.mjs", "/runtimes/wiregasm/wiregasm.wasm"] + COMMON,
}


# ------------------------------------------------------------------ a small HTTP/1.1 client for asyncio
class Conn:
    def __init__(self, host, port, local=None):
        self.host, self.port, self.local = host, port, local
        self.r = self.w = None

    async def open(self):
        self.r, self.w = await asyncio.wait_for(asyncio.open_connection(
            self.host, self.port, local_addr=(self.local, 0) if self.local else None, limit=1 << 20), 30)

    def close(self):
        if self.w:
            self.w.close()
        self.r = self.w = None

    async def request(self, method, path, headers=None, body=b"", keep=False):
        """Returns (status, headers, body or its length)."""
        if not self.w:
            await self.open()
        h = {"Host": f"{self.host}:{self.port}", "Connection": "keep-alive", "Accept-Encoding": "gzip, br",
             "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Edg/142.0 FoCT-loadtest"}
        h.update(headers or {})
        if body or method == "POST":
            h["Content-Length"] = str(len(body))
        head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in h.items()) + "\r\n"
        self.w.write(head.encode("latin-1") + body)
        await self.w.drain()
        line = await self.r.readline()
        if not line:
            raise ConnectionError("closed by the server")
        status = int(line.split()[1])
        hdrs = {}
        while True:
            line = await self.r.readline()
            if line in (b"\r\n", b""):
                break
            k, _, v = line.decode("latin-1").partition(":")
            hdrs[k.strip().lower()] = v.strip()
        n = int(hdrs.get("content-length", 0))
        data, got = [], 0
        while got < n:
            chunk = await self.r.read(min(n - got, 1 << 20))
            if not chunk:
                raise ConnectionError("cut off")
            got += len(chunk)
            if keep:
                data.append(chunk)
        if hdrs.get("connection", "").lower() == "close":
            self.close()
        return status, hdrs, (b"".join(data) if keep else got)


def pct(values, p):
    if not values:
        return 0.0
    v = sorted(values)
    return v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]


# ------------------------------------------------------------------ "lab": PCs open a lab together
async def one_pc(host, port, urls, conns, etags, cookie, stats):
    queue = list(urls)
    t0 = time.perf_counter()

    async def worker():
        c = Conn(host, port)
        while queue:
            path = queue.pop(0)
            headers = {"Cookie": cookie} if cookie else {}
            if etags is not None and path in etags:
                headers["If-None-Match"] = etags[path]
            for attempt in (1, 2):
                try:
                    st, h, n = await c.request("GET", path, headers)
                    stats["status"][st] = stats["status"].get(st, 0) + 1
                    stats["bytes"] += n
                    break
                except (OSError, ConnectionError, asyncio.TimeoutError, ValueError, IndexError) as e:
                    c.close()
                    if attempt == 2:
                        stats["errors"].append(f"{path}: {type(e).__name__} {e}"[:120])
        c.close()
    await asyncio.gather(*(worker() for _ in range(conns)))
    stats["done"].append(time.perf_counter() - t0)


def lab_process(args, pcs, etags, cookie, out):
    async def main():
        stats = {"status": {}, "bytes": 0, "errors": [], "done": []}
        await asyncio.gather(*(one_pc(args.host, args.port, LABS[args.lab], args.conns, etags, cookie, stats) for _ in range(pcs)))
        return stats
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy() if pcs * args.conns < 500 else asyncio.WindowsProactorEventLoopPolicy())
    out.put(asyncio.run(main()))


def run_lab(args):
    cookie = ""
    try:      # the page sets the runtime cookie that cached files depend on
        with urllib.request.urlopen(args.server + "/", timeout=20) as r:
            for v in r.headers.get_all("Set-Cookie") or []:
                if v.startswith("foct_rt="):
                    cookie = v.split(";")[0]
    except OSError as e:
        sys.exit(f"cannot reach {args.server}: {e}")
    etags = None
    if args.warm:
        etags = {}
        for path in LABS[args.lab]:
            req = urllib.request.Request(args.server + path, method="HEAD", headers={"Accept-Encoding": "gzip, br", "Cookie": cookie})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    if r.headers.get("ETag"):
                        etags[path] = r.headers["ETag"]
            except OSError:
                pass
    procs = max(1, min(args.procs, args.pcs))
    share = [args.pcs // procs + (1 if i < args.pcs % procs else 0) for i in range(procs)]
    out = mp.Queue()
    print(f"{args.pcs} PCs open the {args.lab} lab together ({len(LABS[args.lab])} files each, {args.conns} connections per PC, "
          f"{'cached' if args.warm else 'empty caches'}) ...", flush=True)
    t0 = time.perf_counter()
    ps = [mp.Process(target=lab_process, args=(args, n, etags, cookie, out)) for n in share]
    for p in ps:
        p.start()
    results = [out.get() for _ in ps]
    for p in ps:
        p.join()
    wall = time.perf_counter() - t0
    done = [d for r in results for d in r["done"]]
    total = sum(r["bytes"] for r in results)
    status = {}
    for r in results:
        for k, v in r["status"].items():
            status[k] = status.get(k, 0) + v
    errors = [e for r in results for e in r["errors"]]
    print(f"  all {len(done)} PCs done in {wall:.1f} s; per PC: median {statistics.median(done):.1f} s, "
          f"95% {pct(done, 95):.1f} s, slowest {max(done):.1f} s")
    print(f"  {total / 1e9:.2f} GB sent, {total / wall / 1e6:.0f} MB/s; replies: " +
          ", ".join(f"{k} x{v}" for k, v in sorted(status.items())))
    print(f"  errors: {len(errors)}" + ("".join(f"\n    {e}" for e in errors[:8]) if errors else ""))
    if status.get(404):
        print("  (404s: the lab's file list in tools/loadtest.py is out of date for this version)")


# ------------------------------------------------------------------ "exam": exam helpers, students and the teacher
def admin(server, path, body=None, method="POST", raw=False):
    data = json.dumps(body or {}).encode() if method == "POST" else None
    req = urllib.request.Request(server + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "X-FoCT-Admin": "1"})
    with urllib.request.urlopen(req, timeout=300) as r:
        out = r.read()
    return out if raw else json.loads(out or b"{}")


async def exam_sim(args, exam_id, code):
    lat = {k: [] for k in ("hello", "beat", "register", "poll", "upload", "roster")}
    errs = {k: 0 for k in lat}
    stop = time.time() + args.minutes * 60
    src = "int main(void) {\n" + "    /* a student's program */\n" * 60 + "    return 0;\n}\n"

    async def call(kind, conn, method, path, headers=None, body=b""):
        t = time.perf_counter()
        try:
            st, h, data = await conn.request(method, path, headers, body, keep=True)
            lat[kind].append(time.perf_counter() - t)
            if st >= 400:
                errs[kind] += 1
                return None
            return json.loads(data or b"{}")
        except (OSError, ConnectionError, asyncio.TimeoutError, ValueError, IndexError):
            conn.close()
            errs[kind] += 1
            return None

    async def pc(k):
        ip = f"127.0.{1 + k // 250}.{2 + k % 250}"
        await asyncio.sleep(random.uniform(0, args.arrive))
        beat_c, page_c = Conn(args.host, args.port, ip), Conn(args.host, args.port, ip)
        hello = await call("hello", beat_c, "POST", "/__exam/agent/hello",
                           {"Content-Type": "application/json"}, json.dumps({"pc": f"LT-PC-{k:03d}", "user": "student", "version": "3"}).encode())
        if not hello or not hello.get("ok"):
            return
        status = {"ready": True, "browser": True, "taskmgr": True, "admin": False, "netoff": False, "screens": 1}
        beat_body = json.dumps({"token": hello["token"], "status": status}).encode()
        await call("beat", beat_c, "POST", "/__exam/agent/beat", {"Content-Type": "application/json"}, beat_body)

        async def beats():
            while time.time() < stop:
                await asyncio.sleep(3 + random.uniform(-.2, .2))
                await call("beat", beat_c, "POST", "/__exam/agent/beat", {"Content-Type": "application/json"}, beat_body)
        bt = asyncio.ensure_future(beats())
        reg = await call("register", page_c, "POST", "/__exam/register", {"Content-Type": "application/json"},
                         json.dumps({"exam": exam_id, "name": f"Load Test Student {k:03d}", "enrolment": f"LT/2026/{k:04d}",
                                     "code": code, "kiosk": hello["kiosk"]}).encode())
        if reg:
            tok = {"X-FoCT-Token": reg["token"], "X-FoCT-Kiosk": hello["kiosk"]}
            next_up = time.time() + random.uniform(5, 60)
            while time.time() < stop:
                await call("poll", page_c, "GET", "/__exam", tok)
                if time.time() >= next_up:
                    await call("upload", page_c, "POST", "/__exam/upload",
                               dict(tok, **{"X-FoCT-Path": "C/main.c", "Content-Type": "application/octet-stream"}),
                               (src + f"/* {time.time()} */\n").encode())
                    next_up += 60
                await asyncio.sleep(8 + random.uniform(-.5, .5))
        await bt
        beat_c.close()
        page_c.close()

    async def teacher():
        c = Conn(args.host, args.port)
        while time.time() < stop:
            await call("roster", c, "GET", "/__exam/roster", {"X-FoCT-Admin": "1"})
            await asyncio.sleep(3)
        c.close()

    await asyncio.gather(teacher(), *(pc(k) for k in range(args.pcs)))
    return lat, errs


def run_exam(args):
    if args.host not in ("localhost", "127.0.0.1"):
        sys.exit("exam: run this on the lab server PC itself (--server http://localhost:8080)")
    state = admin(args.server, "/__exam", method="GET")
    if state.get("on"):
        sys.exit("An exam is running on this server; the load test only runs when exam mode is off.")
    st = admin(args.server, "/__exam", {"on": True, "title": "Load test", "register": True, "code": True,
                                        "opts": {"helper": True, "helper_internet": False}})
    roster = admin(args.server, "/__exam/roster", method="GET")
    exam_id, code, folder = st["id"], roster["exam"]["code"], roster["exam"]["folder"]
    print(f"Test exam started ({args.pcs} PCs with exam helpers, {args.minutes} min; folder \"{folder}\") ...", flush=True)
    try:
        if sys.platform == "win32":
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        lat, errs = asyncio.run(exam_sim(args, exam_id, code))
        signed = len(admin(args.server, "/__exam/roster", method="GET")["students"])
        t = time.perf_counter()
        z = admin(args.server, "/__exam/zip", method="GET", raw=True)
        zt = time.perf_counter() - t
    finally:
        admin(args.server, "/__exam", {"on": False})
        target = ROOT / "submissions" / folder
        if folder and folder.startswith("Load test") and target.is_dir() and not args.keep:
            shutil.rmtree(target, ignore_errors=True)
    print(f"  signed in: {signed} of {args.pcs}")
    print(f"  {'request':10} {'count':>7} {'errors':>7} {'median':>9} {'95%':>9} {'99%':>9} {'slowest':>9}")
    for k, v in lat.items():
        if v or errs[k]:
            print(f"  {k:10} {len(v):7d} {errs[k]:7d} {statistics.median(v) * 1000:7.1f}ms {pct(v, 95) * 1000:7.1f}ms "
                  f"{pct(v, 99) * 1000:7.1f}ms {max(v) * 1000:7.1f}ms")
    print(f"  submissions zip: {len(z) / 1e6:.1f} MB in {zt:.1f} s")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("lab", help="PCs open a lab together")
    a.add_argument("--lab", choices=sorted(LABS), default="c")
    a.add_argument("--warm", action="store_true", help="files already in the browsers' caches")
    a.add_argument("--conns", type=int, default=6, help="connections per PC (browsers use 6)")
    a.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 2) // 2), help="client processes")
    e = sub.add_parser("exam", help="an exam with exam helpers (on the server PC only)")
    e.add_argument("--minutes", type=float, default=3)
    e.add_argument("--arrive", type=float, default=30, help="students arrive over this many seconds")
    e.add_argument("--keep", action="store_true", help="keep the test exam's folder")
    for p in (a, e):
        p.add_argument("--pcs", type=int, default=90)
        p.add_argument("--server", default="http://localhost:8080")
    args = ap.parse_args()
    u = urllib.parse.urlsplit(args.server)
    args.server = f"{u.scheme}://{u.netloc}"
    args.host, args.port = u.hostname, u.port or 80
    run_lab(args) if args.cmd == "lab" else run_exam(args)


if __name__ == "__main__":
    main()
