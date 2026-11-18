// Keyboard input for programs running in a Web Worker.
//
// Three ways to get a line typed in the Output panel into a running program:
//   jspi  - the program is suspended with WebAssembly JSPI until the line arrives (works over plain HTTP)
//   sab   - the worker blocks on a SharedArrayBuffer (needs HTTPS + cross-origin isolation)
//   batch - only the text from the Input tab is available (old browsers)

const CAP = 1 << 20;
const enc = new TextEncoder();

/** Main-thread side. */
export class StdinHost {
  constructor(mode, preset, console) {
    this.mode = mode;
    this.preset = preset || "";
    this.console = console;
    if (mode === "sab") {
      this.sab = new SharedArrayBuffer(8 + CAP);
      this.hdr = new Int32Array(this.sab, 0, 2);
      this.data = new Uint8Array(this.sab, 8);
    }
  }

  config() {
    return { mode: this.mode, sab: this.sab || null, preset: this.preset };
  }

  /** Called when the worker posts {type: "stdin-request"}. */
  async answer(worker) {
    const line = await this.console.readLine();
    if (this.mode === "sab") {
      if (line === null) {
        Atomics.store(this.hdr, 1, -1);
      } else {
        const bytes = enc.encode(line);
        const n = Math.min(bytes.length, CAP);
        this.data.set(bytes.subarray(0, n));
        Atomics.store(this.hdr, 1, n);
      }
      Atomics.store(this.hdr, 0, 1);
      Atomics.notify(this.hdr, 0);
    } else {
      worker.postMessage({ type: "stdin", data: line });
    }
  }
}

/** Worker side. */
export class StdinSource {
  constructor(cfg, post) {
    this.mode = cfg.mode;
    this.post = post;
    this.preset = cfg.preset ? enc.encode(cfg.preset) : null;
    if (cfg.sab) {
      this.hdr = new Int32Array(cfg.sab, 0, 2);
      this.data = new Uint8Array(cfg.sab, 8);
    }
    this.eof = false;
    this.waiting = null;
    this.beforeWait = null; // flush output before asking for input
  }

  takePreset() {
    if (this.preset && this.preset.length) {
      const p = this.preset;
      this.preset = null;
      return p;
    }
    return null;
  }

  /** Blocking read (sab / batch). Returns bytes, or null at end of input. */
  readSync() {
    const p = this.takePreset();
    if (p) return p;
    if (this.eof || this.mode !== "sab") {
      this.eof = true;
      return null;
    }
    this.beforeWait?.();
    Atomics.store(this.hdr, 0, 0);
    this.post({ type: "stdin-request" });
    Atomics.wait(this.hdr, 0, 0);
    const n = Atomics.load(this.hdr, 1);
    const out = n < 0 ? null : this.data.slice(0, n);
    Atomics.store(this.hdr, 0, 0);
    if (!out) this.eof = true;
    return out;
  }

  /** Non-blocking read for JSPI: returns bytes/null now, or a Promise of them. */
  readAsync() {
    const p = this.takePreset();
    if (p) return p;
    if (this.eof) return null;
    this.beforeWait?.();
    this.post({ type: "stdin-request" });
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  /** Text version used by the Python and Java runners. */
  readLineSync() {
    const b = this.readSync();
    return b === null ? null : new TextDecoder().decode(b);
  }

  async readLineAsync() {
    let b = this.readAsync();
    if (b instanceof Promise) b = await b;
    return b === null ? null : new TextDecoder().decode(b);
  }

  /** Worker onmessage handler calls this for {type: "stdin"} (jspi mode). */
  deliver(text) {
    const r = this.waiting;
    this.waiting = null;
    if (text === null) {
      this.eof = true;
      r?.(null);
    } else {
      r?.(enc.encode(text));
    }
  }
}

/** Batches program output into ~30 ms chunks so the page stays responsive. */
export class OutputBatcher {
  constructor(post, limit = 8 * 1024 * 1024) {
    this.post = post;
    this.buf = { stdout: "", stderr: "" };
    this.order = [];
    this.timer = 0;
    this.total = 0;
    this.limit = limit;
    this.overflow = false;
    this.pending = 0;
    this.lastFlush = performance.now();
  }

  push(stream, text) {
    if (this.overflow) return;
    this.total += text.length;
    if (this.total > this.limit) {
      this.overflow = true;
      this.order.push(["stderr", "\n[Output limit reached - the rest of the output was discarded]\n"]);
      this.flush();
      return;
    }
    const last = this.order[this.order.length - 1];
    if (last && last[0] === stream) last[1] += text;
    else this.order.push([stream, text]);
    this.pending += text.length;
    // A busy program never yields to the event loop, so flush on time/size as well as by timer.
    const now = performance.now();
    if (this.pending > 64 * 1024 || now - this.lastFlush > 40) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 30);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.lastFlush = performance.now();
    this.pending = 0;
    if (!this.order.length) return;
    this.post({ type: "output", chunks: this.order });
    this.order = [];
  }
}
