// Component models added automatically when a netlist uses them (like LTspice's standard library),
// and example circuits for common electronics labs.
//
// Diode and transistor models are the widely published manufacturer/PSpice parameter sets;
// the op-amp is a simple behavioural macro-model written for teaching.

const M = {};
const add = (names, text) => { for (const n of names) M[n.toUpperCase()] = text; };

add(["1N4148", "D1N4148", "1N914", "D1N914"], `.model 1N4148 D(Is=2.682n N=1.836 Rs=.5664 Ikf=44.17m Xti=3 Eg=1.11 Cjo=4p M=.3333 Vj=.5 Fc=.5 Isr=1.565n Nr=2 Bv=100 Ibv=100u Tt=11.54n)`);
add(["1N4007", "D1N4007", "1N4001", "D1N4001"], `.model 1N4007 D(Is=7.02767n Rs=.0341512 N=1.80803 Cjo=10p M=.3 Tt=100n Bv=1000 Ibv=50n)`);
add(["1N4733", "D1N4733", "ZENER5V1"], `.model 1N4733 D(Is=5.5f Rs=.85 N=1 Cjo=450p M=.33 Bv=5.1 Ibv=49m Nbv=1.3)`);
add(["1N750", "D1N750", "ZENER4V7"], `.model 1N750 D(Is=880.5E-18 Rs=.25 N=1 Xti=3 Eg=1.11 Cjo=175p M=.5516 Vj=.75 Fc=.5 Isr=1.859n Nr=2 Bv=4.7 Ibv=20.245m Nbv=1.6989 Ibvl=1.9556m Nbvl=14.976)`);
add(["LED", "LED_RED", "REDLED"], `.model LED_RED D(Is=93.2p Rs=42m N=3.73 Bv=4 Ibv=10u Cjo=2.97p Vj=.75 M=.333 Tt=4.32u)`);
add(["2N2222", "Q2N2222", "2N2222A"], `.model 2N2222 NPN(Is=14.34f Xti=3 Eg=1.11 Vaf=74.03 Bf=255.9 Ne=1.307 Ise=14.34f Ikf=.2847 Xtb=1.5 Br=6.092 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=7.306p Mjc=.3416 Vjc=.75 Fc=.5 Cje=22.01p Mje=.377 Vje=.75 Tr=46.91n Tf=411.1p Itf=.6 Vtf=1.7 Xtf=3 Rb=10)`);
add(["2N3904", "Q2N3904"], `.model 2N3904 NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)`);
add(["2N3906", "Q2N3906"], `.model 2N3906 PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10)`);
add(["BC547", "BC547B", "QBC547"], `.model BC547 NPN(Is=2.39E-14 Nf=1.008 Ise=3.545E-15 Ne=1.541 Bf=294.3 Ikf=.1357 Vaf=63.2 Nr=1.004 Isc=6.272E-14 Nc=1.243 Br=7.946 Ikr=.1144 Var=25.9 Rb=1 Irb=1E-6 Rbm=1 Re=.4683 Rc=.85 Xtb=0 Eg=1.11 Xti=3 Cje=1.358E-11 Vje=.65 Mje=.3279 Tf=4.391E-10 Xtf=120 Vtf=2.643 Itf=.7495 Cjc=3.728E-12 Vjc=.3997 Mjc=.2955 Xcjc=.6193 Fc=.9579)`);
add(["BC557", "BC557B"], `.model BC557 PNP(Is=1.02E-14 Nf=1.008 Ise=2.31E-15 Ne=1.392 Bf=297 Ikf=.06 Vaf=34.5 Nr=1.004 Isc=1E-14 Nc=1.3 Br=6.6 Ikr=.1 Var=19 Rb=1 Re=.5 Rc=.8 Cje=1.6E-11 Vje=.7 Mje=.35 Tf=6E-10 Cjc=1.2E-11 Vjc=.5 Mjc=.35 Fc=.9)`);
add(["2N7000"], `.model 2N7000 NMOS(Level=1 Vto=2.1 Kp=.12 Lambda=.01 Rd=1 Rs=.5 Cgso=20p Cgdo=8p Cbd=30p)`);
add(["BS250"], `.model BS250 PMOS(Level=1 Vto=-2.1 Kp=.06 Lambda=.01 Rd=2 Rs=1 Cgso=20p Cgdo=8p Cbd=30p)`);
add(["NMOS1", "NMOS_L1"], `.model NMOS1 NMOS(Level=1 Vto=0.7 Kp=110u Lambda=0.04 Gamma=0.4 Phi=0.65)`);
add(["PMOS1", "PMOS_L1"], `.model PMOS1 PMOS(Level=1 Vto=-0.7 Kp=50u Lambda=0.05 Gamma=0.57 Phi=0.65)`);

// Op-amps (subcircuits): pins  +in  -in  V+  V-  out  (same order as LTspice's UniversalOpamp)
const opamp = (name, gain, gbw, rout, drop) => `.subckt ${name} inp inn vcc vee out
* behavioural op-amp: open-loop gain ${gain}, gain-bandwidth ${gbw} Hz, output limited to the rails
Rin inp inn 2Meg
G1 0 n1 inp inn 1m
R1 n1 0 ${(gain * 1000).toExponential(3)}
C1 n1 0 ${(1e-3 / (2 * Math.PI * gbw)).toExponential(3)}
B1 n2 0 V = max(min(V(n1), V(vcc)-${drop}), V(vee)+${drop})
Rout n2 out ${rout}
.ends ${name}`;
add(["UA741", "LM741", "OPAMP741", "741"], opamp("UA741", 2e5, 1e6, 75, 1.5));
add(["LM358"], opamp("LM358", 1e5, 1e6, 50, 1.5));
add(["TL081", "TL071"], opamp("TL081", 2e5, 3e6, 50, 1.5));
add(["OPAMP", "IDEALOPAMP"], `.subckt OPAMP inp inn vcc vee out
* ideal op-amp (very high gain, output limited to the rails)
E1 n1 0 inp inn 1e6
B1 out 0 V = max(min(V(n1), V(vcc)), V(vee))
.ends OPAMP`);

export const MODELS = M;

// LTspice's 3-pin ideal "opamp" (opamp.sub): pins +in -in out, parameters Aol and GBW.
// Used instead of the 5-pin OPAMP above when a netlist connects only three pins.
export const OPAMP3 = `.subckt OPAMP inp inn out params: Aol=1e5 GBW=1e7
* ideal 3-pin op-amp: open-loop gain Aol, one pole at GBW/Aol, no supply limits
G1 0 n1 inp inn 1m
R1 n1 0 {Aol*1000}
C1 n1 0 {0.001/(6.283185*GBW)}
E1 out 0 n1 0 1
.ends OPAMP`;

export const EXAMPLES = {
  "RC low-pass: step response (transient)": `RC low-pass filter - step response
* A 5 V step charges the capacitor through R: time constant tau = R*C = 1 ms
V1 in 0 PULSE(0 5 0 1u 1u 5m 10m)
R1 in out 1k
C1 out 0 1u
.tran 10u 10m
.end
`,
  "RC low-pass: frequency response (AC)": `RC low-pass filter - Bode plot
* Cut-off frequency fc = 1/(2*pi*R*C) = 159 Hz (output is -3 dB there)
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 50 1 100k
.end
`,
  "Series RLC resonance (AC)": `Series RLC band-pass
* Resonance f0 = 1/(2*pi*sqrt(L*C)) = 5.03 kHz
V1 in 0 DC 0 AC 1
R1 in a 10
L1 a b 10m
C1 b out 100n
R2 out 0 100
.ac dec 100 100 100k
.end
`,
  "Diode I-V characteristic (DC sweep)": `Silicon diode forward characteristic (1N4148)
* VAM is a 0 V source used as an ammeter: i(VAM) is the diode current.
* It stays tiny until about 0.6 V, then rises steeply.
V1 in 0 0
VAM in a 0
D1 a 0 1N4148
.dc V1 0 0.9 2m
.end
`,
  "Voltage divider: DC operating point (.op)": `Voltage divider - DC operating point
* .op lists the DC voltage at every node and the current in every source.
* Expected: V(mid) = 9 * 4.7k / (10k + 4.7k) = 2.878 V
V1 in 0 9
R1 in mid 10k
R2 mid 0 4.7k
.op
.end
`,
  "Half-wave rectifier with filter": `Half-wave rectifier with capacitor filter
V1 in 0 SIN(0 12 50)
D1 in out 1N4007
C1 out 0 100u
RL out 0 1k
.tran 50u 100m
.end
`,
  "Full-wave bridge rectifier": `Full-wave bridge rectifier
V1 a b SIN(0 12 50)
D1 a out 1N4007
D2 b out 1N4007
D3 0 a 1N4007
D4 0 b 1N4007
C1 out 0 220u
RL out 0 1k
.tran 50u 80m
.end
`,
  "Zener voltage regulator": `Zener shunt regulator (5.1 V)
* Sweep the input from 0 to 15 V: the output stays near 5.1 V above the breakdown
VIN in 0 0
RS in out 220
DZ 0 out 1N4733
RL out 0 1k
.dc VIN 0 15 0.05
.end
`,
  "BJT common-emitter amplifier": `Common-emitter amplifier (2N3904)
VCC vcc 0 12
VIN in 0 SIN(0 10m 1k) AC 1
C1 in b 10u
R1 vcc b 47k
R2 b 0 10k
RC vcc c 4.7k
RE e 0 1k
CE e 0 100u
Q1 c b e 2N3904
C2 c out 10u
RL out 0 10k
.tran 10u 4m
.end
`,
  "Op-amp inverting amplifier (uA741)": `Inverting amplifier, gain = -Rf/Rin = -10
VCC vcc 0 15
VEE vee 0 -15
VIN in 0 SIN(0 0.5 1k)
RIN in inv 10k
RF inv out 100k
XU1 0 inv vcc vee out UA741
.tran 5u 3m
.end
`,
  "CMOS inverter transfer curve": `CMOS inverter voltage transfer characteristic
VDD vdd 0 5
VIN in 0 0
MP out in vdd vdd PMOS1 W=20u L=1u
MN out in 0 0 NMOS1 W=10u L=1u
.dc VIN 0 5 0.01
.end
`,
  "LTspice-style netlist": `* Exported from LTspice: View > SPICE Netlist (pasted unchanged)
V1 N001 0 SINE(0 1 1k) Rser=1
R1 N001 N002 1k
C1 N002 0 100n Rpar=1Meg
.tran 5m
.backanno
.end
`,
};
