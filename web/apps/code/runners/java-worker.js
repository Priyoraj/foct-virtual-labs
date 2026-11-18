// Java compiler worker: javac + TeaVM (both compiled to WebAssembly) produce a WebAssembly program.
import { load } from "/runtimes/teavm/compiler.wasm-runtime.js";
import { SHIMS, rewriteJava, findMainClasses, launcherSource } from "./java-support.js";

const BASE = "/runtimes/teavm/";
let compiler = null;
let diags = [];

async function bytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Int8Array(await r.arrayBuffer());
}

async function init() {
  try {
    const teavm = await load(BASE + "compiler.wasm", { stackDeobfuscator: { enabled: false } });
    postMessage({ type: "progress", value: 0.5 });
    compiler = teavm.exports.createCompiler();
    const [sdk, classlib] = await Promise.all([
      bytes(BASE + "compile-classlib-teavm.bin"),
      bytes(BASE + "runtime-classlib-teavm.bin"),
    ]);
    compiler.setSdk(sdk);
    compiler.setTeaVMClasslib(classlib);
    compiler.onDiagnostic((d) => {
      let col = -1;
      try { col = d.type === "javac" ? d.columnNumber : -1; } catch {}
      diags.push({ type: d.type, severity: d.severity, file: d.fileName, line: d.lineNumber, col, message: d.message });
    });
    postMessage({ type: "ready" });
  } catch (e) {
    postMessage({ type: "fatal", message: "The Java compiler could not start: " + ((e && e.message) || e) });
  }
}

function format(list) {
  return list.map((d) => {
    const where = d.file ? `${d.file}:${d.line > 0 ? d.line + ":" : ""}${d.col > 0 ? d.col + ":" : ""} ` : "";
    return `${where}${d.severity === "other" ? "note" : d.severity}: ${d.message}`;
  }).join("\n");
}

async function compile(files, mainHint) {
  const t0 = performance.now();
  diags = [];
  compiler.clearSourceFiles();
  compiler.clearOutputFiles();
  const nameOf = {}, shifts = {}, mains = [];
  // This javac build expects plain file names (no package folders).
  for (const f of files) {
    const path = f.name.split("/").pop();
    const { text, shift } = rewriteJava(f.text);
    compiler.addSourceFile(path, text);
    nameOf[path] = f.name;
    if (shift) shifts[path] = shift;
    for (const cls of findMainClasses(f.text)) mains.push({ cls, file: f.name });
  }
  for (const [path, src] of Object.entries(SHIMS)) if (!nameOf[path]) compiler.addSourceFile(path, src);
  const main = mains.find((m) => m.file === mainHint) || mains[0];
  if (!main) {
    return {
      ok: false, ms: 0, diagnostics: [],
      log: "No main method found.\nAdd  public static void main(String[] args) { ... }  to one of your classes.",
    };
  }
  compiler.addSourceFile("__FoctLauncher.java", launcherSource(main.cls));

  const fix = (d) => {
    const s = shifts[d.file];
    if (s && d.line === s.line && d.col >= s.col) d.col -= s.len;
    if (nameOf[d.file]) d.file = nameOf[d.file];
    if (d.file === "__FoctLauncher.java") d.file = null;
    return d;
  };

  let ok = false;
  try {
    ok = compiler.compile();
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), diagnostics: [], log: "javac crashed: " + (e.message || e) };
  }
  let list = diags.map(fix);
  if (!ok || list.some((d) => d.severity === "error")) {
    return { ok: false, ms: Math.round(performance.now() - t0), diagnostics: list, log: format(list) };
  }
  const warnings = list;
  diags = [];
  try {
    ok = await compiler.generateWebAssembly({ outputName: "app", mainClass: "__FoctLauncher", obfuscated: false, strictMode: true });
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), diagnostics: [], log: "TeaVM failed: " + (e.message || e) };
  }
  list = diags.map(fix);
  const errors = list.filter((d) => d.severity === "error");
  if (!ok || errors.length) {
    const hint = errors.some((d) => /not found|was not found|can't be found|Method .* not found/i.test(d.message))
      ? "\nnote: this part of the Java library is not available in the browser runtime (for example Swing, AWT, JDBC, networking or thread pools)."
      : "";
    return { ok: false, ms: Math.round(performance.now() - t0), diagnostics: errors, log: format(errors) + hint };
  }
  const out = compiler.getWebAssemblyOutputFile("app.wasm");
  const wasm = new Uint8Array(out.buffer, out.byteOffset, out.byteLength).slice();
  return { ok: true, wasm, ms: Math.round(performance.now() - t0), diagnostics: warnings, log: format(warnings) };
}

onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "init") await init();
  else if (m.type === "compile") {
    const r = await compile(m.files, m.main);
    postMessage({ type: "compiled", ...r }, r.wasm ? [r.wasm.buffer] : []);
  }
};
