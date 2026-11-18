// Runs a Java program that TeaVM compiled to WebAssembly (needs WebAssembly GC).
//
// The browser Java runtime cannot pause a program to wait for the keyboard, so input is
// "replayed": the program runs with everything typed so far; when it needs more it stops,
// the student types the next line, and the program runs again from the start with the
// longer input while the output already on screen is skipped. Random numbers and the clock
// are kept identical between replays so the program behaves the same way each time.
import { load } from "/runtimes/teavm/compiler.wasm-runtime.js";
import { OutputBatcher } from "./stdin.js";

const CONTROL_START = "\u0000";
let pendingInput = null;

onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "stdin") { pendingInput?.(m.data); return; }
  if (m.type !== "run") return;

  const post = (x) => postMessage(x);
  const out = new OutputBatcher(post);
  const bytes = m.wasm;

  let input = m.stdin.preset || "";
  let eof = false;
  let shown = "";            // output already on screen (both streams, in order)
  let warnedDiverge = false;
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const clockBase = Date.now();
  const t0 = performance.now();

  const runOnce = async () => {
    let produced = 0;
    let control = null;      // collecting a control message
    let result = null;
    let pend = "", pendStream = "stdout";
    const flushPend = () => { if (pend) { out.push(pendStream, pend); pend = ""; } };
    const emit = (stream, ch) => {
      if (produced < shown.length) {
        if (shown[produced] !== ch && !warnedDiverge) {
          warnedDiverge = true;
          flushPend();
          out.push("stderr", "\n[note: the program printed something different when re-run with your input — it may use the clock or random numbers]\n");
          shown = shown.slice(0, produced);
        } else {
          produced++;
          return;
        }
      }
      produced++;
      shown += ch;
      if (stream !== pendStream) { flushPend(); pendStream = stream; }
      pend += ch;
      if (ch === "\n" || pend.length > 2048) flushPend();
    };
    const onChar = (stream) => (code) => {
      const ch = String.fromCharCode(code);
      if (stream === "stderr" && (control !== null || ch === CONTROL_START)) {
        if (control === null) { control = ""; return; }
        if (ch === CONTROL_START) {
          if (control.startsWith("FOCT:")) result = control.slice(5);
          else for (const c of CONTROL_START + control + ch) emit("stderr", c);
          control = null;
          return;
        }
        control += ch;
        return;
      }
      emit(stream, ch);
    };
    let rng = seed;
    const random = () => {
      rng |= 0; rng = (rng + 0x6d2b79f5) | 0;
      let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const runStart = performance.now();
    const app = await load(bytes, {
      stackDeobfuscator: { enabled: true, path: "/runtimes/teavm/compiler.wasm-deobfuscator.wasm" },
      installImports(o) {
        o.teavmConsole.putcharStdout = onChar("stdout");
        o.teavmConsole.putcharStderr = onChar("stderr");
        o.teavmMath = Object.assign(Object.create(Math), { random });
        if (o.teavmDate) o.teavmDate.currentTimeMillis = () => clockBase + Math.floor(performance.now() - runStart);
      },
    });
    try {
      app.exports.main([input, eof ? "1" : "0"]);
    } finally {
      flushPend();
    }
    return result;
  };

  while (true) {
    let result;
    try {
      result = await runOnce();
    } catch (e) {
      // In this runtime, errors the JVM would raise itself stop the program instead of throwing.
      const msg = String((e && e.message) || e);
      const java = /divide by zero|remainder by zero|division by zero/i.test(msg) ? "java.lang.ArithmeticException: / by zero"
        : /array element access out of bounds|index out of bounds/i.test(msg) ? "java.lang.ArrayIndexOutOfBoundsException"
        : /null pointer|null reference|dereferenc/i.test(msg) ? "java.lang.NullPointerException"
        : /illegal cast|cast/i.test(msg) ? "java.lang.ClassCastException"
        : /call stack/i.test(msg) ? "java.lang.StackOverflowError"
        : /memory/i.test(msg) ? "java.lang.OutOfMemoryError" : null;
      if (java) out.push("stderr", `Exception in thread "main" ${java}\n`);
      out.flush();
      post({
        type: "exit", code: java ? 1 : null, ms: Math.round(performance.now() - t0),
        trap: java ? null : msg,
        note: java ? "Basic Java mode cannot catch this error with try/catch. Open the lab over HTTPS (secure mode) to use the full Java 21 runtime." : null,
      });
      return;
    }
    if (result === "NEED") {
      out.flush();
      const line = await new Promise((resolve) => { pendingInput = resolve; post({ type: "stdin-request" }); });
      pendingInput = null;
      if (line === null) eof = true; else input += line;
      continue;
    }
    out.flush();
    const code = result && result.startsWith("EXIT:") ? parseInt(result.slice(5), 10) : 0;
    post({ type: "exit", code, ms: Math.round(performance.now() - t0) });
    return;
  }
};
