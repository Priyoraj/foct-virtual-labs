// lex (flex 2.5.4a) and yacc (Berkeley yacc) for the Lex & Yacc lab, used by clang-worker.js.
//
// The first time on a computer, the browser builds both tools from their C sources with the
// lab's own Clang (about 15-30 s) and keeps the WebAssembly in IndexedDB. Then they run like
// on Linux:   yacc -d -v parser.y  ->  y.tab.c y.tab.h y.output      lex scanner.l  ->  lex.yy.c
import { WASI, WasiExit, MemDir, MemFile } from "./wasi.js";

const BASE = "/runtimes/lexyacc/";
const enc = new TextEncoder();
const dec = new TextDecoder();
let tools = null;           // { flex, yacc } compiled WebAssembly.Module
let building = null;

// ------------------------------------------------------------------ cache (this computer only)
const DB = "foct-lexyacc";
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("bin");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function cacheDo(mode, fn) {
  const d = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("bin", mode);
      const req = fn(tx.objectStore("bin"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally { d.close(); }
}

// ------------------------------------------------------------------ running a tool (no keyboard input)
export function runTool(module, args, files) {
  const root = new MemDir();
  for (const [name, text] of Object.entries(files)) root.entries.set(name, new MemFile(typeof text === "string" ? enc.encode(text) : text));
  root.entries.set("tmp", new MemDir());
  let out = "", err = "";
  const wasi = new WASI({
    args, env: { HOME: "/", PWD: "/", TMPDIR: "/tmp", LANG: "C" }, root,
    stdout: (t) => { out += t; }, stderr: (t) => { err += t; },
    stdin: { readSync: () => null, readAsync: () => null },
  });
  const inst = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.imports });
  wasi.setMemory(inst.exports.memory);
  let code = 0;
  try { inst.exports._start(); }
  catch (e) { if (e instanceof WasiExit) code = e.code; else { code = 70; err += `\n${args[0]} crashed: ${e.message || e}\n`; } }
  const made = {};
  for (const f of wasi.changedFiles()) if (!f.name.startsWith("tmp/")) made[f.name] = dec.decode(f.data);
  return { code, out, err, files: made };
}

async function fetchDir(dir, names) {
  const tree = {};
  await Promise.all(names.map(async (n) => {
    const r = await fetch(BASE + dir + "/" + n);
    if (!r.ok) throw new Error(`${dir}/${n}: HTTP ${r.status}`);
    tree[n] = await r.text();
  }));
  return tree;
}

/** Builds (first time) or loads lex and yacc. clang(args, tree, progress) is the worker's compiler. */
export function ensureTools(clang, status) {
  if (tools) return Promise.resolve(tools);
  if (!building) building = (async () => {
    const res = await fetch(BASE + "manifest.json");
    if (!res.ok) throw new Error("lex and yacc are not installed on this server (run tools/setup.py --only lexyacc).");
    const man = await res.json();
    let bin = null;
    try { bin = await cacheDo("readonly", (s) => s.get(man.version)); } catch { bin = null; }
    if (!bin) {
      status("Preparing lex and yacc for this computer (first time only, about 20 seconds)…");
      const by = await fetchDir("byacc", man.byacc.files);
      let r = await clang(["clang", "-O2", "-w", "-D_WASI_EMULATED_SIGNAL", "-DHAVE_CONFIG_H", "-include", "foct_compat.h", "-I.",
        ...man.byacc.sources, "-lwasi-emulated-signal", "-Wl,-z,stack-size=1048576", "-o", "yacc.wasm"], by, false);
      if (!r.ok || !r.out["yacc.wasm"]) throw new Error("Could not build yacc:\n" + r.log);
      const yacc = r.out["yacc.wasm"];
      status("Preparing lex for this computer (first time only)…");
      const fl = await fetchDir("flex", man.flex.files);
      const g = runTool(await WebAssembly.compile(yacc), ["yacc", "-d", "parse.y"], { "parse.y": fl["parse.y"] });
      if (g.code !== 0 || !g.files["y.tab.c"]) throw new Error("Could not prepare lex (yacc on parse.y):\n" + g.err + g.out);
      fl["parse.c"] = g.files["y.tab.c"];
      fl["parse.h"] = g.files["y.tab.h"];
      fl["scan.c"] = fl["initscan.c"];
      r = await clang(["clang", "-std=gnu89", "-O2", "-w", "-I.", ...man.flex.sources, "-Wl,-z,stack-size=1048576", "-o", "flex.wasm"], fl, false);
      if (!r.ok || !r.out["flex.wasm"]) throw new Error("Could not build lex:\n" + r.log);
      bin = { yacc, flex: r.out["flex.wasm"] };
      try { await cacheDo("readwrite", (s) => s.put(bin, man.version)); } catch { /* private mode: build again next time */ }
    }
    tools = { yacc: await WebAssembly.compile(bin.yacc), flex: await WebAssembly.compile(bin.flex) };
    return tools;
  })().catch((e) => { building = null; throw e; });
  return building;
}

// ------------------------------------------------------------------ messages in the compiler's format
// byacc:  yacc: e - line 5 of "calc.y", syntax error      flex:  "scan.l", line 3: unrecognized rule
function toDiagnostics(text, defaultFile) {
  const out = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    let m;
    if ((m = /^\S*?yacc: ([ew]) - line (\d+) of "([^"]+)", (.*)$/.exec(line))) out.push(`${m[3]}:${m[2]}:1: ${m[1] === "e" ? "error" : "warning"}: ${m[4]}`);
    else if ((m = /^\S*?yacc: ([ew]) - (.*)$/.exec(line))) out.push(`${defaultFile}:1:1: ${m[1] === "e" ? "error" : "warning"}: ${m[2]}`);
    else if ((m = /^"([^"]+)", line (\d+): (warning, )?(.*)$/.exec(line))) out.push(`${m[1]}:${m[2]}:1: ${m[3] ? "warning" : "error"}: ${m[4]}`);
    else if ((m = /^\S*?yacc: (.*conflicts?.*)$/.exec(line))) out.push(`${defaultFile}:1:1: warning: ${m[1].replace(/\.$/, "")} (see y.output in the Files tab)`);
    else if ((m = /^(?:lex|flex): (.*)$/.exec(line))) out.push(`${defaultFile}:1:1: error: ${m[1]}`);
    else out.push(line);
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/** Runs yacc on the .y files and lex on the .l files. Returns { ok, log, files: [{name, text}] }. */
export function generate(files) {
  const all = Object.fromEntries(files.map((f) => [f.name, f.text]));
  const ys = files.filter((f) => /\.(y|yacc)$/i.test(f.name));
  const ls = files.filter((f) => /\.(l|lex)$/i.test(f.name));
  const made = {};
  let log = "", ok = true;
  for (const y of ys) {
    const several = ys.length > 1;
    const base = y.name.replace(/\.(y|yacc)$/i, "");
    const r = runTool(tools.yacc, ["yacc", "-d", "-v", ...(several ? ["-b", base] : []), y.name], all);
    log += `$ yacc -d -v ${y.name}\n` + toDiagnostics(r.err + r.out, y.name);
    if (r.code !== 0) { ok = false; continue; }
    const cName = several ? `${base}.tab.c` : "y.tab.c";
    // yacc calls yyerror() without declaring it. Declare it the way this program defines it
    // (int or void, in any file), or as the -ly default, unless the grammar already declares it.
    const err = yyerrorInfo(files);
    if (r.files[cName] !== undefined && !(err.where && err.where === y.name)) {
      r.files[cName] = `/* FoCT Virtual Labs: */ ${err.ret} yyerror();\n` + r.files[cName];
    }
    // Like bison, declare yylval in the header too (scanners written for Linux rely on it).
    const hName = several ? `${base}.tab.h` : "y.tab.h";
    if (r.files[hName] !== undefined && !/\byylval\b/.test(r.files[hName])) {
      r.files[hName] += `
/* added by FoCT Virtual Labs: declare yylval for the scanner, as bison does */
#if !defined(YYSTYPE) && !defined(YYSTYPE_IS_DECLARED)
typedef int YYSTYPE;
#define YYSTYPE_IS_DECLARED 1
#endif
extern YYSTYPE yylval;
`;
    }
    Object.assign(made, r.files);
  }
  if (ok) {
    for (const l of ls) {
      const several = ls.length > 1;
      const outName = several ? l.name.replace(/\.(l|lex)$/i, ".yy.c") : "lex.yy.c";
      const r = runTool(tools.flex, ["lex", ...(several ? [`-o${outName}`] : []), l.name], { ...all, ...made });
      log += `$ lex ${l.name}\n` + toDiagnostics(r.err + r.out, l.name);
      if (r.code !== 0) { ok = false; continue; }
      Object.assign(made, r.files);
    }
  }
  return { ok, log, files: Object.entries(made).map(([name, text]) => ({ name, text })) };
}

// ------------------------------------------------------------------ what -ll and -ly add on Linux
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "");
// a definition: name(...) {   or the old style   name(s) char *s; {
const defRe = (name) => new RegExp(`(?:\\b(void|int)\\s+)?\\b${name}\\s*\\([^;{)]*\\)\\s*(?:\\{|(?:[A-Za-z_][\\w\\s*,\\[\\]]*;\\s*)+\\{)`);
const protoRe = (name) => new RegExp(`\\b(void|int)\\s+${name}\\s*\\([^;{)]*\\)\\s*;`);
function yyerrorInfo(files) {
  let def = null, proto = null;
  for (const f of files) {
    if (!/\.(l|lex|y|yacc|c|h)$/i.test(f.name)) continue;
    const t = stripComments(f.text);
    const d = defRe("yyerror").exec(t);
    if (d && !def) def = { where: f.name, ret: d[1] || "int" };
    const p = protoRe("yyerror").exec(t);
    if (p && !proto) proto = { where: f.name, ret: p[1] };
  }
  const known = def || proto;
  const where = [def, proto].find((x) => x && /\.(y|yacc)$/i.test(x.where))?.where || null;
  return { defined: !!def, ret: known ? known.ret : "void", where };
}
/** C file with the defaults of -ll / -ly for whatever the program does not define itself. */
export function supportC(files) {
  const all = files.filter((f) => /\.(l|lex|y|yacc|c|h)$/i.test(f.name)).map((f) => stripComments(f.text)).join("\n");
  const hasY = files.some((f) => /\.(y|yacc)$/i.test(f.name));
  const err = yyerrorInfo(files);
  const out = ["/* FoCT Virtual Labs: the defaults that -ll and -ly provide on Linux */", "#include <stdio.h>"];
  if (!defRe("yywrap").test(all)) out.push("int yywrap(void) { return 1; }");
  if (hasY && !err.defined) out.push(`${err.ret} yyerror(const char *s) { fprintf(stderr, "%s\\n", s);${err.ret === "int" ? " return 0;" : ""} }`);
  out.push(hasY ? "int yyparse(void);" : "int yylex(void);");
  out.push(`__attribute__((weak)) int main(int argc, char **argv) { (void)argc; (void)argv; ${hasY ? "return yyparse();" : "while (yylex() != 0) { } return 0;"} }`);
  return out.join("\n") + "\n";
}
