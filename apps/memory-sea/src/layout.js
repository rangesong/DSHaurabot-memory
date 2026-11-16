const ANCHORS = {
  W1: [-610, 330, -50], W2: [-305, 480, 70], W3: [0, 520, -50], W4: [305, 480, 70], W5: [610, 330, -50],
  M1: [-640, -155, 40], M2: [-330, -390, -60], M3: [5, -470, 60], M4: [365, -355, -20], M5: [670, -105, -40], U: [0, 70, 0],
};
export function seededRandom(id) {
  let seed = 2166136261;
  for (const character of id) { seed ^= character.codePointAt(0); seed = Math.imul(seed, 16777619); }
  return () => { seed += 0x6d2b79f5; let value = seed; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
export function anchorFor(id, mode = 'relation') {
  const [x, y, z] = ANCHORS[id] ?? ANCHORS.U;
  return mode === 'galaxy' ? { x, y: y * .55, z: z + y * .42 } : { x, y, z };
}

export class StarLayout {
  constructor() { this.points = []; this.byId = new Map(); this.mode = 'relation'; this.heat = 0; this.edges = []; }
  update(graph, mode = this.mode) {
    const changedMode = mode !== this.mode; this.mode = mode;
    const previous = this.byId;
    this.points = graph.nodes.filter((node) => ['region', 'store', 'memory'].includes(node.node_type)).map((node) => {
      const fixed = node.node_type !== 'memory';
      const homeId = node.node_type === 'region' ? node.region_id : fixed ? 'U' : node.display_region ?? node.primary_region;
      const home = anchorFor(homeId, mode); const random = seededRandom(node.id);
      const angle = random() * Math.PI * 2, radius = 20 + Math.sqrt(random()) * 150;
      const offset = mode === 'galaxy' ? { x: Math.cos(angle + radius * .018) * radius, y: (random() - .5) * 80, z: Math.sin(angle + radius * .018) * radius }
        : { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * .7, z: (random() - .5) * 220 };
      const old = previous.get(node.id);
      const reuse = old && old.homeId === homeId && !changedMode;
      return { ...node, fixed, homeId, home, x: reuse ? old.x : home.x + (fixed ? 0 : offset.x),
        y: reuse ? old.y : home.y + (fixed ? 0 : offset.y), z: reuse ? old.z : home.z + (fixed ? 0 : offset.z), vx: 0, vy: 0, vz: 0 };
    });
    this.byId = new Map(this.points.map((point) => [point.id, point]));
    this.edges = graph.edges.filter((edge) => edge.layer === 'content').map((edge) => ({ ...edge, a: this.byId.get(edge.from), b: this.byId.get(edge.to) })).filter((edge) => edge.a && edge.b);
    this.heat = 1;
  }
  step() {
    if (this.heat < .015) return;
    const movable = this.points.filter((point) => !point.fixed);
    for (let i = 0; i < movable.length; i++) for (let j = i + 1; j < movable.length; j++) {
      const a = movable[i], b = movable[j];
      if (a.homeId !== b.homeId) continue;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d2 = dx * dx + dy * dy + dz * dz + .1;
      if (d2 > 50000) continue;
      const force = Math.min(.045, 70 / (d2 * Math.sqrt(d2)));
      a.vx -= dx * force; a.vy -= dy * force; a.vz -= dz * force;
      b.vx += dx * force; b.vy += dy * force; b.vz += dz * force;
    }
    for (const edge of this.edges) {
      if (edge.a.homeId !== edge.b.homeId) continue;
      const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y, dz = edge.b.z - edge.a.z;
      const distance = Math.hypot(dx, dy, dz) || 1;
      const force = (distance - 62) * .0009 * this.heat;
      for (const [axis, delta] of [['vx', dx], ['vy', dy], ['vz', dz]]) { edge.a[axis] += delta * force; edge.b[axis] -= delta * force; }
    }
    for (const point of movable) {
      for (const axis of ['x', 'y', 'z']) {
        const velocity = `v${axis}`;
        point[velocity] = (point[velocity] + (point.home[axis] - point[axis]) * .0018 * this.heat) * .82;
        point[axis] += point[velocity];
      }
    }
    this.heat *= .986;
  }
}
