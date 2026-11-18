// Intermediate code for assignments such as  a = b * -c + b * -c :
// syntax tree, three-address code, quadruples, triples, indirect triples, postfix, and the DAG of
// the basic block with the optimised code it gives (common subexpressions, constant folding).

export class IcgError extends Error {}

function lex(line) {
  const toks = [];
  const re = /\s*(?:([A-Za-z_]\w*)|(\d+(?:\.\d+)?)|(\*\*|[-+*/%^=()]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < line.length) {
    const at = re.lastIndex;
    if (/^\s*$/.test(line.slice(at))) break;
    if (!(m = re.exec(line))) throw new IcgError(`Unexpected “${line.slice(at).trim()[0]}” in: ${line}`);
    toks.push(m[1] ? { t: "id", v: m[1] } : m[2] ? { t: "num", v: m[2] } : { t: m[3] === "**" ? "^" : m[3] });
  }
  return toks;
}

/** Parses one statement: id = expr, or just expr. */
export function parseStatement(line) {
  const toks = lex(line);
  let i = 0;
  const peek = () => toks[i] && toks[i].t;
  const expect = (t) => { if (peek() !== t) throw new IcgError(`Expected “${t}” in: ${line}`); i++; };
  function expr() {
    let n = term();
    while (peek() === "+" || peek() === "-") { const op = toks[i++].t; n = { op, l: n, r: term() }; }
    return n;
  }
  function term() {
    let n = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") { const op = toks[i++].t; n = { op, l: n, r: unary() }; }
    return n;
  }
  function unary() {
    if (peek() === "-") { i++; return { op: "minus", e: unary() }; }
    if (peek() === "+") { i++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === "^") { i++; return { op: "^", l: base, r: unary() }; }
    return base;
  }
  function primary() {
    const tk = toks[i];
    if (!tk) throw new IcgError(`The statement ends too early: ${line}`);
    if (tk.t === "id") { i++; return { id: tk.v }; }
    if (tk.t === "num") { i++; return { num: tk.v }; }
    if (tk.t === "(") { i++; const n = expr(); expect(")"); return n; }
    throw new IcgError(`Unexpected “${tk.t}” in: ${line}`);
  }
  let target = null;
  if (toks.length > 2 && toks[0].t === "id" && toks[1].t === "=") { target = toks[0].v; i = 2; }
  if (toks.some((tk, k) => tk.t === "=" && (k !== 1 || !target))) throw new IcgError(`Write one assignment per line, like  x = a + b  (in: ${line})`);
  const e = expr();
  if (i < toks.length) throw new IcgError(`Unexpected “${toks[i].v || toks[i].t}” in: ${line}`);
  return { target, e };
}

export function parseProgram(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").replace(/;\s*$/, "").trim()).filter(Boolean);
  if (!lines.length) throw new IcgError("Type at least one statement, for example  a = b * -c + b * -c");
  return lines.map(parseStatement);
}

const leafName = (n) => n.id ?? n.num;

// ------------------------------------------------------------------ three-address code etc.
export function generate(stmts) {
  let temp = 0;
  const quads = [];   // { op, a1, a2, res }
  const postfix = [];
  const walk = (n, out) => {
    if (n.id !== undefined || n.num !== undefined) { out.push(leafName(n)); return leafName(n); }
    if (n.op === "minus") {
      const a = walk(n.e, out);
      out.push("minus");
      const t = `t${++temp}`;
      quads.push({ op: "minus", a1: a, a2: "", res: t });
      return t;
    }
    const a = walk(n.l, out), b = walk(n.r, out);
    out.push(n.op);
    const t = `t${++temp}`;
    quads.push({ op: n.op, a1: a, a2: b, res: t });
    return t;
  };
  for (const s of stmts) {
    const out = [];
    const r = walk(s.e, out);
    if (s.target) {
      // keep the explicit copy  x = t  as the textbooks show it
      quads.push({ op: "=", a1: r, a2: "", res: s.target });
      out.unshift(s.target);
      out.push("=");
    }
    postfix.push(out.join(" "));
  }
  const tac = quads.map((q) => (q.op === "=" ? `${q.res} = ${q.a1}` : q.op === "minus" ? `${q.res} = minus ${q.a1}` : `${q.res} = ${q.a1} ${q.op} ${q.a2}`));
  // triples: results are referred to by position
  const where = new Map();
  const triples = [];
  for (const q of quads) {
    const ref = (x) => (where.has(x) ? `(${where.get(x)})` : x);
    if (q.op === "=") triples.push({ op: "=", a1: q.res, a2: ref(q.a1) });
    else triples.push({ op: q.op, a1: ref(q.a1), a2: q.a2 ? ref(q.a2) : "" });
    if (q.op !== "=") where.set(q.res, triples.length - 1);
  }
  return { quads, tac, triples, postfix };
}

// ------------------------------------------------------------------ syntax tree as a graph
export function treeGraph(stmts) {
  const nodes = [], edges = [];
  const add = (label, kind) => { nodes.push({ id: nodes.length, label, kind }); return nodes.length - 1; };
  const walk = (n) => {
    if (n.id !== undefined || n.num !== undefined) return add(leafName(n), "leaf");
    if (n.op === "minus") { const me = add("minus", "op"); edges.push([me, walk(n.e)]); return me; }
    const me = add(n.op, "op");
    edges.push([me, walk(n.l)], [me, walk(n.r)]);
    return me;
  };
  for (const s of stmts) {
    if (s.target) { const me = add("=", "op"); edges.push([me, add(s.target, "leaf")], [me, walk(s.e)]); }
    else walk(s.e);
  }
  return { nodes, edges };
}

// ------------------------------------------------------------------ DAG of the basic block
const fold = (op, x, y) => {
  const a = Number(x), b = Number(y);
  switch (op) {
    case "+": return a + b; case "-": return a - b; case "*": return a * b;
    case "/": return b !== 0 && Number.isInteger(a / b) ? a / b : null;
    case "%": return b !== 0 ? a % b : null;
    case "^": return Number.isInteger(a ** b) && Math.abs(a ** b) < 1e12 ? a ** b : null;
    case "minus": return -a;
  }
  return null;
};
export function dag(stmts) {
  const nodes = [];          // { id, op?, kids: [], leaf?, labels: [] }
  const index = new Map();   // value number key -> node id
  const current = new Map(); // variable -> node id holding its current value
  const assigned = new Set(stmts.filter((s) => s.target).map((s) => s.target));
  const notes = [];
  const leaf = (name, isNum) => {
    if (!isNum && current.has(name)) return current.get(name);
    const key = (isNum ? "#" : "@") + name;
    if (index.has(key)) return index.get(key);
    const id = nodes.length;
    nodes.push({ id, leaf: isNum ? String(name) : assigned.has(name) ? `${name}0` : name, num: isNum, kids: [], labels: [] });
    index.set(key, id);
    return id;
  };
  const node = (op, kids) => {
    if (kids.every((k) => nodes[k].num)) {
      const v = fold(op, ...kids.map((k) => nodes[k].leaf));
      if (v !== null) { notes.push(`constant folding: ${kids.length === 1 ? `minus ${nodes[kids[0]].leaf}` : `${nodes[kids[0]].leaf} ${op} ${nodes[kids[1]].leaf}`} = ${v}`); return leaf(v, true); }
    }
    const key = `${op}(${kids.join(",")})`;
    if (index.has(key)) {
      const id = index.get(key);
      const show = (k) => { const n = nodes[k]; return n.leaf !== undefined ? n.leaf : n.labels[0] || `(${n.op === "minus" ? `minus ${show(n.kids[0])}` : `${show(n.kids[0])} ${n.op} ${show(n.kids[1])}`})`; };
      notes.push(`common subexpression: ${op === "minus" ? `minus ${show(kids[0])}` : `${show(kids[0])} ${op} ${show(kids[1])}`} is computed once and reused`);
      return id;
    }
    const id = nodes.length;
    nodes.push({ id, op, kids, labels: [] });
    index.set(key, id);
    return id;
  };
  const walk = (n) => {
    if (n.id !== undefined) return leaf(n.id, false);
    if (n.num !== undefined) return leaf(n.num, true);
    if (n.op === "minus") return node("minus", [walk(n.e)]);
    return node(n.op, [walk(n.l), walk(n.r)]);
  };
  for (const s of stmts) {
    const id = walk(s.e);
    if (!s.target) continue;
    if (current.has(s.target)) { const old = nodes[current.get(s.target)]; old.labels = old.labels.filter((x) => x !== s.target); }
    nodes[id].labels.push(s.target);
    current.set(s.target, id);
  }
  // optimised code: each interior node once, named by a variable it computes (or a temporary)
  let temp = 0;
  const nameOf = new Map();
  const code = [];
  const emitNode = (id) => {
    if (nameOf.has(id)) return nameOf.get(id);
    const n = nodes[id];
    if (n.leaf !== undefined) {
      // b0 (the value b has when the block starts) is simply b in the code
      const nm = !n.num && n.leaf.endsWith("0") && assigned.has(n.leaf.slice(0, -1)) ? n.leaf.slice(0, -1) : n.leaf;
      nameOf.set(id, nm);
      return nm;
    }
    const args = n.kids.map(emitNode);
    const name = n.labels[0] || `t${++temp}`;
    code.push(n.op === "minus" ? `${name} = minus ${args[0]}` : `${name} = ${args[0]} ${n.op} ${args[1]}`);
    nameOf.set(id, name);
    for (const extra of n.labels.slice(1)) code.push(`${extra} = ${name}`);
    return name;
  };
  for (const n of nodes) if (n.labels.length) emitNode(n.id);
  // a variable whose final value is a leaf (x = y): a copy
  for (const n of nodes) if (n.leaf !== undefined) for (const lb of n.labels) code.push(`${lb} = ${nameOf.get(n.id) ?? n.leaf}`);
  return { nodes, code, notes: [...new Set(notes)] };
}
