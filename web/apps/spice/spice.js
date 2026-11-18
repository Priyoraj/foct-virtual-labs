// FoCT Virtual Labs - SPICE simulator (ngspice in WebAssembly, waveforms with uPlot)
import uPlot from "/runtimes/spice/uplot/uPlot.esm.js";
import { MODELS, OPAMP3, EXAMPLES } from "./library.js";
import { toast, modal, saveToDisk, pickFiles, downloadBlob, toggleTheme, currentTheme, escapeHtml } from "/assets/js/foct.js";

const $ = (id) => document.getElementById(id);
const DRAFT = "foct.spice.draft";
const COLORS = ["#2f6fdb", "#e8590c", "#2b9348", "#c2185b", "#7b2cbf", "#0097a7", "#b08900", "#6d4c41", "#3f51b5", "#d81b60"];

let monaco, editor;
let worker = null, ready = null, runId = 0, pending = null, busy = false;
let last = null;            // {result, selected:Set, sweep, op}
let charts = [];
let fileName = "circuit.cir";
let fileHandle = null;

// ------------------------------------------------------------------ engine
function startWorker() {
  worker = new Worker(new URL("./spice-worker.js", import.meta.url), { type: "module" });
  ready = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") { resolve(m.version); return; }
      if (m.type === "result" && pending && m.id === pending.id) { const p = pending; pending = null; p.resolve(m); }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || "ngspice failed to start"));
      if (pending) { pending.reject(new Error("ngspice stopped unexpectedly: " + (e.message || "unknown error"))); pending = null; }
    };
  });
  ready.catch(() => {});
  const chip = $("engineChip");
  chip.className = "chip warn";
  $("engineText").textContent = "Starting ngspice…";
  ready.then((v) => { chip.className = "chip ok"; $("engineText").textContent = `${v} ready`; })
    .catch((e) => { chip.className = "chip bad"; $("engineText").textContent = "ngspice failed"; toast(e.message, "bad"); });
}

function simulate(netlist) {
  return new Promise((resolve, reject) => {
    pending = { id: ++runId, resolve, reject };
    worker.postMessage({ type: "run", id: runId, netlist });
  });
}

// ------------------------------------------------------------------ numbers
const SUFFIX = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
function spiceNum(s) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|mil|[tgkmunpf])?/i.exec(String(s).trim());
  if (!m) return NaN;
  return parseFloat(m[1]) * (m[2] ? SUFFIX[m[2].toLowerCase()] : 1);
}
const plainNum = (v) => String(+v.toPrecision(4));   // a number SPICE always understands

function eng(v, digits = 3) {
  if (v == null || !isFinite(v)) return "–";
  if (v === 0) return "0";
  const a = Math.abs(v);
  const units = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
  for (const [f, s] of units) if (a >= f * 0.9995) return (+(v / f).toPrecision(digits)) + s;
  return v.toExponential(2);
}
const fixed = (v) => (v == null || !isFinite(v) ? "–" : String(+v.toFixed(Math.abs(v) >= 100 ? 1 : 2)));

// ------------------------------------------------------------------ LTspice compatibility and model library
const DOT_CMD = /^\.(model|subckt|ends|tran|ac|dc|op|noise|tf|four|param|include|inc|lib|options?|ic|nodeset|end|print|plot|probe|meas(ure)?|save|global|func|temp|step|control|backanno)\b/i;

// SPICE always treats the first line as the title. Students often start straight with a component:
// it is an element if its two nodes are used elsewhere in the netlist (a title's words are not).
function firstLineIsCircuit(first, rest) {
  const t = first.trim();
  if (t.startsWith("*")) return false;
  if (DOT_CMD.test(t)) return true;
  if (!/^[RCLVIDQMEFGHXBJKSWTUZ]/i.test(t)) return false;
  const tok = t.split(/\s+/);
  if (tok.length < 3) return false;
  const used = new Set();
  for (const l of rest) if (!/^\s*[*.]/.test(l)) for (const x of l.trim().split(/[\s(),]+/).slice(1)) used.add(x.toLowerCase());
  const node = (n) => /^(0|gnd)$/i.test(n) || used.has(n.toLowerCase());
  return node(tok[1]) && node(tok[2]);
}

export function prepare(src) {
  const notes = [];
  const lines = src.replace(/\r\n?/g, "\n").replace(/[µμ]/g, "u").split("\n");
  const fi = lines.findIndex((l) => l.trim());
  if (fi >= 0 && firstLineIsCircuit(lines[fi], lines.slice(fi + 1))) {
    lines.unshift("* circuit");
    notes.push("Added a title line (SPICE ignores the first line of a netlist).");
  }
  const out = [];
  let inControl = false;
  const controlAnalyses = [];
  for (let line of lines) {
    const t = line.trim();
    if (inControl) {
      if (/^\.endc\b/i.test(t)) { inControl = false; continue; }
      if (/^(tran|ac|dc|op|noise)\b/i.test(t)) controlAnalyses.push("." + t);
      continue;
    }
    if (/^\.control\b/i.test(t)) { inControl = true; notes.push("Removed the .control block: results are plotted here instead."); continue; }
    if (/^\.backanno\b/i.test(t)) { notes.push("Removed .backanno (LTspice only)."); continue; }
    if (/^\.step\b/i.test(t)) { notes.push(`Ignored "${t}": .step sweeps are LTspice only. Change the value and simulate again.`); continue; }
    if (/^\.(lib|include|inc)\b/i.test(t)) {
      notes.push(`Removed "${t}": files cannot be included here. Built-in models are added automatically; for other parts paste their .model or .subckt text into the netlist.`);
      continue;
    }
    if (/^\.options?\b/i.test(t) && /\b(plot\w*|measdgt|nomarch|baudrate)\s*=/i.test(t)) {
      line = line.replace(/\s+(plot\w*|measdgt|nomarch|baudrate)\s*=\s*\S+/gi, "");
      notes.push("Removed LTspice-only .options.");
      if (/^\s*\.options?\s*$/i.test(line)) continue;
    }
    if (/^[VI]/i.test(t) && /\bSINE\s*\(/i.test(t)) { line = line.replace(/\bSINE\s*\(/gi, "SIN("); notes.push("SINE( changed to SIN(."); }
    if (/^[A-Z]/i.test(t) && /\s(Rser|Rpar|Cpar|Lser|Ipk|Vpk)\s*=\s*\S+/i.test(line)) {
      line = line.replace(/\s+(Rser|Rpar|Cpar|Lser|Ipk|Vpk)\s*=\s*\S+/gi, "");
      notes.push("Removed LTspice-only component parameters (Rser=, Rpar=, Cpar=, ...).");
    }
    if (/^\.tran\b/i.test(t)) {
      let args = t.split(/\s+/).slice(1);
      const mods = args.filter((a) => /^(startup|steady|nodiscard|step)$/i.test(a));
      if (mods.length) { args = args.filter((a) => !mods.includes(a)); notes.push(`Removed LTspice-only .tran options: ${mods.join(", ")}.`); }
      const nums = args.filter((a) => !/^uic$/i.test(a)), uic = args.length > nums.length ? ["uic"] : [];
      if (nums.length === 1 && spiceNum(nums[0]) > 0) {
        nums.unshift(plainNum(spiceNum(nums[0]) / 1000));
        notes.push(`".tran ${nums[1]}" (LTspice style) means simulate for ${nums[1]}s: added a time step of ${eng(spiceNum(nums[1]) / 1000)}s.`);
      } else if (nums.length >= 2 && spiceNum(nums[0]) === 0) {
        nums[0] = plainNum(spiceNum(nums[1]) / 1000);
        notes.push("A .tran time step of 0 is not allowed in ngspice: used the stop time / 1000.");
      }
      line = ".tran " + [...nums, ...uic].join(" ");
    }
    out.push(line);
  }
  if (controlAnalyses.length && !out.some((l) => /^\s*\.(tran|ac|dc|op|noise)\b/i.test(l))) {
    const endAt = out.findIndex((l) => /^\s*\.end\s*$/i.test(l));
    out.splice(endAt < 0 ? out.length : endAt, 0, controlAnalyses[0]);
    notes.push(`Used "${controlAnalyses[0]}" from the .control block.`);
  }
  // models and subcircuits used but not defined: take them from the built-in library
  const defined = new Set();
  for (const l of out) {
    const m = /^\s*\.(model|subckt)\s+(\S+)/i.exec(l);
    if (m) defined.add(m[2].toUpperCase());
  }
  const wanted = new Map();
  for (const l of out) {
    const t = l.trim();
    if (!/^[DQMJXZ]/i.test(t)) continue;
    const toks = t.split(/\s+/).slice(1).filter((x) => !x.includes("=") && !/^params:$/i.test(x));
    const isX = /^X/i.test(t);
    for (const tok of isX ? toks.slice(-1) : toks) {
      const k = tok.toUpperCase();
      if (!MODELS[k] || defined.has(k) || wanted.has(k)) continue;
      const text = isX && (k === "OPAMP" || k === "IDEALOPAMP") && toks.length - 1 === 3 ? OPAMP3 : MODELS[k];
      wanted.set(k, { used: tok, text });
    }
  }
  const added = [...wanted.values()].map(({ used, text }) =>
    text.replace(/^(\.model|\.subckt)\s+\S+/im, `$1 ${used}`).replace(/^\.ends\s+\S+/im, `.ends ${used}`));
  if (added.length) notes.push(`Added built-in models: ${[...wanted.values()].map((w) => w.used).join(", ")}.`);
  let endAt = out.findIndex((l) => /^\s*\.end\s*$/i.test(l));
  if (endAt < 0) { out.push(".end"); endAt = out.length - 1; }
  out.splice(endAt, 0, ...added);
  const dc = /^\s*\.dc\s+(\S+)/im.exec(out.join("\n"));
  return { text: out.join("\n"), notes: [...new Set(notes)], sweep: dc ? dc[1] : null };
}

// ------------------------------------------------------------------ run
async function run() {
  if (busy || !editor) return;
  busy = true;
  try { await runInner(); } finally { busy = false; }
}

async function runInner() {
  const { text, notes, sweep } = prepare(editor.getValue());
  if (!/^\s*\.(tran|ac|dc|op|noise|tf|sens|pz|disto)\b/im.test(text)) {
    toast("Add an analysis line, for example .tran 10u 10m, .ac dec 20 1 100k, .dc V1 0 5 0.1 or .op", "bad", 6000);
    return;
  }
  setRunning(true);
  $("status").textContent = "Simulating…";
  const slow = setTimeout(() => toast("Still simulating… press Stop to cancel. A very small time step makes runs slow.", "", 6000), 20000);
  let r;
  try {
    await ready;
    r = await simulate(text);
  } catch (e) {
    if (e.message !== "stopped") {
      showLog(notes, [String(e.message || e)], "");
      showPane("log");
      $("status").textContent = "Simulation failed";
    }
    return;
  } finally {
    clearTimeout(slow);
    setRunning(false);
  }
  const errors = (r.errors || []).concat(r.error ? [r.error] : []);
  const res = r.result;
  const problems = showLog(notes, errors, r.info || "");
  const adj = (notes.length ? ` · ${notes.length} adjustment${notes.length > 1 ? "s" : ""}` : "")
    + (problems ? ` · ${problems} warning${problems > 1 ? "s" : ""}` : "")
    + (notes.length || problems ? " (see Log)" : "");
  if (!res || !res.numPoints || !res.data || !res.data.length) {
    last = null;
    clearPlot(`<p><b>No results.</b> ngspice could not simulate this netlist. The <a href="#" data-goto="log">Log</a> shows what went wrong.</p>`);
    $("dataTable").innerHTML = "";
    $("btnCsv").disabled = $("btnPng").disabled = true;
    showPane("log");
    $("status").textContent = "Simulation failed" + adj;
    return;
  }
  if (res.numPoints === 1 || /operating point/i.test(res.header || "")) {
    last = { result: res, op: true, selected: new Set() };
    clearPlot(`<p><b>DC operating point.</b> The node voltages and source currents are in the <a href="#" data-goto="data">Data</a> tab.</p>`);
    renderOp(res);
    $("btnCsv").disabled = false;
    $("btnPng").disabled = true;
    showPane("data");
    $("status").textContent = `Operating point in ${r.ms} ms${adj}`;
    saveDraft();
    return;
  }
  last = { result: res, sigs: orderSignals(res), selected: defaultSelection(res, last), sweep };
  renderSeries();
  renderData();
  $("btnCsv").disabled = $("btnPng").disabled = false;
  showPane("plot");
  $("status").textContent = `Simulated in ${r.ms} ms · ${res.numPoints} points · ${res.data.length - 1} signals${adj}`;
  saveDraft();
}

function setRunning(on) {
  $("btnRun").hidden = on;
  $("btnStop").hidden = !on;
}

function stop() {
  if (!pending) return;
  const p = pending;
  pending = null;
  worker.terminate();
  p.reject(new Error("stopped"));
  startWorker();
  $("status").textContent = "Stopped";
}

// ------------------------------------------------------------------ results
const isComplex = (res) => res.dataType === "complex";
const kindOf = (d) => (d.type === "current" || /^i\(/i.test(d.name) || /#branch/i.test(d.name) ? "A" : "V");
const realOf = (v) => (typeof v === "object" ? v.real : v);

function defaultSelection(res, prev) {
  const x = res.data[0].values.map(realOf);
  const cx = isComplex(res);
  const sigs = res.data.slice(1);
  if (prev && prev.result && !prev.op) {
    const keep = sigs.map((d) => d.name).filter((n) => prev.selected.has(n));
    if (keep.length) return new Set(keep);
  }
  const varies = (d) => {
    let lo = Infinity, hi = -Infinity;
    for (const v of d.values) {
      const y = typeof v === "object" ? Math.hypot(v.real, v.img) : v;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    return cx ? hi > 1e-12 : hi - lo > 1e-9 * Math.max(1, Math.abs(hi), Math.abs(lo));
  };
  const sameAsX = (d) => !cx && d.values.every((v, i) => Math.abs(v - x[i]) <= 1e-9 * Math.max(1, Math.abs(x[i])));
  const top = (d) => !d.name.includes(".");        // skip nodes inside subcircuits (xu1.n1)
  let pick = sigs.filter((d) => kindOf(d) === "V" && top(d) && varies(d) && !sameAsX(d));
  const io = pick.filter((d) => /^v\((v?in|v?out|input|output|in\d|out\d)\)$/i.test(d.name));
  if (io.length) pick = io;
  if (!pick.length) {
    // currents: positive ones first, and skip one that is just the negative of another (i(V1) = -i(VAM))
    const peak = (d) => Math.max(...d.values.map(realOf));
    const mirror = (a, b) => !cx && a.values.every((v, i) => Math.abs(v + b.values[i]) <= 1e-12 + 1e-6 * Math.abs(v));
    for (const d of sigs.filter((s) => kindOf(s) === "A" && varies(s)).sort((a, b) => peak(b) - peak(a))) {
      if (!pick.some((p) => mirror(p, d))) pick.push(d);
    }
  }
  if (!pick.length) pick = sigs.filter((d) => kindOf(d) === "V" && top(d));
  if (!pick.length) pick = sigs;
  return new Set(pick.slice(0, 6).map((d) => d.name));
}

// Signals in display order (node voltages, then currents, then subcircuit internals), each with its colour.
function orderSignals(res) {
  const rank = (d) => (d.name.includes(".") ? 2 : kindOf(d) === "A" ? 1 : 0);
  return res.data.slice(1).map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(({ d }, k) => ({ ...d, color: COLORS[k % COLORS.length] }));
}

function renderSeries() {
  const box = $("series");
  box.textContent = "";
  last.sigs.forEach((d) => {
    const l = document.createElement("label");
    l.title = kindOf(d) === "A" ? "Current" : "Voltage";
    l.innerHTML = `<input type="checkbox" ${last.selected.has(d.name) ? "checked" : ""}><span class="sw" style="background:${d.color}"></span>${escapeHtml(d.name)}`;
    l.querySelector("input").onchange = (e) => {
      if (e.target.checked) last.selected.add(d.name); else last.selected.delete(d.name);
      renderCharts();
    };
    box.appendChild(l);
  });
}

function clearPlot(html) {
  for (const c of charts) c.destroy();
  charts = [];
  $("series").textContent = "";
  $("charts").innerHTML = `<div class="placeholder">${html}</div>`;
  for (const a of $("charts").querySelectorAll("[data-goto]")) a.addEventListener("click", (e) => { e.preventDefault(); showPane(a.dataset.goto); });
}

function axisColors() {
  const dark = currentTheme() === "dark";
  return { stroke: dark ? "#aeabc9" : "#5d597c", grid: dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.08)" };
}

function xLabel(res, sweep) {
  const x = res.data[0];
  if (x.type === "time" || /^time$/i.test(x.name)) return "Time (s)";
  if (x.type === "frequency" || /^frequency$/i.test(x.name)) return "Frequency (Hz)";
  if (sweep) return /^temp$/i.test(sweep) ? "Temperature (°C)" : `${sweep} (${/^i/i.test(sweep) ? "A" : "V"})`;
  return x.name;
}

function renderCharts() {
  for (const c of charts) c.destroy();
  charts = [];
  const box = $("charts");
  box.textContent = "";
  if (!last || last.op) return;
  const res = last.result;
  const xs = res.data[0].values.map(realOf);
  const sigs = last.sigs.filter((d) => last.selected.has(d.name));
  const xName = xLabel(res, last.sweep);
  if (!sigs.length) { box.innerHTML = `<div class="placeholder">Tick a signal above to plot it.</div>`; return; }
  if (isComplex(res)) {
    const mag = sigs.map((d) => d.values.map((c) => { const m = Math.hypot(c.real, c.img); return m > 0 ? 20 * Math.log10(m) : null; }));
    const ph = sigs.map((d) => d.values.map((c) => (c.real || c.img ? Math.atan2(c.img, c.real) * 180 / Math.PI : null)));
    makeChart(box, "Magnitude (dB)", xName, xs, sigs, mag, { log: true, unit: "dB" });
    makeChart(box, "Phase (degrees)", xName, xs, sigs, ph, { log: true, unit: "°" });
  } else {
    const hasA = sigs.some((d) => kindOf(d) === "A"), hasV = sigs.some((d) => kindOf(d) === "V");
    makeChart(box, hasA && hasV ? "Voltage (left axis) and current (right axis)" : hasA ? "Current (A)" : "Voltage (V)",
      xName, xs, sigs, sigs.map((d) => d.values), { log: false });
  }
  fitCharts();
}

function logTicks(u, vals) {
  const many = Math.log10(u.scales.x.max / u.scales.x.min) > 3;
  return vals.map((v) => {
    const m = v / 10 ** Math.floor(Math.log10(v) + 1e-9);
    return (many ? Math.abs(m - 1) < 1e-6 : [1, 2, 5].some((k) => Math.abs(m - k) < 1e-6)) ? eng(v) : "";
  });
}

function makeChart(box, title, xName, xs, sigs, ys, { log, unit }) {
  const holder = document.createElement("div");
  holder.className = "chart-box";
  holder.innerHTML = `<div class="chart-title">${escapeHtml(title)}</div>`;
  box.appendChild(holder);
  const { stroke, grid } = axisColors();
  const fmtY = unit ? (v) => fixed(v) + unit : null;
  const twoScales = !unit && sigs.some((d) => kindOf(d) === "A") && sigs.some((d) => kindOf(d) === "V");
  const onlyA = !unit && !sigs.some((d) => kindOf(d) === "V");
  const axis = { stroke, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } };
  const opts = {
    width: Math.max(280, box.clientWidth - 2),
    height: 220,
    scales: { x: { time: false, distr: log ? 3 : 1, log: 10, range: (u, min, max) => [min, max] }, V: { auto: true }, A: { auto: true } },
    axes: [
      { ...axis, label: xName, labelSize: 22, values: log ? logTicks : (u, vals) => vals.map((v) => eng(v)) },
      { ...axis, scale: "V", size: 70, values: (u, vals) => vals.map((v) => (fmtY ? fmtY(v) : eng(v) + (onlyA ? "A" : "V"))) },
      ...(twoScales ? [{ ...axis, scale: "A", side: 1, size: 70, grid: { show: false }, values: (u, vals) => vals.map((v) => eng(v) + "A") }] : []),
    ],
    series: [
      { label: xName.replace(/ \(.*\)$/, ""), value: (u, v) => (v == null ? "–" : eng(v, 4)) },
      ...sigs.map((d) => ({
        label: d.name, stroke: d.color, width: 1.6, spanGaps: false,
        scale: twoScales && kindOf(d) === "A" ? "A" : "V",
        value: (u, v) => (v == null ? "–" : fmtY ? fmtY(v) : eng(v, 4) + kindOf(d)),
      })),
    ],
    cursor: { drag: { x: true, y: false, setScale: true } },
    legend: { live: true },
  };
  charts.push(new uPlot(opts, [xs, ...ys], holder));
}

// Size the plots to fill the pane (titles and legends take their own height).
function fitCharts() {
  if (!charts.length) return;
  const r = $("charts").getBoundingClientRect();
  if (r.width < 60 || r.height < 60) return;           // pane hidden
  const n = charts.length;
  const extra = charts.reduce((s, c) => s + Math.max(0, c.root.parentElement.offsetHeight - c.height), 0);
  const h = Math.max(150, Math.floor((r.height - extra - (n - 1) * 10) / n) - 2);
  const w = Math.max(280, Math.floor(r.width) - 2);
  for (const c of charts) if (c.width !== w || c.height !== h) c.setSize({ width: w, height: h });
}

function renderData() {
  const res = last.result;
  const cols = res.data;
  const n = Math.min(res.numPoints, 500);
  const cx = isComplex(res);
  const head = cols.map((c, i) => (i > 0 && cx ? `<th>|${escapeHtml(c.name)}|</th><th>phase ${escapeHtml(c.name)}</th>` : `<th>${escapeHtml(c.name)}</th>`)).join("");
  const rows = [];
  for (let r = 0; r < n; r++) {
    rows.push("<tr>" + cols.map((c, i) => {
      const v = c.values[r];
      if (typeof v === "object") {
        if (i === 0) return `<td>${eng(v.real, 5)}</td>`;
        return `<td>${eng(Math.hypot(v.real, v.img), 5)}</td><td>${(Math.atan2(v.img, v.real) * 180 / Math.PI).toFixed(2)}°</td>`;
      }
      return `<td>${eng(v, 5)}</td>`;
    }).join("") + "</tr>");
  }
  $("dataTable").innerHTML = `<p class="muted">${res.numPoints > n ? `First ${n} of ${res.numPoints} points. Download the CSV for all of them.` : `${res.numPoints} points.`}</p><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderOp(res) {
  const rows = res.data.map((d) => {
    const v = realOf(d.values[0]);
    return `<tr><td style="text-align:left">${escapeHtml(d.name)}</td><td>${eng(v, 5)}${kindOf(d)}</td><td>${v.toPrecision(6)}</td></tr>`;
  });
  $("dataTable").innerHTML = `<p class="muted">DC operating point: the voltage of every node (to ground) and the current in every voltage source.
    A source's current is negative when it delivers power (current leaves its + terminal).</p>
    <table><thead><tr><th style="text-align:left">Signal</th><th>Value</th><th>Exact</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function toCsv() {
  const res = last.result;
  const cx = isComplex(res);
  if (last.op) return ["signal,value", ...res.data.map((d) => `${d.name},${realOf(d.values[0])}`)].join("\r\n");
  const head = res.data.map((c, i) => (i > 0 && cx ? `${c.name} re,${c.name} im` : c.name)).join(",");
  const lines = [head];
  for (let r = 0; r < res.numPoints; r++) {
    lines.push(res.data.map((c, i) => {
      const v = c.values[r];
      if (typeof v === "object") return i === 0 ? v.real : `${v.real},${v.img}`;
      return v;
    }).join(","));
  }
  return lines.join("\r\n");
}

function exportPng() {
  if (!charts.length) return;
  const canvases = charts.map((c) => c.ctx.canvas);
  const w = Math.max(...canvases.map((c) => c.width));
  const h = canvases.reduce((s, c) => s + c.height, 0);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  ctx.fillStyle = currentTheme() === "dark" ? "#1b1a2c" : "#ffffff";
  ctx.fillRect(0, 0, w, h);
  let y = 0;
  for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height; }
  out.toBlob((b) => downloadBlob(fileName.replace(/\.\w+$/, "") + ".png", b), "image/png");
}

function showLog(notes, errors, info) {
  const lines = [];
  for (const n of notes) lines.push(`<span class="n">ℹ ${escapeHtml(n)}</span>`);
  let problems = 0;
  for (const e of errors) {
    const t = e.trim();
    if (/^note:/i.test(t)) { lines.push(`<span class="n">ℹ ${escapeHtml(t)}</span>`); continue; }
    problems++;
    lines.push(`<span class="${/error|fatal|abort/i.test(t) ? "e" : "w"}">${escapeHtml(t)}</span>`);
  }
  const text = (info || "")
    .replace(/ngspice \d+ -> /g, "")
    .replace(/^Note: No compatibility mode selected!\s*$/m, "")
    .replace(/^binary raw file.*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text) lines.push("", escapeHtml(text));
  $("log").innerHTML = lines.join("\n") || "No messages.";
  $("logBadge").hidden = !problems;
  return problems;
}

function showPane(name) {
  for (const b of document.querySelectorAll(".rtab")) b.classList.toggle("active", b.dataset.pane === name);
  for (const p of document.querySelectorAll(".rbody > [data-pane]")) p.hidden = p.dataset.pane !== name;
  if (name === "plot" && last && !last.op) renderCharts();
}

// ------------------------------------------------------------------ files, examples, help
function setNetlist(text, name, handle = null) {
  editor.pushUndoStop();
  editor.executeEdits("load", [{ range: editor.getModel().getFullModelRange(), text }]);
  editor.pushUndoStop();
  editor.setPosition({ lineNumber: 1, column: 1 });
  fileName = name;
  fileHandle = handle;
  last = null;
}

async function saveNetlist(saveAs = false) {
  const r = await saveToDisk(fileName, editor.getValue(), { handle: fileHandle, saveAs, mime: "text/plain", description: "SPICE netlist" });
  if (!r) return;
  fileHandle = r.handle;
  if (r.name) fileName = r.name;
  toast(r.method === "file" ? `Saved ${fileName}.` : `${fileName} downloaded to your Downloads folder.`);
}

async function openNetlist() {
  const [f] = await pickFiles({ accept: ".cir,.net,.sp,.spice,.ckt,.txt,.asc", multiple: false });
  if (!f) return;
  if (/\.asc$/i.test(f.name)) {
    modal({ title: "LTspice schematic", html: `<p><code>${escapeHtml(f.name)}</code> is an LTspice <b>schematic</b>, which only LTspice can read.
      Open it in LTspice, choose <i>View &rarr; SPICE Netlist</i>, and copy the netlist into this editor (or save it as a <code>.net</code> file and open that).</p>` });
    return;
  }
  setNetlist(await f.file.text(), f.name, f.handle);
  toast(`Opened ${f.name}. Press Simulate.`);
}

function loadExample(title) {
  setNetlist(EXAMPLES[title], title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".cir");
  run();
}

function showModels() {
  const names = {};
  for (const [alias, text] of Object.entries(MODELS)) {
    const m = /^\.(model|subckt)\s+(\S+)(?:\s+(\w+)\()?/im.exec(text);
    const key = m[2];
    names[key] ||= { kind: m[1] === "subckt" ? "op-amp" : { D: "diode", NPN: "NPN transistor", PNP: "PNP transistor", NMOS: "N-channel MOSFET", PMOS: "P-channel MOSFET" }[m[3].toUpperCase()] || m[3], aliases: [] };
    if (alias !== key.toUpperCase()) names[key].aliases.push(alias);
  }
  const order = ["diode", "NPN transistor", "PNP transistor", "N-channel MOSFET", "P-channel MOSFET", "op-amp"];
  const sorted = Object.entries(names).sort((a, b) => order.indexOf(a[1].kind) - order.indexOf(b[1].kind));
  modal({
    title: "Built-in component models",
    html: `<p>Use these names in your netlist; the model is added automatically (like LTspice's standard library).</p>
      <table style="font-size:.86rem;border-collapse:collapse;width:100%">${sorted.map(([n, v]) =>
        `<tr><td style="padding:3px 8px;font-family:var(--mono);font-weight:700">${escapeHtml(n)}</td><td style="padding:3px 8px">${escapeHtml(v.kind)}</td><td style="padding:3px 8px;font-family:var(--mono);color:var(--faint)">${escapeHtml(v.aliases.join(", "))}</td></tr>`).join("")}</table>
      <p>Op-amps have the pins <code>+in -in V+ V- out</code>, for example <code>XU1 0 inv vcc vee out UA741</code>.
      LTspice's 3-pin <code>opamp</code> (<code>XU1 inp inn out opamp Aol=100K GBW=10Meg</code>) also works.</p>`,
  });
}

function help() {
  modal({
    title: "SPICE simulator help",
    html: `<ul style="padding-left:18px;line-height:1.7;margin:0">
      <li>A netlist starts with a <b>title line</b>, then one component per line (<code>R1 in out 1k</code> is resistor R1 from node <i>in</i> to node <i>out</i>; node <code>0</code> is ground), then an <b>analysis</b>:
        <code>.tran 10u 10m</code> (time), <code>.ac dec 20 1 100k</code> (frequency), <code>.dc V1 0 5 0.1</code> (sweep) or <code>.op</code> (bias point). Press <b>Simulate</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>).</li>
      <li>Values use SPICE suffixes: <code>k</code>, <code>meg</code>, <code>m</code> (milli), <code>u</code>, <code>n</code>, <code>p</code>. Careful: <code>M</code> also means milli; write <code>meg</code> for mega.</li>
      <li>Tick the signals to plot. Drag across a plot to zoom in; double-click it to zoom out. The legend shows the values under the mouse.</li>
      <li><b>From LTspice:</b> open your schematic in LTspice, choose <i>View &rarr; SPICE Netlist</i>, and paste the netlist here. LTspice-only details (<code>SINE</code>, <code>Rser=</code>, <code>.backanno</code>, one-value <code>.tran</code>) are adjusted automatically; the Log tab lists the changes. <code>.step</code> sweeps are not supported.</li>
      <li>Common parts are built in (1N4148, 1N4007, Zeners, red LED, 2N2222, 2N3904, 2N3906, BC547, BC557, 2N7000, uA741, LM358, TL081): see <i>Examples &rarr; Built-in component models</i>. For any other part, paste its <code>.model</code> or <code>.subckt</code> text into the netlist.</li>
      <li>Prefer drawing circuits? The <a href="/apps/circuit/">Circuit Simulator</a> lets you build schematics and watch the current flow.</li>
      <li>Your netlists are saved on your computer with <b>Save</b>; nothing is stored on the lab server.</li>
    </ul>`,
  });
}

function saveDraft() {
  try { localStorage.setItem(DRAFT, editor.getValue()); } catch {}
}

// ------------------------------------------------------------------ editor & boot
function loadMonaco() {
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
    window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
  });
}

function registerSpice() {
  monaco.languages.register({ id: "spice", extensions: [".cir", ".net", ".sp"] });
  monaco.languages.setMonarchTokensProvider("spice", {
    ignoreCase: true,
    keywords: ["dc", "ac", "sin", "sine", "pulse", "pwl", "exp", "sffm", "dec", "oct", "lin", "uic", "params"],
    tokenizer: {
      root: [
        [/^\s*\*.*$/, "comment"],
        [/^\s*\.[a-z]+/, "keyword"],
        [/^\s*\+/, "delimiter"],
        [/^\s*[a-z][\w.#$:-]*/, "type.identifier"],
        [/;.*$/, "comment"],
        [/[a-z_][\w#$:.-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?[a-z]*/, "number"],
        [/[{}()=,]/, "delimiter"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration("spice", {
    comments: { lineComment: "*" },
    brackets: [["(", ")"], ["{", "}"]],
    autoClosingPairs: [{ open: "(", close: ")" }, { open: "{", close: "}" }],
  });
}

function initMenu() {
  const menu = $("menu"), btn = $("btnMenu");
  for (const title of Object.keys(EXAMPLES)) {
    const b = document.createElement("button");
    b.textContent = title;
    b.onclick = () => { menu.hidden = true; loadExample(title); };
    $("examples").appendChild(b);
  }
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
  menu.addEventListener("click", (e) => {
    const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
    if (!cmd) return;
    menu.hidden = true;
    ({ models: showModels, help, theme: toggleTheme })[cmd]?.();
  });
}

function initSplit() {
  const sp = $("vsplit"), left = document.querySelector(".left"), lab = document.querySelector(".lab");
  let drag = false;
  sp.addEventListener("pointerdown", (e) => { drag = true; sp.classList.add("drag"); sp.setPointerCapture(e.pointerId); });
  sp.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const r = lab.getBoundingClientRect();
    const vertical = matchMedia("(max-width: 860px)").matches;
    const pct = vertical ? ((e.clientY - r.top) / r.height) * 100 : ((e.clientX - r.left) / r.width) * 100;
    left.style.flex = `0 0 ${Math.min(75, Math.max(20, pct))}%`;
  });
  sp.addEventListener("pointerup", () => { drag = false; sp.classList.remove("drag"); });
}

async function boot() {
  startWorker();
  monaco = await loadMonaco();
  registerSpice();
  let draft = "";
  try { draft = localStorage.getItem(DRAFT) || ""; } catch {}
  editor = monaco.editor.create($("editor"), {
    value: draft || EXAMPLES[Object.keys(EXAMPLES)[0]],
    language: "spice",
    theme: currentTheme() === "dark" ? "vs-dark" : "vs",
    automaticLayout: true,
    fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 15,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
  });
  window.addEventListener("foct-theme", () => { monaco.editor.setTheme(currentTheme() === "dark" ? "vs-dark" : "vs"); if (last && !last.op) renderCharts(); });
  editor.onDidChangeCursorPosition((e) => { $("cursor").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
  editor.onDidChangeModelContent(() => { clearTimeout(boot.t); boot.t = setTimeout(saveDraft, 500); });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
  editor.addCommand(monaco.KeyCode.F5, run);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveNetlist());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, openNetlist);
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "enter") { e.preventDefault(); run(); }
    else if (e.key === "F5") { e.preventDefault(); run(); }
    else if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); saveNetlist(e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && k === "o") { e.preventDefault(); openNetlist(); }
  });
  $("btnRun").onclick = run;
  $("btnStop").onclick = stop;
  $("btnSave").onclick = () => saveNetlist();
  $("btnOpen").onclick = openNetlist;
  $("btnNew").onclick = () => {
    setNetlist("My circuit\n* one component per line, then an analysis such as .tran, .ac, .dc or .op\n\n.end\n", "circuit.cir");
    editor.setPosition({ lineNumber: 3, column: 1 });
    editor.focus();
  };
  $("btnCsv").onclick = () => last && downloadBlob(fileName.replace(/\.\w+$/, "") + ".csv", new Blob([toCsv()], { type: "text/csv" }));
  $("btnPng").onclick = exportPng;
  for (const b of document.querySelectorAll(".rtab")) b.onclick = () => showPane(b.dataset.pane);
  let raf = 0;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitCharts); }).observe($("charts"));
  initMenu();
  initSplit();
  clearPlot(`<p><b>SPICE simulator</b> &mdash; ngspice running in your browser.</p>
    <p>Edit the netlist on the left and press <b>Simulate</b> (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>), or pick one of the <b>Examples</b>.
    LTspice users: paste the netlist from <i>View &rarr; SPICE Netlist</i>.</p>`);
  editor.focus();
}

boot().catch((e) => { console.error(e); $("status").textContent = "Could not start: " + (e.message || e); });
