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

## Why it is light on the server

The server only **sends files**. Compiling and running happen inside each student's browser
(WebAssembly), so one ordinary PC can serve a whole lab: no per-student CPU or memory, no
sandboxing worries, no containers. The browser caches the runtimes after the first visit.

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

## Project layout

```
start-server.bat / .sh     launchers
server/serve.py            LAN web server (standard library only): gzip, caching, isolation headers, /__status
server/make_cert.py        lab CA + HTTPS certificate
tools/setup.py             downloads and patches all third-party runtimes into web/
tools/javasdk.py           repairs the TeaVM javac class library (TeaVM @Rename/@Remove)
tools/make_brand.py        cuts the ADtU logo into web assets
tools/jupyterlite/         JupyterLite config and starter notebook
tools/office/              blank Word/Excel/PowerPoint templates
web/index.html, help.html  portal and help
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

## Licences

FoCT Virtual Labs code (portal, IDE, NetSim, SQL and MongoDB labs, Lex & Yacc integration, Compiler Design Tools, SPICE front end, server, tools) was designed and developed by Mr. Priya Raj Chanda, Assistant Professor [CSE], for ADtU FoCT.
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

The Assam down town University name, seal and logo belong to the university.
