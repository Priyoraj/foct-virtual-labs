// Runs a compiled C/C++ program (WASI) with console input/output and an in-memory disk.
import { WASI, WasiExit, MemDir, MemFile } from "./wasi.js";
import { StdinSource, OutputBatcher } from "./stdin.js";

let stdin = null;

onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "stdin") { stdin?.deliver(m.data); return; }
  if (m.type !== "run") return;

  const post = (x) => postMessage(x);
  const out = new OutputBatcher(post);
  stdin = new StdinSource(m.stdin, post);
  stdin.beforeWait = () => out.flush();
  const jspi = m.stdin.mode === "jspi";

  const root = new MemDir();
  for (const f of m.files) root.entries.set(f.name, new MemFile(f.data));

  const wasi = new WASI({
    args: ["program", ...(m.args || [])],
    env: { HOME: "/", PWD: "/", USER: "student", LANG: "C.UTF-8", TERM: "dumb" },
    root,
    stdout: (t) => out.push("stdout", t),
    stderr: (t) => out.push("stderr", t),
    stdin,
    jspi,
    onSystem: (cmd) => {
      const c = cmd.trim().toLowerCase();
      if (c === "cls" || c === "clear") { out.push("stdout", "\x1b[2J"); return 0; }
      if (c === "pause") { out.push("stdout", "Press any key to continue . . .\n"); return 0; }
      if (/^color\b|^title\b|^chcp\b|^mode\b/.test(c)) return 0;
      out.push("stderr", `[system("${cmd}") is not available in the browser]\n`);
      return 1;
    },
  });

  let code = 0, trap = null;
  const t0 = performance.now();
  try {
    const mod = await WebAssembly.compile(m.wasm);
    const inst = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi.imports, foct: wasi.foctImports() });
    wasi.setMemory(inst.exports.memory);
    if (jspi) await WebAssembly.promising(inst.exports._start)();
    else inst.exports._start();
  } catch (e) {
    if (e instanceof WasiExit) code = e.code;
    else { code = null; trap = describeTrap(e); }
  }
  out.flush();
  const files = wasi.changedFiles();
  postMessage({ type: "exit", code, trap, ms: Math.round(performance.now() - t0), files }, files.map((f) => f.data.buffer));
};

function describeTrap(e) {
  const msg = String((e && e.message) || e);
  if (typeof WebAssembly.Exception === "function" && e instanceof WebAssembly.Exception) return "terminate called after throwing an exception that was not caught.";
  if (e instanceof WebAssembly.CompileError) return "This browser is too old to run the program (it needs WebAssembly exception handling). Please update Chrome, Edge or Firefox.";
  if (e instanceof RangeError && /call stack/i.test(msg)) return "Stack overflow: the recursion went too deep.";
  if (/unreachable/i.test(msg)) return "The program was aborted (abort() was called or an assertion failed).";
  if (/out of bounds|memory access/i.test(msg)) return "Segmentation fault: the program used memory it should not (check array indexes, pointers, and very deep recursion).";
  if (/divi.*zero/i.test(msg)) return "Arithmetic error: integer division by zero.";
  if (/integer overflow/i.test(msg)) return "Arithmetic error: integer overflow in division.";
  if (/call stack|stack size|too much recursion/i.test(msg)) return "Stack overflow: the recursion went too deep.";
  if (/indirect call|signature mismatch|null function/i.test(msg)) return "Invalid function pointer call.";
  if (/memory/i.test(msg)) return "Out of memory.";
  return msg;
}
