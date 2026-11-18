// Output console with inline keyboard input for running programs.

const LIMIT = 1_500_000; // characters kept on screen

export class Console {
  constructor(root) {
    this.root = root;
    this.pre = document.createElement("pre");
    root.appendChild(this.pre);
    this.queue = [];
    this.raf = 0;
    this.size = 0;
    this.trimmed = false;
    this.inputEl = null;
    this.inputResolve = null;
    this.onLinkClick = null;
    this.history = [];
  }

  clear() {
    this.cancelInput();
    this.queue.length = 0;
    this.pre.textContent = "";
    this.size = 0;
    this.trimmed = false;
  }

  /** Append program/system text. kind: out | err | warn | info | ok | in */
  write(text, kind = "out") {
    if (!text) return;
    this.queue.push([kind, text]);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  flush() {
    this.raf = 0;
    if (!this.queue.length) return;
    const stick = this.atBottom();
    const frag = document.createDocumentFragment();
    let lastSpan = this.pre.lastElementChild;
    if (lastSpan && (lastSpan === this.inputWrap || lastSpan.tagName !== "SPAN" || lastSpan.dataset.kind == null)) lastSpan = null;
    for (let [kind, text] of this.queue) {
      const cls = text.lastIndexOf("\x1b[2J");
      if (cls >= 0) {
        // clrscr() / system("cls"): clear the screen
        this.pre.textContent = "";
        frag.textContent = "";
        lastSpan = null;
        this.size = 0;
        text = text.slice(cls + 4);
      }
      text = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n");
      if (!text) continue;
      if (lastSpan && lastSpan.dataset.kind === kind) {
        lastSpan.appendChild(document.createTextNode(text));
      } else {
        const s = document.createElement("span");
        s.className = "k-" + kind;
        s.dataset.kind = kind;
        s.textContent = text;
        frag.appendChild(s);
        lastSpan = s;
      }
      this.size += text.length;
    }
    this.queue.length = 0;
    if (this.inputWrap && this.inputWrap.parentNode === this.pre) this.pre.insertBefore(frag, this.inputWrap);
    else this.pre.appendChild(frag);
    if (this.size > LIMIT) this.trim();
    if (stick) this.scrollToEnd();
  }

  trim() {
    while (this.size > LIMIT * 0.7 && this.pre.firstChild && this.pre.firstChild !== this.inputWrap) {
      this.size -= this.pre.firstChild.textContent.length;
      this.pre.firstChild.remove();
    }
    if (!this.trimmed) {
      this.trimmed = true;
      const n = document.createElement("span");
      n.className = "k-sys";
      n.textContent = "(older output was removed to keep the page fast)";
      this.pre.prepend(n);
    }
  }

  /** A block line in the system font (run banner, compile messages). */
  system(text, cls = "") {
    this.flush();
    const s = document.createElement("span");
    s.className = "k-sys " + cls;
    s.textContent = text;
    this.pre.appendChild(s);
    this.scrollToEnd();
    return s;
  }

  html(node) {
    this.flush();
    this.pre.appendChild(node);
    this.scrollToEnd();
  }

  image(url, alt = "plot") {
    const img = document.createElement("img");
    img.className = "con-img";
    img.src = url;
    img.alt = alt;
    img.onload = () => this.scrollToEnd();
    this.html(img);
  }

  exit(text, ok) {
    this.flush();
    const s = document.createElement("span");
    s.className = "k-exit " + (ok ? "ok" : "bad");
    s.textContent = text;
    this.pre.appendChild(s);
    this.scrollToEnd();
  }

  atBottom() {
    const r = this.root;
    return r.scrollHeight - r.scrollTop - r.clientHeight < 40;
  }

  scrollToEnd() {
    this.root.scrollTop = this.root.scrollHeight;
  }

  /** Ask the student for one line of input. Resolves with "text\n", or null for end-of-input. */
  readLine() {
    this.flush();
    this.cancelInput();
    return new Promise((resolve) => {
      const wrap = document.createElement("span");
      wrap.className = "con-input-wrap";
      const input = document.createElement("input");
      input.className = "con-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Program input");
      const hint = document.createElement("span");
      hint.className = "con-input-hint";
      hint.textContent = "Enter ↵ to send · Ctrl+D = end of input";
      wrap.append(input, hint);
      let hi = this.history.length;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const v = input.value;
          if (v) this.history.push(v);
          this.finishInput(v + "\n");
        } else if ((e.key === "d" || e.key === "D" || e.key === "z" || e.key === "Z") && e.ctrlKey) {
          e.preventDefault();
          if (input.value) this.finishInput(input.value); else this.finishInput(null);
        } else if (e.key === "ArrowUp" && this.history.length) {
          e.preventDefault();
          hi = Math.max(0, hi - 1);
          input.value = this.history[hi] || "";
        } else if (e.key === "ArrowDown" && this.history.length) {
          e.preventDefault();
          hi = Math.min(this.history.length, hi + 1);
          input.value = this.history[hi] || "";
        }
      });
      this.inputEl = input;
      this.inputWrap = wrap;
      this.inputResolve = resolve;
      this.pre.appendChild(wrap);
      this.scrollToEnd();
      input.focus({ preventScroll: true });
    });
  }

  finishInput(value) {
    const resolve = this.inputResolve;
    if (!resolve) return;
    this.inputResolve = null;
    this.inputWrap.remove();
    this.inputEl = this.inputWrap = null;
    if (value === null) this.write("^D\n", "info");
    else this.write(value, "in");
    this.flush();
    resolve(value);
  }

  cancelInput() {
    if (this.inputResolve) {
      const r = this.inputResolve;
      this.inputResolve = null;
      this.inputWrap?.remove();
      this.inputEl = this.inputWrap = null;
      r(null);
    }
  }

  focusInput() {
    this.inputEl?.focus();
  }

  get waitingForInput() {
    return !!this.inputResolve;
  }
}
