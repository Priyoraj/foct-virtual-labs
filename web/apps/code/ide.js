// FoCT Virtual Labs - code IDE (C, C++, Java, Python)
import { LANGS, monacoLanguageFor } from "./langs.js";
import { registerLexYacc } from "./lexyacc-examples.js";
import { Console } from "./console.js";
import { ClangRunner, PythonRunner, JavaRunner, JdkJavaRunner } from "./runners/runners.js";
import {
  toast, modal, prompt, saveToDisk, pickFiles, downloadBlob, makeZip, systemCheck, inputMode,
  currentTheme, toggleTheme, canPickFiles, escapeHtml,
} from "/assets/js/foct.js";

// ------------------------------------------------------------------ setup
const params = new URLSearchParams(location.search);
const LANG = LANGS[params.get("lang")] || LANGS.c;
const KEY = `foct.code.${LANG.id}`;
const SETTINGS_KEY = "foct.code.settings";
const cap = systemCheck();
const MODE = inputMode(cap);

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const settings = Object.assign({
  fontSize: 15, wordWrap: false, minimap: false, cStd: "c17", cppStd: "c++20", opt: "-O1",
  warnings: true, clearOnRun: true,
}, store.get(SETTINGS_KEY, {}));

document.title = `${LANG.title} · FoCT Virtual Labs`;
$("lang").value = LANG.id;
$("mode").textContent = LANG.runner === "java" || MODE !== "batch" ? "Keyboard input: live" : "Keyboard input: Input tab";

const con = new Console($("console"));
// Java: the full OpenJDK 21 needs cross-origin isolation (HTTPS or localhost); otherwise TeaVM.
const JAVA_FULL = LANG.runner === "java" && cap.isolated && params.get("engine") !== "basic";
const runner = LANG.runner === "clang" ? new ClangRunner(LANG.id, () => settings)
  : LANG.runner === "java" ? (JAVA_FULL ? new JdkJavaRunner() : new JavaRunner())
  : new PythonRunner();

let monaco, editor;
let tabs = [];   // {name, model, saved, handle, viewState}
let active = null;
let running = false;
let lastFiles = [];

// ------------------------------------------------------------------ Monaco
function loadMonaco() {
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
  });
}

function monacoTheme() {
  return currentTheme() === "dark" ? "vs-dark" : "vs";
}

function registerSnippets() {
  const snip = (lang, items) => monaco.languages.registerCompletionItemProvider(lang, {
    provideCompletionItems(model, pos) {
      const w = model.getWordUntilPosition(pos);
      const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      return {
        suggestions: items.map(([label, body, doc]) => ({
          label, insertText: body, documentation: doc, range,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        })),
      };
    },
  });
  const cCommon = [
    ["for", "for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}", "for loop"],
    ["while", "while (${1:condition}) {\n\t$0\n}", "while loop"],
    ["if", "if (${1:condition}) {\n\t$0\n}", "if statement"],
    ["ifelse", "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}", "if / else"],
    ["switch", "switch (${1:value}) {\ncase ${2:1}:\n\t$0\n\tbreak;\ndefault:\n\tbreak;\n}", "switch statement"],
  ];
  snip("c", [
    ["main", "#include <stdio.h>\n\nint main(void) {\n\t$0\n\treturn 0;\n}", "main function"],
    ["printf", "printf(\"${1:%d}\\n\", ${2:value});", "print formatted"],
    ["scanf", "scanf(\"${1:%d}\", &${2:variable});", "read input"],
    ...cCommon,
  ]);
  snip("cpp", [
    ["main", "#include <iostream>\nusing namespace std;\n\nint main() {\n\t$0\n\treturn 0;\n}", "main function"],
    ["cout", "cout << ${1:value} << endl;", "print"],
    ["cin", "cin >> ${1:variable};", "read input"],
    ["class", "class ${1:Name} {\npublic:\n\t${1:Name}() {}\n\t$0\n};", "class"],
    ...cCommon,
  ]);
  snip("java", [
    ["psvm", "public static void main(String[] args) {\n\t$0\n}", "main method"],
    ["main", "public static void main(String[] args) {\n\t$0\n}", "main method"],
    ["sout", "System.out.println(${1});", "print a line"],
    ["souf", "System.out.printf(\"${1:%d%n}\", ${2});", "print formatted"],
    ["scanner", "Scanner ${1:sc} = new Scanner(System.in);", "read input"],
    ["fori", "for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}", "for loop"],
    ["foreach", "for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}", "for-each loop"],
    ["trycatch", "try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}", "try / catch"],
  ]);
  snip("python", [
    ["main", "def main():\n\t$0\n\n\nif __name__ == \"__main__\":\n\tmain()", "main guard"],
    ["for", "for ${1:i} in range(${2:n}):\n\t$0", "for loop"],
    ["def", "def ${1:name}(${2:args}):\n\t$0", "function"],
    ["class", "class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t$0", "class"],
  ]);
}

// ------------------------------------------------------------------ tabs
function uriFor(name) {
  return monaco.Uri.parse(`file:///${LANG.id}/${encodeURIComponent(name)}`);
}

function addTab(name, text, { saved = text, handle = null, activate = true } = {}) {
  let tab = tabs.find((t) => t.name === name);
  if (tab) {
    tab.model.setValue(text);
    tab.saved = saved;
    tab.handle = handle || tab.handle;
  } else {
    const model = monaco.editor.createModel(text, monacoLanguageFor(name, LANG.id), uriFor(name));
    tab = { name, model, saved, handle, viewState: null };
    model.onDidChangeContent(() => { renderTabs(); scheduleDraft(); });
    tabs.push(tab);
  }
  if (activate) activate_(tab);
  renderTabs();
  scheduleDraft();
  return tab;
}

function activate_(tab) {
  if (active && active !== tab) active.viewState = editor.saveViewState();
  active = tab;
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  renderTabs();
  scheduleDraft();
}

function isDirty(t) {
  return t.model.getValue() !== t.saved;
}

function renderTabs() {
  const bar = $("filetabs");
  bar.textContent = "";
  for (const t of tabs) {
    const b = document.createElement("button");
    b.className = "ftab" + (t === active ? " active" : "") + (isDirty(t) ? " dirty" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(t === active));
    b.title = t.name + (isDirty(t) ? " (not saved to your computer)" : "");
    const label = document.createElement("span");
    label.textContent = t.name;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "Close";
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    b.append(label, x);
    b.onclick = () => activate_(t);
    b.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    bar.appendChild(b);
  }
  const add = document.createElement("button");
  add.className = "ftab-add";
  add.title = "New file (Alt+N)";
  add.textContent = "+";
  add.onclick = newFile;
  bar.appendChild(add);
}

async function closeTab(t) {
  if (isDirty(t)) {
    const ok = await modal({
      title: `Close ${t.name}?`,
      html: "<p>This file has changes that are not saved to your computer.</p>",
      actions: [{ label: "Cancel", value: false }, { label: "Close without saving", value: true, danger: true }],
    });
    if (!ok) return;
  }
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  t.model.dispose();
  if (!tabs.length) addTab(LANG.main, LANG.template);
  else if (active === t) activate_(tabs[Math.max(0, i - 1)]);
  renderTabs();
  scheduleDraft();
}

let draftTimer = 0;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}
function saveDraft() {
  store.set(KEY, {
    tabs: tabs.map((t) => ({ name: t.name, text: t.model.getValue(), saved: t.saved })),
    active: active?.name,
    at: Date.now(),
  });
}

// ------------------------------------------------------------------ files on the student's PC
async function saveTab(t = active, saveAs = false) {
  if (!t) return;
  const text = t.model.getValue();
  const r = await saveToDisk(t.name, text, { handle: t.handle, saveAs, mime: "text/plain", description: LANG.name + " source" });
  if (!r) return;
  if (r.handle) {
    t.handle = r.handle;
    if (r.name !== t.name && !tabs.some((o) => o !== t && o.name === r.name)) renameTab(t, r.name);
    toast(`Saved ${t.name} on this computer.`);
  } else {
    toast(`${t.name} downloaded to your Downloads folder.`);
  }
  t.saved = text;
  renderTabs();
  saveDraft();
}

async function openFiles(list) {
  for (const f of list) {
    if (f.file.size > 5 * 1024 * 1024) { toast(`${f.name} is too large to open (over 5 MB).`, "bad"); continue; }
    const text = await f.file.text();
    addTab(f.name, text, { saved: text, handle: f.handle });
  }
  if (list.length === 1) {
    const other = LANG.id === "lex" ? null : Object.values(LANGS).find((l) => l.id !== LANG.id && list[0].name.toLowerCase().endsWith(l.ext));
    if (other) toast(`Tip: switch the language to ${other.name} to run ${list[0].name}.`);
  }
}

async function openDialog() {
  openFiles(await pickFiles({ accept: LANG.accept, multiple: true }));
}

function renameTab(t, name) {
  const text = t.model.getValue();
  const model = monaco.editor.createModel(text, monacoLanguageFor(name, LANG.id), uriFor(name));
  model.onDidChangeContent(() => { renderTabs(); scheduleDraft(); });
  const old = t.model;
  t.model = model;
  t.name = name;
  if (active === t) editor.setModel(model);
  old.dispose();
  renderTabs();
  scheduleDraft();
}

async function newFile() {
  let base = LANG.id === "java" ? "NewClass" : "file";
  let n = 2, name;
  do { name = LANG.id === "java" && n === 2 ? `${base}${LANG.ext}` : `${base}${n}${LANG.ext}`; n++; } while (tabs.some((t) => t.name === name));
  const chosen = await prompt("New file", name, LANG.id === "java" ? "File name (the class name must match it)" : "File name, e.g. utils.h or data.txt");
  if (!chosen) return;
  if (!/^[\w.\- ]+$/.test(chosen)) { toast("Use only letters, digits, dot, dash and underscore.", "bad"); return; }
  if (tabs.some((t) => t.name === chosen)) { activate_(tabs.find((t) => t.name === chosen)); return; }
  addTab(chosen, LANG.newFile(chosen), { saved: "" });
}

async function renameActive() {
  const name = await prompt("Rename file", active.name, "New file name");
  if (!name || name === active.name) return;
  if (!/^[\w.\- ]+$/.test(name)) { toast("Use only letters, digits, dot, dash and underscore.", "bad"); return; }
  if (tabs.some((t) => t.name === name)) { toast("A file with that name is already open.", "bad"); return; }
  active.handle = null;
  renameTab(active, name);
}

function downloadAll() {
  const zip = makeZip(tabs.map((t) => ({ name: t.name, data: t.model.getValue() })));
  downloadBlob(`${LANG.id}-files.zip`, zip);
  for (const t of tabs) t.saved = t.model.getValue();
  renderTabs();
  saveDraft();
}

// ------------------------------------------------------------------ diagnostics
const DIAG_RE = /^(?<file>[^\s:][^:\n]*?):(?<line>\d+):(?:(?<col>\d+):)?\s*(?<sev>fatal error|error|warning|note):\s*(?<msg>.*)$/;

function showCompileLog(log, ok) {
  const markers = new Map();
  const lines = (log || "").replace(/\s+$/, "").split("\n");
  for (const line of lines) {
    if (!line && !lines.length) continue;
    const m = DIAG_RE.exec(line);
    if (m) {
      const { file, sev, msg } = m.groups;
      const ln = +m.groups.line, col = +(m.groups.col || 1);
      const span = document.createElement("span");
      span.className = "diag " + (sev === "warning" ? "k-warn" : sev === "note" ? "k-info" : "k-err");
      span.textContent = line + "\n";
      span.title = "Click to go to this line";
      span.onclick = () => goTo(file, ln, col);
      con.html(span);
      if (sev !== "note") {
        if (!markers.has(file)) markers.set(file, []);
        markers.get(file).push({
          severity: sev === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: msg, startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col + 1,
        });
      }
    } else {
      con.write(line + "\n", ok ? "info" : "out");
    }
  }
  con.flush();
  for (const t of tabs) {
    const list = (markers.get(t.name) || []).map((mk) => {
      const word = t.model.getWordAtPosition({ lineNumber: mk.startLineNumber, column: mk.startColumn });
      return word ? { ...mk, startColumn: word.startColumn, endColumn: word.endColumn } : { ...mk, endColumn: t.model.getLineMaxColumn(Math.min(mk.startLineNumber, t.model.getLineCount())) };
    });
    monaco.editor.setModelMarkers(t.model, "foct", list);
  }
  return [...markers.values()].flat().filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
}

function clearMarkers() {
  for (const t of tabs) monaco.editor.setModelMarkers(t.model, "foct", []);
}

function goTo(file, line, col = 1) {
  const t = tabs.find((x) => x.name === file || x.name === file.split("/").pop());
  if (!t) return;
  activate_(t);
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: col });
  editor.focus();
}

/** Turn Python tracebacks into clickable links and mark the failing line. */
function linkTraceback() {
  const spans = [...con.pre.querySelectorAll(".k-err")].slice(-20);
  let last = null;
  for (const s of spans) {
    for (const node of [...s.childNodes]) {
      if (node.nodeType !== 3) continue;
      const re = /File "([^"]+)", line (\d+)/g;
      const text = node.textContent;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let i = 0, m;
      while ((m = re.exec(text))) {
        frag.append(text.slice(i, m.index));
        const a = document.createElement("span");
        a.className = "diag";
        a.textContent = m[0];
        const file = m[1].replace(/^\/home\/pyodide\//, ""), line = +m[2];
        if (tabs.some((t) => t.name === file)) {
          a.onclick = () => goTo(file, line);
          last = { file, line };
        }
        frag.append(a);
        i = m.index + m[0].length;
      }
      frag.append(text.slice(i));
      node.replaceWith(frag);
    }
  }
  if (last) {
    const t = tabs.find((x) => x.name === last.file);
    const errLine = con.pre.textContent.trim().split("\n").pop();
    monaco.editor.setModelMarkers(t.model, "foct", [{
      severity: monaco.MarkerSeverity.Error, message: errLine,
      startLineNumber: last.line, startColumn: 1, endLineNumber: last.line, endColumn: t.model.getLineMaxColumn(last.line),
    }]);
  }
}

// ------------------------------------------------------------------ run
function sourceFilesForRun() {
  const all = tabs.map((t) => ({ name: t.name, text: t.model.getValue() }));
  if (LANG.id === "lex") {
    // every open file is part of the program: scanner (.l), grammar (.y), and any .c/.h files
    const isLY = (n) => /\.(l|lex|y|yacc)$/i.test(n);
    const main = all.find((f) => f.name === active.name && isLY(f.name)) || all.find((f) => isLY(f.name));
    if (!main) return { error: "Open or create a .l (lex) or .y (yacc) file to run." };
    return { files: all, main: main.name };
  }
  const isSrc = (n) => LANG.id === "c" ? /\.c$/i.test(n) : LANG.id === "cpp" ? /\.(c|cc|cpp|cxx)$/i.test(n) : LANG.id === "java" ? /\.java$/i.test(n) : /\.py$/i.test(n);
  const hasMain = (f) => LANG.id === "java" ? /\bstatic\s+(final\s+)?void\s+main\s*\(/.test(f.text)
    : LANG.id === "python" ? true : /\bmain\s*\(/.test(f.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
  let main = all.find((f) => f.name === active.name && isSrc(f.name));
  if (!main) main = all.find((f) => isSrc(f.name) && hasMain(f)) || all.find((f) => isSrc(f.name));
  if (!main) return { error: `Open or create a ${LANG.ext} file to run.` };
  // Other source files with their own main() are left out (e.g. a second example).
  const files = all.filter((f) => f === main || !isSrc(f.name) || LANG.id === "python" || !(hasMain(main) && hasMain(f)));
  return { files, main: main.name };
}

async function run() {
  if (running) return;
  const sel = sourceFilesForRun();
  if (sel.error) { toast(sel.error, "bad"); return; }
  running = true;
  setRunning(true);
  clearMarkers();
  if (settings.clearOnRun) con.clear();
  const preset = $("stdinText").value;
  con.system(`▶ ${sel.main}  ·  ${new Date().toLocaleTimeString()}`, "run");
  if (preset && LANG.runner !== "java" && MODE === "batch") con.system("Using the text in the Input tab as keyboard input.");
  else if (preset) con.system("Reading the Input tab first, then from the keyboard.");
  setStatus(LANG.runner === "python" ? "Starting Python…" : "Compiling…");
  const t0 = performance.now();
  let result;
  try {
    result = await runner.run({
      files: sel.files, main: sel.main, settings, console: con, stdinMode: MODE, preset,
      onStatus: setStatus,
      onProgress: engineProgress,
      onCompiled: (c) => {
        if (c.log && c.log.trim()) showCompileLog(c.log, c.ok);
        if (c.ok) con.system(`Compiled in ${(c.ms / 1000).toFixed(1)} s`);
        else con.exit("✖ Compilation failed — fix the errors above (click a message to jump to the line).", false);
      },
    });
  } catch (e) {
    con.exit("✖ " + (e.message || e), false);
    result = { error: true };
  }
  running = false;
  setRunning(false);
  engineReady();
  if (result && result.compiled !== false && !result.error) {
    if (result.stopped) con.exit("■ Stopped.", false);
    else if (result.trap) con.exit("✖ " + result.trap, false);
    else {
      const ok = result.code === 0;
      const secs = ((performance.now() - t0) / 1000).toFixed(2);
      con.exit(ok ? `✔ Finished (exit code 0) in ${secs} s` : `✖ Exited with code ${result.code} after ${secs} s`, ok);
    }
    if (result.note) con.system(result.note);
    if (LANG.id === "python") linkTraceback();
    showFiles(result.files || []);
  }
  setStatus(result?.compiled === false ? "Compilation failed" : "Ready");
}

function stop() {
  if (!running) return;
  runner.stop();
  setStatus("Stopping…");
}

function setRunning(on) {
  $("btnRun").hidden = on;
  $("btnStop").hidden = !on;
  document.body.classList.toggle("is-running", on);
}

function setStatus(text) {
  $("status").textContent = text;
}

// ------------------------------------------------------------------ files panel
function showFiles(files) {
  lastFiles = files;
  const ul = $("fileList");
  ul.textContent = "";
  $("filesBadge").hidden = !files.length;
  $("filesBadge").textContent = files.length;
  if (!files.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No files were created by the last run.";
    ul.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = f.name;
    const sz = document.createElement("span");
    sz.className = "sz";
    sz.textContent = f.data.length < 1024 ? `${f.data.length} B` : `${(f.data.length / 1024).toFixed(1)} KB`;
    const open = document.createElement("button");
    open.className = "btn btn-sm";
    open.textContent = "Open";
    open.title = "Open in the editor";
    open.onclick = () => {
      const text = new TextDecoder().decode(f.data);
      addTab(f.name.split("/").pop(), text, { saved: "" });
    };
    const dl = document.createElement("button");
    dl.className = "btn btn-sm btn-primary";
    dl.textContent = "Download";
    dl.onclick = () => downloadBlob(f.name.split("/").pop(), new Blob([f.data]));
    li.append(nm, sz);
    if (f.data.length < 2 * 1024 * 1024 && !f.data.subarray(0, 4096).includes(0)) li.append(open);
    li.append(dl);
    ul.appendChild(li);
  }
  if (files.length) toast(`${files.length} file${files.length > 1 ? "s" : ""} created — see the Files tab.`);
}

// ------------------------------------------------------------------ engine status
function engineProgress(f) {
  const chip = $("engine");
  chip.className = "chip warn";
  $("engineText").textContent = `Loading ${LANG.runner === "clang" ? "compiler" : LANG.name}… ${Math.round((f || 0) * 100)}%`;
}

function engineReady() {
  $("engine").className = "chip ok";
  $("engineText").textContent = `${runner.engine} ready`;
}

function preload() {
  if (LANG.runner === "java" && !JAVA_FULL && !cap.wasmGC) {
    $("engine").className = "chip bad";
    $("engineText").textContent = "Browser too old for Java";
    con.system("Java needs WebAssembly GC: please use Chrome or Edge 119+, Firefox 120+ or Safari 18.2+.");
    return;
  }
  engineProgress(0);
  runner.load(engineProgress).then(engineReady).catch((e) => {
    $("engine").className = "chip bad";
    $("engineText").textContent = "Failed to load";
    con.exit("✖ " + (e.message || e), false);
  });
}

// ------------------------------------------------------------------ side panel, splitter, settings
function showPane(name) {
  for (const b of document.querySelectorAll(".stab")) b.classList.toggle("active", b.dataset.pane === name);
  for (const p of document.querySelectorAll(".side-body > [data-pane]")) p.hidden = p.dataset.pane !== name;
  $("btnClear").hidden = name !== "output";
}

function initSplitter() {
  const sp = $("splitter"), ide = $("ide"), left = document.querySelector(".editor-pane");
  const vertical = () => matchMedia("(max-width: 860px)").matches;
  const saved = store.get("foct.code.split", null);
  if (saved) left.style.flex = `0 0 ${saved}%`;
  let dragging = false;
  sp.addEventListener("pointerdown", (e) => { dragging = true; sp.classList.add("drag"); sp.setPointerCapture(e.pointerId); });
  sp.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = ide.getBoundingClientRect();
    const pct = vertical() ? ((e.clientY - r.top) / r.height) * 100 : ((e.clientX - r.left) / r.width) * 100;
    const v = Math.min(80, Math.max(20, pct));
    left.style.flex = `0 0 ${v}%`;
    store.set("foct.code.split", Math.round(v));
  });
  sp.addEventListener("pointerup", () => { dragging = false; sp.classList.remove("drag"); });
  sp.addEventListener("keydown", (e) => {
    const cur = parseFloat(left.style.flex.split(" ")[2]) || 58;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") left.style.flex = `0 0 ${Math.max(20, cur - 3)}%`;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") left.style.flex = `0 0 ${Math.min(80, cur + 3)}%`;
  });
}

function applySettings() {
  editor.updateOptions({
    fontSize: settings.fontSize,
    wordWrap: settings.wordWrap ? "on" : "off",
    minimap: { enabled: settings.minimap },
  });
  $("console").style.fontSize = Math.max(12, settings.fontSize - 1.5) + "px";
  store.set(SETTINGS_KEY, settings);
}

async function openSettings() {
  const body = document.createElement("div");
  body.className = "settings-grid";
  const sel = (id, opts, val) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  body.innerHTML = `
    <label for="sFont">Font size</label><input id="sFont" type="number" min="11" max="28" value="${settings.fontSize}">
    <label for="sWrap">Wrap long lines</label><input id="sWrap" type="checkbox" ${settings.wordWrap ? "checked" : ""}>
    <label for="sMini">Show minimap</label><input id="sMini" type="checkbox" ${settings.minimap ? "checked" : ""}>
    <label for="sClear">Clear output on each run</label><input id="sClear" type="checkbox" ${settings.clearOnRun ? "checked" : ""}>
    ${LANG.runner === "clang" ? `
    <label for="sStd">${LANG.id === "cpp" ? "C++" : "C"} standard</label>${LANG.id === "cpp"
      ? sel("sStd", [["c++11", "C++11"], ["c++14", "C++14"], ["c++17", "C++17"], ["c++20", "C++20"], ["c++23", "C++23"]], settings.cppStd)
      : sel("sStd", [["c89", "C89 / ANSI C"], ["c99", "C99"], ["c11", "C11"], ["c17", "C17"], ["c23", "C23"]], settings.cStd)}
    <label for="sOpt">Optimisation</label>${sel("sOpt", [["-O0", "-O0 (none)"], ["-O1", "-O1 (default)"], ["-O2", "-O2 (fast)"]], settings.opt)}
    <label for="sWarn">Show warnings (-Wall)</label><input id="sWarn" type="checkbox" ${settings.warnings ? "checked" : ""}>` : ""}`;
  const ok = await modal({ title: "Settings", body, actions: [{ label: "Cancel", value: false }, { label: "Save", value: true, primary: true }] });
  if (!ok) return;
  settings.fontSize = Math.min(28, Math.max(11, +body.querySelector("#sFont").value || 15));
  settings.wordWrap = body.querySelector("#sWrap").checked;
  settings.minimap = body.querySelector("#sMini").checked;
  settings.clearOnRun = body.querySelector("#sClear").checked;
  if (LANG.runner === "clang") {
    if (LANG.id === "cpp") settings.cppStd = body.querySelector("#sStd").value; else settings.cStd = body.querySelector("#sStd").value;
    settings.opt = body.querySelector("#sOpt").value;
    settings.warnings = body.querySelector("#sWarn").checked;
  }
  applySettings();
  toast("Settings saved.");
}

function showHelp() {
  modal({
    title: `${LANG.title} — quick help`,
    html: `<ul style="padding-left:18px;margin:0;line-height:1.8">
      <li><kbd>Ctrl</kbd>+<kbd>Enter</kbd> or <kbd>F5</kbd> &mdash; run &nbsp;&middot;&nbsp; <kbd>Ctrl</kbd>+<kbd>.</kbd> &mdash; stop</li>
      <li><kbd>Ctrl</kbd>+<kbd>S</kbd> save &middot; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> save as &middot; <kbd>Ctrl</kbd>+<kbd>O</kbd> open &middot; <kbd>Alt</kbd>+<kbd>N</kbd> new file</li>
      <li>When the program waits for input, type in the <b>Output</b> panel and press <kbd>Enter</kbd>. <kbd>Ctrl</kbd>+<kbd>D</kbd> ends the input.</li>
      <li>The <b>Input</b> tab lets you prepare input in advance (handy for long test data).</li>
      <li>All open tabs are files your program can read (for example <code>data.txt</code>). Files it writes appear in the <b>Files</b> tab.</li>
      <li>${canPickFiles ? "Save writes straight to the file on your computer." : "Save downloads the file to your Downloads folder (in secure mode it can write back to the same file)."}</li>
      <li>Type <code>${LANG.id === "java" ? "sout" : LANG.id === "python" ? "for" : "printf"}</code> and press <kbd>Tab</kbd> for code snippets. <kbd>F1</kbd> opens all editor commands.</li>
      ${LANG.id === "lex" ? `<li>Put the scanner in a <code>.l</code> file and the grammar in a <code>.y</code> file (open both as tabs). <b>Run</b> does what you would type on Linux:
        <code>yacc -d -v file.y</code>, <code>lex file.l</code>, <code>cc lex.yy.c y.tab.c -ll -ly</code>, then runs the program.</li>
        <li>The generated <code>lex.yy.c</code>, <code>y.tab.c</code>, <code>y.tab.h</code> and <code>y.output</code> (yacc's LR states and any conflicts) appear in the <b>Files</b> tab.</li>
        <li>Type input and press <kbd>Enter</kbd>; <kbd>Ctrl</kbd>+<kbd>D</kbd> ends the input (then <code>yywrap()</code> is called). If you leave out <code>main</code>, <code>yywrap</code> or <code>yyerror</code>, the usual <code>-ll</code>/<code>-ly</code> versions are used.</li>
        <li>lex here is flex 2.5.4 and yacc is Berkeley yacc. The first Run on a computer prepares them (about 20 seconds).</li>` : ""}
      ${LANG.id === "cpp" ? "<li>Exceptions (<code>try</code>/<code>catch</code>/<code>throw</code>) work; threads (<code>std::thread</code>) are not available.</li>" : ""}
      ${LANG.id === "java" ? (JAVA_FULL
        ? "<li>Full Java 21 (OpenJDK) runs in this browser. Console programs only: Swing/AWT windows, JDBC and networking are not available. Stop restarts the Java runtime (a few seconds).</li>"
        : "<li><b>Basic Java mode</b> (plain HTTP): most console programs work, but errors such as division by zero or a bad array index stop the program instead of being caught by <code>try/catch</code>, and some library classes are missing. Open the lab in secure mode (HTTPS) for full Java 21.</li>") : ""}
      ${LANG.id === "python" ? "<li>Plots from Matplotlib appear in the Output panel. GUI libraries such as tkinter and turtle are not available.</li>" : ""}
    </ul>`,
  });
}

function welcome() {
  const w = document.createElement("div");
  w.className = "welcome";
  w.innerHTML = `<p><b>${escapeHtml(LANG.title)}</b> runs entirely inside this browser.</p>
    ${LANG.id === "lex" ? `<p>Write a scanner (<code>.l</code>) and, for a parser, a grammar (<code>.y</code>). <b>Run</b> runs <code>yacc</code> and <code>lex</code>, compiles the C they generate and starts the program.
    Lex programs read until the end of the input: press <kbd>Ctrl</kbd>+<kbd>D</kbd> when you have finished typing. Try the examples in the <b>&middot;&middot;&middot;</b> menu.</p>` : ""}
    <p>Press <b>Run</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) to ${LANG.runner === "python" ? "run" : "compile and run"} your program.
    When it asks for input, type here and press <kbd>Enter</kbd>.</p>
    <p>Use <b>Save</b> (<kbd>Ctrl</kbd>+<kbd>S</kbd>) to keep your work on this computer or a pen drive &mdash; nothing is stored on the lab server.
    Examples are in the <b>&middot;&middot;&middot;</b> menu.</p>`;
  con.html(w);
}

// ------------------------------------------------------------------ menu & shortcuts
function initMenu() {
  const menu = $("menu"), btn = $("btnMenu");
  const ex = $("examples");
  for (const [title, code] of Object.entries(LANG.examples)) {
    const b = document.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = title;
    b.onclick = () => { closeMenu(); loadExample(title, code); };
    ex.appendChild(b);
  }
  const closeMenu = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
  };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  menu.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (!cmd) return;
    closeMenu();
    ({ saveAs: () => saveTab(active, true), saveAll: downloadAll, rename: renameActive, settings: openSettings, theme: toggleTheme, help: showHelp })[cmd]?.();
  });
}

async function loadExample(title, code) {
  if (code && typeof code === "object") return loadProjectExample(title, code);
  let target = active;
  if (LANG.id === "java" && target.name !== "Main.java") target = tabs.find((t) => t.name === "Main.java") || addTab("Main.java", "", { saved: "", activate: false });
  if (!LANG.examples || !target) return;
  activate_(target);
  const model = target.model;
  editor.pushUndoStop();
  editor.executeEdits("example", [{ range: model.getFullModelRange(), text: code }]);
  editor.pushUndoStop();
  editor.setPosition({ lineNumber: 1, column: 1 });
  toast(`Loaded example “${title}” (Ctrl+Z to undo).`);
}

// An example made of several files (Lex & Yacc): it replaces the open program files.
async function loadProjectExample(title, files) {
  const names = Object.keys(files);
  const isProg = (n) => /\.(l|lex|y|yacc|c|h)$/i.test(n);
  const leaving = tabs.filter((t) => isProg(t.name) && !names.includes(t.name));
  const losing = tabs.filter((t) => isProg(t.name) && isDirty(t) && files[t.name] !== t.model.getValue());
  if (losing.length) {
    const ok = await modal({
      title: `Load the example “${title}”?`,
      html: `<p>It replaces ${losing.map((t) => `<code>${escapeHtml(t.name)}</code>`).join(", ")}, which ${losing.length > 1 ? "have" : "has"} changes that are not saved to your computer.</p>`,
      actions: [{ label: "Cancel", value: false }, { label: "Load the example", value: true, primary: true }],
    });
    if (!ok) return;
  }
  for (const [name, text] of Object.entries(files)) addTab(name, text, { saved: text, activate: false });
  for (const t of leaving) {
    tabs.splice(tabs.indexOf(t), 1);
    if (active === t) active = null;
    t.model.dispose();
  }
  activate_(tabs.find((t) => t.name === names[0]));
  editor.setPosition({ lineNumber: 1, column: 1 });
  toast(`Loaded example “${title}”${names.length > 1 ? ` (${names.join(" + ")})` : ""}.`);
}

function initShortcuts() {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
  editor.addCommand(monaco.KeyCode.F5, run);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveTab());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => saveTab(active, true));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, openDialog);
  editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyN, newFile);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, stop);
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "enter") { e.preventDefault(); run(); }
    else if (e.key === "F5") { e.preventDefault(); run(); }
    else if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); saveTab(active, e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && k === "o") { e.preventDefault(); openDialog(); }
    else if ((e.ctrlKey || e.metaKey) && k === ".") { e.preventDefault(); stop(); }
    else if (e.altKey && k === "n") { e.preventDefault(); newFile(); }
  });
}

function initDragDrop() {
  const area = document.querySelector(".editor-pane");
  area.addEventListener("dragover", (e) => { e.preventDefault(); area.style.outline = "2px dashed var(--gold)"; });
  area.addEventListener("dragleave", () => { area.style.outline = ""; });
  area.addEventListener("drop", (e) => {
    e.preventDefault();
    area.style.outline = "";
    openFiles([...e.dataTransfer.files].map((f) => ({ name: f.name, file: f, handle: null })));
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  monaco = await loadMonaco();
  registerLexYacc(monaco);
  registerSnippets();
  editor = monaco.editor.create($("editor"), {
    theme: monacoTheme(),
    automaticLayout: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", monospace',
    fontSize: settings.fontSize,
    tabSize: 4,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    minimap: { enabled: settings.minimap },
    renderWhitespace: "selection",
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    fixedOverflowWidgets: true,
    smoothScrolling: true,
    mouseWheelZoom: true,
    padding: { top: 8 },
    tabCompletion: "on",
  });
  window.addEventListener("foct-theme", () => monaco.editor.setTheme(monacoTheme()));
  editor.onDidChangeCursorPosition((e) => { $("cursor").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });

  const draft = store.get(KEY, null);
  if (draft && draft.tabs?.length) {
    for (const t of draft.tabs) addTab(t.name, t.text, { saved: t.saved ?? t.text, activate: false });
    activate_(tabs.find((t) => t.name === draft.active) || tabs[0]);
  } else {
    addTab(LANG.main, LANG.template, { saved: LANG.template });
  }

  $("stdinText").value = store.get(`${KEY}.stdin`, "");
  const syncBadge = () => { $("inputBadge").hidden = !$("stdinText").value.trim(); };
  syncBadge();
  $("stdinText").addEventListener("input", () => { store.set(`${KEY}.stdin`, $("stdinText").value); syncBadge(); });

  $("btnRun").onclick = run;
  $("btnStop").onclick = stop;
  $("btnSave").onclick = () => saveTab();
  $("btnOpen").onclick = openDialog;
  $("btnNew").onclick = newFile;
  $("btnClear").onclick = () => con.clear();
  $("lang").onchange = (e) => { saveDraft(); leaving = true; location.search = "?lang=" + e.target.value; };
  for (const b of document.querySelectorAll(".stab")) b.onclick = () => showPane(b.dataset.pane);
  $("console").addEventListener("click", () => con.focusInput());

  initMenu();
  initShortcuts();
  initSplitter();
  initDragDrop();
  applySettings();
  showFiles([]);
  $("filesBadge").hidden = true;
  welcome();
  preload();
  editor.focus();
}

let leaving = false;
window.addEventListener("beforeunload", (e) => {
  saveDraft();
  if (!leaving && tabs.some(isDirty)) { e.preventDefault(); e.returnValue = ""; }
});

boot().catch((e) => {
  console.error(e);
  con.exit("The editor could not start: " + (e.message || e), false);
});
