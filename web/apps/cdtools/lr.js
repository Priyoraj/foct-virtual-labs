// LR parsing: LR(0) and LR(1) item sets, LR(0) / SLR(1) / LALR(1) / CLR(1) tables, and
// shift-reduce parsing with a parse tree. Used by the compiler design tools page.
import { EPS, END, firstFollow, showRhs } from "./grammar.js";

const MAX_STATES = 400;

/** The augmented grammar S' -> S, with the original productions numbered 1..n. */
export function augment(g) {
  let S2 = g.start + "'";
  while (g.nts.includes(S2) || g.ts.includes(S2)) S2 += "'";
  const prods = [{ lhs: S2, rhs: [g.start], i: 0 }, ...g.prods.map((p, k) => ({ lhs: p.lhs, rhs: p.rhs, i: k + 1 }))];
  return { ...g, start: S2, nts: [S2, ...g.nts], prods, original: g.start };
}

// items are [prod, dot] (LR(0)) or [prod, dot, lookahead] (LR(1))
const key0 = (it) => `${it[0]}.${it[1]}`;
const key1 = (it) => `${it[0]}.${it[1]}.${it[2]}`;

function closure0(aug, items) {
  const out = new Map(items.map((it) => [key0(it), it]));
  const todo = [...items];
  while (todo.length) {
    const [p, d] = todo.pop();
    const X = aug.prods[p].rhs[d];
    if (!aug.nts.includes(X)) continue;
    for (const q of aug.prods) if (q.lhs === X) {
      const it = [q.i, 0];
      if (!out.has(key0(it))) { out.set(key0(it), it); todo.push(it); }
    }
  }
  return [...out.values()];
}
function closure1(aug, ff, items) {
  const out = new Map(items.map((it) => [key1(it), it]));
  const todo = [...items];
  while (todo.length) {
    const [p, d, a] = todo.pop();
    const rhs = aug.prods[p].rhs;
    const X = rhs[d];
    if (!aug.nts.includes(X)) continue;
    const { set, nullable } = ff.firstOf(rhs.slice(d + 1));
    const las = [...set];
    if (nullable) las.push(a);
    for (const q of aug.prods) if (q.lhs === X) for (const b of las) {
      const it = [q.i, 0, b];
      if (!out.has(key1(it))) { out.set(key1(it), it); todo.push(it); }
    }
  }
  return [...out.values()];
}
const sortItems = (items) => items.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1] || String(x[2] ?? "").localeCompare(String(y[2] ?? "")));

/** Canonical collection. lr1: use LR(1) items. Returns { states: [items], trans: [Map(sym -> state)] } */
function collection(aug, ff, lr1) {
  const keyOf = lr1 ? key1 : key0;
  const close = lr1 ? (its) => closure1(aug, ff, its) : (its) => closure0(aug, its);
  const setKey = (items) => items.map(keyOf).sort().join("|");
  const start = sortItems(close(lr1 ? [[0, 0, END]] : [[0, 0]]));
  const states = [start], trans = [new Map()], index = new Map([[setKey(start), 0]]);
  for (let s = 0; s < states.length; s++) {
    if (states.length > MAX_STATES) throw new Error(`More than ${MAX_STATES} states: the grammar is too large for this tool.`);
    const symbols = [];
    for (const [p, d] of states[s]) { const X = aug.prods[p].rhs[d]; if (X !== undefined && !symbols.includes(X)) symbols.push(X); }
    for (const X of symbols) {
      const moved = states[s].filter(([p, d]) => aug.prods[p].rhs[d] === X).map((it) => (lr1 ? [it[0], it[1] + 1, it[2]] : [it[0], it[1] + 1]));
      const target = sortItems(close(moved));
      const k = setKey(target);
      if (!index.has(k)) { index.set(k, states.length); states.push(target); trans.push(new Map()); }
      trans[s].set(X, index.get(k));
    }
  }
  return { states, trans };
}

/** LALR(1): merge LR(1) states with the same core. */
function mergeCores(aug, c) {
  const coreKey = (items) => [...new Set(items.map((it) => `${it[0]}.${it[1]}`))].sort().join("|");
  const groupOf = new Map(), merged = [], members = [];
  c.states.forEach((items, s) => {
    const k = coreKey(items);
    if (!groupOf.has(k)) { groupOf.set(k, merged.length); merged.push(new Map()); members.push([]); }
    const g = groupOf.get(k);
    members[g].push(s);
    for (const it of items) merged[g].set(key1(it), it);
  });
  const stateMap = c.states.map((items) => groupOf.get(coreKey(items)));
  const trans = merged.map(() => new Map());
  c.trans.forEach((m, s) => { for (const [X, t] of m) trans[stateMap[s]].set(X, stateMap[t]); });
  return { states: merged.map((m) => sortItems([...m.values()])), trans, members };
}

/**
 * Builds the parsing table.  method: "lr0" | "slr" | "lalr" | "clr"
 * Returns { aug, method, states, trans, action: [Map(term -> [entry])], goto: [Map(nt -> state)], conflicts, terms }
 * entry: { t: "s", n } | { t: "r", n } | { t: "acc" }
 */
export function buildLR(g, method) {
  const aug = augment(g);
  const ff = firstFollow(aug);
  const lr1 = method === "lalr" || method === "clr";
  let c = collection(aug, ff, lr1);
  let members = null;
  if (method === "lalr") { const m = mergeCores(aug, c); members = m.members; c = { states: m.states, trans: m.trans }; }
  const terms = [...g.ts, END];
  const action = c.states.map(() => new Map()), gotoT = c.states.map(() => new Map());
  const add = (s, a, e) => {
    const row = action[s];
    if (!row.has(a)) row.set(a, []);
    if (!row.get(a).some((x) => x.t === e.t && x.n === e.n)) row.get(a).push(e);
  };
  c.states.forEach((items, s) => {
    for (const [X, t] of c.trans[s]) { if (aug.nts.includes(X)) gotoT[s].set(X, t); else add(s, X, { t: "s", n: t }); }
    for (const it of items) {
      const [p, d] = it;
      const prod = aug.prods[p];
      if (d < prod.rhs.length) continue;
      if (p === 0) { add(s, END, { t: "acc" }); continue; }
      const las = method === "lr0" ? terms : method === "slr" ? [...ff.follow.get(prod.lhs)] : [it[2]];
      for (const a of las) add(s, a, { t: "r", n: p });
    }
  });
  const conflicts = [];
  action.forEach((row, s) => {
    for (const [a, es] of row) if (es.length > 1) {
      const kinds = es.some((e) => e.t === "s") ? "shift/reduce" : "reduce/reduce";
      conflicts.push({ state: s, term: a, kind: kinds, entries: es });
    }
  });
  return { aug, ff, method, states: c.states, trans: c.trans, members, action, goto: gotoT, conflicts, terms, nts: g.nts };
}

export const entryText = (e) => (e.t === "acc" ? "acc" : `${e.t}${e.n}`);

/** Item text such as  E → E · + T   or  [E → E · + T, $/+]  (lookaheads grouped). */
export function itemLines(aug, items) {
  const groups = new Map();
  for (const it of items) {
    const k = `${it[0]}.${it[1]}`;
    if (!groups.has(k)) groups.set(k, { p: it[0], d: it[1], las: [] });
    if (it[2] !== undefined) groups.get(k).las.push(it[2]);
  }
  return [...groups.values()].map(({ p, d, las }) => {
    const prod = aug.prods[p];
    const rhs = prod.rhs.slice();
    rhs.splice(d, 0, "·");
    const body = `${prod.lhs} → ${rhs.join(" ")}`;
    return las.length ? `[${body}, ${las.join("/")}]` : body;
  });
}

/** Shift-reduce parse of the tokens. On a conflict the first entry is used (shift, as yacc does). */
export function lrParse(t, tokens, limit = 600) {
  const input = [...tokens, END];
  const stack = [{ state: 0 }];
  let ip = 0;
  const steps = [];
  const stackText = () => stack.map((e) => (e.sym ? `${e.sym} ${e.state}` : `${e.state}`)).join(" ");
  const snap = (action, ok = true) => steps.push({ stack: stackText(), input: input.slice(ip).join(" "), action, ok });
  while (steps.length < limit) {
    const s = stack.at(-1).state, a = input[ip];
    const es = t.action[s].get(a) || [];
    if (!es.length) {
      const expected = t.terms.filter((x) => (t.action[s].get(x) || []).length);
      snap(`error: unexpected ${a === END ? "end of input" : a}${expected.length ? ` (expected ${expected.join(", ")})` : ""}`, false);
      return { steps, accepted: false, tree: null };
    }
    const e = es.find((x) => x.t === "s") || es[0];
    const note = es.length > 1 ? "  (conflict: first choice used)" : "";
    if (e.t === "acc") { snap("accept"); return { steps, accepted: true, tree: stack[1].node }; }
    if (e.t === "s") { snap(`shift ${e.n}${note}`); stack.push({ state: e.n, sym: a, node: { label: a, children: [] } }); ip++; continue; }
    const p = t.aug.prods[e.n];
    const k = p.rhs.length;
    const g = t.goto[stack[stack.length - 1 - k].state].get(p.lhs);
    snap(`reduce by ${p.lhs} → ${showRhs(p.rhs)}, goto ${g}${note}`);
    if (g === undefined) { snap("error: no goto entry", false); return { steps, accepted: false, tree: null }; }
    const popped = k ? stack.splice(stack.length - k, k) : [];
    const node = { label: p.lhs, children: k ? popped.map((x) => x.node) : [{ label: EPS, children: [], eps: true }] };
    stack.push({ state: g, sym: p.lhs, node });
  }
  snap("stopped: too many steps", false);
  return { steps, accepted: false, tree: null };
}
