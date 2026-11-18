/* FoCT Virtual Labs - MongoDB Lab engine (runs in a Web Worker).
 *
 * A mongosh-style shell over an in-memory database:
 *  - filters, projections, update operators and the aggregation pipeline are evaluated by
 *    mingo (MIT, https://github.com/kofrasa/mingo);
 *  - the shell (one result per statement, use / show / it), databases and collections,
 *    unique indexes, explain(), $jsonSchema validation, $text search and mapReduce are here.
 * The data stays on this computer: it is kept in this browser's IndexedDB between visits. */
importScripts("/runtimes/mongo/mingo.min.js", "/runtimes/mongo/acorn.js", "samples.js");

(() => {
"use strict";

const SERVER_VERSION = "7.0.0";
const BATCH = 20;

// ------------------------------------------------------------------ BSON-like types
let oidCounter = crypto.getRandomValues(new Uint32Array(1))[0] & 0xffffff;
const OID_RANDOM = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");

function ObjectId(id) {
  if (!(this instanceof ObjectId)) return new ObjectId(id);
  let hex;
  if (id instanceof ObjectId) hex = id.$oid;
  else if (id === undefined || id === null) hex = ObjectId.generate();
  else if (typeof id === "number") hex = ObjectId.generate(id);
  else if (typeof id === "string" && /^[0-9a-f]{24}$/i.test(id)) hex = id.toLowerCase();
  else if (id && typeof id === "object" && typeof id.$oid === "string") hex = id.$oid.toLowerCase();
  else throw new BSONError("input must be a 24 character hex string, 12 byte Uint8Array, or an integer");
  this.$oid = hex;
}
ObjectId.generate = (seconds) => {
  oidCounter = (oidCounter + 1) & 0xffffff;
  const ts = ((seconds ?? Date.now() / 1000) >>> 0).toString(16).padStart(8, "0");
  return ts + OID_RANDOM + oidCounter.toString(16).padStart(6, "0");
};
ObjectId.createFromHexString = (h) => new ObjectId(h);
ObjectId.createFromTime = (s) => new ObjectId(ObjectId.generate(s).slice(0, 8) + "0000000000000000");
ObjectId.isValid = (v) => v instanceof ObjectId || (typeof v === "string" && /^[0-9a-f]{24}$/i.test(v));
ObjectId.prototype.toString = function () { return this.$oid; };
ObjectId.prototype.toHexString = function () { return this.$oid; };
ObjectId.prototype.toJSON = function () { return { $oid: this.$oid }; };
ObjectId.prototype.equals = function (o) { return o != null && String(o) === this.$oid; };
ObjectId.prototype.getTimestamp = function () { return new Date(parseInt(this.$oid.slice(0, 8), 16) * 1000); };
Object.defineProperty(ObjectId.prototype, "str", { get() { return this.$oid; } });

class BSONError extends Error { constructor(m) { super(m); this.name = "BSONError"; } }

function ISODate(s) {
  if (s === undefined) return new Date();
  const d = new Date(s);
  if (isNaN(d)) throw new BSONError(`${JSON.stringify(s)} is not a valid ISO date`);
  return d;
}
const toNumber = (name) => (v = 0) => {
  const n = Number(typeof v === "object" && v !== null ? v.valueOf() : v);
  if (Number.isNaN(n)) throw new BSONError(`${name}: invalid number ${JSON.stringify(v)}`);
  return name === "NumberInt" ? Math.trunc(n) : n;
};

// ------------------------------------------------------------------ errors
class MongoServerError extends Error {
  constructor(message, code, codeName, extra) {
    super(message);
    this.name = "MongoServerError";
    if (code !== undefined) this.code = code;
    if (codeName) this.codeName = codeName;
    if (extra) Object.assign(this, extra);
  }
}
class MongoBulkWriteError extends MongoServerError {
  constructor(message, result, code) { super(message, code, "", { result }); this.name = "MongoBulkWriteError"; }
}
class MongoshError extends Error { constructor(m, name = "MongoshInvalidInputError") { super(m); this.name = name; } }
const notAvailable = (what) => new MongoshError(`${what} is not available in this lab: it runs a single MongoDB-compatible database inside your browser.`, "MongoshUnimplementedError");

// mingo's messages, in MongoDB's words
function mongoError(e) {
  if (!e || e instanceof MongoServerError || e instanceof MongoshError) return e;
  const m = String(e.message || e);
  let r;
  if ((r = /unknown (?:query )?operator[: ]*'?(\$\w+)/i.exec(m)) || (r = /invalid query operator[: ]*'?(\$\w+)/i.exec(m)))
    return new MongoServerError(`unknown operator: ${r[1]}`, 2, "BadValue");
  if ((r = /unknown pipeline operator[: ]*'?(\$\w+)|invalid pipeline operator[: ]*'?(\$\w+)/i.exec(m)))
    return new MongoServerError(`Unrecognized pipeline stage name: '${r[1] || r[2]}'`, 40324, "Location40324");
  if ((r = /unknown (?:expression|accumulator) operator[: ]*'?(\$\w+)|invalid (?:expression|accumulator) operator[: ]*'?(\$\w+)/i.exec(m)))
    return new MongoServerError(`Invalid $project :: caused by :: Unrecognized expression '${r[1] || r[2]}'`, 31325, "Location31325");
  if ((r = /unregistered (\w+) operator[: ]*'?(\$\w+)/i.exec(m))) {
    const [, kind, op] = r;
    const near = (list) => { const s = didYouMean(op, list.map((x) => "$" + x)); return s ? ` (did you mean ${s}?)` : ""; };
    if (/pipeline/i.test(kind)) return new MongoServerError(`Unrecognized pipeline stage name: '${op}'${near(STAGES)}`, 40324, "Location40324");
    if (/query/i.test(kind)) return new MongoServerError(`unknown operator: ${op}${near(QUERY_OPS)}`, 2, "BadValue");
    if (/accumulator/i.test(kind)) return new MongoServerError(`unknown group operator '${op}'${near(ACCUMULATORS)}`, 15952, "Location15952");
    return new MongoServerError(`Unrecognized expression '${op}'`, 168, "InvalidPipelineOperator");
  }
  if (e.constructor && /Mingo/i.test(e.constructor.name || "") || /^mingo/i.test(m)) return new MongoServerError(m.replace(/^mingo:\s*/i, ""), 2, "BadValue");
  return e;
}
const STAGES = "match group project sort limit skip unwind lookup addFields set unset count facet bucket bucketAuto sortByCount replaceRoot replaceWith sample out merge unionWith graphLookup redact densify fill setWindowFields documents".split(" ");
const QUERY_OPS = "eq ne gt gte lt lte in nin and or not nor exists type regex options all elemMatch size mod expr text where jsonSchema bitsAllSet bitsAnySet".split(" ");
const ACCUMULATORS = "sum avg min max first last push addToSet count stdDevPop stdDevSamp mergeObjects top bottom firstN lastN".split(" ");
const guard = (fn) => { try { return fn(); } catch (e) { throw mongoError(e); } };

// ------------------------------------------------------------------ helpers
const isPlain = (v) => v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function clone(v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof ObjectId) return new ObjectId(v.$oid);
  if (v instanceof RegExp) return new RegExp(v.source, v.flags);
  if (Array.isArray(v)) return v.map(clone);
  if (!isPlain(v)) return v;
  const o = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined && typeof v[k] !== "function") o[k] = clone(v[k]);
  return o;
}
function canon(v) {
  if (v === undefined || v === null) return "n";
  switch (typeof v) {
    case "number": return "d" + (Object.is(v, -0) ? 0 : v);
    case "string": return "s" + JSON.stringify(v);
    case "boolean": return v ? "T" : "F";
  }
  if (v instanceof ObjectId) return "o" + v.$oid;
  if (v instanceof Date) return "t" + v.getTime();
  if (v instanceof RegExp) return "r" + String(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return "?" + String(v);
}
// all values at a dotted path (arrays expand, like MongoDB's multikey indexes)
function valuesAt(doc, path) {
  let cur = [doc];
  for (const part of path.split(".")) {
    const next = [];
    for (const c of cur) {
      if (c === null || c === undefined) { next.push(undefined); continue; }
      if (Array.isArray(c) && !/^\d+$/.test(part)) { for (const el of c) next.push(el && typeof el === "object" ? el[part] : undefined); }
      else next.push(typeof c === "object" ? c[part] : undefined);
    }
    cur = next;
  }
  const out = [];
  for (const v of cur) { if (Array.isArray(v)) { if (v.length) out.push(...v); else out.push(undefined); } else out.push(v); }
  return out;
}
function setPath(doc, path, value) {
  const parts = path.split(".");
  let o = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts.at(-1)] = value;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return d[a.length][b.length];
}
function didYouMean(word, options) {
  let best = null, bestD = 3;
  for (const o of options) { const dd = levenshtein(word, o); if (dd < bestD) { bestD = dd; best = o; } }
  return best;
}

// ------------------------------------------------------------------ the database
const state = { current: "test", dbs: new Map() };   // dbName -> Map(collName -> store)
let dirty = false;
const markDirty = () => { dirty = true; };

function checkDbName(n) {
  if (typeof n !== "string" || !n || /[\/\\. "$*<>:|?]/.test(n) || n.length > 63)
    throw new MongoshError(`Invalid database name: ${JSON.stringify(n)}`);
}
function checkCollName(n) {
  if (typeof n !== "string" || !n || n.includes("$") || n.includes("\0") || n.startsWith(".") || n.endsWith(".") || n.startsWith("system."))
    throw new MongoServerError(`Invalid collection name: ${JSON.stringify(n)}`, 73, "InvalidNamespace");
}
function newStore(name, options = {}) {
  const st = { name, docs: [], indexes: [{ v: 2, key: { _id: 1 }, name: "_id_" }], options, uniq: new Map() };
  st.uniq.set("_id_", new Map());
  return st;
}
function storeOf(dbName, collName, create = false) {
  let db = state.dbs.get(dbName);
  if (!db) {
    if (!create) return null;
    checkDbName(dbName);
    db = new Map();
    state.dbs.set(dbName, db);
  }
  let st = db.get(collName);
  if (!st && create) {
    checkCollName(collName);
    st = newStore(collName);
    db.set(collName, st);
    markDirty();
  }
  return st || null;
}
const isUniqueIx = (ix) => ix.name === "_id_" || !!ix.unique;
const isTextIx = (ix) => Object.values(ix.key).some((v) => v === "text");

function indexKeys(ix, doc) {
  const fields = Object.keys(ix.key);
  const lists = fields.map((f) => valuesAt(doc, f));
  if (ix.sparse && lists.every((l) => l.every((v) => v === undefined))) return [];
  let combos = [""];
  for (const l of lists) {
    const next = [];
    for (const c of combos) for (const v of l) { next.push(c + "|" + canon(v)); if (next.length > 1000) break; }
    combos = next;
  }
  return [...new Set(combos)];
}
function dupError(dbName, st, ix, doc) {
  const shown = {};
  for (const f of Object.keys(ix.key)) { const v = valuesAt(doc, f)[0]; shown[f] = v === undefined ? null : v; }
  return new MongoServerError(`E11000 duplicate key error collection: ${dbName}.${st.name} index: ${ix.name} dup key: ${fmt(shown).t}`,
    11000, "DuplicateKey", { keyPattern: ix.key, keyValue: shown });
}
function checkUnique(dbName, st, doc, except) {
  for (const ix of st.indexes) {
    if (!isUniqueIx(ix)) continue;
    const m = st.uniq.get(ix.name);
    for (const k of indexKeys(ix, doc)) { const o = m.get(k); if (o && o !== except) throw dupError(dbName, st, ix, doc); }
  }
}
function indexDoc(st, doc) {
  for (const ix of st.indexes) if (isUniqueIx(ix)) { const m = st.uniq.get(ix.name); for (const k of indexKeys(ix, doc)) m.set(k, doc); }
}
function unindexDoc(st, doc) {
  for (const ix of st.indexes) if (isUniqueIx(ix)) { const m = st.uniq.get(ix.name); for (const k of indexKeys(ix, doc)) if (m.get(k) === doc) m.delete(k); }
}
function rebuildUnique(st) {
  st.uniq = new Map();
  for (const ix of st.indexes) if (isUniqueIx(ix)) st.uniq.set(ix.name, new Map());
  for (const d of st.docs) indexDoc(st, d);
}

const mingoOptions = (dbName) => ({
  collectionResolver: (name) => storeOf(dbName, name)?.docs || [],
  jsonSchemaValidator: (schema) => (doc) => schemaErrors(schema, doc).length === 0,
  useStrictMode: true,
  scriptEnabled: true,
});
const query = (dbName, filter) => guard(() => new mingo.Query(filter || {}, mingoOptions(dbName)));

// ------------------------------------------------------------------ $jsonSchema (the common keywords)
function bsonTypeOf(v) {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? (Math.abs(v) <= 2147483647 ? "int" : "long") : "double";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  if (v instanceof Date) return "date";
  if (v instanceof ObjectId) return "objectId";
  if (v instanceof RegExp) return "regex";
  if (Array.isArray(v)) return "array";
  return "object";
}
function bsonTypeOk(expected, v) {
  const t = bsonTypeOf(v);
  return [].concat(expected).some((e) => e === t || (e === "number" && ["int", "long", "double"].includes(t)) || (e === "decimal" && typeof v === "number") || (e === "long" && t === "int"));
}
function jsonTypeOk(expected, v) {
  return [].concat(expected).some((e) => ({
    string: typeof v === "string", number: typeof v === "number", integer: Number.isInteger(v), boolean: typeof v === "boolean",
    object: v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId),
    array: Array.isArray(v), null: v === null,
  })[e]);
}
function schemaErrors(s, v, path = "") {
  const at = path || "document";
  const errs = [];
  if (!s || typeof s !== "object") return errs;
  if (s.bsonType && !bsonTypeOk(s.bsonType, v)) return [`${at}: expected type ${[].concat(s.bsonType).join(" or ")}, found ${bsonTypeOf(v)}${v === undefined ? "" : " " + fmt(v).t}`];
  if (s.type && !jsonTypeOk(s.type, v)) return [`${at}: expected type ${[].concat(s.type).join(" or ")}, found ${bsonTypeOf(v)}`];
  if (s.enum && !s.enum.some((e) => canon(e) === canon(v))) errs.push(`${at}: ${fmt(v).t} is not one of ${fmt(s.enum).t}`);
  if (typeof v === "number") {
    if (s.minimum !== undefined && (s.exclusiveMinimum === true ? v <= s.minimum : v < s.minimum)) errs.push(`${at}: ${v} is less than the minimum ${s.minimum}`);
    if (s.maximum !== undefined && (s.exclusiveMaximum === true ? v >= s.maximum : v > s.maximum)) errs.push(`${at}: ${v} is more than the maximum ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) errs.push(`${at}: ${v} must be greater than ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) errs.push(`${at}: ${v} must be less than ${s.exclusiveMaximum}`);
    if (s.multipleOf && Math.abs(v / s.multipleOf - Math.round(v / s.multipleOf)) > 1e-9) errs.push(`${at}: ${v} is not a multiple of ${s.multipleOf}`);
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength} characters`);
    if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength} characters`);
    if (s.pattern) { let ok = true; try { ok = new RegExp(s.pattern, "u").test(v); } catch { ok = true; } if (!ok) errs.push(`${at}: ${fmt(v).t} does not match the pattern ${s.pattern}`); }
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
    if (s.uniqueItems && new Set(v.map(canon)).size !== v.length) errs.push(`${at}: items are not unique`);
    if (Array.isArray(s.items)) s.items.forEach((is, i) => { if (i < v.length) errs.push(...schemaErrors(is, v[i], `${at}[${i}]`)); });
    else if (s.items) v.forEach((x, i) => errs.push(...schemaErrors(s.items, x, `${at}[${i}]`)));
  }
  if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId)) {
    for (const r of s.required || []) if (v[r] === undefined) errs.push(`${path ? path + "." : ""}${r}: required field is missing`);
    const props = s.properties || {};
    for (const [k, ps] of Object.entries(props)) if (v[k] !== undefined) errs.push(...schemaErrors(ps, v[k], path ? `${path}.${k}` : k));
    if (s.additionalProperties === false || typeof s.additionalProperties === "object") {
      for (const k of Object.keys(v)) {
        if (k in props || (s.patternProperties && Object.keys(s.patternProperties).some((p) => new RegExp(p).test(k)))) continue;
        if (s.additionalProperties === false) errs.push(`${path ? path + "." : ""}${k}: additional field not allowed`);
        else errs.push(...schemaErrors(s.additionalProperties, v[k], path ? `${path}.${k}` : k));
      }
    }
    if (s.minProperties !== undefined && Object.keys(v).length < s.minProperties) errs.push(`${at}: fewer than ${s.minProperties} fields`);
    if (s.maxProperties !== undefined && Object.keys(v).length > s.maxProperties) errs.push(`${at}: more than ${s.maxProperties} fields`);
  }
  if (s.allOf) for (const x of s.allOf) errs.push(...schemaErrors(x, v, path));
  if (s.anyOf && !s.anyOf.some((x) => !schemaErrors(x, v, path).length)) errs.push(`${at}: does not match any of the allowed schemas (anyOf)`);
  if (s.oneOf && s.oneOf.filter((x) => !schemaErrors(x, v, path).length).length !== 1) errs.push(`${at}: must match exactly one schema (oneOf)`);
  if (s.not && !schemaErrors(s.not, v, path).length) errs.push(`${at}: matches a schema it must not match (not)`);
  return errs;
}
function validateDoc(dbName, st, doc) {
  const o = st.options || {};
  if (!o.validator || o.validationLevel === "off") return;
  if (query(dbName, o.validator).test(doc)) return;
  const reasons = o.validator.$jsonSchema ? schemaErrors(o.validator.$jsonSchema, doc) : [];
  if (o.validationAction === "warn") { emit({ kind: "info", text: `Warning: the document failed validation, but validationAction is "warn" so it was saved.` }); return; }
  throw new MongoServerError("Document failed validation", 121, "DocumentValidationFailure",
    { errInfo: { failingDocumentId: doc._id, reasons: reasons.length ? reasons : ["the document does not match the collection's validator"] } });
}

// ------------------------------------------------------------------ $text search
const STOP = new Set("a an and are as at be but by for from has have in into is it its of on or that the their this to was were will with".split(" "));
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}
const words = (t) => String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
function textMatcher(st, spec, dbName) {
  const ix = st && st.indexes.find(isTextIx);
  if (!ix) throw new MongoServerError("text index required for $text query", 27, "IndexNotFound");
  if (!spec || typeof spec.$search !== "string") throw new MongoServerError("$text requires a $search string", 2, "BadValue");
  const s = spec.$search;
  const phrases = [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase().trim()).filter(Boolean);
  const toks = s.replace(/"[^"]*"/g, " ").split(/\s+/).filter(Boolean);
  const neg = toks.filter((t) => t.startsWith("-")).flatMap((t) => words(t.slice(1))).map(stem);
  const terms = [...new Set(toks.filter((t) => !t.startsWith("-")).flatMap(words).filter((w) => !STOP.has(w)).map(stem))];
  const wild = "$**" in ix.key;
  const fields = wild ? null : Object.keys(ix.key).filter((k) => ix.key[k] === "text");
  const weights = ix.weights || {};
  const strings = (v, out) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (isPlain(v)) Object.values(v).forEach((x) => strings(x, out));
    return out;
  };
  return (doc) => {
    const perField = wild ? [["$**", strings(doc, [])]] : fields.map((f) => [f, valuesAt(doc, f).flatMap((x) => strings(x, []))]);
    let score = 0, hit = false;
    const all = [];
    for (const [f, texts] of perField) {
      const toksF = texts.flatMap(words).map(stem);
      all.push(...texts);
      if (!toksF.length) continue;
      const w = weights[f] || 1;
      for (const t of terms) {
        const c = toksF.filter((x) => x === t).length;
        if (c) { hit = true; score += w * (0.75 + 0.5 * c / toksF.length); }
      }
    }
    const lower = all.join(" \u0000 ").toLowerCase();
    if (phrases.length) { if (!phrases.every((p) => lower.includes(p))) return 0; hit = true; score += phrases.length * 0.5; }
    if (!hit) return 0;
    if (neg.length) { const all2 = new Set(words(lower).map(stem)); if (neg.some((n) => all2.has(n))) return 0; }
    return Math.round(score * 1e4) / 1e4;
  };
}
// split {$text: ...} out of a filter (top level or inside a top-level $and)
function extractText(filter) {
  if (!filter || typeof filter !== "object") return { filter, text: null };
  if (filter.$text) { const { $text, ...rest } = filter; return { filter: rest, text: $text }; }
  if (Array.isArray(filter.$and)) {
    const i = filter.$and.findIndex((c) => c && c.$text);
    if (i >= 0) { const and = filter.$and.slice(); const { $text, ...rest } = and[i]; and[i] = rest; return { filter: { ...filter, $and: and }, text: $text }; }
  }
  return { filter, text: null };
}
const isMetaScore = (v) => v && typeof v === "object" && v.$meta === "textScore";

// ------------------------------------------------------------------ find / aggregate execution
function orderLike(src, r) {
  if (!isPlain(r) || !isPlain(src)) return r;
  const o = {};
  if ("_id" in r) o._id = r._id;
  for (const k of Object.keys(src)) if (k in r && !(k in o)) o[k] = isPlain(r[k]) && isPlain(src[k]) ? orderLike(src[k], r[k]) : r[k];
  for (const k of Object.keys(r)) if (!(k in o)) o[k] = r[k];
  return o;
}
function idFirst(r) {
  if (!isPlain(r) || !("_id" in r) || Object.keys(r)[0] === "_id") return r;
  const { _id, ...rest } = r;
  return { _id, ...rest };
}
function runFind(c) {
  const st = storeOf(c._dbName, c._collName);
  let docs = st ? st.docs : [];
  const { filter, text } = extractText(c._filter || {});
  let proj = c._proj && Object.keys(c._proj).length ? { ...c._proj } : null;
  let sort = c._sort && Object.keys(c._sort).length ? { ...c._sort } : null;
  const metaProj = proj ? Object.keys(proj).filter((k) => isMetaScore(proj[k])) : [];
  metaProj.forEach((k) => delete proj[k]);
  if (proj && !Object.keys(proj).length) proj = null;
  const sortMeta = !!sort && Object.values(sort).some(isMetaScore);
  let scoreOf = null;
  if (text) {
    const score = textMatcher(st, text, c._dbName);
    const byId = new Map();
    docs = docs.filter((d) => { const s = score(d); if (s > 0) { byId.set(canon(d._id), s); return true; } return false; });
    scoreOf = (d) => byId.get(canon(d._id));
  } else if (metaProj.length || sortMeta) {
    throw new MongoServerError("query requires text score metadata, but it is not available", 40218, "Location40218");
  }
  const q = query(c._dbName, filter);
  let list;
  if (sortMeta) {
    const tmp = docs.map((d, i) => ({ ...d, __textScore: scoreOf(d), __i: i }));
    const s2 = {};
    for (const [k, v] of Object.entries(sort)) { if (isMetaScore(v)) s2.__textScore = -1; else s2[k] = v; }
    let mc = guard(() => q.find(tmp).sort(s2));
    if (c._skip) mc = mc.skip(c._skip);
    if (c._limit) mc = mc.limit(Math.abs(c._limit));
    list = guard(() => mc.all()).map((x) => docs[x.__i]);
  } else {
    let mc = guard(() => q.find(docs));
    if (sort) mc = guard(() => mc.sort(sort));
    if (c._skip) mc = mc.skip(c._skip);
    if (c._limit) mc = mc.limit(Math.abs(c._limit));
    list = guard(() => mc.all());
  }
  return list.map((d) => {
    let r = proj ? guard(() => q.find([d], proj).all()[0]) || {} : d;
    r = orderLike(d, clone(r));
    if (scoreOf) for (const k of metaProj) r[k] = scoreOf(d);
    return r;
  });
}

function runAggregate(c) {
  const dbName = c._dbName;
  const st = storeOf(dbName, c._collName);
  let pipeline = c._pipeline.slice();
  if (!Array.isArray(pipeline)) throw new MongoServerError("'pipeline' option must be specified as an array", 14, "TypeMismatch");
  for (const s of pipeline) {
    if (!s || typeof s !== "object" || Object.keys(s).length !== 1)
      throw new MongoServerError("A pipeline stage specification object must contain exactly one field.", 40323, "Location40323");
  }
  let docs = st ? st.docs : [];
  // $text must be in the first $match
  if (pipeline[0] && pipeline[0].$match) {
    const { filter, text } = extractText(pipeline[0].$match);
    if (text) {
      const score = textMatcher(st, text, dbName);
      docs = docs.filter((d) => score(d) > 0);
      pipeline = [{ $match: filter }, ...pipeline.slice(1)];
    }
  }
  const last = pipeline.at(-1);
  const out = last && (last.$out !== undefined ? { kind: "out", spec: last.$out } : last.$merge !== undefined ? { kind: "merge", spec: last.$merge } : null);
  if (out) pipeline = pipeline.slice(0, -1);
  let result = guard(() => new mingo.Aggregator(pipeline, mingoOptions(dbName)).run(docs.map(clone)));
  result = result.map((r) => idFirst(clone(r)));
  if (out) { writeOut(dbName, out, result); return []; }
  return result;
}
function writeOut(dbName, out, result) {
  let target = out.spec, tdb = dbName;
  if (out.kind === "merge" && typeof target === "object" && target.into) target = target.into;
  if (target && typeof target === "object") { tdb = target.db || dbName; target = target.coll; }
  if (typeof target !== "string") throw new MongoServerError(`${out.kind === "out" ? "$out" : "$merge"} needs a collection name`, 2, "BadValue");
  if (out.kind === "out") {
    const db = state.dbs.get(tdb);
    if (db) db.delete(target);
    const st = storeOf(tdb, target, true);
    for (const d of result) insertDoc(tdb, st, d);
  } else {
    const spec = typeof out.spec === "object" ? out.spec : {};
    const on = [].concat(spec.on || "_id");
    const whenMatched = spec.whenMatched || "merge", whenNotMatched = spec.whenNotMatched || "insert";
    const st = storeOf(tdb, target, true);
    for (const d of result) {
      const f = {};
      for (const k of on) f[k] = valuesAt(d, k)[0];
      const existing = st.docs.find((x) => query(tdb, f).test(x));
      if (existing) {
        if (whenMatched === "fail") throw new MongoServerError("$merge failed: a matching document already exists", 11000, "DuplicateKey");
        if (whenMatched === "keepExisting") continue;
        const merged = whenMatched === "replace" ? { _id: existing._id, ...d, _id: existing._id } : { ...existing, ...d, _id: existing._id };
        replaceDoc(tdb, st, existing, merged);
      } else if (whenNotMatched === "insert") insertDoc(tdb, st, d);
      else if (whenNotMatched === "fail") throw new MongoServerError("$merge could not find a matching document", 13113, "MergeStageNoMatchingDocument");
    }
  }
  markDirty();
}

// ------------------------------------------------------------------ writes
function insertDoc(dbName, st, doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new MongoshError("Document must be an object, for example { name: 'Asha' }");
  const d = clone(doc);
  const full = d._id === undefined ? { _id: new ObjectId(), ...d } : d;
  if (Array.isArray(full._id)) throw new MongoServerError("The '_id' value cannot be of type array", 53, "InvalidIdField");
  for (const k of Object.keys(full)) if (k.startsWith("$")) throw new MongoServerError(`Document can't have $ prefixed field names: ${k}`, 52, "DollarPrefixedFieldName");
  validateDoc(dbName, st, full);
  checkUnique(dbName, st, full, null);
  st.docs.push(full);
  indexDoc(st, full);
  markDirty();
  return full._id;
}
function replaceDoc(dbName, st, oldDoc, newDoc) {
  if (canon(oldDoc._id) !== canon(newDoc._id))
    throw new MongoServerError("Performing an update on the path '_id' would modify the immutable field '_id'", 66, "ImmutableField");
  validateDoc(dbName, st, newDoc);
  checkUnique(dbName, st, newDoc, oldDoc);
  unindexDoc(st, oldDoc);
  st.docs[st.docs.indexOf(oldDoc)] = newDoc;
  indexDoc(st, newDoc);
  markDirty();
}
const UPDATE_OPS = new Set(["$set", "$unset", "$inc", "$mul", "$rename", "$min", "$max", "$currentDate", "$setOnInsert",
  "$push", "$addToSet", "$pop", "$pull", "$pullAll", "$bit"]);
function checkUpdate(update, replacement) {
  if (Array.isArray(update)) { if (replacement) throw new MongoshError("Replacement document must not be an array"); return "pipeline"; }
  if (!update || typeof update !== "object") throw new MongoshError("Update document must be an object");
  const keys = Object.keys(update);
  const ops = keys.filter((k) => k.startsWith("$"));
  if (replacement) { if (ops.length) throw new MongoshError("Replacement document must not contain atomic operators"); return "replace"; }
  if (!keys.length) throw new MongoshError("Update document requires atomic operators");
  if (ops.length !== keys.length) throw new MongoshError("Update document requires atomic operators");
  for (const k of ops) if (!UPDATE_OPS.has(k)) {
    const s = didYouMean(k, [...UPDATE_OPS]);
    throw new MongoServerError(`Unknown modifier: ${k}. Expected a valid update modifier or pipeline-style update specified as an array${s ? ` (did you mean ${s}?)` : ""}`, 9, "FailedToParse");
  }
  return "ops";
}
// returns the updated copy of doc (doc itself is not changed)
function applyUpdate(dbName, doc, update, filter, opts, inserting) {
  const kind = Array.isArray(update) ? "pipeline" : Object.keys(update).some((k) => k.startsWith("$")) ? "ops" : "replace";
  if (kind === "replace") { const r = clone(update); delete r._id; return { _id: doc._id, ...r }; }
  if (kind === "pipeline") {
    const [r] = guard(() => new mingo.Aggregator(update, mingoOptions(dbName)).run([clone(doc)]));
    return clone(r);
  }
  const d = clone(doc);
  const ops = { ...update };
  const onInsert = ops.$setOnInsert;
  delete ops.$setOnInsert;
  if (ops.$currentDate) {
    ops.$set = { ...(ops.$set || {}) };
    for (const [k, v] of Object.entries(ops.$currentDate)) ops.$set[k] = new Date();
    delete ops.$currentDate;
  }
  if (Object.keys(ops).length)
    guard(() => mingo.update(d, clone(ops), opts.arrayFilters, filter, { cloneMode: "deep", queryOptions: mingoOptions(dbName) }));
  if (inserting && onInsert) for (const [k, v] of Object.entries(onInsert)) setPath(d, k, clone(v));
  return d;
}
function upsertBase(filter) {
  const base = {};
  const take = (f) => {
    for (const [k, v] of Object.entries(f || {})) {
      if (k === "$and" && Array.isArray(v)) v.forEach(take);
      else if (k.startsWith("$")) continue;
      else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId) && !(v instanceof RegExp)) {
        const ks = Object.keys(v);
        if (ks.length && ks.every((x) => x.startsWith("$"))) { if ("$eq" in v) setPath(base, k, clone(v.$eq)); }
        else setPath(base, k, clone(v));
      } else if (!(v instanceof RegExp)) setPath(base, k, clone(v));
    }
  };
  take(filter);
  return base;
}
function doUpdate(coll, filter, update, opts = {}, multi = false, replacement = false) {
  const dbName = coll._dbName;
  checkUpdate(update, replacement);
  filter = filter || {};
  const st = storeOf(dbName, coll._collName, !!opts.upsert);
  const q = query(dbName, filter);
  let matched = [];
  if (st) {
    if (!multi && opts.sort) matched = guard(() => q.find(st.docs).sort(opts.sort).limit(1).all());
    else for (const d of st.docs) { if (q.test(d)) { matched.push(d); if (!multi) break; } }
  }
  let modified = 0;
  for (const d of matched) {
    const nd = applyUpdate(dbName, d, update, filter, opts, false);
    if (canon(nd) !== canon(d)) { replaceDoc(dbName, st, d, nd); modified++; }
  }
  const res = { acknowledged: true, insertedId: null, matchedCount: matched.length, modifiedCount: modified, upsertedCount: 0 };
  if (!matched.length && opts.upsert) {
    let base = upsertBase(filter);
    if (base._id === undefined) base = { _id: new ObjectId(), ...base };
    const nd = applyUpdate(dbName, base, update, filter, opts, true);
    if (nd._id === undefined) nd._id = base._id;
    const id = insertDoc(dbName, st, nd);
    res.insertedId = id;
    res.upsertedCount = 1;
    res.upsertedId = id;
  }
  return res;
}
function doDelete(coll, filter, multi) {
  const st = storeOf(coll._dbName, coll._collName);
  if (!st) return { acknowledged: true, deletedCount: 0 };
  const q = query(coll._dbName, filter || {});
  const keep = [];
  let n = 0;
  for (const d of st.docs) {
    if ((multi || n === 0) && q.test(d)) { n++; unindexDoc(st, d); } else keep.push(d);
  }
  st.docs = keep;
  if (n) markDirty();
  return { acknowledged: true, deletedCount: n };
}

// ------------------------------------------------------------------ explain()
function boundsFor(cond) {
  const v2 = (v) => (typeof v === "string" ? JSON.stringify(v) : fmt(v).t);
  if (cond === undefined) return ["[MinKey, MaxKey]"];
  if (!cond || typeof cond !== "object" || Array.isArray(cond) || cond instanceof Date || cond instanceof ObjectId) return [`[${v2(cond)}, ${v2(cond)}]`];
  if (cond instanceof RegExp) return ["[\"\", {})", `[/${cond.source}/${cond.flags}, /${cond.source}/${cond.flags}]`];
  if ("$eq" in cond) return [`[${v2(cond.$eq)}, ${v2(cond.$eq)}]`];
  if (Array.isArray(cond.$in)) return cond.$in.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((x) => `[${v2(x)}, ${v2(x)}]`);
  let lo = "-inf.0", hi = "inf.0", lb = "[", hb = "]";
  if (typeof (cond.$gt ?? cond.$gte) === "string" || typeof (cond.$lt ?? cond.$lte) === "string") { lo = '""'; hi = "{}"; hb = ")"; }
  if ("$gt" in cond) { lo = v2(cond.$gt); lb = "("; }
  if ("$gte" in cond) { lo = v2(cond.$gte); lb = "["; }
  if ("$lt" in cond) { hi = v2(cond.$lt); hb = ")"; }
  if ("$lte" in cond) { hi = v2(cond.$lte); hb = "]"; }
  return [`${lb}${lo}, ${hi}${hb}`];
}
function parsedQuery(filter) {
  const parts = [];
  for (const [k, v] of Object.entries(filter || {})) {
    if (k.startsWith("$")) { parts.push({ [k]: v }); continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof ObjectId) && !(v instanceof RegExp) && Object.keys(v).every((x) => x.startsWith("$"))) {
      for (const [op, x] of Object.entries(v)) parts.push({ [k]: { [op]: x } });
    } else if (v instanceof RegExp) parts.push({ [k]: { $regex: v.source, ...(v.flags ? { $options: v.flags } : {}) } });
    else parts.push({ [k]: { $eq: v } });
  }
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
}
function explainFind(c, verbosity) {
  const t0 = performance.now();
  const st = storeOf(c._dbName, c._collName);
  const docs = st ? st.docs : [];
  const filter = extractText(c._filter || {}).filter || {};
  const fieldsInFilter = new Set(Object.keys(filter).filter((k) => !k.startsWith("$")));
  for (const a of filter.$and || []) for (const k of Object.keys(a || {})) if (!k.startsWith("$")) fieldsInFilter.add(k);
  const condOf = (f) => filter[f] !== undefined ? filter[f] : (filter.$and || []).map((a) => a && a[f]).find((x) => x !== undefined);
  const results = runFind(c);
  let plan, keys = 0, examined = docs.length, ixUsed = null;
  const hintName = c._hint && (typeof c._hint === "string" ? c._hint : st?.indexes.find((ix) => canon(ix.key) === canon(c._hint))?.name);
  const usable = (st ? st.indexes : []).filter((ix) => !isTextIx(ix) && (hintName ? ix.name === hintName : fieldsInFilter.has(Object.keys(ix.key)[0])));
  if (usable.length) {
    const scored = usable.map((ix) => {
      const prefix = [];
      for (const f of Object.keys(ix.key)) { if (fieldsInFilter.has(f)) prefix.push(f); else break; }
      const sub = {};
      for (const f of prefix) sub[f] = condOf(f);
      const n = prefix.length ? docs.filter((d) => query(c._dbName, sub).test(d)).length : docs.length;
      return { ix, prefix, n };
    }).sort((a, b) => b.prefix.length - a.prefix.length || a.n - b.n);
    const best = scored[0];
    ixUsed = best.ix;
    keys = best.n;
    examined = best.n;
    if (best.ix.name === "_id_" && Object.keys(filter).length === 1 && fieldsInFilter.has("_id") && !(condOf("_id") && typeof condOf("_id") === "object" && !(condOf("_id") instanceof ObjectId) && Object.keys(condOf("_id")).some((k) => k.startsWith("$") && k !== "$eq"))) {
      plan = { stage: "IDHACK" };
    } else {
      const indexBounds = {};
      for (const f of Object.keys(best.ix.key)) {
        let b = boundsFor(best.prefix.includes(f) ? condOf(f) : undefined);
        if (best.ix.key[f] === -1) b = b.map((x) => {
          const m = /^([\[(])(.*), (.*)([\])])$/.exec(x);
          return m ? `${m[4] === "]" ? "[" : "("}${m[3]}, ${m[2]}${m[1] === "[" ? "]" : ")"}` : x;
        }).reverse();
        indexBounds[f] = b;
      }
      plan = { stage: "FETCH", ...(Object.keys(filter).length > best.prefix.length ? { filter: parsedQuery(Object.fromEntries(Object.entries(filter).filter(([k]) => !best.prefix.includes(k)))) } : {}),
        inputStage: { stage: "IXSCAN", keyPattern: best.ix.key, indexName: best.ix.name, isMultiKey: false, isUnique: !!best.ix.unique || best.ix.name === "_id_",
          direction: "forward", indexBounds } };
    }
  } else {
    plan = { stage: "COLLSCAN", ...(Object.keys(filter).length ? { filter: parsedQuery(filter) } : {}), direction: "forward" };
  }
  if (c._sort && Object.keys(c._sort).length && !(ixUsed && Object.keys(c._sort)[0] === Object.keys(ixUsed.key)[0]))
    plan = { stage: "SORT", sortPattern: c._sort, memLimit: 104857600, type: "simple", inputStage: plan };
  if (c._skip) plan = { stage: "SKIP", skipAmount: c._skip, inputStage: plan };
  if (c._limit) plan = { stage: "LIMIT", limitAmount: Math.abs(c._limit), inputStage: plan };
  if (c._proj && Object.keys(c._proj).length) plan = { stage: "PROJECTION_SIMPLE", transformBy: c._proj, inputStage: plan };
  const out = {
    explainVersion: "1",
    queryPlanner: { namespace: `${c._dbName}.${c._collName}`, indexFilterSet: false, parsedQuery: parsedQuery(filter), maxIndexedOrSolutionsReached: false,
      winningPlan: plan, rejectedPlans: [] },
  };
  if (verbosity !== "queryPlanner") {
    out.executionStats = { executionSuccess: true, nReturned: results.length, executionTimeMillis: Math.round(performance.now() - t0),
      totalKeysExamined: plan.stage === "IDHACK" ? (results.length ? 1 : 0) : keys, totalDocsExamined: plan.stage === "IDHACK" ? results.length : examined };
  }
  out.command = { find: c._collName, filter: c._filter || {}, ...(c._proj ? { projection: c._proj } : {}), ...(c._sort ? { sort: c._sort } : {}), $db: c._dbName };
  out.ok = 1;
  return out;
}

// ------------------------------------------------------------------ Cursor
class Cursor {
  constructor(src) {
    this._kind = src.kind;
    this._dbName = src.db;
    this._collName = src.coll;
    this._filter = src.filter;
    this._proj = src.projection;
    this._pipeline = src.pipeline;
    this._array = src.array;
    this._sort = src.sort || null;
    this._skip = src.skip || 0;
    this._limit = src.limit || 0;
    this._hint = null;
    this._results = null;
    this._pos = 0;
    this._maps = [];
  }
  _exec() {
    if (this._results) return this._results;
    let r = this._kind === "find" ? runFind(this) : this._kind === "agg" ? runAggregate(this) : this._array.slice();
    for (const f of this._maps) r = r.map((x) => f(x));
    this._results = r;
    return r;
  }
  _mod(fn) { if (this._results) throw new MongoshError("Cursor already started: call sort/limit/skip before reading documents", "MongoshInvalidInputError"); fn(); return this; }
  sort(s) { return this._mod(() => { this._sort = s; }); }
  limit(n) { return this._mod(() => { this._limit = Number(n) || 0; }); }
  skip(n) { return this._mod(() => { this._skip = Number(n) || 0; }); }
  project(p) { return this._mod(() => { this._proj = p; }); }
  projection(p) { return this.project(p); }
  hint(h) { return this._mod(() => { this._hint = h; }); }
  batchSize() { return this; }
  collation() { return this; }
  comment() { return this; }
  maxTimeMS() { return this; }
  allowDiskUse() { return this; }
  noCursorTimeout() { return this; }
  readPref() { return this; }
  readConcern() { return this; }
  pretty() { return this; }
  min() { return this; }
  max() { return this; }
  returnKey() { return this; }
  showRecordId() { return this; }
  toArray() { const r = this._exec(); const out = r.slice(this._pos); this._pos = r.length; return out; }
  forEach(fn) { const r = this._exec(); while (this._pos < r.length) { const d = r[this._pos++]; if (fn(d) === false) break; } }
  map(fn) { const c = new Cursor({ kind: "array", array: this.toArray() }); c._maps.push(fn); return c; }
  hasNext() { return this._pos < this._exec().length; }
  tryNext() { return this.hasNext() ? this.next() : null; }
  next() { const r = this._exec(); return this._pos < r.length ? r[this._pos++] : null; }
  isExhausted() { return !this.hasNext(); }
  isClosed() { return !this.hasNext(); }
  close() { this._pos = this._exec().length; }
  objsLeftInBatch() { return Math.min(BATCH, this._exec().length - this._pos); }
  itcount() { const n = this._exec().length - this._pos; this._pos = this._exec().length; return n; }
  size() { return this._exec().length; }
  count(applySkipLimit) {
    if (this._kind !== "find") return this._exec().length;
    const c = new Cursor({ kind: "find", db: this._dbName, coll: this._collName, filter: this._filter });
    if (applySkipLimit) { c._skip = this._skip; c._limit = this._limit; }
    return runFind(c).length;
  }
  explain(verbosity = "queryPlanner") {
    if (verbosity === true) verbosity = "allPlansExecution";
    if (this._kind === "find") return explainFind(this, verbosity);
    if (this._kind === "agg") {
      const first = this._pipeline[0] && this._pipeline[0].$match;
      const fc = new Cursor({ kind: "find", db: this._dbName, coll: this._collName, filter: first || {} });
      const inner = explainFind(fc, verbosity);
      return { explainVersion: "1", stages: [{ $cursor: { queryPlanner: inner.queryPlanner, ...(inner.executionStats ? { executionStats: inner.executionStats } : {}) } },
        ...this._pipeline.slice(first ? 1 : 0).map((s) => ({ [Object.keys(s)[0]]: s[Object.keys(s)[0]] }))], ok: 1 };
    }
    return { ok: 1 };
  }
  [Symbol.iterator]() { const self = this; return { next() { return self.hasNext() ? { value: self.next(), done: false } : { value: undefined, done: true }; } }; }
  toString() { return "Cursor"; }
}

// ------------------------------------------------------------------ Collection
const IS_DB = Symbol("db");
let warned = new Set();
const deprecated = (what, use) => {
  if (warned.has(what)) return;
  warned.add(what);
  emit({ kind: "warn", text: `DeprecationWarning: ${what} is deprecated. Use ${use}.` });
};

class Collection {
  constructor(dbName, name) { this._dbName = dbName; this._collName = name; }
  getName() { return this._collName; }
  getFullName() { return `${this._dbName}.${this._collName}`; }
  getDB() { return dbProxy(this._dbName); }
  toString() { return this.getFullName(); }
  exists() { const st = storeOf(this._dbName, this._collName); return st ? { name: st.name, type: "collection", options: st.options || {} } : null; }

  // ---- create
  insertOne(doc) {
    const st = storeOf(this._dbName, this._collName, true);
    return { acknowledged: true, insertedId: insertDoc(this._dbName, st, doc) };
  }
  insertMany(docs, opts = {}) {
    if (!Array.isArray(docs)) throw new MongoshError("insertMany needs an array of documents: insertMany([ {...}, {...} ])");
    const st = storeOf(this._dbName, this._collName, true);
    const insertedIds = {};
    const errors = [];
    docs.forEach((d, i) => {
      if (errors.length && opts.ordered !== false) return;
      try { insertedIds[i] = insertDoc(this._dbName, st, d); }
      catch (e) { errors.push({ index: i, error: e }); }
    });
    if (errors.length) {
      const n = Object.keys(insertedIds).length;
      const e = new MongoBulkWriteError(errors[0].error.message, { insertedCount: n, insertedIds }, errors[0].error.code);
      e.extra = `${plural(n, "document")} inserted before the error` + (errors.length > 1 ? `; ${errors.length} documents failed` : "");
      throw e;
    }
    return { acknowledged: true, insertedIds };
  }
  insert(docs) {
    deprecated("Collection.insert()", "insertOne, insertMany, or bulkWrite");
    return Array.isArray(docs) ? this.insertMany(docs) : { acknowledged: true, insertedIds: { 0: this.insertOne(docs).insertedId } };
  }
  save(doc) {
    deprecated("Collection.save()", "insertOne, insertMany, updateOne, or updateMany");
    if (doc && doc._id !== undefined) return this.replaceOne({ _id: doc._id }, doc, { upsert: true });
    return this.insertOne(doc);
  }

  // ---- read
  find(filter = {}, projection, options = {}) {
    if (filter !== null && typeof filter !== "object") throw new MongoshError("find() needs a filter document, for example find({ name: 'Asha' })");
    const c = new Cursor({ kind: "find", db: this._dbName, coll: this._collName, filter: filter || {}, projection: projection || options.projection,
      sort: options.sort, skip: options.skip, limit: options.limit });
    return c;
  }
  findOne(filter = {}, projection, options = {}) {
    const r = this.find(filter, projection, options).limit(1).toArray();
    return r.length ? r[0] : null;
  }
  countDocuments(filter = {}, opts = {}) {
    const c = this.find(filter);
    c._skip = opts.skip || 0;
    c._limit = opts.limit || 0;
    return runFind(c).length;
  }
  estimatedDocumentCount() { return storeOf(this._dbName, this._collName)?.docs.length || 0; }
  count(filter = {}, opts) { deprecated("Collection.count()", "countDocuments or estimatedDocumentCount"); return this.countDocuments(filter, opts); }
  distinct(field, filter = {}) {
    if (typeof field !== "string") throw new MongoshError("distinct() needs a field name, for example distinct('dept')");
    const st = storeOf(this._dbName, this._collName);
    const seen = new Map();
    if (st) {
      const q = query(this._dbName, filter);
      for (const d of st.docs) if (q.test(d)) for (const v of valuesAt(d, field)) if (v !== undefined) seen.set(canon(v), v);
    }
    return guard(() => new mingo.Query({}, {}).find([...seen.values()].map((v) => ({ v }))).sort({ v: 1 }).all().map((x) => clone(x.v)));
  }
  aggregate(pipeline, ...rest) {
    if (!Array.isArray(pipeline)) pipeline = [pipeline, ...rest.filter((x) => x && typeof x === "object" && Object.keys(x).length === 1 && Object.keys(x)[0].startsWith("$"))];
    const c = new Cursor({ kind: "agg", db: this._dbName, coll: this._collName, pipeline });
    if (pipeline.length && (pipeline.at(-1).$out !== undefined || pipeline.at(-1).$merge !== undefined)) { c._exec(); }
    return c;
  }

  // ---- update
  updateOne(filter, update, opts = {}) { return doUpdate(this, filter, update, opts, false); }
  updateMany(filter, update, opts = {}) { return doUpdate(this, filter, update, opts, true); }
  replaceOne(filter, doc, opts = {}) { return doUpdate(this, filter, doc, opts, false, true); }
  update(filter, update, opts = {}) {
    deprecated("Collection.update()", "updateOne, updateMany, or bulkWrite");
    const isReplace = update && !Array.isArray(update) && !Object.keys(update).some((k) => k.startsWith("$"));
    return isReplace ? this.replaceOne(filter, update, opts) : doUpdate(this, filter, update, opts, !!opts.multi);
  }
  findOneAndUpdate(filter, update, opts = {}) { return this._findAnd(filter, opts, (d) => doUpdate(this, d ? { _id: d._id } : filter, update, opts, false)); }
  findOneAndReplace(filter, doc, opts = {}) { return this._findAnd(filter, opts, (d) => doUpdate(this, d ? { _id: d._id } : filter, doc, opts, false, true)); }
  findOneAndDelete(filter, opts = {}) {
    const [d] = this.find(filter, undefined, { sort: opts.sort }).limit(1).toArray();
    if (!d) return null;
    doDelete(this, { _id: d._id }, false);
    return opts.projection ? query(this._dbName, {}).find([d], opts.projection).all()[0] : d;
  }
  _findAnd(filter, opts, write) {
    const [before] = this.find(filter, undefined, { sort: opts.sort }).limit(1).toArray();
    const res = write(before);
    const after = opts.returnDocument === "after" || opts.returnNewDocument === true;
    let doc = before || null;
    if (after) {
      const id = before ? before._id : res.upsertedId;
      doc = id === undefined || id === null ? null : this.findOne({ _id: id });
    }
    if (doc && opts.projection) doc = query(this._dbName, {}).find([doc], opts.projection).all()[0];
    return doc;
  }

  // ---- delete
  deleteOne(filter = {}) { return doDelete(this, filter, false); }
  deleteMany(filter = {}) {
    if (filter === undefined) throw new MongoshError("deleteMany() needs a filter; use deleteMany({}) to delete every document");
    return doDelete(this, filter, true);
  }
  remove(filter = {}, justOne) {
    deprecated("Collection.remove()", "deleteOne, deleteMany, findOneAndDelete, or bulkWrite");
    const one = justOne === true || (justOne && justOne.justOne);
    return doDelete(this, filter, !one);
  }

  bulkWrite(ops, opts = {}) {
    if (!Array.isArray(ops)) throw new MongoshError("bulkWrite needs an array of operations");
    const r = { acknowledged: true, insertedCount: 0, insertedIds: {}, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, upsertedIds: {} };
    ops.forEach((op, i) => {
      const [kind] = Object.keys(op);
      const a = op[kind];
      try {
        if (kind === "insertOne") { r.insertedIds[i] = this.insertOne(a.document).insertedId; r.insertedCount++; }
        else if (kind === "updateOne" || kind === "updateMany" || kind === "replaceOne") {
          const x = kind === "replaceOne" ? this.replaceOne(a.filter, a.replacement, a) : this[kind](a.filter, a.update, a);
          r.matchedCount += x.matchedCount; r.modifiedCount += x.modifiedCount;
          if (x.upsertedCount) { r.upsertedCount++; r.upsertedIds[i] = x.upsertedId; }
        } else if (kind === "deleteOne" || kind === "deleteMany") r.deletedCount += this[kind](a.filter).deletedCount;
        else throw new MongoshError(`Unknown bulkWrite operation: ${kind}`);
      } catch (e) {
        if (opts.ordered !== false) throw new MongoBulkWriteError(e.message, r, e.code);
      }
    });
    return r;
  }

  // ---- indexes
  createIndex(keys, options = {}) {
    if (!keys || typeof keys !== "object" || !Object.keys(keys).length) throw new MongoshError("createIndex needs a key pattern, for example createIndex({ rollno: 1 })");
    for (const [k, v] of Object.entries(keys))
      if (![1, -1, "text", "hashed", "2dsphere", "2d"].includes(v)) throw new MongoServerError(`Values in the index key pattern can contain only 1, -1, "text", "hashed" or "2dsphere"; got ${k}: ${fmt(v).t}`, 67, "CannotCreateIndex");
    const st = storeOf(this._dbName, this._collName, true);
    const name = options.name || Object.entries(keys).map(([k, v]) => `${k}_${v}`).join("_");
    const same = st.indexes.find((ix) => canon(ix.key) === canon(keys));
    if (same) {
      if (!!same.unique !== !!options.unique || (options.name && options.name !== same.name))
        throw new MongoServerError(`An equivalent index already exists with the same name but different options. Requested index: ${fmt({ v: 2, key: keys, name, ...options }).t}, existing index: ${fmt(publicIndex(same)).t}`, 85, "IndexOptionsConflict");
      return same.name;
    }
    if (st.indexes.some((ix) => ix.name === name)) throw new MongoServerError(`An existing index has the same name as the requested index: ${name}`, 86, "IndexKeySpecsConflict");
    if (Object.values(keys).includes("text") && st.indexes.some(isTextIx))
      throw new MongoServerError(`An equivalent index already exists with a different name and options. Only one text index is allowed per collection`, 85, "IndexOptionsConflict");
    const ix = { v: 2, key: { ...keys }, name };
    for (const o of ["unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "weights", "default_language", "hidden"]) if (options[o] !== undefined) ix[o] = clone(options[o]);
    if (ix.unique) {
      const m = new Map();
      for (const d of st.docs) for (const k of indexKeys(ix, d)) { if (m.has(k)) throw dupError(this._dbName, st, ix, d); m.set(k, d); }
      st.uniq.set(name, m);
    }
    st.indexes.push(ix);
    if (ix.expireAfterSeconds !== undefined) emit({ kind: "info", text: "Note: TTL indexes are recorded, but documents are not deleted automatically in this lab." });
    markDirty();
    return name;
  }
  ensureIndex(keys, options) { deprecated("Collection.ensureIndex()", "createIndex"); return this.createIndex(keys, options); }
  createIndexes(list, options = {}) { return list.map((k) => this.createIndex(k, options)); }
  getIndexes() { const st = storeOf(this._dbName, this._collName); if (!st) throw new MongoServerError(`ns does not exist: ${this.getFullName()}`, 26, "NamespaceNotFound"); return st.indexes.map(publicIndex); }
  getIndices() { return this.getIndexes(); }
  getIndexKeys() { return this.getIndexes().map((ix) => ix.key); }
  dropIndex(spec) {
    const st = storeOf(this._dbName, this._collName);
    if (!st) throw new MongoServerError(`ns not found ${this.getFullName()}`, 26, "NamespaceNotFound");
    const ix = typeof spec === "string" ? st.indexes.find((i) => i.name === spec) : st.indexes.find((i) => canon(i.key) === canon(spec));
    if (!ix) throw new MongoServerError(`index not found with name [${typeof spec === "string" ? spec : fmt(spec).t}]`, 27, "IndexNotFound");
    if (ix.name === "_id_") throw new MongoServerError("cannot drop _id index", 72, "InvalidOptions");
    const was = st.indexes.length;
    st.indexes = st.indexes.filter((i) => i !== ix);
    st.uniq.delete(ix.name);
    markDirty();
    return { nIndexesWas: was, ok: 1 };
  }
  dropIndexes(spec) {
    if (spec !== undefined && spec !== "*") return [].concat(spec).map((s) => this.dropIndex(s)).at(-1);
    const st = storeOf(this._dbName, this._collName);
    if (!st) throw new MongoServerError(`ns not found ${this.getFullName()}`, 26, "NamespaceNotFound");
    const was = st.indexes.length;
    st.indexes = st.indexes.filter((i) => i.name === "_id_");
    rebuildUnique(st);
    markDirty();
    return { nIndexesWas: was, msg: "non-_id indexes dropped for collection", ok: 1 };
  }
  reIndex() { return { ok: 1 }; }

  // ---- collection
  drop() {
    const db = state.dbs.get(this._dbName);
    const had = !!(db && db.delete(this._collName));
    if (db && !db.size) state.dbs.delete(this._dbName);
    if (had) markDirty();
    return had;
  }
  renameCollection(newName, dropTarget = false) {
    checkCollName(newName);
    const db = state.dbs.get(this._dbName);
    const st = db && db.get(this._collName);
    if (!st) throw new MongoServerError("source namespace does not exist", 26, "NamespaceNotFound");
    if (db.has(newName)) { if (!dropTarget) throw new MongoServerError("target namespace exists", 48, "NamespaceExists"); db.delete(newName); }
    db.delete(this._collName);
    st.name = newName;
    db.set(newName, st);
    markDirty();
    return { ok: 1 };
  }
  stats() {
    const st = storeOf(this._dbName, this._collName);
    if (!st) throw new MongoServerError(`Collection [${this.getFullName()}] not found.`, 26, "NamespaceNotFound");
    const size = sizeOf(st.docs);
    return { ns: this.getFullName(), size, count: st.docs.length, avgObjSize: st.docs.length ? Math.round(size / st.docs.length) : 0,
      storageSize: Math.max(4096, Math.ceil(size / 4096) * 4096), nindexes: st.indexes.length,
      indexSizes: Object.fromEntries(st.indexes.map((ix) => [ix.name, 4096 + st.docs.length * 16])), ok: 1 };
  }
  dataSize() { return this.stats().size; }
  storageSize() { return this.stats().storageSize; }
  totalIndexSize() { return Object.values(this.stats().indexSizes).reduce((a, b) => a + b, 0); }
  isCapped() { return false; }
  validate() { return { ns: this.getFullName(), nrecords: this.estimatedDocumentCount(), valid: true, ok: 1 }; }

  mapReduce(map, reduce, options = {}) {
    if (typeof map !== "function" || typeof reduce !== "function") throw new MongoshError("mapReduce needs a map function and a reduce function");
    deprecated("Collection.mapReduce()", "an aggregation instead");
    if (typeof options === "string") options = { out: options };
    const docs = this.find(options.query || {}, undefined, { sort: options.sort, limit: options.limit }).toArray();
    const groups = new Map();
    const scope = options.scope || {};
    const prevEmit = currentEmit;
    currentEmit = (k, v) => {
      const key = canon(k);
      if (!groups.has(key)) groups.set(key, { key: clone(k), values: [] });
      groups.get(key).values.push(clone(v));
    };
    try {
      for (const d of docs) map.call(Object.assign(d, {}), scope);
    } finally { currentEmit = prevEmit; }
    let results = [...groups.values()].map(({ key, values }) => {
      let value = values.length === 1 ? values[0] : reduce(key, values);
      if (options.finalize) value = options.finalize(key, value);
      return { _id: key, value };
    });
    results = guard(() => new mingo.Query({}, {}).find(results).sort({ _id: 1 }).all());
    const out = options.out;
    if (!out || (typeof out === "object" && out.inline)) return { results, ok: 1 };
    let target = typeof out === "string" ? out : out.replace || out.merge || out.reduce;
    const tdb = (typeof out === "object" && out.db) || this._dbName;
    if (typeof target !== "string") throw new MongoshError("mapReduce out must be a collection name or { inline: 1 }");
    if (typeof out === "string" || out.replace) { const db = state.dbs.get(tdb); if (db) db.delete(target); }
    const st = storeOf(tdb, target, true);
    for (const r of results) {
      const existing = st.docs.find((d) => canon(d._id) === canon(r._id));
      if (existing && out.reduce) replaceDoc(tdb, st, existing, { _id: r._id, value: reduce(r._id, [existing.value, r.value]) });
      else if (existing) replaceDoc(tdb, st, existing, r);
      else insertDoc(tdb, st, r);
    }
    return { result: target, ok: 1 };
  }

  explain(verbosity = "queryPlanner") {
    const self = this;
    return {
      find: (f, p) => { const c = self.find(f, p); return { ...c, explain: () => c.explain(verbosity), sort(s) { c.sort(s); return this; }, limit(n) { c.limit(n); return this; }, skip(n) { c.skip(n); return this; }, toString() { return "Explainable"; }, __explain: () => c.explain(verbosity) }; },
      aggregate: (p) => self.aggregate(p).explain(verbosity),
      count: (f) => explainFind(self.find(f), verbosity),
    };
  }
  watch() { throw notAvailable("Change streams (watch)"); }
  getShardDistribution() { throw notAvailable("Sharding"); }
  help() { return new ShellText(HELP_COLL); }
}
const publicIndex = (ix) => { const o = { v: ix.v, key: ix.key, name: ix.name }; for (const k of ["unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "weights", "default_language", "hidden"]) if (ix[k] !== undefined) o[k] = ix[k]; return o; };
const sizeOf = (docs) => docs.reduce((n, d) => n + JSON.stringify(toEJ(d)).length, 0);

const collMethods = new Set(Object.getOwnPropertyNames(Collection.prototype).filter((k) => !k.startsWith("_") && k !== "constructor"));
function collProxy(dbName, name) {
  return new Proxy(new Collection(dbName, name), {
    get(t, k) {
      if (typeof k === "symbol" || k in t) return t[k];
      if (k === "then" || k === "toJSON" || k === "inspect" || k.startsWith("_")) return undefined;
      return collProxy(dbName, `${name}.${k}`);
    },
  });
}

// ------------------------------------------------------------------ Database
class Database {
  constructor(name) { this._name = name; }
  get [IS_DB]() { return true; }
  getName() { return this._name; }
  toString() { return this._name; }
  getCollection(n) { if (typeof n !== "string" || !n) throw new MongoshError("getCollection needs a collection name"); return collProxy(this._name, n); }
  getCollectionNames() { return [...(state.dbs.get(this._name)?.keys() || [])].sort(); }
  getCollectionInfos(filter = {}) {
    const infos = this.getCollectionNames().map((n) => ({ name: n, type: "collection", options: clone(state.dbs.get(this._name).get(n).options || {}), info: { readOnly: false } }));
    return guard(() => query(this._name, filter).find(infos).all());
  }
  createCollection(name, options = {}) {
    checkCollName(name);
    if (state.dbs.get(this._name)?.has(name)) throw new MongoServerError(`Collection ${this._name}.${name} already exists.`, 48, "NamespaceExists");
    const st = storeOf(this._name, name, true);
    const o = {};
    for (const k of ["validator", "validationLevel", "validationAction", "capped", "size", "max"]) if (options[k] !== undefined) o[k] = clone(options[k]);
    if (o.validator) guard(() => query(this._name, o.validator));
    st.options = o;
    if (o.capped) emit({ kind: "info", text: "Note: capped collections are created as ordinary collections in this lab." });
    markDirty();
    return { ok: 1 };
  }
  dropDatabase() { if (state.dbs.delete(this._name)) markDirty(); return { ok: 1, dropped: this._name }; }
  getSiblingDB(n) { checkDbName(n); return dbProxy(n); }
  stats(scale = 1) {
    const db = state.dbs.get(this._name) || new Map();
    let objects = 0, dataSize = 0, indexes = 0;
    for (const st of db.values()) { objects += st.docs.length; dataSize += sizeOf(st.docs); indexes += st.indexes.length; }
    const s = typeof scale === "object" ? scale.scale || 1 : scale;
    return { db: this._name, collections: db.size, views: 0, objects, avgObjSize: objects ? Math.round(dataSize / objects) : 0,
      dataSize: dataSize / s, storageSize: Math.ceil(dataSize / 4096) * 4096 / s, indexes, indexSize: indexes * 4096 / s,
      totalSize: (Math.ceil(dataSize / 4096) * 4096 + indexes * 4096) / s, scaleFactor: s, ok: 1 };
  }
  version() { return SERVER_VERSION; }
  runCommand(cmd) {
    if (typeof cmd === "string") cmd = { [cmd]: 1 };
    const [k] = Object.keys(cmd || {});
    switch (k) {
      case "ping": return { ok: 1 };
      case "buildInfo": case "buildinfo": return { version: SERVER_VERSION, gitVersion: "foct-browser-lab", modules: [], ok: 1 };
      case "hello": case "isMaster": case "ismaster": return { isWritablePrimary: true, ismaster: true, maxBsonObjectSize: 16777216, ok: 1 };
      case "create": return this.createCollection(cmd.create, cmd);
      case "drop": return { ok: this.getCollection(cmd.drop).drop() ? 1 : 0 };
      case "dropDatabase": return this.dropDatabase();
      case "count": return { n: this.getCollection(cmd.count).countDocuments(cmd.query || {}), ok: 1 };
      case "listCollections": return { cursor: { firstBatch: this.getCollectionInfos(cmd.filter || {}), ns: `${this._name}.$cmd.listCollections` }, ok: 1 };
      case "collMod": {
        const st = storeOf(this._name, cmd.collMod);
        if (!st) throw new MongoServerError(`ns does not exist: ${this._name}.${cmd.collMod}`, 26, "NamespaceNotFound");
        for (const o of ["validator", "validationLevel", "validationAction"]) if (cmd[o] !== undefined) st.options[o] = clone(cmd[o]);
        markDirty();
        return { ok: 1 };
      }
      case "dbStats": return this.stats();
      case "collStats": return this.getCollection(cmd.collStats).stats();
      case "listDatabases": return listDatabases();
      case "serverStatus": case "replSetGetStatus": case "createUser": case "usersInfo": case "shardCollection": throw notAvailable(k);
    }
    throw new MongoServerError(`no such command: '${k}'`, 59, "CommandNotFound");
  }
  adminCommand(cmd) { return this.runCommand(cmd); }
  getUsers() { throw notAvailable("User management"); }
  createUser() { throw notAvailable("User management"); }
  dropUser() { throw notAvailable("User management"); }
  auth() { throw notAvailable("Authentication"); }
  serverStatus() { throw notAvailable("serverStatus"); }
  currentOp() { throw notAvailable("currentOp"); }
  hostInfo() { throw notAvailable("hostInfo"); }
  hello() { return this.runCommand("hello"); }
  isMaster() { return this.runCommand("hello"); }
  getMongo() { return { getDBNames: () => listDatabases().databases.map((d) => d.name), getDB: (n) => dbProxy(n), toString: () => "mongodb://browser-lab" }; }
  printCollectionStats() { for (const n of this.getCollectionNames()) { emit({ kind: "print", text: n }); emit({ kind: "val", ...fmt(this.getCollection(n).stats()) }); } }
  watch() { throw notAvailable("Change streams (watch)"); }
  help() { return new ShellText(HELP_DB); }
}
const dbMethods = new Set(Object.getOwnPropertyNames(Database.prototype).filter((k) => !k.startsWith("_") && k !== "constructor"));
function dbProxy(name) {
  return new Proxy(new Database(name), {
    get(t, k) {
      if (typeof k === "symbol" || k in t) return t[k];
      if (k === "then" || k === "toJSON" || k === "inspect" || k.startsWith("_")) return undefined;
      return collProxy(name, k);
    },
  });
}
function listDatabases() {
  const databases = [...state.dbs.entries()].filter(([, colls]) => colls.size).map(([name, colls]) => {
    let size = 0;
    for (const st of colls.values()) size += sizeOf(st.docs) + st.indexes.length * 4096;
    return { name, sizeOnDisk: Math.max(8192, Math.ceil(size / 4096) * 4096), empty: false };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { databases, totalSize: databases.reduce((s, d) => s + d.sizeOnDisk, 0), ok: 1 };
}

// ------------------------------------------------------------------ mongosh-style printing
class ShellText { constructor(s) { this.s = s; } toString() { return this.s; } }
const escH = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const S = (kind, text) => ({ t: text, h: kind ? `<span class="t-${kind}">${escH(text)}</span>` : escH(text) });
const cat = (...ps) => ({ t: ps.map((p) => (typeof p === "string" ? p : p.t)).join(""), h: ps.map((p) => (typeof p === "string" ? escH(p) : p.h)).join("") });
const joinF = (items, sep) => items.reduce((acc, it, i) => (i ? cat(acc, sep, it) : it), S("", ""));
const quote = (s) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + "'";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function fmt(v, indent = 0, seen = []) {
  if (v === null) return S("null", "null");
  switch (typeof v) {
    case "undefined": return S("null", "undefined");
    case "string": return S("str", quote(v));
    case "number": return S("num", Object.is(v, -0) ? "-0" : String(v));
    case "bigint": return S("num", v + "n");
    case "boolean": return S("bool", String(v));
    case "symbol": return S("", String(v));
    case "function": return S("fn", v.name ? `[Function: ${v.name}]` : "[Function (anonymous)]");
  }
  if (v instanceof ObjectId) return cat(S("type", "ObjectId("), S("str", quote(v.$oid)), S("type", ")"));
  if (v instanceof Date) return isNaN(v) ? S("type", "Invalid Date") : cat(S("type", "ISODate("), S("str", quote(v.toISOString())), S("type", ")"));
  if (v instanceof RegExp) return S("re", String(v));
  if (v[IS_DB]) return S("", v.getName());
  if (v instanceof Collection) return S("", v.getFullName());
  if (v instanceof Cursor) return S("type", "Cursor");
  if (v instanceof ShellText) return S("", v.s);
  if (v instanceof Error) return S("err", `${v.name}: ${v.message}`);
  if (v instanceof Map) v = Object.fromEntries([...v].map(([k, x]) => [String(k), x]));
  if (v instanceof Set) v = [...v];
  if (seen.includes(v)) return S("type", "[Circular]");
  if (seen.length > 30) return S("type", Array.isArray(v) ? "[Array]" : "[Object]");
  seen.push(v);
  let open, close, items;
  if (Array.isArray(v)) {
    open = "["; close = "]";
    items = v.slice(0, 100).map((x) => fmt(x, indent + 2, seen));
    if (v.length > 100) items.push(S("type", `... ${plural(v.length - 100, "more item")}`));
  } else {
    open = "{"; close = "}";
    const name = v.constructor && v.constructor !== Object && v.constructor.name;
    if (name && name !== "Object") open = name + " {";
    items = Object.keys(v).filter((k) => typeof v[k] !== "function").map((k) => cat(S("key", IDENT.test(k) ? k : quote(k)), ": ", fmt(v[k], indent + 2, seen)));
  }
  seen.pop();
  if (!items.length) return S("", open === "[" ? "[]" : open === "{" ? "{}" : open + "}");
  const single = cat(open, " ", joinF(items, ", "), " ", close);
  if (single.t.length + indent <= 72 && !single.t.includes("\n")) return single;
  const pad = " ".repeat(indent + 2);
  return cat(open, "\n", joinF(items.map((it) => cat(pad, it)), ",\n"), "\n", " ".repeat(indent), close);
}
const printable = (v) => (typeof v === "string" ? v : fmt(v).t);

// ------------------------------------------------------------------ Extended JSON (mongoexport format)
function toEJ(v) {
  if (v === null || typeof v !== "object") return typeof v === "number" && !Number.isFinite(v) ? { $numberDouble: String(v) } : v;
  if (v instanceof ObjectId) return { $oid: v.$oid };
  if (v instanceof Date) return { $date: isNaN(v) ? null : v.toISOString() };
  if (v instanceof RegExp) return { $regularExpression: { pattern: v.source, options: v.flags } };
  if (Array.isArray(v)) return v.map(toEJ);
  const o = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined && typeof v[k] !== "function") o[k] = toEJ(v[k]);
  return o;
}
function fromEJ(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(fromEJ);
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const [k] = keys, x = v[k];
    if (k === "$oid" && typeof x === "string") return new ObjectId(x);
    if (k === "$date") return new Date(x && typeof x === "object" ? Number(x.$numberLong) : x);
    if (k === "$numberInt" || k === "$numberLong" || k === "$numberDouble" || k === "$numberDecimal") return Number(x);
    if (k === "$regularExpression" && x && typeof x === "object") return new RegExp(x.pattern, x.options || "");
  }
  const o = {};
  for (const k of keys) o[k] = fromEJ(v[k]);
  return o;
}

// ------------------------------------------------------------------ the shell
let runInfo = { id: 0, errors: 0, count: 0, truncated: false };
let outBuf = [], lastFlush = 0;
let stmts = [];
let lastCursor = null;
let currentEmit = null;
function emit(item) {
  if (runInfo.truncated) return;
  if (++runInfo.count > 5000) {
    runInfo.truncated = true;
    outBuf.push({ kind: "info", text: "Output limit reached (5000 results): the rest of the output is not shown." });
    flush();
    return;
  }
  outBuf.push(item);
  if (outBuf.length >= 200 || performance.now() - lastFlush > 120) flush();
}
function flush() {
  if (outBuf.length) postMessage({ type: "out", id: runInfo.id, items: outBuf });
  outBuf = [];
  lastFlush = performance.now();
}

function showCursor(c) {
  const all = c._exec();
  const batch = all.slice(c._pos, c._pos + BATCH);
  c._pos += batch.length;
  lastCursor = c;
  if (!batch.length) { emit({ kind: "dim", text: c._kind === "find" && all.length === 0 ? "(no matching documents)" : "(no more documents)" }); return; }
  emit({ kind: "val", ...fmt(batch) });
  if (c._pos < all.length) emit({ kind: "dim", text: `Type "it" for more (${all.length - c._pos} more)` });
}
function shellCmd(cmd, arg) {
  switch (cmd) {
    case "use":
      checkDbName(arg);
      state.current = arg;
      self.db = dbProxy(arg);
      markDirty();
      return new ShellText(`switched to db ${arg}`);
    case "show dbs": {
      const { databases } = listDatabases();
      if (!databases.length) return new ShellText("(no databases yet: they appear after you insert data)");
      const w = Math.max(...databases.map((d) => d.name.length));
      return new ShellText(databases.map((d) => `${d.name.padEnd(w + 2)}${(d.sizeOnDisk / 1024).toFixed(2).padStart(7)} KiB`).join("\n"));
    }
    case "show collections": {
      const names = self.db.getCollectionNames();
      return new ShellText(names.length ? names.join("\n") : `(no collections in ${state.current} yet)`);
    }
    case "show":
      if (/^(users|roles|profile|log|logs|startupWarnings)$/i.test(arg)) throw notAvailable(`show ${arg}`);
      throw new MongoshError(`'${arg}' is not a valid argument for "show". Try: show dbs, show collections`);
    case "it":
      if (!lastCursor || !lastCursor.hasNext()) return new ShellText("no cursor");
      showCursor(lastCursor);
      return undefined;
    case "exit": return new ShellText("(exit has no effect here: just close the tab, or keep working)");
    case "cls": emit({ kind: "cls" }); return undefined;
    case "help": return new ShellText(HELP);
  }
}
const SHELL_LINES = [
  [/^\s*use\s+([^\s;]+)\s*;?\s*(\/\/.*)?$/, (m) => `__shell("use", ${JSON.stringify(m[1])});`],
  [/^\s*show\s+(dbs|databases)\s*;?\s*(\/\/.*)?$/i, () => `__shell("show dbs");`],
  [/^\s*show\s+(collections|tables)\s*;?\s*(\/\/.*)?$/i, () => `__shell("show collections");`],
  [/^\s*show\s+(\w+)\s*;?\s*(\/\/.*)?$/i, (m) => `__shell("show", ${JSON.stringify(m[1])});`],
  [/^\s*it\s*;?\s*$/, () => `__shell("it");`],
  [/^\s*(exit|quit)\s*(\(\s*\))?\s*;?\s*$/, () => `__shell("exit");`],
  [/^\s*cls\s*;?\s*$/, () => `__shell("cls");`],
  [/^\s*help\s*;?\s*$/, () => `__shell("help");`],
];
function preprocess(code) {
  return code.split("\n").map((line) => {
    for (const [re, f] of SHELL_LINES) { const m = re.exec(line); if (m) return f(m); }
    return line;
  }).join("\n");
}
function collectNames(p, out) {
  if (!p) return out;
  switch (p.type) {
    case "Identifier": out.push(p.name); break;
    case "ObjectPattern": for (const pr of p.properties) collectNames(pr.type === "RestElement" ? pr.argument : pr.value, out); break;
    case "ArrayPattern": for (const el of p.elements) collectNames(el, out); break;
    case "AssignmentPattern": collectNames(p.left, out); break;
    case "RestElement": collectNames(p.argument, out); break;
  }
  return out;
}
function transform(src, original) {
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, locations: true });
  const list = [];
  let hoisted = "", out = "", pos = 0;
  const origLines = original.split("\n");
  for (const st of ast.body) {
    out += src.slice(pos, st.start);
    pos = st.end;
    const raw = src.slice(st.start, st.end);
    const text = raw.includes("__shell(") ? origLines.slice(st.loc.start.line - 1, st.loc.end.line).join("\n").trim() : raw.trim();
    const i = list.push({ line: st.loc.start.line, text }) - 1;
    const body = src.slice(st.start, st.end);
    switch (st.type) {
      case "EmptyStatement": break;
      case "ExpressionStatement":
        if (st.directive) { out += body; break; }
        out += `__s(${i}); try { __r(${i}, (${src.slice(st.expression.start, st.expression.end)})); } catch (__e) { __x(${i}, __e); }`;
        break;
      case "VariableDeclaration": {
        const names = [], parts = [];
        for (const d of st.declarations) {
          collectNames(d.id, names);
          if (d.init) parts.push(d.id.type === "Identifier" ? `${d.id.name} = (${src.slice(d.init.start, d.init.end)});` : `(${src.slice(d.id.start, d.id.end)} = (${src.slice(d.init.start, d.init.end)}));`);
          else if (st.kind !== "var") parts.push(`${d.id.name} = undefined;`);
        }
        out += `__s(${i}); __decl(${JSON.stringify(names)}); try { ${parts.join(" ")} } catch (__e) { __x(${i}, __e); }`;
        break;
      }
      case "FunctionDeclaration":
        hoisted += `__decl(${JSON.stringify([st.id.name])}); ${st.id.name} = ${body};\n`;
        out += `__s(${i});`;
        break;
      case "ClassDeclaration":
        out += `__s(${i}); __decl(${JSON.stringify([st.id.name])}); try { ${st.id.name} = ${body}; } catch (__e) { __x(${i}, __e); }`;
        break;
      default:
        out += `__s(${i}); try { ${body}\n} catch (__e) { __x(${i}, __e); }`;
    }
  }
  out += src.slice(pos);
  return { code: hoisted + out, list };
}

// variables survive from one run to the next, like typing into mongosh
const scopeVars = Object.create(null);
const scope = new Proxy(scopeVars, {
  has(t, k) { if (typeof k !== "string") return false; if (k in t) return true; return !(k in self); },
  get(t, k) {
    if (k === Symbol.unscopables) return undefined;
    if (typeof k === "string" && k in t) return t[k];
    if (typeof k === "string" && !(k in self)) throw new ReferenceError(`${k} is not defined`);
    return self[k];
  },
  set(t, k, v) { t[k] = v; return true; },
  deleteProperty(t, k) { return delete t[k]; },
});
const AsyncFunction = (async function () {}).constructor;

function errorText(e) {
  e = mongoError(e);
  if (!(e instanceof Error)) return { text: `Uncaught: ${printable(e)}` };
  const name = e.name || "Error";
  let text = `${name}${e.codeName ? `[${e.codeName}]` : ""}: ${e.message}`;
  const more = [];
  if (e.errInfo && e.errInfo.reasons) more.push("Why: " + e.errInfo.reasons.join("; "));
  if (e.extra) more.push(e.extra);
  let hint = "";
  const m = /([\w$.]+)\.(\w+) is not a function/.exec(e.message || "");
  if (m) {
    const base = m[1].split(".");
    const pool = base[0] === "db" && base.length === 1 ? [...dbMethods] : base[0] === "db" && base.length === 2 ? [...collMethods] : [...collMethods, ...Object.getOwnPropertyNames(Cursor.prototype).filter((k) => !k.startsWith("_") && k !== "constructor")];
    const s = didYouMean(m[2], pool);
    if (s) hint = `Did you mean ${s}()?`;
  }
  if (!hint && /\)\.(\w+) is not a function/.test(e.message || "")) {
    const w = /\)\.(\w+) is not a function/.exec(e.message)[1];
    const s = didYouMean(w, [...collMethods, ...Object.getOwnPropertyNames(Cursor.prototype).filter((k) => !k.startsWith("_") && k !== "constructor")]);
    if (s) hint = `Did you mean ${s}()?`;
  }
  const r = /^(\w+) is not defined$/.exec(e.message || "");
  if (r && e instanceof ReferenceError) hint = /^[A-Za-z]+$/.test(r[1]) ? `Strings need quotes: "${r[1]}". If ${r[1]} is a variable, declare it first.` : "";
  if (e.code === 11000) hint = "Each value of a unique index (and of _id) can appear only once in the collection.";
  return { text: text + (more.length ? "\n" + more.join("\n") : ""), hint };
}
self.__shell = shellCmd;
self.__decl = (names) => { for (const n of names) if (!(n in scopeVars)) scopeVars[n] = undefined; };
self.__s = (i) => { const s = stmts[i]; if (s) emit({ kind: "cmd", line: s.line, text: s.text, db: state.current }); };
self.__r = (i, v) => {
  if (v === undefined) return;
  if (v instanceof Cursor) { showCursor(v); return; }
  if (v && v.__explain) v = v.__explain();
  emit({ kind: v instanceof ShellText ? "text" : "val", ...(v instanceof ShellText ? { text: v.s } : fmt(v)) });
};
self.__x = (i, e) => {
  runInfo.errors++;
  const { text, hint } = errorText(e);
  emit({ kind: "err", text, hint, line: stmts[i] && stmts[i].line });
};

async function run(id, code) {
  const t0 = performance.now();
  runInfo = { id, errors: 0, count: 0, truncated: false };
  warned = new Set();
  let prepared;
  try { prepared = transform(preprocess(code), code); }
  catch (e) {
    if (e instanceof SyntaxError && e.loc) {
      const line = code.split("\n")[e.loc.line - 1] || "";
      emit({ kind: "cmd", line: 1, text: code.trim().split("\n").slice(0, 8).join("\n"), db: state.current });
      emit({ kind: "err", syntax: true, line: e.loc.line, col: e.loc.column + 1,
        text: `SyntaxError: ${e.message.replace(/\s*\(\d+:\d+\)$/, "")} (line ${e.loc.line}, column ${e.loc.column + 1})\n${line}\n${" ".repeat(e.loc.column)}^`,
        hint: syntaxHint(e.message, line) });
    } else emit({ kind: "err", text: String(e) });
    flush();
    postMessage({ type: "done", id, ms: Math.round(performance.now() - t0), errors: 1, statements: 0, db: state.current });
    return;
  }
  stmts = prepared.list;
  try {
    const fn = new AsyncFunction("__scope", "with (__scope) {\n" + prepared.code + "\n}");
    await fn(scope);
  } catch (e) {
    runInfo.errors++;
    const { text, hint } = errorText(e);
    emit({ kind: "err", text, hint });
  }
  flush();
  if (dirty) await persist();
  postMessage(schema());
  postMessage({ type: "done", id, ms: Math.round(performance.now() - t0), errors: runInfo.errors, statements: stmts.length, db: state.current });
}
function syntaxHint(msg, line) {
  if (/Unexpected token/.test(msg) && /}\s*{/.test(line)) return "Separate documents with a comma: { ... }, { ... }";
  if (/Unexpected token/.test(msg) && /(['"\d\]}]|true|false|null)\s+[A-Za-z_$][\w$]*\s*:/.test(line)) return "Separate the fields of a document with commas, for example { name: 'Asha', age: 20 }";
  if (/Unterminated string/.test(msg)) return "A string is missing its closing quote.";
  if (/Unexpected token/.test(msg) && /:\s*[A-Za-z][\w ]*[,}]/.test(line)) return 'Text values need quotes, for example name: "Asha".';
  return "";
}

// shell helpers available to scripts
Object.assign(self, {
  db: dbProxy("test"),
  ObjectId, ISODate, BSONError,
  NumberInt: toNumber("NumberInt"), NumberLong: toNumber("NumberLong"), NumberDecimal: toNumber("NumberDecimal"), Double: toNumber("Double"), Int32: toNumber("NumberInt"),
  print: (...a) => emit({ kind: "print", text: a.map(printable).join(" ") }),
  printjson: (v) => emit({ kind: "val", ...fmt(v) }),
  tojson: (v) => fmt(v).t,
  emit: (k, v) => { if (!currentEmit) throw new MongoshError("emit() can only be used inside a mapReduce map function"); currentEmit(k, v); },
  sleep: (ms) => { const end = Date.now() + Math.min(Number(ms) || 0, 5000); while (Date.now() < end) {} },
  version: () => "2.3.0 (FoCT browser lab)",
  load: () => { throw notAvailable("load()"); },
  connect: (url) => {
    const rest = String(url || "test").replace(/^mongodb(\+srv)?:\/\/[^/]*/, "");
    const m = /\/([^/?]+)(\?|$)/.exec(rest);
    return dbProxy(m ? m[1] : rest.split("/").pop() || "test");
  },
  Mongo: function Mongo() { return { getDB: (n) => dbProxy(n), getDBNames: () => listDatabases().databases.map((d) => d.name), toString: () => "mongodb://browser-lab" }; },
  rs: new Proxy({}, { get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : () => { throw notAvailable("Replica sets (rs." + String(k) + ")"); }) }),
  sh: new Proxy({}, { get: (t, k) => (typeof k === "symbol" || k === "then" ? undefined : () => { throw notAvailable("Sharding (sh." + String(k) + ")"); }) }),
});
self.console = Object.assign(Object.create(console), { log: self.print, info: self.print, warn: self.print, error: self.print });
if (!Array.sum) Array.sum = (a) => a.reduce((s, x) => s + x, 0);
if (!Array.avg) Array.avg = (a) => (a.length ? Array.sum(a) / a.length : NaN);
if (!Array.unique) Array.unique = (a) => [...new Set(a)];

const HELP = `Shell commands
  use <db>                switch database (it is created when you insert data)
  show dbs                list databases
  show collections        list collections in the current database
  it                      show the next 20 documents of the last query
  cls                     clear the output
  db.help()               database methods
  db.<collection>.help()  collection methods`;
const HELP_DB = `Database methods
  db.getName()                         current database
  db.getCollectionNames()              list collections
  db.createCollection(name, options)   e.g. with { validator: { $jsonSchema: {...} } }
  db.<collection>                      a collection (created on first insert)
  db.getCollection("name")             a collection with an unusual name
  db.getSiblingDB("other")             another database
  db.dropDatabase()                    delete the current database
  db.stats()                           sizes and counts`;
const HELP_COLL = `Collection methods
  insertOne(doc)  insertMany([docs])
  find(filter, projection)  findOne(filter)  countDocuments(filter)  distinct(field)
  updateOne(filter, update, { upsert })  updateMany(...)  replaceOne(filter, doc)
  deleteOne(filter)  deleteMany(filter)
  findOneAndUpdate / findOneAndReplace / findOneAndDelete
  aggregate([stages])  mapReduce(map, reduce, { out })  bulkWrite([ops])
  createIndex(keys, { unique })  getIndexes()  dropIndex(name)
  drop()  renameCollection(newName)  stats()
Cursor methods (after find): sort  limit  skip  count  toArray  forEach  map  hasNext  next  explain`;

// ------------------------------------------------------------------ data in and out
function schema() {
  const dbs = [...state.dbs.entries()].map(([name, colls]) => ({
    name, colls: [...colls.values()].map((st) => ({ name: st.name, count: st.docs.length, indexes: st.indexes.map((ix) => ix.name), validator: !!(st.options && st.options.validator) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { type: "schema", current: state.current, dbs };
}
function dump() {
  const databases = {};
  for (const [dbName, colls] of state.dbs) {
    databases[dbName] = {};
    for (const st of colls.values()) databases[dbName][st.name] = { options: toEJ(st.options || {}), indexes: st.indexes.map(publicIndex).map(toEJ), documents: st.docs.map(toEJ) };
  }
  return { format: "foct-mongo-lab", version: 1, saved: new Date().toISOString(), current: state.current, databases };
}
function restore(data, merge = false) {
  if (!data || data.format !== "foct-mongo-lab" || typeof data.databases !== "object") throw new Error("This is not a MongoDB Lab database file.");
  if (!merge) state.dbs.clear();
  for (const [dbName, colls] of Object.entries(data.databases)) {
    checkDbName(dbName);
    const db = new Map();
    state.dbs.set(dbName, db);
    for (const [name, c] of Object.entries(colls)) {
      const st = newStore(name, fromEJ(c.options || {}));
      st.indexes = (c.indexes && c.indexes.length ? c.indexes : st.indexes).map(fromEJ);
      st.docs = (c.documents || []).map(fromEJ);
      rebuildUnique(st);
      db.set(name, st);
    }
  }
  if (data.current) { state.current = data.current; self.db = dbProxy(state.current); }
  markDirty();
}
function loadDataset(name) {
  const ds = self.FOCT_MONGO.DATASETS[name];
  if (!ds) throw new Error("Unknown sample database " + name);
  const colls = ds.build(ObjectId);
  state.dbs.delete(name);
  const parts = [];
  for (const [cn, docs] of Object.entries(colls)) {
    const st = storeOf(name, cn, true);
    for (const d of docs) insertDoc(name, st, d);
    parts.push(`${cn} (${docs.length})`);
  }
  markDirty();
  return `Loaded the ${name} database: ${parts.join(", ")}`;
}
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!head) return [];
  return body.map((r) => {
    const d = {};
    head.forEach((h, i) => {
      const raw = (r[i] ?? "").trim();
      if (raw === "" || !h.trim()) return;
      const v = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
      setPath(d, h.trim(), v);
    });
    return d;
  });
}
function parseDocs(text, format) {
  if (format === "csv") return parseCsv(text);
  const t = text.trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) return j.map(fromEJ);
    if (j && j.format === "foct-mongo-lab") throw new Error("This is a whole-lab database file: use Open databases instead.");
    return [fromEJ(j)];
  } catch (e) {
    if (/whole-lab/.test(e.message)) throw e;
    return t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try { return fromEJ(JSON.parse(l)); } catch { throw new Error(`Line ${i + 1} is not valid JSON.`); }
    });
  }
}
function importDocs(dbName, coll, text, format, replace) {
  checkDbName(dbName);
  checkCollName(coll);
  const docs = parseDocs(text, format);
  if (replace) state.dbs.get(dbName)?.delete(coll);
  const st = storeOf(dbName, coll, true);
  let ok = 0;
  const errors = [];
  for (const d of docs) {
    try { insertDoc(dbName, st, d); ok++; } catch (e) { if (errors.length < 3) errors.push(e.message); }
  }
  markDirty();
  return { inserted: ok, failed: docs.length - ok, errors };
}
function flatten(v, prefix, out) {
  if (isPlain(v)) { for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out); }
  else out[prefix] = v;
  return out;
}
function exportDocs(dbName, coll, format) {
  const st = storeOf(dbName, coll);
  const docs = st ? st.docs : [];
  if (format === "ndjson") return docs.map((d) => JSON.stringify(toEJ(d))).join("\n") + "\n";
  if (format === "csv") {
    const rows = docs.map((d) => flatten(d, "", {}));
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const cell = (v) => {
      if (v === undefined || v === null) return "";
      const s = v instanceof Date ? v.toISOString() : v instanceof ObjectId ? v.$oid : typeof v === "object" ? JSON.stringify(toEJ(v)) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
  }
  return JSON.stringify(docs.map(toEJ), null, 2) + "\n";
}

// ------------------------------------------------------------------ IndexedDB (this computer only)
const IDB = "foct-mongo-lab";
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const d = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { d.close(); }
}
let persistWarned = false;
async function persist() {
  dirty = false;
  try {
    const json = JSON.stringify(dump());
    if (json.length > 60e6) { if (!persistWarned) postMessage({ type: "note", text: "The data is too large to keep in this browser; use Save databases to keep it." }); persistWarned = true; return; }
    await idbDo("readwrite", (s) => s.put(json, "state"));
  } catch (e) {
    if (!persistWarned) postMessage({ type: "note", text: "This browser did not allow saving the data between visits (" + (e && e.message) + "). Use Save databases to keep it." });
    persistWarned = true;
  }
}
async function loadSaved() {
  try {
    const json = await idbDo("readonly", (s) => s.get("state"));
    if (json) restore(JSON.parse(json));
  } catch (e) { postMessage({ type: "note", text: "Could not read the saved data: " + (e && e.message) }); }
  dirty = false;
}

// ------------------------------------------------------------------ messages from the page
const ready = loadSaved().then(() => {
  self.db = dbProxy(state.current);
  postMessage({ type: "ready", version: SERVER_VERSION, mingo: "mingo" });
  postMessage(schema());
});
onmessage = async (e) => {
  const m = e.data;
  await ready;
  if (m.type === "run") { await run(m.id, m.code); return; }
  let data, error;
  try {
    runInfo = { id: m.id, errors: 0, count: 0, truncated: false };
    switch (m.type) {
      case "sample": data = loadDataset(m.name); break;
      case "import": data = importDocs(m.db, m.coll, m.text, m.format, m.replace); break;
      case "export": data = exportDocs(m.db, m.coll, m.format); break;
      case "dump": data = JSON.stringify(dump(), null, 1); break;
      case "restore": restore(JSON.parse(m.text)); data = "ok"; break;
      case "reset": state.dbs.clear(); state.current = "test"; self.db = dbProxy("test"); for (const k of Object.keys(scopeVars)) delete scopeVars[k]; lastCursor = null; markDirty(); data = "ok"; break;
      case "schema": break;
      default: throw new Error("unknown request " + m.type);
    }
  } catch (err) { error = err && err.message ? err.message : String(err); }
  flush();
  if (dirty) await persist();
  postMessage({ type: "reply", id: m.id, data, error });
  postMessage(schema());
};
})();
