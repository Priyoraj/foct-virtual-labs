// FoCT Virtual Labs - SQL Lab (SQLite via sql.js, PostgreSQL via PGlite; everything in the browser)
import { DATASETS, EXAMPLES } from "./samples.js";
import { toast, modal, saveToDisk, pickFiles, downloadBlob, toggleTheme, currentTheme, escapeHtml } from "/assets/js/foct.js";

const $ = (id) => document.getElementById(id);
const DRAFT = "foct.sql.draft";
const ENGINE_KEY = "foct.sql.engine";
const ENGINES = {
  sqlite: { label: "SQLite", worker: () => new Worker(new URL("./sqlite-worker.js", import.meta.url)) },
  postgres: { label: "PostgreSQL", worker: () => new Worker(new URL("./pg-worker.js", import.meta.url), { type: "module" }) },
};

let monaco, editor;
let engine = "sqlite";
const conns = {};            // engine -> {worker, pending, version}
let running = false;
let fileName = "queries.sql";
let fileHandle = null;

// ------------------------------------------------------------------ engine connections
function conn(name = engine) {
  if (!conns[name]) {
    const w = ENGINES[name].worker();
    const c = { worker: w, pending: new Map(), seq: 0, version: null };
    w.onmessage = (e) => {
      const p = c.pending.get(e.data.id);
      if (!p) return;
      c.pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data.result) : p.reject(Object.assign(new Error(e.data.error), e.data));
    };
    w.onerror = (e) => {
      for (const p of c.pending.values()) p.reject(new Error(e.message || "The database engine stopped."));
      c.pending.clear();
    };
    conns[name] = c;
  }
  return conns[name];
}

function call(type, data = {}, name = engine) {
  const c = conn(name);
  const id = ++c.seq;
  return new Promise((resolve, reject) => {
    c.pending.set(id, { resolve, reject });
    c.worker.postMessage({ id, type, ...data });
  });
}

function killEngine(name = engine) {
  const c = conns[name];
  if (!c) return;
  c.worker.terminate();
  for (const p of c.pending.values()) p.reject(new Error("Stopped."));
  delete conns[name];
}

async function warmUp() {
  const chip = $("engineChip");
  chip.className = "chip warn";
  $("engineText").textContent = `Starting ${ENGINES[engine].label}…`;
  try {
    const v = await call("version");
    conn().version = v;
    chip.className = "chip ok";
    $("engineText").textContent = v;
    refreshSchema();
  } catch (e) {
    chip.className = "chip bad";
    $("engineText").textContent = "Engine failed to start";
    toast(String(e.message || e), "bad");
  }
}

// ------------------------------------------------------------------ statement splitting
/** Split a script into statements, keeping quotes, comments, $$ bodies and trigger BEGIN..END intact. */
export function splitSql(text) {
  const out = [];
  let start = 0, i = 0, depth = 0, caseDepth = 0;
  const n = text.length;
  const isTrigger = () => /^\s*(--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(text.slice(start, i));
  const push = (end) => {
    const sql = text.slice(start, end);
    const body = sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "");
    if (body.trim() && body.trim() !== ";") {
      const lead = sql.length - body.length;
      const line = text.slice(0, start + lead).split("\n").length;
      out.push({ sql: body.replace(/;\s*$/, "").trim(), line });
    }
    start = end;
  };
  while (i < n) {
    const c = text[i], d = text[i + 1];
    // psql (\dt) and sqlite3 (.tables) commands end at the end of their line
    if ((c === "\\" || (c === "." && /[a-z]/i.test(d || ""))) && !text.slice(start, i).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim()) {
      const e = text.indexOf("\n", i);
      i = e < 0 ? n : e;
      push(i);
      continue;
    }
    if (c === "-" && d === "-") { const e = text.indexOf("\n", i); i = e < 0 ? n : e + 1; continue; }
    if (c === "/" && d === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < n) { if (text[i] === c) { if (text[i + 1] === c) { i += 2; continue; } break; } i++; }
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const e = text.indexOf(m[0], i + m[0].length);
        i = e < 0 ? n : e + m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1]))) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const w = text.slice(i, j).toUpperCase();
      if (w === "BEGIN" || w === "CASE" || w === "END") {
        if (isTrigger()) {
          if (w === "BEGIN") depth++;
          else if (w === "CASE") caseDepth++;
          else if (caseDepth > 0) caseDepth--;
          else if (depth > 0) depth--;
        }
      }
      i = j;
      continue;
    }
    if (c === ";" && depth === 0) { push(i + 1); depth = 0; caseDepth = 0; }
    i++;
  }
  push(n);
  return out;
}

const VERB_RE = /^\s*(\w+)(?:\s+(?:OR\s+REPLACE\s+)?(?:TEMP\s+|TEMPORARY\s+|UNIQUE\s+)?(\w+))?/i;
function describeStmt(sql) {
  const m = VERB_RE.exec(sql) || [];
  return { verb: (m[1] || "").toUpperCase(), object: (m[2] || "").toUpperCase() };
}

// ------------------------------------------------------------------ MySQL / psql / sqlite3 habits
function metaCommand(sql) {
  const s = sql.trim().replace(/;$/, "");
  let m;
  if (/^(show\s+tables|\\dt\+?|\.tables)$/i.test(s)) return { kind: "tables" };
  if ((m = /^(?:desc|describe|show\s+columns\s+from|\\d\+?|\.schema)\s+[`"[]?([\w.]+)[`"\]]?$/i.exec(s))) return { kind: "describe", table: m[1].split(".").pop() };
  if (/^\.schema$/i.test(s)) return { kind: "tables" };
  if (/^show\s+databases$/i.test(s) || /^\\l$/i.test(s)) return { kind: "info", text: "There is one database per browser tab in the SQL Lab, so SHOW DATABASES / USE are not needed. Just create tables." };
  if ((m = /^use\s+(\w+)$/i.exec(s))) return { kind: "info", text: `USE ${m[1]}: the SQL Lab always works in its single database, so this command is skipped.` };
  if ((m = /^(create|drop)\s+database\s+(?:if\s+(?:not\s+)?exists\s+)?(\w+)$/i.exec(s))) return { kind: "info", text: `${m[1].toUpperCase()} DATABASE ${m[2]}: skipped. The SQL Lab gives you one database per engine; use "Empty database" to start over.` };
  return null;
}

// ------------------------------------------------------------------ running
async function run() {
  if (running) return;
  const model = editor.getModel();
  const sel = editor.getSelection();
  const useSel = sel && !sel.isEmpty();
  const text = useSel ? model.getValueInRange(sel) : model.getValue();
  const lineOffset = useSel ? sel.startLineNumber - 1 : 0;
  const stmts = splitSql(text).map((s) => ({ ...s, line: s.line + lineOffset }));
  monaco.editor.setModelMarkers(model, "sql", []);
  const out = $("results");
  out.textContent = "";
  if (!stmts.length) { out.innerHTML = `<p class="muted">Nothing to run. Write a SQL statement ending with <code>;</code></p>`; return; }
  setRunning(true);
  const t0 = performance.now();
  let okCount = 0;
  for (const st of stmts) {
    const block = document.createElement("div");
    block.className = "res";
    out.appendChild(block);
    const start = performance.now();
    try {
      const meta = metaCommand(st.sql);
      if (meta) await runMeta(meta, block, st);
      else {
        $("status").textContent = `Running statement at line ${st.line}…`;
        const r = await call("exec", { sql: st.sql });
        renderResult(block, st, r, performance.now() - start);
      }
      okCount++;
    } catch (e) {
      renderError(block, st, e);
      if (e.message === "Stopped.") break;
      // keep going like most SQL tools, but mark the line
    }
    block.scrollIntoView({ block: "nearest" });
  }
  setRunning(false);
  const secs = ((performance.now() - t0) / 1000).toFixed(2);
  $("status").textContent = `${okCount} of ${stmts.length} statement${stmts.length > 1 ? "s" : ""} succeeded in ${secs} s`;
  refreshSchema();
  saveDraft();
}

function headHtml(st, extra) {
  const short = st.sql.replace(/\s+/g, " ").slice(0, 120);
  return `<span class="sql" title="Go to line ${st.line}" data-line="${st.line}">${escapeHtml(short)}</span><span>line ${st.line}</span><span class="spacer"></span>${extra || ""}`;
}

function wireHead(block) {
  const s = block.querySelector(".sql");
  if (s) s.onclick = () => { editor.revealLineInCenter(+s.dataset.line); editor.setPosition({ lineNumber: +s.dataset.line, column: 1 }); editor.focus(); };
}

function renderResult(block, st, r, ms) {
  const { verb, object } = describeStmt(st.sql);
  const time = `${Math.max(1, Math.round(ms))} ms`;
  if (r.columns && r.columns.length) {
    const more = r.rowCount > r.rows.length ? ` (showing first ${r.rows.length})` : "";
    block.innerHTML = `<div class="res-head">${headHtml(st, `<span class="ok">${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${more}</span><span>${time}</span><button class="btn btn-ghost btn-sm csv">CSV</button>`)}</div>`;
    block.appendChild(table(r.columns, r.rows));
    block.querySelector(".csv").onclick = () => downloadBlob("result.csv", new Blob([toCsv(r.columns, r.rows)], { type: "text/csv" }));
  } else {
    let msg;
    const n = r.changes;
    if (verb === "INSERT") msg = `${n} row${n === 1 ? "" : "s"} inserted.`;
    else if (verb === "UPDATE") msg = `${n} row${n === 1 ? "" : "s"} updated.`;
    else if (verb === "DELETE") msg = `${n} row${n === 1 ? "" : "s"} deleted.`;
    else if (verb === "CREATE" || verb === "DROP" || verb === "ALTER") msg = `${verb} ${object || ""} done.`.replace(/\s+/g, " ");
    else if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(verb)) msg = `${verb} done.`;
    else msg = `${verb || "Statement"} done.`;
    block.innerHTML = `<div class="res-head">${headHtml(st, `<span>${time}</span>`)}</div><div class="res-msg">${escapeHtml(msg)}</div>`;
  }
  wireHead(block);
}

function renderError(block, st, e) {
  block.classList.add("err");
  let line = st.line;
  if (e.position && st.sql) line += st.sql.slice(0, e.position - 1).split("\n").length - 1;
  let msg = String(e.message || e).replace(/^Error:\s*/, "");
  const hint = friendlyHint(msg, st.sql);
  block.innerHTML = `<div class="res-head">${headHtml(st, "")}</div><div class="res-msg">✖ Line ${line}: ${escapeHtml(msg)}</div>` +
    (e.detail ? `<div class="hint">${escapeHtml(e.detail)}</div>` : "") +
    (e.hint ? `<div class="hint">Hint: ${escapeHtml(e.hint)}</div>` : "") +
    (hint ? `<div class="hint">${hint}</div>` : "");
  wireHead(block);
  const model = editor.getModel();
  const markers = monaco.editor.getModelMarkers({ owner: "sql" });
  markers.push({ severity: monaco.MarkerSeverity.Error, message: msg, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(Math.min(line, model.getLineCount())) });
  monaco.editor.setModelMarkers(model, "sql", markers);
}

function friendlyHint(msg, sql) {
  if (/AUTO_INCREMENT/i.test(sql)) return engine === "sqlite"
    ? "MySQL's AUTO_INCREMENT: in SQLite write <code>id INTEGER PRIMARY KEY</code> (it numbers rows automatically)."
    : "MySQL's AUTO_INCREMENT: in PostgreSQL write <code>id SERIAL PRIMARY KEY</code> or <code>id INTEGER GENERATED ALWAYS AS IDENTITY</code>.";
  const nn = engine === "postgres" && /null value in column "(\w+)"/i.exec(msg);
  if (nn) return `If <code>${nn[1]}</code> should number the rows by itself, declare it as <code>${nn[1]} SERIAL PRIMARY KEY</code> (or <code>GENERATED ALWAYS AS IDENTITY</code>). Unlike SQLite, PostgreSQL's <code>INTEGER PRIMARY KEY</code> does not fill itself in.`;
  const missing = /no such table: (\w+)|relation "(\w+)" does not exist/i.exec(msg);
  if (missing && /^(emp|dept|salgrade|student|course|enrollment|department|book|member|issue)$/i.test(missing[1] || missing[2])) return "Load the matching sample database from <b>Samples &amp; examples</b>.";
  if (/VARCHAR2|NUMBER\(/i.test(sql)) return "Oracle types: use <code>VARCHAR</code> instead of <code>VARCHAR2</code> and <code>NUMERIC</code> instead of <code>NUMBER</code>.";
  if (/DELIMITER/i.test(sql)) return "DELIMITER is a MySQL client command. Statements here end with <code>;</code>; write PostgreSQL functions with <code>$$ ... $$</code>.";
  return "";
}

async function runMeta(meta, block, st) {
  if (meta.kind === "info") {
    block.innerHTML = `<div class="res-head">${headHtml(st, "")}</div><div class="res-msg info">${escapeHtml(meta.text)}</div>`;
    wireHead(block);
    return;
  }
  const schema = await call("schema");
  if (meta.kind === "tables") {
    const rows = schema.map((t) => [t.name, t.type, t.rows]);
    block.innerHTML = `<div class="res-head">${headHtml(st, `<span class="ok">${rows.length} table${rows.length === 1 ? "" : "s"}</span>`)}</div>`;
    block.appendChild(table(["name", "type", "rows"], rows));
  } else {
    const t = schema.find((x) => x.name.toLowerCase() === meta.table.toLowerCase());
    if (!t) throw new Error(`Table '${meta.table}' does not exist.`);
    const rows = t.columns.map((c) => [c.name, c.type || "", c.notNull || c.pk ? "NO" : "YES", c.pk ? "PRI" : ""]);
    block.innerHTML = `<div class="res-head">${headHtml(st, `<span class="ok">${t.name}: ${rows.length} columns</span>`)}</div>`;
    block.appendChild(table(["Field", "Type", "Null", "Key"], rows));
  }
  wireHead(block);
}

function table(columns, rows) {
  const wrap = document.createElement("div");
  wrap.className = "grid";
  const parts = ["<table><thead><tr><th class=\"rowno\">#</th>"];
  for (const c of columns) parts.push(`<th>${escapeHtml(c)}</th>`);
  parts.push("</tr></thead><tbody>");
  rows.forEach((r, i) => {
    parts.push(`<tr><td class="rowno">${i + 1}</td>`);
    for (const v of r) {
      if (v === null || v === undefined) parts.push('<td class="null">NULL</td>');
      else parts.push(`<td${typeof v === "number" ? ' class="num"' : ""}>${escapeHtml(String(v))}</td>`);
    }
    parts.push("</tr>");
  });
  parts.push("</tbody></table>");
  wrap.innerHTML = parts.join("");
  return wrap;
}

function toCsv(columns, rows) {
  const q = (v) => v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [columns.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\r\n");
}

function setRunning(on) {
  running = on;
  $("btnRun").hidden = on;
  $("btnStop").hidden = !on;
}

async function stop() {
  if (!running) return;
  killEngine();
  setRunning(false);
  toast(`${ENGINES[engine].label} was restarted; the database is empty again.`, "bad", 5000);
  warmUp();
}

// ------------------------------------------------------------------ schema browser
async function refreshSchema() {
  const box = $("schemaList");
  let schema;
  try { schema = await call("schema"); } catch { return; }
  if (!schema.length) { box.innerHTML = `<p class="muted" style="padding:4px 6px">No tables yet. Create one, or load a sample database.</p>`; return; }
  box.textContent = "";
  for (const t of schema) {
    const d = document.createElement("details");
    d.innerHTML = `<summary><span class="nm">${escapeHtml(t.name)}</span>${t.type === "view" ? '<span class="kind">view</span>' : ""}<span class="cnt">${t.rows ?? ""}</span></summary>` +
      `<ul>${t.columns.map((c) => `<li>${c.pk ? '<span class="pk" title="primary key">PK</span>' : ""}<span>${escapeHtml(c.name)}</span><span class="ty">${escapeHtml(c.type || "")}</span></li>`).join("")}</ul>`;
    d.querySelector("summary").addEventListener("dblclick", (e) => {
      e.preventDefault();
      insertAndRun(`SELECT * FROM ${t.name} LIMIT 100;`);
    });
    d.querySelector("summary").title = "Double-click to show the rows";
    box.appendChild(d);
  }
}

function insertAndRun(sql) {
  const model = editor.getModel();
  const last = model.getLineCount();
  const text = (model.getValue().trim() ? "\n" : "") + sql + "\n";
  editor.executeEdits("schema", [{ range: new monaco.Range(last, model.getLineMaxColumn(last), last, model.getLineMaxColumn(last)), text }]);
  const end = model.getLineCount();
  editor.setSelection(new monaco.Selection(end - 1, 1, end - 1, model.getLineMaxColumn(end - 1)));
  run();
}

// ------------------------------------------------------------------ files
async function saveScript(saveAs = false) {
  const r = await saveToDisk(fileName, editor.getValue(), { handle: fileHandle, saveAs, mime: "application/sql", description: "SQL script" });
  if (!r) return;
  fileHandle = r.handle;
  if (r.name) fileName = r.name;
  toast(r.method === "file" ? `Saved ${fileName}.` : `${fileName} downloaded to your Downloads folder.`);
}

async function openFile() {
  const [f] = await pickFiles({ accept: ".sql,.txt,.db,.sqlite,.sqlite3,.gz", multiple: false });
  if (!f) return;
  const name = f.name.toLowerCase();
  if (/\.(db|sqlite3?)$/.test(name)) {
    await switchEngine("sqlite");
    await call("open", { bytes: await f.file.arrayBuffer() });
    toast(`Opened database ${f.name} in SQLite.`);
    refreshSchema();
  } else if (name.endsWith(".tar.gz") || name.endsWith(".gz")) {
    await switchEngine("postgres");
    await call("open", { blob: f.file });
    toast(`Opened PostgreSQL database ${f.name}.`);
    refreshSchema();
  } else {
    editor.setValue(await f.file.text());
    fileName = f.name;
    fileHandle = f.handle;
    toast(`Opened ${f.name}. Press Run to execute it.`);
  }
}

async function saveDatabase() {
  try {
    const data = await call("export");
    if (engine === "sqlite") downloadBlob("database.sqlite", new Blob([data], { type: "application/vnd.sqlite3" }));
    else downloadBlob("database.pgdata.tar.gz", data);
    toast(engine === "sqlite" ? "database.sqlite downloaded. Open it here later, or in any SQLite tool." : "database.pgdata.tar.gz downloaded. Open it here later to continue.");
  } catch (e) {
    toast("Could not export the database: " + (e.message || e), "bad");
  }
}

async function emptyDatabase() {
  const ok = await modal({ title: `Empty the ${ENGINES[engine].label} database?`, html: "<p>All tables and data in this lab session are removed. Save the database first if you need it.</p>", actions: [{ label: "Cancel", value: false }, { label: "Empty it", value: true, danger: true }] });
  if (!ok) return;
  await call("open", {});
  refreshSchema();
  toast("The database is empty.");
}

async function loadDataset(key) {
  const ds = DATASETS[key];
  const out = $("results");
  out.innerHTML = "";
  setRunning(true);
  try {
    for (const st of splitSql(ds.sql)) {
      if (/^SELECT/i.test(st.sql)) continue;
      await call("exec", { sql: st.sql });
    }
    out.innerHTML = `<div class="res"><div class="res-msg">${escapeHtml(ds.title)} loaded into ${ENGINES[engine].label}.</div></div>`;
    toast(`${ds.title} is ready. Double-click a table on the left to see it.`);
  } catch (e) {
    out.innerHTML = `<div class="res err"><div class="res-msg">${escapeHtml(e.message || String(e))}</div></div>`;
  }
  setRunning(false);
  refreshSchema();
}

async function loadExample(title) {
  const ex = EXAMPLES[title];
  if (ex.engine && ex.engine !== engine) {
    await switchEngine(ex.engine);
    toast(`Switched to ${ENGINES[ex.engine].label} for this example.`);
  }
  const schema = await call("schema").catch(() => []);
  const need = { company: "emp", university: "student", library: "book" }[ex.needs];
  if (need && !schema.some((t) => t.name === need)) await loadDataset(ex.needs);
  editor.pushUndoStop();
  editor.executeEdits("example", [{ range: editor.getModel().getFullModelRange(), text: ex.sql }]);
  editor.pushUndoStop();
  editor.setPosition({ lineNumber: 1, column: 1 });
  toast(`Example "${title}" loaded — press Run (Ctrl+Enter).`);
}

async function switchEngine(name) {
  if (name === engine) return;
  engine = name;
  $("engine").value = name;
  try { localStorage.setItem(ENGINE_KEY, name); } catch {}
  await warmUp();
}

function saveDraft() {
  try { localStorage.setItem(DRAFT, editor.getValue()); } catch {}
}

function help() {
  modal({
    title: "SQL Lab help",
    html: `<ul style="padding-left:18px;line-height:1.7;margin:0">
      <li><b>Run</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) runs the selected text, or the whole script. End every statement with <code>;</code>.</li>
      <li><b>SQLite</b> is small and quick. <b>PostgreSQL</b> is a full server database (version 18) with stored functions, procedures, triggers in PL/pgSQL, sequences and roles &mdash; use it for PL/SQL-style labs.</li>
      <li>Familiar commands work: <code>SHOW TABLES;</code> <code>DESC emp;</code> <code>\\dt</code> <code>\\d emp</code> <code>.tables</code>.</li>
      <li>MySQL users: use <code>INTEGER PRIMARY KEY</code> (SQLite) or <code>SERIAL PRIMARY KEY</code> (PostgreSQL) instead of <code>AUTO_INCREMENT</code>; <code>LIMIT</code> works in both.</li>
      <li>Oracle users: use <code>VARCHAR</code>/<code>NUMERIC</code> instead of <code>VARCHAR2</code>/<code>NUMBER</code>; PL/SQL blocks become PostgreSQL functions written between <code>$$ ... $$</code>.</li>
      <li>The database lives in this browser tab. <b>Save</b> keeps your script (<code>.sql</code>); <b>Save database</b> keeps the data (<code>.sqlite</code> or <code>.pgdata.tar.gz</code>). <b>Open</b> loads either. Nothing is stored on the lab server.</li>
      <li>Double-click a table on the left to see its rows.</li>
    </ul>`,
  });
}

function welcome() {
  $("results").innerHTML = `<div class="welcome">
    <p><b>SQL Lab</b> runs a real database inside your browser: <b>SQLite</b> or <b>PostgreSQL</b> (choose at the top).</p>
    <p>Start from <b>Samples &amp; examples</b> &rarr; <i>Company (EMP, DEPT, SALGRADE)</i>, then try <code>SELECT * FROM emp;</code> and press <b>Run</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>).</p>
    <p>Save your script with <kbd>Ctrl</kbd>+<kbd>S</kbd>. The data is not stored on the lab server: use <b>Save database</b> to keep it.</p></div>`;
}

// ------------------------------------------------------------------ UI wiring
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
    b.innerHTML = `${escapeHtml(ds.title)}`;
    b.title = ds.note;
    b.onclick = () => { menu.hidden = true; loadDataset(key); };
    $("datasets").appendChild(b);
  }
  for (const [title, ex] of Object.entries(EXAMPLES)) {
    const b = document.createElement("button");
    b.innerHTML = `${escapeHtml(title)}${ex.engine ? `<small>${ENGINES[ex.engine].label}</small>` : ""}`;
    b.onclick = () => { menu.hidden = true; loadExample(title); };
    $("examples").appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
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
    const pct = Math.min(80, Math.max(15, ((e.clientY - r.top) / r.height) * 100));
    ed.style.flex = `0 0 ${pct}%`;
  });
  sp.addEventListener("pointerup", () => { drag = false; sp.classList.remove("drag"); });
}

async function boot() {
  monaco = await loadMonaco();
  let draft = "";
  try { draft = localStorage.getItem(DRAFT) || ""; engine = localStorage.getItem(ENGINE_KEY) || "sqlite"; } catch {}
  if (!ENGINES[engine]) engine = "sqlite";
  $("engine").value = engine;
  editor = monaco.editor.create($("editor"), {
    value: draft || "-- Write SQL here. End each statement with ;\n-- Tip: Samples & examples > Company, then:\nSELECT * FROM emp;\n",
    language: "sql",
    theme: currentTheme() === "dark" ? "vs-dark" : "vs",
    automaticLayout: true,
    fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 15,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    fixedOverflowWidgets: true,
  });
  window.addEventListener("foct-theme", () => monaco.editor.setTheme(currentTheme() === "dark" ? "vs-dark" : "vs"));
  editor.onDidChangeCursorPosition((e) => { $("cursor").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
  editor.onDidChangeModelContent(() => { clearTimeout(boot.t); boot.t = setTimeout(saveDraft, 500); });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
  editor.addCommand(monaco.KeyCode.F5, run);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveScript());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, openFile);
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "enter") { e.preventDefault(); run(); }
    else if (e.key === "F5") { e.preventDefault(); run(); }
    else if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); saveScript(e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && k === "o") { e.preventDefault(); openFile(); }
  });
  $("btnRun").onclick = run;
  $("btnStop").onclick = stop;
  $("btnSave").onclick = () => saveScript();
  $("btnOpen").onclick = openFile;
  $("btnNew").onclick = () => { editor.setValue(""); fileName = "queries.sql"; fileHandle = null; editor.focus(); };
  $("btnRefresh").onclick = refreshSchema;
  $("btnSaveDb").onclick = saveDatabase;
  $("btnClearDb").onclick = emptyDatabase;
  $("engine").onchange = (e) => switchEngine(e.target.value);
  initMenu();
  initSplit();
  welcome();
  warmUp();
  editor.focus();
}

boot().catch((e) => { console.error(e); $("results").textContent = "The SQL Lab could not start: " + (e.message || e); });
