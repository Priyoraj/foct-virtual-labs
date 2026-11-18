// Example networks for FoCT NetSim (same format as saved .foctnet files).
const pc = (id, name, x, y, ip, mask, gw) => ({ id, type: "pc", name, x, y, gateway: gw, ifaces: [{ name: "Fa0", ip, mask }] });
const dev = (id, type, name, x, y, extra = {}) => ({ id, type, name, x, y, ...extra });

export const EXAMPLES = {
  "Two PCs and a switch": {
    note: "Open PC1's Terminal and type: ping 192.168.1.20 — watch ARP find the MAC address first, then the echo request and reply.",
    data: {
      format: "foct-netsim", version: 1,
      devices: [
        pc(1, "PC1", 180, 210, "192.168.1.10", "255.255.255.0"),
        pc(2, "PC2", 620, 210, "192.168.1.20", "255.255.255.0"),
        dev(3, "switch", "Switch1", 400, 210),
      ],
      links: [[1, "Fa0", 3, "Fa0/1"], [2, "Fa0", 3, "Fa0/2"]],
    },
  },
  "Two LANs joined by a router": {
    note: "From PC1 try: ping 192.168.2.100 and tracert 192.168.2.100. Check Router1 > Tables for its ARP cache and routes.",
    data: {
      format: "foct-netsim", version: 1,
      devices: [
        pc(1, "PC1", 110, 130, "192.168.1.10", "255.255.255.0", "192.168.1.1"),
        pc(2, "PC2", 110, 330, "192.168.1.11", "255.255.255.0", "192.168.1.1"),
        dev(3, "switch", "Switch1", 270, 230),
        dev(4, "router", "Router1", 450, 230, { ifaces: [{ name: "Gig0/0", ip: "192.168.1.1", mask: "255.255.255.0" }, { name: "Gig0/1", ip: "192.168.2.1", mask: "255.255.255.0" }, { name: "Gig0/2" }, { name: "Gig0/3" }] }),
        dev(5, "switch", "Switch2", 630, 230),
        pc(6, "PC3", 790, 130, "192.168.2.10", "255.255.255.0", "192.168.2.1"),
        { id: 7, type: "server", name: "Server1", x: 790, y: 330, gateway: "192.168.2.1", ifaces: [{ name: "Fa0", ip: "192.168.2.100", mask: "255.255.255.0" }] },
      ],
      links: [[1, "Fa0", 3, "Fa0/1"], [2, "Fa0", 3, "Fa0/2"], [3, "Fa0/8", 4, "Gig0/0"], [4, "Gig0/1", 5, "Fa0/8"], [5, "Fa0/1", 6, "Fa0"], [5, "Fa0/2", 7, "Fa0"]],
    },
  },
  "Three routers with static routes": {
    note: "From PC-A run: tracert 10.0.3.10 — each router on the path answers with ICMP time exceeded. Remove a static route and try again.",
    data: {
      format: "foct-netsim", version: 1,
      devices: [
        pc(1, "PC-A", 90, 230, "10.0.1.10", "255.255.255.0", "10.0.1.1"),
        dev(2, "router", "R1", 260, 230, {
          ifaces: [{ name: "Gig0/0", ip: "10.0.1.1", mask: "255.255.255.0" }, { name: "Gig0/1", ip: "172.16.0.1", mask: "255.255.255.252" }, { name: "Gig0/2" }, { name: "Gig0/3" }],
          routes: [{ network: "10.0.3.0", mask: "255.255.255.0", nextHop: "172.16.0.2" }, { network: "172.16.0.4", mask: "255.255.255.252", nextHop: "172.16.0.2" }],
        }),
        dev(3, "router", "R2", 450, 230, {
          ifaces: [{ name: "Gig0/0", ip: "172.16.0.2", mask: "255.255.255.252" }, { name: "Gig0/1", ip: "172.16.0.5", mask: "255.255.255.252" }, { name: "Gig0/2" }, { name: "Gig0/3" }],
          routes: [{ network: "10.0.1.0", mask: "255.255.255.0", nextHop: "172.16.0.1" }, { network: "10.0.3.0", mask: "255.255.255.0", nextHop: "172.16.0.6" }],
        }),
        dev(4, "router", "R3", 640, 230, {
          ifaces: [{ name: "Gig0/0", ip: "172.16.0.6", mask: "255.255.255.252" }, { name: "Gig0/1", ip: "10.0.3.1", mask: "255.255.255.0" }, { name: "Gig0/2" }, { name: "Gig0/3" }],
          routes: [{ network: "10.0.1.0", mask: "255.255.255.0", nextHop: "172.16.0.5" }, { network: "172.16.0.0", mask: "255.255.255.252", nextHop: "172.16.0.5" }],
        }),
        pc(5, "PC-B", 810, 230, "10.0.3.10", "255.255.255.0", "10.0.3.1"),
      ],
      links: [[1, "Fa0", 2, "Gig0/0"], [2, "Gig0/1", 3, "Gig0/0"], [3, "Gig0/1", 4, "Gig0/0"], [4, "Gig0/1", 5, "Fa0"]],
    },
  },
  "Hub versus switch": {
    note: "Ping from PC1 to PC2 and from PC4 to PC5. The hub repeats every frame to all PCs; the switch learns MAC addresses and forwards only to the right port.",
    data: {
      format: "foct-netsim", version: 1,
      devices: [
        dev(1, "hub", "Hub1", 230, 230),
        pc(2, "PC1", 90, 110, "192.168.10.1", "255.255.255.0"),
        pc(3, "PC2", 370, 110, "192.168.10.2", "255.255.255.0"),
        pc(4, "PC3", 230, 380, "192.168.10.3", "255.255.255.0"),
        dev(5, "switch", "Switch1", 670, 230),
        pc(6, "PC4", 530, 110, "192.168.20.1", "255.255.255.0"),
        pc(7, "PC5", 810, 110, "192.168.20.2", "255.255.255.0"),
        pc(8, "PC6", 670, 380, "192.168.20.3", "255.255.255.0"),
      ],
      links: [[2, "Fa0", 1, "Port 1"], [3, "Fa0", 1, "Port 2"], [4, "Fa0", 1, "Port 3"], [6, "Fa0", 5, "Fa0/1"], [7, "Fa0", 5, "Fa0/2"], [8, "Fa0", 5, "Fa0/3"]],
    },
  },
  "Troubleshooting exercise (3 faults)": {
    note: "Exercise: PC1 should reach Server1 and PC2. Find the three configuration mistakes using ping, ipconfig, show ip route and the Configure panel.",
    data: {
      format: "foct-netsim", version: 1,
      devices: [
        pc(1, "PC1", 110, 150, "192.168.1.10", "255.255.255.0", "192.168.1.254"),
        pc(2, "PC2", 110, 330, "192.168.1.11", "255.255.0.0", "192.168.1.1"),
        dev(3, "switch", "Switch1", 280, 240),
        dev(4, "router", "Router1", 470, 240, { ifaces: [{ name: "Gig0/0", ip: "192.168.1.1", mask: "255.255.255.0" }, { name: "Gig0/1", ip: "10.10.10.1", mask: "255.255.255.0" }, { name: "Gig0/2" }, { name: "Gig0/3" }] }),
        { id: 5, type: "server", name: "Server1", x: 680, y: 240, gateway: "10.10.10.2", ifaces: [{ name: "Fa0", ip: "10.10.10.100", mask: "255.255.255.0" }] },
      ],
      links: [[1, "Fa0", 3, "Fa0/1"], [2, "Fa0", 3, "Fa0/2"], [3, "Fa0/8", 4, "Gig0/0"], [4, "Gig0/1", 5, "Fa0"]],
    },
  },
};
