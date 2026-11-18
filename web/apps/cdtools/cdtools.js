// FoCT Virtual Labs - Compiler Design Tools: check FIRST/FOLLOW, LL(1) and LR tables, automata
// and intermediate code worked out by hand (or by your C programs).
import { toggleTheme, escapeHtml as esc, modal } from "/assets/js/foct.js";
import {
  parseGrammar, firstFollow, ll1Table, ll1Parse, tokenizeInput, removeLeftRecursion, leftFactor, leftRecursion,
  grammarText, showProd, showRhs, orderTerms, EPS, END,
} from "./grammar.js";
import { buildLR, itemLines, entryText, lrParse } from "./lr.js";
import { parseRegex, thompson, subset, minimise, simulate, followpos, EPS as REPS } from "./automata.js";
import { parseProgram, generate, treeGraph, dag } from "./icg.js";
import { operatorIssues, toOperatorGrammar, leadingTrailing, precedenceTable, precedenceFunctions, opParse, LT, EQ, GT } from "./oprec.js";
import { draw, head, q, palette } from "./graph.js";

const $ = (id) => document.getElementById(id);
const STORE = "foct.cdtools";

// ------------------------------------------------------------------ examples
const GRAMMARS = [
  ["Expressions (left recursive)", "E -> E + T | T\nT -> T * F | F\nF -> ( E ) | id", "id + id * id"],
  ["Expressions in LL(1) form", "E -> T E'\nE' -> + T E' | ε\nT -> F T'\nT' -> * F T' | ε\nF -> ( E ) | id", "id + id * id"],
  ["Lab-manual notation (E'->+TE'|#)", "E->TE'\nE'->+TE'|#\nT->FT'\nT'->*FT'|#\nF->(E)|id", "id+id*id"],
  ["Needs left factoring (if-then-else)", "S -> i E t S | i E t S e S | a\nE -> b", "i b t a e a"],
  ["Dangling else: not LL(1)", "S -> i E t S S' | a\nS' -> e S | ε\nE -> b", "i b t i b t a e a"],
  ["Indirect left recursion", "S -> A a | b\nA -> A c | S d | ε", "b d a"],
  ["Balanced parentheses", "S -> ( S ) S | ε", "( ( ) ) ( )"],
  ["a^n b^n", "S -> a S b | a b", "a a b b"],
  ["SLR(1) but not LR(0)", "E -> T + E | T\nT -> id", "id + id + id"],
  ["LALR(1) but not SLR(1)", "S -> L = R | R\nL -> * R | id\nR -> L", "* id = id"],
  ["LR(1) but not LALR(1)", "S -> a A d | b B d | a B e | b A e\nA -> c\nB -> c", "a c e"],
  ["Ambiguous expressions", "E -> E + E | E * E | ( E ) | id", "id + id * id"],
];
const OP_GRAMMARS = [
  ["Expressions (E + T, T * F)", "E -> E + T | T\nT -> T * F | F\nF -> ( E ) | id", "id + id * id"],
  ["Four operators and ^ (right associative)", "E -> E + T | E - T | T\nT -> T * F | T / F | F\nF -> P ^ F | P\nP -> ( E ) | id", "id - id / id ^ id ^ id"],
  ["Boolean expressions", "B -> B or T | T\nT -> T and F | F\nF -> not F | ( B ) | true | false", "not true or false and true"],
  ["Not an operator grammar: E -> E A E", "E -> E A E | ( E ) | - E | id\nA -> + | - | * | / | ^", "id + id * id"],
  ["Ambiguous: E -> E + E | E * E", "E -> E + E | E * E | ( E ) | id", "id + id * id"],
  ["Assignment and comparison", "S -> id = E\nE -> E < T | T\nT -> T + F | F\nF -> ( E ) | id | num", "id = id + num < id"],
];
const REGEXES = [
  ["(a|b)*abb", "(a|b)*abb", false, "aababb"],
  ["(a+b)*abb  (textbook +)", "(a+b)*abb", true, "babb"],
  ["(a|b)*a(a|b)", "(a|b)*a(a|b)", false, "abab"],
  ["Identifiers: l(l|d)*", "l(l|d)*", false, "lldl"],
  ["a*b*", "a*b*", false, "aabbb"],
  ["(0|1)*01", "(0|1)*01", false, "11001"],
  ["ab*|ba*", "ab*|ba*", false, "baa"],
  ["Even number of a's", "b*(ab*ab*)*", false, "abba"],
];
const PROGRAMS = [
  ["a = b * -c + b * -c", "a = b * -c + b * -c"],
  ["Basic block: common subexpressions", "a = b + c\nb = a - d\nc = b + c\nd = a - d"],
  ["x = (a + b) * (a + b) - c / d", "x = (a + b) * (a + b) - c / d"],
  ["Constant folding", "x = 2 * 3 + y\nz = x * (8 - 4) + 10"],
  ["Precedence and powers", "y = a + b * c ^ 2 - (d - e) / f"],
];

function fill(select, list, onPick) {
  select.innerHTML = list.map((x, i) => `<option value="${i}">${esc(x[0])}</option>`).join("");
  select.onchange = () => onPick(list[+select.value]);
}

// ------------------------------------------------------------------ helpers
const sec = (title, body, sub = "") => `<section><h3>${title}${sub ? ` <small>${sub}</small>` : ""}</h3>${body}</section>`;
const errBox = (e) => `<section><p class="err">${esc(e.message || String(e))}</p></section>`;
const verdict = (ok, text) => `<span class="verdict ${ok ? "ok" : "no"}">${ok ? "✔" : "✖"} ${esc(text)}</span>`;
const setText = (S) => (S.size ? `{ ${[...S].join(", ")} }` : "{ }");
const table = (headRow, rows) => `<div class="tbl"><table><thead><tr>${headRow}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
function traceTable(steps) {
  return table("<th>#</th><th>Stack</th><th>Input</th><th>Action</th>",
    steps.map((s, i) => `<tr class="${s.ok ? (s.action === "accept" ? "good" : "") : "bad"}"><td>${i + 1}</td><td>${esc(s.stack)}</td><td>${esc(s.input)}</td><td>${esc(s.action)}</td></tr>`));
}
function treeDot(root) {
  const c = palette();
  let dot = head("digraph", 'ordering=out; nodesep=0.25; ranksep=0.35;') + `  node [shape=plaintext fontsize=13];\n`;
  let n = 0;
  const walk = (node) => {
    const id = n++;
    const leaf = !node.children.length;
    dot += `  n${id} [label=${q(node.label)} ${leaf ? `fontcolor="${node.eps ? c.muted : c.accent}" fontname="Helvetica-Bold"` : ""}];\n`;
    for (const ch of node.children) { const k = walk(ch); dot += `  n${id} -> n${k} [arrowhead=none];\n`; }
    return id;
  };
  walk(root);
  return dot + "}";
}
function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      g: $("gText").value, gIn: $("gInput").value, gMode: $("gMode").value, o: $("oText").value, oIn: $("oInput").value, l: $("lText").value, lIn: $("lInput").value, lM: $("lMethod").value,
      r: $("rText").value, rPlus: $("rPlus").checked, rIn: $("rInput").value, i: $("iText").value,
    }));
  } catch {}
}

// ------------------------------------------------------------------ FIRST / FOLLOW / LL(1)
let gState = null;
function analyseGrammar() {
  const out = $("gOut");
  let g;
  try { g = parseGrammar($("gText").value, $("gMode").value); }
  catch (e) { out.innerHTML = errBox(e); gState = null; return; }
  const ff = firstFollow(g);
  const ll = ll1Table(g, ff);
  const lr = leftRecursion(g, ff);
  gState = { g, ff, ll };
  let html = sec("The grammar", `<ol class="prods">${g.prods.map((p) => `<li><span class="no">(${p.i + 1})</span><span>${esc(showProd(p))}</span></li>`).join("")}</ol>
    <p class="muted">Non-terminals: <code>${esc(g.nts.join(" "))}</code> &middot; terminals: <code>${esc(g.ts.join(" ") || "none")}</code> &middot; start symbol <code>${esc(g.start)}</code>
    &middot; read with ${g.spaced ? "symbols separated by spaces" : "one character per symbol"}.</p>
    ${g.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}`);
  html += sec("FIRST and FOLLOW", table("<th>Non-terminal</th><th>FIRST</th><th>FOLLOW</th>",
    g.nts.map((A) => {
      const f = new Set(orderTerms(g, ff.first.get(A), false));
      if (ff.nullable.has(A)) f.add(EPS);
      return `<tr><td><b>${esc(A)}</b></td><td>${esc(setText(f))}</td><td>${esc(setText(new Set(orderTerms(g, ff.follow.get(A)))))}</td></tr>`;
    })), "ε in FIRST means the non-terminal can derive the empty string");
  const isLL1 = !ll.conflicts.length;
  const why = [];
  if (lr.recursive.length) why.push(`left recursion in ${lr.recursive.join(", ")}${lr.indirect ? " (indirect)" : ""}`);
  const factorable = g.nts.filter((A) => { const firsts = g.prods.filter((p) => p.lhs === A && p.rhs.length).map((p) => p.rhs[0]); return new Set(firsts).size < firsts.length; });
  if (factorable.length) why.push(`alternatives of ${factorable.join(", ")} start with the same symbol (left factoring needed)`);
  const rows = g.nts.map((A) => `<tr><td><b>${esc(A)}</b></td>${ll.columns.map((a) => {
    const ps = ll.table.get(A).get(a) || [];
    return `<td class="${ps.length > 1 ? "conflict" : ""}">${ps.map((i) => esc(showProd(g.prods[i]))).join("<br>")}</td>`;
  }).join("")}</tr>`);
  html += sec(`LL(1) parsing table ${verdict(isLL1, isLL1 ? "The grammar is LL(1)" : `Not LL(1): ${ll.conflicts.length} conflicting entr${ll.conflicts.length > 1 ? "ies" : "y"}`)}`,
    `${!isLL1 && why.length ? `<p class="warn">Because of ${esc(why.join("; "))}. Try <b>Remove left recursion</b> and <b>Left factor</b>.</p>` : ""}
     ${table(`<th>M[A, a]</th>${ll.columns.map((a) => `<th>${esc(a)}</th>`).join("")}`, rows)}`);
  html += `<div id="gTransform"></div><div id="gParseOut"></div>`;
  out.innerHTML = html;
  persist();
}

function transform(kind) {
  if (!gState) analyseGrammar();
  if (!gState) return;
  const r = kind === "rec" ? removeLeftRecursion(gState.g, gState.ff) : leftFactor(gState.g);
  const text = grammarText(r.grammar);
  const box = $("gTransform");
  box.innerHTML = sec(kind === "rec" ? "After removing left recursion" : "After left factoring",
    `<div class="newgram"><pre>${esc(text)}</pre><button class="btn btn-primary" id="gUse">Use this grammar</button></div>
     <ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`);
  $("gUse").onclick = () => { $("gText").value = text; $("gMode").value = "spaced"; analyseGrammar(); $("gOut").scrollTop = 0; };
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function parseLL1() {
  if (!gState) analyseGrammar();
  if (!gState) return;
  const box = $("gParseOut");
  let tokens;
  try { tokens = tokenizeInput(gState.g, $("gInput").value); }
  catch (e) { box.innerHTML = errBox(e); return; }
  const r = ll1Parse(gState.g, gState.ll, tokens);
  box.innerHTML = sec(`Predictive (LL(1)) parse of <code>${esc(tokens.join(" ") || EPS)}</code> ${verdict(r.accepted, r.accepted ? "Accepted" : "Rejected")}`,
    traceTable(r.steps) + `<h3 style="margin-top:12px">Parse tree</h3><div id="gTree"></div>`);
  draw($("gTree"), treeDot(r.tree));
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  persist();
}

// ------------------------------------------------------------------ operator precedence
let oState = null;
const relCell = (rs) => [...rs].join(" ");
function analyseOp() {
  const out = $("oOut");
  let g;
  try { g = parseGrammar($("oText").value, "auto"); }
  catch (e) { out.innerHTML = errBox(e); oState = null; return; }
  const issues = operatorIssues(g);
  let html = sec("The grammar", `<ol class="prods">${g.prods.map((p) => `<li><span class="no">(${p.i + 1})</span><span>${esc(showProd(p))}</span></li>`).join("")}</ol>
    ${g.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}`);
  if (issues.length) {
    const fix = toOperatorGrammar(g);
    const fixedOk = !operatorIssues(fix.grammar).length;
    html += sec(`Operator grammar? ${verdict(false, "No")}`,
      `<p>In an operator grammar no right side is ε and no right side has two non-terminals next to each other. Here:</p>
       <ul class="steps">${issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
       ${fixedOk ? `<p>Substituting gives an equivalent operator grammar:</p>
         <div class="newgram"><pre>${esc(grammarText(fix.grammar))}</pre><button class="btn btn-primary" id="oUse">Use this grammar</button></div>
         <ol class="steps">${fix.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`
         : `<p class="muted">This cannot be fixed just by substituting non-terminals that produce only terminals; rewrite the grammar by hand.</p>`}`);
    out.innerHTML = html;
    if (fixedOk) $("oUse").onclick = () => { $("oText").value = grammarText(fix.grammar); analyseOp(); };
    oState = null;
    persist();
    return;
  }
  const lt = leadingTrailing(g);
  const t = precedenceTable(g, lt);
  const fns = precedenceFunctions(t);
  oState = { g, t };
  const ok = !t.conflicts.length;
  html += sec("LEADING and TRAILING", table("<th>Non-terminal</th><th>LEADING</th><th>TRAILING</th>",
    g.nts.map((A) => `<tr><td><b>${esc(A)}</b></td><td>${esc(setText(new Set(orderTerms(g, lt.lead.get(A), false))))}</td><td>${esc(setText(new Set(orderTerms(g, lt.trail.get(A), false))))}</td></tr>`)),
    "the first / last terminal of what a non-terminal derives, allowing one non-terminal before / after it");
  const rows = t.terms.map((a) => `<tr><td><b>${esc(a)}</b></td>${t.terms.map((b) => {
    const rs = t.get(a, b);
    return `<td class="c ${rs.size > 1 ? "conflict" : ""}">${esc(relCell(rs))}</td>`;
  }).join("")}</tr>`);
  html += sec(`Operator precedence relations ${verdict(ok, ok ? "No conflicts: an operator precedence grammar" : `${t.conflicts.length} conflict${t.conflicts.length > 1 ? "s" : ""}: not an operator precedence grammar`)}`,
    `${ok ? "" : `<p class="warn">${t.conflicts.map((c) => esc(`${c.a} and ${c.b}: ${c.rels.join(" and ")}`)).join("<br>")}${g.prods.length && /E -> E \+ E/.test(grammarText(g)) ? "<br>An ambiguous grammar needs operator precedence and associativity chosen by hand." : ""}</p>`}
     ${table(`<th>stack \u2193 / input \u2192</th>${t.terms.map((b) => `<th>${esc(b)}</th>`).join("")}`, rows)}
     <p class="muted">${LT} : the input terminal binds tighter, shift it &nbsp;&middot;&nbsp; ${EQ} : same handle &nbsp;&middot;&nbsp; ${GT} : reduce. Rows are the topmost terminal on the stack, columns the next input symbol.</p>
     <details><summary>Why each relation holds</summary><ul class="steps">${t.why.map((w) => `<li>${esc(`${w.a} ${w.r} ${w.b}`)} &nbsp;<span class="muted">from ${esc(w.reason)}</span></li>`).join("")}</ul></details>`);
  if (fns.ok) {
    html += sec("Precedence functions", table(`<th></th>${t.terms.map((a) => `<th>${esc(a)}</th>`).join("")}`,
      [`<tr><td><b>f</b></td>${t.terms.map((a) => `<td class="c">${fns.f[a]}</td>`).join("")}</tr>`, `<tr><td><b>g</b></td>${t.terms.map((a) => `<td class="c">${fns.g[a]}</td>`).join("")}</tr>`]) +
      `<p class="muted">f(a) &lt; g(b) when a ${LT} b, f(a) = g(b) when a ${EQ} b, f(a) &gt; g(b) when a ${GT} b: the table above becomes two short rows. Each value is the length of the longest path from its node in this graph:</p><div id="oFns"></div>`);
  } else {
    html += sec(`Precedence functions ${verdict(false, "None exist")}`, `<p>The graph of the relations has a cycle: <code>${esc(fns.cycle.join(" \u2192 "))}</code>, so no functions f and g can represent this table.</p><div id="oFns"></div>`);
  }
  html += `<div id="oParseOut"></div>`;
  out.innerHTML = html;
  draw($("oFns"), fnsDot(fns));
  persist();
}
function fnsDot(fns) {
  const c = palette();
  let dot = head("digraph", "rankdir=LR; nodesep=0.25; ranksep=0.5;") + `  node [shape=ellipse fontsize=12];\n`;
  const id = new Map([...fns.groups.keys()].map((k, i) => [k, i]));
  for (const [k, members] of fns.groups) {
    const val = fns.ok ? (members[0][0] === "f" ? fns.f[members[0].slice(1)] : fns.g[members[0].slice(1)]) : "";
    dot += `  n${id.get(k)} [label=${q(members.map((m) => m[0] + m.slice(1)).join("  ") + (fns.ok ? `\n${val}` : ""))}];\n`;
  }
  for (const [x, ys] of fns.edges) for (const y of ys) dot += `  n${id.get(x)} -> n${id.get(y)};\n`;
  return dot + "}";
}
function parseOp() {
  if (!oState) analyseOp();
  if (!oState) return;
  const box = $("oParseOut");
  let tokens;
  try { tokens = tokenizeInput(oState.g, $("oInput").value); }
  catch (e) { box.innerHTML = errBox(e); return; }
  const r = opParse(oState.g, oState.t, tokens);
  box.innerHTML = sec(`Operator-precedence parse of <code>${esc(tokens.join(" ") || EPS)}</code> ${verdict(r.accepted, r.accepted ? "Accepted" : "Rejected")}`,
    traceTable(r.steps) + (r.tree ? `<h3 style="margin-top:12px">Parse tree <small>a skeleton: steps such as E \u2192 T, with no terminal, are never made</small></h3><div id="oTree"></div>` : ""));
  if (r.tree) draw($("oTree"), treeDot(r.tree));
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  persist();
}

// ------------------------------------------------------------------ LR
let lState = null;
const METHOD = { lr0: "LR(0)", slr: "SLR(1)", lalr: "LALR(1)", clr: "canonical LR(1)" };
function buildTable() {
  const out = $("lOut");
  let g, t;
  try { g = parseGrammar($("lText").value, "auto"); t = buildLR(g, $("lMethod").value); }
  catch (e) { out.innerHTML = errBox(e); lState = null; return; }
  lState = { g, t };
  const name = METHOD[t.method];
  const ok = !t.conflicts.length;
  const conflictStates = new Set(t.conflicts.map((c) => c.state));
  let html = sec("Augmented grammar", `<ol class="prods">${t.aug.prods.map((p) => `<li><span class="no">(${p.i})</span><span>${esc(showProd(p))}</span></li>`).join("")}</ol>`);
  const conflictText = t.conflicts.map((c) => `state ${c.state} on ${c.term}: ${c.kind} (${c.entries.map(entryText).join(" / ")})`);
  const nts = t.nts;
  const rows = t.states.map((_, s) => `<tr><td><b>${s}</b></td>${t.terms.map((a) => {
    const es = t.action[s].get(a) || [];
    return `<td class="c ${es.length > 1 ? "conflict" : es.some((e) => e.t === "acc") ? "acc" : ""}">${es.map(entryText).join("/")}</td>`;
  }).join("")}${nts.map((A, k) => `<td class="c${k === 0 ? " split" : ""}">${t.goto[s].has(A) ? t.goto[s].get(A) : ""}</td>`).join("")}</tr>`);
  html += sec(`${name} parsing table ${verdict(ok, ok ? `The grammar is ${name}` : `Not ${name}: ${t.conflicts.length} conflict${t.conflicts.length > 1 ? "s" : ""}`)}`,
    `${ok ? "" : `<p class="warn">${conflictText.map(esc).join("<br>")}</p>`}
     ${table(`<th rowspan="2">State</th><th colspan="${t.terms.length}">ACTION</th><th colspan="${nts.length}" class="split">GOTO</th></tr><tr>${t.terms.map((a) => `<th>${esc(a)}</th>`).join("")}${nts.map((A, k) => `<th class="${k === 0 ? "split" : ""}">${esc(A)}</th>`).join("")}`, rows)}
     <p class="muted">s<i>n</i> = shift and go to state <i>n</i>; r<i>n</i> = reduce by production (<i>n</i>); acc = accept.</p>`,
    `${t.states.length} states`);
  html += sec(`${t.method === "clr" || t.method === "lalr" ? "LR(1)" : "LR(0)"} item sets`,
    `<div class="items">${t.states.map((items, s) => `<div class="item-card ${conflictStates.has(s) ? "has-conflict" : ""}"><b>I${s}</b>${t.members && t.members[s].length > 1 ? `<span class="src">merged from LR(1) states ${t.members[s].join(", ")}</span>` : ""}<br>${itemLines(t.aug, items).map(esc).join("<br>")}</div>`).join("")}</div>`,
    t.method === "lalr" ? "LR(1) states with the same core are merged" : "");
  html += sec("GOTO graph (the DFA of item sets)", `<div id="lGraph"></div>`);
  html += `<div id="lParseOut"></div>`;
  out.innerHTML = html;
  draw($("lGraph"), lrDot(t, conflictStates));
  persist();
}
function lrDot(t, conflictStates) {
  const c = palette();
  const small = t.states.length <= 40;
  let dot = head("digraph", "rankdir=LR; nodesep=0.3; ranksep=0.5;") + `  node [shape=box style="rounded" fontname="Courier" fontsize=11];\n`;
  t.states.forEach((items, s) => {
    const lines = small ? [`I${s}`, ...itemLines(t.aug, items)] : [`I${s}`];
    const label = lines.map((l) => l.replace(/\\/g, "\\\\").replace(/"/g, '\\"')).join("\\l") + "\\l";
    dot += `  s${s} [label="${label}" ${conflictStates.has(s) ? `color="${c.bad}" penwidth=2` : ""}];\n`;
  });
  t.trans.forEach((m, s) => { for (const [X, to] of m) dot += `  s${s} -> s${to} [label=${q(X)}];\n`; });
  return dot + "}";
}
function parseLR() {
  if (!lState) buildTable();
  if (!lState) return;
  const box = $("lParseOut");
  let tokens;
  try { tokens = tokenizeInput(lState.g, $("lInput").value); }
  catch (e) { box.innerHTML = errBox(e); return; }
  const r = lrParse(lState.t, tokens);
  box.innerHTML = sec(`Shift-reduce parse of <code>${esc(tokens.join(" ") || EPS)}</code> ${verdict(r.accepted, r.accepted ? "Accepted" : "Rejected")}`,
    traceTable(r.steps) + (r.tree ? `<h3 style="margin-top:12px">Parse tree</h3><div id="lTree"></div>` : ""));
  if (r.tree) draw($("lTree"), treeDot(r.tree));
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  persist();
}

// ------------------------------------------------------------------ regular expressions
let rState = null;
function automatonDot(names, start, accept, transitions, opts = {}) {
  const c = palette();
  let dot = head("digraph", "rankdir=LR; nodesep=0.35;") + `  node [shape=circle fixedsize=false width=0.45];\n  __start [shape=point width=0.08 color="${c.fg}"];\n`;
  names.forEach((n, i) => { dot += `  s${i} [label=${q(n)} ${accept.has(i) ? "shape=doublecircle" : ""} ${opts.highlight && opts.highlight.has(i) ? `color="${c.accent}" penwidth=2` : ""}];\n`; });
  dot += `  __start -> s${start};\n`;
  const merged = new Map();
  for (const [a, sym, b] of transitions) { const k = `${a}->${b}`; if (!merged.has(k)) merged.set(k, []); merged.get(k).push(sym); }
  for (const [k, syms] of merged) { const [a, b] = k.split("->"); dot += `  s${a} -> s${b} [label=${q(syms.join(","))}${syms.every((x) => x === REPS) ? ` fontcolor="${c.muted}" style=dashed` : ""}];\n`; }
  return dot + "}";
}
const dfaEdges = (dfa) => dfa.trans.flatMap((m, s) => [...m].map(([ch, t]) => [s, ch, t]));
function buildAutomata() {
  const out = $("rOut");
  $("rTestOut").textContent = "";
  let tree, nfa, d, m, fp;
  try {
    tree = parseRegex($("rText").value, $("rPlus").checked);
    nfa = thompson(tree); d = subset(nfa); m = minimise(d); fp = followpos(tree);
  } catch (e) { out.innerHTML = errBox(e); rState = null; return; }
  rState = { nfa, d, m, fp };
  const al = nfa.alphabet;
  const nfaRows = [...Array(nfa.states).keys()].map((s) => `<tr><td><b>${s}</b>${s === nfa.start ? " →" : ""}${s === nfa.accept ? " *" : ""}</td>${[REPS, ...al].map((ch) => {
    const to = nfa.edges.filter(([a, c]) => a === s && c === ch).map((e) => e[2]);
    return `<td class="c">${to.length ? `{${to.join(", ")}}` : ""}</td>`;
  }).join("")}</tr>`);
  let html = sec("Thompson's construction: ε-NFA", `<div id="rNfa"></div><details><summary>Transition table</summary>${table(`<th>State</th>${[REPS, ...al].map((x) => `<th>${esc(x)}</th>`).join("")}`, nfaRows)}<p class="muted">→ start state, * accepting state.</p></details>`,
    `${nfa.states} states, start ${nfa.start}, accepting ${nfa.accept}`);
  const subsetRows = d.sets.map((set, i) => `<tr><td><b>${d.names[i]}</b>${i === d.start ? " →" : ""}${d.accept.has(i) ? " *" : ""}</td><td>{${set.join(", ")}}</td>${al.map((ch) => {
    const mv = d.rows[i].moves[ch];
    return `<td>${mv ? `${d.names[mv.to]} <span class="muted">= ε-closure({${mv.move.join(", ")}})</span>` : `<span class="muted">—</span>`}</td>`;
  }).join("")}</tr>`);
  html += sec("Subset construction: DFA", `${table(`<th>DFA state</th><th>NFA states</th>${al.map((x) => `<th>on ${esc(x)}</th>`).join("")}`, subsetRows)}<div id="rDfa"></div>`,
    `start = ε-closure({${nfa.start}}); accepting states contain NFA state ${nfa.accept}`);
  const minRows = m.dfa.names.map((n, i) => `<tr><td><b>${esc(n)}</b>${i === m.dfa.start ? " →" : ""}${m.dfa.accept.has(i) ? " *" : ""}</td>${al.map((ch) => `<td class="c">${m.dfa.trans[i].has(ch) ? esc(m.dfa.names[m.dfa.trans[i].get(ch)]) : "—"}</td>`).join("")}</tr>`);
  html += sec("Minimised DFA", `<ol class="steps" start="0">${m.steps.map((p, k) => `<li>Π${k} = ${p.map((g) => `{${g.join(", ")}}`).join(" ")}</li>`).join("")}</ol>
    <p class="muted">Start with accepting and non-accepting states; split a group while its states go to different groups on some symbol.${m.steps.some((p) => p.flat().includes("∅")) ? " ∅ is the dead state that missing transitions go to." : ""}</p>
    ${table(`<th>State</th>${al.map((x) => `<th>${esc(x)}</th>`).join("")}`, minRows)}<div id="rMin"></div>`,
    `${d.names.length} → ${m.dfa.names.length} states`);
  const posRows = fp.leaves.slice(1).map((sym, k) => `<tr><td class="c">${k + 1}</td><td class="c">${esc(sym)}</td><td>{${fp.follow[k + 1].join(", ")}}</td></tr>`);
  html += sec("Direct method: syntax tree and followpos", `<details><summary>Show the followpos table and the DFA it gives</summary>
    <p class="muted">The expression is extended with an end marker: (r)#. Positions number the symbols of the tree.</p>
    ${table("<th>Position</th><th>Symbol</th><th>followpos</th>", posRows)}
    <div id="rTree"></div>
    ${table(`<th>DFA state</th><th>Positions</th>${al.map((x) => `<th>on ${esc(x)}</th>`).join("")}`, fp.dfa.sets.map((set, i) => `<tr><td><b>${fp.dfa.names[i]}</b>${i === 0 ? " →" : ""}${fp.dfa.accept.has(i) ? " *" : ""}</td><td>{${set.join(", ")}}</td>${al.map((ch) => `<td class="c">${fp.dfa.trans[i].has(ch) ? fp.dfa.names[fp.dfa.trans[i].get(ch)] : "—"}</td>`).join("")}</tr>`))}
    <div id="rFpDfa"></div></details>`);
  out.innerHTML = html;
  draw($("rNfa"), automatonDot([...Array(nfa.states).keys()].map(String), nfa.start, new Set([nfa.accept]), nfa.edges));
  draw($("rDfa"), automatonDot(d.names, d.start, d.accept, dfaEdges(d)));
  draw($("rMin"), automatonDot(m.dfa.names, m.dfa.start, m.dfa.accept, dfaEdges(m.dfa)));
  out.querySelector("details:last-of-type").addEventListener("toggle", (e) => {
    if (!e.target.open || $("rTree").dataset.done) return;
    $("rTree").dataset.done = "1";
    draw($("rTree"), fpTreeDot(fp));
    draw($("rFpDfa"), automatonDot(fp.dfa.names, 0, fp.dfa.accept, dfaEdges(fp.dfa)));
  });
  persist();
}
function fpTreeDot(fp) {
  const c = palette();
  let dot = head("digraph", "ordering=out; nodesep=0.3; ranksep=0.4;") + `  node [shape=plaintext fontsize=12];\n`;
  let n = 0;
  const sym = { cat: "•", alt: "|", star: "*", plus: "+", opt: "?", eps: "ε" };
  const walk = (node) => {
    const id = n++;
    const a = fp.ann.get(node);
    const label = node.type === "sym" ? `${node.c}\\n${node.pos}` : sym[node.type];
    dot += `  n${id} [label="${label.replace(/"/g, '\\"')}" ${node.type === "sym" ? `fontcolor="${c.accent}" fontname="Helvetica-Bold"` : ""} xlabel="${a ? `{${a.first.join(",")}} {${a.last.join(",")}}` : ""}" fontsize=12];\n`;
    for (const ch of [node.a, node.b]) if (ch) { const k = walk(ch); dot += `  n${id} -> n${k} [arrowhead=none];\n`; }
    return id;
  };
  walk(fp.root);
  return dot.replace("node [shape=plaintext", `forcelabels=true;\n  node [shape=plaintext`) + "}";
}
function testString() {
  if (!rState) buildAutomata();
  if (!rState) return;
  const s = $("rInput").value;
  const r = simulate(rState.m.dfa, s);
  $("rTestOut").innerHTML = `<span class="${r.accepted ? "yes" : "no"}">${r.accepted ? "✔ Accepted" : "✖ Rejected"}</span>
    <div>Path in the minimised DFA: <code>${esc(r.path.join(" → "))}</code>${r.stuck ? ` then no move on <code>${esc(r.stuck)}</code>` : !r.accepted ? " (not an accepting state)" : ""}</div>`;
  persist();
}

// ------------------------------------------------------------------ intermediate code
function generateCode() {
  const out = $("iOut");
  let stmts, gen, tr, dg;
  try { stmts = parseProgram($("iText").value); gen = generate(stmts); tr = treeGraph(stmts); dg = dag(stmts); }
  catch (e) { out.innerHTML = errBox(e); return; }
  let html = sec("Three-address code", `<pre>${esc(gen.tac.join("\n"))}</pre>`);
  html += sec("Quadruples", table("<th>#</th><th>op</th><th>arg1</th><th>arg2</th><th>result</th>",
    gen.quads.map((x, i) => `<tr><td>(${i})</td><td class="c">${esc(x.op)}</td><td>${esc(x.a1)}</td><td>${esc(x.a2)}</td><td>${esc(x.res)}</td></tr>`)));
  html += sec("Triples", table("<th>#</th><th>op</th><th>arg1</th><th>arg2</th>",
    gen.triples.map((x, i) => `<tr><td>(${i})</td><td class="c">${esc(x.op)}</td><td>${esc(x.a1)}</td><td>${esc(x.a2)}</td></tr>`)), "a result is referred to by the number of the triple that computes it");
  html += sec("Indirect triples", table("<th>Instruction</th><th>Triple</th>",
    gen.triples.map((x, i) => `<tr><td>${35 + i}</td><td>(${i})</td></tr>`)), "a list of pointers to the triples above, so code can be reordered without renumbering them");
  html += sec("Postfix notation", `<pre>${esc(gen.postfix.join("\n"))}</pre>`);
  html += sec("Syntax tree", `<div id="iTree"></div>`);
  html += sec("DAG of the basic block", `<div id="iDag"></div>
    <h3 style="margin-top:10px">Code from the DAG</h3><pre>${esc(dg.code.join("\n"))}</pre>
    ${dg.notes.length ? `<ul class="steps">${dg.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : `<p class="muted">No common subexpressions or constants to fold.</p>`}`,
    "each value is computed once; b0 is the value of b when the block starts");
  out.innerHTML = html;
  const c = palette();
  let dot = head("digraph", "ordering=out; nodesep=0.3; ranksep=0.4;") + `  node [shape=plaintext fontsize=13];\n`;
  for (const n of tr.nodes) dot += `  n${n.id} [label=${q(n.label)} ${n.kind === "leaf" ? `fontcolor="${c.accent}" fontname="Helvetica-Bold"` : ""}];\n`;
  for (const [a, b] of tr.edges) dot += `  n${a} -> n${b} [arrowhead=none];\n`;
  draw($("iTree"), dot + "}");
  let dd = head("digraph", "ordering=out; nodesep=0.35; ranksep=0.45;") + `  node [shape=ellipse fontsize=12];\n`;
  for (const n of dg.nodes) {
    const label = (n.leaf !== undefined ? n.leaf : n.op) + (n.labels.length ? `\\n${n.labels.join(", ")}` : "");
    dd += `  n${n.id} [label="${label.replace(/"/g, '\\"')}" ${n.leaf !== undefined ? `shape=plaintext fontcolor="${c.accent}"` : ""}];\n`;
    for (const k of n.kids) dd += `  n${n.id} -> n${k};\n`;
  }
  draw($("iDag"), dd + "}");
  persist();
}

// ------------------------------------------------------------------ page
function showTab(name) {
  for (const b of document.querySelectorAll(".cd-tab")) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".panel")) p.hidden = p.dataset.panel !== name;
  try { sessionStorage.setItem(STORE + ".tab", name); } catch {}
  ({ grammar: () => !$("gOut").innerHTML && analyseGrammar(), op: () => !$("oOut").innerHTML && analyseOp(), lr: () => !$("lOut").innerHTML && buildTable(),
    regex: () => !$("rOut").innerHTML && buildAutomata(), icg: () => !$("iOut").innerHTML && generateCode() })[name]();
}
function help() {
  modal({
    title: "Compiler Design Tools",
    html: `<ul style="padding-left:18px;line-height:1.7;margin:0">
      <li>Use these pages to check work done by hand or by your own programs: FIRST and FOLLOW sets, LL(1) and LR parsing tables, automata from regular expressions, and intermediate code.</li>
      <li><b>Grammars</b>: one rule per line, <code>A -&gt; &alpha; | &beta;</code>. Write symbols with spaces (<code>E -&gt; E + T</code>) or one character each as in lab manuals (<code>E-&gt;TE'</code>, with <code>id</code>, <code>num</code> and primes understood). &epsilon; can be <code>ε</code>, <code>#</code>, <code>@</code> or an empty alternative. The first rule's left side is the start symbol.</li>
      <li><b>LL(1)</b>: conflicting cells are red. <b>Remove left recursion</b> and <b>Left factor</b> show the transformed grammar step by step.</li>
      <li><b>Operator precedence</b>: checks that the grammar is an operator grammar (and offers to substitute, e.g. <code>E -&gt; E A E</code>), then shows LEADING and TRAILING, the relation table, the precedence functions f and g (or the cycle that rules them out) and a step-by-step parse.</li>
      <li><b>LR</b>: choose LR(0), SLR(1), LALR(1) or canonical LR(1). The item sets, the GOTO graph and the ACTION/GOTO table are shown; states with conflicts are outlined in red. On a conflict the parser shifts, as yacc does.</li>
      <li><b>Regular expressions</b>: Thompson's construction numbers the states as in the Dragon book. Tick <i>+ means or</i> for the textbook notation <code>(a+b)*abb</code>.</li>
      <li><b>Intermediate code</b>: three-address code, quadruples, triples and indirect triples, postfix, and the DAG of the block with the code it gives.</li>
      <li>To write the scanner or parser itself, use the <a href="/apps/code/?lang=lex">Lex &amp; Yacc lab</a>.</li>
    </ul>`,
  });
}

function boot() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch {}
  fill($("gExample"), GRAMMARS, ([, text, input]) => { $("gText").value = text; $("gInput").value = input; $("gMode").value = "auto"; analyseGrammar(); });
  fill($("oExample"), OP_GRAMMARS, ([, text, input]) => { $("oText").value = text; $("oInput").value = input; analyseOp(); });
  fill($("lExample"), GRAMMARS, ([, text, input]) => { $("lText").value = text; $("lInput").value = input; buildTable(); });
  fill($("rExample"), REGEXES, ([, text, plus, input]) => { $("rText").value = text; $("rPlus").checked = plus; $("rInput").value = input; buildAutomata(); });
  fill($("iExample"), PROGRAMS, ([, text]) => { $("iText").value = text; generateCode(); });
  $("gText").value = saved.g ?? GRAMMARS[0][1];
  $("gInput").value = saved.gIn ?? GRAMMARS[0][2];
  $("gMode").value = saved.gMode || "auto";
  $("oText").value = saved.o ?? OP_GRAMMARS[0][1];
  $("oInput").value = saved.oIn ?? OP_GRAMMARS[0][2];
  $("lText").value = saved.l ?? GRAMMARS[0][1];
  $("lInput").value = saved.lIn ?? GRAMMARS[0][2];
  $("lMethod").value = saved.lM || "slr";
  $("rText").value = saved.r ?? REGEXES[0][1];
  $("rPlus").checked = !!saved.rPlus;
  $("rInput").value = saved.rIn ?? REGEXES[0][3];
  $("iText").value = saved.i ?? PROGRAMS[0][1];
  $("gGo").onclick = analyseGrammar;
  $("gLeftRec").onclick = () => transform("rec");
  $("gFactor").onclick = () => transform("factor");
  $("gParse").onclick = parseLL1;
  $("gInput").onkeydown = (e) => { if (e.key === "Enter") parseLL1(); };
  $("oGo").onclick = analyseOp;
  $("oParse").onclick = parseOp;
  $("oInput").onkeydown = (e) => { if (e.key === "Enter") parseOp(); };
  $("lGo").onclick = buildTable;
  $("lMethod").onchange = buildTable;
  $("lParse").onclick = parseLR;
  $("lInput").onkeydown = (e) => { if (e.key === "Enter") parseLR(); };
  $("rGo").onclick = buildAutomata;
  $("rText").onkeydown = (e) => { if (e.key === "Enter") buildAutomata(); };
  $("rPlus").onchange = buildAutomata;
  $("rTest").onclick = testString;
  $("rInput").onkeydown = (e) => { if (e.key === "Enter") testString(); };
  $("iGo").onclick = generateCode;
  for (const id of ["gText", "oText", "lText", "iText"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ({ gText: analyseGrammar, oText: analyseOp, lText: buildTable, iText: generateCode })[id](); } });
  for (const b of document.querySelectorAll(".cd-tab")) b.onclick = () => showTab(b.dataset.tab);
  $("btnHelp").onclick = help;
  $("btnTheme").onclick = toggleTheme;
  window.addEventListener("foct-theme", () => {
    const tab = document.querySelector(".cd-tab.active").dataset.tab;
    for (const id of ["gOut", "oOut", "lOut", "rOut", "iOut"]) $(id).innerHTML = "";
    showTab(tab);
  });
  let tab = "grammar";
  try { tab = sessionStorage.getItem(STORE + ".tab") || new URLSearchParams(location.search).get("tab") || "grammar"; } catch {}
  showTab(["grammar", "op", "lr", "regex", "icg"].includes(tab) ? tab : "grammar");
}

boot();
