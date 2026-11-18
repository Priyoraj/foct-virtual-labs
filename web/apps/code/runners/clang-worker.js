// Compiles C/C++ to WebAssembly with Clang 22 (YoWASP build) inside a Web Worker.
//
// C++ headers are slow to parse in WebAssembly, so the standard headers a program includes are
// turned into a precompiled header (PCH) in the background and reused on later runs.
import { runClang, Exit } from "/runtimes/clang/bundle.js";
import { INCLUDE_DIR, RT_C, EH_WRAPPER_CPP } from "./clang-support.js";
import { ensureTools, generate, supportC } from "./lexyacc.js";

let rtObject = null;
let ehLibs = null;            // C++ standard library built with WebAssembly exceptions (wasi-sdk 34)
let ehObject = null;          // main() wrapper that reports uncaught exceptions
const EH_FLAGS = ["-fwasm-exceptions", "-mllvm", "-wasm-use-legacy-eh=false"];
const pchCache = new Map();   // key -> Uint8Array (most recently used last)
const PCH_LIMIT = 3;
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

async function clang(args, files, progress = true) {
  const dec = new TextDecoder();
  let log = "";
  const sink = (b) => { if (b) log += dec.decode(b, { stream: true }); };
  let lastProgress = 0;
  try {
    const out = await runClang(args, files, {
      stdout: sink,
      stderr: sink,
      fetchProgress: progress ? ({ totalLength, doneLength }) => {
        const now = performance.now();
        if (now - lastProgress > 150 || doneLength === totalLength) {
          lastProgress = now;
          postMessage({ type: "progress", done: doneLength, total: totalLength });
        }
      } : undefined,
    });
    return { ok: true, out, log };
  } catch (e) {
    if (e instanceof Exit) return { ok: false, code: e.code, log };
    return { ok: false, code: -1, log: log + "\n" + (e && e.stack || e) };
  }
}

async function ensureExceptions() {
  if (ehLibs && ehObject) return true;
  try {
    const names = ["libc++.a", "libc++abi.a", "libunwind.a", "libc++experimental.a"];
    const bufs = await Promise.all(names.map(async (n) => {
      const r = await fetch("/runtimes/clang/eh/" + n);
      if (!r.ok) throw new Error(n + ": HTTP " + r.status);
      return new Uint8Array(await r.arrayBuffer());
    }));
    ehLibs = Object.fromEntries(names.map((n, i) => [n, bufs[i]]));
  } catch (e) {
    postMessage({ type: "fatal", message: "Could not load the C++ library: " + (e.message || e) });
    return false;
  }
  const r = await clang(["clang++", "-std=c++20", "-O2", ...EH_FLAGS, "-c", "foct_eh.cpp", "-o", "foct_eh.o"],
    { "foct_eh.cpp": EH_WRAPPER_CPP }, false);
  if (!r.ok) {
    postMessage({ type: "fatal", message: "Could not prepare C++ exception support:\n" + r.log });
    return false;
  }
  ehObject = r.out["foct_eh.o"];
  return true;
}

async function ensureRuntime() {
  if (rtObject) return true;
  const r = await clang(["clang", "-c", "-O2", "-isystem", "foct-include", "foct_rt.c", "-o", "foct_rt.o"],
    { "foct_rt.c": RT_C, "foct-include": INCLUDE_DIR });
  if (!r.ok) {
    postMessage({ type: "fatal", message: "Could not prepare the C runtime:\n" + r.log });
    return false;
  }
  rtObject = r.out["foct_rt.o"];
  return true;
}

function commonFlags(m) {
  const cpp = m.lang === "cpp";
  return [
    cpp ? `-std=${m.std || "c++20"}` : `-std=${m.std || "c17"}`,
    m.opt || "-O1",
    ...(m.warnings === false ? [] : ["-Wall"]),
    ...(cpp ? EH_FLAGS : []),
    "-fno-color-diagnostics",
    "-I.",
    "-isystem", "foct-include",
    // POSIX bits that WASI only offers as emulations: clock(), signal(), getpid(), mmap()
    "-D_WASI_EMULATED_PROCESS_CLOCKS", "-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_GETPID", "-D_WASI_EMULATED_MMAN",
    // lex/yacc output and textbook programs: keep old-style C working, hide noise from generated code
    ...(m.lexyacc ? ["-Wno-unused-function", "-Wno-unused-label", "-Wno-unused-variable", "-Wno-unused-but-set-variable",
      "-Wno-unneeded-internal-declaration", "-Wno-deprecated-non-prototype", "-Wno-strict-prototypes",
      "-Wno-error=implicit-function-declaration", "-Wno-error=implicit-int", "-Wno-error=int-conversion",
      "-Wno-error=incompatible-pointer-types", "-Wno-error=incompatible-function-pointer-types", "-Wno-error=return-type"] : []),
  ];
}

/** Standard headers (#include <...>) used by the sources, in first-seen order. */
function systemIncludes(sources) {
  const out = [];
  for (const text of sources) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const m of code.matchAll(/^[ \t]*#[ \t]*include[ \t]*<([^>\s]+)>/gm)) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function pchKey(m, includes) {
  return JSON.stringify([m.lang, m.std, m.opt, m.warnings, includes]);
}

async function buildPch(m, includes) {
  const key = pchKey(m, includes);
  if (pchCache.has(key)) return;
  const header = ['#include "foct-include/foct_compat.h"', ...includes.map((h) => `#include <${h}>`)].join("\n") + "\n";
  const r = await clang(["clang++", ...commonFlags(m), "-x", "c++-header", "-Xclang", "-fno-pch-timestamp",
    "foct_pch.hpp", "-o", "foct.pch"], { "foct_pch.hpp": header, "foct-include": INCLUDE_DIR }, false);
  if (!r.ok || !r.out["foct.pch"]) return;   // e.g. a header that does not exist: just compile normally
  pchCache.set(key, r.out["foct.pch"]);
  while (pchCache.size > PCH_LIMIT) pchCache.delete(pchCache.keys().next().value);
}

async function compile(m) {
  const t0 = performance.now();
  if (!(await ensureRuntime())) return;
  let preLog = "", generated;
  if (m.lang === "lex") {
    // Lex & Yacc: yacc -d -v *.y, lex *.l, then compile everything as C with the -ll/-ly defaults
    try { await ensureTools(clang, (text) => postMessage({ type: "status", text })); }
    catch (e) { postMessage({ type: "compiled", ok: false, log: String((e && e.message) || e), ms: Math.round(performance.now() - t0) }); return; }
    const g = generate(m.files);
    preLog = g.log;
    generated = g.files;
    if (!g.ok) { postMessage({ type: "compiled", ok: false, log: g.log, ms: Math.round(performance.now() - t0), generated }); return; }
    const plain = m.files.filter((f) => !/\.(l|lex|y|yacc)$/i.test(f.name));
    const own = new Set(plain.map((f) => f.name));
    m = { ...m, lang: "c", lexyacc: true, std: (m.std || "c17").replace(/^c/, "gnu"),
      files: [...plain, ...g.files.filter((f) => !own.has(f.name)), { name: "foct_lexyacc.c", text: supportC(m.files) }] };
  }
  const cpp = m.lang === "cpp";
  if (cpp && !(await ensureExceptions())) return;
  const tree = { "foct-include": INCLUDE_DIR, "foct_rt.o": rtObject };
  if (cpp) Object.assign(tree, { "foct-eh": ehLibs, "foct_eh.o": ehObject });
  const sources = [];
  const texts = [];
  const srcRe = m.lang === "cpp" ? /\.(c|cc|cpp|cxx|c\+\+)$/i : /\.c$/i;
  // a grammar that does  #include "lex.yy.c"  compiles the scanner itself
  const lexIncluded = m.lexyacc && m.files.some((f) => f.name !== "lex.yy.c" && /#\s*include\s*["<]lex\.yy\.c[">]/.test(f.text));
  for (const f of m.files) {
    if (f.name.includes("/")) continue;
    tree[f.name] = f.text;
    if (lexIncluded && f.name === "lex.yy.c") continue;
    if (srcRe.test(f.name)) { sources.push(f.name); texts.push(f.text); }
  }
  if (!sources.length) {
    postMessage({ type: "compiled", ok: false, log: `No ${m.lang === "cpp" ? ".cpp" : ".c"} source file is open.` });
    return;
  }
  const includes = m.lang === "cpp" ? systemIncludes(texts) : [];
  const key = includes.length ? pchKey(m, includes) : null;
  const pch = key ? pchCache.get(key) : null;
  const args = (withPch) => [
    m.lang === "cpp" ? "clang++" : "clang",
    ...commonFlags(m),
    ...(withPch ? ["-include-pch", "foct.pch", "-Xclang", "-fno-validate-pch"] : ["-include", "foct-include/foct_compat.h"]),
    ...sources,
    "foct_rt.o",
    ...(cpp ? ["foct_eh.o", "-Lfoct-eh", "-lunwind", "-Wl,--wrap=__main_void"] : []),
    "-o", "program.wasm",
    "-lm",
    "-lwasi-emulated-process-clocks", "-lwasi-emulated-signal", "-lwasi-emulated-getpid", "-lwasi-emulated-mman",
    "-Wl,-z,stack-size=8388608",
    "-Wl,--stack-first",
  ];
  let r;
  if (pch) {
    pchCache.delete(key);
    pchCache.set(key, pch);            // mark as recently used
    r = await clang(args(true), { ...tree, "foct.pch": pch });
    if (!r.ok && /precompiled header|PCH|\.pch/i.test(r.log)) {
      pchCache.delete(key);            // stale PCH: fall back to a normal compile
      r = await clang(args(false), tree);
    }
  } else {
    r = await clang(args(false), tree);
  }
  const ms = Math.round(performance.now() - t0);
  if (!r.ok || !r.out["program.wasm"]) {
    postMessage({ type: "compiled", ok: false, log: preLog + r.log, ms, generated });
  } else {
    const wasm = r.out["program.wasm"];
    postMessage({ type: "compiled", ok: true, log: preLog + r.log, ms, wasm, generated }, [wasm.buffer]);
  }
  // Prepare a PCH for next time while the student reads the output.
  if (key && !pch && r.ok) serial(() => buildPch(m, includes));
}

onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "warmup") {
    serial(async () => {
      if (!(await ensureRuntime())) return;
      if (m.lang === "cpp" && !(await ensureExceptions())) return;
      postMessage({ type: "ready" });
      if (m.lang === "lex") { try { await ensureTools(clang, () => {}); } catch { /* reported again on Run */ } }
      if (m.lang === "cpp") await buildPch({ lang: "cpp", std: m.std, opt: m.opt, warnings: m.warnings }, ["iostream"]);
    });
  } else if (m.type === "compile") {
    serial(() => compile(m));
  }
};
