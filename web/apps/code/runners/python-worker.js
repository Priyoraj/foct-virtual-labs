// Python (Pyodide) in a Web Worker: input(), plots, packages and files.
import { loadPyodide } from "/runtimes/pyodide/pyodide.mjs";
import { StdinSource, OutputBatcher } from "./stdin.js";

const WORK = "/home/pyodide";
let py = null;
let stdin = null;
let out = null;
let extras = {};

const post = (x) => postMessage(x);
const outDec = new TextDecoder(), errDec = new TextDecoder();

self.foctReadLineSync = () => stdin.readLineSync();
self.foctReadLineAsync = () => stdin.readLineAsync();
self.foctImage = (bytes) => {
  out?.flush();
  const copy = new Uint8Array(bytes);
  post({ type: "image", png: copy }, [copy.buffer]);
};

const BOOT = String.raw`
import sys, io, os, builtins, traceback, time
import js
from pyodide.ffi import to_js
try:
    from pyodide.ffi import run_sync
except ImportError:
    run_sync = None

_foct_mode = "batch"

def _foct_readline():
    if _foct_mode == "jspi":
        line = run_sync(js.foctReadLineAsync())
    else:
        line = js.foctReadLineSync()
    return None if line is None else str(line)

class _FoctStdin(io.TextIOBase):
    def __init__(self):
        self._buf = ""
        self._eof = False
    def readable(self): return True
    def isatty(self): return True
    @property
    def encoding(self): return "utf-8"
    def _fill(self):
        if self._eof:
            return False
        sys.stdout.flush()
        line = _foct_readline()
        if line is None:
            self._eof = True
            return False
        self._buf += line
        return True
    def readline(self, size=-1):
        while "\n" not in self._buf and self._fill():
            pass
        i = self._buf.find("\n")
        if i < 0:
            line, self._buf = self._buf, ""
        else:
            line, self._buf = self._buf[:i + 1], self._buf[i + 1:]
        return line
    def read(self, size=-1):
        if size is None or size < 0:
            while self._fill():
                pass
            data, self._buf = self._buf, ""
            return data
        while len(self._buf) < size and self._fill():
            pass
        data, self._buf = self._buf[:size], self._buf[size:]
        return data
    def readlines(self, hint=-1):
        return list(iter(self.readline, ""))
    def __iter__(self):
        return self
    def __next__(self):
        line = self.readline()
        if not line:
            raise StopIteration
        return line

def _foct_input(prompt=""):
    if prompt != "":
        sys.stdout.write(str(prompt))
    sys.stdout.flush()
    line = sys.stdin.readline()
    if not line:
        raise EOFError("EOF when reading a line (type the program's input in the Output panel or the Input tab)")
    return line[:-1] if line.endswith("\n") else line

def _foct_emit_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    import warnings
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fig.savefig(buf, format="png", dpi=100, bbox_inches="tight", facecolor="white")
        js.foctImage(to_js(buf.getvalue()))
    plt.close("all")

def _foct_prepare_plots():
    if "matplotlib" in sys.modules or _foct_find("matplotlib"):
        import matplotlib
        matplotlib.use("agg")
        import matplotlib.pyplot as plt
        plt.show = lambda *a, **k: _foct_emit_figures()
    if "PIL" in sys.modules or _foct_find("PIL"):
        try:
            from PIL import Image
            def _show(self, *a, **k):
                buf = io.BytesIO()
                self.save(buf, format="PNG")
                js.foctImage(to_js(buf.getvalue()))
            Image.Image.show = _show
        except Exception:
            pass

def _foct_find(name):
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False

def _foct_forget_user_modules():
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if f.startswith("${WORK}/"):
            del sys.modules[name]

def _foct_run(main, mode):
    global _foct_mode
    _foct_mode = mode
    sys.stdin = _FoctStdin()
    builtins.input = _foct_input
    os.chdir("${WORK}")
    if "${WORK}" not in sys.path:
        sys.path.insert(0, "${WORK}")
    _foct_forget_user_modules()
    _foct_prepare_plots()
    sys.argv = [main]
    g = {"__name__": "__main__", "__file__": "${WORK}/" + main, "__builtins__": builtins}
    status = 0
    try:
        with open(main, encoding="utf-8") as f:
            src = f.read()
        exec(compile(src, main, "exec"), g)
    except SystemExit as e:
        if e.code is None:
            status = 0
        elif isinstance(e.code, int):
            status = e.code
        else:
            print(e.code, file=sys.stderr)
            status = 1
    except KeyboardInterrupt:
        print("\nKeyboardInterrupt (stopped)", file=sys.stderr)
        status = 130
    except SyntaxError as e:
        sys.stderr.write("".join(traceback.format_exception_only(type(e), e)))
        status = 1
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename not in (main, "${WORK}/" + main) and tb.tb_next is not None:
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb)
        status = 1
    finally:
        try:
            _foct_emit_figures()
        except Exception:
            pass
        sys.stdout.flush()
        sys.stderr.flush()
    return status

def _foct_changed_files(since):
    found = []
    for base, dirs, files in os.walk("${WORK}"):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
        for n in files:
            p = os.path.join(base, n)
            try:
                if os.path.getmtime(p) >= since:
                    with open(p, "rb") as f:
                        found.append([os.path.relpath(p, "${WORK}"), f.read()])
            except OSError:
                pass
    return found
`;

async function init(cfg) {
  try {
    py = await loadPyodide({
      indexURL: "/runtimes/pyodide/",
      env: { HOME: WORK, MPLBACKEND: "agg", PYTHONIOENCODING: "utf-8" },
    });
  } catch (e) {
    post({ type: "fatal", message: "Python could not start: " + (e && e.message || e) });
    return;
  }
  py.setStdout({ write: (b) => { out?.push("stdout", outDec.decode(b, { stream: true })); return b.length; }, isatty: true });
  py.setStderr({ write: (b) => { out?.push("stderr", errDec.decode(b, { stream: true })); return b.length; }, isatty: true });
  if (cfg.interrupt) py.setInterruptBuffer(cfg.interrupt);
  await py.runPythonAsync(BOOT);
  await loadExtras();
  post({ type: "ready", version: py.version, python: py.runPython("import sys; sys.version.split()[0]") });
}

// The lab's extra pure-Python packages: setup's (seaborn, openpyxl, ...) and the ones a teacher adds on the
// lab server while the labs run. The list is always checked with the server, so a new package shows at once.
let extrasAt = 0;
async function loadExtras() {
  try {
    extras = await (await fetch("/runtimes/pywheels/index.json", { cache: "no-cache" })).json();
  } catch { /* keep the list we have */ }
  extrasAt = Date.now();
}

async function ensurePackages(code) {
  const msg = (m) => { out?.flush(); post({ type: "info", text: m.trim() + "\n" }); };
  await py.loadPackagesFromImports(code, { messageCallback: msg, errorCallback: msg });
  // Pure-Python packages of the lab are installed on demand, when the program imports them.
  const imports = py.pyodide_py.code.find_imports(code).toJs();
  const missing = imports.filter((name) => !py.runPython(`_foct_find(${JSON.stringify(name)})`));
  if (!missing.length) return;
  if (Date.now() - extrasAt > 2000) await loadExtras();   // added (or removed) on the lab server since the last look?
  const want = [];
  for (const name of missing) {
    const e = extras[name];
    if (e && !want.some((w) => w.name === e.name)) want.push(e);
  }
  if (!want.length) return;
  const wheels = [...new Set(want.flatMap((e) => e.wheels))];
  const deps = [...new Set(want.flatMap((e) => e.pyodide || []))];
  if (deps.length) await py.loadPackage(deps, { messageCallback: msg, errorCallback: msg });
  await py.loadPackage("micropip", { messageCallback: () => {} });
  msg("Installing " + want.map((e) => e.name).join(", ") + " ...");
  const micropip = py.pyimport("micropip");
  await micropip.install(wheels.map((w) => new URL("/runtimes/pywheels/" + w, location.href).href), { deps: false });
}

async function run(m) {
  out = new OutputBatcher(post);
  stdin = new StdinSource(m.stdin, post);
  stdin.beforeWait = () => out.flush();
  const started = Date.now() / 1000 - 1;
  const t0 = performance.now();
  let status = 1;
  try {
    // fresh working folder with the editor tabs as files
    py.runPython(`
import os, shutil
for n in os.listdir("${WORK}"):
    p = os.path.join("${WORK}", n)
    if n.startswith("."):
        continue
    shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
`);
    for (const f of m.files) py.FS.writeFile(`${WORK}/${f.name}`, f.text);
    await ensurePackages(m.files.filter((f) => f.name.endsWith(".py")).map((f) => f.text).join("\n"));
    const fn = py.globals.get("_foct_run");
    status = m.stdin.mode === "jspi" ? await fn.callPromising(m.main, "jspi") : fn(m.main, m.stdin.mode);
    fn.destroy();
  } catch (e) {
    out.push("stderr", String(e && e.message || e) + "\n");
    status = 1;
  }
  out.flush();
  let files = [];
  try {
    const changed = py.globals.get("_foct_changed_files")(started);
    const enc = new TextEncoder();
    const inputs = new Map(m.files.map((f) => [f.name, f.text]));
    for (const [name, data] of changed.toJs()) {
      const bytes = new Uint8Array(data);
      if (inputs.has(name) && new TextDecoder().decode(bytes) === inputs.get(name)) continue;
      files.push({ name, data: bytes });
    }
    changed.destroy();
    void enc;
  } catch {}
  post({ type: "exit", code: status, ms: Math.round(performance.now() - t0), files });
}

onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "stdin") stdin?.deliver(m.data);
  else if (m.type === "init") await init(m);
  else if (m.type === "run") await run(m);
};
