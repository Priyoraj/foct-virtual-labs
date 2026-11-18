// Diagrams with Graphviz (viz.js, WebAssembly). Colours follow the page's light/dark theme.
import { instance } from "/runtimes/viz/viz.js";

let vizP = null;
const viz = () => (vizP ||= instance());

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
export function palette() {
  return {
    fg: css("--text", "#1f1d33"), muted: css("--muted", "#5d597c"), accent: css("--accent", "#3f51b5"),
    ok: css("--ok", "#2b9348"), bad: css("--bad", "#c62828"), soft: css("--navy-100", "#eceaff"), border: css("--border-strong", "#c9c6e0"),
  };
}

/** Quotes text for a DOT label. */
export const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

/** Common graph, node and edge attributes for the current theme. */
export function head(kind = "digraph", extra = "") {
  const c = palette();
  return `${kind} G {
  bgcolor="transparent"; pad=0.2; ${extra}
  node [fontname="Helvetica" fontsize=12 color="${c.fg}" fontcolor="${c.fg}"];
  edge [fontname="Helvetica" fontsize=11 color="${c.muted}" fontcolor="${c.fg}" arrowsize=0.7];
`;
}

export async function draw(el, dot) {
  el.classList.add("graph");
  el.textContent = "Drawing…";
  try {
    const v = await viz();
    const svg = v.renderSVGElement(dot);
    svg.removeAttribute("height");
    el.replaceChildren(svg);
  } catch (e) {
    el.textContent = "The diagram could not be drawn: " + (e && e.message ? e.message : e);
  }
}
