// Regular expressions to automata: Thompson's ε-NFA, subset construction, DFA minimisation,
// string testing, and the direct (followpos) method. Used by the compiler design tools page.

export const EPS = "ε";
export class RegexError extends Error {}

/**
 * Parses a regular expression. Operators: | (or + when plusIsUnion), *, + (one or more), ?, ( ),
 * ε for the empty string, [abc] / [a-z] for a choice of characters, \x for a literal character.
 */
export function parseRegex(src, plusIsUnion = false) {
  const s = src.replace(/\s+/g, "");
  if (!s) throw new RegexError("Type a regular expression, for example (a|b)*abb");
  let i = 0;
  const peek = () => s[i];
  const isUnion = (c) => c === "|" || (plusIsUnion && c === "+");
  function alt() {
    let left = cat();
    while (i < s.length && isUnion(peek())) { i++; left = { type: "alt", a: left, b: cat() }; }
    return left;
  }
  function cat() {
    let left = null;
    while (i < s.length && peek() !== ")" && !isUnion(peek())) {
      const r = rep();
      left = left ? { type: "cat", a: left, b: r } : r;
    }
    if (!left) throw new RegexError(`Missing operand at position ${i + 1}${i < s.length ? ` (before “${peek()}”)` : ""}.`);
    return left;
  }
  function rep() {
    let node = atom();
    while (i < s.length && (peek() === "*" || peek() === "?" || (!plusIsUnion && peek() === "+"))) {
      const op = s[i++];
      node = { type: op === "*" ? "star" : op === "+" ? "plus" : "opt", a: node };
    }
    return node;
  }
  function atom() {
    const c = s[i];
    if (c === "(") {
      i++;
      if (peek() === ")") { i++; return { type: "eps" }; }
      const node = alt();
      if (peek() !== ")") throw new RegexError(`Missing “)” at position ${i + 1}.`);
      i++;
      return node;
    }
    if (c === "[") {
      const j = s.indexOf("]", i + 1);
      if (j < 0) throw new RegexError(`Missing “]” for the set at position ${i + 1}.`);
      const body = s.slice(i + 1, j);
      i = j + 1;
      const chars = [];
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === "-" && body[k + 2]) {
          for (let x = body.charCodeAt(k); x <= body.charCodeAt(k + 2); x++) chars.push(String.fromCharCode(x));
          k += 2;
        } else chars.push(body[k]);
      }
      if (!chars.length) throw new RegexError("An empty set [] matches nothing.");
      return chars.map((ch) => ({ type: "sym", c: ch })).reduce((a, b) => ({ type: "alt", a, b }));
    }
    if (c === "*" || c === "?" || c === ")" || isUnion(c) || (!plusIsUnion && c === "+"))
      throw new RegexError(`“${c}” at position ${i + 1} needs something before it.`);
    if (c === "\\") { i += 2; if (i > s.length) throw new RegexError("A \\ at the end needs a character after it."); return { type: "sym", c: s[i - 1] }; }
    i++;
    if (c === "ε") return { type: "eps" };
    return { type: "sym", c };
  }
  const tree = alt();
  if (i < s.length) throw new RegexError(`Unexpected “${s[i]}” at position ${i + 1}${s[i] === ")" ? " (no matching “(”)" : ""}.`);
  return tree;
}

export function alphabetOf(tree) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === "sym" && !out.includes(n.c)) out.push(n.c);
    walk(n.a); walk(n.b);
  };
  walk(tree);
  return out;
}

// ------------------------------------------------------------------ Thompson's construction
export function thompson(tree) {
  let n = 0;
  const edges = [];
  const make = () => n++;
  const build = (node, start = make()) => {
    switch (node.type) {
      case "sym": { const f = make(); edges.push([start, node.c, f]); return f; }
      case "eps": { const f = make(); edges.push([start, EPS, f]); return f; }
      case "cat": { const mid = build(node.a, start); return build(node.b, mid); }
      case "alt": {
        const s1 = make(); const f1 = build(node.a, s1);
        const s2 = make(); const f2 = build(node.b, s2);
        const f = make();
        edges.push([start, EPS, s1], [start, EPS, s2], [f1, EPS, f], [f2, EPS, f]);
        return f;
      }
      case "star": case "plus": case "opt": {
        const s1 = make(); const f1 = build(node.a, s1);
        const f = make();
        edges.push([start, EPS, s1]);
        if (node.type !== "plus") edges.push([start, EPS, f]);
        if (node.type !== "opt") edges.push([f1, EPS, s1]);
        edges.push([f1, EPS, f]);
        return f;
      }
    }
    throw new RegexError("unknown node");
  };
  const start = make();
  const accept = build(tree, start);
  return { states: n, start, accept, edges, alphabet: alphabetOf(tree) };
}

function closure(nfa, set) {
  const out = new Set(set), todo = [...set];
  while (todo.length) {
    const s = todo.pop();
    for (const [a, c, b] of nfa.edges) if (a === s && c === EPS && !out.has(b)) { out.add(b); todo.push(b); }
  }
  return [...out].sort((x, y) => x - y);
}
const move = (nfa, set, ch) => [...new Set(nfa.edges.filter(([a, c]) => set.includes(a) && c === ch).map((e) => e[2]))];
const letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : `S${i}`);

/** Subset construction. Returns a DFA { names, sets, start, accept:Set, trans:[Map(ch -> state)], alphabet, rows } */
export function subset(nfa) {
  const sets = [closure(nfa, [nfa.start])], index = new Map([[sets[0].join(","), 0]]);
  const trans = [new Map()], rows = [];
  for (let s = 0; s < sets.length; s++) {
    if (sets.length > 300) throw new RegexError("The DFA has more than 300 states: try a smaller expression.");
    const row = { state: s, moves: {} };
    for (const ch of nfa.alphabet) {
      const m = move(nfa, sets[s], ch);
      if (!m.length) { row.moves[ch] = null; continue; }
      const u = closure(nfa, m), k = u.join(",");
      if (!index.has(k)) { index.set(k, sets.length); sets.push(u); trans.push(new Map()); }
      trans[s].set(ch, index.get(k));
      row.moves[ch] = { move: m.sort((a, b) => a - b), to: index.get(k) };
    }
    rows.push(row);
  }
  const accept = new Set(sets.map((set, i) => (set.includes(nfa.accept) ? i : -1)).filter((i) => i >= 0));
  return { names: sets.map((_, i) => letter(i)), sets, start: 0, accept, trans, alphabet: nfa.alphabet, rows };
}

/** Minimisation by partition refinement. Returns { dfa, steps: [[ [names...] ]] , groups } */
export function minimise(dfa) {
  const n = dfa.trans.length;
  const DEAD = n;
  const total = (s, ch) => (s === DEAD ? DEAD : dfa.trans[s].has(ch) ? dfa.trans[s].get(ch) : DEAD);
  const needDead = dfa.trans.some((m) => dfa.alphabet.some((ch) => !m.has(ch)));
  const all = [...Array(n).keys(), ...(needDead ? [DEAD] : [])];
  const nameOf = (s) => (s === DEAD ? "∅" : dfa.names[s]);
  let part = [all.filter((s) => dfa.accept.has(s)), all.filter((s) => !dfa.accept.has(s))].filter((g) => g.length);
  const steps = [part.map((g) => g.map(nameOf))];
  for (let guard = 0; guard < 100; guard++) {
    const groupOf = new Map();
    part.forEach((g, i) => g.forEach((s) => groupOf.set(s, i)));
    const next = [];
    for (const g of part) {
      const buckets = new Map();
      for (const s of g) {
        const sig = dfa.alphabet.map((ch) => groupOf.get(total(s, ch))).join(",");
        if (!buckets.has(sig)) buckets.set(sig, []);
        buckets.get(sig).push(s);
      }
      next.push(...buckets.values());
    }
    if (next.length === part.length) break;
    part = next;
    steps.push(part.map((g) => g.map(nameOf)));
  }
  // build the minimal DFA (without the dead group)
  const groupOf = new Map();
  part.forEach((g, i) => g.forEach((s) => groupOf.set(s, i)));
  const deadGroup = needDead ? groupOf.get(DEAD) : -1;
  const isDeadGroup = (gi) => gi === deadGroup || (part[gi].every((s) => !dfa.accept.has(s) && s !== DEAD) &&
    dfa.alphabet.every((ch) => part[gi].every((s) => groupOf.get(total(s, ch)) === gi)) && part[gi].every((s) => s !== 0));
  const keep = part.map((_, i) => i).filter((i) => !isDeadGroup(i)).sort((x, y) => Math.min(...part[x]) - Math.min(...part[y]));
  const order = [groupOf.get(0), ...keep.filter((i) => i !== groupOf.get(0))];
  const newIndex = new Map(order.map((gi, k) => [gi, k]));
  const names = order.map((gi) => part[gi].filter((s) => s !== DEAD).map(nameOf).join(""));
  const trans = order.map((gi) => {
    const m = new Map();
    const rep = part[gi].find((s) => s !== DEAD);
    for (const ch of dfa.alphabet) { const t = groupOf.get(total(rep, ch)); if (newIndex.has(t)) m.set(ch, newIndex.get(t)); }
    return m;
  });
  const accept = new Set(order.map((gi, k) => (part[gi].some((s) => dfa.accept.has(s)) ? k : -1)).filter((k) => k >= 0));
  return { dfa: { names, start: 0, accept, trans, alphabet: dfa.alphabet }, steps };
}

/** Runs a DFA on a string. */
export function simulate(dfa, str) {
  let s = dfa.start;
  const path = [dfa.names[s]];
  for (const ch of str) {
    if (!dfa.trans[s].has(ch)) return { accepted: false, path, stuck: ch };
    s = dfa.trans[s].get(ch);
    path.push(dfa.names[s]);
  }
  return { accepted: dfa.accept.has(s), path };
}

// ------------------------------------------------------------------ direct method (followpos)
export function followpos(tree) {
  const root = { type: "cat", a: tree, b: { type: "sym", c: "#", end: true } };
  const leaves = [null];
  const ann = new Map();
  const walk = (n) => {
    let r;
    switch (n.type) {
      case "sym": { const p = leaves.length; leaves.push(n.c); n.pos = p; r = { nullable: false, first: [p], last: [p] }; break; }
      case "eps": r = { nullable: true, first: [], last: [] }; break;
      case "alt": { const a = walk(n.a), b = walk(n.b); r = { nullable: a.nullable || b.nullable, first: [...a.first, ...b.first], last: [...a.last, ...b.last] }; break; }
      case "cat": {
        const a = walk(n.a), b = walk(n.b);
        r = { nullable: a.nullable && b.nullable, first: a.nullable ? [...a.first, ...b.first] : a.first, last: b.nullable ? [...a.last, ...b.last] : b.last };
        break;
      }
      case "star": case "opt": { const a = walk(n.a); r = { nullable: true, first: a.first, last: a.last }; break; }
      case "plus": { const a = walk(n.a); r = { nullable: a.nullable, first: a.first, last: a.last }; break; }
    }
    r.first = [...new Set(r.first)].sort((x, y) => x - y);
    r.last = [...new Set(r.last)].sort((x, y) => x - y);
    ann.set(n, r);
    return r;
  };
  walk(root);
  const follow = leaves.map(() => new Set());
  const fill = (n) => {
    if (!n || n.type === "sym" || n.type === "eps") return;
    if (n.type === "cat") for (const i of ann.get(n.a).last) for (const j of ann.get(n.b).first) follow[i].add(j);
    if (n.type === "star" || n.type === "plus") for (const i of ann.get(n.a).last) for (const j of ann.get(n.a).first) follow[i].add(j);
    fill(n.a); fill(n.b);
  };
  fill(root);
  const endPos = leaves.length - 1;
  const alphabet = alphabetOf(tree);
  const sets = [ann.get(root).first], index = new Map([[sets[0].join(","), 0]]), trans = [new Map()];
  for (let s = 0; s < sets.length && sets.length < 300; s++) {
    for (const ch of alphabet) {
      const u = [...new Set(sets[s].filter((p) => leaves[p] === ch).flatMap((p) => [...follow[p]]))].sort((x, y) => x - y);
      if (!u.length) continue;
      const k = u.join(",");
      if (!index.has(k)) { index.set(k, sets.length); sets.push(u); trans.push(new Map()); }
      trans[s].set(ch, index.get(k));
    }
  }
  const accept = new Set(sets.map((set, i) => (set.includes(endPos) ? i : -1)).filter((i) => i >= 0));
  return {
    root, ann, leaves, follow: follow.map((f) => [...f].sort((x, y) => x - y)), endPos,
    dfa: { names: sets.map((_, i) => letter(i)), sets, start: 0, accept, trans, alphabet },
  };
}
