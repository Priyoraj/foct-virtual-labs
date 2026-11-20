// FoCT Virtual Labs - plain-language hints after a run, for things students try that a lab in the
// browser cannot do (pip, shell commands, starting other programs) and for missing Python packages.
// hintsFor() looks at the program and at what this run printed, and returns the hints to show.

const PIP_LINE = /^[ \t]*(?:[!%][ \t]*)?(?:pip3?|python3?[ \t]+-m[ \t]+pip|py[ \t]+-m[ \t]+pip|conda)[ \t]+install\b(.*)$/gim;
const NO_WINDOW = new Set(["tkinter", "_tkinter", "turtle"]);
const TOO_BIG = new Set(["tensorflow", "torch", "torchvision", "keras"]);

const norm = (s) => String(s).toLowerCase().replace(/[-_.]+/g, "-");

// What the Python lab has: pip names and import names, from Pyodide's list and the lab's extras.
let known = null;
function packages() {
  known ??= Promise.all([
    fetch("/runtimes/pyodide/pyodide-lock.json").then((r) => r.json()).catch(() => null),
    fetch("/runtimes/pywheels/index.json").then((r) => r.json()).catch(() => null),
  ]).then(([lock, extras]) => {
    const byName = new Map(), byImport = new Map();      // pip name -> import name; import name -> itself
    for (const p of Object.values((lock && lock.packages) || {})) {
      if (!p || !Array.isArray(p.imports) || !p.imports.length) continue;   // shared libraries
      byName.set(norm(p.name), p.imports[0]);
      for (const i of p.imports) byImport.set(i.toLowerCase(), i);
    }
    for (const [imp, e] of Object.entries(extras || {})) {
      byName.set(norm(e.name), imp);
      byImport.set(imp.toLowerCase(), imp);
    }
    return { byName, byImport };
  });
  return known;
}

function asked(lines) {                 // the package names on "pip install ..." lines
  const out = [];
  for (const rest of lines) {
    for (const w of rest.trim().split(/\s+/)) {
      if (!w || w.startsWith("-") || /[/\\]|\.(txt|whl)$|^(git\+|https?:)/i.test(w)) continue;
      const name = w.split(/[<>=!~[;@]/)[0];
      if (name && !out.some((n) => norm(n) === norm(name))) out.push(name);
    }
  }
  return out;
}

async function pythonHints(files, output) {
  const hints = [];
  const src = files.filter((f) => f.name.endsWith(".py")).map((f) => f.text).join("\n");

  const pip = [...src.matchAll(PIP_LINE)].map((m) => m[1]);
  if (pip.length && /SyntaxError/.test(output)) {
    const { byName, byImport } = await packages();
    const lines = ['Hint: "pip install" is a command for a terminal, and these labs have no terminal: the editor holds Python only.',
                   "There is nothing to install here. A package loads by itself when your program imports it."];
    for (const a of asked(pip)) {
      const imp = byName.get(norm(a)) || byImport.get(a.toLowerCase());
      lines.push(imp ? `  ${a}: already here, write   import ${imp}` : `  ${a}: not part of this lab (pip cannot add packages here)`);
    }
    lines.push("Delete the pip line and run again.");
    hints.push(lines.join("\n"));
  }

  const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(output);
  if (missing) {
    const top = missing[1].split(".")[0];
    const own = files.some((f) => f.name === `${top}.py`);
    if (NO_WINDOW.has(top)) {
      hints.push(`Hint: ${top} needs a desktop window, which a lab in the browser cannot open. For drawings and charts, use matplotlib: plots appear in the output.`);
    } else if (TOO_BIG.has(top)) {
      hints.push(`Hint: ${top} is too big to run in a browser. For machine learning, use scikit-learn (import sklearn).`);
    } else if (!own) {
      const { byName } = await packages();
      const imp = byName.get(norm(top));
      hints.push(imp && imp !== top
        ? `Hint: "${top}" is the name pip uses. In Python this package is   import ${imp}`
        : `Hint: ${top} is not part of this lab, and pip cannot add packages here. If ${top} is your own file, add it with + as ${top}.py.`);
    }
  }

  if (/emscripten does not support processes/.test(output) || /\bos\.(system|popen)\s*\(/.test(src)) {
    hints.push("Hint: Python programs here cannot start other programs (os.system, subprocess): the lab runs inside the browser, " +
               "with no operating system to run them in. os.system() does nothing and returns -1. To clear the output, use Clear.");
  }
  return hints;
}

/** The hints for one finished run: lang is the IDE's language, files the program, output what the run printed. */
export async function hintsFor(lang, files, output) {
  if (lang.runner === "python") return pythonHints(files, output);
  if (lang.runner === "java") {
    if (/Cannot run program "[^"]*"/.test(output) && /posix_spawn|error: 52|Function not implemented/.test(output)) {
      return ['Hint: Java programs here cannot start other programs (ProcessBuilder, Runtime.exec): the lab runs inside the browser. ' +
              'The "Possible reasons" and "Possible solutions" lines above are written for a desktop JDK; ignore them.'];
    }
    return [];
  }
  if (/\[system\("[^\n]*"\) is not available in the browser\]/.test(output)) {
    return ['Hint: only system("cls"), system("clear") and system("pause") work here. A program in the browser cannot start other programs.'];
  }
  return [];
}
