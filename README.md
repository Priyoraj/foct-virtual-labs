# FoCT Virtual Labs

Browser-based computer labs for the **Faculty of Computer Technology, Assam down town University**.

Designed and developed by **Mr. Priya Raj Chanda**, Assistant Professor [CSE], Faculty of Computer Technology, Assam down town University.

Students open one address on the lab network and get:

| Lab | Status | How it works |
|---|---|---|
| **C** | ✅ Full | Clang 22 compiled to WebAssembly, runs in the student's browser. Live keyboard input, files, `math.h`, `time.h`. Turbo-C habits (`conio.h`, `getch`, `clrscr`, `gets`, `system("cls")`, `dos.h`) are supported. |
| **C++** | ✅ Full | Clang 22 + libc++ (C++11–C++23, STL, `bits/stdc++.h`), exceptions via WebAssembly exception handling (wasi-sdk 34 libraries); uncaught exceptions print the usual `terminate called after throwing …`. A precompiled-header cache makes repeat runs take about 1 s. No threads. |
| **Python (plain IDE)** | ✅ Full | Pyodide 314 (Python 3.14.2) with 356 packages: NumPy, pandas, Matplotlib (plots shown inline), SciPy, scikit-learn, statsmodels, SymPy, NetworkX, OpenCV, Pillow, NLTK, polars, duckdb … Extra pure-Python packages (seaborn, openpyxl, plotly, tabulate, XlsxWriter, prettytable, ipywidgets) are bundled and install on first import. Not possible in a browser: TensorFlow, PyTorch, tkinter/turtle. |
| **Python (Jupyter)** | ✅ Full | JupyterLite 0.8 (JupyterLab + classic Notebook) with the same offline Pyodide; `%pip install seaborn …` works offline. |
| **Java** | ✅ Full in secure mode, basic over HTTP | Over HTTPS: the real **OpenJDK 21** compiled to WebAssembly ([JavaBox](https://github.com/bmarti44/javabox)), exact Java behaviour. Over plain HTTP: javac + TeaVM (7 MB, offline); console programs, `Scanner`, `printf` work, but JVM-raised errors (÷0, bad index, `null`) stop the program instead of reaching `catch`. No Swing/AWT/JDBC either way. |
| **SQL** | ✅ Full (light) | *SQL Lab*: SQLite 3.54 ([sql.js](https://github.com/sql-js/sql.js), 0.75 MB) and real PostgreSQL 18 ([PGlite](https://pglite.dev), about 5 MB compressed) in the browser. Joins, views, transactions, triggers, PL/pgSQL functions and procedures; MySQL-style `SHOW TABLES`/`DESC`/`USE`; sample company (EMP/DEPT), university and library databases; scripts saved as `.sql`, whole databases as `.sqlite`/`.pgdata.tar.gz`. |
| **MongoDB** | ✅ Light | *MongoDB Lab*: a mongosh-style shell over a MongoDB-compatible engine ([mingo](https://github.com/kofrasa/mingo); with the acorn parser about 0.1 MB compressed). CRUD, query/update operators, cursors and `it`, unique indexes and `explain()` (COLLSCAN vs IXSCAN), aggregation with `$lookup`, map-reduce, `$text` search, `$jsonSchema` validation, JSON/CSV import and export; sample college, shop and library databases. Data stays in the browser (IndexedDB) and can be saved to one file. No users, replication or sharding (there is no server). |
| **Compiler design: lex & yacc** | ✅ Full | *Lex & Yacc* language in the code IDE: flex 2.5.4a (the last flex without a run-time m4) and Berkeley yacc, compiled from source to WebAssembly by each browser on first use (about 20 s, then cached), then Clang. Runs `yacc -d -v`, `lex`, `cc … -ll -ly` like Linux; old textbook code (implicit `int`, `int yyerror(char*)`, `#include "lex.yy.c"`) works; generated files and `y.output` are shown. |
| **Compiler design: tools** | ✅ Built for FoCT | *Compiler Design Tools*: FIRST/FOLLOW, LL(1) tables and traces, left recursion and left factoring; operator precedence (operator-grammar check and fix, LEADING/TRAILING, relations, precedence functions, traces); LR(0)/SLR/LALR/CLR item sets, GOTO graph, tables, conflicts and traces; regex → Thompson NFA → subset DFA → minimal DFA and the followpos method; three-address code, quadruples, triples, DAG. Results match the Dragon book's worked examples. Diagrams by Graphviz (viz.js, 0.5 MB compressed). |
| **LTspice** | ❌ → SPICE substitute | LTspice is a Windows desktop program and cannot run in a browser. Instead, *SPICE Simulator*: **ngspice 45** compiled to WebAssembly ([EEcircuit-engine](https://github.com/eelab-dev/EEcircuit-engine)) with uPlot waveforms: `.tran`, `.ac` (Bode), `.dc`, `.op`. Netlists exported from LTspice (*View → SPICE Netlist*) are adjusted automatically (`SINE`, `Rser=`, one-value `.tran`, `.backanno`, library includes), and common parts (1N4148, 1N4007, Zeners, 2N2222, 2N3904, BC547, 2N7000, uA741, LM358, TL081, LTspice's 3-pin `opamp`) are built in. Not supported: `.asc` schematics and `.step`. |
| **Circuit simulator** | ✅ Full | [Falstad CircuitJS](https://www.falstad.com/circuit/) (3.4 MB): draw schematics and watch current flow live, analog and digital, ~380 example circuits; offline, its service worker and Dropbox import disabled. |
| **Diagrams (draw.io)** | ✅ Full | Self-hosted draw.io 32.7, offline, cloud storage disabled; saves/exports to the student's PC. |
| **Network simulation** | ✅ Built for FoCT | *FoCT NetSim*: PCs, laptops, servers, hubs, switches, routers; IPv4/masks/gateways/static routes; Ethernet MAC learning, ARP, ICMP `ping`/`tracert`, TTL, unreachable messages; animated packets, step mode and header inspector; example networks and a troubleshooting exercise. (Packet Tracer and GNS3 cannot run in a browser.) |
| **Office suite** | ✅ (heavier) | ONLYOFFICE editors compiled for the browser ([ranuts/document](https://github.com/ranuts/document)): Word/Excel/PowerPoint `.docx/.xlsx/.pptx`, save as PDF. English UI, open fonts metric-compatible with Arial, Times New Roman, Courier New, Calibri and Cambria. Needs 4 GB+ RAM on the PC. |

**Student files are never stored on the server.** Every app saves to and opens from the
student's own computer (download, or the browser's "Save as" picker in secure mode). Unsaved code is
kept as a browser draft on that PC, and the home page has a *Clear my lab data* button for shared PCs.
The one exception is an exam with sign-in (see [Exam mode](#exam-mode)): the students' exam work is
then sent to the server for the teacher.

## Why it is light on the server

The server only **sends files**. Compiling and running happen inside each student's browser
(WebAssembly), so one ordinary PC can serve a whole lab: no per-student CPU or memory, no
sandboxing worries, no containers. The browser caches the runtimes after the first visit.

After the first visit, opening a lab asks the server only for its pages and FoCT's own small
files. Runtime files are fetched again only after `tools/setup.py` installs a new version.

For a 90-PC lab, put the server on a wired gigabit port of the lab's main switch, not Wi-Fi. On a
PC's first visit a lab downloads up to 50 MB (C 29 MB, C++ 39 MB, Python 21 MB, Jupyter 49 MB,
Office 19 MB). If 90 PCs open Jupyter for the first time together, this takes about 40 seconds on
gigabit. In a test, the server sent 90 simultaneous clients about 885 MB/s, so the network is the
limit, not the server.

## Requirements

* **Server:** any Windows/Linux/macOS PC on the lab network with **Python 3.8+**. The lab itself
  (`web/`) takes about 1.1 GB. Internet is needed **once** for `tools/setup.py` (about 860 MB of
  downloads, cached in `.downloads/` and `.build/`, about 1 GB; delete those two folders after
  setup if disk space is short). Afterwards the lab runs fully offline.
* **Student PCs:** a current **Chrome or Edge** (Firefox works too). 4 GB RAM minimum, 8 GB
  recommended for Office and Java.

## Install and start

```bat
git clone https://github.com/Priyoraj/foct-virtual-labs.git
cd foct-virtual-labs
start-server.bat
```

The repository holds only the FoCT Virtual Labs code. On first start, `start-server.bat` runs
`python tools/setup.py`, which downloads and unpacks every third-party runtime into `web/`. Then
the window prints the addresses for students, e.g.

```
 On the lab LAN   :  http://<this-PC's-IP>:8080/
```

Linux/macOS: `./start-server.sh`. Options: `python server/serve.py --port 80 --https --https-port 443`.

**Firewall:** allow Python when Windows asks, or run `server\allow-firewall.bat` as administrator
(opens TCP 8080/8443 on private/domain networks).

**Run at boot (Windows):** Task Scheduler → *Create task* → trigger *At startup* → action
`start-server.bat` (start in the project folder).

## Secure mode (recommended)

Plain `http://` works for everything above, but browsers only enable some features on secure
pages. Start the server with `--https`: it creates a **lab certificate authority** in
`server/certs/` and serves `https://<server>:8443/`. Install the public CA certificate
(`http://<server>:8080/foct-lab-ca.crt`) on each PC once, by hand, with
`certutil -addstore -f Root foct-lab-ca.crt`, or by Group Policy. Bake it into the lab image if
labs are re-imaged for exams. Secure mode adds the full Java 21 runtime, Jupyter file
access and `input()`, and direct save-back to files.

The CA is **name-constrained** to private IP ranges and local host names, so a leaked key cannot
impersonate public websites. Keep `server/certs/foct-lab-ca.key` on the server only. If the
university has a real certificate (e.g. for `vlabs.adtu.in`), use
`--cert fullchain.pem --key privkey.pem` instead.

## Exam mode

On the server PC, open **http://localhost:8080/__exam/control**. The server window prints this
address. The page works only on the server PC.

Type the exam title and press **Start exam mode**. Within about 10 seconds every open lab page,
including Jupyter, Office and draw.io:

* **turns off copy, cut and paste**: keyboard shortcuts, right-click and editor menus, and the
  browser's clipboard API;
* **blocks dragging** text or files into the page;
* **shows an exam watermark**: a red frame and a diagonal mark with the exam title, the PC's
  network address and the time. It also appears in screenshots and printouts.

**End exam mode** turns it off the same way. Exam mode stays on if the server restarts; the
state is kept in `server/exam-state.json`.

### Sign-in and collecting the students' work

Leave **Students sign in with their name and enrolment no.** ticked when you start the exam. Each
student then types their name and enrolment number once, on whichever lab page they open first.
The page shows a bar with their name and a **Submit files** button, and their work reaches the
server PC by itself:

* **Lab work changed during the exam**: C, C++, Java, Python, Lex & Yacc, SQL, MongoDB, SPICE,
  NetSim and Jupyter notebooks. It is sent at most once a minute, and at once when you collect.
  Drafts left on the PC from earlier classes are not taken.
* **Every file the student saves or downloads** from a lab, including Office documents, draw.io
  diagrams and circuits.
* **Files the student hands in with Submit files**, for example from their Downloads folder.

**Download submissions (.zip)** on the control page first asks every PC for its latest work
(a few seconds). It then saves `<Exam title>.zip` to your Downloads folder:

```
<Exam title>/
  roster.csv                          name, enrolment no., PC, sign-in time, last work received
  <Name>_<Enrolment no.>/
    _student.txt
    C/main.c, SQL/query.sql, Jupyter/<notebook>.ipynb ...   lab work
    Saved files/...                   files the student saved or downloaded
    Submitted files/...               files handed in with Submit files
```

* **Collect work and end exam** does a final collection and then ends exam mode.
* The last exam's submissions stay downloadable after the exam.
* On the server PC the same folders are kept in `submissions/<Exam title>/`.
* Only the latest version of each file is kept.
* If the same enrolment number signs in on a second PC, that PC gets its own folder, so nothing is overwritten, and the roster marks it "2 PCs".

Limits:

* Uploads are accepted only from signed-in students of the running exam, plus 2 minutes after it ends.
* Each student can send up to 50 MB per file and 300 MB in total.
* Program files (`.exe`, `.bat`, `.ps1`, `.msi`, ...) are refused.

How it works:

* The server adds `web/assets/js/exam.js` to every page it sends.
* The script checks `/__exam` every 8 seconds.
* Its listeners run before any editor sees the event.
* All labs share one browser storage, so whichever page is open can send every lab's drafts.
* The server code is in `server/exam_mode.py`.

Only the server PC can switch exam mode, see the roster or download submissions, and other web
sites cannot do it through the administrator's browser.

### Safeguards

Choose them on the control page before you start. The tick-boxes are under **Safeguards**; most
are on by default.

**Enforced by the server itself.** Developer tools on a student PC cannot change these:

* **Labs allowed in this exam.** Other labs show "This lab is not part of the exam", their files
  are refused, and the home page greys them out.
* **Sign-in gate.** With sign-in, the server gives the labs only to PCs that are signed in, not
  locked, and checking in every few seconds. A PC whose exam script is blocked or switched off
  gets no labs after about 45 seconds.
* **Exam code.** Students must type a 4-digit code that the control page shows for the board.
* **Only these PCs may sign in.** A list of addresses, ranges or subnets.
* **Time limit.** A countdown shows in each student's bar, with warnings at 10 minutes and
  1 minute. When it reaches zero, every PC sends its work and the labs lock. **+10 minutes**
  reopens them.
* **Your actions.** Lock or let back in a single student, and send a message to every screen.

**In every exam page.** These are reported to you:

* No opening files from the PC or a pen drive (Open buttons, Office's "Open a file", Jupyter
  upload, file pickers), and no built-in example programs. *Submit files* still works.
* No browser right-click menu, developer-tools keys (F12, Ctrl+Shift+I/J/C), view source (Ctrl+U)
  or printing (Ctrl+P, and printouts come out blank).
* Leaving the exam window (another program, browser tab or window) is noted with its length.
  Moving between lab tabs is not counted. Optionally the student is warned, and the exam pauses
  after N times until you let them back in.
* Require full screen (optional): leaving it pauses the exam on that PC until the student
  returns.
* Text that appears 200+ characters at once in a code editor is noted. Paste is blocked, so
  such text was injected or typed by a tool.
* A second screen is noted, in secure (HTTPS) mode only; browsers offer this check only on
  secure pages.

**Tamper detection and lock.**

* Every 3 seconds each page checks itself:
  * Are developer tools open? A `debugger` statement pauses only while they are, and the pause
    can be measured.
  * Do the copy, paste and drop guards still block a test event?
  * Are the clipboard, download and file-open guards still in place?
  * Is the watermark still on screen?
* If anything fails, the student's screen shows "Exam paused on this PC", the server stops giving
  that PC the labs, and you see it on the control page.
* The lock lifts by itself once everything is back to normal. If you choose "wait until I let
  them back in", it lifts only when you press **Let back in**.

Everything is recorded with times:

* The control page shows the alerts per student.
* The zip has `incidents.csv`, an alerts column in `roster.csv`, and the alerts in each
  `_student.txt`.

During an exam the browsers check every file with the server instead of using their 30-day copy,
so these rules apply to every file. The checks are cheap 304 replies, not new downloads.

### Exam helper for Windows PCs

For what a web page cannot do, tick **Students must run the exam helper** on the control page.
Students then run `exam-helper.vbs` (VBScript, built into Windows 10 and 11) on their PC before
they can start. It needs no administrator rights. While the exam runs, it:

* **Closes other programs and keeps them closed.** The list is editable on the control page. It
  covers editors and IDEs, Office, other browsers, chat, remote-desktop tools, screenshot and
  recording tools, terminals, Task Manager, regedit and calculators. Windows itself and the
  exam window are never touched.
* **Opens the exam in its own Edge window** in kiosk mode: full screen, no address bar, no tabs,
  and no internet (only the lab server can be reached). If the student closes it, it opens again.
* **Turns off Task Manager and the clipboard history** (optional).
* **Watches and reports to the server:** USB drives (optionally pausing the exam on that PC until
  the drive is removed), a second screen, and the programs it had to close. It refuses to run in a
  remote-desktop session.
* **With administrator rights** (optional; only when the PC's account has them, after Windows'
  usual prompt): turns off developer tools in Edge and Chrome (`DeveloperToolsAvailability` = 2)
  and blocks USB drives.

**Enforced by the server.**

* A PC can sign in and get lab files only while its helper checks in (every 3 seconds), and only
  from the helper's exam window. Other browsers see "Use the exam window", and signing in from
  them is refused.
* If the helper is stopped, the server stops serving that PC's labs within 20 seconds and the page
  asks for the helper again. Running it again resumes the exam.
* The control page shows each student's helper status: running, Task Manager off, developer tools
  off, USB blocked, USB drives, screens. It also lists the PCs where the helper runs but nobody
  has signed in yet.

**Back to normal.**

* When you end the exam, every helper puts back exactly what it changed and closes the exam
  window. The backups are in `%LOCALAPPDATA%\FoCTExam`, plus `%ProgramData%\FoCTExam` for
  administrator changes.
* If the PC restarts first, the helper finishes this at the next sign-in, from a one-time
  start-up entry, and administrator changes are undone at start-up by a one-time task.
* Running it with `/restore` does the same by hand.
* If the lab server cannot be reached for 30 minutes, the helper puts the PC back by itself.

**Getting it onto the PCs.**

* **Download exam-helper.vbs** on the control page. The server writes its own address into the
  file. Copy it to each PC's desktop or a shared folder.
* Students can also download it from the exam page, but browsers and Windows warn about `.vbs`
  files: "Keep", then "Run".
* `exam-helper.vbs /test` talks to the server but changes nothing on the PC, for trying it out.

Microsoft has announced that VBScript will be phased out in a future Windows version. In Windows 11
24H2 it is still installed by default as an optional feature.

**What this cannot do.** All the in-page checks run in the student's own browser:

* A student who can rewrite the exam script itself could get around them, though not around the
  server's part.
* To close that gap, turn off developer tools on the lab PCs with the Edge or Chrome policy
  `DeveloperToolsAvailability` = 2, through Group Policy or the lab image. The exam helper does
  this when the PC's account has administrator rights.
* The exam helper also runs on the student's PC. A student with administrator rights or
  scripting skills could stop it or imitate its reports. Stopping it cuts their labs off at once;
  imitating it takes real effort.
* Phones and cameras are outside any software's reach.

## Project layout

```
start-server.bat / .sh     launchers
server/serve.py            LAN web server (standard library only): gzip, caching, isolation headers, /__status
server/make_cert.py        lab CA + HTTPS certificate
server/exam-control.html   exam mode switch, roster and zip download (/__exam/control, server PC only)
server/exam_mode.py        exam state, student sign-in, submissions, safeguards and the zip
server/exam-helper.vbs     exam helper for the student PCs (served at /exam-helper.vbs with this server's address)
submissions/               the students' exam work, one folder per exam   (created in exams)
tools/setup.py             downloads and patches all third-party runtimes into web/
tools/javasdk.py           repairs the TeaVM javac class library (TeaVM @Rename/@Remove)
tools/make_brand.py        cuts the ADtU logo into web assets
tools/jupyterlite/         JupyterLite config and starter notebook
tools/office/              blank Word/Excel/PowerPoint templates
web/index.html, help.html  portal and help
web/assets/js/exam.js      exam mode in every page (clipboard block, watermark, sign-in, sending work)
web/apps/code/             C / C++ / Java / Python IDE (Monaco editor, workers, WASI runtime)
web/apps/netsim/           FoCT NetSim network simulator
web/apps/sql/              SQL Lab (SQLite and PostgreSQL workers, sample databases)
web/apps/spice/            SPICE simulator (ngspice worker, LTspice netlist adapter, model library)
web/apps/mongo/            MongoDB Lab (engine worker: shell, indexes, validation, text search; samples)
web/apps/cdtools/          Compiler Design Tools (grammar.js, oprec.js, lr.js, automata.js, icg.js)
web/apps/code/runners/lexyacc.js   builds and runs lex and yacc for the Lex & Yacc language
web/apps/circuit/          Falstad CircuitJS        (generated)
web/apps/notebook/         JupyterLite build        (generated)
web/apps/drawio/           draw.io                  (generated)
web/apps/office/           office suite             (generated)
web/runtimes/              pyodide, clang, teavm, javabox, pywheels, sql, spice, mongo, lexyacc, viz (generated)
web/vendor/monaco/         code editor              (generated)
```

Folders marked *(generated)* are not in the repository (see `.gitignore`); setup creates them.
To move the lab to another server, copy the whole folder (after setup) — no internet needed there.

## Notes for maintainers

* `tools/setup.py --list` shows the steps; `--only clang,office` re-runs some. Finished steps are
  skipped; downloads are cached in `.downloads/`.
* Patches applied during setup (all in `tools/setup.py`): draw.io offline config; office suite
  moved to `/apps/office/`, English UI (official ONLYOFFICE 7.4.1 strings), FoCT branding,
  English templates, Microsoft fonts replaced by open ones; Clang virtual-FS write speed-up and
  exception-enabled C++ libraries from wasi-sdk 34; TeaVM javac library renames; CircuitJS
  without its service worker (its cleanup deleted every Cache Storage entry of the site, including
  JupyterLite's) and without Dropbox import.
* lex and yacc are not shipped as binaries: setup downloads the flex 2.5.4a and byacc sources
  (pinned by SHA-256) into `web/runtimes/lexyacc/`, and each browser compiles them with the lab's
  Clang the first time someone uses Lex & Yacc, keeping the result in IndexedDB.
* The SPICE model library (`web/apps/spice/library.js`) is plain text: add a part by adding its
  `.model`/`.subckt` there and it becomes available by name in every netlist.
* The JavaBox prebuilt files come from the author's demo site (no versioned release). `setup.py`
  checks them against the SHA-256 of the tested build and warns if they change.
* `/__status` on the server shows active PCs, requests and data sent.
* Caching (`server/serve.py`):
  * Pages and FoCT's own files are revalidated on every visit, so edits show at once.
  * Files in the folders setup manages are kept by browsers for 30 days without asking: `runtimes/`, `vendor/` and `apps/notebook|office|drawio|circuit/`.
  * Every page sets a `foct_rt` cookie, a hash of the `.foct-version` markers. Those files are sent with `Vary: Cookie`, so when setup installs a new version, browsers fetch the new files instead of mixing versions.
  * If you hand-edit a file inside those folders, add it to `OWN_IN_MANAGED`.

## Licences

FoCT Virtual Labs code (portal, IDE, NetSim, SQL and MongoDB labs, Lex & Yacc integration, Compiler Design Tools, SPICE front end, server, tools) was designed and developed by Mr. Priya Raj Chanda, Assistant Professor [CSE], for ADtU FoCT.
It is released under the [MIT License](LICENSE). The MIT License covers this code only.

Third-party components keep their licences: Pyodide (MPL-2.0), JupyterLite/JupyterLab
(BSD-3-Clause), LLVM/Clang (Apache-2.0 with LLVM exception), YoWASP packaging (ISC), JavaBox (MIT),
OpenJDK (GPL-2.0 with Classpath Exception), TeaVM (Apache-2.0), Monaco (MIT), draw.io (Apache-2.0),
sql.js (MIT), SQLite (public domain), mingo (MIT), acorn (MIT), flex (BSD), Berkeley yacc (public domain),
Graphviz (EPL) via viz.js (MIT), PGlite (Apache-2.0 / PostgreSQL Licence), ngspice (BSD-3-Clause
and others), EEcircuit-engine (MIT), uPlot (MIT), CircuitJS (GPL-2.0),
ranuts/document and ONLYOFFICE (AGPL-3.0; the modifications are the scripted patches in
`tools/setup.py`, and the upstream sources are linked from the Help page), Liberation/Carlito/
Caladea fonts (SIL OFL 1.1). These components are not stored in this repository: `tools/setup.py`
downloads them from their publishers.

The Assam down town University name, seal and logo belong to the university and are not covered
by the MIT License.
