"""FoCT Virtual Labs - merge the submissions of several lab servers, and check them for similarity.

Several lab servers can run the same exam, so that if one fails its students carry on with another.
Each server's exam control page downloads that server's work as <Exam title>.zip. This module merges
those zips into one folder per student (by enrolment number), then compares every student's work
with every other student's, lab by lab, and writes a report a teacher can mark from.

How the similarity check works (the method of MOSS and JPlag, the usual tools for programming classes):
  1. Each program becomes a list of tokens with names and values replaced: `total = total + x[i];`
     becomes `V = V + V [ V ] ;`. Renaming variables, editing comments, spacing or the text of
     messages leaves the tokens as they were.
  2. Greedy string tiling finds the longest runs of identical tokens two programs share, in any order,
     down to a minimum length (one or two lines of code), so moving functions around does not hide
     them either.
  3. Code the teacher gave the students, and code that many students have (more than a quarter of
     the class by default), is left out first: it says nothing about copying.
  4. For each pair: how much of each student's own code is also in the other's, which lines match,
     whether the matching code even has the same names, texts and comments (copied as is) or not
     (names changed), and whether parts were moved around.
Documents (Word, PowerPoint, Excel, text) are compared word by word in the same way, and identical
files (the very same file, byte for byte) are listed too.

Command line, on any PC with Python 3.8 or newer (nothing to install):
    python server/similarity.py "Server 1.zip" "Server 2.zip" [--base starter.c] [--out folder]
The exam control page has the same tool: Merge and check similarity (/__exam/merge).
Only the Python standard library is used.
"""
import argparse
import csv
import hashlib
import io
import itertools
import json
import keyword
import os
import re
import secrets
import shutil
import sys
import threading
import time
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from itertools import accumulate
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from exam_mode import EARLIER, safe_name  # noqa: E402

OTHER = "Other copies"                   # older or different versions of a file, from another server or PC
REPORT_FILE = "similarity-report.html"
PAIRS_CSV = "similarity-pairs.csv"
STUDENTS_CSV = "similarity-students.csv"
LEVELS = (("vhigh", 0.80, "Very high"), ("high", 0.60, "High"), ("medium", 0.40, "Medium"))
LOW_SHOWN = 0.25          # pairs below this share are not listed at all
MIN_MATCH = 25            # tokens (two or three lines): less matching code than this is not reported
SHORT = 80                # tokens of a student's own code (about 8-10 lines): less is a short program
COMMON_SHARE = 0.15       # code that more than this share of the students have is left out (MOSS: 10)
COMMON_MIN = 4            # ...but always only code that more than this many students have
FILE_MAX = 20 * 2**20     # bytes read from one file for the check
TEXT_MAX = 2 * 2**20      # characters of one file used for the check
TOKENS_MAX = 60000        # tokens per student and lab
SCALE_FACTORS = (1, 2, 4, 8)          # stretch lengths (times the minimum match) at which commonness is judged
HASH_MOD, HASH_MUL = (1 << 61) - 1, 1000003
PART_MAX = 32 * 2**20     # bytes read from one part of an Office file
SHOW_MAX = 300 * 1024     # characters of one file shown in the report

# ---------------------------------------------------------------------------------- what is compared
BUCKETS = {   # id: (name in the report, lexer, minimum match length in tokens)
    "c": ("C", "c", 10), "cpp": ("C++", "cpp", 10), "java": ("Java", "java", 10), "python": ("Python", "python", 8),
    "notebook": ("Jupyter notebooks", "python", 8), "lex": ("Lex & Yacc", "c", 10), "sql": ("SQL", "sql", 8),
    "js": ("MongoDB", "js", 10), "spice": ("SPICE", "spice", 6), "text": ("Documents", "text", 8)}
DIR_BUCKET = {   # a lab's folder in the student's folder: (file types that count, bucket)
    "C": ({".c", ".h"}, "c"), "C++": ({".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h"}, "cpp"),
    "Java": ({".java"}, "java"), "Python": ({".py", ".pyw"}, "python"),
    "Lex & Yacc": ({".l", ".lex", ".y", ".yacc", ".c", ".h"}, "lex"), "SQL": ({".sql"}, "sql"),
    "MongoDB": ({".js", ".mongodb"}, "js"), "SPICE": ({".cir", ".sp", ".spice", ".net", ".txt"}, "spice"),
    "Jupyter": ({".ipynb"}, "notebook")}
EXT_BUCKET = {".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".c++": "cpp", ".hpp": "cpp", ".hh": "cpp",
              ".hxx": "cpp", ".java": "java", ".py": "python", ".pyw": "python", ".ipynb": "notebook", ".l": "lex",
              ".lex": "lex", ".y": "lex", ".yacc": "lex", ".sql": "sql", ".js": "js", ".cir": "spice", ".sp": "spice",
              ".spice": "spice", ".docx": "text", ".pptx": "text", ".xlsx": "text", ".txt": "text", ".md": "text",
              ".csv": "text"}
BASE_ALSO = {"python": ("notebook",), "notebook": ("python",), "c": ("cpp", "lex"), "cpp": ("c",)}
TEXTLIKE = {".c", ".h", ".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".java", ".py", ".pyw", ".l", ".lex", ".y",
            ".yacc", ".sql", ".js", ".cir", ".sp", ".spice", ".net", ".txt", ".md", ".csv"}


def bucket_for(rel):
    """Which comparison a file of a student's folder belongs to (None: not compared)."""
    parts = rel.split("/")
    top, name = parts[0], parts[-1]
    ext = os.path.splitext(name)[1].lower()
    if top == OTHER or top.startswith(EARLIER) or name == "_student.txt" or name.startswith(".") or len(parts) < 2:
        return None
    if top in DIR_BUCKET:
        exts, bucket = DIR_BUCKET[top]
        return bucket if ext in exts else None
    if top == "Network":
        return None
    return EXT_BUCKET.get(ext)


# ---------------------------------------------------------------------------------- reading text
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _part(z, name):
    try:
        info = z.getinfo(name)
    except KeyError:
        return None
    return z.read(info) if info.file_size <= PART_MAX else None


def _paragraphs(root, p_tag, t_tag, tab_tags=(), br_tags=()):
    lines = []
    for p in root.iter(p_tag):
        out = []
        for el in p.iter():
            if el.tag == t_tag and el.text:
                out.append(el.text)
            elif el.tag in tab_tags:
                out.append(" ")
            elif el.tag in br_tags:
                out.append("\n")
        line = "".join(out).strip()
        if line:
            lines.append(line)
    return lines


def office_text(ext, data):
    """The text of a Word, PowerPoint or Excel file (formulas included), or "" if it cannot be read."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if ext == ".docx":
                xml = _part(z, "word/document.xml")
                return "\n".join(_paragraphs(ET.fromstring(xml), W_NS + "p", W_NS + "t", (W_NS + "tab",),
                                             (W_NS + "br", W_NS + "cr"))) if xml else ""
            if ext == ".pptx":
                slides = sorted((n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                                key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
                lines = []
                for n in slides:
                    xml = _part(z, n)
                    if xml:
                        lines += _paragraphs(ET.fromstring(xml), A_NS + "p", A_NS + "t", (), (A_NS + "br",))
                return "\n".join(lines)
            if ext == ".xlsx":
                shared = []
                xml = _part(z, "xl/sharedStrings.xml")
                if xml:
                    for si in ET.fromstring(xml).iter(S_NS + "si"):
                        shared.append("".join(t.text or "" for t in si.iter(S_NS + "t")))
                sheets = sorted((n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
                                key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
                lines = []
                for n in sheets:
                    xml = _part(z, n)
                    if not xml:
                        continue
                    for row in ET.fromstring(xml).iter(S_NS + "row"):
                        cells = []
                        for c in row.iter(S_NS + "c"):
                            f, v = c.find(S_NS + "f"), c.find(S_NS + "v")
                            if f is not None and f.text:
                                cells.append("=" + f.text)
                            elif c.get("t") == "s" and v is not None and (v.text or "").isdigit() and int(v.text) < len(shared):
                                cells.append(shared[int(v.text)])
                            elif c.get("t") == "inlineStr":
                                cells.append("".join(t.text or "" for t in c.iter(S_NS + "t")))
                            elif v is not None and v.text:
                                cells.append(v.text)
                        if cells:
                            lines.append(" | ".join(cells))
                return "\n".join(lines)
    except (zipfile.BadZipFile, ET.ParseError, KeyError, ValueError, OSError, RuntimeError):
        return ""
    return ""


def notebook_code(data):
    """The code cells of a Jupyter notebook, one after the other."""
    try:
        nb = json.loads(data.decode("utf-8", "replace"))
    except ValueError:
        return ""
    out = []
    for n, cell in enumerate(nb.get("cells") or [], 1):
        if isinstance(cell, dict) and cell.get("cell_type") == "code":
            src = cell.get("source") or ""
            src = "".join(src) if isinstance(src, list) else str(src)
            if src.strip():
                out.append(f"# In [{n}]:\n{src.rstrip()}\n")
    return "\n".join(out)


def decode(data):
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def file_text(rel, data):
    """The text the check compares, for a file of a student's folder."""
    ext = os.path.splitext(rel)[1].lower()
    if ext in (".docx", ".pptx", ".xlsx"):
        text = office_text(ext, data)
    elif ext == ".ipynb":
        text = notebook_code(data)
    else:
        text = decode(data)
    return text.replace("\r\n", "\n").replace("\r", "\n")[:TEXT_MAX]


def norm_text(text):
    return re.sub(r"[ \t]+(?=\n)|\s+\Z", "", text.replace("\r\n", "\n")).encode("utf-8")


# ---------------------------------------------------------------------------------- tokens
# A token is (symbol, original text, kind, line). The symbol is what the comparison sees: names
# become "V", numbers "N", strings "S"; keywords, well-known library names and operators stay as
# they are. Kinds: "id" (a name the student chose), "kw", "num", "str", "op", "word".
C_KEEP = set("""auto break case char const continue default do double else enum extern float for goto if inline int
long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool
bool true false NULL define ifdef ifndef endif undef pragma elif printf scanf puts gets fgets getchar putchar getch
getche clrscr malloc calloc realloc free strlen strcpy strncpy strcat strcmp strncmp strchr strstr strrev sprintf
sscanf fopen fclose fprintf fscanf fread fwrite fseek ftell rewind feof fflush exit abs sqrt pow sin cos tan log exp
floor ceil fabs rand srand time memset memcpy atoi atof isdigit isalpha isupper islower isspace toupper tolower main
stdin stdout stderr EOF FILE size_t yylex yyparse yyerror yytext yyleng yylval yywrap yyin""".split())
CPP_KEEP = C_KEEP | set("""alignas alignof and asm catch class constexpr const_cast decltype delete dynamic_cast
explicit export friend mutable namespace new noexcept not nullptr operator or private protected public
reinterpret_cast static_assert static_cast template this throw try typeid typename using virtual xor override final
std cout cin cerr endl string vector map set unordered_map unordered_set pair stack queue deque list iostream
push_back pop_back push pop top front back size empty begin end sort swap max min getline make_pair first second
insert erase find count""".split())
JAVA_KEEP = set("""abstract assert boolean break byte case catch char class const continue default do double else
enum extends final finally float for goto if implements import instanceof int interface long native new package
private protected public return short static strictfp super switch synchronized this throw throws transient try void
volatile while var record yield true false null String System out in err println print printf Scanner nextInt
nextLine next nextDouble nextFloat nextLong hasNext hasNextInt close Math max min abs sqrt pow random Integer
parseInt valueOf Double parseDouble Float Long Character Boolean ArrayList LinkedList List HashMap TreeMap Map
HashSet TreeSet Set Arrays Collections length size add get put remove contains containsKey equals charAt
substring indexOf toString toCharArray split trim compareTo main args Exception IOException
ArithmeticException ArrayIndexOutOfBoundsException NullPointerException InputMismatchException Override Object
StringBuilder append reverse""".split())
PY_KEEP = set(keyword.kwlist) | set("""print input range len int float str bool list dict set tuple open sum min max
abs round sorted reversed enumerate zip map filter type isinstance append extend pop insert remove index count split
join strip lower upper replace format items keys values get sort reverse read write readline readlines close self
__init__ __name__ __main__ __str__ math sqrt pow floor ceil pi random randint numpy np pandas pd matplotlib pyplot
plt array mean sum DataFrame read_csv head describe groupby plot show xlabel ylabel title legend""".split())
JS_KEEP = set("""break case catch class const continue debugger default delete do else export extends finally for
function if import in instanceof let new return super switch this throw try typeof var void while with yield async
await of true false null undefined db print printjson find findOne insertOne insertMany updateOne updateMany
replaceOne deleteOne deleteMany aggregate count countDocuments distinct sort limit skip pretty createIndex
dropIndex getIndexes drop toArray forEach map filter reduce length push console log ObjectId ISODate Date Math
use show collections dbs it explain""".split())
SQL_KEEP = set("""SELECT FROM WHERE GROUP BY HAVING ORDER ASC DESC JOIN LEFT RIGHT INNER OUTER FULL CROSS NATURAL ON
USING AS AND OR NOT IN EXISTS BETWEEN LIKE ILIKE IS NULL INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE PRIMARY
KEY FOREIGN REFERENCES INT INTEGER SMALLINT BIGINT SERIAL VARCHAR CHAR CHARACTER TEXT DATE TIME TIMESTAMP DECIMAL
NUMERIC REAL FLOAT DOUBLE PRECISION BOOLEAN BOOL DISTINCT ALL ANY SOME COUNT SUM AVG MIN MAX UNION INTERSECT EXCEPT
CASE WHEN THEN ELSE END LIMIT OFFSET TOP VIEW INDEX UNIQUE DROP ALTER ADD COLUMN CONSTRAINT CHECK DEFAULT TRIGGER
PROCEDURE FUNCTION RETURNS RETURN BEGIN COMMIT ROLLBACK TRANSACTION DECLARE IF EXEC CALL WITH RECURSIVE AUTO_INCREMENT
AUTOINCREMENT TRUE FALSE CAST COALESCE NULLIF UPPER LOWER LENGTH SUBSTRING SUBSTR ROUND NOW CURRENT_DATE SHOW DESC
DESCRIBE USE DATABASE SCHEMA GRANT REVOKE CASCADE TRUNCATE RENAME TO FOR EACH ROW BEFORE AFTER NEW OLD LANGUAGE
PLPGSQL""".split())
SPICE_KEEP = set("""sin pulse pwl exp sffm dc ac dec oct lin tran op noise tf model param include lib end ends subckt
options plot print probe temp step meas""".split())

C_TOKEN = re.compile(r"""
  (?P<ws>\s+)
| (?P<lc>//[^\n]*)
| (?P<bc>/\*.*?(?:\*/|\Z))
| (?P<str>"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)
| (?P<num>(?:0[xX][0-9a-fA-F]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[a-zA-Z]*)
| (?P<id>[A-Za-z_$][\w$]*)
| (?P<op>>>>=|<<=|>>=|>>>|\.\.\.|::|->|\+\+|--|&&|\|\||==|!=|<=|>=|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|=>|.)
""", re.S | re.X)
PY_TOKEN = re.compile(r"""
  (?P<nl>\n)
| (?P<ws>[ \t\f\r]+|\\\r?\n)
| (?P<com>\#[^\n]*)
| (?P<str>(?:[rRbBuUfF]{1,2})?(?:'''(?:\\.|[^\\])*?(?:'''|\Z)|\"\"\"(?:\\.|[^\\])*?(?:\"\"\"|\Z)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?))
| (?P<num>(?:0[xXoObB][0-9a-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[jJlL]?)
| (?P<id>[^\W\d]\w*)
| (?P<op>\*\*=|//=|>>=|<<=|->|:=|\*\*|//|==|!=|<=|>=|\+=|-=|\*=|/=|%=|&=|\|=|\^=|<<|>>|.)
""", re.S | re.X)
SQL_TOKEN = re.compile(r"""
  (?P<ws>\s+)
| (?P<lc>--[^\n]*)
| (?P<bc>/\*.*?(?:\*/|\Z))
| (?P<str>'(?:''|[^'])*'?)
| (?P<qid>"(?:""|[^"])*"?|`[^`]*`?)
| (?P<num>\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)
| (?P<id>[A-Za-z_][\w$]*)
| (?P<op><>|!=|<=|>=|\|\||::|.)
""", re.S | re.X)
WORD = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*")
INCLUDE = re.compile(r"(?m)^[ \t]*#[ \t]*include\b[^\n]*")


def norm_comment(text):
    """A comment as it is compared: lower case, single spaces, no comment marks; short ones are dropped."""
    s = re.sub(r"^[\s/*#!;\-]+|[\s*/]+$", "", text)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s if len(s) >= 12 and len(s.split()) >= 3 else None


def _comments(text, line, out):
    for n, part in enumerate(text.split("\n")):
        c = norm_comment(part)
        if c:
            out.append((c, line + n))


def lex_c(text, keep):
    toks, coms, line = [], [], 1
    for m in C_TOKEN.finditer(INCLUDE.sub("", text)):
        kind, s = m.lastgroup, m.group()
        if kind == "id":
            toks.append((s if s in keep or s.startswith("$") else "V", s, "kw" if s in keep or s.startswith("$") else "id", line))
        elif kind == "num":
            toks.append(("N", s, "num", line))
        elif kind == "str":
            toks.append(("S", s, "str", line))
        elif kind == "op":
            toks.append((s, s, "op", line))
        elif kind in ("lc", "bc"):
            _comments(s, line, coms)
        line += s.count("\n")
    return toks, coms


def lex_python(text):
    toks, coms, line = [], [], 1
    depth, at_start, line_start, stack = 0, True, 0, [0]
    for m in PY_TOKEN.finditer(text):
        kind, s = m.lastgroup, m.group()
        if kind == "nl":
            line += 1
            line_start = m.end()
            if depth == 0:
                at_start = True
            continue
        if kind == "ws":
            line += s.count("\n")
            continue
        if kind == "com":
            _comments(s, line, coms)
            continue
        if at_start:
            at_start = False
            indent = len(text[line_start:m.start()].expandtabs(8))
            if indent > stack[-1]:
                stack.append(indent)
                toks.append(("INDENT", "", "op", line))
            while indent < stack[-1] and len(stack) > 1:
                stack.pop()
                toks.append(("DEDENT", "", "op", line))
        if kind == "id":
            toks.append((s if s in PY_KEEP else "V", s, "kw" if s in PY_KEEP else "id", line))
        elif kind == "num":
            toks.append(("N", s, "num", line))
        elif kind == "str":
            toks.append(("S", s, "str", line))
        else:
            if s in "([{":
                depth += 1
            elif s in ")]}":
                depth = max(0, depth - 1)
            toks.append((s, s, "op", line))
        line += s.count("\n")
    return toks, coms


def lex_sql(text):
    toks, coms, line = [], [], 1
    for m in SQL_TOKEN.finditer(text):
        kind, s = m.lastgroup, m.group()
        if kind == "id":
            up = s.upper()
            toks.append((up, s, "kw", line) if up in SQL_KEEP else ("V", s, "id", line))
        elif kind == "qid":
            toks.append(("V", s, "id", line))
        elif kind == "num":
            toks.append(("N", s, "num", line))
        elif kind == "str":
            toks.append(("S", s, "str", line))
        elif kind == "op":
            toks.append((s, s, "op", line))
        elif kind in ("lc", "bc"):
            _comments(s, line, coms)
        line += s.count("\n")
    return toks, coms


def lex_spice(text):
    toks, coms = [], []
    for line, raw in enumerate(text.split("\n"), 1):
        s = raw.strip()
        if not s:
            continue
        if s.startswith("*"):
            _comments(s[1:], line, coms)
            continue
        if ";" in s:
            s, c = s.split(";", 1)
            _comments(c, line, coms)
        first = not s.startswith("+")
        for p in re.findall(r"[A-Za-z_.$][\w.$#]*|[-+]?\d[\w.+\-]*|\S", s.lstrip("+")):
            low = p.lower()
            if first and not low.startswith("."):
                toks.append(("E:" + low[0], p, "kw", line))      # an element: its type (R, C, V ...) counts, not its name
            elif low.startswith(".") or low in SPICE_KEEP:
                toks.append((low, p, "kw", line))
            elif re.match(r"[-+]?\d", p):
                toks.append(("N", p, "num", line))
            elif re.match(r"[A-Za-z_$]", p):
                toks.append(("V", p, "id", line))
            else:
                toks.append((p, p, "op", line))
            first = False
        toks.append(("EOL", "", "op", line))
    return toks, coms


def lex_text(text):
    toks = []
    for line, raw in enumerate(text.split("\n"), 1):
        for w in WORD.findall(raw):
            toks.append((w.lower(), w, "word", line))
    return toks, []


LEXERS = {"c": lambda t: lex_c(t, C_KEEP), "cpp": lambda t: lex_c(t, CPP_KEEP), "java": lambda t: lex_c(t, JAVA_KEEP),
          "js": lambda t: lex_c(t, JS_KEEP), "python": lex_python, "sql": lex_sql, "spice": lex_spice, "text": lex_text}


# ---------------------------------------------------------------------------------- one student's work in one lab
class Doc:
    """One student's files for one comparison, as one token list (files kept apart by separators)."""

    def __init__(self, student, bucket, files, symbols, separators):
        _, lexer, self.mml = BUCKETS[bucket]
        self.student, self.bucket, self.files = student, bucket, files
        self.syms, self.raw, self.kind, self.where, self.comments = [], [], [], [], {}
        lex = LEXERS[lexer]
        for fi, (_, text) in enumerate(files):
            toks, coms = lex(text)
            room = TOKENS_MAX - len(self.syms)
            for sym, raw, kind, line in toks[:max(0, room)]:
                self.syms.append(symbols.setdefault(sym, len(symbols)))
                self.raw.append(raw)
                self.kind.append(kind)
                self.where.append((fi, line))
            for c, line in coms:
                self.comments.setdefault(c, (fi, line))
            self.syms.append(next(separators))           # a token no other file has: no match runs across files
            self.raw.append("")
            self.kind.append("sep")
            self.where.append((fi, 0))
        n = len(self.syms)
        # Hashes of every stretch of k, 2k, 4k and 8k tokens (k: the minimum match length). How many
        # students have a stretch says how common it is; the longer stretches keep a whole copied
        # program distinctive even when each short piece of it is standard code.
        self.scales = tuple(self.mml * f for f in SCALE_FACTORS)
        seps = [0, *accumulate(1 if s < 0 else 0 for s in self.syms)]
        vals = [(s * 0x9E3779B97F4A7C15 + 0x632BE59BD9B4E019) % HASH_MOD for s in self.syms]
        prefix = [0] * (n + 1)
        for i, v in enumerate(vals):
            prefix[i + 1] = (prefix[i] * HASH_MUL + v) % HASH_MOD
        self.windows = {}
        for length in self.scales:
            p = pow(HASH_MUL, length, HASH_MOD)
            self.windows[length] = [(prefix[i + length] - prefix[i] * p) % HASH_MOD if seps[i + length] == seps[i] else None
                                    for i in range(max(0, n - length + 1))]
        self.grams = self.windows[self.mml]
        self.signature = hashlib.sha256(b"\0".join(norm_text(t) for _, t in files)).hexdigest()
        self.ignored = bytearray(1 if s < 0 else 0 for s in self.syms)   # separators: never part of a match
        self.base = bytearray(n)           # code the teacher gave the students: never counts
        self.common = bytearray(n)         # standard code many students have (shown in the report)
        self.own = 0
        self.tokens = sum(1 for s in self.syms if s >= 0)


def gst(a, b):
    """Greedy string tiling: the longest runs of tokens a and b share, in any order, none shorter than
    the minimum match length and none using a token twice. Returns [(start in a, start in b, length)]."""
    k = a.mml
    sa, sb = a.syms, b.syms
    na, nb = len(sa), len(sb)
    ma, mb = bytearray(a.ignored), bytearray(b.ignored)
    tiles = []
    while True:
        pa = [0, *accumulate(ma)]
        index = defaultdict(list)
        for i, g in enumerate(a.grams):
            if g is not None and pa[i + k] == pa[i]:
                index[g].append(i)
        if not index:
            break
        pb = [0, *accumulate(mb)]
        best, found, reach = 0, [], {}
        for j, g in enumerate(b.grams):
            if g is None or pb[j + k] != pb[j]:
                continue
            cands = index.get(g)
            if not cands:
                continue
            for i in cands:
                d = i - j
                if reach.get(d, -1) > j:              # inside a run already followed on this diagonal
                    continue
                n = 0
                while i + n < na and j + n < nb and sa[i + n] == sb[j + n] and not ma[i + n] and not mb[j + n]:
                    n += 1
                reach[d] = j + n
                if n < k:
                    continue
                if n > best:
                    best, found = n, [(i, j, n)]
                elif n == best:
                    found.append((i, j, n))
        if not found:
            break
        for i, j, n in found:
            if any(ma[i:i + n]) or any(mb[j:j + n]):
                continue
            ma[i:i + n] = b"\x01" * n
            mb[j:j + n] = b"\x01" * n
            tiles.append((i, j, n))
    return tiles


def lis_length(seq):
    tails = []
    for x in seq:
        lo, hi = 0, len(tails)
        while lo < hi:
            mid = (lo + hi) // 2
            if tails[mid] < x:
                lo = mid + 1
            else:
                hi = mid
        tails[lo:lo + 1] = [x]
    return len(tails)


def level_of(score):
    for key, at_least, _ in LEVELS:
        if score >= at_least:
            return key
    return "low"


# ---------------------------------------------------------------------------------- submissions zips
def enrol_key(enrolment):
    return re.sub(r"[\s/._-]", "", str(enrolment or "")).upper()


def zip_time(info):
    try:
        return time.mktime(tuple(info.date_time) + (0, 0, -1))
    except (OverflowError, ValueError):
        return 0.0


def clean_rel(rel):
    """A path inside a student's folder, made safe to write (None if nothing is left)."""
    parts = [safe_name(p, limit=120) for p in rel.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return "/".join(parts) or None


def _csv(z, name):
    try:
        text = z.read(name).decode("utf-8-sig", "replace")
    except KeyError:
        return []
    return [r for r in csv.DictReader(io.StringIO(text)) if r]


class Source:
    """One lab server's submissions zip (or an earlier merged one)."""

    def __init__(self, path, label=None):
        self.path = Path(path)
        try:
            self.zip = zipfile.ZipFile(self.path)
        except (zipfile.BadZipFile, OSError) as e:
            raise ValueError(f"{self.path.name} is not a zip file.") from e
        infos = [i for i in self.zip.infolist() if not i.is_dir()]
        tops = {i.filename.split("/", 1)[0] for i in infos if "/" in i.filename}
        if len(tops) != 1 or not any(i.filename.count("/") == 1 and i.filename.endswith("/roster.csv") for i in infos):
            self.zip.close()
            raise ValueError(f"{self.path.name} is not a submissions zip from a FoCT lab server "
                             "(use Download submissions on the exam control page).")
        self.top = tops.pop()
        try:
            self.meta = json.loads(self.zip.read(f"{self.top}/exam.json"))
            if not isinstance(self.meta, dict):
                self.meta = {}
        except (KeyError, ValueError):
            self.meta = {}
        server = self.meta.get("server") if isinstance(self.meta.get("server"), dict) else {}
        self.title = str(self.meta.get("title") or self.top)
        self.address = str(server.get("address") or "")
        self.label = str(label or server.get("name") or self.path.stem)
        self.merged = bool(self.meta.get("merged"))
        self.started, self.ended = self.meta.get("started"), self.meta.get("ended")
        self.roster = _csv(self.zip, f"{self.top}/roster.csv")
        self.incidents = _csv(self.zip, f"{self.top}/incidents.csv")
        self.folders = defaultdict(dict)                 # student folder -> {path inside it: ZipInfo}
        for i in infos:
            parts = i.filename.split("/")
            if len(parts) >= 3 and parts[0] == self.top and parts[2]:
                self.folders[parts[1]]["/".join(parts[2:])] = i
        self.digest = None

    def sha(self):
        if self.digest is None:
            h = hashlib.sha256()
            with open(self.path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            self.digest = h.hexdigest()
        return self.digest

    def students(self):
        """[(folder, roster row, {path: ZipInfo})] for every student in this zip."""
        rows = {r.get("Folder", ""): r for r in self.roster if r.get("Folder")}
        out = []
        for folder, files in self.folders.items():
            row = rows.get(folder) or self._from_student_txt(folder, files)
            if row.get("Enrolment no."):
                out.append((folder, row, files))
        for folder, row in rows.items():
            if folder not in self.folders and row.get("Enrolment no."):
                out.append((folder, row, {}))                # signed in, but sent nothing
        return out

    def _from_student_txt(self, folder, files):
        row = {"Folder": folder}
        info = files.get("_student.txt")
        if info:
            for line in self.zip.read(info).decode("utf-8", "replace").splitlines():
                key, _, value = line.partition(":")
                if key.strip() in ("Name", "Enrolment no.", "PC"):
                    row[key.strip()] = value.strip()
        return row

    def close(self):
        self.zip.close()


class Copy:
    """A student's folder in one source zip."""

    def __init__(self, source, folder, row, files):
        self.source, self.folder, self.row, self.files = source, folder, row, files
        self.first = row.get("Signed in") or ""
        self.saved = row.get("Last saved") or ""
        self.label = source.label


class Student:
    def __init__(self, key):
        self.key = key
        self.copies = []
        self.name = self.enrolment = self.folder = ""
        self.files = {}                                   # path in the merged folder -> (Copy, ZipInfo)
        self.incidents = []
        self.sid = 0

    def servers(self):
        return list(dict.fromkeys(c.source.label for c in self.copies))

    def pcs(self):
        out = []
        for c in self.copies:
            out += [p.strip() for p in (c.row.get("PC") or "").split(";") if p.strip()]
        return list(dict.fromkeys(out))

    def alerts(self):
        out, many = [], len(self.copies) > 1
        for c in self.copies:
            a = (c.row.get("Alerts") or "").strip()
            if a:
                out.append(f"{c.label}: {a}" if many and not c.source.merged else a)
        return out


def _digest(copy, info):
    h = hashlib.sha256()
    with copy.source.zip.open(info) as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Merged:
    """The exam put together from every source zip."""

    def __init__(self, sources, title=None):
        self.sources = []
        seen = {}
        for s in sources:                                  # the same zip twice counts once
            if s.sha() in seen:
                continue
            seen[s.sha()] = s
            self.sources.append(s)
        used = Counter()
        for s in self.sources:                             # every source gets a name of its own
            used[s.label] += 1
            if used[s.label] > 1:
                s.label = f"{s.label} ({used[s.label]})"
        titles = Counter(s.title for s in self.sources)
        self.title = (title or "").strip() or (titles.most_common(1)[0][0] if titles else "Exam")
        self.titles = list(titles)
        by_key = {}
        for s in self.sources:
            for folder, row, files in s.students():
                key = enrol_key(row.get("Enrolment no.")) or f"?{s.label}/{folder}"
                st = by_key.setdefault(key, Student(key))
                st.copies.append(Copy(s, folder, row, files))
        self.students = sorted(by_key.values(), key=lambda st: st.key)
        names = set()
        for n, st in enumerate(self.students):
            st.sid = n
            latest = max(st.copies, key=lambda c: (c.saved, c.first))
            st.name = (latest.row.get("Name") or "").strip() or latest.folder
            st.enrolment = (latest.row.get("Enrolment no.") or "").strip()
            folder = safe_name(f"{st.name}_{st.enrolment}", fallback="student", limit=120)
            base, k = folder, 2
            while folder.lower() in names:
                folder, k = f"{base} ({k})", k + 1
            names.add(folder.lower())
            st.folder = folder
            self._files(st)
        by_enrol = {st.key: st for st in self.students}
        for s in self.sources:
            for row in s.incidents:
                st = by_enrol.get(enrol_key(row.get("Enrolment no.")))
                if st:
                    st.incidents.append(dict(row, Server=row.get("Server") or s.label))
        for st in self.students:
            st.incidents.sort(key=lambda r: r.get("Time", ""))

    @staticmethod
    def _files(st):
        """Newest version of every file on top; other versions (another server, another PC) under Other copies."""
        versions = defaultdict(list)
        per_source = Counter(c.source.label for c in st.copies)
        for c in st.copies:
            for rel, info in c.files.items():
                if rel == "_student.txt":
                    continue
                rel = clean_rel(rel)
                if rel:
                    versions[rel].append((zip_time(info), info.file_size, c, info))
        for rel, vs in versions.items():
            vs.sort(key=lambda v: (v[0], v[1]), reverse=True)
            st.files[rel] = (vs[0][2], vs[0][3])
            if len(vs) == 1:
                continue
            seen = {_digest(vs[0][2], vs[0][3])}
            for _, _, c, info in vs[1:]:
                d = _digest(c, info)
                if d in seen:
                    continue
                seen.add(d)
                where = c.label if per_source[c.source.label] == 1 else f"{c.label} - {c.folder}"
                st.files[f"{OTHER}/{safe_name(where, limit=80)}/{rel}"] = (c, info)

    # ------------------------------------------------------------------ writing
    def write(self, top, progress=None):
        """Write the merged exam into the folder top (created)."""
        top = Path(top)
        top.mkdir(parents=True, exist_ok=True)
        for n, st in enumerate(self.students):
            if progress:
                progress("Merging", n, len(self.students))
            home = top / st.folder
            home.mkdir(parents=True, exist_ok=True)
            for rel, (copy, info) in st.files.items():
                target = home.joinpath(*rel.split("/"))
                target.parent.mkdir(parents=True, exist_ok=True)
                with copy.source.zip.open(info) as src, open(target, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1 << 20)
                t = zip_time(info)
                if t:
                    os.utime(target, (t, t))
            (home / "_student.txt").write_bytes(self.student_txt(st).replace("\n", "\r\n").encode("utf-8"))
        self._csv(top / "roster.csv", ["Name", "Enrolment no.", "Folder", "Servers", "PC", "Signed in", "Last saved",
                                       "Files", "Size (KB)", "Locked", "Alerts", "Note"], self.roster_rows())
        self._csv(top / "incidents.csv", ["Server", "Name", "Enrolment no.", "Time", "Event", "Detail", "Seconds"],
                  [[r.get("Server", ""), st.name, st.enrolment, r.get("Time", ""), r.get("Event", ""), r.get("Detail", ""),
                    r.get("Seconds", "")] for st in self.students for r in st.incidents])
        self._csv(top / "servers.csv", ["Server", "Address", "Exam title", "Exam started", "Exam ended", "Zip file", "Students"],
                  [[s.label, s.address, s.title, _stamp(s.started), _stamp(s.ended), s.path.name, len(s.students())]
                   for s in self.sources])
        (top / "exam.json").write_bytes(json.dumps({
            "app": "FoCT Virtual Labs", "kind": "submissions", "merged": True, "title": self.title,
            "created": time.time(), "students": len(self.students),
            "sources": [{"server": s.label, "address": s.address, "title": s.title, "zip": s.path.name} for s in self.sources],
            "server": {"name": "Merged: " + ", ".join(s.label for s in self.sources)}}, indent=1).encode("utf-8"))

    def student_txt(self, st):
        lines = [f"Name: {st.name}", f"Enrolment no.: {st.enrolment}", f"Exam: {self.title}"]
        for c in st.copies:
            r = c.row
            lines.append(f"Server: {c.label} (folder {c.folder}) - PC {r.get('PC', '')}, signed in {c.first}, "
                         f"last saved {c.saved}")
        alerts = st.alerts()
        lines.append("Alerts:")
        lines += [f"  {a}" for a in alerts] or ["  none"]
        if any(rel.startswith(OTHER + "/") for rel in st.files):
            lines.append(f'Some files came from more than one server or PC: the newest copy is here, the others are in '
                         f'"{OTHER}".')
        return "\n".join(lines) + "\n"

    def roster_rows(self):
        rows = []
        for st in self.students:
            files = [i for rel, (_, i) in st.files.items()]
            locked = "; ".join(dict.fromkeys(c.row.get("Locked", "") for c in st.copies if c.row.get("Locked")))
            notes = [c.row.get("Note", "") for c in st.copies if c.row.get("Note")]
            if len(st.copies) > 1:
                notes.append(f"worked on {len(st.copies)} servers or PCs")
            rows.append([st.name, st.enrolment, st.folder, "; ".join(st.servers()), "; ".join(st.pcs()),
                         min((c.first for c in st.copies if c.first), default=""),
                         max((c.saved for c in st.copies if c.saved), default=""),
                         len(files), round(sum(i.file_size for i in files) / 1024), locked, " | ".join(st.alerts()),
                         "; ".join(dict.fromkeys(notes))])
        return rows

    @staticmethod
    def _csv(path, header, rows):
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(header)
        w.writerows(rows)
        path.write_bytes(("\ufeff" + buf.getvalue()).encode("utf-8"))     # BOM: Excel opens it as UTF-8

    def close(self):
        for s in self.sources:
            s.close()


def _stamp(t):
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(t))) if t else ""
    except (TypeError, ValueError, OverflowError):
        return ""


# ---------------------------------------------------------------------------------- the similarity check
class Check:
    def __init__(self, merged, base=(), share=COMMON_SHARE, progress=None):
        self.merged, self.share, self.progress = merged, share, progress or (lambda *a: None)
        self.symbols, self.seps = {}, itertools.count(-1, -1)
        self.base_files = list(base)                      # [(file name, bytes)] the teacher gave the students
        self.base_names = [name for name, _ in self.base_files]
        self.common_windows = {}                          # comparison -> {stretch length: hashes many students have}
        self.docs = defaultdict(list)
        self.pairs, self.groups, self.identical, self.commons = [], [], [], []
        self.stats = {}

    def run(self):
        self._read()
        for b in self.docs:
            self._prepare(b)
        work = [(b, x, y) for b in self.docs for x, y in self._candidates(b)]
        for n, (b, x, y) in enumerate(work):
            if n % 25 == 0:
                self.progress("Comparing", n, len(work))
            r = self._pair(self.docs[b][x], self.docs[b][y])
            if r:
                self.pairs.append(r)
        self.pairs.sort(key=lambda p: (-p["score"], -p["matched"]))
        self._groups()
        self._identical()
        self.progress("Comparing", len(work), len(work))
        return self

    # ---------------------------------------------------------------- reading the students' files
    def _read(self):
        for n, st in enumerate(self.merged.students):
            self.progress("Reading", n, len(self.merged.students))
            per, seen = defaultdict(list), set()
            lab_names = defaultdict(set)
            items = sorted(st.files.items(), key=lambda kv: (kv[0].split("/", 1)[0] in ("Saved files", "Submitted files"), kv[0]))
            for rel, (copy, info) in items:
                b = bucket_for(rel)
                if not b or info.file_size > FILE_MAX:
                    continue
                top, name = rel.split("/", 1)[0], rel.rsplit("/", 1)[-1]
                if top == "Saved files" and name in lab_names[b]:
                    continue                                 # an earlier save of a file the lab sent anyway
                text = file_text(rel, copy.source.zip.read(info))
                if not text.strip():
                    continue
                sig = (b, hashlib.sha256(norm_text(text)).digest())
                if sig in seen:
                    continue
                seen.add(sig)
                per[b].append((rel, text))
                if top in DIR_BUCKET:
                    lab_names[b].add(name)
            for b, files in per.items():
                self.docs[b].append(Doc(st, b, files, self.symbols, self.seps))

    # ---------------------------------------------------------------- what is left out
    def _base(self, b):
        """The teacher's material for comparison b: (gram hashes, comments), in this check's symbol table."""
        grams, comments = set(), set()
        for name, data in self.base_files:
            bucket = EXT_BUCKET.get(os.path.splitext(name)[1].lower())
            if bucket != b and b not in BASE_ALSO.get(bucket, ()):
                continue
            doc = Doc(None, b, [(name, file_text(name, data))], self.symbols, self.seps)
            grams |= {g for g in doc.grams if g is not None}
            comments |= set(doc.comments)
        return grams, comments

    def _prepare(self, b):
        """What is given and what is common, for comparison b. A stretch of code is common when more than
        `most` students have it. Shared code counts as evidence only where it lies in a stretch (of
        k, 2k, 4k or 8k tokens) that is not common: a whole copied program counts even if each of its
        parts is standard, a standard function on its own does not. Given code never counts."""
        docs = self.docs[b]
        students = len(docs)
        most = max(COMMON_MIN, round(self.share * students))
        base_grams, base_comments = self._base(b)
        common = {}
        for length in docs[0].scales:
            counts = Counter()
            for d in docs:
                counts.update({g for g in d.windows[length] if g is not None})
            common[length] = {g for g, c in counts.items() if c > most}
        com_counts = Counter(c for d in docs for c in d.comments)
        self.stats[b] = {"students": students, "most": most, "mml": docs[0].mml,
                         "common_comments": {c for c, n in com_counts.items() if n > most} | set(base_comments)}
        self.common_windows[b] = common
        total = given = standard = 0
        for d in docs:
            k = d.mml
            for i, g in enumerate(d.grams):
                if g is None:
                    continue
                if g in base_grams:
                    d.base[i:i + k] = b"\x01" * k
                elif g in common[k]:
                    d.common[i:i + k] = b"\x01" * k
            d.own = sum(1 for i, s in enumerate(d.syms) if s >= 0 and not d.base[i])
            total += d.tokens
            given += d.tokens - d.own
            standard += sum(1 for i, s in enumerate(d.syms) if s >= 0 and d.common[i] and not d.base[i])
        self.stats[b]["given"] = given / total if total else 0.0
        self.stats[b]["standard"] = standard / total if total else 0.0
        self._common_examples(b, common[docs[0].mml])

    def _common_examples(self, b, common):
        """The code most students share (left out), to show in the report."""
        runs = {}
        for d in self.docs[b]:
            i, n = 0, len(d.syms)
            while i < n:
                if not d.common[i]:
                    i += 1
                    continue
                j = i
                while j < n and d.common[j] and d.syms[j] >= 0:
                    j += 1
                if j - i >= 2 * d.mml:
                    key = hash(tuple(d.syms[i:j]))
                    r = runs.setdefault(key, {"doc": d, "start": i, "end": j - 1, "students": set()})
                    r["students"].add(d.student.sid)
                i = max(j, i + 1)
        best = sorted(runs.values(), key=lambda r: (len(r["students"]), r["end"] - r["start"]), reverse=True)[:3]
        for r in best:
            d = r["doc"]
            (fi, l1), (_, l2) = d.where[r["start"]], d.where[r["end"]]
            lines = d.files[fi][1].split("\n")[l1 - 1:l2]
            self.commons.append({"bucket": b, "students": len(r["students"]), "of": len(self.docs[b]),
                                 "text": "\n".join(lines)[:2000]})

    # ---------------------------------------------------------------- pairs
    def _candidates(self, b):
        """Pairs of students who share at least one stretch that is not common: only those can count."""
        docs = self.docs[b]
        common = self.common_windows[b]
        index = defaultdict(list)
        for n, d in enumerate(docs):
            keys = set()
            for length, hashes in d.windows.items():
                keys.update((length, g) for g in hashes if g is not None and g not in common[length])
            for key in keys:
                index[key].append(n)
        pairs = set()
        for lst in index.values():
            if len(lst) > 1:
                for x in range(len(lst)):
                    for y in range(x + 1, len(lst)):
                        pairs.add((lst[x], lst[y]))
        return sorted(pairs)

    def _counts(self, a, i, n):
        """Which tokens of a match (n tokens of a, from i) count: inside a stretch that is not common."""
        common = self.common_windows[a.bucket]
        counts = bytearray(n)
        for length in a.scales:
            if length > n:
                break
            hashes, rare = a.windows[length], common[length]
            ones = b"\x01" * length
            for s in range(i, i + n - length + 1):
                g = hashes[s]
                if g is not None and g not in rare:
                    counts[s - i:s - i + length] = ones
        return counts

    def _pair(self, a, b):
        if not a.own or not b.own:
            return None
        tiles = []          # (start in a, start in b, length, tokens that count in a, ... in b, which count)
        for i, j, n in gst(a, b):
            counts = self._counts(a, i, n)                # the same tokens on both sides: the same stretches
            ca = sum(1 for t in range(n) if counts[t] and not a.base[i + t])
            cb = sum(1 for t in range(n) if counts[t] and not b.base[j + t])
            if min(ca, cb) >= 3:        # a match made (nearly) only of given or common code is no evidence
                tiles.append((i, j, n, ca, cb, counts))
        matched_a, matched_b = sum(t[3] for t in tiles), sum(t[4] for t in tiles)
        if min(matched_a, matched_b) < MIN_MATCH:
            return None
        pa, pb = matched_a / a.own, matched_b / b.own
        score = max(pa, pb)
        if score < LOW_SHOWN:
            return None
        ids = ids_same = lits = lits_same = 0
        for i, j, n, _, _, counts in tiles:
            for t in range(n):
                if not counts[t] or a.base[i + t]:
                    continue
                kind = a.kind[i + t]
                if kind == "id":
                    ids += 1
                    ids_same += a.raw[i + t] == b.raw[j + t]
                elif kind in ("str", "num"):
                    lits += 1
                    lits_same += a.raw[i + t] == b.raw[j + t]
        tiles.sort()
        matched = min(matched_a, matched_b)
        moved = len(tiles) - lis_length([t[1] for t in tiles]) if len(tiles) > 1 else 0
        common_comments = self.stats[a.bucket]["common_comments"]
        comments = sorted(c for c in a.comments.keys() & b.comments.keys() if c not in common_comments)
        blocks = []                    # the parts shown side by side: only what counts (not given or standard code)
        for i, j, n, _, _, counts in tiles:
            keep = [bool(counts[t]) and not a.base[i + t] for t in range(n)]
            runs, t = [], 0
            while t < n:
                if not keep[t]:
                    t += 1
                    continue
                s = t
                while t < n and keep[t]:
                    t += 1
                if runs and s - runs[-1][1] <= 3:       # a gap of a token or three: still one part
                    runs[-1][1] = t
                else:
                    runs.append([s, t])
            for s, e in runs:
                (fa, la1), (_, la2) = a.where[i + s], a.where[i + e - 1]
                (fb, lb1), (_, lb2) = b.where[j + s], b.where[j + e - 1]
                blocks.append([fa, la1, la2, fb, lb1, lb2, e - s])
        lines_a = len({(f, ln) for f, l1, l2, *_ in blocks for ln in range(l1, l2 + 1)})
        lines_b = len({(f, ln) for _, _, _, f, l1, l2, _ in blocks for ln in range(l1, l2 + 1)})
        identical = a.signature == b.signature
        text = a.bucket == "text"
        level = level_of(score)
        verbatim = bool(comments) and ids and ids_same / ids >= 0.85
        raised = level == "low" and verbatim          # a smaller part copied word for word, comments and all
        if raised:
            level = "medium"
        return {"bucket": a.bucket, "a": a.student.sid, "b": b.student.sid, "da": a, "db": b,
                "pa": round(pa, 3), "pb": round(pb, 3), "score": round(score, 3), "level": level,
                "matched": matched, "own_a": a.own, "own_b": b.own, "lines_a": lines_a, "lines_b": lines_b,
                "short": min(a.own, b.own) < SHORT, "identical": identical,
                "names": None if text or not ids else round(ids_same / ids, 3),
                "texts": None if text or not lits else round(lits_same / lits, 3),
                "moved": moved, "comments": comments[:12], "blocks": blocks,
                "how": self._how(identical, text, ids, ids_same, lits, lits_same, moved, comments, len(tiles), matched,
                                 score, raised)}

    @staticmethod
    def _how(identical, text, ids, ids_same, lits, lits_same, moved, comments, ntiles, matched, score, raised):
        """Plain sentences that say how the two pieces of work match."""
        out = []
        if identical:
            out.append("The two are identical, character for character (spacing aside).")
        elif text:
            out.append(f"{ntiles} passage{'s' if ntiles != 1 else ''} of the same text, {matched} words in all.")
        else:
            names = ids_same / ids if ids else 1.0
            lit = lits_same / lits if lits else 1.0
            if names >= 0.85 and lit >= 0.8:
                out.append("The matching code is the same even in its names and its texts: copied as it is.")
            elif names <= 0.5 and score >= 0.6:
                out.append("The matching code has the same structure, but most names are different: names were changed, "
                           "a common way to hide copying.")
            elif names <= 0.5:
                out.append("The matching parts have the same structure but different names: a disguised copy, or the "
                           "same standard solution written separately. Look at them side by side.")
            else:
                out.append("The matching code has the same structure; some names or texts are different.")
        if moved:
            out.append(f"{moved} matching part{'s were' if moved != 1 else ' was'} moved to another place.")
        if comments:
            out.append(f"{len(comments)} identical comment{'s' if len(comments) != 1 else ''}: comments are personal, "
                       f"so this is strong evidence.")
        if raised:
            out.append("Listed as Medium although under 40%: a smaller part was copied word for word, comments included.")
        return out

    def _groups(self):
        """Students who share code in threes or more (pairs High or above, per lab)."""
        for b in self.docs:
            parent = {}

            def find(x):
                while parent.setdefault(x, x) != x:
                    parent[x] = parent[parent[x]]
                    x = parent[x]
                return x
            strong = [p for p in self.pairs if p["bucket"] == b and p["level"] in ("vhigh", "high")]
            for p in strong:
                parent[find(p["a"])] = find(p["b"])
            members = defaultdict(set)
            for p in strong:
                members[find(p["a"])].update((p["a"], p["b"]))
            for m in members.values():
                if len(m) >= 3:
                    inside = [p for p in strong if p["a"] in m]
                    self.groups.append({"bucket": b, "members": sorted(m), "score": max(p["score"] for p in inside),
                                        "pairs": len(inside)})
        self.groups.sort(key=lambda g: (-len(g["members"]), -g["score"]))

    def _identical(self):
        """The very same file in the folders of two or more students."""
        groups = defaultdict(list)
        students = len(self.merged.students)
        most = max(COMMON_MIN, round(self.share * students))
        for st in self.merged.students:
            seen = set()
            for rel, (copy, info) in st.files.items():
                top, name = rel.split("/", 1)[0], rel.rsplit("/", 1)[-1]
                if top == OTHER or top.startswith(EARLIER) or name == "_student.txt" or not 64 <= info.file_size <= FILE_MAX:
                    continue
                data = copy.source.zip.read(info)
                if os.path.splitext(name)[1].lower() in TEXTLIKE:
                    data = norm_text(decode(data))
                h = hashlib.sha256(data).hexdigest()
                if h in seen:
                    continue
                seen.add(h)
                groups[h].append({"student": st.sid, "path": rel, "size": info.file_size})
        for h, items in groups.items():
            n = len({i["student"] for i in items})
            if 2 <= n <= most:
                self.identical.append({"name": items[0]["path"].rsplit("/", 1)[-1], "size": items[0]["size"], "files": items})
        self.identical.sort(key=lambda g: (-len(g["files"]), -g["size"]))


# ---------------------------------------------------------------------------------- report
def report_data(check, created=None):
    merged = check.merged
    docs, doc_ids = [], {}

    def doc_id(d):
        if id(d) not in doc_ids:
            doc_ids[id(d)] = len(docs)
            docs.append({"student": d.student.sid, "bucket": d.bucket,
                         "files": [{"path": p, "text": t[:SHOW_MAX]} for p, t in d.files]})
        return doc_ids[id(d)]

    pairs = []
    for p in check.pairs:
        q = {k: v for k, v in p.items() if k not in ("da", "db")}
        q["da"], q["db"] = doc_id(p["da"]), doc_id(p["db"])
        pairs.append(q)
    students = []
    for st in merged.students:
        students.append({"name": st.name, "enrolment": st.enrolment, "key": st.key, "folder": st.folder,
                         "servers": st.servers(), "pcs": st.pcs(), "alerts": st.alerts(),
                         "labs": sorted(b for b, ds in check.docs.items() if any(d.student is st for d in ds)),
                         "incidents": [{"server": r.get("Server", ""), "time": r.get("Time", ""), "event": r.get("Event", ""),
                                        "detail": r.get("Detail", ""), "secs": r.get("Seconds", "")} for r in st.incidents][-60:]})
    labs = {b: {"name": BUCKETS[b][0], "students": s["students"], "most": s["most"], "mml": s["mml"],
                "given": round(s["given"], 3), "standard": round(s["standard"], 3)} for b, s in check.stats.items()}
    return {"id": hashlib.sha256((merged.title + "".join(s.sha() for s in merged.sources)).encode()).hexdigest()[:16],
            "title": merged.title, "titles": merged.titles, "created": created or time.time(),
            "servers": [{"label": s.label, "address": s.address, "title": s.title, "zip": s.path.name,
                         "students": len(s.students())} for s in merged.sources],
            "settings": {"share": check.share, "min_match": MIN_MATCH, "short": SHORT, "base": check.base_names,
                         "levels": [[k, v, name] for k, v, name in LEVELS]},
            "labs": labs, "students": students, "docs": docs, "pairs": pairs, "groups": check.groups,
            "identical": check.identical, "commons": check.commons}


def report_html(data):
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    blob = blob.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    page = (Path(__file__).resolve().parent / "similarity-report.html").read_text(encoding="utf-8")
    return page.replace("__REPORT_TITLE__", _html_escape(data["title"])).replace("__REPORT_DATA__", blob)


def _html_escape(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def write_csvs(data, top):
    stud = data["students"]
    pct = lambda x: f"{round(x * 100)}%"  # noqa: E731
    levels = dict({k: name for k, _, name in LEVELS}, low="Low")
    rows = []
    for p in data["pairs"]:
        a, b = stud[p["a"]], stud[p["b"]]
        rows.append([levels[p["level"]], pct(p["score"]), data["labs"][p["bucket"]]["name"], a["name"], a["enrolment"],
                     b["name"], b["enrolment"], pct(p["pa"]), pct(p["pb"]), p["lines_a"], p["lines_b"],
                     " ".join(p["how"]), "yes" if p["short"] else "", "", ""])
    Merged._csv(Path(top) / PAIRS_CSV, ["Level", "Similarity", "Lab", "Student A", "Enrolment A", "Student B",
                                        "Enrolment B", "A's code in B", "B's code in A", "Lines A", "Lines B", "How",
                                        "Short program", "Decision", "Note"], rows)
    best = {}
    for p in data["pairs"]:
        for s, other in ((p["a"], p["b"]), (p["b"], p["a"])):
            if s not in best or p["score"] > best[s][0]["score"]:
                best[s] = (p, other)
    group_of = {}
    for n, g in enumerate(data["groups"], 1):
        for s in g["members"]:
            group_of.setdefault(s, f"Group {n} ({data['labs'][g['bucket']]['name']})")
    same_file = Counter(f["student"] for g in data["identical"] for f in g["files"])
    rows = []
    for n, s in enumerate(stud):
        p, other = best.get(n, (None, None))
        rows.append([s["name"], s["enrolment"], "; ".join(s["servers"]),
                     levels[p["level"]] if p else "", pct(p["score"]) if p else "",
                     stud[other]["name"] if p else "", data["labs"][p["bucket"]]["name"] if p else "",
                     group_of.get(n, ""), same_file.get(n, 0) or "", " | ".join(s["alerts"]), "", ""])
    rows.sort(key=lambda r: (-(int(r[4][:-1]) if r[4] else -1), r[1]))
    Merged._csv(Path(top) / STUDENTS_CSV, ["Name", "Enrolment no.", "Servers", "Highest level", "Highest similarity",
                                           "With", "Lab", "Group", "Identical files", "Exam alerts", "Decision",
                                           "Marks note"], rows)


# ---------------------------------------------------------------------------------- the whole job
def zip_folder(top, out_path):
    top = Path(top)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(top.rglob("*")):
            if f.is_file():
                z.write(f, f"{top.name}/{f.relative_to(top).as_posix()}")


def free_folder(root, name):
    base = safe_name(name, fallback="Merged exam")
    folder, n = base, 2
    while (Path(root) / folder).exists():
        folder, n = f"{base} ({n})", n + 1
    return Path(root) / folder


def run(sources, out_root, base=(), title=None, share=COMMON_SHARE, check=True, progress=None, zip_path=None):
    """Merge the sources into a new folder under out_root and (if check) write the similarity report.
    base: [(file name, bytes)] the teacher gave the students. Returns a summary dict."""
    progress = progress or (lambda *a: None)
    merged = Merged(sources, title)
    try:
        top = free_folder(out_root, f"{merged.title} (merged)")
        merged.write(top, progress)
        summary = {"title": merged.title, "titles": merged.titles, "folder": str(top), "students": len(merged.students),
                   "servers": [s.label for s in merged.sources], "both": sum(1 for s in merged.students if len(s.copies) > 1)}
        if check:
            c = Check(merged, base, share, progress).run()
            data = report_data(c)
            (top / REPORT_FILE).write_bytes(report_html(data).encode("utf-8"))
            write_csvs(data, top)
            levels = Counter(p["level"] for p in data["pairs"])
            summary.update(report=str(top / REPORT_FILE), pairs={k: levels.get(k, 0) for k in ("vhigh", "high", "medium")},
                           groups=len(data["groups"]), identical=len(data["identical"]),
                           labs={b: v["name"] for b, v in data["labs"].items()})
        progress("Packing", 0, 1)
        if zip_path:
            zip_folder(top, zip_path)
            summary["zip"] = str(zip_path)
        progress("Done", 1, 1)
        return summary
    finally:
        merged.close()


# ---------------------------------------------------------------------------------- jobs for the server's page
class Jobs:
    """Merge jobs started from the exam control page: uploaded zips, the teacher's own files, progress."""

    def __init__(self, root, out_root):
        self.root, self.out_root = Path(root), Path(out_root)
        self.lock = threading.Lock()
        self.jobs = {}

    def _dir(self, job):
        if not re.fullmatch(r"[0-9a-f]{12}", job or ""):
            raise ValueError("unknown job")
        d = self.root / job
        if job not in self.jobs:
            raise ValueError("unknown job")
        return d

    def new(self):
        self._cleanup()
        job = secrets.token_hex(6)
        (self.root / job / "zips").mkdir(parents=True, exist_ok=True)
        (self.root / job / "base").mkdir(parents=True, exist_ok=True)
        with self.lock:
            self.jobs[job] = {"state": "new", "step": "", "done": 0, "total": 0, "error": None, "result": None,
                              "files": {}}
        return job

    def _cleanup(self, days=2):
        try:
            for d in self.root.iterdir():
                if d.is_dir() and time.time() - d.stat().st_mtime > days * 86400 and d.name not in self.jobs:
                    shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass

    def add(self, job, kind, name, length, stream, limit):
        if kind not in ("zip", "base"):
            raise ValueError("unknown kind")
        if not 0 < length <= limit:
            raise ValueError(f"Files can be at most {limit // 2**20} MB here.")
        with self.lock:
            if not job or job not in self.jobs:
                job = None
        job = job or self.new()
        d = self._dir(job) / ("zips" if kind == "zip" else "base")
        name = safe_name(Path(str(name)).name, fallback="file.zip" if kind == "zip" else "file", limit=120)
        stem, ext = os.path.splitext(name)
        n = 2
        while (d / name).exists():                       # every server's zip has the exam's name: keep them all
            name, n = f"{stem} ({n}){ext}", n + 1
        target = d / name
        tmp = d / f".{name}.part"
        left = length
        with open(tmp, "wb") as f:
            while left > 0:
                chunk = stream.read(min(left, 1 << 20))
                if not chunk:
                    raise ValueError("The upload was cut off.")
                f.write(chunk)
                left -= len(chunk)
        os.replace(tmp, target)
        info = {"name": name, "kind": kind, "size": length}
        if kind == "zip":
            try:
                s = Source(target)
            except ValueError as e:
                target.unlink()
                raise ValueError(str(e)) from None
            info.update(title=s.title, server=s.label, address=s.address, students=len(s.students()),
                        merged=s.merged)
            s.close()
        with self.lock:
            self.jobs[job]["files"][f"{kind}/{name}"] = info
        return job, info

    def remove(self, job, kind, name):
        d = self._dir(job)
        name = safe_name(Path(str(name)).name, limit=120)
        try:
            (d / ("zips" if kind == "zip" else "base") / name).unlink()
        except OSError:
            pass
        with self.lock:
            self.jobs[job]["files"].pop(f"{kind}/{name}", None)

    def status(self, job):
        self._dir(job)
        with self.lock:
            return json.loads(json.dumps(self.jobs[job]))

    def start(self, job, title, share, check, local_zip=None):
        d = self._dir(job)
        with self.lock:
            st = self.jobs[job]
            if st["state"] == "running":
                raise ValueError("This merge is running already.")
            st.update(state="running", step="Starting", done=0, total=0, error=None, result=None)

        def progress(step, done, total):
            with self.lock:
                st.update(step=step, done=done, total=total)

        def work():
            sources = []
            try:
                paths = sorted((d / "zips").glob("*.zip"))
                if local_zip:
                    paths.insert(0, local_zip)
                if not paths:
                    raise ValueError("Add at least one submissions zip.")
                sources = [Source(p) for p in paths]
                base = [(p.name, p.read_bytes()) for p in sorted((d / "base").iterdir()) if p.is_file()]
                result = run(sources, self.out_root, base, title, share, check, progress, zip_path=d / "merged.zip")
                with self.lock:
                    st.update(state="done", result=result)
            except Exception as e:  # noqa: BLE001 - shown to the teacher
                for s in sources:
                    s.close()
                with self.lock:
                    st.update(state="error", error=str(e) or type(e).__name__)
        threading.Thread(target=work, daemon=True, name=f"merge-{job}").start()

    def result_file(self, job, which):
        d = self._dir(job)
        with self.lock:
            res = self.jobs[job].get("result") or {}
        if which == "zip":
            return d / "merged.zip", f"{Path(res.get('folder', 'Merged exam')).name}.zip"
        if which == "report" and res.get("report"):
            return Path(res["report"]), REPORT_FILE
        raise FileNotFoundError("Not ready")


# ---------------------------------------------------------------------------------- command line
def main(argv=None):
    ap = argparse.ArgumentParser(description="Merge the submissions zips of several FoCT Virtual Labs servers "
                                             "and check the students' work for similarity.")
    ap.add_argument("zips", nargs="+", help="submissions zips (Download submissions on each server's exam control page)")
    ap.add_argument("--out", default=".", help="folder in which the merged exam folder is made (default: here)")
    ap.add_argument("--base", nargs="*", default=[], metavar="FILE",
                    help="code or documents you gave the students: left out of the check")
    ap.add_argument("--title", help="title of the merged exam (default: the title in the zips)")
    ap.add_argument("--common", type=float, default=COMMON_SHARE * 100, metavar="PERCENT",
                    help="leave out code that more than this %% of the students have (default: %(default)s)")
    ap.add_argument("--no-check", action="store_true", help="merge only, without the similarity check")
    args = ap.parse_args(argv)
    try:
        sources = [Source(p) for p in args.zips]
    except ValueError as e:
        sys.exit(f"error: {e}")
    base = [(Path(p).name, Path(p).read_bytes()) for p in args.base]
    last = [""]

    def progress(step, done, total):
        if step != last[0]:
            print(f"{step}...", flush=True)
            last[0] = step
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    s = run(sources, out, base, args.title, args.common / 100, not args.no_check, progress)
    print(f"\nMerged {s['students']} students from {len(s['servers'])} zip(s) into:\n  {s['folder']}")
    if s.get("both"):
        print(f"  {s['both']} of them worked on more than one server or PC (newest copy on top, others in \"{OTHER}\")")
    if s.get("report"):
        p = s["pairs"]
        print(f"\nSimilarity: {p['vhigh']} very high, {p['high']} high, {p['medium']} medium pairs; "
              f"{s['groups']} group(s); {s['identical']} identical file(s).")
        print(f"Open the report:\n  {s['report']}")


if __name__ == "__main__":
    main()
