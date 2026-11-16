import { Camera } from './camera.js';
import { StarLayout, anchorFor, seededRandom } from './layout.js';

export const COLORS = { M1: '#90dbf4', M2: '#f7a072', M3: '#f49fbc', M4: '#a9def9', M5: '#c3f584', U: '#c6eea2', W1: '#70d6ff', W2: '#ffd670', W3: '#ff8fab', W4: '#b8f2e6', W5: '#bdb2ff' };
const short = (value, size) => { const chars = Array.from(value); return chars.length > size ? chars.slice(0, size).join('') + '…' : value; };

/** Decorative dust is separate from data nodes: it never enters hit testing or counts. */
export class MemorySea {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.camera = new Camera(); this.layout = new StarLayout();
    this.onSelect = onSelect; this.onHover = onHover; this.selected = null; this.hovered = null; this.hits = [];
    this.motion = !matchMedia('(prefers-reduced-motion: reduce)').matches; this.lines = true; this.phase = 0;
    const random = seededRandom('thinkstar-decorative-dust');
    this.background = Array.from({ length: 380 }, () => ({ x: random(), y: random(), r: random() * .9 + .2, a: random() * .26 + .06 }));
    this.dust = ['M1', 'M2', 'M3', 'M4', 'M5'].flatMap((homeId) => Array.from({ length: 440 }, () => {
      const angle = random() * Math.PI * 2, r = Math.sqrt(random()) * 235;
      return { homeId, angle, r, y: (random() - .5) * 145, z: (random() - .5) * 195, a: random() * .3 + .07, size: random() * 1.25 + .35 };
    }));
    this.glows = new Map(Object.entries(COLORS).map(([id, color]) => {
      const sprite = document.createElement('canvas'); sprite.width = sprite.height = 128;
      const ctx = sprite.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      gradient.addColorStop(0, color + 'a0'); gradient.addColorStop(.15, color + '38'); gradient.addColorStop(1, color + '00');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128); return [id, sprite];
    }));
    this.resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect(); this.width = rect.width; this.height = rect.height; this.dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(this.width * this.dpr); canvas.height = Math.round(this.height * this.dpr);
    });
    this.resize.observe(canvas); this.bind();
    const frame = (now) => {
      this.frameId = requestAnimationFrame(frame);
      if (document.hidden || now - (this.lastFrame ?? 0) < 30) return;
      this.lastFrame = now; this.camera.tick(); this.layout.step(); if (this.motion) this.phase += .0006;
      this.draw();
    };
    this.frameId = requestAnimationFrame(frame);
  }
  setGraph(graph) { this.graph = graph; this.layout.update(graph); }
  setMode(mode) { if (!this.graph || mode === this.layout.mode) return; this.layout.update(this.graph, mode); this.camera.reset(); }
  select(id) { this.selected = id; }
  focus(id) { const point = this.layout.byId.get(id); if (point) this.camera.focus(point); }
  reset() { this.camera.reset(); }
  zoom(factor) { this.camera.scale(factor); }
  setMotion(value) { this.motion = value; }
  setLines(value) { this.lines = value; }
  pick(x, y) { return [...this.hits].reverse().find((point) => Math.hypot(point.x - x, point.y - y) < point.radius)?.node ?? null; }
  bind() {
    const canvas = this.canvas;
    const position = (event) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('pointerdown', (event) => {
      if (this.pointer) return;
      const point = position(event); this.pointer = { id: event.pointerId, ...point, startX: point.x, startY: point.y, moved: false, pan: event.shiftKey || event.button === 2 };
      canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true });
    });
    canvas.addEventListener('pointermove', (event) => {
      const point = position(event);
      if (this.pointer?.id === event.pointerId) {
        const p = this.pointer; const dx = point.x - p.x, dy = point.y - p.y;
        if (Math.hypot(point.x - p.startX, point.y - p.startY) > 4) p.moved = true;
        if (p.moved) { if (p.pan || event.shiftKey) this.camera.pan(dx, dy); else this.camera.rotate(dx, dy); }
        p.x = point.x; p.y = point.y; this.onHover?.(null); return;
      }
      const node = this.pick(point.x, point.y); this.hovered = node?.id; canvas.style.cursor = node ? 'pointer' : 'grab'; this.onHover?.(node, point);
    });
    canvas.addEventListener('pointerup', (event) => {
      if (this.pointer?.id !== event.pointerId) return;
      const point = position(event); if (!this.pointer.moved && event.button !== 2) this.onSelect?.(this.pick(point.x, point.y));
      this.pointer = null;
    });
    canvas.addEventListener('pointercancel', () => { this.pointer = null; });
    canvas.addEventListener('pointerleave', () => { this.hovered = null; this.onHover?.(null); });
    canvas.addEventListener('dblclick', (event) => { const p = position(event), node = this.pick(p.x, p.y); if (node) this.focus(node.id); });
    canvas.addEventListener('wheel', (event) => { event.preventDefault(); this.camera.scale(Math.exp(-event.deltaY * .001)); }, { passive: false });
    canvas.addEventListener('keydown', (event) => {
      const rotations = { ArrowLeft: [-25, 0], ArrowRight: [25, 0], ArrowUp: [0, -25], ArrowDown: [0, 25] };
      if (rotations[event.key]) { event.preventDefault(); this.camera.rotate(...rotations[event.key]); }
      if (['+', '='].includes(event.key)) { event.preventDefault(); this.zoom(1.15); }
      if (event.key === '-') { event.preventDefault(); this.zoom(1 / 1.15); }
      if (event.key === 'Escape') this.reset();
    });
  }
  draw() {
    const ctx = this.ctx, w = this.width, h = this.height; if (!w || !h) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, w, h); this.hits = [];
    for (const star of this.background) { ctx.globalAlpha = star.a; ctx.fillStyle = '#a9bdd8'; ctx.beginPath(); ctx.arc(star.x * w, star.y * h, star.r, 0, Math.PI * 2); ctx.fill(); }
    const project = (p) => this.camera.project(p, w, h);
    for (const region of this.graph?.regions ?? []) {
      const p = project(anchorFor(region.id, this.layout.mode)); if (!p.visible) continue;
      const radius = Math.min(280, Math.max(55, p.scale * (region.id.startsWith('M') ? 560 : 180)));
      ctx.globalAlpha = region.id.startsWith('M') ? .23 : .08;
      ctx.drawImage(this.glows.get(region.id), p.x - radius, p.y - radius, radius * 2, radius * 2);
    }
    for (const star of this.dust) {
      const home = anchorFor(star.homeId, this.layout.mode), a = star.angle + this.phase * (star.homeId === 'M2' ? -.4 : .3);
      const point = this.layout.mode === 'galaxy'
        ? { x: home.x + Math.cos(a + star.r * .018) * star.r, y: home.y + star.y * .32, z: home.z + Math.sin(a + star.r * .018) * star.r }
        : { x: home.x + Math.cos(a) * star.r, y: home.y + Math.sin(a) * star.r * .6, z: home.z + star.z };
      const p = project(point); if (!p.visible) continue;
      ctx.globalAlpha = star.a * .7; ctx.fillStyle = COLORS[star.homeId]; ctx.fillRect(p.x, p.y, Math.max(.45, star.size * p.scale * 2), Math.max(.45, star.size * p.scale * 2));
    }
    const projected = this.layout.points.map((node) => ({ node, ...project(node) })).filter((p) => p.visible).sort((a, b) => a.depth - b.depth);
    const byId = new Map(projected.map((p) => [p.node.id, p]));
    if (this.lines) {
      for (const edge of this.layout.edges) {
        const a = byId.get(edge.a.id), b = byId.get(edge.b.id); if (!a || !b) continue;
        const active = [this.selected, this.hovered].some((id) => id && [a.node.id, b.node.id].includes(id));
        if (this.selected && !active) continue;
        ctx.globalAlpha = active ? .48 : .075; ctx.strokeStyle = active ? '#b1d5ad' : '#7da2bf'; ctx.lineWidth = active ? .9 : .5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      const active = byId.get(this.selected ?? this.hovered);
      if (active?.node.node_type === 'memory') for (const region of active.node.region_ids) {
        const target = byId.get(`region:${region}`); if (!target) continue;
        ctx.globalAlpha = .36; ctx.strokeStyle = COLORS[region]; ctx.lineWidth = .8; ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(active.x, active.y); ctx.lineTo(target.x, target.y); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const anchors = [];
    for (const p of projected) {
      const { node, x, y, scale } = p; const fixed = node.node_type !== 'memory', active = [this.selected, this.hovered].includes(node.id);
      const color = COLORS[node.homeId] ?? '#c6eea2'; const size = fixed ? (node.node_type === 'store' ? 4 : 2.7) : active ? 3 : 1.4;
      if (fixed || active) { const radius = active ? 24 : node.node_type === 'store' ? 55 : 22; ctx.globalAlpha = active ? .9 : .65; ctx.drawImage(this.glows.get(node.homeId) ?? this.glows.get('U'), x - radius, y - radius, radius * 2, radius * 2); }
      ctx.globalAlpha = fixed && node.homeId.startsWith('W') ? .5 : .9; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, Math.max(.85, size * Math.min(1.3, scale * 2)), 0, Math.PI * 2); ctx.fill();
      if (active) { ctx.globalAlpha = .8; ctx.strokeStyle = color; ctx.lineWidth = .7; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); }
      this.hits.push({ x, y, radius: fixed ? 15 : 9, node });
      if (fixed) anchors.push(p);
      else if (active) {
        const label = short(node.label, 20); ctx.font = '11px "Segoe UI","Microsoft YaHei",sans-serif';
        const width = ctx.measureText(label).width; const lx = Math.max(8, Math.min(w - width - 14, x + 13)), ly = Math.max(20, y - 10);
        ctx.globalAlpha = .95; ctx.fillStyle = '#0b1421'; ctx.fillRect(lx - 5, ly - 14, width + 10, 23); ctx.fillStyle = '#dbe7f2'; ctx.fillText(label, lx, ly + 1);
      }
    }
    for (const { node, x, y } of anchors) {
      const working = node.homeId.startsWith('W'), store = node.homeId === 'U';
      ctx.globalAlpha = working ? .62 : .9; ctx.textAlign = 'center'; ctx.fillStyle = COLORS[node.homeId];
      ctx.font = `${working ? 10 : 12}px "Segoe UI","Microsoft YaHei",sans-serif`; ctx.fillText(store ? 'U · 统一记忆底座' : node.label, x, y + 24);
      if (!working && !store) {
        const count = this.graph?.regions.find((r) => r.id === node.homeId)?.count ?? 0;
        ctx.fillStyle = '#73849b'; ctx.font = '9px "Segoe UI","Microsoft YaHei",sans-serif'; ctx.globalAlpha = .8;
        ctx.fillText(count ? `${count} 个入口` : '尚无内容', x, y + 40);
      }
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }
}
