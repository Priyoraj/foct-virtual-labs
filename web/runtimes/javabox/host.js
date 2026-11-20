// Hosts the in-browser OpenJDK 21 (JavaBox, Emscripten) inside a hidden iframe of the code IDE.
// The parent page talks to it with postMessage; see FoctServer.java for the JVM side.
const send = (m) => window.parent.postMessage({ source: "foct-jdk", ...m }, location.origin);

if (!window.crossOriginIsolated) {
  send({ type: "fatal", message: "The full Java runtime needs secure mode (HTTPS or localhost)." });
  throw new Error("cross-origin isolation required");
}

let Module = null;
let phase = "boot";        // boot -> server -> ready
const enc = new TextEncoder();

// The JVM reads stdin from a 3072-byte ring buffer. jvm_stdin_write_string waits on this thread
// until all of its text has gone in, and every line a JVM thread prints waits for this thread
// too. A long write made while the JVM prints therefore left both waiting for each other, and the
// page froze. Text now goes in pieces of at most half the buffer, with a break between pieces in
// which this thread passes on what the JVM printed. Writes are queued so pieces never interleave.
const PIECE = 512;         // UTF-16 units: at most 1.5 KB of UTF-8
let openStdin;
const stdinReady = new Promise((resolve) => { openStdin = resolve; });
let writing = Promise.resolve();

// A message rather than setTimeout: hidden tabs run timers at most once a second.
function nextTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

async function writePieces(text) {
  await stdinReady;
  for (let i = 0; i < text.length; ) {
    let n = Math.min(PIECE, text.length - i);
    const last = text.charCodeAt(i + n - 1);
    if (n < text.length - i && last >= 0xd800 && last <= 0xdbff) n--;   // keep surrogate pairs whole
    Module.ccall("jvm_stdin_write_string", null, ["string"], [text.slice(i, i + n)]);
    i += n;
    if (i < text.length) await nextTask();
  }
}

function write(text) {
  writing = writing.then(() => writePieces(text)).catch((e) => console.error("Java runtime: stdin write failed", e));
  return writing;
}

// Start-up. JavaBox prints JBOX_PONG by itself once it reads stdin (about 4 s after loading) and
// answers each JBOX_PING with another. Pinging every 700 ms until then queued pings whose answers
// came while FoctServer.java was being written: the freeze above. So ping only if that first PONG
// is slow to come, one ping at a time, and start the server once every ping has been answered.
const PING_AFTER_MS = 20000;
let pings = 0, pongs = 0, bootTimer = 0;

function ping() {
  if (phase !== "boot") return;
  pings++;
  write("JBOX_PING\n");
  bootTimer = setTimeout(ping, PING_AFTER_MS);
}

function onPong() {
  pongs++;
  clearTimeout(bootTimer);
  if (pongs > pings) startServer();                   // the ready PONG and an answer to every ping
  else bootTimer = setTimeout(startServer, 1000);     // every ping answered, but no ready PONG yet
}

function onLine(text, isErr) {
  if (phase === "boot") {
    if (text.startsWith("JBOX_PONG")) onPong();
    return;
  }
  if (text.startsWith("\u0001")) return control(text.slice(1));
  if (phase !== "ready") return;
  if (/^JBOX_/.test(text)) return;
  send({ type: "out", stream: isErr ? "stderr" : "stdout", text: text + "\n" });
}

function control(msg) {
  const sp = msg.indexOf(" ");
  const cmd = sp < 0 ? msg : msg.slice(0, sp);
  const arg = sp < 0 ? "" : msg.slice(sp + 1);
  switch (cmd) {
    case "FOCT_READY":
      if (phase !== "ready") { phase = "ready"; send({ type: "ready", version: arg }); }
      break;
    case "FOCT_DIAG": {
      const [kind, file, line, col, ...rest] = arg.split("\t");
      send({ type: "diag", kind, file, line: +line, col: +col, message: rest.join("\t").replace(/\\n/g, "\n").replace(/\\\\/g, "\\") });
      break;
    }
    case "FOCT_COMPILED": send({ type: "compiled", ms: +arg }); break;
    case "FOCT_PART": send({ type: "out", stream: "stdout", text: arg }); break;
    case "FOCT_PARTERR": send({ type: "out", stream: "stderr", text: arg }); break;
    case "FOCT_WAIT": send({ type: "stdin-request" }); break;
    case "FOCT_EXIT": send({ type: "exit", code: arg === "compile" ? "compile" : parseInt(arg, 10) }); break;
    case "FOCT_ERROR": send({ type: "out", stream: "stderr", text: arg + "\n" }); break;
  }
}

let serverStarted = false;
async function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  phase = "server";
  clearTimeout(bootTimer);
  const src = await (await fetch("FoctServer.java")).text();
  write("JBOX_COMPILE FoctServer\n" + src.replace(/\r/g, "") + "\nJBOX_END\n");
}

window.addEventListener("message", (ev) => {
  if (ev.origin !== location.origin || ev.source !== window.parent) return;
  const m = ev.data;
  if (!Module || phase !== "ready") return;
  if (m.type === "run") {
    let out = `FOCT_RUN ${m.main} ${m.files.length}\n`;
    for (const f of m.files) {
      const text = f.text.replace(/\r\n/g, "\n");
      out += `FOCT_FILE ${f.name} ${enc.encode(text).length}\n${text}\n`;
    }
    write(out);
  } else if (m.type === "stdin") {
    write(m.text.endsWith("\n") ? m.text : m.text + "\n");
  } else if (m.type === "eof") {
    write("\u0004\n");
  }
});

(async () => {
  try {
    const wasm = WebAssembly.compileStreaming(fetch("javabox-direct.wasm"));
    const { default: createModule } = await import("./javabox-direct.mjs");
    const compiled = await wasm;
    Module = await createModule({
      print: (t) => onLine(t, false),
      printErr: (t) => {
        if (/^Exception in thread "(Finalizer|Common-Cleaner|Reference Handler)"/.test(t)) return;
        onLine(t, true);
      },
      setStatus: (s) => {
        const m = /\((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\)/.exec(s || "");
        if (m) send({ type: "progress", value: (+m[1] / +m[2]) * 0.8 });
      },
      onExit: (code) => send({ type: "died", code }),
      instantiateWasm(imports, callback) {
        WebAssembly.instantiate(compiled, imports).then((inst) => callback(inst, compiled));
        return {};
      },
    });
    send({ type: "progress", value: 0.85 });
    Module.ccall("jvm_enable_ring_buffer_stdin", null, [], []);
    openStdin();
    if (phase === "boot") bootTimer = setTimeout(ping, PING_AFTER_MS);
  } catch (e) {
    send({ type: "fatal", message: "The Java runtime could not start: " + ((e && e.message) || e) });
  }
})();
