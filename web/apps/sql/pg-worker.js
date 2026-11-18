// PostgreSQL (PGlite) in a module Web Worker, one statement per "exec" message.
import { PGlite } from "/runtimes/sql/pglite/index.js";

const MAX_ROWS = 2000;
let db = null;
let ready = start(null);

async function start(dataDir) {
  if (db) { try { await db.close(); } catch {} }
  db = await PGlite.create(dataDir ? { loadDataDir: dataDir } : {});
}

const DATE = 1082, TIMESTAMP = 1114, TIMESTAMPTZ = 1184;

function cell(v, typeId) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (typeId === DATE) return v.toISOString().slice(0, 10);
    return v.toISOString().replace("T", " ").replace(/\.000Z$|Z$/, "");
  }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `<BYTEA ${v.length} bytes>`;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

async function exec(sql) {
  const r = await db.query(sql, [], { rowMode: "array" });
  const fields = r.fields || [];
  const rows = (r.rows || []).slice(0, MAX_ROWS).map((row) => row.map((v, i) => cell(v, fields[i]?.dataTypeID)));
  return { columns: fields.map((f) => f.name), rows, rowCount: (r.rows || []).length, changes: r.affectedRows ?? 0 };
}

async function schema() {
  const objs = await db.query(`
    SELECT c.relname AS name, CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS type
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'p')
    ORDER BY 2, 1`);
  const out = [];
  for (const o of objs.rows) {
    const cols = await db.query(`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
      FROM pg_attribute a
      WHERE a.attrelid = ('public.' || quote_ident($1))::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [o.name]);
    let rows = null;
    try { rows = Number((await db.query(`SELECT count(*) AS n FROM public.${quoteId(o.name)}`)).rows[0].n); } catch {}
    out.push({ name: o.name, type: o.type, rows, columns: cols.rows.map((c) => ({ name: c.name, type: c.type, notNull: c.not_null, pk: c.pk })) });
  }
  return out;
}

const quoteId = (s) => '"' + String(s).replace(/"/g, '""') + '"';

onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.type === "exec") postMessage({ id: m.id, ok: true, result: await exec(m.sql) });
    else if (m.type === "schema") postMessage({ id: m.id, ok: true, result: await schema() });
    else if (m.type === "export") {
      const blob = await db.dumpDataDir("gzip");
      postMessage({ id: m.id, ok: true, result: blob });
    } else if (m.type === "open") {
      ready = start(m.blob ? m.blob : null);
      await ready;
      postMessage({ id: m.id, ok: true, result: null });
    } else if (m.type === "version") {
      const v = (await db.query("select version() as v")).rows[0].v;
      postMessage({ id: m.id, ok: true, result: v.replace(/ on .*$/, "") });
    }
  } catch (err) {
    const pos = err && err.position ? Number(err.position) : null;
    postMessage({
      id: m.id, ok: false, error: String((err && err.message) || err), position: pos,
      detail: err?.detail || null, hint: err?.hint || null,
    });
  }
};
