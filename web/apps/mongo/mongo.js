// FoCT Virtual Labs - MongoDB Lab (page). The database and the shell run in engine.js (a Web Worker).
import { toast, modal, saveToDisk, pickFiles, toggleTheme, currentTheme, escapeHtml } from "/assets/js/foct.js";

const { DATASETS, EXAMPLES } = self.FOCT_MONGO;
const $ = (id) => document.getElementById(id);
const DRAFT = "foct.mongo.draft", HISTORY = "foct.mongo.history";

let monaco, editor;
let worker = null, ready = null, seq = 0, busy = false, pendingRun = null;
const replies = new Map();
let schema = { current: "test", dbs: [] };
let fileName = "script.js", fileHandle = null;
let lineOffset = 0, runFromEditor = true;
let history = [];
let histPos = -1;

// ------------------------------------------------------------------ engine
function startWorker() {
  worker = new Worker("engine.js");
  ready = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      switch (m.type) {
        case "ready": resolve(m); break;
        case "schema": schema = m; renderSchema(); break;
        case "out": addItems(m.items); break;
        case "done":
          if (pendingRun && m.id === pendingRun.id) { const p = pendingRun; pendingRun = null; p.resolve(m); }
          break;
        case "reply": {
          const r = replies.get(m.id);
          if (r) { replies.delete(m.id); if (m.error) r.reject(new Error(m.error)); else r.resolve(m.data); }
          break;
        }
        case "note": toast(m.text, "", 7000); break;
      }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      reject(new Error(e.message || "The MongoDB engine could not start"));
      if (pendingRun) { const p = pendingRun; pendingRun = null; p.resolve({ crashed: true, error: e.message }); }
    };
  });
  ready.catch(() => {});
  const chip = $("engineChip");
  chip.className = "chip warn";
  $("engineText").textContent = "Starting\u2026";
  ready.then(() => { chip.className = "chip ok"; $("engineText").textContent = "MongoDB shell ready"; chip.title = "A MongoDB-compatible database running in this browser (mingo)"; })
    .catch((err) => { chip.className = "chip bad"; $("engineText").textContent = "Engine failed"; toast(err.message, "bad"); });
}
async function call(type, data = {}) {
  await ready;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    replies.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...data });
  });
}

// ------------------------------------------------------------------ running scripts
async function run(code, { repl = false } = {}) {
  if (busy) return;
  if (code === undefined) {
    const sel = editor.getSelection();
    const selected = sel && !sel.isEmpty() ? editor.getModel().getValueInRange(sel) : "";
    code = selected || editor.getValue();
    lineOffset = selected ? sel.startLineNumber - 1 : 0;
    runFromEditor = true;
  } else {
    lineOffset = 0;
    runFromEditor = !repl;
  }
  if (!code.trim()) return;
  busy = true;
  setRunning(true);
  monaco.editor.setModelMarkers(editor.getModel(), "mongo", []);
  $("status").textContent = "Running\u2026";
  try { await ready; } catch { busy = false; setRunning(false); return; }
  const id = ++seq;
  const done = new Promise((resolve) => { pendingRun = { id, resolve }; });
  worker.postMessage({ type: "run", id, code });
  const r = await done;
  busy = false;
  setRunning(false);
  if (r.stopped) return;
  if (r.crashed) { addItems([{ kind: "err", text: "The engine stopped unexpectedly: " + (r.error || "unknown error") }]); startWorker(); return; }
  $("status").textContent = `${r.statements} command${r.statements === 1 ? "" : "s"} in ${r.ms} ms` + (r.errors ? ` \u00b7 ${r.errors} error${r.errors > 1 ? "s" : ""}` : "");
}
function setRunning(on) {
  $("btnRun").hidden = on;
  $("btnStop").hidden = !on;
  $("replInput").disabled = on;
}
function stop() {
  if (!pendingRun) return;
  const p = pendingRun;
  pendingRun = null;
  worker.terminate();
  for (const r of replies.values()) r.reject(new Error("stopped"));
  replies.clear();
  addItems([{ kind: "warn", text: "Stopped. The data is back to how it was before this run (changes made by the stopped run are discarded)." }]);
  startWorker();
  p.resolve({ stopped: true });
  $("status").textContent = "Stopped";
}

// ------------------------------------------------------------------ output
const out = () => $("out");
function addItems(items) {
  const box = out();
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const markers = [];
  for (const it of items) {
    let el;
    switch (it.kind) {
      case "cls": box.textContent = ""; continue;
      case "cmd": {
        el = document.createElement("div");
        el.className = "cmd";
        const lines = it.text.split("\n");
        const shown = lines.length > 8 ? lines.slice(0, 7).join("\n") + `\n\u2026 (${lines.length - 7} more lines)` : it.text;
        el.innerHTML = `<span class="prompt">${escapeHtml(it.db)}&gt;</span><pre></pre>` +
          (runFromEditor && it.line ? `<span class="ln" title="Show in the editor">line ${it.line + lineOffset}</span>` : "");
        el.querySelector("pre").textContent = shown;
        const ln = el.querySelector(".ln");
        if (ln) { const line = it.line + lineOffset; ln.onclick = () => { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus(); }; }
        break;
      }
      case "val": el = document.createElement("pre"); el.className = "val"; el.innerHTML = it.h; break;
      case "text": el = document.createElement("pre"); el.className = "text"; el.textContent = it.text; break;
      case "print": el = document.createElement("pre"); el.className = "print"; el.textContent = it.text; break;
      case "err": {
        el = document.createElement("div");
        const pre = document.createElement("pre");
        pre.className = "err";
        pre.textContent = it.text;
        el.appendChild(pre);
        if (it.hint) { const h = document.createElement("div"); h.className = "hint"; h.textContent = it.hint; el.appendChild(h); }
        if (runFromEditor && it.line) {
          const line = it.line + lineOffset;
          const lineText = editor.getModel().getLineContent(Math.min(line, editor.getModel().getLineCount()));
          markers.push({ severity: monaco.MarkerSeverity.Error, message: it.text.split("\n")[0], startLineNumber: line, endLineNumber: line,
            startColumn: it.col || 1, endColumn: it.col ? it.col + 1 : lineText.length + 1 });
        }
        break;
      }
      case "info": el = document.createElement("div"); el.className = "note"; el.textContent = it.text; break;
      case "warn": el = document.createElement("div"); el.className = "warn"; el.textContent = it.text; break;
      case "dim": el = document.createElement("pre"); el.className = "dim"; el.textContent = it.text; break;
      default: continue;
    }
    box.appendChild(el);
  }
  while (box.childElementCount > 3000) box.firstElementChild.remove();
  if (markers.length) monaco.editor.setModelMarkers(editor.getModel(), "mongo", markers);
  if (atEnd) box.scrollTop = box.scrollHeight;
}
function banner() {
  out().innerHTML = `<div class="banner"><b>MongoDB Lab</b>: a MongoDB-compatible shell and database running inside this browser.
    Write commands above and press <b>Run</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs the selected lines, or everything), or type one command in the box below.
    Start with <b>Samples &amp; examples</b>. Your databases stay on this computer.</div>`;
}

// ------------------------------------------------------------------ sidebar
const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s);
const collExpr = (name) => (isIdent(name) && !["help", "stats", "version"].includes(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`);
function renderSchema() {
  $("prompt").textContent = `${schema.current}>`;
  $("dbStatus").textContent = `db: ${schema.current}`;
  const dbs = schema.dbs.slice();
  if (!dbs.some((d) => d.name === schema.current)) dbs.push({ name: schema.current, colls: [] });
  const box = $("dbList");
  const open = new Set([...box.querySelectorAll("details[open]")].map((d) => d.dataset.db));
  box.innerHTML = dbs.map((d) => `<details data-db="${escapeHtml(d.name)}" ${d.name === schema.current || open.has(d.name) ? "open" : ""}>
    <summary title="Double-click to switch to this database"><span class="nm">${escapeHtml(d.name)}</span>${d.name === schema.current ? '<span class="cur">current</span>' : ""}<span class="cnt">${d.colls.length}</span></summary>
    <ul>${d.colls.map((c) => `<li data-coll="${escapeHtml(c.name)}" title="Show the documents of ${escapeHtml(d.name)}.${escapeHtml(c.name)}"><span class="cn">${escapeHtml(c.name)}</span>${c.validator ? '<span class="val" title="Has a validator">valid</span>' : ""}${c.indexes.length > 1 ? `<span class="ix" title="Indexes: ${escapeHtml(c.indexes.join(", "))}">${c.indexes.length} idx</span>` : ""}<span class="cnt">${c.count}</span></li>`).join("") || '<li class="muted">no collections yet</li>'}</ul>
  </details>`).join("");
}
function initSidebar() {
  $("dbList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-coll]");
    if (!li || busy) return;
    const dbName = li.closest("details").dataset.db;
    const code = (dbName !== schema.current ? `use ${dbName}\n` : "") + `${collExpr(li.dataset.coll)}.find()`;
    run(code, { repl: true });
  });
  $("dbList").addEventListener("dblclick", (e) => {
    const sum = e.target.closest("summary");
    if (!sum || busy) return;
    e.preventDefault();
    run(`use ${sum.parentElement.dataset.db}`, { repl: true });
  });
}

// ------------------------------------------------------------------ REPL box
function initRepl() {
  const ta = $("replInput");
  try { history = JSON.parse(localStorage.getItem(HISTORY) || "[]"); } catch { history = []; }
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; };
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault();
      const code = ta.value;
      if (!code.trim()) return;
      if (history.at(-1) !== code) history.push(code);
      history = history.slice(-100);
      try { localStorage.setItem(HISTORY, JSON.stringify(history)); } catch {}
      histPos = -1;
      ta.value = "";
      fit();
      run(code, { repl: true }).then(() => ta.focus());
    } else if (e.key === "ArrowUp" && !ta.value.slice(0, ta.selectionStart).includes("\n") && history.length) {
      e.preventDefault();
      histPos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      ta.value = history[histPos];
      fit();
    } else if (e.key === "ArrowDown" && !ta.value.slice(ta.selectionEnd).includes("\n") && histPos >= 0) {
      e.preventDefault();
      histPos = histPos + 1 >= history.length ? -1 : histPos + 1;
      ta.value = histPos < 0 ? "" : history[histPos];
      fit();
    }
  });
}

// ------------------------------------------------------------------ samples, examples, files
const dbHasData = (name) => schema.dbs.some((d) => d.name === name && d.colls.length);
async function loadDataset(name, ask = true) {
  if (ask && dbHasData(name)) {
    const yes = await modal({
      title: `Replace the ${name} database?`,
      html: `<p>A database called <code>${escapeHtml(name)}</code> already exists in this browser. Loading the sample replaces it with fresh sample data.</p>`,
      actions: [{ label: "Cancel", value: false }, { label: "Replace it", value: true, primary: true }],
    });
    if (!yes) return false;
  }
  try {
    const msg = await call("sample", { name });
    toast(msg + ".");
    addItems([{ kind: "info", text: msg + `. Try: use ${name}  then  show collections` }]);
    return true;
  } catch (e) { toast(e.message, "bad"); return false; }
}
async function loadExample(ex) {
  setScript(ex.code, ex.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".js");
  if (ex.needs && !dbHasData(ex.needs)) { if (!(await loadDataset(ex.needs, false))) return; }
  run();
}
function setScript(text, name, handle = null) {
  editor.pushUndoStop();
  editor.executeEdits("load", [{ range: editor.getModel().getFullModelRange(), text }]);
  editor.pushUndoStop();
  editor.setPosition({ lineNumber: 1, column: 1 });
  fileName = name;
  fileHandle = handle;
}
async function saveScript(saveAs = false) {
  const r = await saveToDisk(fileName, editor.getValue(), { handle: fileHandle, saveAs, mime: "text/javascript", description: "MongoDB shell script" });
  if (!r) return;
  fileHandle = r.handle;
  if (r.name) fileName = r.name;
  toast(r.method === "file" ? `Saved ${fileName}.` : `${fileName} downloaded to your Downloads folder.`);
}
async function openScript() {
  const [f] = await pickFiles({ accept: ".js,.mongodb,.txt,.json,.csv", multiple: false });
  if (!f) return;
  if (/\.(json|csv)$/i.test(f.name)) return importFiles([f]);
  setScript(await f.file.text(), f.name, f.handle);
  toast(`Opened ${f.name}. Press Run.`);
}

const formField = (label, input) => `<label for="${input.match(/id="([^"]+)"/)[1]}">${label}</label>${input}`;
async function importFiles(files) {
  if (!files) files = await pickFiles({ accept: ".json,.csv,.jsonl,.ndjson,.txt", multiple: true });
  for (const f of files || []) {
    const text = await f.file.text();
    try {
      const j = JSON.parse(text);
      if (j && j.format === "foct-mongo-lab") { await restoreText(text, f.name); continue; }
    } catch {}
    const base = f.name.replace(/\.(json|csv|jsonl|ndjson|txt)$/i, "");
    const guess = base.includes(".") ? base.split(".").pop() : base;
    const body = document.createElement("div");
    body.innerHTML = `<p>Import <b>${escapeHtml(f.name)}</b> (${(f.file.size / 1024).toFixed(1)} KB) into a collection.</p>
      <div class="form-grid">
        ${formField("Database", `<input type="text" id="impDb" value="${escapeHtml(schema.current)}">`)}
        ${formField("Collection", `<input type="text" id="impColl" value="${escapeHtml(guess.replace(/[^\w.-]/g, "_"))}">`)}
        ${formField("Format", `<select id="impFmt"><option value="json">JSON (array, or one document per line)</option><option value="csv">CSV with a header row</option></select>`)}
        <label class="chk"><input type="checkbox" id="impReplace"> Delete the collection's existing documents first</label>
      </div>`;
    body.querySelector("#impFmt").value = /\.csv$/i.test(f.name) ? "csv" : "json";
    const go = await modal({ title: "Import documents", body, actions: [{ label: "Cancel", value: false }, { label: "Import", value: true, primary: true }] });
    if (!go) continue;
    const db = body.querySelector("#impDb").value.trim(), coll = body.querySelector("#impColl").value.trim();
    try {
      const r = await call("import", { db, coll, text, format: body.querySelector("#impFmt").value, replace: body.querySelector("#impReplace").checked });
      const msg = `Imported ${r.inserted} document${r.inserted === 1 ? "" : "s"} into ${db}.${coll}` + (r.failed ? ` (${r.failed} skipped: ${r.errors[0]})` : "");
      toast(msg + ".", r.failed ? "warn" : "", 6000);
      addItems([{ kind: r.failed ? "warn" : "info", text: msg }]);
    } catch (e) { toast("Import failed: " + e.message, "bad", 7000); }
  }
}
async function exportColl() {
  const all = schema.dbs.flatMap((d) => d.colls.map((c) => `${d.name}.${c.name}`));
  if (!all.length) { toast("There is nothing to export yet."); return; }
  const body = document.createElement("div");
  const cur = all.find((x) => x.startsWith(schema.current + ".")) || all[0];
  body.innerHTML = `<div class="form-grid">
      ${formField("Collection", `<select id="expColl">${all.map((x) => `<option ${x === cur ? "selected" : ""}>${escapeHtml(x)}</option>`).join("")}</select>`)}
      ${formField("Format", `<select id="expFmt"><option value="json">JSON array (Extended JSON)</option><option value="ndjson">One document per line (mongoexport style)</option><option value="csv">CSV (spreadsheet)</option></select>`)}
    </div>`;
  const go = await modal({ title: "Export a collection", body, actions: [{ label: "Cancel", value: false }, { label: "Export", value: true, primary: true }] });
  if (!go) return;
  const full = body.querySelector("#expColl").value, format = body.querySelector("#expFmt").value;
  const dot = full.indexOf(".");
  const db = full.slice(0, dot), coll = full.slice(dot + 1);
  try {
    const text = await call("export", { db, coll, format });
    const ext = format === "csv" ? "csv" : "json";
    const r = await saveToDisk(`${db}.${coll}.${ext}`, text, { mime: format === "csv" ? "text/csv" : "application/json", description: format === "csv" ? "CSV file" : "JSON file" });
    if (r) toast(r.method === "file" ? `Saved ${r.name}.` : `${r.name} downloaded to your Downloads folder.`);
  } catch (e) { toast(e.message, "bad"); }
}
async function dumpAll() {
  try {
    const text = await call("dump");
    const r = await saveToDisk("mongodb-lab-databases.json", text, { mime: "application/json", description: "MongoDB Lab databases" });
    if (r) toast(r.method === "file" ? `Saved ${r.name}.` : `${r.name} downloaded to your Downloads folder.`);
  } catch (e) { toast(e.message, "bad"); }
}
async function restoreText(text, name) {
  const yes = await modal({
    title: "Open saved databases?",
    html: `<p>Opening <b>${escapeHtml(name)}</b> replaces <b>all</b> the databases in this browser with the ones in the file.</p>`,
    actions: [{ label: "Cancel", value: false }, { label: "Open", value: true, primary: true }],
  });
  if (!yes) return;
  try { await call("restore", { text }); toast(`Opened ${name}.`); addItems([{ kind: "info", text: `Opened the databases saved in ${name}.` }]); }
  catch (e) { toast(e.message, "bad", 7000); }
}
async function restoreAll() {
  const [f] = await pickFiles({ accept: ".json", multiple: false });
  if (!f) return;
  const text = await f.file.text();
  let j = null;
  try { j = JSON.parse(text); } catch { toast("That file is not valid JSON.", "bad"); return; }
  if (!j || j.format !== "foct-mongo-lab") return importFiles([f]);
  restoreText(text, f.name);
}
async function resetAll() {
  const yes = await modal({
    title: "Delete all databases?",
    html: "<p>This deletes every database and collection of the MongoDB Lab in <b>this browser</b>. Files you saved on your computer are not affected.</p>",
    actions: [{ label: "Cancel", value: false }, { label: "Delete everything", value: true, danger: true }],
  });
  if (!yes) return;
  await call("reset");
  banner();
  toast("All MongoDB Lab data was deleted from this browser.");
}

function help() {
  modal({
    title: "MongoDB Lab help",
    html: `<ul style="padding-left:18px;line-height:1.7;margin:0">
      <li>Write shell commands in the editor, one per line, and press <b>Run</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>). With lines selected, only those run. Each command's result appears in the output, like <code>mongosh</code>.</li>
      <li>Or type a single command in the box under the output and press <kbd>Enter</kbd>; <kbd>&uarr;</kbd> brings back earlier commands.</li>
      <li>Shell commands: <code>use college</code>, <code>show dbs</code>, <code>show collections</code>, <code>it</code> (next 20 documents), <code>cls</code>, <code>db.help()</code>.</li>
      <li>CRUD: <code>insertOne</code>, <code>insertMany</code>, <code>find</code>, <code>findOne</code>, <code>updateOne</code>, <code>updateMany</code>, <code>replaceOne</code>, <code>deleteOne</code>, <code>deleteMany</code>, <code>countDocuments</code>, <code>distinct</code>. Also <code>aggregate</code>, <code>mapReduce</code>, <code>bulkWrite</code>, <code>createIndex</code> (with <code>unique</code>), <code>explain()</code>, <code>$text</code> search and <code>$jsonSchema</code> validation.</li>
      <li>The shell is JavaScript: variables, loops and functions work, and variables are remembered between runs.</li>
      <li>Click a collection on the left to see its documents. <b>Import</b> and <b>Export</b> read and write JSON (as <code>mongoimport</code>/<code>mongoexport</code> do) and CSV.</li>
      <li>Your databases are kept in this browser on this computer. Use <b>Save databases</b> to take them with you, and <b>Open databases</b> to continue on another PC. On a shared PC, use <i>Clear my lab data</i> on the home page before you leave.</li>
      <li>This is a MongoDB-compatible engine for learning, not a real MongoDB server: users and roles, replica sets, sharding and change streams are not available, and very large datasets are slow.</li>
    </ul>`,
  });
}

// ------------------------------------------------------------------ editor language and completion
const COLL_METHODS = [
  ["find", "find(${1:{}})", "find(filter, projection): matching documents"],
  ["findOne", "findOne(${1:{}})", "findOne(filter, projection): the first match or null"],
  ["insertOne", "insertOne({ ${1} })", "insertOne(document)"],
  ["insertMany", "insertMany([\n\t{ ${1} }\n])", "insertMany([documents])"],
  ["updateOne", "updateOne({ ${1} }, { \\$set: { ${2} } })", "updateOne(filter, update, { upsert })"],
  ["updateMany", "updateMany({ ${1} }, { \\$set: { ${2} } })", "updateMany(filter, update)"],
  ["replaceOne", "replaceOne({ ${1} }, { ${2} })", "replaceOne(filter, newDocument)"],
  ["deleteOne", "deleteOne({ ${1} })", "deleteOne(filter)"],
  ["deleteMany", "deleteMany({ ${1} })", "deleteMany(filter); deleteMany({}) deletes all"],
  ["countDocuments", "countDocuments(${1:{}})", "countDocuments(filter)"],
  ["estimatedDocumentCount", "estimatedDocumentCount()", "number of documents"],
  ["distinct", "distinct(\"${1:field}\")", "distinct(field, filter): the different values"],
  ["aggregate", "aggregate([\n\t{ \\$match: { ${1} } },\n\t{ \\$group: { _id: \"\\$${2:field}\", count: { \\$sum: 1 } } }\n])", "aggregate([stages])"],
  ["createIndex", "createIndex({ ${1:field}: 1 })", "createIndex(keys, { unique: true })"],
  ["getIndexes", "getIndexes()", "list the indexes"],
  ["dropIndex", "dropIndex(\"${1:name}\")", "dropIndex(name)"],
  ["drop", "drop()", "delete the collection"],
  ["findOneAndUpdate", "findOneAndUpdate({ ${1} }, { \\$set: { ${2} } }, { returnDocument: \"after\" })", "update and return the document"],
  ["findOneAndDelete", "findOneAndDelete({ ${1} })", "delete and return the document"],
  ["findOneAndReplace", "findOneAndReplace({ ${1} }, { ${2} })", "replace and return the document"],
  ["bulkWrite", "bulkWrite([\n\t{ insertOne: { document: { ${1} } } }\n])", "several writes at once"],
  ["mapReduce", "mapReduce(\n\tfunction () { emit(this.${1:key}, ${2:1}); },\n\tfunction (key, values) { return Array.sum(values); },\n\t{ out: \"${3:result}\" }\n)", "map-reduce"],
  ["renameCollection", "renameCollection(\"${1:newName}\")", "rename the collection"],
  ["stats", "stats()", "size and counts"],
  ["count", "count(${1:{}})", "deprecated: use countDocuments"],
];
const CURSOR_METHODS = ["sort({ ${1:field}: 1 })", "limit(${1:10})", "skip(${1:10})", "count()", "toArray()", "forEach(${1:printjson})", "map(${1:d => d})",
  "pretty()", "explain(\"executionStats\")", "hasNext()", "next()", "size()", "itcount()", "project({ ${1} })"];
const DB_METHODS = [["getCollectionNames()", "list collections"], ["createCollection(\"${1:name}\")", "create a collection (optionally with a validator)"],
  ["dropDatabase()", "delete this database"], ["getName()", "the current database"], ["getCollection(\"${1:name}\")", "a collection by name"],
  ["getSiblingDB(\"${1:name}\")", "another database"], ["stats()", "sizes and counts"], ["help()", "database methods"]];
const OPERATORS = {
  query: "eq ne gt gte lt lte in nin and or not nor exists type regex options all elemMatch size mod expr text search where jsonSchema",
  update: "set unset inc mul rename min max currentDate setOnInsert push each slice sort position addToSet pop pull pullAll",
  stage: "match group project sort limit skip unwind lookup addFields set unset count facet bucket bucketAuto sortByCount replaceRoot replaceWith sample out merge unionWith graphLookup",
  expr: "sum avg min max first last push addToSet add subtract multiply divide mod round concat toUpper toLower substr split size filter map reduce cond ifNull switch dateToString year month dayOfMonth toString toInt arrayElemAt literal meta",
};
function registerLanguage() {
  monaco.languages.register({ id: "mongosh", extensions: [".js", ".mongodb"] });
  monaco.languages.setMonarchTokensProvider("mongosh", {
    keywords: ["var", "let", "const", "function", "return", "if", "else", "for", "while", "do", "break", "continue", "new", "delete", "typeof", "instanceof", "in", "of", "true", "false", "null", "undefined", "this", "try", "catch", "finally", "throw", "switch", "case", "default", "class", "async", "await"],
    shell: ["use", "show", "it", "db", "print", "printjson", "ObjectId", "ISODate", "Date", "NumberInt", "NumberLong", "NumberDecimal", "emit", "Math", "JSON", "Array", "tojson"],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"/, "string", "@dq"], [/'/, "string", "@sq"], [/`/, "string", "@bq"],
        [/\$[A-Za-z_]\w*/, "operator.mongo"],
        [/[A-Za-z_]\w*/, { cases: { "@keywords": "keyword", "@shell": "shell", "@default": "identifier" } }],
        [/\/(?![\/*])(?:[^\\\/\n]|\\.)+\/[gimsuy]*(?=\s*[,)\]};]|\s*$)/, "regexp"],
        [/\d+(\.\d+)?([eE][-+]?\d+)?/, "number"],
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
      ],
      comment: [[/[^/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[/*]/, "comment"]],
      dq: [[/[^\\"$]+/, "string"], [/\$[A-Za-z_][\w.]*/, "string.field"], [/\$/, "string"], [/\\./, "string.escape"], [/"/, "string", "@pop"]],
      sq: [[/[^\\'$]+/, "string"], [/\$[A-Za-z_][\w.]*/, "string.field"], [/\$/, "string"], [/\\./, "string.escape"], [/'/, "string", "@pop"]],
      bq: [[/[^\\`]+/, "string"], [/\\./, "string.escape"], [/`/, "string", "@pop"]],
    },
  });
  monaco.languages.setLanguageConfiguration("mongosh", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"', notIn: ["string"] }, { open: "'", close: "'", notIn: ["string"] }],
    surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"' }, { open: "'", close: "'" }],
  });
  monaco.editor.defineTheme("mongo-light", { base: "vs", inherit: true, rules: [
    { token: "shell", foreground: "267f99" }, { token: "operator.mongo", foreground: "af00db" }, { token: "string.field", foreground: "b35c00" }], colors: {} });
  monaco.editor.defineTheme("mongo-dark", { base: "vs-dark", inherit: true, rules: [
    { token: "shell", foreground: "4ec9b0" }, { token: "operator.mongo", foreground: "c586c0" }, { token: "string.field", foreground: "ffb86b" }], colors: {} });

  const K = monaco.languages.CompletionItemKind, SNIP = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  monaco.languages.registerCompletionItemProvider("mongosh", {
    triggerCharacters: [".", "$"],
    provideCompletionItems(model, pos) {
      const line = model.getValueInRange({ startLineNumber: pos.lineNumber, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: pos.column });
      const word = model.getWordUntilPosition(pos);
      const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const item = (label, insertText, kind, detail, snippet = true) => ({ label, insertText, kind, detail, range, insertTextRules: snippet ? SNIP : undefined });
      const cur = schema.dbs.find((d) => d.name === schema.current);
      let m;
      if ((m = /\$(\w*)$/.exec(line))) {
        const r2 = { ...range, startColumn: pos.column - m[0].length };
        const inStr = (line.match(/"/g) || []).length % 2 === 1 || (line.match(/'/g) || []).length % 2 === 1;
        if (inStr) return { suggestions: [] };
        return { suggestions: Object.entries(OPERATORS).flatMap(([kind, list]) => list.split(" ").map((op) => ({
          label: "$" + op, insertText: "\\$" + op, insertTextRules: SNIP, kind: K.Operator, detail: `${kind} operator`, range: r2 }))) };
      }
      if (/\bdb\.(?:getCollection\(["'][^"']+["']\)|[A-Za-z_$][\w$]*)\.\w*$/.test(line) && !/\bdb\.(getSiblingDB|getCollection)\.\w*$/.test(line))
        return { suggestions: COLL_METHODS.map(([n, s, d]) => item(n, s, K.Method, d)) };
      if (/\bdb\.\w*$/.test(line))
        return { suggestions: [
          ...(cur ? cur.colls : []).map((c) => item(c.name, c.name, K.Field, `collection (${c.count} documents)`, false)),
          ...DB_METHODS.map(([s, d]) => item(s.replace(/\(.*/, ""), s, K.Method, d)),
        ] };
      if (/\)\s*\.\w*$/.test(line)) return { suggestions: CURSOR_METHODS.map((s) => item(s.replace(/\(.*/, ""), s, K.Method, "cursor method")) };
      if (/^\s*use\s+\w*$/.test(line)) return { suggestions: schema.dbs.map((d) => item(d.name, d.name, K.Module, "database", false)) };
      if (/^\s*show\s+\w*$/.test(line)) return { suggestions: ["dbs", "collections"].map((x) => item(x, x, K.Keyword, "shell command", false)) };
      return { suggestions: [] };
    },
  });
}

function loadMonaco() {
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
  });
}
function initMenu() {
  const menu = $("menu"), btn = $("btnMenu");
  for (const [key, ds] of Object.entries(DATASETS)) {
    const b = document.createElement("button");
    b.innerHTML = `${escapeHtml(ds.title)} <small>${escapeHtml(ds.desc)}</small>`;
    b.onclick = () => { menu.hidden = true; loadDataset(key); };
    $("datasets").appendChild(b);
  }
  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.innerHTML = `${escapeHtml(ex.title)}${ex.needs ? `<small>${escapeHtml(ex.needs)}</small>` : ""}`;
    b.onclick = () => { menu.hidden = true; loadExample(ex); };
    $("examples").appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
  menu.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (!cmd) return;
    menu.hidden = true;
    ({ help, theme: toggleTheme })[cmd]?.();
  });
}
function initSplit() {
  const sp = $("hsplit"), ed = $("editor"), work = document.querySelector(".work");
  let drag = false;
  sp.addEventListener("pointerdown", (e) => { drag = true; sp.classList.add("drag"); sp.setPointerCapture(e.pointerId); });
  sp.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = work.getBoundingClientRect();
    ed.style.flex = `0 0 ${Math.min(80, Math.max(12, ((e.clientY - r.top) / r.height) * 100))}%`;
  });
  sp.addEventListener("pointerup", () => { drag = false; sp.classList.remove("drag"); });
}
const editorTheme = () => (currentTheme() === "dark" ? "mongo-dark" : "mongo-light");

async function boot() {
  startWorker();
  banner();
  monaco = await loadMonaco();
  registerLanguage();
  let draft = "";
  try { draft = localStorage.getItem(DRAFT) || ""; } catch {}
  editor = monaco.editor.create($("editor"), {
    value: draft || "// MongoDB shell commands, one per line. Ctrl+Enter runs them (or just the selected lines).\n// Start with Samples & examples, or try:\nuse test\ndb.notes.insertOne({ text: \"Hello MongoDB\", when: new Date() })\ndb.notes.find()\n",
    language: "mongosh",
    theme: editorTheme(),
    automaticLayout: true,
    fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 15,
    tabSize: 2,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    quickSuggestions: { other: true, comments: false, strings: false },
  });
  window.addEventListener("foct-theme", () => monaco.editor.setTheme(editorTheme()));
  editor.onDidChangeCursorPosition((e) => { $("cursor").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
  editor.onDidChangeModelContent(() => {
    clearTimeout(boot.t);
    boot.t = setTimeout(() => { try { localStorage.setItem(DRAFT, editor.getValue()); } catch {} }, 500);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => run());
  editor.addCommand(monaco.KeyCode.F5, () => run());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveScript());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, openScript);
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.target === $("replInput")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "enter") { e.preventDefault(); run(); }
    else if (e.key === "F5") { e.preventDefault(); run(); }
    else if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); saveScript(e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && k === "o") { e.preventDefault(); openScript(); }
  });
  $("btnRun").onclick = () => run();
  $("btnStop").onclick = stop;
  $("btnSave").onclick = () => saveScript();
  $("btnOpen").onclick = openScript;
  $("btnNew").onclick = () => { setScript("// New MongoDB script\nuse test\n\n", "script.js"); editor.setPosition({ lineNumber: 3, column: 1 }); editor.focus(); };
  $("btnClear").onclick = () => { out().textContent = ""; };
  $("btnImport").onclick = () => importFiles();
  $("btnExport").onclick = exportColl;
  $("btnDump").onclick = dumpAll;
  $("btnRestore").onclick = restoreAll;
  $("btnReset").onclick = resetAll;
  initMenu();
  initSplit();
  initSidebar();
  initRepl();
  editor.focus();
}

boot().catch((e) => { console.error(e); $("status").textContent = "The MongoDB Lab could not start: " + (e.message || e); });
