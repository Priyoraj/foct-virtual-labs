#!/usr/bin/env python3
"""
FoCT Virtual Labs - one-time setup.

Downloads the third-party runtimes (Python, C/C++, Java compilers, draw.io,
office suite, editor) and unpacks them into ./web so the lab can run with no
internet access afterwards.

    python tools/setup.py            # everything
    python tools/setup.py --only clang,teavm
    python tools/setup.py --list

Needs internet once (about 860 MB of downloads). Re-running is safe: finished
components are skipped, and downloads are cached in ./.downloads.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CACHE = ROOT / ".downloads"
BUILD = ROOT / ".build"

PYODIDE_VERSION = "314.0.6"          # must match jupyterlite-pyodide-kernel
JUPYTERLITE_VERSION = "0.8.7"
CLANG_VERSION = "22.0.0-git20542-10"
CLANG_PATCH = "fastwrite1+eh34"
WASI_SDK = "34"
MONACO_VERSION = "0.57.0"
DRAWIO_VERSION = "32.7.4"
TEAVM_BASE = "https://teavm.org/playground/3/"
OFFICE_ZIP = "https://codeload.github.com/ranuts/document/zip/refs/heads/gh-pages"
SQLJS_VERSION = "1.16.0"
PGLITE_VERSION = "0.5.16"
NGSPICE_ENGINE_VERSION = "1.9.0"      # eecircuit-engine (ngspice compiled to WebAssembly)
UPLOT_VERSION = "1.6.32"
CIRCUITJS_VERSION = "5.0.5ts"
MINGO_VERSION = "7.2.7"
ACORN_VERSION = "8.19.0"
VIZ_VERSION = "3.31.0"
# lex and yacc for the Lex & Yacc lab: their C sources, compiled in each browser on first use.
# flex 2.5.4a is the last flex that does not run m4 as a separate program (a browser cannot start
# programs); Berkeley yacc (byacc) is POSIX yacc. Archives are pinned by SHA-256.
FLEX_ARCHIVE = ("https://snapshot.debian.org/archive/debian/20100101T000000Z/pool/main/f/flex-old/flex-old_2.5.4a.orig.tar.gz",
                "flex-2.5.4a.tar.gz", "791e8e26d35faed05654b17fe3a9e64eea0874d623c5aaaaf532e164378e8407")
BYACC_VERSION = "20260126"
BYACC_ARCHIVE = (f"https://invisible-island.net/archives/byacc/byacc-{BYACC_VERSION}.tgz",
                 f"byacc-{BYACC_VERSION}.tgz", "b618c5fb44c2f5f048843db90f7d1b24f78f47b07913c8c7ba8c942d3eb24b00")

UA = "FoCT-Virtual-Labs-setup/1.0"


# ----------------------------------------------------------------- helpers
def log(msg):
    print(msg, flush=True)


def download(url, name=None):
    """Download url into the cache (resumable) and return the local path."""
    CACHE.mkdir(parents=True, exist_ok=True)
    name = name or url.rstrip("/").split("/")[-1]
    dest = CACHE / name
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if have:
        req.add_header("Range", f"bytes={have}-")
    log(f"  downloading {name} ...")
    with urllib.request.urlopen(req, timeout=60) as r:
        mode = "ab" if have and r.status == 206 else "wb"
        total = r.headers.get("Content-Length")
        total = int(total) + (have if mode == "ab" else 0) if total else None
        done = have if mode == "ab" else 0
        last = time.time()
        with open(part, mode) as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if time.time() - last > 2:
                    last = time.time()
                    pct = f"{done * 100 // total}%" if total else f"{done >> 20} MB"
                    log(f"    {name}: {pct}")
    part.replace(dest)
    log(f"  saved {name} ({dest.stat().st_size >> 20} MB)")
    return dest


def fresh_dir(path):
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def marker(path, version):
    return path / ".foct-version", version


def is_done(path, version):
    m = path / ".foct-version"
    return m.exists() and m.read_text().strip() == version


def mark_done(path, version):
    (path / ".foct-version").write_text(version)


def safe_extract_tar(tf, dest, strip=None, only=None):
    dest = dest.resolve()
    for m in tf.getmembers():
        name = m.name
        if strip:
            if not name.startswith(strip):
                continue
            name = name[len(strip):]
        if not name or (only and not any(name.startswith(o) for o in only)):
            continue
        target = (dest / name).resolve()
        if not str(target).startswith(str(dest)):
            raise RuntimeError(f"unsafe path in archive: {m.name}")
        if m.isdir():
            target.mkdir(parents=True, exist_ok=True)
        elif m.isfile():
            target.parent.mkdir(parents=True, exist_ok=True)
            with tf.extractfile(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)


def safe_extract_zip(zf, dest, strip="", skip=()):
    dest = dest.resolve()
    for info in zf.infolist():
        name = info.filename
        if not name.startswith(strip):
            continue
        name = name[len(strip):]
        if not name or any(name.startswith(s) for s in skip):
            continue
        target = (dest / name).resolve()
        if not str(target).startswith(str(dest)):
            raise RuntimeError(f"unsafe path in archive: {info.filename}")
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)


# -------------------------------------------------------------- components
def setup_pyodide():
    dest = WEB / "runtimes" / "pyodide"
    if is_done(dest, PYODIDE_VERSION):
        return log("  already installed")
    arc = download(f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/"
                   f"pyodide-{PYODIDE_VERSION}.tar.bz2")
    fresh_dir(dest)
    log("  unpacking (takes a minute) ...")
    with tarfile.open(arc, "r:bz2") as tf:
        safe_extract_tar(tf, dest, strip="pyodide/")
    mark_done(dest, PYODIDE_VERSION)


def setup_clang():
    dest = WEB / "runtimes" / "clang"
    if is_done(dest, CLANG_VERSION + CLANG_PATCH):
        return log("  already installed")
    arc = download(f"https://registry.npmjs.org/@yowasp/clang/-/clang-{CLANG_VERSION}.tgz",
                   f"yowasp-clang-{CLANG_VERSION}.tgz")
    fresh_dir(dest)
    with tarfile.open(arc, "r:gz") as tf:
        safe_extract_tar(tf, dest, strip="package/gen/")
        safe_extract_tar(tf, dest, strip="package/", only=["README.md", "package.json"])
    # The virtual file system copies the whole file on every write (quadratic); writing a
    # precompiled C++ header took ~30 s. Grow the buffer geometrically instead.
    bundle = dest / "bundle.js"
    s = bundle.read_text(encoding="utf-8")
    old = """  write(contents) {
    const offset = Number(this.offset);
    const newData = new Uint8Array(Math.max(this.file.data.length, offset + contents.length));
    newData.set(this.file.data);
    newData.subarray(offset).set(contents);
    this.file.data = newData;
    this.offset += BigInt(contents.length);
  }"""
    new = """  write(contents) {
    const offset = Number(this.offset);
    const file = this.file;
    const size = Math.max(file.data.length, offset + contents.length);
    let buf = file._foctBuf;
    if (!buf || buf.buffer !== file.data.buffer || buf.length < size) {
      const grown = new Uint8Array(Math.max(size, 65536, buf && buf.buffer === file.data.buffer ? buf.length * 2 : file.data.length * 2));
      grown.set(file.data);
      buf = grown;
    }
    buf.set(contents, offset);
    file._foctBuf = buf;
    file.data = buf.subarray(0, size);
    this.offset += BigInt(contents.length);
  }"""
    if old in s:
        bundle.write_text(s.replace(old, new), encoding="utf-8")
    else:
        log("  note: clang bundle layout changed; write-speed patch not applied")
    # C++ exceptions: the libc++/libc++abi/libunwind that wasi-sdk builds with WebAssembly
    # exception handling (used with -fwasm-exceptions; the default sysroot has them disabled).
    sysroot = download(f"https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-{WASI_SDK}/"
                       f"wasi-sysroot-{WASI_SDK}.0.tar.gz", f"wasi-sysroot-{WASI_SDK}.0.tar.gz")
    (dest / "eh").mkdir(exist_ok=True)
    prefix = f"wasi-sysroot-{WASI_SDK}.0/lib/wasm32-wasip1/eh/"
    with tarfile.open(sysroot, "r:gz") as tf:
        for m in tf.getmembers():
            if m.isfile() and m.name.startswith(prefix) and m.name.endswith(".a") and "llvm-lto" not in m.name:
                (dest / "eh" / m.name[len(prefix):]).write_bytes(tf.extractfile(m).read())
    mark_done(dest, CLANG_VERSION + CLANG_PATCH)


def setup_monaco():
    dest = WEB / "vendor" / "monaco"
    if is_done(dest, MONACO_VERSION):
        return log("  already installed")
    arc = download(f"https://registry.npmjs.org/monaco-editor/-/monaco-editor-{MONACO_VERSION}.tgz")
    fresh_dir(dest)
    with tarfile.open(arc, "r:gz") as tf:
        safe_extract_tar(tf, dest, strip="package/min/")
        safe_extract_tar(tf, dest, strip="package/", only=["LICENSE", "ThirdPartyNotices.txt"])
    mark_done(dest, MONACO_VERSION)


def setup_teavm():
    dest = WEB / "runtimes" / "teavm"
    version = "playground-3+renames"
    if is_done(dest, version):
        return log("  already installed")
    fresh_dir(dest)
    for f in ["compiler.wasm", "compiler.wasm-runtime.js", "compiler.wasm-deobfuscator.wasm",
              "compile-classlib-teavm.bin", "runtime-classlib-teavm.bin"]:
        src = download(TEAVM_BASE + f, "teavm-" + f)
        shutil.copy2(src, dest / f)
    # Make Throwable.getMessage(), Object.getClass()/wait()/notify() ... visible to javac.
    sys.path.insert(0, str(ROOT / "tools"))
    import javasdk
    n = javasdk.fix_archive(dest / "compile-classlib-teavm.bin")
    log(f"  repaired {n} library classes for javac")
    mark_done(dest, version)


JAVABOX_BASE = "https://javabox-demo.brian-fec.workers.dev/"
JAVABOX_FILES = {  # build tested with FoCT Virtual Labs (Nov 2026)
    "javabox-direct.mjs": "f8043bfdd5b6be95a2dd71394ea10d3a036b4c98456fa138abd44dfa25ba4b7c",
    "javabox-direct.wasm": "a6adde60e065bd9f82632556c5450fc1f39c1fd6e585fcb5e9fca8ba825c9236",
    "javabox-direct.data": "837c057b64e361f482d9bdc05961be23d1dc5afd77578c9d0bae4aed34ee9831",
}


def setup_javabox():
    """Full OpenJDK 21 in WebAssembly (JavaBox, MIT). Used for Java in secure (HTTPS) mode."""
    dest = WEB / "runtimes" / "javabox"   # also holds our host.html, host.js, FoctServer.java
    version = "javabox-" + JAVABOX_FILES["javabox-direct.data"][:12]
    if is_done(dest, version):
        return log("  already installed")
    for name, sha in JAVABOX_FILES.items():
        src = download(JAVABOX_BASE + name, "javabox-" + name)
        got = hashlib.sha256(src.read_bytes()).hexdigest()
        if got != sha:
            log(f"  WARNING: {name} differs from the tested build (the upstream demo was updated).")
        shutil.copy2(src, dest / name)
    lic = download("https://raw.githubusercontent.com/bmarti44/javabox/main/LICENSE", "javabox-LICENSE")
    shutil.copy2(lic, dest / "LICENSE")
    mark_done(dest, version)


def npm_tarball(name, version):
    base = name.split("/")[-1]
    return download(f"https://registry.npmjs.org/{name}/-/{base}-{version}.tgz", f"npm-{base}-{version}.tgz")


def setup_sql():
    """SQLite (sql.js) and PostgreSQL (PGlite) for the SQL lab."""
    dest = WEB / "runtimes" / "sql"
    version = f"sqljs-{SQLJS_VERSION}+pglite-{PGLITE_VERSION}"
    if is_done(dest, version):
        return log("  already installed")
    fresh_dir(dest)
    with tarfile.open(npm_tarball("sql.js", SQLJS_VERSION), "r:gz") as tf:
        safe_extract_tar(tf, dest / "sqljs", strip="package/dist/", only=["sql-wasm.js", "sql-wasm.wasm"])
        safe_extract_tar(tf, dest / "sqljs", strip="package/", only=["LICENSE"])
    with tarfile.open(npm_tarball("@electric-sql/pglite", PGLITE_VERSION), "r:gz") as tf:
        keep = []
        for m in tf.getmembers():
            n = m.name[len("package/dist/"):] if m.name.startswith("package/dist/") else None
            # the browser ESM build: index.js + its chunks, the wasm and the data file
            if n and "/" not in n and (n.endswith(".js") or n in ("pglite.wasm", "pglite.data", "initdb.wasm")):
                keep.append(n)
        safe_extract_tar(tf, dest / "pglite", strip="package/dist/", only=keep)
        safe_extract_tar(tf, dest / "pglite", strip="package/", only=["LICENSE"])
    for m in (dest / "pglite").glob("*.map"):
        m.unlink()
    mark_done(dest, version)


def setup_spice():
    """ngspice compiled to WebAssembly (eecircuit-engine) and uPlot for waveforms."""
    dest = WEB / "runtimes" / "spice"
    version = f"eecircuit-{NGSPICE_ENGINE_VERSION}+uplot-{UPLOT_VERSION}"
    if is_done(dest, version):
        return log("  already installed")
    fresh_dir(dest)
    with tarfile.open(npm_tarball("eecircuit-engine", NGSPICE_ENGINE_VERSION), "r:gz") as tf:
        safe_extract_tar(tf, dest, strip="package/dist/", only=["eecircuit-engine.mjs"])
        safe_extract_tar(tf, dest, strip="package/", only=["LICENSE", "README.md"])
    with tarfile.open(npm_tarball("uplot", UPLOT_VERSION), "r:gz") as tf:
        safe_extract_tar(tf, dest / "uplot", strip="package/dist/", only=["uPlot.esm.js", "uPlot.min.css"])
        safe_extract_tar(tf, dest / "uplot", strip="package/", only=["LICENSE"])
    mark_done(dest, version)


def setup_mongo():
    """MongoDB lab: mingo (MongoDB query language in JavaScript) and acorn (JavaScript parser)."""
    dest = WEB / "runtimes" / "mongo"
    version = f"mingo-{MINGO_VERSION}+acorn-{ACORN_VERSION}"
    if is_done(dest, version):
        return log("  already installed")
    fresh_dir(dest)
    with tarfile.open(npm_tarball("mingo", MINGO_VERSION), "r:gz") as tf:
        safe_extract_tar(tf, dest, strip="package/dist/", only=["mingo.min.js"])
        safe_extract_tar(tf, dest / "mingo", strip="package/", only=["LICENSE"])
    with tarfile.open(npm_tarball("acorn", ACORN_VERSION), "r:gz") as tf:
        safe_extract_tar(tf, dest, strip="package/dist/", only=["acorn.js"])
        safe_extract_tar(tf, dest / "acorn", strip="package/", only=["LICENSE"])
    mark_done(dest, version)


FLEX_SOURCES = ["ccl.c", "dfa.c", "ecs.c", "gen.c", "main.c", "misc.c", "nfa.c", "parse.c", "scan.c",
                "skel.c", "sym.c", "tblcmp.c", "yylex.c"]
BYACC_SOURCES = ["closure.c", "error.c", "graph.c", "lalr.c", "lr0.c", "main.c", "mkpar.c", "mstring.c",
                 "output.c", "reader.c", "symtab.c", "verbose.c", "warshall.c", "yaccpar.c"]
FLEX_CONFIG_H = """/* config.h for flex 2.5.4a, written by FoCT Virtual Labs tools/setup.py */
#define STDC_HEADERS 1
#define HAVE_STRING_H 1
#define HAVE_SYS_TYPES_H 1
"""
BYACC_CONFIG_H = """/* config.h for byacc, written by FoCT Virtual Labs tools/setup.py */
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_UNISTD_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_VSNPRINTF 1
#define STDC_HEADERS 1
#define MIXEDCASE_FILENAMES 1
#define MAXTABLE 32500
#define SYSTEM_NAME "wasm32-wasi"
#define GCC_NORETURN __attribute__((noreturn))
#define GCC_UNUSED __attribute__((unused))
#define GCC_PRINTFLIKE(fmt, var) __attribute__((format(printf, fmt, var)))
#define GCC_SCANFLIKE(fmt, var) __attribute__((format(scanf, fmt, var)))
#define GCC_PRINTF 1
#define GCC_SCANF 1
"""
# WebAssembly has no tmpfile(): byacc's scratch files go to /tmp, and each name is removed at
# once so the file disappears when byacc closes it.
BYACC_COMPAT_H = """/* WASI support for byacc, FoCT Virtual Labs */
#include <stdio.h>
FILE *foct_tmpfile(void);
#define tmpfile foct_tmpfile
"""
BYACC_COMPAT_C = """#include <errno.h>
#include <stdio.h>
#include <sys/stat.h>
FILE *foct_tmpfile(void)
{
    static unsigned n = 0;
    char name[64];
    int tries;
    mkdir("/tmp", 0777);
    for (tries = 0; tries < 1000; tries++) {
        FILE *f;
        snprintf(name, sizeof name, "/tmp/yacc%u.tmp", n++);
        f = fopen(name, "wx+");
        if (f) { remove(name); return f; }
        if (errno != EEXIST) return NULL;
    }
    return NULL;
}
"""


def setup_lexyacc():
    """lex (flex 2.5.4a) and yacc (byacc) sources, built into WebAssembly by each browser on first use."""
    dest = WEB / "runtimes" / "lexyacc"
    version = f"flex-2.5.4a+byacc-{BYACC_VERSION}+cfg1"
    if is_done(dest, version):
        return log("  already installed")
    archives = []
    for url, name, digest in (FLEX_ARCHIVE, BYACC_ARCHIVE):
        path = download(url, name)
        got = hashlib.sha256(path.read_bytes()).hexdigest()
        if got != digest:
            path.unlink()
            raise RuntimeError(f"{name}: checksum mismatch (expected {digest}, got {got}); run setup again")
        archives.append(path)
    fresh_dir(dest)
    with tarfile.open(archives[0], "r:gz") as tf:
        safe_extract_tar(tf, dest / "flex", strip="flex-2.5.4/",
                         only=[f for f in FLEX_SOURCES if f not in ("parse.c", "scan.c")] + ["flexdef.h", "version.h", "parse.y", "initscan.c", "COPYING"])
    with tarfile.open(archives[1], "r:gz") as tf:
        safe_extract_tar(tf, dest / "byacc", strip=f"byacc-{BYACC_VERSION}/", only=BYACC_SOURCES + ["defs.h", "LICENSE"])
    (dest / "flex" / "config.h").write_text(FLEX_CONFIG_H, encoding="utf-8")
    (dest / "byacc" / "config.h").write_text(BYACC_CONFIG_H, encoding="utf-8")
    (dest / "byacc" / "foct_compat.h").write_text(BYACC_COMPAT_H, encoding="utf-8")
    (dest / "byacc" / "foct_compat.c").write_text(BYACC_COMPAT_C, encoding="utf-8")
    manifest = {
        "version": version,
        "flex": {"files": sorted(p.name for p in (dest / "flex").iterdir()), "sources": FLEX_SOURCES},
        "byacc": {"files": sorted(p.name for p in (dest / "byacc").iterdir()), "sources": BYACC_SOURCES + ["foct_compat.c"]},
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    mark_done(dest, version)


def setup_viz():
    """Graphviz compiled to WebAssembly (viz.js, MIT) for the automata and tree diagrams."""
    dest = WEB / "runtimes" / "viz"
    if is_done(dest, VIZ_VERSION):
        return log("  already installed")
    fresh_dir(dest)
    with tarfile.open(npm_tarball("@viz-js/viz", VIZ_VERSION), "r:gz") as tf:
        safe_extract_tar(tf, dest, strip="package/dist/", only=["viz.js"])
        safe_extract_tar(tf, dest, strip="package/", only=["README.md"])
    mark_done(dest, VIZ_VERSION)


CIRCUIT_SW_KILL = """// FoCT Virtual Labs: CircuitJS is served by the lab server, so its offline service worker is
// not used. Its original worker deleted every Cache Storage entry of the site (including
// JupyterLite's), so this replacement removes its own cache and unregisters itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("circuitjs-cache")) await caches.delete(key);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
})()));
"""


def patch_circuit(dest):
    """No service worker (see CIRCUIT_SW_KILL) and no Dropbox import (the lab may be offline)."""
    for js in (dest / "circuitjs116").glob("circuitjs-*.js"):
        s = js.read_text(encoding="utf-8")
        if "registerServiceWorker" not in s:
            continue
        s, n1 = re.subn(r"`serviceWorker`in navigator&&location\.protocol===`file:`", "false", s)
        s, n2 = re.subn(r"else if\(`serviceWorker`in navigator\)\{let registerServiceWorker",
                        "else if(false){let registerServiceWorker", s)
        s, n3 = re.subn(r"s\.addMenuItem\(this\.importFromDropboxItem,iconHtml\([^)]*\),`file`,`importfromdropbox`\)",
                        "void 0", s)
        if (n1, n2) != (1, 1):
            raise RuntimeError(f"CircuitJS changed: could not disable its service worker in {js.name}")
        if n3 != 1:
            log("  note: Dropbox menu item not found (CircuitJS changed?)")
        js.write_text(s, encoding="utf-8")
    (dest / "service-worker.js").write_text(CIRCUIT_SW_KILL, encoding="utf-8")


def setup_circuit():
    """Falstad CircuitJS (GPL-2.0): the web app inside the offline desktop build."""
    dest = WEB / "apps" / "circuit"
    if is_done(dest, CIRCUITJS_VERSION + "+nosw1"):
        return log("  already installed")
    arc = download(f"https://www.falstad.com/circuit/offline/circuitjs1-{CIRCUITJS_VERSION}-linux64.tgz",
                   f"circuitjs1-{CIRCUITJS_VERSION}-linux64.tgz")
    fresh_dir(dest)
    prefix = "circuitjs1/resources/app/war/"
    with tarfile.open(arc, "r:gz") as tf:
        for m in tf.getmembers():
            if not m.isfile() or not m.name.startswith(prefix):
                continue
            rel = m.name[len(prefix):]
            if any(p.startswith("._") for p in rel.split("/")):
                continue   # macOS metadata files
            out = dest / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(tf.extractfile(m).read())
    # Our entry page: same app without the Dropbox script and web manifest (offline lab).
    page = (dest / "circuitjs.html").read_text(encoding="utf-8")
    page = re.sub(r'\s*<link rel="manifest"[^>]*>', "", page)
    page = re.sub(r'\s*<!--[^>]*dropbox[^>]*-->', "", page, flags=re.I)
    page = re.sub(r'\s*<script[^>]*dropbox[^>]*></script>', "", page, flags=re.I)
    page = page.replace("<title>CircuitJS</title>",
                        "<title>Circuit Simulator · FoCT Virtual Labs</title>\n"
                        '  <link rel="icon" type="image/png" href="/assets/brand/favicon-32.png">')
    (dest / "index.html").write_text(page, encoding="utf-8")
    patch_circuit(dest)
    mark_done(dest, CIRCUITJS_VERSION + "+nosw1")


def setup_drawio():
    dest = WEB / "apps" / "drawio"
    if is_done(dest, DRAWIO_VERSION):
        return log("  already installed")
    arc = download(f"https://github.com/jgraph/drawio/releases/download/v{DRAWIO_VERSION}/draw.war",
                   f"drawio-v{DRAWIO_VERSION}.war")
    fresh_dir(dest)
    with zipfile.ZipFile(arc) as zf:
        safe_extract_zip(zf, dest, skip=("WEB-INF/", "META-INF/"))
    # Run fully offline: no Google/OneDrive/plugins, save to this computer.
    pre = dest / "js" / "PreConfig.js"
    pre.write_text(
        "/* FoCT Virtual Labs: self-hosted, offline draw.io. Diagrams are saved to\n"
        "   the student's own computer; nothing is sent to any cloud service. */\n"
        "window.DRAWIO_PUBLIC_BUILD = true;\n"
        "window.EXPORT_URL = null;\n"
        "window.DRAWIO_BASE_URL = new URL('.', window.location.href).href.replace(/\\/$/, '');\n"
        "window.DRAWIO_VIEWER_URL = null;\n"
        "window.DRAWIO_LIGHTBOX_URL = null;\n"
        "window.DRAW_MATH_URL = 'math4/es5';\n"
        "window.DRAWIO_CONFIG = null;\n"
        "urlParams['sync'] = 'manual';\n"
        "urlParams['offline'] = '1';\n"
        "urlParams['stealth'] = '1';\n"
        "urlParams['gapi'] = '0'; urlParams['db'] = '0'; urlParams['od'] = '0';\n"
        "urlParams['gh'] = '0'; urlParams['gl'] = '0'; urlParams['tr'] = '0';\n"
        "urlParams['mode'] = urlParams['mode'] || 'device';\n", encoding="utf-8")
    mark_done(dest, DRAWIO_VERSION)


OFFICE_FONTS = {
    # MS font file name in AllFonts.js -> open-licence, metric-compatible replacement
    "arial.ttf": "LiberationSans-Regular.ttf", "arialbd.ttf": "LiberationSans-Bold.ttf",
    "ariali.ttf": "LiberationSans-Italic.ttf", "arialbi.ttf": "LiberationSans-BoldItalic.ttf",
    "times.ttf": "LiberationSerif-Regular.ttf", "timesbd.ttf": "LiberationSerif-Bold.ttf",
    "timesi.ttf": "LiberationSerif-Italic.ttf", "timesbi.ttf": "LiberationSerif-BoldItalic.ttf",
    "cour.ttf": "LiberationMono-Regular.ttf", "courbd.ttf": "LiberationMono-Bold.ttf",
    "couri.ttf": "LiberationMono-Italic.ttf", "courbi.ttf": "LiberationMono-BoldItalic.ttf",
    "calibri.ttf": "Carlito-Regular.ttf", "calibrib.ttf": "Carlito-Bold.ttf",
    "calibrii.ttf": "Carlito-Italic.ttf", "calibriz.ttf": "Carlito-BoldItalic.ttf",
    "cambria.ttc": "Caladea-Regular.ttf", "cambriab.ttf": "Caladea-Bold.ttf",
    "cambriai.ttf": "Caladea-Italic.ttf", "cambriaz.ttf": "Caladea-BoldItalic.ttf",
}


def office_fonts():
    """Fetch SIL-OFL fonts that stand in for Arial, Times, Courier, Calibri, Cambria."""
    out = {}
    arc = download("https://github.com/liberationfonts/liberation-fonts/files/7261482/"
                   "liberation-fonts-ttf-2.1.5.tar.gz", "liberation-fonts-ttf-2.1.5.tar.gz")
    with tarfile.open(arc, "r:gz") as tf:
        for m in tf.getmembers():
            base = m.name.split("/")[-1]
            if base.endswith(".ttf") and base.startswith("Liberation"):
                out[base] = tf.extractfile(m).read()
    for fam in ("Carlito", "Caladea"):
        for style in ("Regular", "Bold", "Italic", "BoldItalic"):
            f = f"{fam}-{style}.ttf"
            p = download(f"https://raw.githubusercontent.com/google/fonts/main/ofl/{fam.lower()}/{f}", f)
            out[f] = p.read_bytes()
    return out


def patch_office(dest):
    """English UI, FoCT branding, and new documents created from plain English templates."""
    def sub(path, pairs, required=True):
        s = path.read_text(encoding="utf-8")
        for old, new in pairs:
            if old not in s:
                if required:
                    raise RuntimeError(f"office patch: pattern not found in {path.name}: {old[:60]}")
                continue
            s = s.replace(old, new)
        path.write_text(s, encoding="utf-8")

    # 1. The editors were built with Chinese as the default language and its strings bundled in.
    #    An empty translation table keeps the English text that is built into the code.
    #    The official English table of the same release (7.4.1) is merged over it at start-up.
    for app in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
        main = dest / "web-apps" / "apps" / app / "main"
        en = download(f"https://raw.githubusercontent.com/ONLYOFFICE/web-apps/v7.4.1.36/apps/{app}/main/locale/en.json",
                      f"onlyoffice-7.4.1-{app}-en.json")
        table = json.loads(en.read_text(encoding="utf-8"))
        (main / "locale-en.js").write_text("window.FOCT_L10N=" + json.dumps(table, ensure_ascii=False) + ";\n",
                                           encoding="utf-8")
        sub(main / "app.js", [
            ('defLang="zh"', 'defLang="en"'),
            ("if(t&&(loadcallback=t),e){for(var i in l10n=e)",
             "if(t&&(loadcallback=t),e){e=Object.assign({},e,window.FOCT_L10N||{});for(var i in l10n=e)"),
        ])
        sub(main / "index.html", [("</head>", '<script src="locale-en.js"></script>\n</head>')])
        # Firefox has no window.chrome: a check for the "360" browser crashed the editors there.
        sub(main / "app.js", [("(chrome.account360?", "(window.chrome&&chrome.account360?")], required=False)
        # This build reports every opened document to 360's server (the editor, file type, load times,
        # memory use and a random browser ID kept in localStorage; not the contents or file names).
        # Students' documents must not be reported anywhere: the beacon is switched off, and the two
        # values it needs no longer break the page (no crypto.subtle on plain-HTTP pages, no
        # performance.memory in Firefox).
        sub(main / "app.js", [
            ('basePath:"https://dd.browser.360.cn/static/a/"', 'basePath:""'),
            ('e=this.basePath+t+"?"+jQuery.param(i);(new Image).src=e}', 'e=this.basePath+t+"?"+jQuery.param(i);void e}'),
            ('t=await crypto.subtle.digest("SHA-1",t)', 't=crypto.subtle?await crypto.subtle.digest("SHA-1",t):t'),
            ("performance.memory.usedJSHeapSize", "(performance.memory||{usedJSHeapSize:0}).usedJSHeapSize"),
        ], required=False)
    sub(dest / "web-apps" / "apps" / "presentationeditor" / "main" / "app.reporter.js",
        [(";chrome.runtime&&chrome.runtime.onMessage?", ";window.chrome&&chrome.runtime&&chrome.runtime.onMessage?")],
        required=False)
    # Fonts missing locally (DengXian, Symbol, Wingdings: not redistributable) were fetched from
    # 360's server, and the extension build loads SmartArt from there too: both now stay on the lab
    # server. The font loader tells its second try by the address, so the second address must be
    # recognisable; it does not exist, and after three tries the editor uses a substitute font, as
    # it always did on an offline lab network.
    for js in (dest / "sdkjs").rglob("sdk-all*.js"):
        sub(js, [('"https://bangong.360.cn/office/fonts/"', '"/apps/office/fonts-fallback/"'),
                 ('.includes("bangong.360.cn")', '.includes("/fonts-fallback/")'),
                 ('"https://bangong.360.cn/office/SmartArts/"', '"/apps/office/sdkjs/common/SmartArts/"')], required=False)
    for js in (dest / "sdkjs").glob("*/sdk-all.js"):
        s = js.read_text(encoding="utf-8")
        # The editors measure each character with the browser's canvas at a 3686.4 px font size.
        # Firefox measures canvas text at no more than 2000 px, so there every word came out about
        # half as wide and text was drawn squeezed together. Measuring at half the size and
        # doubling gives exactly the same numbers in Edge and Chrome, and the right ones in Firefox.
        s, n = re.subn(r"\$\{3686\.4\}px(.{0,600}?)Math\.round\(10\*", r"${1843.2}px\1Math.round(20*", s, flags=re.S)
        # This build turns the theme font Calibri into 等线 (DengXian, the Chinese Office default)
        # and gives its built-in heading styles 等线 too. Windows outside China has no DengXian, so
        # new spreadsheets and slides showed SimSun. Calibri now stays Calibri.
        deng = s.count('"\\u7b49\\u7ebf')
        s = s.replace('"\\u7b49\\u7ebf Light"', '"Calibri Light"').replace('"\\u7b49\\u7ebf"', '"Calibri"')
        js.write_text(s, encoding="utf-8")
        log(f"  {js.parent.name}: text measuring fixed for Firefox in {n} places, {deng} DengXian defaults made Calibri")
    seal = ('t.innerHTML=\'<img src="/assets/brand/adtu-seal.png" alt="FoCT Virtual Labs" '
            'style="width:34px;height:34px;border-radius:50%;background:#fff">\','
            't.style.background="none",t.style.cursor="pointer",t.title="Back to FoCT Virtual Labs",'
            't.onclick=()=>{location.href="/"},i.appendChild(t)')
    for js in (dest / "assets").glob("index-*.js"):
        sub(js, [
            ("lang:window.navigator.language", 'lang:"en"'),
            ('t.textContent="W",i.appendChild(t)', seal),
            ('r.textContent="Web Office"', 'r.textContent="FoCT Office"'),
            ('o.textContent="Upload Document to view"', 'o.textContent="Open a file"'),
            ('n.textContent="New Word"', 'n.textContent="New document"'),
            ('s.textContent="New Excel"', 's.textContent="New spreadsheet"'),
            ('l.textContent="New PowerPoint"', 'l.textContent="New presentation"'),
            ("`文件保存成功：${i}`", "`Saved ${i} on this computer`"),
            ("`文档操作失败：${e.message}`", "`Could not open the document: ${e.message}`"),
            ('"文档操作失败："', '"Could not open the document: "'),
            ('"无效的文件对象"', '"Invalid file"'),
            ('"无法加载编辑器组件。请确保已正确安装 OnlyOffice API。"',
             '"The office editor could not be loaded. Please refresh the page."'),
            ('"文档加载完成："', '"Document loaded: "'),
            # 2. New files: open our blank templates (Calibri; A4 documents, 16:9 slides) instead of the built-in Chinese ones.
            ("if(e){const n=Z2[`.${r}`];if(!n)throw new Error(`不支持的文件类型：${r}`);o={bin:n}}",
             'if(e){const n=await(await fetch("/apps/office/templates/blank."+r)).blob();o=await K2(new File([n],i))}'),
        ])
    sub(dest / "index.html", [("<title></title>", "<title>FoCT Office</title>")], required=False)
    (dest / "templates").mkdir(exist_ok=True)
    for f in (ROOT / "tools" / "office").glob("blank.*"):
        shutil.copy2(f, dest / "templates" / f.name)


def setup_office():
    dest = WEB / "apps" / "office"
    version = "ranuts-document-gh-pages-2025-10-23+openfonts+en3+ff2+notrack2+calibri+a4"
    if is_done(dest, version):
        return log("  already installed")
    arc = download(OFFICE_ZIP, "ranuts-document-gh-pages.zip")
    fresh_dir(dest)
    with zipfile.ZipFile(arc) as zf:
        safe_extract_zip(zf, dest, strip="document-gh-pages/", skip=("fonts/",))
    # The build expects to live at /document/ - move it to /apps/office/.
    for p in [dest / "index.html", *(dest / "assets").glob("index-*.js")]:
        s = p.read_text(encoding="utf-8")
        p.write_text(s.replace("/document/", "/apps/office/"), encoding="utf-8")
    patch_office(dest)
    # Replace bundled Microsoft fonts with open, metric-compatible ones.
    allfonts = (dest / "sdkjs" / "common" / "AllFonts.js").read_text(encoding="utf-8")
    files = re.search(r"__fonts_files=\[(.*?)\]", allfonts, re.S).group(1)
    files = [f.strip().strip('"').split("\\")[-1].lower() for f in files.split('",')]
    fonts = office_fonts()
    (dest / "fonts").mkdir(exist_ok=True)
    placed = 0
    for idx, fname in enumerate(files):
        repl = OFFICE_FONTS.get(fname)
        if repl and repl in fonts:
            (dest / "fonts" / f"{idx:03d}").write_bytes(fonts[repl])
            placed += 1
    for f in ("symbol.ttf",):
        pass  # symbol/wingdings are not redistributable; editors fall back gracefully
    log(f"  placed {placed} open fonts")
    mark_done(dest, version)


# Pure-Python packages that Pyodide does not ship but labs often use. They are stored on the
# lab server and installed on demand (Python IDE: on import; notebooks: %pip install ...).
#   import name: (PyPI project, [PyPI dependencies to bundle], [Pyodide packages it needs])
PY_EXTRAS = {
    "seaborn": ("seaborn", [], ["numpy", "pandas", "matplotlib"]),
    "openpyxl": ("openpyxl", ["et_xmlfile"], []),
    "plotly": ("plotly", [], ["narwhals", "packaging"]),
    "tabulate": ("tabulate", [], []),
    "xlsxwriter": ("XlsxWriter", [], []),
    "prettytable": ("prettytable", [], ["wcwidth"]),
    "ipywidgets": ("ipywidgets", ["comm", "widgetsnbextension", "jupyterlab_widgets"], ["traitlets", "ipython"]),
}


def pypi_wheel(project):
    """Download the newest pure-Python wheel of a PyPI project into the cache."""
    req = urllib.request.Request(f"https://pypi.org/pypi/{project}/json", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        meta = json.load(r)
    for u in meta["urls"]:
        if u["packagetype"] == "bdist_wheel" and u["filename"].endswith("-none-any.whl") and "py3" in u["filename"]:
            return download(u["url"], u["filename"])
    raise RuntimeError(f"no pure-Python wheel for {project}")


def setup_pywheels():
    dest = WEB / "runtimes" / "pywheels"
    version = "1:" + ",".join(sorted(PY_EXTRAS))
    if is_done(dest, version):
        return log("  already installed")
    fresh_dir(dest)
    index = {}
    for name, (project, deps, pyo) in PY_EXTRAS.items():
        wheels = []
        for proj in [project, *deps]:
            w = pypi_wheel(proj)
            shutil.copy2(w, dest / w.name)
            wheels.append(w.name)
        index[name] = {"name": project, "wheels": wheels, "pyodide": pyo}
    (dest / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    mark_done(dest, version)


def setup_jupyterlite():
    dest = WEB / "apps" / "notebook"
    src = ROOT / "tools" / "jupyterlite"
    stamp = hashlib.sha1()
    for p in sorted(src.rglob("*")):
        if p.is_file():
            stamp.update(p.name.encode())
            stamp.update(p.read_bytes())
    version = f"{JUPYTERLITE_VERSION}-{stamp.hexdigest()[:10]}"
    if is_done(dest, version):
        return log("  already built")
    venv = BUILD / "jlvenv"
    py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not py.exists():
        log("  creating build environment ...")
        subprocess.check_call([sys.executable, "-m", "venv", str(venv)])
    subprocess.check_call([str(py), "-m", "pip", "install", "-q", "--disable-pip-version-check",
                           f"jupyterlite-core=={JUPYTERLITE_VERSION}",
                           f"jupyterlite-pyodide-kernel=={JUPYTERLITE_VERSION}",
                           "jupyterlab-widgets", "jupyter-server"])
    work = fresh_dir(BUILD / "jupyterlite")
    shutil.copytree(src, work, dirs_exist_ok=True)
    # Offline %pip install: wheels in pypi/ are indexed by the build (piplite).
    wheels = WEB / "runtimes" / "pywheels"
    if wheels.is_dir():
        (work / "pypi").mkdir(exist_ok=True)
        for w in wheels.glob("*.whl"):
            shutil.copy2(w, work / "pypi" / w.name)
    if dest.exists():
        shutil.rmtree(dest)
    env = dict(os.environ, PYTHONUTF8="1")
    subprocess.check_call([str(py), "-m", "jupyter", "lite", "build",
                           "--output-dir", str(dest)], cwd=work, env=env)
    mark_done(dest, version)


COMPRESSIBLE = {".js", ".mjs", ".css", ".html", ".json", ".wasm", ".svg", ".tar", ".txt",
                ".map", ".xml", ".bin", ".data", ".ttf", ".otf", ".py", ".md", ".ipynb"}


def precompress():
    """Write .gz next to big text/wasm files so the server can send them compressed."""
    n = saved = 0
    for p in WEB.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in COMPRESSIBLE:
            if not (p.is_file() and p.parent.name == "fonts" and p.suffix == ""):
                continue
        if p.stat().st_size < 4096:
            continue
        gz = p.with_name(p.name + ".gz")
        if gz.exists() and gz.stat().st_mtime >= p.stat().st_mtime:
            continue
        data = p.read_bytes()
        comp = gzip.compress(data, compresslevel=9 if len(data) < (8 << 20) else 6, mtime=0)
        if len(comp) < len(data) * 0.9:
            gz.write_bytes(comp)
            n += 1
            saved += len(data) - len(comp)
        elif gz.exists():
            gz.unlink()
    log(f"  compressed {n} files, saving {saved >> 20} MB per full download")


STEPS = {
    "monaco": ("Code editor (Monaco)", setup_monaco),
    "clang": ("C / C++ compiler (Clang -> WebAssembly)", setup_clang),
    "teavm": ("Java, basic mode (javac + TeaVM -> WebAssembly)", setup_teavm),
    "javabox": ("Java, full OpenJDK 21 for secure mode (JavaBox)", setup_javabox),
    "pyodide": ("Python (Pyodide, with scientific packages)", setup_pyodide),
    "pywheels": ("Extra pure-Python packages (seaborn, openpyxl, plotly ...)", setup_pywheels),
    "jupyterlite": ("Jupyter notebooks (JupyterLite)", setup_jupyterlite),
    "sql": ("SQL lab engines (SQLite, PostgreSQL)", setup_sql),
    "mongo": ("MongoDB lab engine (mingo)", setup_mongo),
    "lexyacc": ("lex and yacc sources for the Lex & Yacc lab", setup_lexyacc),
    "viz": ("Graphviz for diagrams in the compiler design tools", setup_viz),
    "spice": ("SPICE circuit simulator (ngspice)", setup_spice),
    "circuit": ("Circuit simulator (Falstad CircuitJS)", setup_circuit),
    "drawio": ("Diagrams (draw.io)", setup_drawio),
    "office": ("Office suite (OnlyOffice in the browser)", setup_office),
    "compress": ("Pre-compress files for faster loading", precompress),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated steps: " + ",".join(STEPS))
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()
    if args.list:
        for k, (desc, _) in STEPS.items():
            print(f"  {k:12} {desc}")
        return
    steps = args.only.split(",") if args.only else list(STEPS)
    for k in steps:
        if k not in STEPS:
            sys.exit(f"unknown step {k!r}; choose from {', '.join(STEPS)}")
    for k in steps:
        desc, fn = STEPS[k]
        log(f"[{k}] {desc}")
        fn()
    log("Setup complete. Start the lab server with start-server.bat (Windows) or ./start-server.sh")


if __name__ == "__main__":
    main()
