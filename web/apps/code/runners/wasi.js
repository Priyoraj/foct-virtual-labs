// WASI preview1 for programs compiled by Clang (wasm32-wasip1).
// In-memory file system, console I/O, clocks, random numbers and sleep.
// Keyboard input either blocks (SharedArrayBuffer) or suspends (JSPI).

export class WasiExit extends Error {
  constructor(code) {
    super("exit(" + code + ")");
    this.code = code;
  }
}

const E = {
  SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NAMETOOLONG: 37,
  NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, PERM: 63, SPIPE: 70, NOTCAPABLE: 76,
};
const FT_CHAR = 2, FT_DIR = 3, FT_FILE = 4;
const RIGHTS_ALL = (1n << 29n) - 1n;
const RIGHTS_TTY = RIGHTS_ALL & ~(0x4n | 0x20n); // no seek/tell, so libc treats stdio as a terminal
const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
const FDFLAG_APPEND = 1;

let inoCounter = 1;
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));

export class MemFile {
  constructor(data = new Uint8Array(0)) {
    this.type = "file";
    this.data = data;
    this.size = data.length;
    this.ino = BigInt(inoCounter++);
    this.mtime = nowNs();
    this.changed = false;
  }
  ensure(cap) {
    if (cap <= this.data.length) return;
    const n = new Uint8Array(Math.max(cap, this.data.length * 2, 1024));
    n.set(this.data.subarray(0, this.size));
    this.data = n;
  }
  bytes() {
    return this.data.slice(0, this.size);
  }
}

export class MemDir {
  constructor() {
    this.type = "dir";
    this.entries = new Map();
    this.ino = BigInt(inoCounter++);
    this.mtime = nowNs();
  }
}

export class WASI {
  /**
   * @param {object} o
   *   args: string[], env: object, root: MemDir,
   *   stdout(text), stderr(text): output callbacks,
   *   stdin: StdinSource (see stdin-worker.js),
   *   jspi: boolean - wrap blocking calls with WebAssembly.Suspending,
   *   onSystem(cmd): handler for system(); returns exit status
   */
  constructor(o) {
    this.args = o.args || ["program"];
    this.env = Object.entries(o.env || {}).map(([k, v]) => `${k}=${v}`);
    this.root = o.root || new MemDir();
    this.out = [o.stdout, o.stderr];
    this.stdin = o.stdin;
    this.jspi = !!o.jspi;
    this.onSystem = o.onSystem || (() => -1);
    this.memory = null;
    this.dec = [new TextDecoder(), new TextDecoder()];
    this.fds = new Map([
      [0, { kind: "stdin" }],
      [1, { kind: "stdout" }],
      [2, { kind: "stderr" }],
      [3, { kind: "dir", node: this.root, path: [], preopen: "/" }],
    ]);
    this.nextFd = 4;
    this.pendingIn = null; // bytes received but not yet consumed by fd_read
    this.imports = this.buildImports();
  }

  setMemory(mem) { this.memory = mem; }
  get dv() { return new DataView(this.memory.buffer); }
  get u8() { return new Uint8Array(this.memory.buffer); }
  str(ptr, len) { return new TextDecoder().decode(this.u8.subarray(ptr, ptr + len)); }

  // ------------------------------------------------------------ path helpers
  lookup(dirFd, path) {
    const d = this.fds.get(dirFd);
    if (!d || d.kind !== "dir") return { err: E.BADF };
    const parts = path.startsWith("/") ? [] : [...d.path];
    for (const seg of path.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { if (parts.length) parts.pop(); continue; }
      parts.push(seg);
    }
    let node = this.root, parent = null;
    for (let i = 0; i < parts.length; i++) {
      if (node.type !== "dir") return { err: E.NOTDIR };
      parent = node;
      node = node.entries.get(parts[i]);
      if (!node) {
        if (i === parts.length - 1) return { parent, name: parts[i], node: null, parts };
        return { err: E.NOENT };
      }
    }
    return { parent, name: parts[parts.length - 1] || "", node, parts };
  }

  // ------------------------------------------------------------ console output
  write(fd, bytes) {
    const text = this.dec[fd - 1].decode(bytes, { stream: true });
    if (text) this.out[fd - 1](text);
  }

  // ------------------------------------------------------------ stdin
  /** Copy as much pending input as fits into the iovecs. */
  fillIovs(iovs, iovsLen, nreadPtr) {
    const dv = this.dv, u8 = this.u8;
    let total = 0;
    for (let i = 0; i < iovsLen && this.pendingIn && this.pendingIn.length; i++) {
      const ptr = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
      const n = Math.min(len, this.pendingIn.length);
      u8.set(this.pendingIn.subarray(0, n), ptr);
      this.pendingIn = this.pendingIn.subarray(n);
      total += n;
    }
    dv.setUint32(nreadPtr, total, true);
    return E.SUCCESS;
  }

  readStdin(iovs, iovsLen, nreadPtr) {
    if (this.pendingIn && this.pendingIn.length) return this.fillIovs(iovs, iovsLen, nreadPtr);
    if (this.jspi) {
      const r = this.stdin.readAsync();
      if (r instanceof Promise) {
        return r.then((bytes) => {
          this.pendingIn = bytes;
          return this.fillIovs(iovs, iovsLen, nreadPtr);
        });
      }
      this.pendingIn = r;
    } else {
      this.pendingIn = this.stdin.readSync();
    }
    return this.fillIovs(iovs, iovsLen, nreadPtr);
  }

  // ------------------------------------------------------------ imports
  buildImports() {
    const self = this;
    const I = {
      args_sizes_get(argcPtr, bufSizePtr) {
        const dv = self.dv;
        dv.setUint32(argcPtr, self.args.length, true);
        dv.setUint32(bufSizePtr, self.args.reduce((s, a) => s + new TextEncoder().encode(a).length + 1, 0), true);
        return E.SUCCESS;
      },
      args_get(argvPtr, bufPtr) {
        return writeStrings(self, self.args, argvPtr, bufPtr);
      },
      environ_sizes_get(countPtr, bufSizePtr) {
        const dv = self.dv;
        dv.setUint32(countPtr, self.env.length, true);
        dv.setUint32(bufSizePtr, self.env.reduce((s, a) => s + new TextEncoder().encode(a).length + 1, 0), true);
        return E.SUCCESS;
      },
      environ_get(envPtr, bufPtr) {
        return writeStrings(self, self.env, envPtr, bufPtr);
      },
      clock_res_get(id, resPtr) {
        self.dv.setBigUint64(resPtr, 1000n, true);
        return E.SUCCESS;
      },
      clock_time_get(id, precision, timePtr) {
        const t = id === 0 ? nowNs() : BigInt(Math.round(performance.now() * 1e6));
        self.dv.setBigUint64(timePtr, t, true);
        return E.SUCCESS;
      },
      fd_advise() { return E.SUCCESS; },
      fd_allocate() { return E.SUCCESS; },
      fd_close(fd) {
        if (fd <= 2) return E.SUCCESS;
        if (!self.fds.has(fd)) return E.BADF;
        self.fds.delete(fd);
        return E.SUCCESS;
      },
      fd_datasync() { return E.SUCCESS; },
      fd_sync() { return E.SUCCESS; },
      fd_fdstat_get(fd, ptr) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        const dv = self.dv;
        const tty = f.kind === "stdin" || f.kind === "stdout" || f.kind === "stderr";
        dv.setUint8(ptr, tty ? FT_CHAR : f.kind === "dir" ? FT_DIR : FT_FILE);
        dv.setUint8(ptr + 1, 0);
        dv.setUint16(ptr + 2, f.append ? FDFLAG_APPEND : 0, true);
        dv.setUint32(ptr + 4, 0, true);
        dv.setBigUint64(ptr + 8, tty ? RIGHTS_TTY : RIGHTS_ALL, true);
        dv.setBigUint64(ptr + 16, tty ? RIGHTS_TTY : RIGHTS_ALL, true);
        return E.SUCCESS;
      },
      fd_fdstat_set_flags(fd, flags) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        f.append = !!(flags & FDFLAG_APPEND);
        return E.SUCCESS;
      },
      fd_fdstat_set_rights() { return E.SUCCESS; },
      fd_filestat_get(fd, ptr) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind === "file" || f.kind === "dir") return writeStat(self, ptr, f.node);
        writeStat(self, ptr, null);
        return E.SUCCESS;
      },
      fd_filestat_set_size(fd, size) {
        const f = self.fds.get(fd);
        if (!f || f.kind !== "file") return E.BADF;
        const n = Number(size);
        f.node.ensure(n);
        if (n > f.node.size) f.node.data.fill(0, f.node.size, n);
        f.node.size = n;
        f.node.changed = true;
        return E.SUCCESS;
      },
      fd_filestat_set_times() { return E.SUCCESS; },
      fd_pread(fd, iovs, iovsLen, offset, nreadPtr) {
        const f = self.fds.get(fd);
        if (!f || f.kind !== "file") return E.BADF;
        return readFile(self, f, iovs, iovsLen, nreadPtr, Number(offset));
      },
      fd_pwrite(fd, iovs, iovsLen, offset, nwrittenPtr) {
        const f = self.fds.get(fd);
        if (!f || f.kind !== "file") return E.BADF;
        return writeFile(self, f, iovs, iovsLen, nwrittenPtr, Number(offset));
      },
      fd_prestat_get(fd, ptr) {
        const f = self.fds.get(fd);
        if (!f || !f.preopen) return E.BADF;
        self.dv.setUint8(ptr, 0);
        self.dv.setUint32(ptr + 4, new TextEncoder().encode(f.preopen).length, true);
        return E.SUCCESS;
      },
      fd_prestat_dir_name(fd, pathPtr, len) {
        const f = self.fds.get(fd);
        if (!f || !f.preopen) return E.BADF;
        self.u8.set(new TextEncoder().encode(f.preopen).subarray(0, len), pathPtr);
        return E.SUCCESS;
      },
      fd_read(fd, iovs, iovsLen, nreadPtr) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind === "stdin") return self.readStdin(iovs, iovsLen, nreadPtr);
        if (f.kind !== "file") return f.kind === "dir" ? E.ISDIR : E.BADF;
        return readFile(self, f, iovs, iovsLen, nreadPtr, null);
      },
      fd_readdir(fd, buf, bufLen, cookie, usedPtr) {
        const f = self.fds.get(fd);
        if (!f || f.kind !== "dir") return E.BADF;
        const names = [".", "..", ...f.node.entries.keys()];
        const dv = self.dv, u8 = self.u8, enc = new TextEncoder();
        let off = 0;
        for (let i = Number(cookie); i < names.length; i++) {
          const name = enc.encode(names[i]);
          const node = i < 2 ? f.node : f.node.entries.get(names[i]);
          const head = new DataView(new ArrayBuffer(24));
          head.setBigUint64(0, BigInt(i + 1), true);
          head.setBigUint64(8, node.ino, true);
          head.setUint32(16, name.length, true);
          head.setUint8(20, node.type === "dir" ? FT_DIR : FT_FILE);
          const entry = new Uint8Array(24 + name.length);
          entry.set(new Uint8Array(head.buffer), 0);
          entry.set(name, 24);
          const n = Math.min(entry.length, bufLen - off);
          u8.set(entry.subarray(0, n), buf + off);
          off += n;
          if (off >= bufLen) break;
        }
        dv.setUint32(usedPtr, off, true);
        return E.SUCCESS;
      },
      fd_renumber(from, to) {
        const f = self.fds.get(from);
        if (!f) return E.BADF;
        self.fds.set(to, f);
        self.fds.delete(from);
        return E.SUCCESS;
      },
      fd_seek(fd, offset, whence, newPtr) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind !== "file") return E.SPIPE;
        const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.node.size;
        const pos = base + Number(offset);
        if (pos < 0) return E.INVAL;
        f.pos = pos;
        self.dv.setBigUint64(newPtr, BigInt(pos), true);
        return E.SUCCESS;
      },
      fd_tell(fd, ptr) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind !== "file") return E.SPIPE;
        self.dv.setBigUint64(ptr, BigInt(f.pos), true);
        return E.SUCCESS;
      },
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        const f = self.fds.get(fd);
        if (!f) return E.BADF;
        if (f.kind === "stdout" || f.kind === "stderr") {
          const dv = self.dv, u8 = self.u8;
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const ptr = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
            if (len) self.write(fd, u8.slice(ptr, ptr + len));
            total += len;
          }
          dv.setUint32(nwrittenPtr, total, true);
          return E.SUCCESS;
        }
        if (f.kind !== "file") return E.BADF;
        return writeFile(self, f, iovs, iovsLen, nwrittenPtr, null);
      },
      path_create_directory(fd, pathPtr, pathLen) {
        const r = self.lookup(fd, self.str(pathPtr, pathLen));
        if (r.err) return r.err;
        if (r.node) return E.EXIST;
        r.parent.entries.set(r.name, new MemDir());
        return E.SUCCESS;
      },
      path_filestat_get(fd, flags, pathPtr, pathLen, ptr) {
        const r = self.lookup(fd, self.str(pathPtr, pathLen));
        if (r.err) return r.err;
        if (!r.node) return E.NOENT;
        return writeStat(self, ptr, r.node);
      },
      path_filestat_set_times() { return E.SUCCESS; },
      path_link() { return E.NOTSUP; },
      path_open(dirFd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInh, fdflags, fdPtr) {
        const path = self.str(pathPtr, pathLen);
        const r = self.lookup(dirFd, path);
        if (r.err) return r.err;
        let node = r.node;
        if (node) {
          if ((oflags & O_CREAT) && (oflags & O_EXCL)) return E.EXIST;
          if ((oflags & O_DIRECTORY) && node.type !== "dir") return E.NOTDIR;
          if (node.type === "file" && (oflags & O_TRUNC)) { node.size = 0; node.changed = true; node.mtime = nowNs(); }
        } else {
          if (!(oflags & O_CREAT)) return E.NOENT;
          if (!r.parent) return E.NOENT;
          node = new MemFile();
          node.changed = true;
          r.parent.entries.set(r.name, node);
        }
        const fd = self.nextFd++;
        self.fds.set(fd, node.type === "dir"
          ? { kind: "dir", node, path: r.parts }
          : { kind: "file", node, pos: 0, append: !!(fdflags & FDFLAG_APPEND), path: r.parts });
        self.dv.setUint32(fdPtr, fd, true);
        return E.SUCCESS;
      },
      path_readlink() { return E.INVAL; },
      path_remove_directory(fd, pathPtr, pathLen) {
        const r = self.lookup(fd, self.str(pathPtr, pathLen));
        if (r.err) return r.err;
        if (!r.node) return E.NOENT;
        if (r.node.type !== "dir") return E.NOTDIR;
        if (r.node.entries.size) return E.NOTEMPTY;
        r.parent.entries.delete(r.name);
        return E.SUCCESS;
      },
      path_rename(fd, oldPtr, oldLen, newFd, newPtr, newLen) {
        const a = self.lookup(fd, self.str(oldPtr, oldLen));
        const b = self.lookup(newFd, self.str(newPtr, newLen));
        if (a.err) return a.err;
        if (b.err) return b.err;
        if (!a.node) return E.NOENT;
        a.parent.entries.delete(a.name);
        b.parent.entries.set(b.name, a.node);
        if (a.node.type === "file") a.node.changed = true;
        return E.SUCCESS;
      },
      path_symlink() { return E.NOTSUP; },
      path_unlink_file(fd, pathPtr, pathLen) {
        const r = self.lookup(fd, self.str(pathPtr, pathLen));
        if (r.err) return r.err;
        if (!r.node) return E.NOENT;
        if (r.node.type === "dir") return E.ISDIR;
        r.parent.entries.delete(r.name);
        return E.SUCCESS;
      },
      poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
        const dv = self.dv;
        let sleepMs = 0, hasClock = false, events = [];
        for (let i = 0; i < nsubs; i++) {
          const b = inPtr + i * 48;
          const userdata = dv.getBigUint64(b, true);
          const tag = dv.getUint8(b + 8);
          if (tag === 0) {
            const id = dv.getUint32(b + 16, true);
            let ns = dv.getBigUint64(b + 24, true);
            const flags = dv.getUint16(b + 40, true);
            if (flags & 1) ns = ns - (id === 0 ? nowNs() : BigInt(Math.round(performance.now() * 1e6)));
            const ms = Math.max(0, Number(ns) / 1e6);
            sleepMs = hasClock ? Math.min(sleepMs, ms) : ms;
            hasClock = true;
            events.push([userdata, 0, 0]);
          } else {
            events.push([userdata, tag, 1]);
          }
        }
        const finish = () => {
          const d = self.dv;
          events.forEach(([ud, type, nbytes], i) => {
            const o = outPtr + i * 32;
            d.setBigUint64(o, ud, true);
            d.setUint16(o + 8, 0, true);
            d.setUint8(o + 10, type);
            d.setBigUint64(o + 16, BigInt(nbytes), true);
            d.setUint16(o + 24, 0, true);
          });
          d.setUint32(neventsPtr, events.length, true);
          return E.SUCCESS;
        };
        const onlyClock = events.every((e) => e[1] === 0);
        if (hasClock && onlyClock && sleepMs > 0) {
          if (self.jspi) return new Promise((res) => setTimeout(() => res(finish()), sleepMs));
          sleepSync(sleepMs);
        }
        return finish();
      },
      proc_exit(code) {
        throw new WasiExit(code);
      },
      proc_raise() { return E.NOSYS; },
      random_get(buf, len) {
        const u8 = self.u8;
        for (let off = 0; off < len; off += 65536) {
          crypto.getRandomValues(u8.subarray(buf + off, buf + Math.min(len, off + 65536)));
        }
        return E.SUCCESS;
      },
      sched_yield() { return E.SUCCESS; },
      sock_accept() { return E.NOSYS; },
      sock_recv() { return E.NOSYS; },
      sock_send() { return E.NOSYS; },
      sock_shutdown() { return E.NOSYS; },
    };
    if (this.jspi) {
      I.fd_read = new WebAssembly.Suspending(I.fd_read);
      I.poll_oneoff = new WebAssembly.Suspending(I.poll_oneoff);
    }
    return I;
  }

  /** FoCT helpers linked into every C/C++ program (system()). */
  foctImports() {
    return {
      system: (ptr) => {
        if (!ptr) return 1;
        const u8 = this.u8;
        let end = ptr;
        while (u8[end]) end++;
        return this.onSystem(new TextDecoder().decode(u8.subarray(ptr, end)));
      },
    };
  }

  /** Files created or changed by the program. */
  changedFiles() {
    const out = [];
    const walk = (dir, prefix) => {
      for (const [name, node] of dir.entries) {
        if (node.type === "dir") walk(node, prefix + name + "/");
        else if (node.changed) out.push({ name: prefix + name, data: node.bytes() });
      }
    };
    walk(this.root, "");
    return out;
  }
}

function writeStrings(self, list, ptrs, buf) {
  const dv = self.dv, u8 = self.u8, enc = new TextEncoder();
  let off = buf;
  list.forEach((s, i) => {
    dv.setUint32(ptrs + i * 4, off, true);
    const b = enc.encode(s);
    u8.set(b, off);
    u8[off + b.length] = 0;
    off += b.length + 1;
  });
  return E.SUCCESS;
}

function writeStat(self, ptr, node) {
  const dv = self.dv;
  dv.setBigUint64(ptr, 1n, true);
  dv.setBigUint64(ptr + 8, node ? node.ino : 0n, true);
  dv.setUint8(ptr + 16, !node ? FT_CHAR : node.type === "dir" ? FT_DIR : FT_FILE);
  for (let i = 17; i < 24; i++) dv.setUint8(ptr + i, 0);
  dv.setBigUint64(ptr + 24, 1n, true);
  dv.setBigUint64(ptr + 32, BigInt(node && node.type === "file" ? node.size : 0), true);
  const t = node ? node.mtime : nowNs();
  dv.setBigUint64(ptr + 40, t, true);
  dv.setBigUint64(ptr + 48, t, true);
  dv.setBigUint64(ptr + 56, t, true);
  return E.SUCCESS;
}

function readFile(self, f, iovs, iovsLen, nreadPtr, at) {
  const dv = self.dv, u8 = self.u8, node = f.node;
  let pos = at ?? f.pos, total = 0;
  for (let i = 0; i < iovsLen; i++) {
    const ptr = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
    const n = Math.max(0, Math.min(len, node.size - pos));
    u8.set(node.data.subarray(pos, pos + n), ptr);
    pos += n;
    total += n;
    if (n < len) break;
  }
  if (at == null) f.pos = pos;
  dv.setUint32(nreadPtr, total, true);
  return E.SUCCESS;
}

function writeFile(self, f, iovs, iovsLen, nwrittenPtr, at) {
  const dv = self.dv, u8 = self.u8, node = f.node;
  let pos = at ?? (f.append ? node.size : f.pos), total = 0;
  for (let i = 0; i < iovsLen; i++) {
    const ptr = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
    node.ensure(pos + len);
    if (pos > node.size) node.data.fill(0, node.size, pos);
    node.data.set(u8.subarray(ptr, ptr + len), pos);
    pos += len;
    total += len;
    if (pos > node.size) node.size = pos;
  }
  if (at == null) f.pos = pos;
  node.changed = true;
  node.mtime = nowNs();
  dv.setUint32(nwrittenPtr, total, true);
  return E.SUCCESS;
}

let sleepCell = null;
function sleepSync(ms) {
  ms = Math.min(ms, 60000);
  if (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated) {
    sleepCell ||= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleepCell, 0, 0, ms);
    return;
  }
  const end = performance.now() + ms;
  while (performance.now() < end) { /* busy wait inside the worker */ }
}
