// Context-free grammars: reading them, FIRST/FOLLOW, LL(1) tables and parsing,
// removing left recursion and left factoring. Used by the compiler design tools page.

export const EPS = "ε";
export const END = "$";
const EPS_WORDS = new Set(["ε", "eps", "epsilon", "#", "@", "λ", "∈", "''", '""']);
// multi-letter terminals that compact grammars such as  F->(E)|id  mean as one symbol
const WORDS = ["epsilon", "letter", "digit", "while", "float", "then", "else", "num", "int", "id", "do", "if"];

export class GrammarError extends Error {}

// A quote starts a quoted terminal ('+', '|') only at the start of a symbol; E' is a primed name.
const quoteStarts = (s, i) => (s[i] === "'" || s[i] === '"') && (i === 0 || /[\s|]/.test(s[i - 1])) && s.indexOf(s[i], i + 1) > i;
function splitAlternatives(s) {
  const out = [];
  let cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (quoteStarts(s, i)) { q = ch; cur += ch; continue; }
    if (ch === "|") { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((a) => a.trim().replace(/\s*;$/, "").trim());
}

function tokenizeSpaced(alt) {
  const out = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(alt))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function tokenizeCompact(alt, ntNames) {
  const nts = [...ntNames].sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < alt.length) {
    const ch = alt[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (quoteStarts(alt, i) && alt.indexOf(ch, i + 1) > i + 1) {
      const j = alt.indexOf(ch, i + 1);
      out.push(alt.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    const nt = nts.find((n) => alt.startsWith(n, i));
    if (nt) { out.push(nt); i += nt.length; continue; }
    const w = WORDS.find((x) => alt.startsWith(x, i) && !/[a-z]/.test(alt[i + x.length] || ""));
    if (w) { out.push(w); i += w.length; continue; }
    out.push(ch);
    i++;
  }
  return out;
}

/**
 * Reads a grammar such as
 *     E -> E + T | T        (symbols separated by spaces)
 *     E->TE'   E'->+TE'|#   (one character per symbol; E', id and num are recognised)
 * The left side of the first rule is the start symbol. ε may be written ε, eps, # or @, or left empty.
 * mode: "auto" | "spaced" | "compact"
 */
export function parseGrammar(text, mode = "auto") {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    const m = /^(.+?)\s*(->|→|::=|=>|:)\s*(.*)$/.exec(line);
    if (m && !/\s/.test(m[1].trim())) { rules.push({ lhs: m[1].trim(), alts: splitAlternatives(m[3]) }); continue; }
    if (line.startsWith("|") && rules.length) { rules.at(-1).alts.push(...splitAlternatives(line.slice(1))); continue; }
    if (line === ";") continue;
    throw new GrammarError(`“${line}” is not a production. Write rules like  A -> α | β  (one non-terminal on the left).`);
  }
  if (!rules.length) throw new GrammarError("Type a grammar first, for example  E -> E + T | T");
  const ntNames = new Set(rules.map((r) => r.lhs));
  const spaced = mode === "spaced" ? true : mode === "compact" ? false
    : rules.some((r) => r.alts.some((a) => tokenizeSpaced(a).length > 1));
  const nts = [], ts = [], prods = [], warnings = [];
  for (const r of rules) if (!nts.includes(r.lhs)) nts.push(r.lhs);
  for (const r of rules) {
    for (const alt of r.alts) {
      let rhs = alt === "" || EPS_WORDS.has(alt) ? [] : spaced ? tokenizeSpaced(alt) : tokenizeCompact(alt, ntNames);
      if (rhs.length > 1 && rhs.some((x) => EPS_WORDS.has(x) && x !== "#" && x !== "@")) rhs = rhs.filter((x) => !EPS_WORDS.has(x));
      if (rhs.length === 1 && EPS_WORDS.has(rhs[0])) rhs = [];
      for (const x of rhs) if (!ntNames.has(x) && !ts.includes(x)) ts.push(x);
      if (!prods.some((p) => p.lhs === r.lhs && p.rhs.join("\u0000") === rhs.join("\u0000"))) prods.push({ lhs: r.lhs, rhs });
    }
  }
  prods.forEach((p, i) => { p.i = i; });
  for (const t of ts) if (/^[A-Z]$/.test(t)) warnings.push(`${t} looks like a non-terminal but has no productions, so it is treated as a terminal.`);
  if (ts.includes(END)) throw new GrammarError("$ is reserved for the end of the input; use another terminal.");
  return { start: nts[0], nts, ts, prods, spaced, warnings };
}

export const isNT = (g, x) => g.nts.includes(x);
export const showRhs = (rhs) => (rhs.length ? rhs.join(" ") : EPS);
export const showProd = (p) => `${p.lhs} → ${showRhs(p.rhs)}`;

/** Grammar back to text, one line per non-terminal. */
export function grammarText(g) {
  return g.nts.map((A) => `${A} -> ${g.prods.filter((p) => p.lhs === A).map((p) => showRhs(p.rhs)).join(" | ")}`).join("\n");
}

function fromRules(start, order, rules, spaced = true) {
  const nts = order.filter((A) => rules.has(A));
  const ts = [], prods = [];
  for (const A of nts) for (const rhs of rules.get(A)) {
    for (const x of rhs) if (!rules.has(x) && !ts.includes(x)) ts.push(x);
    if (!prods.some((p) => p.lhs === A && p.rhs.join("\u0000") === rhs.join("\u0000"))) prods.push({ lhs: A, rhs });
  }
  prods.forEach((p, i) => { p.i = i; });
  return { start, nts, ts, prods, spaced, warnings: [] };
}

// ------------------------------------------------------------------ FIRST and FOLLOW
export function firstFollow(g) {
  const first = new Map(g.nts.map((A) => [A, new Set()]));
  const nullable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of g.prods) {
      const f = first.get(p.lhs);
      let all = true;
      for (const X of p.rhs) {
        if (!first.has(X)) { if (!f.has(X)) { f.add(X); changed = true; } all = false; break; }
        for (const a of first.get(X)) if (!f.has(a)) { f.add(a); changed = true; }
        if (!nullable.has(X)) { all = false; break; }
      }
      if (all && !nullable.has(p.lhs)) { nullable.add(p.lhs); changed = true; }
    }
  }
  const firstOf = (seq) => {
    const set = new Set();
    for (const X of seq) {
      if (!first.has(X)) { set.add(X); return { set, nullable: false }; }
      for (const a of first.get(X)) set.add(a);
      if (!nullable.has(X)) return { set, nullable: false };
    }
    return { set, nullable: true };
  };
  const follow = new Map(g.nts.map((A) => [A, new Set()]));
  follow.get(g.start).add(END);
  changed = true;
  while (changed) {
    changed = false;
    for (const p of g.prods) {
      p.rhs.forEach((X, i) => {
        if (!follow.has(X)) return;
        const fx = follow.get(X);
        const { set, nullable: rest } = firstOf(p.rhs.slice(i + 1));
        for (const a of set) if (!fx.has(a)) { fx.add(a); changed = true; }
        if (rest) for (const a of follow.get(p.lhs)) if (!fx.has(a)) { fx.add(a); changed = true; }
      });
    }
  }
  return { first, follow, nullable, firstOf };
}

/** Terminals in grammar order, then $ (for table columns and set display). */
export function orderTerms(g, set, withEnd = true) {
  const out = g.ts.filter((t) => set.has(t));
  if (withEnd && set.has(END)) out.push(END);
  return out;
}

// ------------------------------------------------------------------ LL(1)
export function ll1Table(g, ff) {
  const table = new Map(g.nts.map((A) => [A, new Map()]));
  const add = (A, a, p) => {
    const row = table.get(A);
    if (!row.has(a)) row.set(a, []);
    if (!row.get(a).includes(p)) row.get(a).push(p);
  };
  for (const p of g.prods) {
    const { set, nullable } = ff.firstOf(p.rhs);
    for (const a of set) add(p.lhs, a, p.i);
    if (nullable) for (const b of ff.follow.get(p.lhs)) add(p.lhs, b, p.i);
  }
  const conflicts = [];
  for (const [A, row] of table) for (const [a, ps] of row) if (ps.length > 1) conflicts.push({ A, a, prods: ps });
  return { table, conflicts, columns: [...g.ts, END] };
}

/** Splits the input string into the grammar's terminals. */
export function tokenizeInput(g, text) {
  const s = text.trim();
  if (!s) return [];
  if (/\s/.test(s) && s.split(/\s+/).every((t) => g.ts.includes(t))) return s.split(/\s+/);
  const terms = [...g.ts].sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const t = terms.find((x) => s.startsWith(x, i));
    if (!t) throw new GrammarError(`“${s.slice(i, i + 12)}” does not start with a terminal of the grammar (${g.ts.join(" ")}).`);
    out.push(t);
    i += t.length;
  }
  return out;
}

export function ll1Parse(g, ll, tokens, limit = 400) {
  const root = { label: g.start, children: [] };
  const stack = [{ sym: END }, { sym: g.start, node: root }];
  const input = [...tokens, END];
  let ip = 0;
  const steps = [];
  const snap = (action, ok = true) => steps.push({
    stack: stack.map((e) => e.sym).join(" "), input: input.slice(ip).join(" "), action, ok,
  });
  while (steps.length < limit) {
    const top = stack.at(-1), a = input[ip];
    if (top.sym === END && a === END) { snap("accept"); return { steps, accepted: true, tree: root }; }
    if (!g.nts.includes(top.sym)) {
      if (top.sym === a) { snap(`match ${a}`); stack.pop(); ip++; continue; }
      snap(`error: expected ${top.sym === END ? "end of input" : top.sym}, found ${a === END ? "end of input" : a}`, false);
      return { steps, accepted: false, tree: root };
    }
    const cell = ll.table.get(top.sym).get(a);
    if (!cell || !cell.length) {
      snap(`error: no entry M[${top.sym}, ${a}]`, false);
      return { steps, accepted: false, tree: root };
    }
    const p = g.prods[cell[0]];
    snap(`${showProd(p)}${cell.length > 1 ? "  (conflict: first choice used)" : ""}`);
    stack.pop();
    const kids = p.rhs.length ? p.rhs.map((x) => ({ label: x, children: [] })) : [{ label: EPS, children: [], eps: true }];
    top.node.children = kids;
    for (let i = p.rhs.length - 1; i >= 0; i--) stack.push({ sym: p.rhs[i], node: kids[i] });
  }
  snap("stopped: too many steps", false);
  return { steps, accepted: false, tree: root };
}

// ------------------------------------------------------------------ left recursion
function rulesOf(g) {
  const rules = new Map();
  for (const A of g.nts) rules.set(A, []);
  for (const p of g.prods) rules.get(p.lhs).push(p.rhs.slice());
  return rules;
}
function freshName(base, taken) {
  let n = base + "'";
  while (taken.has(n)) n += "'";
  taken.add(n);
  return n;
}
/** Non-terminals that can derive themselves at the left (A =>+ A...), and whether that needs other non-terminals. */
export function leftRecursion(g, ff) {
  const edges = new Map(g.nts.map((A) => [A, new Set()]));
  for (const p of g.prods) {
    for (const X of p.rhs) {
      if (!edges.has(X)) break;
      edges.get(p.lhs).add(X);
      if (!ff.nullable.has(X)) break;
    }
  }
  const direct = g.nts.filter((A) => edges.get(A).has(A));
  const reach = (A) => {
    const seen = new Set(), todo = [...edges.get(A)];
    while (todo.length) { const X = todo.pop(); if (seen.has(X)) continue; seen.add(X); todo.push(...edges.get(X)); }
    return seen;
  };
  const recursive = g.nts.filter((A) => reach(A).has(A));
  return { direct, recursive, indirect: recursive.some((A) => !direct.includes(A)) || recursive.length > direct.length };
}

export function removeLeftRecursion(g, ff) {
  const info = leftRecursion(g, ff);
  const steps = [];
  if (!info.recursive.length) return { grammar: g, steps: ["The grammar has no left recursion."] };
  const rules = rulesOf(g);
  const order = [...g.nts];
  const taken = new Set([...g.nts, ...g.ts]);
  const immediate = (A) => {
    const alts = rules.get(A);
    const rec = alts.filter((r) => r[0] === A), rest = alts.filter((r) => r[0] !== A);
    if (!rec.length) return;
    const A2 = freshName(A, taken);
    rules.set(A, rest.map((b) => [...b, A2]));
    rules.set(A2, [...rec.map((r) => [...r.slice(1), A2]), []]);
    order.splice(order.indexOf(A) + 1, 0, A2);
    steps.push(`${A} is left recursive: ${A} → ${rest.map((b) => showRhs([...b, A2])).join(" | ")} and ${A2} → ${rec.map((r) => showRhs([...r.slice(1), A2])).join(" | ")} | ${EPS}`);
  };
  if (!info.indirect) {
    for (const A of info.direct) immediate(A);
  } else {
    if (g.prods.some((p) => !p.rhs.length)) steps.push("Note: the standard algorithm assumes there are no ε-productions; check the result.");
    const base = [...g.nts];
    base.forEach((Ai, i) => {
      for (let j = 0; j < i; j++) {
        const Aj = base[j];
        const next = [];
        let replaced = false;
        for (const r of rules.get(Ai)) {
          if (r[0] === Aj) { replaced = true; for (const d of rules.get(Aj)) next.push([...d, ...r.slice(1)]); }
          else next.push(r);
        }
        if (replaced) {
          rules.set(Ai, next);
          steps.push(`Substitute ${Aj} in ${Ai}: ${Ai} → ${next.map(showRhs).join(" | ")}`);
        }
      }
      immediate(Ai);
    });
  }
  return { grammar: fromRules(g.start, order, rules), steps };
}

// ------------------------------------------------------------------ left factoring
export function leftFactor(g) {
  const rules = rulesOf(g);
  const order = [...g.nts];
  const taken = new Set([...g.nts, ...g.ts]);
  const steps = [];
  let changed = true, guard = 0;
  while (changed && guard++ < 100) {
    changed = false;
    for (const A of [...order]) {
      const alts = rules.get(A);
      const groups = new Map();
      alts.forEach((r, i) => { if (r.length) { if (!groups.has(r[0])) groups.set(r[0], []); groups.get(r[0]).push(i); } });
      const grp = [...groups.values()].find((ix) => ix.length > 1);
      if (!grp) continue;
      const rs = grp.map((i) => alts[i]);
      let k = 0;
      while (rs.every((r) => k < r.length && r[k] === rs[0][k])) k++;
      const prefix = rs[0].slice(0, k);
      const A2 = freshName(A, taken);
      const next = [];
      alts.forEach((r, i) => {
        if (i === grp[0]) next.push([...prefix, A2]);
        else if (!grp.includes(i)) next.push(r);
      });
      const rests = rs.map((r) => r.slice(k)).sort((x, y) => (x.length === 0) - (y.length === 0));
      rules.set(A, next);
      rules.set(A2, rests);
      order.splice(order.indexOf(A) + 1, 0, A2);
      steps.push(`${A}: common prefix “${showRhs(prefix)}” → ${A} → ${next.map(showRhs).join(" | ")} and ${A2} → ${rests.map(showRhs).join(" | ")}`);
      changed = true;
      break;
    }
  }
  if (!steps.length) steps.push("No two alternatives of a non-terminal start with the same symbol: nothing to factor.");
  return { grammar: fromRules(g.start, order, rules), steps };
}
