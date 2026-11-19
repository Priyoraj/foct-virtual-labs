"""FoCT Virtual Labs - exam mode: state, the students who signed in, and their submissions.

While exam mode is on, every lab page blocks copy and paste and shows an exam watermark
(web/assets/js/exam.js). With "students sign in" ticked, each student also enters their name and
enrolment number, and the page sends their work here:
  - their lab drafts (C, C++, Java, Python, Lex & Yacc, SQL, MongoDB, SPICE, NetSim, Jupyter)
    whenever they change, at most once a minute, and at once when the teacher collects;
  - every file they save or download from a lab during the exam;
  - files they hand in with "Submit files".
Files are kept in submissions/<exam title>/<Name>_<Enrolment>/ and the teacher downloads them as
<exam title>.zip from the control page. Only the latest version of each file is kept.
Only the Python standard library is used.
"""
import csv
import io
import json
import os
import re
import secrets
import tempfile
import threading
import time
import zipfile
from pathlib import Path

UPLOAD_MAX = 50 * 1024 * 1024          # one file
STUDENT_MAX = 300 * 1024 * 1024        # everything one student sends in one exam
GRACE = 120                            # seconds after the exam ends during which late uploads still count
BLOCKED_EXT = {".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".msi",
               ".msp", ".scr", ".pif", ".lnk", ".dll", ".cpl", ".hta", ".reg", ".sys", ".scf", ".url"}
WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
NAME_RE = re.compile(r"[\w .'\-]{2,80}")
ENROL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9/._ \-]{1,39}")


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


class ExamMode:
    def __init__(self, state_file, root):
        self.state_file = Path(state_file)
        self.root = Path(root)
        self.lock = threading.Condition()
        self.state = {"on": False, "title": "", "since": None, "ended": None, "id": None, "folder": None,
                      "register": True, "collect": 0}
        self.students = {}        # token -> record
        try:
            saved = json.loads(self.state_file.read_text(encoding="utf-8"))
            for k in self.state:
                if k in saved:
                    self.state[k] = saved[k]
            self.state["title"] = str(self.state["title"] or "")[:120]
            if self.state["folder"]:
                roster = json.loads((self.exam_dir() / ".exam.json").read_text(encoding="utf-8"))
                if roster.get("id") == self.state["id"]:
                    self.students = roster.get("students", {})
        except (OSError, ValueError, AttributeError, TypeError):
            pass

    # ------------------------------------------------------------ helpers (call with the lock held)
    def exam_dir(self):
        return self.root / self.state["folder"]

    def _save(self):
        try:
            self.state_file.write_text(json.dumps(self.state), encoding="utf-8")
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

    # ------------------------------------------------------------ public
    def public(self):
        with self.lock:
            s = self.state
            return {"on": s["on"], "title": s["title"], "since": s["since"], "id": s["id"],
                    "register": bool(s["register"]), "collect": s["collect"]}

    def set(self, on, title, register):
        with self.lock:
            s = self.state
            title = str(title or "").strip()[:120]
            if on and not s["on"]:                      # a new exam
                s.update(on=True, since=time.time(), ended=None, title=title, register=bool(register), collect=0,
                         id=time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2))
                self.students = {}
                s["folder"] = self._new_folder(title) if s["register"] else None
            elif on:                                   # change the title or the sign-in option
                if s["register"] != bool(register) and register and not s["folder"]:
                    s["folder"] = self._new_folder(title or s["title"])
                s["register"] = bool(register)
                if title != s["title"] and s["folder"] and not self.students:
                    new = self._new_folder(title)
                    try:
                        if self.exam_dir().exists():
                            os.replace(self.exam_dir(), self.root / new)
                        s["folder"] = new
                    except OSError:
                        pass
                s["title"] = title
            elif s["on"]:                              # end the exam; its submissions stay available
                s.update(on=False, ended=time.time())
            self._save()
            return dict(s)

    def register(self, exam_id, name, enrolment, ip):
        name, enrolment = clean_student(name, enrolment)
        with self.lock:
            s = self.state
            if not (s["on"] and s["register"] and s["folder"] and exam_id == s["id"]):
                raise PermissionError("This exam is not accepting sign-ins.")
            key = re.sub(r"[\s/._-]", "", enrolment)
            same = [(t, r) for t, r in self.students.items() if re.sub(r"[\s/._-]", "", r["enrolment"]) == key]
            for t, r in same:
                if r["ip"] == ip:                       # signing in again on the same PC
                    r.update(name=name, seen=time.time())
                    self._save()
                    return t, r
            folder = safe_name(f"{name}_{enrolment}", fallback="student", limit=120)
            used = {r["folder"] for r in self.students.values()}
            base, n = folder, 2
            while folder in used:
                folder, n = f"{base} ({n})", n + 1
            token = secrets.token_urlsafe(18)
            now = time.time()
            rec = {"name": name, "enrolment": enrolment, "folder": folder, "ip": ip, "first": now, "seen": now,
                   "saved": None, "files": {}, "done": 0}
            self.students[token] = rec
            (self.exam_dir() / folder).mkdir(parents=True, exist_ok=True)
            self._save()
            return token, rec

    def seen(self, token, ip):
        with self.lock:
            rec = self.students.get(token or "")
            if rec:
                rec["seen"] = time.time()
                rec["ip_now"] = ip
                return {"name": rec["name"], "enrolment": rec["enrolment"], "folder": rec["folder"],
                        "saved": rec["saved"]}
            return None

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

    def roster(self):
        with self.lock:
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
                             "twice": counts[re.sub(r"[\s/._-]", "", r["enrolment"])] > 1})
            folder = str(self.exam_dir().resolve()) if self.state["folder"] else None
            return {"exam": dict(self.state), "folder": folder, "students": rows}

    def zip_file(self):
        """The exam folder as a zip in a temporary file: <title>/<Name>_<Enrolment>/... and roster.csv."""
        info = self.roster()
        s = info["exam"]
        if not s["folder"]:
            raise FileNotFoundError("There is no exam with submissions yet.")
        top = safe_name(s["title"] or s["folder"], fallback="Exam")
        out = tempfile.TemporaryFile()
        stamp = lambda t: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) if t else ""  # noqa: E731
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["Name", "Enrolment no.", "Folder", "PC", "Signed in", "Last saved", "Files", "Size (KB)", "Note"])
            for r in info["students"]:
                w.writerow([r["name"], r["enrolment"], r["folder"], r["pc"], stamp(r["first"]), stamp(r["saved"]),
                            r["files"], r["kb"], "signed in on more than one PC" if r["twice"] else ""])
            z.writestr(f"{top}/roster.csv", "﻿" + buf.getvalue())   # BOM: Excel opens it as UTF-8
            base = self.root / s["folder"]
            for r in info["students"]:
                folder = base / r["folder"]
                z.writestr(f"{top}/{r['folder']}/_student.txt",
                           f"Name: {r['name']}\r\nEnrolment no.: {r['enrolment']}\r\nPC: {r['pc']}\r\n"
                           f"Signed in: {stamp(r['first'])}\r\nLast saved: {stamp(r['saved'])}\r\n"
                           f"Exam: {s['title']}\r\n")
                if not folder.is_dir():
                    continue
                for f in sorted(folder.rglob("*")):
                    if f.is_file() and not f.name.startswith((".upload-", ".exam")):
                        z.write(f, f"{top}/{r['folder']}/{f.relative_to(folder).as_posix()}")
        size = out.tell()
        out.seek(0)
        return out, size, f"{top}.zip"
