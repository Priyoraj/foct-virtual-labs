// SQLite (sql.js) in a classic Web Worker, one statement per "exec" message.
importScripts("/runtimes/sql/sqljs/sql-wasm.js");

const MAX_ROWS = 2000;
let SQL = null;
let db = null;

const ready = initSqlJs({ locateFile: (f) => "/runtimes/sql/sqljs/" + f }).then((s) => {
  SQL = s;
  open(null);
});

function open(bytes) {
  if (db) db.close();
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run("PRAGMA foreign_keys = ON;");
}

function exec(sql) {
  const stmt = db.prepare(sql);
  try {
    const columns = stmt.getColumnNames();
    const rows = [];
    let count = 0;
    while (stmt.step()) {
      if (rows.length < MAX_ROWS) rows.push(stmt.get().map(cell));
      count++;
    }
    return { columns, rows, rowCount: count, changes: db.getRowsModified() };
  } finally {
    stmt.free();
  }
}

function cell(v) {
  if (v instanceof Uint8Array) return `<BLOB ${v.length} bytes>`;
  return v;
}

function schema() {
  const out = [];
  const objs = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  for (const [name, type] of objs[0]?.values || []) {
    const cols = db.exec(`PRAGMA table_info(${quoteId(name)})`)[0]?.values || [];
    let rows = null;
    try { rows = db.exec(`SELECT count(*) FROM ${quoteId(name)}`)[0].values[0][0]; } catch {}
    out.push({ name, type, rows, columns: cols.map((c) => ({ name: c[1], type: c[2], notNull: !!c[3], pk: !!c[5] })) });
  }
  return out;
}

const quoteId = (s) => '"' + String(s).replace(/"/g, '""') + '"';

onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.type === "exec") postMessage({ id: m.id, ok: true, result: exec(m.sql) });
    else if (m.type === "schema") postMessage({ id: m.id, ok: true, result: schema() });
    else if (m.type === "export") {
      const bytes = db.export();
      postMessage({ id: m.id, ok: true, result: bytes }, [bytes.buffer]);
    } else if (m.type === "open") {
      open(m.bytes || null);
      postMessage({ id: m.id, ok: true, result: null });
    } else if (m.type === "version") {
      postMessage({ id: m.id, ok: true, result: "SQLite " + db.exec("select sqlite_version()")[0].values[0][0] });
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
