// Main-thread side of the language runners. Each runner exposes:
//   load(onProgress)  - start the compiler/interpreter in the background
//   run(ctx)          - compile + run; resolves when the program ends
//   stop()            - stop the running program
// ctx = { files:[{name,text}], main, settings, console, stdinMode, preset,
//         onStatus(text), onCompiled({ok, log, ms}), onProgress(fraction) }
import { StdinHost } from "./stdin.js";
import { SHIMS, rewriteJava, findMainClasses } from "./java-support.js";

const enc = new TextEncoder();

function attachOutput(worker, ctx, extra) {
  const stdin = new StdinHost(ctx.stdinMode, ctx.preset, ctx.console);
  return {
    stdin,
    handle(m) {
      if (m.type === "output") {
        for (const [s, t] of m.chunks) ctx.console.write(t, s === "stderr" ? "err" : "out");
        return true;
      }
      if (m.type === "stdin-request") { stdin.answer(worker); return true; }
      if (m.type === "info") { ctx.console.write(m.text, "info"); return true; }
      if (m.type === "image") {
        ctx.console.image(URL.createObjectURL(new Blob([m.png], { type: "image/png" })));
        return true;
      }
      return extra ? extra(m) : false;
    },
  };
}

// ---------------------------------------------------------------- C / C++
export class ClangRunner {
  constructor(lang, getSettings = () => ({})) {
    this.lang = lang;
    this.getSettings = getSettings;
    this.engine = lang === "lex" ? "lex + yacc + Clang" : "Clang 22";
    this.compiler = null;
    this.ready = null;
    this.progress = null;
    this.current = null;
  }

  load(onProgress) {
    this.progress = onProgress;
    if (this.ready) return this.ready;
    this.compiler = new Worker(new URL("./clang-worker.js", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.compiler.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "progress") this.progress?.(m.total ? m.done / m.total : 0);
        else if (m.type === "ready") resolve();
        else if (m.type === "fatal") reject(new Error(m.message));
      };
      this.compiler.onerror = (e) => reject(new Error(e.message || "The compiler could not start."));
    });
    const st = this.getSettings();
    this.compiler.postMessage({
      type: "warmup", lang: this.lang, std: this.lang === "cpp" ? st.cppStd : st.cStd, opt: st.opt, warnings: st.warnings,
    });
    this.ready.catch(() => { this.ready = null; this.compiler?.terminate(); });
    return this.ready;
  }

  compile(files, settings) {
    return new Promise((resolve) => {
      this.compiler.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "compiled") resolve(m);
        else if (m.type === "progress") this.progress?.(m.total ? m.done / m.total : 0);
        else if (m.type === "status") this.onStatus?.(m.text);
        else if (m.type === "fatal") resolve({ ok: false, log: m.message });
      };
      this.compiler.postMessage({
        type: "compile", lang: this.lang, files,
        std: this.lang === "cpp" ? settings.cppStd : settings.cStd,
        opt: settings.opt, warnings: settings.warnings,
      });
    });
  }

  async run(ctx) {
    this.stopped = false;
    await this.load(ctx.onProgress);
    ctx.onStatus(this.lang === "lex" ? "Running lex and yacc, compiling…" : "Compiling…");
    this.onStatus = (text) => { ctx.onStatus(text); ctx.console.write(text + "\n", "info"); };
    const c = await this.compile(ctx.files, ctx.settings);
    this.onStatus = null;
    ctx.onCompiled(c);
    if (!c.ok || this.stopped) return { compiled: c.ok, stopped: this.stopped };
    ctx.onStatus("Running…");
    const r = await this.execute(c.wasm, ctx);
    if (c.generated && c.generated.length) r.files = [...c.generated.map((f) => ({ name: f.name, data: enc.encode(f.text) })), ...(r.files || [])];
    return r;
  }

  execute(wasm, ctx) {
    return new Promise((resolve) => {
      const w = new Worker(new URL("./wasi-worker.js", import.meta.url), { type: "module" });
      const io = attachOutput(w, ctx);
      const finish = (r) => {
        if (!this.current) return;
        this.current = null;
        w.terminate();
        ctx.console.cancelInput();
        resolve({ compiled: true, ...r });
      };
      this.current = { finish };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (io.handle(m)) return;
        if (m.type === "exit") finish({ code: m.code, trap: m.trap, ms: m.ms, files: m.files });
      };
      w.onerror = (e) => finish({ code: null, trap: "Internal error: " + (e.message || "worker failed") });
      const files = ctx.files.map((f) => ({ name: f.name, data: enc.encode(f.text) }));
      w.postMessage({ type: "run", wasm, files, stdin: io.stdin.config() }, [wasm.buffer]);
    });
  }

  stop() {
    this.stopped = true;
    this.current?.finish({ stopped: true });
  }
}

// ---------------------------------------------------------------- Python
export class PythonRunner {
  constructor() {
    this.engine = "Python";
    this.worker = null;
    this.ready = null;
    this.current = null;
    this.interrupt = null;
  }

  load(onProgress) {
    if (this.ready) return this.ready;
    onProgress?.(0.1);
    this.worker = new Worker(new URL("./python-worker.js", import.meta.url), { type: "module" });
    this.interrupt = self.crossOriginIsolated ? new Int8Array(new SharedArrayBuffer(1)) : null;
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "ready") { this.engine = "Python " + m.python; onProgress?.(1); resolve(); }
        else if (m.type === "fatal") reject(new Error(m.message));
      };
      this.worker.onerror = (e) => reject(new Error(e.message || "Python could not start."));
    });
    this.worker.postMessage({ type: "init", interrupt: this.interrupt });
    this.ready.catch(() => { this.ready = null; this.worker?.terminate(); });
    return this.ready;
  }

  async run(ctx) {
    await this.load(ctx.onProgress);
    ctx.onStatus("Running…");
    if (this.interrupt) this.interrupt[0] = 0;
    return new Promise((resolve) => {
      const w = this.worker;
      const io = attachOutput(w, ctx);
      const finish = (r) => {
        if (!this.current) return;
        this.current = null;
        ctx.console.cancelInput();
        resolve({ compiled: true, ...r });
      };
      this.current = { finish, io };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (io.handle(m)) return;
        if (m.type === "exit") finish({ code: m.code, ms: m.ms, files: m.files });
      };
      w.onerror = (e) => finish({ code: null, trap: "Internal error: " + (e.message || "worker failed") });
      w.postMessage({ type: "run", files: ctx.files, main: ctx.main, stdin: io.stdin.config() });
    });
  }

  stop() {
    const cur = this.current;
    if (!cur) return;
    if (this.interrupt) {
      // Ask Python to raise KeyboardInterrupt; if it does not stop soon, restart the worker.
      this.interrupt[0] = 2;
      if (cur.io) cur.io.stdin.console.cancelInput();
      setTimeout(() => { if (this.current === cur) this.restart(cur); }, 1500);
    } else {
      this.restart(cur);
    }
  }

  restart(cur) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    cur.finish({ stopped: true });
    this.load();
  }
}

// ---------------------------------------------------------------- Java (full OpenJDK 21, secure mode)

export class JdkJavaRunner {
  constructor() {
    this.engine = "Java 21";
    this.full = true;
    this.frame = null;
    this.ready = null;
    this.current = null;
    this.progress = null;
    window.addEventListener("message", (e) => this.onMessage(e));
  }

  onMessage(e) {
    if (e.origin !== location.origin || !e.data || e.data.source !== "foct-jdk") return;
    if (this.frame && e.source !== this.frame.contentWindow) return;
    const m = e.data;
    if (m.type === "progress") this.progress?.(m.value);
    else if (m.type === "ready") { this.engine = "Java " + m.version.split(".")[0] + " (OpenJDK)"; this.resolveReady?.(); }
    else if (m.type === "fatal") this.rejectReady?.(new Error(m.message));
    else if (m.type === "died") { this.current?.finish({ code: m.code }); this.reset(); this.load(); }
    else this.current?.handle(m);
  }

  load(onProgress) {
    if (onProgress) this.progress = onProgress;
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.frame = document.createElement("iframe");
    this.frame.src = "/runtimes/javabox/host.html";
    this.frame.title = "Java runtime";
    this.frame.style.display = "none";
    document.body.appendChild(this.frame);
    this.ready.catch(() => this.reset());
    return this.ready;
  }

  reset() {
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
  }

  async run(ctx) {
    this.stopped = false;
    await this.load(ctx.onProgress);
    ctx.onStatus("Compiling…");
    const src = ctx.files.filter((f) => f.name.endsWith(".java"));
    const mains = [];
    for (const f of src) for (const cls of findMainClasses(f.text)) mains.push({ cls, file: f.name });
    const main = mains.find((m) => m.file === ctx.main) || mains[0];
    if (!main) {
      ctx.onCompiled({ ok: false, log: "No main method found.\nAdd  public static void main(String[] args) { ... }  to one of your classes." });
      return { compiled: false };
    }
    const files = src.map((f) => ({ name: f.name, text: rewriteJava(f.text, { jdk: true }).text }));
    files.push({ name: "foct/Sys.java", text: SHIMS["Sys.java"] }, { name: "foct/ExitError.java", text: SHIMS["ExitError.java"] });
    const win = this.frame.contentWindow;
    return new Promise((resolve) => {
      const diags = [];
      let compiled = false;
      const t0 = performance.now();
      const finish = (r) => {
        if (this.current !== cur) return;
        this.current = null;
        ctx.console.cancelInput();
        resolve(r);
      };
      const cur = {
        finish,
        handle: async (m) => {
          if (m.type === "diag") diags.push(m);
          else if (m.type === "compiled") {
            compiled = true;
            ctx.onCompiled({ ok: true, ms: m.ms, log: formatDiags(diags) });
            ctx.onStatus("Running…");
          } else if (m.type === "out") ctx.console.write(m.text, m.stream === "stderr" ? "err" : "out");
          else if (m.type === "stdin-request") {
            const line = await ctx.console.readLine();
            if (this.current !== cur) return;
            win.postMessage(line === null ? { type: "eof" } : { type: "stdin", text: line }, location.origin);
          } else if (m.type === "exit") {
            if (m.code === "compile") {
              ctx.onCompiled({ ok: false, log: formatDiags(diags) });
              finish({ compiled: false });
            } else {
              finish({ compiled: true, code: m.code, ms: Math.round(performance.now() - t0) });
            }
          }
        },
      };
      this.current = cur;
      void compiled;
      win.postMessage({ type: "run", main: main.cls, files }, location.origin);
    });
  }

  stop() {
    this.stopped = true;
    if (!this.current) return;
    // A running JVM cannot be interrupted safely: restart it (takes a few seconds).
    this.current.finish({ stopped: true });
    this.reset();
    this.load();
  }
}

function formatDiags(list) {
  return list.map((d) => {
    const sev = /ERROR/.test(d.kind) ? "error" : /WARN/.test(d.kind) ? "warning" : "note";
    const msg = d.message.split("\n");
    const head = d.file && !d.file.startsWith("foct/") ? `${d.file}:${d.line}:${d.col}: ${sev}: ${msg[0]}` : `${sev}: ${msg[0]}`;
    return [head, ...msg.slice(1)].join("\n");
  }).join("\n");
}

// ---------------------------------------------------------------- Java (TeaVM, basic mode)
export class JavaRunner {
  constructor() {
    this.engine = "Java (basic mode)";
    this.compiler = null;
    this.ready = null;
    this.current = null;
  }

  load(onProgress) {
    if (this.ready) return this.ready;
    onProgress?.(0.1);
    this.compiler = new Worker(new URL("./java-worker.js", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.compiler.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "progress") onProgress?.(m.value);
        else if (m.type === "ready") { onProgress?.(1); resolve(); }
        else if (m.type === "fatal") reject(new Error(m.message));
      };
      this.compiler.onerror = (e) => reject(new Error(e.message || "The Java compiler could not start."));
    });
    this.compiler.postMessage({ type: "init" });
    this.ready.catch(() => { this.ready = null; this.compiler?.terminate(); });
    return this.ready;
  }

  compile(files, main) {
    return new Promise((resolve) => {
      this.compiler.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "compiled") resolve(m);
        else if (m.type === "fatal") resolve({ ok: false, log: m.message, diagnostics: [] });
      };
      this.compiler.postMessage({ type: "compile", files, main });
    });
  }

  async run(ctx) {
    this.stopped = false;
    await this.load(ctx.onProgress);
    ctx.onStatus("Compiling…");
    const c = await this.compile(ctx.files.filter((f) => f.name.endsWith(".java")), ctx.main);
    ctx.onCompiled(c);
    if (!c.ok || this.stopped) return { compiled: c.ok, stopped: this.stopped };
    ctx.onStatus("Running…");
    return new Promise((resolve) => {
      const w = new Worker(new URL("./java-run-worker.js", import.meta.url), { type: "module" });
      // Java input always arrives by message: TeaVM suspends the program itself.
      const io = attachOutput(w, { ...ctx, stdinMode: "jspi" });
      const finish = (r) => {
        if (!this.current) return;
        this.current = null;
        w.terminate();
        ctx.console.cancelInput();
        resolve({ compiled: true, ...r });
      };
      this.current = { finish };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (io.handle(m)) return;
        if (m.type === "exit") finish({ code: m.code, trap: m.trap, ms: m.ms, note: m.note });
      };
      w.onerror = (e) => finish({ code: null, trap: "Internal error: " + (e.message || "worker failed") });
      w.postMessage({ type: "run", wasm: c.wasm, stdin: io.stdin.config() }, [c.wasm.buffer]);
    });
  }

  stop() {
    this.stopped = true;
    this.current?.finish({ stopped: true });
  }
}
