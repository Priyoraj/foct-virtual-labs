// ngspice (eecircuit-engine, WebAssembly) in a Web Worker.
import { Simulation } from "/runtimes/spice/eecircuit-engine.mjs";

let sim = null;
const ready = (async () => {
  sim = new Simulation();
  await sim.start();
  const banner = (sim.getInitInfo() || "").match(/ngspice-[\d.]+/);
  postMessage({ type: "ready", version: banner ? banner[0] : "ngspice" });
})();

onmessage = async (e) => {
  const m = e.data;
  if (m.type !== "run") return;
  try {
    await ready;
    sim.setNetList(m.netlist);
    const t0 = performance.now();
    const result = await sim.runSim();
    postMessage({
      type: "result", id: m.id, ms: Math.round(performance.now() - t0),
      result, info: sim.getInfo(), errors: sim.getError().filter((x) => x && x.trim()),
    });
  } catch (err) {
    postMessage({ type: "result", id: m.id, error: String((err && err.message) || err), errors: sim ? sim.getError() : [] });
  }
};
