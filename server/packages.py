"""Extra Python packages for the labs, added on the lab server while it runs (/__packages on the server PC).

The teacher types a package name (the one used with pip install) and the server downloads it from PyPI with the
packages it needs; with no internet on the server PC, .whl files from a pen drive do the same. From then on the labs
install it by themselves when a student's code imports it: the Python IDE reads web/runtimes/pywheels/index.json,
Jupyter reads that list and its pip index (apps/notebook/pypi/all.json, which also makes %pip install work offline).
Pages that are already open pick it up at the next run or cell, also during an exam: no reload, no setup run, and
no internet on the students' PCs.

Only pure-Python packages can be added. Packages with compiled code run in a browser only when Pyodide includes
them (numpy, pandas, scipy, scikit-learn, matplotlib, opencv and about 350 more); those are already in the lab and
are used as they are, also as dependencies.

Several lab servers share their packages: each one lists the others, and every minute (at once when another server
says something changed) it copies the packages they added or removed. The newest change to a package wins.

Files: packages/registry.json and packages/wheels/*.whl next to the web folder. setup.py rebuilds the folders the
labs read, so the server brings them back in step when it starts and every minute (reconcile).
"""
import hashlib
import io
import json
import os
import re
import shutil
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from email.parser import HeaderParser
from pathlib import Path

try:                        # pip's copy of "packaging": requirement markers and version ranges, as pip reads them
    from pip._vendor.packaging.requirements import Requirement, InvalidRequirement
    from pip._vendor.packaging.specifiers import SpecifierSet, InvalidSpecifier
    from pip._vendor.packaging.version import Version, InvalidVersion
except Exception:  # noqa: BLE001 - a Python without pip: the simpler reading below
    Requirement = None

UA = "FoCT-Virtual-Labs-server"
INDEX = "https://pypi.org/simple/"          # PyPI's index for installers (JSON, PEP 691)
WHEEL_MAX = 60 << 20                        # one wheel
ADD_MAX = 250 << 20                         # one package with everything it brings
SYNC_EVERY = 60                             # seconds between looks at the other servers
PING_GAP = 3                                # ... and at least this many when they say something changed
WHEEL_RE = re.compile(r"^(?P<name>[A-Za-z0-9_.]+)-(?P<ver>[A-Za-z0-9_.!+]+)(?:-\d[A-Za-z0-9_.]*)?"
                      r"-(?P<py>[A-Za-z0-9_.]+)-(?P<abi>[A-Za-z0-9_.]+)-(?P<plat>[A-Za-z0-9_.]+)\.whl$")
IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?")      # a package name (PEP 508)
VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.!+_-]{0,58}")
PIP_RE = re.compile(r"^\s*[!%]?\s*(?:pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip)\s+install\b", re.I)
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # other lab servers: never through a proxy


def canon(name):
    return re.sub(r"[-_.]+", "-", str(name or "")).lower().strip()


def is_pure(filename):
    """A wheel that runs anywhere, the browser too: pure Python, for Python 3."""
    m = WHEEL_RE.match(filename)
    return bool(m and m["abi"] == "none" and m["plat"] == "any" and any(t.startswith("py3") for t in m["py"].split(".")))


def ipv4(url):
    """The address with its PC name resolved to IPv4. Lab servers listen on IPv4 only, and on Windows a PC name or
    "localhost" is tried over IPv6 first, which costs about two seconds per connection before it falls back."""
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if re.fullmatch(r"[\d.]+", host):
        return url
    try:
        ip = socket.getaddrinfo(host, parts.port or 80, socket.AF_INET, socket.SOCK_STREAM)[0][4][0]
    except (OSError, IndexError):
        return url
    return urllib.parse.urlunsplit(parts._replace(netloc=f"{ip}:{parts.port}" if parts.port else ip))


def parse_request(text):
    """'faker pyjokes', 'pip install faker>=30', 'faker, art' -> ['faker', 'pyjokes'] ..."""
    out = []
    for tok in re.split(r"\s+|,(?=\s*[A-Za-z])", PIP_RE.sub("", str(text or "")).strip()):
        if not tok or tok.startswith("-"):
            continue
        if out and (re.match(r"[<>=!~;(\[,]", tok) or re.search(r"[<>=!~,;]$", out[-1])):
            out[-1] += tok                                  # "faker >= 30" typed with spaces
        else:
            out.append(tok)
    return out[:10]


class Problem(Exception):
    """Something to tell the teacher, in plain words."""


class Req:
    """One requirement: name, extras, version range and marker."""

    def __init__(self, text):
        text = str(text).strip()
        if Requirement:
            try:
                r = Requirement(text)
            except InvalidRequirement:
                raise Problem(f"{text!r} is not a package name pip would accept.") from None
            self.name, self.extras, self.spec, self.marker = r.name, set(r.extras), r.specifier, r.marker
        else:
            m = re.fullmatch(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*\(?([^;)]*)\)?\s*(?:;(.*))?", text)
            if not m:
                raise Problem(f"{text!r} is not a package name pip would accept.")
            self.name = m[1]
            self.extras = {e.strip() for e in (m[2] or "").split(",") if e.strip()}
            self.spec, self.marker = m[3].strip(), (m[4] or "").strip()

    def applies(self, env, extras=()):
        if not self.marker:
            return True
        if Requirement:
            return any(self.marker.evaluate(dict(env, extra=x)) for x in (sorted(extras) or [""]))
        return "extra" not in self.marker                   # without pip: leave out the optional extras only

    def allows(self, version):
        if not self.spec:
            return True
        if Requirement:
            try:
                return self.spec.contains(version, prereleases=True)
            except Exception:  # noqa: BLE001
                return False
        m = re.match(r"\s*==\s*([^,\s]+)", str(self.spec))
        return not m or m[1] == version


def version_key(v):
    if Requirement:
        try:
            return (1, Version(v))
        except InvalidVersion:
            return (0, Version("0"))
    return (1, tuple(int(x) if x.isdigit() else -1 for x in re.split(r"[.+!-]", v)))


def prerelease(v):
    if Requirement:
        try:
            return Version(v).is_prerelease
        except InvalidVersion:
            return True
    return bool(re.search(r"(a|b|rc|dev)\d*", v))


def python_ok(spec, version):
    if not spec or not Requirement:
        return True
    try:
        return SpecifierSet(spec).contains(version, prereleases=True)
    except InvalidSpecifier:
        return True


def wheel_info(data):
    """What a wheel's METADATA says, and the modules it brings (the names students import)."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise Problem("This file is not a Python wheel (it is not a zip file).") from None
    with z:
        names = z.namelist()
        metas = [n for n in names if n.count("/") == 1 and n.endswith(".dist-info/METADATA")]
        if not metas:
            raise Problem("This file is not a Python wheel (it has no .dist-info/METADATA).")
        dist = metas[0].split("/")[0]
        small = lambda n: z.getinfo(n).file_size < (4 << 20)                     # noqa: E731 - no zip bombs
        meta = HeaderParser().parsestr(z.read(metas[0]).decode("utf-8", "replace") if small(metas[0]) else "")
        tops = []
        if f"{dist}/top_level.txt" in names and small(f"{dist}/top_level.txt"):
            tops = z.read(f"{dist}/top_level.txt").decode("utf-8", "replace").split()
        if not tops:
            for n in names:
                first, _, rest = n.partition("/")
                if first.endswith((".dist-info", ".data")) or first == "__pycache__":
                    continue
                if (rest and rest.endswith(".py")) or (not rest and n.endswith(".py")):
                    tops.append(first if rest else n[:-3])
    imports = sorted({t.replace("\\", "/").split("/")[0].split(".")[0] for t in tops})
    project, version = (meta.get("Name") or "").strip(), (meta.get("Version") or "").strip()
    if not NAME_RE.fullmatch(project) or not VERSION_RE.fullmatch(version):
        raise Problem("This wheel's name or version is not valid.")
    return {"project": project, "version": version,
            "requires": [r.strip() for r in meta.get_all("Requires-Dist") or [] if r.strip()],
            "requires_python": (meta.get("Requires-Python") or "").strip() or None,
            "imports": [i for i in imports if IDENT_RE.fullmatch(i) and not i.startswith("_")]}


class Packages:
    def __init__(self, store, web):
        self.store, self.web = Path(store), Path(web)
        self.wheels = self.store / "wheels"
        self.incoming = self.store / "incoming"
        self.lock = threading.RLock()
        self._rec_lock = threading.Lock()
        self.job = {"running": False, "log": [], "ok": None}
        self.peer_status = {}                       # server -> {"ok", "when", "got" | "error"}
        self.me = set()                             # this server's own addresses (serve.py fills them in)
        self._wake = threading.Event()
        self._last_ping = -PING_GAP
        self._ping_later = False
        try:
            self.reg = json.loads((self.store / "registry.json").read_text(encoding="utf-8"))
            if not isinstance(self.reg, dict):
                raise ValueError
        except (OSError, ValueError):
            self.reg = {}
        self.reg.setdefault("packages", {})
        self.reg.setdefault("servers", [])
        self.pyodide, self.py_version = self._pyodide()
        try:
            self.reconcile()
        except OSError as e:
            print(f"Python packages: could not update the labs' lists: {e}", flush=True)
        self._wake.set()                            # look at the other servers at once
        threading.Thread(target=self._loop, name="packages-sync", daemon=True).start()

    # ------------------------------------------------------------ what the lab has already
    def _pyodide(self):
        try:
            lock = json.loads((self.web / "runtimes" / "pyodide" / "pyodide-lock.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}, "3.13.0"
        pkgs = {}
        for key, p in lock.get("packages", {}).items():
            entry = {"name": key, "imports": p.get("imports") or []}
            pkgs[canon(key)] = entry
            pkgs.setdefault(canon(p.get("name", key)), entry)
        return pkgs, lock.get("info", {}).get("python", "3.13.0")

    def env(self):
        """The marker values of Python in the browser (Pyodide), for the packages' "; sys_platform == ..." parts."""
        v = self.py_version
        return {"python_version": ".".join(v.split(".")[:2]), "python_full_version": v, "os_name": "posix",
                "sys_platform": "emscripten", "platform_system": "Emscripten", "platform_machine": "wasm32",
                "platform_release": "", "platform_version": "", "implementation_name": "cpython",
                "implementation_version": v, "platform_python_implementation": "CPython"}

    def base_index(self):
        """The packages setup put in the lab (seaborn, openpyxl ...): import name -> entry."""
        try:
            idx = json.loads((self.web / "runtimes" / "pywheels" / "index.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {k: v for k, v in idx.items() if isinstance(v, dict) and not v.get("added")}

    def known(self, name):
        """How the lab has this package or module already, or None."""
        c = canon(name)
        if name in getattr(sys, "stdlib_module_names", ()):
            return f"{name} is part of Python itself: students just write  import {name}"
        p = self.pyodide.get(c)
        if p and p["imports"]:
            return f"{name} is part of the lab already (it comes with Pyodide): students just write  import {p['imports'][0]}"
        for p in self.pyodide.values():
            if name in p["imports"]:
                return f"{name} comes with {p['name']}, which is part of the lab already: students just write  import {name}"
        for imp, e in self.base_index().items():
            if canon(e.get("name")) == c or imp == name:
                return f"{e.get('name')} is part of the lab already: students just write  import {imp}"
        return None

    # ------------------------------------------------------------ adding (a background job, one at a time)
    def start(self, kind, items):
        with self.lock:
            if self.job.get("running"):
                raise Problem("A package is being added. Wait until it has finished.")
            self.job = {"running": True, "log": [], "ok": None, "started": time.time()}
        threading.Thread(target=self._run, args=(kind, items), name="packages-add", daemon=True).start()

    def _log(self, text):
        with self.lock:
            self.job["log"].append(text)

    def _run(self, kind, items):
        added = 0
        try:
            if kind == "pypi":
                for text in items:
                    try:
                        added += self.add_from_pypi(text)
                    except Problem as e:
                        self._log(str(e))
            else:
                added = self.add_wheels(items)
        except Problem as e:
            self._log(str(e))
        except Exception as e:  # noqa: BLE001 - the page must hear about it
            self._log(f"Could not finish: {e}")
        finally:
            if kind != "pypi":
                shutil.rmtree(self.incoming, ignore_errors=True)
        if added:
            try:
                self.reconcile()
            except OSError as e:
                self._log(f"Could not update the labs' lists: {e}")
            self.tell_peers()
        with self.lock:
            self.job.update(running=False, ok=added > 0, ended=time.time())

    def add_from_pypi(self, text):
        req = Req(text)
        known = self.known(req.name)
        if known:
            raise Problem(known)
        staged, pyodide, base = {}, set(), set()
        self._resolve(req, staged, pyodide, base, top=True)
        self._commit(canon(req.name), staged, pyodide, base)
        return 1

    def stage_upload(self, name, length, rfile):
        """One .whl file from the page, kept in packages/incoming until the job adds it."""
        name = re.sub(r"\s*\(\d+\)(?=\.whl$)", "", os.path.basename(str(name or "")).strip())   # "x (1).whl"
        if not WHEEL_RE.match(name):
            raise Problem(f"{name or 'This file'}: only Python wheels (.whl files) can be added.")
        if not is_pure(name):
            raise Problem(f"{name}: this wheel holds compiled code for one kind of PC. The labs can only use "
                          "pure-Python wheels, whose names end in -none-any.whl.")
        if not 0 < length <= WHEEL_MAX:
            raise Problem(f"{name} is too big for the labs.")
        if self.job.get("running"):
            raise Problem("A package is being added. Wait until it has finished, then add the files again.")
        self.incoming.mkdir(parents=True, exist_ok=True)
        left = length
        with open(self.incoming / name, "wb") as out:
            while left:
                chunk = rfile.read(min(left, 1 << 20))
                if not chunk:
                    raise Problem(f"{name} did not arrive completely; try again.")
                out.write(chunk)
                left -= len(chunk)
        return name

    def add_wheels(self, names):
        """The staged .whl files: each is a package of its own unless another one needs it. What they need comes
        from the other files, from Pyodide, from packages added before, or from PyPI when the server PC is online."""
        given = {}
        for n in names:
            n = os.path.basename(str(n))
            try:
                data = (self.incoming / n).read_bytes()
            except OSError:
                raise Problem(f"{n} did not arrive; add it again.") from None
            info = wheel_info(data)
            given[canon(info["project"])] = dict(info, file=n, data=data)
        needed = {canon(Req(d).name) for g in given.values() for d in g["requires"] if Req(d).applies(self.env())}
        added = 0
        for c in [c for c in given if c not in needed] or list(given):
            g = given[c]
            known = self.known(g["project"])
            if known:
                self._log(known)
                continue
            staged, pyodide, base = {c: g}, set(), set()
            try:
                for d in g["requires"]:
                    r = Req(d)
                    if r.applies(self.env()):
                        self._resolve(r, staged, pyodide, base, given=given, depth=1)
                self._commit(c, staged, pyodide, base)
                added += 1
            except Problem as e:
                self._log(str(e))
        return added

    def _resolve(self, req, staged, pyodide, base, top=False, given=None, depth=0):
        """Put req and what it needs in staged (canonical name -> wheel, or None when the lab has it already)."""
        if depth > 30:
            raise Problem("These packages need each other too deeply to add.")
        c = canon(req.name)
        if c in staged:
            return
        if not top:
            p = self.pyodide.get(c)
            if p:
                pyodide.add(p["name"])
                staged[c] = None
                return
            for e in self.base_index().values():
                if canon(e.get("name")) == c:
                    base.add(c)
                    staged[c] = None
                    return
            with self.lock:
                have = self.reg["packages"].get(c)
            if (have and not have.get("removed") and req.allows(have["version"])
                    and all((self.wheels / w["file"]).is_file() for w in have["wheels"])):
                for w in have["wheels"]:
                    staged.setdefault(canon(w["project"]), dict(w, reuse=True))
                staged[c] = staged.get(c) or dict(have["wheels"][0], reuse=True)
                pyodide.update(have.get("pyodide", []))
                base.update(have.get("base", []))
                return
        item = (given or {}).get(c) or self._download(req, needed=not top)
        staged[c] = item
        for dep in item["requires"]:
            r = Req(dep)
            if r.applies(self.env(), req.extras):
                self._resolve(r, staged, pyodide, base, given=given, depth=depth + 1)

    def _download(self, req, needed=False):
        self._log(f"Looking up {req.name}{req.spec or ''} on PyPI ...")
        url = INDEX + canon(req.name) + "/"
        try:
            page = json.loads(self._get(url, accept="application/vnd.pypi.simple.v1+json"))
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise Problem(f"PyPI has no package called {req.name}. Check the name (the one used with pip install).") from None
            raise Problem(f"PyPI did not answer for {req.name} (error {e.code}). Try again in a minute.") from None
        except (urllib.error.URLError, OSError) as e:
            reason = getattr(e, "reason", e)
            raise Problem(f"The server PC cannot reach PyPI to download {req.name} ({reason}). Connect it to the "
                          f"internet, or bring {req.name}'s .whl file and add it here"
                          + (" together with the others." if needed else ".")) from None
        by_version, compiled, pure = {}, False, False
        for f in page.get("files", []):
            m = WHEEL_RE.match(f.get("filename", ""))
            if not m:
                continue
            if not is_pure(f["filename"]):
                compiled = True
                continue
            pure = True
            if f.get("yanked") or not python_ok(f.get("requires-python"), self.py_version):
                continue
            by_version.setdefault(m["ver"], []).append(f)
        fits = sorted((v for v in by_version if req.allows(v)), key=version_key, reverse=True)
        for v in [v for v in fits if not prerelease(v)] or fits:
            f = sorted(by_version[v], key=lambda f: f["filename"])[0]
            size = int(f.get("size") or 0)
            if size > WHEEL_MAX:
                raise Problem(f"{f['filename']} is {size >> 20} MB, too big for the labs.")
            self._log(f"  downloading {f['filename']} ({max(1, size >> 10):,} KB)")
            data = self._get(urllib.parse.urljoin(url, f["url"]))
            want = (f.get("hashes") or {}).get("sha256")
            if want and hashlib.sha256(data).hexdigest() != want:
                raise Problem(f"{f['filename']} did not download correctly. Try again.")
            return dict(wheel_info(data), file=f["filename"], data=data)
        if by_version:
            raise Problem(f"No version of {req.name} fits {req.spec}.")
        if pure:
            raise Problem(f"{req.name} does not work with the lab's Python ({self.py_version}).")
        if compiled:
            raise Problem(f"{req.name} contains compiled code. That runs in a browser only when Pyodide includes it, "
                          "and Pyodide does not include this one, so the labs cannot use it"
                          + (" (the package you added needs it)." if needed else "."))
        raise Problem(f"{req.name} has no wheel on PyPI, only its source code. On a PC with Python, "
                      f"pip wheel {req.name} --no-deps  makes one: add that .whl file here.")

    @staticmethod
    def _get(url, accept=None, direct=False, timeout=60):
        headers = {"User-Agent": UA}
        if accept:
            headers["Accept"] = accept
        req = urllib.request.Request(url, headers=headers)
        with (DIRECT.open(req, timeout=timeout) if direct else urllib.request.urlopen(req, timeout=timeout)) as r:
            data = r.read(WHEEL_MAX + 1)
        if len(data) > WHEEL_MAX:
            raise Problem("A file is too big for the labs.")
        return data

    def _commit(self, top_c, staged, pyodide, base):
        """Keep the new wheels and put the package in the registry."""
        top = staged[top_c]
        if not top.get("imports"):
            raise Problem(f"{top['project']} has no Python module to import.")
        total = sum(len(i["data"]) for i in staged.values() if i and "data" in i)
        if total > ADD_MAX:
            raise Problem(f"Together these packages are {total >> 20} MB, too big for the labs.")
        wheels = []
        with self.lock:
            self.wheels.mkdir(parents=True, exist_ok=True)
            for i in staged.values():
                if not i:
                    continue
                if "data" in i:
                    tmp = self.wheels / (i["file"] + ".tmp")
                    tmp.write_bytes(i["data"])
                    os.replace(tmp, self.wheels / i["file"])
                    w = {"file": i["file"], "project": i["project"], "version": i["version"],
                         "sha256": hashlib.sha256(i["data"]).hexdigest(),
                         "md5": hashlib.md5(i["data"], usedforsecurity=False).hexdigest(),
                         "size": len(i["data"]), "requires_python": i.get("requires_python")}
                else:
                    w = {k: v for k, v in i.items() if k != "reuse"}
                if all(x["file"] != w["file"] for x in wheels):
                    wheels.append(w)
            wheels.sort(key=lambda w: canon(w["project"]) != top_c)          # the package's own wheel first
            self.reg["packages"][top_c] = {
                "project": top["project"], "version": top["version"], "imports": top["imports"], "wheels": wheels,
                "base": sorted(base), "pyodide": sorted(pyodide), "time": time.time(), "removed": False, "origin": ""}
            self._save()
        brings = [f"{w['project']} {w['version']}" for w in wheels[1:]]
        self._log(f"Added {top['project']} {top['version']}. Students can now write  import {top['imports'][0]}"
                  + (f"  (it brings {', '.join(brings)})" if brings else "") + ".")

    def remove(self, key):
        with self.lock:
            e = self.reg["packages"].get(canon(key))
            if not e or e.get("removed"):
                raise Problem("This package is not in the list.")
            e.update(removed=True, time=time.time(), origin="")
            self._save()
        self.reconcile()
        self.tell_peers()
        return e["project"]

    def _save(self):
        self.store.mkdir(parents=True, exist_ok=True)
        tmp = self.store / "registry.json.tmp"
        tmp.write_text(json.dumps(self.reg, indent=1), encoding="utf-8")
        os.replace(tmp, self.store / "registry.json")

    # ------------------------------------------------------------ the lists the labs read
    def reconcile(self):
        """Bring the Python IDE's list and Jupyter's pip index in line with the registry."""
        with self._rec_lock:
            with self.lock:
                live = json.loads(json.dumps([e for e in self.reg["packages"].values() if not e.get("removed")]))
            live.sort(key=lambda e: e["time"])
            self._reconcile_ide(live)
            self._reconcile_notebook(live)

    def _reconcile_ide(self, live):
        pyw = self.web / "runtimes" / "pywheels"
        if not pyw.is_dir():
            return
        index_file = pyw / "index.json"
        index = self._read_json(index_file)
        before = json.dumps(index, sort_keys=True)
        index = {k: v for k, v in index.items() if isinstance(v, dict) and not v.get("added")}
        base = {canon(v.get("name")): v for v in index.values()}
        for e in live:
            files = [w["file"] for w in e["wheels"] if self._copy(w["file"], pyw)]
            if len(files) < len(e["wheels"]):
                continue                                # a wheel is still on its way from another server
            pyo = list(e["pyodide"])
            for b in e.get("base", []):
                files += [f for f in base.get(b, {}).get("wheels", []) if f not in files]
                pyo += [p for p in base.get(b, {}).get("pyodide", []) if p not in pyo]
            for imp in e["imports"]:
                if imp in index and not index[imp].get("added"):
                    continue                            # never hide one of the lab's own packages
                index[imp] = {"name": e["project"], "wheels": files, "pyodide": pyo, "added": True, "version": e["version"]}
        if json.dumps(index, sort_keys=True) != before:
            self._write_json(index_file, index)

    def _reconcile_notebook(self, live):
        nb = self.web / "apps" / "notebook" / "pypi"
        if not nb.is_dir():
            return
        all_file = nb / "all.json"
        allj = self._read_json(all_file)
        before = json.dumps(allj, sort_keys=True)
        for proj in list(allj):
            rel = allj[proj].get("releases", {}) if isinstance(allj[proj], dict) else {}
            for v in list(rel):
                rel[v] = [f for f in rel[v] if not f.get("foct_added")]
                if not rel[v]:
                    del rel[v]
            if not rel:
                del allj[proj]
        for e in live:
            when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e["time"]))
            for w in e["wheels"]:
                if not self._copy(w["file"], nb):
                    continue
                rel = allj.setdefault(canon(w["project"]), {}).setdefault("releases", {}).setdefault(w["version"], [])
                if any(f.get("filename") == w["file"] for f in rel):
                    continue
                md5 = w.get("md5") or ""
                rel.append({"comment_text": "", "digests": {"md5": md5, "sha256": w["sha256"]}, "downloads": -1,
                            "filename": w["file"], "has_sig": False, "md5_digest": md5, "packagetype": "bdist_wheel",
                            "python_version": "py3", "requires_python": w.get("requires_python"), "size": w["size"],
                            "upload_time": when, "upload_time_iso_8601": when, "url": "./" + w["file"],
                            "yanked": False, "yanked_reason": None, "foct_added": True})
        if json.dumps(allj, sort_keys=True) != before:
            self._write_json(all_file, allj)

    def _copy(self, file, folder):
        dst = folder / file
        if dst.is_file():
            return True
        src = self.wheels / file
        if not src.is_file():
            return False
        shutil.copy2(src, dst)
        return True

    def _cleanup(self):
        """Delete the copies of wheels no package uses any more (only when nothing is being added; the lock keeps
        a package being saved meanwhile from losing its files)."""
        with self.lock:
            if self.job.get("running"):
                return
            used = {w["file"] for e in self.reg["packages"].values() if not e.get("removed") for w in e["wheels"]}
            try:
                ours = {p.name for p in self.wheels.glob("*.whl")}
            except OSError:
                return
            keep = {f for e in self.base_index().values() for f in e.get("wheels", [])}
            for name in ours - used:
                for folder in (self.web / "runtimes" / "pywheels", self.web / "apps" / "notebook" / "pypi", self.wheels):
                    if folder != self.wheels and name in keep:
                        continue                        # also one of the lab's own wheels
                    try:
                        (folder / name).unlink()
                    except OSError:
                        pass

    @staticmethod
    def _read_json(path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _write_json(path, data):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        os.replace(tmp, path)
        for stale in (path.with_name(path.name + ".gz"), path.with_name(path.name + ".br")):
            try:
                stale.unlink()                          # setup's compressed copy holds the old list
            except OSError:
                pass

    # ------------------------------------------------------------ the page
    def view(self):
        with self.lock:
            rows = []
            for c, e in self.reg["packages"].items():
                if e.get("removed"):
                    continue
                ready = all((self.wheels / w["file"]).is_file() for w in e["wheels"])
                rows.append({"key": c, "project": e["project"], "version": e["version"], "imports": e["imports"],
                             "brings": [f"{w['project']} {w['version']}" for w in e["wheels"][1:]],
                             "uses": sorted(set(e.get("pyodide", [])) | set(e.get("base", []))),
                             "kb": round(sum(w["size"] for w in e["wheels"]) / 1024), "time": e["time"],
                             "origin": e.get("origin", ""), "ready": ready})
            rows.sort(key=lambda r: r["project"].lower())
            job = dict(self.job, log=list(self.job.get("log", [])))
            servers = list(self.reg["servers"])
            peers = {s: dict(v) for s, v in self.peer_status.items() if s in servers}
        base = sorted({e.get("name") for e in self.base_index().values()}, key=str.lower)
        return {"packages": rows, "servers": servers, "peers": peers, "job": job, "base": base,
                "pyodide": len({p["name"] for p in self.pyodide.values()}), "python": self.py_version,
                "me": sorted(u for u in self.me if not re.match(r"https?://(127\.|localhost)", u)), "now": time.time()}

    # ------------------------------------------------------------ several lab servers
    def set_servers(self, servers):
        with self.lock:
            self.reg["servers"] = [s for s in servers if s not in self.me]
            self._save()
        self._wake.set()

    def wake(self):
        self._wake.set()

    def peer_json(self):
        """What the other servers copy: every package, with when it was added or removed (the newest change wins)."""
        with self.lock:
            return json.dumps({"app": "FoCT Virtual Labs", "packages": self.reg["packages"]})

    def wheel_path(self, file):
        with self.lock:
            files = {w["file"] for e in self.reg["packages"].values() if not e.get("removed") for w in e["wheels"]}
        path = self.wheels / file
        return path if file in files and path.is_file() else None

    def ping(self):
        """Another server says its packages changed: look at once, or a little later when it said so a moment ago
        (anyone on the network can send this, so it makes at most one look every few seconds)."""
        with self.lock:
            wait = self._last_ping + PING_GAP - time.monotonic()
            if wait <= 0:
                self._last_ping = time.monotonic()
                self._wake.set()
                return
            if self._ping_later:
                return
            self._ping_later = True

        def later():
            time.sleep(wait)
            with self.lock:
                self._ping_later = False
                self._last_ping = time.monotonic()
            self._wake.set()
        threading.Thread(target=later, name="packages-ping", daemon=True).start()

    def others(self):
        return [s for s in self.reg["servers"] if s not in self.me]

    def tell_peers(self):
        def tell():
            for s in self.others():
                try:
                    req = urllib.request.Request(ipv4(s) + "/__packages/ping", data=b"", method="POST", headers={"User-Agent": UA})
                    DIRECT.open(req, timeout=5).close()
                except (OSError, ValueError):
                    pass
        threading.Thread(target=tell, name="packages-tell", daemon=True).start()

    @staticmethod
    def _clean(key, e):
        """A package entry from another server, checked (it decides file names here), or None."""
        try:
            if canon(key) != key or not isinstance(e, dict):
                return None
            out = {"project": str(e["project"])[:100], "version": str(e["version"])[:60],
                   "imports": [i for i in e.get("imports", []) if isinstance(i, str) and IDENT_RE.fullmatch(i)][:50],
                   "wheels": [], "base": [canon(b) for b in e.get("base", []) if isinstance(b, str)][:50],
                   "pyodide": [p for p in e.get("pyodide", []) if isinstance(p, str) and re.fullmatch(r"[A-Za-z0-9._-]{1,100}", p)][:100],
                   "time": float(e["time"]), "removed": bool(e.get("removed")), "origin": str(e.get("origin") or "")[:200]}
            for w in e.get("wheels", [])[:100]:
                if not (isinstance(w.get("file"), str) and is_pure(w["file"]) and re.fullmatch(r"[0-9a-f]{64}", str(w.get("sha256")))):
                    return None
                out["wheels"].append({"file": w["file"], "project": str(w["project"])[:100], "version": str(w["version"])[:60],
                                      "sha256": w["sha256"], "md5": str(w.get("md5") or "")[:32], "size": int(w["size"]),
                                      "requires_python": str(w["requires_python"])[:100] if w.get("requires_python") else None})
            if not out["removed"] and (not out["wheels"] or not out["imports"]):
                return None
            names = [out["project"]] + [w["project"] for w in out["wheels"]]
            versions = [out["version"]] + [w["version"] for w in out["wheels"]]
            if not all(NAME_RE.fullmatch(n) for n in names) or not all(VERSION_RE.fullmatch(v) for v in versions):
                return None
            return out
        except (KeyError, TypeError, ValueError, AttributeError):
            return None

    def sync(self):
        for s in self.others():
            try:
                at = ipv4(s)
                data = json.loads(self._get(at + "/__packages/peer.json", direct=True, timeout=15))
                if not isinstance(data, dict) or data.get("app") != "FoCT Virtual Labs":
                    raise ValueError("not a FoCT Virtual Labs server")
                got = []
                for key, theirs in (data.get("packages") or {}).items():
                    e = self._clean(key, theirs)
                    if not e:
                        continue
                    with self.lock:
                        mine = self.reg["packages"].get(key)
                    if mine and mine["time"] >= e["time"]:
                        continue
                    if not e["removed"]:
                        for w in e["wheels"]:
                            dst = self.wheels / w["file"]
                            if dst.is_file():
                                continue
                            blob = self._get(f"{at}/__packages/wheel/{urllib.parse.quote(w['file'])}", direct=True)
                            if hashlib.sha256(blob).hexdigest() != w["sha256"]:
                                raise ValueError(f"{w['file']} did not copy correctly")
                            w["md5"] = w["md5"] or hashlib.md5(blob, usedforsecurity=False).hexdigest()
                            self.wheels.mkdir(parents=True, exist_ok=True)
                            tmp = dst.with_name(dst.name + ".tmp")
                            tmp.write_bytes(blob)
                            os.replace(tmp, dst)
                    e["origin"] = e["origin"] or s
                    with self.lock:
                        mine = self.reg["packages"].get(key)
                        if mine and mine["time"] >= e["time"]:
                            continue
                        self.reg["packages"][key] = e
                        self._save()
                    got.append(("removed " if e["removed"] else "") + e["project"])
                self.peer_status[s] = {"ok": True, "when": time.time(), "got": got}
            except (OSError, ValueError, Problem) as ex:
                reason = getattr(ex, "reason", None) or ex
                self.peer_status[s] = {"ok": False, "when": time.time(), "error": str(reason)[:200]}

    def _loop(self):
        while True:
            self._wake.wait(SYNC_EVERY)
            self._wake.clear()
            try:
                if self.reg["servers"]:
                    self.sync()
                self.reconcile()
                self._cleanup()
            except Exception as e:  # noqa: BLE001 - keep going
                print(f"Python packages: {e}", flush=True)
