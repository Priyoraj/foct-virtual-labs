// Operator-precedence parsing: operator grammars, LEADING and TRAILING, the precedence relation
// table, precedence functions, and the shift-reduce parse driven by the relations.
import { END, showRhs } from "./grammar.js";

export const LT = "<·", EQ = "≐", GT = "·>";   // <·  ≐  ·>

const isNT = (g, x) => g.nts.includes(x);

/** Reasons the grammar is not an operator grammar (empty when it is one). */
export function operatorIssues(g) {
  const out = [];
  for (const p of g.prods) {
    if (!p.rhs.length) { out.push(`${p.lhs} → ε is an ε-production`); continue; }
    for (let i = 0; i + 1 < p.rhs.length; i++) {
      if (isNT(g, p.rhs[i]) && isNT(g, p.rhs[i + 1])) { out.push(`${p.lhs} → ${showRhs(p.rhs)} has two non-terminals side by side (${p.rhs[i]} ${p.rhs[i + 1]})`); break; }
    }
  }
  return out;
}

/** Makes an operator grammar where possible, by substituting non-terminals that only produce terminals (A → + | *). */
export function toOperatorGrammar(g) {
  const rules = new Map(g.nts.map((A) => [A, []]));
  for (const p of g.prods) rules.get(p.lhs).push(p.rhs.slice());
  const onlyTerminals = (A) => rules.get(A).every((r) => r.length && r.every((x) => !rules.has(x)));
  const steps = [];
  for (let guard = 0, changed = true; changed && guard < 50; guard++) {
    changed = false;
    for (const A of g.nts) {
      const alts = rules.get(A);
      for (let k = 0; k < alts.length && !changed; k++) {
        const r = alts[k];
        for (let i = 0; i + 1 < r.length; i++) {
          if (!rules.has(r[i]) || !rules.has(r[i + 1])) continue;
          const at = onlyTerminals(r[i + 1]) ? i + 1 : onlyTerminals(r[i]) ? i : -1;
          if (at < 0) continue;
          const X = r[at];
          const repl = rules.get(X).map((alt) => [...r.slice(0, at), ...alt, ...r.slice(at + 1)]);
          alts.splice(k, 1, ...repl);
          steps.push(`In ${A} → ${showRhs(r)}, replace ${X} by its alternatives: ${repl.map(showRhs).join(" | ")}`);
          changed = true;
          break;
        }
      }
    }
  }
  // drop non-terminals that can no longer be reached from the start symbol
  const reach = new Set([g.start]), todo = [g.start];
  while (todo.length) for (const r of rules.get(todo.pop())) for (const x of r) if (rules.has(x) && !reach.has(x)) { reach.add(x); todo.push(x); }
  for (const A of g.nts) if (!reach.has(A)) { rules.delete(A); steps.push(`${A} is no longer used, so it is removed.`); }
  const nts = g.nts.filter((A) => rules.has(A));
  const ts = [], prods = [];
  for (const A of nts) for (const rhs of rules.get(A)) {
    for (const x of rhs) if (!rules.has(x) && !ts.includes(x)) ts.push(x);
    if (!prods.some((p) => p.lhs === A && p.rhs.join("\u0000") === rhs.join("\u0000"))) prods.push({ lhs: A, rhs });
  }
  prods.forEach((p, i) => { p.i = i; });
  return { grammar: { start: g.start, nts, ts, prods, spaced: true, warnings: [] }, steps };
}

/** LEADING(A): terminals that can come first in a string derived from A (after at most one non-terminal); TRAILING(A) likewise at the end. */
export function leadingTrailing(g) {
  const lead = new Map(g.nts.map((A) => [A, new Set()]));
  const trail = new Map(g.nts.map((A) => [A, new Set()]));
  let changed = true;
  const addAll = (dst, src) => { for (const a of src) if (!dst.has(a)) { dst.add(a); changed = true; } };
  const add = (dst, a) => { if (!dst.has(a)) { dst.add(a); changed = true; } };
  while (changed) {
    changed = false;
    for (const p of g.prods) {
      const r = p.rhs;
      if (!r.length) continue;
      const L = lead.get(p.lhs), T = trail.get(p.lhs);
      if (!isNT(g, r[0])) add(L, r[0]);
      else { addAll(L, lead.get(r[0])); if (r.length > 1 && !isNT(g, r[1])) add(L, r[1]); }
      const n = r.length - 1;
      if (!isNT(g, r[n])) add(T, r[n]);
      else { addAll(T, trail.get(r[n])); if (n > 0 && !isNT(g, r[n - 1])) add(T, r[n - 1]); }
    }
  }
  return { lead, trail };
}

/** The precedence relations between terminals (a = top terminal of the stack, b = next input symbol). */
export function precedenceTable(g, lt) {
  const terms = [...g.ts, END];
  const rel = new Map(terms.map((a) => [a, new Map()]));
  const why = [];
  const add = (a, b, r, reason) => {
    const row = rel.get(a);
    if (!row.has(b)) row.set(b, new Set());
    if (!row.get(b).has(r)) { row.get(b).add(r); why.push({ a, b, r, reason }); }
  };
  for (const p of g.prods) {
    const X = p.rhs, prod = `${p.lhs} → ${showRhs(X)}`;
    for (let i = 0; i + 1 < X.length; i++) {
      const t0 = !isNT(g, X[i]), t1 = !isNT(g, X[i + 1]);
      if (t0 && t1) add(X[i], X[i + 1], EQ, prod);
      if (i + 2 < X.length && t0 && !t1 && !isNT(g, X[i + 2])) add(X[i], X[i + 2], EQ, prod);
      if (t0 && !t1) for (const a of lt.lead.get(X[i + 1])) add(X[i], a, LT, `${prod}: ${X[i]} before ${X[i + 1]}, LEADING(${X[i + 1]})`);
      if (!t0 && t1) for (const a of lt.trail.get(X[i])) add(a, X[i + 1], GT, `${prod}: TRAILING(${X[i]}) before ${X[i + 1]}`);
    }
  }
  for (const a of lt.lead.get(g.start)) add(END, a, LT, `$ before LEADING(${g.start})`);
  for (const a of lt.trail.get(g.start)) add(a, END, GT, `TRAILING(${g.start}) before $`);
  const conflicts = [];
  for (const [a, row] of rel) for (const [b, rs] of row) if (rs.size > 1) conflicts.push({ a, b, rels: [...rs] });
  const get = (a, b) => (rel.get(a) && rel.get(a).get(b)) || new Set();
  return { terms, rel, get, conflicts, why };
}

/**
 * Precedence functions f and g with f(a) < g(b) when a <· b, f(a) = g(b) when a ≐ b, f(a) > g(b) when a ·> b.
 * Built from the graph of groups (f_a and g_b are merged when a ≐ b): the value is the longest path from the node.
 */
export function precedenceFunctions(t) {
  const parent = new Map();
  const node = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const a of t.terms) { node("f" + a); node("g" + a); }
  for (const a of t.terms) for (const b of t.terms) if (t.get(a, b).has(EQ)) parent.set(find("f" + a), find("g" + b));
  const edges = new Map();
  const edge = (x, y) => { const X = find(x), Y = find(y); if (!edges.has(X)) edges.set(X, new Set()); edges.get(X).add(Y); };
  for (const a of t.terms) for (const b of t.terms) {
    const rs = t.get(a, b);
    if (rs.has(LT)) edge("g" + b, "f" + a);
    if (rs.has(GT)) edge("f" + a, "g" + b);
  }
  const groups = new Map();
  for (const k of parent.keys()) { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); }
  // longest path, with cycle detection
  const memo = new Map(), state = new Map();
  let cycle = null;
  const longest = (x, path) => {
    if (memo.has(x)) return memo.get(x);
    if (state.get(x) === 1) { cycle = cycle || [...path.slice(path.indexOf(x)), x]; return 0; }
    state.set(x, 1);
    path.push(x);
    let best = 0;
    for (const y of edges.get(x) || []) best = Math.max(best, 1 + longest(y, path));
    path.pop();
    state.set(x, 2);
    memo.set(x, best);
    return best;
  };
  for (const x of groups.keys()) longest(x, []);
  const label = (r) => groups.get(r).join(" ");
  if (cycle) return { ok: false, cycle: cycle.map(label), groups, edges, label };
  const f = {}, g = {};
  for (const a of t.terms) { f[a] = memo.get(find("f" + a)); g[a] = memo.get(find("g" + a)); }
  return { ok: true, f, g, groups, edges, label };
}

/** Shift-reduce parse with the precedence relations. Non-terminals on the stack all match any non-terminal in a handle. */
export function opParse(g, t, tokens, limit = 600) {
  const term = (x) => !isNT(g, x);
  const stack = [{ sym: END, node: null }];
  const input = [...tokens, END];
  let ip = 0;
  const steps = [];
  const snap = (action, ok = true) => steps.push({ stack: stack.map((e) => e.sym).join(" "), input: input.slice(ip).join(" "), action, ok });
  const topTerminal = (from) => { for (let i = from; i >= 0; i--) if (term(stack[i].sym)) return i; return -1; };
  while (steps.length < limit) {
    const ti = topTerminal(stack.length - 1);
    const a = stack[ti].sym, b = input[ip];
    if (a === END && b === END) {
      const ok = stack.length === 2 && !term(stack[1].sym);
      snap(ok ? "accept" : "error: the input does not reduce to a single non-terminal", ok);
      return { steps, accepted: ok, tree: ok ? stack[1].node : null };
    }
    const rs = t.get(a, b);
    if (!rs.size) { snap(`error: no relation between ${a} and ${b}`, false); return { steps, accepted: false, tree: null }; }
    const note = rs.size > 1 ? "  (conflict: shift chosen)" : "";
    if (rs.has(LT) || rs.has(EQ)) {
      snap(`${a} ${rs.has(LT) ? LT : EQ} ${b}: shift ${b}${note}`);
      stack.push({ sym: b, node: { label: b, children: [] } });
      ip++;
      continue;
    }
    // a ·> b: pop the handle, back to the terminal that is <· the last terminal popped
    let last = a, j = topTerminal(ti - 1);
    while (j >= 0 && !t.get(stack[j].sym, last).has(LT)) {
      if (!t.get(stack[j].sym, last).has(EQ)) { snap(`error: no handle to reduce (${stack[j].sym} and ${last} are not related)`, false); return { steps, accepted: false, tree: null }; }
      last = stack[j].sym;
      j = topTerminal(j - 1);
    }
    if (j < 0) { snap("error: no handle to reduce", false); return { steps, accepted: false, tree: null }; }
    const handle = stack.slice(j + 1).map((e) => e.sym);
    const match = g.prods.filter((p) => p.rhs.length === handle.length && p.rhs.every((x, k) => (isNT(g, x) ? !term(handle[k]) : x === handle[k])));
    if (!match.length) {
      snap(`${a} ${GT} ${b}: error, no production has the right side ${handle.map((x) => (term(x) ? x : "N")).join(" ")}`, false);
      return { steps, accepted: false, tree: null };
    }
    const p = match[0];
    snap(`${a} ${GT} ${b}: reduce ${showRhs(handle)} by ${p.lhs} → ${showRhs(p.rhs)}`);
    const kids = stack.splice(j + 1).map((e) => e.node);
    stack.push({ sym: p.lhs, node: { label: p.lhs, children: kids } });
  }
  snap("stopped: too many steps", false);
  return { steps, accepted: false, tree: null };
}
