"""FoCT Virtual Labs - exam mode: state, options, the students who signed in, their submissions,
incidents and locks.

While exam mode is on, every lab page blocks copy and paste and shows an exam watermark
(web/assets/js/exam.js), and the teacher's options add more safeguards:
  - only the labs chosen for the exam are served (enforced here, by the server);
  - with "students sign in": each student enters name, enrolment no. (and the exam code, if set),
    only allowed PCs may sign in, and the server serves the labs only to signed-in PCs that are not
    locked and keep checking in; their work is collected into
    submissions/<exam title>/<Name>_<Enrolment>/ and downloaded as <exam title>.zip;
  - a time limit: when it runs out the work is collected and the labs lock;
  - pages report incidents (leaving the exam, developer tools, removed protections, big insertions,
    a second screen, blocked actions). Developer tools or removed protections lock the student at
    once; the lock lifts when the page is back to normal, or when the teacher lets them back in;
  - the teacher can lock or unlock a student and send a message to every screen.
Only the Python standard library is used.
"""
import csv
import io
import ipaddress
import json
import os
import re
import secrets
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import parse_qs

UPLOAD_MAX = 50 * 1024 * 1024          # one file
STUDENT_MAX = 300 * 1024 * 1024        # everything one student sends in one exam
# A student who signs in again on the same PC (after a restart or a power cut, say) starts in a browser
# without their drafts. What they sent before moves to a folder of its own, so nothing is replaced, and
# their lab drafts (up to RESTORE_MAX each) go back to the page, which puts them back into the labs.
EARLIER = "Earlier work until"
RESTORE_MAX = 1024 * 1024
DRAFT_DIRS = ("C", "C++", "Java", "Python", "Lex & Yacc", "SQL", "MongoDB", "SPICE", "Network")
GRACE = 120                            # seconds after the exam ends during which late uploads still count
STALE = 45                             # seconds without a check-in before a signed-in PC loses the labs
EVENTS_KEPT = 300                      # per student; the counters keep counting
BLOCKED_EXT = {".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".msi",
               ".msp", ".scr", ".pif", ".lnk", ".dll", ".cpl", ".hta", ".reg", ".sys", ".scf", ".url"}
WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
NAME_RE = re.compile(r"[\w .'\-]{2,80}")
ENROL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9/._ \-]{1,39}")

LABS = {"c": "C", "cpp": "C++", "java": "Java", "python": "Python IDE", "jupyter": "Jupyter", "lex": "Lex & Yacc",
        "cdtools": "Compiler tools", "sql": "SQL", "mongo": "MongoDB", "spice": "SPICE", "circuit": "Circuit simulator",
        "netsim": "Network simulator", "packets": "Packet analyzer", "drawio": "Diagrams", "office": "Office"}
CODE_LABS = {"c", "cpp", "java", "python", "lex"}
NEEDS = [   # URL prefix -> the labs that use it (first match wins)
    ("/apps/code/", CODE_LABS), ("/apps/notebook/", {"jupyter"}), ("/apps/sql/", {"sql"}), ("/apps/mongo/", {"mongo"}),
    ("/apps/cdtools/", {"cdtools"}), ("/apps/spice/", {"spice"}), ("/apps/circuit/", {"circuit"}),
    ("/apps/netsim/", {"netsim"}), ("/apps/packets/", {"packets"}), ("/apps/drawio/", {"drawio"}), ("/apps/office/", {"office"}),
    ("/vendor/monaco/", CODE_LABS | {"sql", "mongo", "spice"}),
    ("/runtimes/clang/", {"c", "cpp", "lex"}), ("/runtimes/lexyacc/", {"lex"}),
    ("/runtimes/teavm/", {"java"}), ("/runtimes/javabox/", {"java"}),
    ("/runtimes/pyodide/", {"python", "jupyter"}), ("/runtimes/pywheels/", {"python", "jupyter"}),
    ("/runtimes/sql/", {"sql"}), ("/runtimes/mongo/", {"mongo"}), ("/runtimes/viz/", {"cdtools"}),
    ("/runtimes/spice/", {"spice"}), ("/runtimes/wiregasm/", {"packets"}),
]
AGENT_STALE = 20                       # seconds without a beat before a PC's exam helper counts as stopped
# Programs the exam helper closes (and keeps closed) on the student's PC. The teacher can change the list.
HELPER_KILL = ("notepad.exe, notepad++.exe, wordpad.exe, write.exe, code.exe, devenv.exe, sublime_text.exe, atom.exe, "
               "pycharm64.exe, idea64.exe, eclipse.exe, netbeans64.exe, codeblocks.exe, devcpp.exe, winword.exe, "
               "excel.exe, powerpnt.exe, onenote.exe, soffice.exe, soffice.bin, wps.exe, chrome.exe, firefox.exe, "
               "opera.exe, brave.exe, vivaldi.exe, iexplore.exe, whatsapp.exe, telegram.exe, discord.exe, skype.exe, "
               "teams.exe, ms-teams.exe, zoom.exe, anydesk.exe, teamviewer.exe, rustdesk.exe, quickassist.exe, "
               "mstsc.exe, snippingtool.exe, screensketch.exe, screenclippinghost.exe, sharex.exe, greenshot.exe, "
               "obs64.exe, obs32.exe, cmd.exe, powershell.exe, pwsh.exe, windowsterminal.exe, wt.exe, taskmgr.exe, "
               "regedit.exe, procexp.exe, procexp64.exe, processhacker.exe, systeminformer.exe, calculatorapp.exe, calc.exe")
EXE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+\-]{0,60}\.(exe|bin)")
OPTS = {"block_open": True,      # opening files from the PC / pen drive, and the IDE's example programs
        "block_keys": True,      # right-click menu, developer-tools and view-source keys, printing
        "tamper_lock": True,     # lock on developer tools or removed protections
        "unlock": "auto",        # "auto": when back to normal; "teacher": only when the teacher lets them back in
        "leave": "log",          # leaving the exam window: "log", "warn" or "lock" (after leave_limit times)
        "leave_limit": 3,
        "fullscreen": False,     # the exam runs full screen
        "chromium_only": False,  # only Chromium browsers (Edge, Chrome) can take the exam: they support every safeguard
        "helper": False,         # students must run the exam helper (exam-helper.vbs) on their Windows PC
        "helper_taskmgr": True,  # ... which turns off Task Manager and the clipboard history during the exam
        "helper_admin": True,    # ... and, with administrator rights: developer tools off, USB drives blocked
        "helper_internet": True,  # ... and, with administrator rights: no internet on the PC, the lab network still works
        "helper_usb": "pause",   # a USB drive on the PC: "pause" the exam there while it is connected, or "note" it
        "helper_kill": HELPER_KILL,
        "helper_servers": ""}    # the lab's other servers ("http://host:port ..."): if this one stops, the helper moves there
EVENT_KINDS = {"left", "fullscreen", "devtools", "tamper", "bigins", "screen2", "blocked"}
EVENT_NAMES = {"left": "Left the exam window", "fullscreen": "Left full screen", "devtools": "Developer tools opened",
               "tamper": "Exam protection changed", "bigins": "Large insertion in an editor", "screen2": "Second screen",
               "blocked": "Blocked", "stale": "Stopped checking in", "lock": "Locked", "unlock": "Unlocked",
               "timeup": "Time up", "usb": "USB drive connected", "kiosk": "Exam browser closed",
               "closed": "Programs closed by the exam helper", "helper": "Exam helper", "again": "Signed in again"}


def safe_name(text, fallback="file", limit=100):
    """A file or folder name that is valid on Windows, Linux and macOS."""
    s = re.sub(r"\s*:\s*", " - ", str(text))                      # "C: Practical" -> "C - Practical"
    s = re.sub(r"\s+", " ", WIN_BAD.sub("-", s)).strip().strip(".").strip()
    s = s[:limit].rstrip(". ")
    if not s:
        s = fallback
    if s.split(".")[0].upper() in RESERVED:
        s = "_" + s
    return s


def safe_relpath(path):
    """'Python/main.py' style path inside a student's folder, or None if it is not acceptable."""
    parts = [p for p in str(path).replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or len(parts) > 6 or ".." in parts:
        return None
    rel = "/".join(safe_name(p, limit=120) for p in parts)
    if len(rel) > 240 or Path(rel).suffix.lower() in BLOCKED_EXT or rel.startswith("_student"):
        return None
    return rel


def clean_student(name, enrolment):
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    enrolment = re.sub(r"\s+", " ", str(enrolment or "")).strip().upper()
    if not NAME_RE.fullmatch(name) or not re.search(r"[^\W\d_]", name):
        raise ValueError("Enter your full name (letters, spaces, dots or hyphens).")
    if not ENROL_RE.fullmatch(enrolment):
        raise ValueError("Enter your enrolment number (letters, digits, / - or .).")
    return name, enrolment


def parse_allow(text):
    """'192.168.1.20-192.168.1.110, 10.0.5.0/24, 192.168.1.5' -> [(first, last), ...] as integers."""
    ranges = []
    for part in re.split(r"[,;\s]+", str(text or "").strip()):
        if not part:
            continue
        if "/" in part:
            net = ipaddress.ip_network(part, strict=False)
            ranges.append((int(net.network_address), int(net.broadcast_address)))
        elif "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(ipaddress.ip_address(a.strip())), int(ipaddress.ip_address(b.strip()))
            ranges.append((min(lo, hi), max(lo, hi)))
        else:
            ip = int(ipaddress.ip_address(part))
            ranges.append((ip, ip))
    return ranges


def ip_allowed(ip, ranges):
    if not ranges:
        return True
    try:
        n = int(ipaddress.ip_address(ip))
    except ValueError:
        return False
    return any(lo <= n <= hi for lo, hi in ranges)


def labs_for(path, query, page):
    """The labs a request belongs to, or None for shared files (portal, help, assets)."""
    if page and path.startswith("/apps/code/"):
        lang = (parse_qs(query).get("lang") or ["c"])[0]
        return {lang if lang in CODE_LABS else "c"}
    for prefix, labs in NEEDS:
        if path.startswith(prefix):
            return labs
    return None


def server_list(text):
    """The lab's other servers, from what the teacher typed: ['http://host:port', ...]. A missing port is
    the lab server's usual one (8080, or 8443 for https). Raises ValueError for a typing mistake."""
    out = []
    for part in re.split(r"[\s,;]+", str(text or "")):
        part = part.strip().rstrip("/")
        if not part:
            continue
        if not re.match(r"https?://", part, re.I):
            part = "http://" + part
        m = re.fullmatch(r"(https?)://([A-Za-z0-9][A-Za-z0-9.\-]*)(?::(\d{1,5}))?", part, re.I)
        if not m:
            raise ValueError(f"Please check the other lab servers: {part} is not an address like http://192.168.1.11:8080.")
        scheme = m.group(1).lower()
        url = f"{scheme}://{m.group(2).lower()}:{m.group(3) or (8443 if scheme == 'https' else 8080)}"
        if url not in out:
            out.append(url)
    if len(out) > 8:
        raise ValueError("Please check the other lab servers: at most 8.")
    return out


def chromium_browser(user_agent):
    """Edge, Chrome and the other Chromium browsers (by what the browser says it is)."""
    ua = str(user_agent or "")
    return bool(re.search(r"(Chrome|Chromium|Edg)/", ua)) and "Firefox/" not in ua


BROWSER_MSG = "This exam needs Microsoft Edge or Google Chrome. Open the lab address in one of them."


def duration(secs):
    secs = int(secs or 0)
    return f"{secs // 60}m {secs % 60:02d}s" if secs >= 60 else f"{secs}s"


class ExamMode:
    def __init__(self, state_file, root):
        self.state_file = Path(state_file)
        self.root = Path(root)
        self.lock = threading.Condition()
        self.state = {"on": False, "title": "", "since": None, "ended": None, "id": None, "folder": None,
                      "register": True, "collect": 0, "labs": None, "code": None, "allow": "", "ends_at": None,
                      "timeup": False, "opts": dict(OPTS), "message": None}
        self.students = {}        # token -> record
        self.agents = {}          # exam helper token -> {ip, pc, user, kiosk, beat, status ...}
        try:
            saved = json.loads(self.state_file.read_text(encoding="utf-8"))
            for k in self.state:
                if k in saved:
                    self.state[k] = saved[k]
            self.state["title"] = str(self.state["title"] or "")[:120]
            self.state["opts"] = {**OPTS, **(self.state["opts"] or {})}
            self.agents = saved.get("agents") or {}
            if self.state["folder"]:
                roster = json.loads((self.exam_dir() / ".exam.json").read_text(encoding="utf-8"))
                if roster.get("id") == self.state["id"]:
                    self.students = roster.get("students", {})
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        self._ranges = self._safe_ranges(self.state["allow"])

    # ------------------------------------------------------------ helpers (call with the lock held)
    @staticmethod
    def _safe_ranges(text):
        try:
            return parse_allow(text)
        except ValueError:
            return []

    def exam_dir(self):
        return self.root / self.state["folder"]

    def _save(self):
        try:
            self.state_file.write_text(json.dumps(dict(self.state, agents=self.agents)), encoding="utf-8")
        except OSError:
            pass
        if self.state["folder"]:
            try:
                self.exam_dir().mkdir(parents=True, exist_ok=True)
                tmp = self.exam_dir() / ".exam.json.tmp"
                tmp.write_text(json.dumps({"id": self.state["id"], "title": self.state["title"],
                                           "since": self.state["since"], "students": self.students}, indent=1),
                               encoding="utf-8")
                os.replace(tmp, self.exam_dir() / ".exam.json")
            except OSError:
                pass

    def _new_folder(self, title):
        base = safe_name(title, fallback="Exam " + time.strftime("%Y-%m-%d %H-%M"))
        name, n = base, 2
        while (self.root / name).exists():
            name, n = f"{base} ({n})", n + 1
        return name

    def _accepting(self):
        s = self.state
        return s["id"] and (s["on"] or (s["ended"] and time.time() - s["ended"] < GRACE))

    def _student(self, token):
        rec = self.students.get(token or "")
        return rec if rec and self._accepting() else None

    def _log(self, rec, kind, detail="", secs=0):
        ev = rec.setdefault("events", [])
        ev.append({"t": time.time(), "kind": kind, "detail": str(detail)[:200], "secs": round(secs or 0, 1)})
        del ev[:-EVENTS_KEPT]

    def _lock(self, rec, kind, reason, auto):
        if rec.get("locked"):
            return
        rec["locked"] = {"kind": kind, "reason": reason, "at": time.time(), "auto": bool(auto)}
        self._log(rec, "lock", reason)

    def _tick(self):
        s = self.state
        if s["on"] and s["ends_at"] and not s["timeup"] and time.time() >= s["ends_at"]:
            s["timeup"] = True
            s["collect"] += 1                       # every PC sends its final work
            for rec in self.students.values():
                self._log(rec, "timeup", "the time limit ran out")
            self._save()

    # ------------------------------------------------------------ teacher
    def public(self):
        with self.lock:
            self._tick()
            s = self.state
            return {"on": s["on"], "title": s["title"], "since": s["since"], "id": s["id"],
                    "register": bool(s["register"]), "collect": s["collect"], "labs": s["labs"],
                    "code": bool(s["code"]), "ends_at": s["ends_at"], "timeup": bool(s["timeup"]),
                    "opts": dict(s["opts"]), "message": s["message"]}

    def configure(self, on, title, register=True, labs=None, code=False, allow="", minutes=0, opts=None):
        if labs is not None:
            labs = [x for x in labs if x in LABS] or None
            if labs and set(labs) == set(LABS):
                labs = None
        ranges = parse_allow(allow)                 # raises ValueError for a typing mistake
        o = {**OPTS, **{k: v for k, v in (opts or {}).items() if k in OPTS}}
        o["unlock"] = "teacher" if o["unlock"] == "teacher" else "auto"
        o["leave"] = o["leave"] if o["leave"] in ("log", "warn", "lock") else "log"
        o["leave_limit"] = max(1, min(20, int(o["leave_limit"] or 3)))
        for k in ("block_open", "block_keys", "tamper_lock", "fullscreen", "chromium_only", "helper", "helper_taskmgr",
                  "helper_admin", "helper_internet"):
            o[k] = bool(o[k])
        o["helper_usb"] = "note" if o["helper_usb"] == "note" else "pause"
        o["helper_kill"] = ", ".join(dict.fromkeys(m.group(0).lower() for m in EXE_RE.finditer(str(o["helper_kill"] or ""))))
        o["helper_servers"] = " ".join(server_list(o.get("helper_servers")))     # raises ValueError for a typing mistake
        with self.lock:
            s = self.state
            title = str(title or "").strip()[:120]
            if on and not s["on"]:                      # a new exam
                now = time.time()
                s.update(on=True, since=now, ended=None, title=title, register=bool(register), collect=0,
                         id=time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2), timeup=False, message=None,
                         ends_at=now + int(minutes) * 60 if int(minutes or 0) > 0 else None)
                self.students = {}
                self.agents = {}
                s["folder"] = self._new_folder(title) if s["register"] else None
                s["code"] = f"{secrets.randbelow(9000) + 1000}" if code else None
            elif on:                                   # changes during the exam
                if register and not s["register"] and not s["folder"]:
                    s["folder"] = self._new_folder(title or s["title"])
                s["register"] = bool(register) or s["register"]
                if title != s["title"] and s["folder"] and not self.students:
                    new = self._new_folder(title)
                    try:
                        if self.exam_dir().exists():
                            os.replace(self.exam_dir(), self.root / new)
                        s["folder"] = new
                    except OSError:
                        pass
                s["title"] = title
                if code and not s["code"]:
                    s["code"] = f"{secrets.randbelow(9000) + 1000}"
                elif not code:
                    s["code"] = None
            elif s["on"]:                              # end the exam; its submissions stay available
                s.update(on=False, ended=time.time())
            if on:
                s["labs"], s["allow"], s["opts"] = labs, str(allow or "").strip()[:500], o
                self._ranges = ranges
            self._save()
            return dict(s)

    def add_time(self, minutes):
        with self.lock:
            s = self.state
            if not s["on"]:
                return dict(s)
            now = time.time()
            base = max(s["ends_at"] or now, now) if s["timeup"] else (s["ends_at"] or now)
            s["ends_at"] = base + int(minutes) * 60
            if s["timeup"] and s["ends_at"] > now:
                s["timeup"] = False
            self._save()
            return dict(s)

    def send_message(self, text):
        text = str(text or "").strip()[:500]
        with self.lock:
            self.state["message"] = {"id": secrets.token_hex(4), "text": text, "at": time.time()} if text else None
            self._save()
            return self.state["message"]

    def teacher_lock(self, folder, lock):
        with self.lock:
            for rec in self.students.values():
                if rec["folder"] == folder:
                    if lock:
                        self._lock(rec, "teacher", "Paused by your teacher", auto=False)
                    elif rec.get("locked"):
                        rec["locked"] = None
                        rec["left_mark"] = rec.get("counts", {}).get("left", 0)
                        self._log(rec, "unlock", "let back in by the teacher")
                    self._save()
                    return True
            return False

    def collect(self, timeout=25):
        """Ask every page to send its latest work now; wait until the active PCs have answered."""
        with self.lock:
            if not self.state["id"]:
                return {"asked": 0, "answered": 0}
            self.state["collect"] += 1
            n = self.state["collect"]
            self._save()
            if not self.state["on"]:
                return {"asked": 0, "answered": 0}
            active = [r for r in self.students.values() if time.time() - r["seen"] < 60]
            end = time.time() + timeout
            while time.time() < end and any(r.get("done", 0) < n for r in active):
                self.lock.wait(min(1.0, end - time.time()))
            return {"asked": len(active), "answered": sum(1 for r in active if r.get("done", 0) >= n)}

    # ------------------------------------------------------------ students
    def register(self, exam_id, name, enrolment, code, ip, kiosk="", user_agent=""):
        name, enrolment = clean_student(name, enrolment)
        with self.lock:
            s = self.state
            if not (s["on"] and s["register"] and s["folder"] and exam_id == s["id"]):
                raise PermissionError("This exam is not accepting sign-ins.")
            if s["timeup"]:
                raise PermissionError("The time for this exam is over.")
            if not ip_allowed(ip, self._ranges):
                raise PermissionError("This PC is not one of the exam PCs. Ask your teacher.")
            if s["opts"].get("chromium_only") and not chromium_browser(user_agent):
                raise PermissionError(BROWSER_MSG)
            if s["opts"].get("helper"):
                ag = self._agent_for(ip)
                if not ag or not ag["status"].get("ready"):
                    raise PermissionError("Run the exam helper on this PC first.")
                if str(kiosk or "") != ag["kiosk"]:
                    raise PermissionError("Start the exam in the browser that the exam helper opened.")
            if s["code"] and str(code or "").strip() != s["code"]:
                raise ValueError("The exam code is not right. Look at the board, or ask your teacher.")
            key = re.sub(r"[\s/._-]", "", enrolment)
            same = [(t, r) for t, r in self.students.items() if re.sub(r"[\s/._-]", "", r["enrolment"]) == key]
            for t, r in same:
                if r["ip"] == ip:                       # signing in again on the same PC
                    r.update(name=name, seen=time.time())
                    kept, restore = self._set_aside(r)
                    self._log(r, "again", f'earlier work kept in "{kept}"' if kept else "")
                    self._note_move(r, ip)
                    self._save()
                    return t, r, restore
            folder = safe_name(f"{name}_{enrolment}", fallback="student", limit=120)
            used = {r["folder"] for r in self.students.values()}
            base, n = folder, 2
            while folder in used:
                folder, n = f"{base} ({n})", n + 1
            token = secrets.token_urlsafe(18)
            now = time.time()
            rec = {"name": name, "enrolment": enrolment, "folder": folder, "ip": ip, "first": now, "seen": now,
                   "saved": None, "files": {}, "done": 0, "locked": None, "events": [], "counts": {}}
            self.students[token] = rec
            (self.exam_dir() / folder).mkdir(parents=True, exist_ok=True)
            self._note_move(rec, ip)
            self._save()
            return token, rec, []

    def _note_move(self, rec, ip):
        """The PC came here because its lab server stopped answering: note it with the student (lock held)."""
        ag = self._agent_for(ip) if self.state["opts"].get("helper") else None
        if ag and ag.get("from") and not ag.get("noted"):
            ag["noted"] = True
            self._log(rec, "helper", f"moved here from {ag['from']}, which stopped answering")

    def _set_aside(self, rec):
        """Before a student who signs in again can replace anything: move what they sent so far into
        "Earlier work until <time>". Returns that folder's name (None if nothing was there) and the
        latest version of each lab draft, for the page to put back (lock held)."""
        home = self.exam_dir() / rec["folder"]
        moving = [rel for rel in rec["files"] if not rel.startswith(EARLIER)]
        name = None
        if moving:
            stamp = time.strftime("%H.%M")
            name, n = f"{EARLIER} {stamp}", 2
            while (home / name).exists():
                name, n = f"{EARLIER} {stamp} ({n})", n + 1
            for rel in moving:
                size = rec["files"].pop(rel)
                try:
                    (home / name / rel).parent.mkdir(parents=True, exist_ok=True)
                    os.replace(home / rel, home / name / rel)
                except OSError:
                    continue                                # gone already: nothing to keep
                rec["files"][f"{name}/{rel}"] = size
            for rel in moving:                              # folders left empty
                d = (home / rel).parent
                while d != home:
                    try:
                        d.rmdir()
                    except OSError:
                        break
                    d = d.parent
        # The latest version of each lab draft, wherever it is now: files moved later come later in
        # rec["files"], so they win. (Signing in twice in a row still finds the work.)
        latest = {}
        for rel, size in rec["files"].items():
            path = rel.split("/", 1)[1] if rel.startswith(EARLIER) and "/" in rel else rel
            if path.split("/", 1)[0] in DRAFT_DIRS and size <= RESTORE_MAX:
                latest[path] = rel
        restore = []
        for path, rel in latest.items():
            try:
                restore.append({"path": path, "data": (home / rel).read_text(encoding="utf-8")})
            except (OSError, UnicodeDecodeError):
                pass
        return name, restore

    def seen(self, token, ip):
        with self.lock:
            rec = self.students.get(token or "")
            if not rec:
                return None
            rec["seen"] = time.time()
            rec["ip_now"] = ip
            rec.pop("stale_logged", None)
            return {"name": rec["name"], "enrolment": rec["enrolment"], "folder": rec["folder"],
                    "saved": rec["saved"], "locked": rec.get("locked")}

    def event(self, token, kind, detail="", count=1, secs=0):
        """A page reports an incident. Returns {"locked": lock or None, "new": locked just now, "who": ...}."""
        with self.lock:
            rec = self.students.get(token or "")
            if not rec or not self.state["on"]:
                return {"locked": None, "new": False, "who": ""}
            before = rec.get("locked")
            kind = kind if kind in EVENT_KINDS else "blocked"
            counts = rec.setdefault("counts", {})
            secs = max(0.0, min(float(secs or 0), 6 * 3600))
            if kind == "blocked":
                what = re.sub(r"[^a-z0-9]", "", str(detail).lower())[:20] or "action"
                n = max(1, min(int(count or 1), 1000))
                counts["blocked_" + what] = counts.get("blocked_" + what, 0) + n
                self._log(rec, kind, f"{what} x{n}")
            else:
                counts[kind] = counts.get(kind, 0) + 1
                if kind == "left":
                    counts["left_s"] = counts.get("left_s", 0) + secs
                self._log(rec, kind, detail, secs)
            o = self.state["opts"]
            if kind in ("devtools", "tamper") and o["tamper_lock"]:
                self._lock(rec, kind, EVENT_NAMES[kind] + (f" ({detail})" if detail else ""), auto=o["unlock"] == "auto")
            if kind == "left" and o["leave"] == "lock" and counts["left"] - rec.get("left_mark", 0) >= o["leave_limit"]:
                self._lock(rec, "left", f"Left the exam window {counts['left']} times", auto=False)
            rec["seen"] = time.time()
            self._save()
            after = rec.get("locked")
            return {"locked": after, "new": bool(after and not before), "who": f"{rec['name']} ({rec['enrolment']})"}

    def ok(self, token):
        """The page is back to normal (developer tools closed, protections in place)."""
        with self.lock:
            rec = self.students.get(token or "")
            if rec and rec.get("locked") and rec["locked"].get("auto"):
                rec["locked"] = None
                self._log(rec, "unlock", "back to normal")
                self._save()
            return rec.get("locked") if rec else None

    def gate(self, token, path, query, page, ip="", user_agent=""):
        """None when the request may be served, else (status, message) - the server's own safeguards."""
        labs = labs_for(path, query, page)
        if labs is None:
            return None
        with self.lock:
            self._tick()
            s = self.state
            if not s["on"]:
                return None
            if s["labs"] is not None and not labs & set(s["labs"]):
                return 403, "This lab is not part of the exam."
            if page:                                # pages always load, so they can show sign-in or the lock screen
                return None
            if s["timeup"]:
                return 403, "The time for the exam is over."
            if s["opts"].get("chromium_only") and not chromium_browser(user_agent):
                return 403, BROWSER_MSG
            if s["opts"].get("helper"):
                ag = self._agent_for(ip)
                if not ag or not ag["status"].get("ready"):
                    return 403, "Run the exam helper on this PC first."
            if not s["register"]:
                return None
            rec = self.students.get(token or "")
            if not rec:
                return 403, "Sign in to the exam first."
            if rec.get("locked"):
                return 403, "The exam is paused on this PC."
            if time.time() - rec["seen"] > STALE:
                if not rec.get("stale_logged"):
                    rec["stale_logged"] = True
                    rec.setdefault("counts", {})["stale"] = rec.get("counts", {}).get("stale", 0) + 1
                    self._log(rec, "stale", "used the labs without checking in (exam script stopped?)")
                    self._save()
                return 403, "This PC stopped checking in with the exam."
            return None

    # ------------------------------------------------------------ exam helper (exam-helper.vbs on the PC)
    def _agent_for(self, ip):
        """The running exam helper of this PC (lock held), or None."""
        now = time.time()
        best = None
        for ag in self.agents.values():
            if ag["ip"] == ip and not ag.get("gone") and now - ag["beat"] < AGENT_STALE:
                if not best or ag["beat"] > best["beat"]:
                    best = ag
        return best

    def _students_on(self, ip):
        return [r for r in self.students.values() if (r.get("ip_now") or r["ip"]) == ip]

    def helper_settings(self):
        o = self.state["opts"]
        return {"taskmgr": bool(o["helper_taskmgr"]), "admin": bool(o["helper_admin"]),
                "internet": bool(o.get("helper_internet")), "kill": o["helper_kill"],
                "servers": o.get("helper_servers") or ""}

    def helper_servers(self):
        """The lab's other servers, for the exam helper that this server hands out."""
        with self.lock:
            return (self.state["opts"].get("helper_servers") or "").split()

    def agent_hello(self, ip, info):
        """A PC's exam helper starts. Returns its token, the kiosk key for the exam browser and the settings."""
        with self.lock:
            s = self.state
            if not (s["on"] and s["opts"].get("helper")):
                raise PermissionError("No exam that needs the exam helper is running." if not s["on"]
                                      else "This exam does not use the exam helper.")
            if not ip_allowed(ip, self._ranges):
                raise PermissionError("This PC is not one of the exam PCs. Ask your teacher.")
            pc = re.sub(r"[^\w .\-]", "", str(info.get("pc") or ""))[:40]
            old = next((a for a in self.agents.values() if a["ip"] == ip and a.get("pc") == pc), None)
            kiosk = old["kiosk"] if old else secrets.token_urlsafe(12)     # the exam browser keeps working after a restart
            for t in [t for t, a in self.agents.items() if a["ip"] == ip]:
                del self.agents[t]
            token = secrets.token_urlsafe(18)
            now = time.time()
            self.agents[token] = {"ip": ip, "pc": pc, "user": re.sub(r"[^\w .\-@]", "", str(info.get("user") or ""))[:40],
                                  "version": str(info.get("version") or "")[:10], "kiosk": kiosk, "first": now,
                                  "beat": now, "status": {"ready": False},
                                  # the lab server the helper moved away from (it stopped answering)
                                  "from": re.sub(r"[^\w.:/\-]", "", str(info.get("from") or ""))[:80]}
            for rec in self._students_on(ip):
                self._log(rec, "helper", "exam helper started")
            self._save()
            return {"token": token, "kiosk": kiosk, "exam": s["id"], "title": s["title"], **self.helper_settings()}

    def agent_beat(self, token, status):
        """The helper reports what it sees on the PC. Returns whether the exam goes on, and the settings."""
        with self.lock:
            self._tick()
            ag = self.agents.get(token or "")
            s = self.state
            if not ag:
                return {"known": False, "on": s["on"], "end": not s["on"]}
            now = time.time()
            ag["beat"] = now
            old = ag.get("status") or {}
            st = {"ready": bool(status.get("ready")), "browser": bool(status.get("browser")),
                  "taskmgr": bool(status.get("taskmgr")), "admin": bool(status.get("admin")),
                  "devtools": bool(status.get("devtools")), "usbblock": bool(status.get("usbblock")),
                  "netoff": bool(status.get("netoff")),
                  "usb": str(status.get("usb") or "")[:40], "screens": int(status.get("screens") or 0),
                  "problem": str(status.get("problem") or "")[:200], "killed": str(status.get("killed") or "")[:300],
                  "relaunched": int(status.get("relaunched") or 0)}
            ag["status"] = st
            students = self._students_on(ag["ip"])
            seen = ag.setdefault("closed_at", {})          # note each program at most every 2 minutes
            fresh = [n for n in st["killed"].split(",") if n and now - seen.get(n, 0) > 120]
            for n in fresh:
                seen[n] = now
            for rec in students:
                if fresh:
                    self._log(rec, "closed", ", ".join(fresh))
                if st["relaunched"] > (old.get("relaunched") or 0):
                    self._log(rec, "kiosk", "the exam browser was closed and opened again")
                if st["usb"] and st["usb"] != old.get("usb"):
                    rec.setdefault("counts", {})["usb"] = rec.get("counts", {}).get("usb", 0) + 1
                    self._log(rec, "usb", f"drive {st['usb']}")
                if st["screens"] > 1 and (old.get("screens") or 0) <= 1:
                    rec.setdefault("counts", {})["screen2"] = rec.get("counts", {}).get("screen2", 0) + 1
                    self._log(rec, "screen2", f"{st['screens']} screens (exam helper)")
                lk = rec.get("locked")
                if st["usb"] and s["opts"]["helper_usb"] == "pause":
                    self._lock(rec, "usb", f"A USB drive ({st['usb']}) is connected; remove it to continue", auto=True)
                elif not st["usb"] and lk and lk.get("kind") == "usb":
                    rec["locked"] = None
                    self._log(rec, "unlock", "USB drive removed")
            if students or st != old:
                self._save()
            return {"known": True, "on": s["on"], "end": not s["on"], "title": s["title"], **self.helper_settings()}

    def agent_bye(self, token, reason=""):
        with self.lock:
            ag = self.agents.get(token or "")
            if ag:
                ag["gone"] = time.time()
                for rec in self._students_on(ag["ip"]):
                    self._log(rec, "helper", f"exam helper stopped ({str(reason)[:60] or 'PC put back to normal'})")
                self._save()

    def client_agent(self, ip, kiosk, loopback):
        """For the exam page: is this PC's exam helper running, and is this the helper's browser?"""
        with self.lock:
            if not self.state["opts"].get("helper") or loopback:
                return {"ok": True, "ready": True, "kiosk": True, "problem": ""}
            ag = self._agent_for(ip)
            if not ag:
                return {"ok": False, "ready": False, "kiosk": False, "problem": ""}
            st = ag["status"]
            return {"ok": True, "ready": bool(st.get("ready")), "kiosk": bool(kiosk) and kiosk == ag["kiosk"],
                    "problem": st.get("problem", "")}

    def cache_key(self):
        """Part of the runtime cookie: during an exam it changes, so browsers check every file with the server."""
        with self.lock:
            return self.state["id"] if self.state["on"] else ""

    def upload(self, token, relpath, length, stream):
        """Write one file from the request body. Raises PermissionError / ValueError with a message."""
        rel = safe_relpath(relpath)
        if rel is None:
            raise ValueError("This file name or type is not accepted.")
        if not 0 <= length <= UPLOAD_MAX:
            raise ValueError(f"Files can be at most {UPLOAD_MAX // 2**20} MB.")
        with self.lock:
            rec = self._student(token)
            if not rec:
                raise PermissionError("Not signed in to the current exam.")
            if sum(rec["files"].values()) - rec["files"].get(rel, 0) + length > STUDENT_MAX:
                raise ValueError(f"You can send at most {STUDENT_MAX // 2**20} MB in this exam.")
            target = self.exam_dir() / rec["folder"] / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".upload-")
        try:
            left = length
            with os.fdopen(fd, "wb") as f:
                while left > 0:
                    chunk = stream.read(min(left, 256 * 1024))
                    if not chunk:
                        raise ValueError("The upload was cut off.")
                    f.write(chunk)
                    left -= len(chunk)
            os.replace(tmp, target)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        with self.lock:
            rec["files"][rel] = length
            rec["saved"] = rec["seen"] = time.time()
            self._save()
        return rel

    def done(self, token, n):
        with self.lock:
            rec = self.students.get(token or "")
            if rec:
                rec["done"] = max(rec.get("done", 0), int(n))
                rec["seen"] = time.time()
                self.lock.notify_all()

    # ------------------------------------------------------------ reports
    @staticmethod
    def alerts(rec):
        c = rec.get("counts", {})
        out = []
        for kind, label in (("devtools", "Developer tools"), ("tamper", "Protection changed"), ("stale", "Stopped checking in"),
                            ("usb", "USB drive"), ("screen2", "Second screen"), ("bigins", "Large insertion"),
                            ("fullscreen", "Left full screen")):
            if c.get(kind):
                out.append(f"{label} x{c[kind]}")
        if c.get("left"):
            out.append(f"Left the window x{c['left']} ({duration(c.get('left_s', 0))})")
        blocked = sum(v for k, v in c.items() if k.startswith("blocked_"))
        if blocked:
            out.append(f"Blocked actions x{blocked}")
        return out

    def roster(self):
        with self.lock:
            self._tick()
            now = time.time()
            counts = {}
            for r in self.students.values():
                k = re.sub(r"[\s/._-]", "", r["enrolment"])
                counts[k] = counts.get(k, 0) + 1
            rows = []
            for r in sorted(self.students.values(), key=lambda r: (r["enrolment"], r["first"])):
                rows.append({"name": r["name"], "enrolment": r["enrolment"], "folder": r["folder"],
                             "pc": r.get("ip_now") or r["ip"], "first": r["first"], "seen": r["seen"],
                             "saved": r["saved"], "files": len(r["files"]),
                             "kb": round(sum(r["files"].values()) / 1024),
                             "online": now - r["seen"] < 30,
                             "twice": counts[re.sub(r"[\s/._-]", "", r["enrolment"])] > 1,
                             "locked": r.get("locked"), "alerts": self.alerts(r),
                             "helper": self._helper_row(r.get("ip_now") or r["ip"]),
                             "events": [dict(e, name=EVENT_NAMES.get(e["kind"], e["kind"])) for e in r.get("events", [])[-12:]]})
            folder = str(self.exam_dir().resolve()) if self.state["folder"] else None
            signed = {r.get("ip_now") or r["ip"] for r in self.students.values()}
            pcs = [dict(self._helper_row(a["ip"]) or {}, ip=a["ip"]) for a in self.agents.values()
                   if a["ip"] not in signed and not a.get("gone") and now - a["beat"] < AGENT_STALE]
            return {"exam": dict(self.state), "folder": folder, "students": rows, "labs": LABS, "now": now,
                    "helper_pcs": pcs, "helper_kill": HELPER_KILL}

    def _helper_row(self, ip):
        """What the exam helper reports for this PC, for the control page (lock held)."""
        if not self.state["opts"].get("helper"):
            return None
        ag = self._agent_for(ip)
        if not ag:
            return {"running": False}
        st = ag["status"]
        return {"running": True, "ready": st.get("ready"), "pc": ag.get("pc"), "taskmgr": st.get("taskmgr"),
                "admin": st.get("admin"), "devtools": st.get("devtools"), "usbblock": st.get("usbblock"),
                "netoff": st.get("netoff"), "usb": st.get("usb"), "screens": st.get("screens"), "problem": st.get("problem")}

    def zip_file(self, server=None):
        """The exam folder as a zip in a temporary file: <title>/<Name>_<Enrolment>/..., roster.csv, incidents.csv,
        and exam.json (the exam and this server, so zips from several lab servers can be merged:
        server/similarity.py). server: {"name", "address", "version"} of this lab server."""
        with self.lock:
            s = dict(self.state)
            students = [dict(r) for r in self.students.values()]
        if not s["folder"]:
            raise FileNotFoundError("There is no exam with submissions yet.")
        info = self.roster()
        top = safe_name(s["title"] or s["folder"], fallback="Exam")
        stamp = lambda t: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if t else ""  # noqa: E731
        out = tempfile.TemporaryFile()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            z.writestr(f"{top}/exam.json", json.dumps({
                "app": "FoCT Virtual Labs", "kind": "submissions", "title": s["title"], "id": s["id"],
                "folder": s["folder"], "started": s["since"], "ended": s["ended"], "zipped": time.time(),
                "students": len(info["students"]), "server": server or {}}, indent=1))
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["Name", "Enrolment no.", "Folder", "PC", "Signed in", "Last saved", "Files", "Size (KB)",
                        "Locked", "Alerts", "Note"])
            for r in info["students"]:
                w.writerow([r["name"], r["enrolment"], r["folder"], r["pc"], stamp(r["first"]), stamp(r["saved"]),
                            r["files"], r["kb"], (r["locked"] or {}).get("reason", ""), "; ".join(r["alerts"]),
                            "signed in on more than one PC" if r["twice"] else ""])
            z.writestr(f"{top}/roster.csv", "﻿" + buf.getvalue())   # BOM: Excel opens it as UTF-8
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["Name", "Enrolment no.", "Time", "Event", "Detail", "Seconds"])
            for r in sorted(students, key=lambda r: r["enrolment"]):
                for e in r.get("events", []):
                    w.writerow([r["name"], r["enrolment"], stamp(e["t"]), EVENT_NAMES.get(e["kind"], e["kind"]),
                                e.get("detail", ""), e.get("secs") or ""])
            z.writestr(f"{top}/incidents.csv", "﻿" + buf.getvalue())
            base = self.root / s["folder"]
            for r in info["students"]:
                folder = base / r["folder"]
                alerts = "\r\n".join("  " + a for a in r["alerts"]) or "  none"
                z.writestr(f"{top}/{r['folder']}/_student.txt",
                           f"Name: {r['name']}\r\nEnrolment no.: {r['enrolment']}\r\nPC: {r['pc']}\r\n"
                           f"Signed in: {stamp(r['first'])}\r\nLast saved: {stamp(r['saved'])}\r\n"
                           f"Exam: {s['title']}\r\nAlerts:\r\n{alerts}\r\n")
                if not folder.is_dir():
                    continue
                for f in sorted(folder.rglob("*")):
                    if f.is_file() and not f.name.startswith((".upload-", ".exam")):
                        z.write(f, f"{top}/{r['folder']}/{f.relative_to(folder).as_posix()}")
        size = out.tell()
        out.seek(0)
        return out, size, f"{top}.zip"
