export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class Camera {
  constructor() { this.reset(); }
  reset() { this.yaw = -.1; this.pitch = .15; this.zoom = 1; this.panX = 0; this.panY = 0; this.target = { x: 0, y: 0, z: 0 }; this.destination = null; }
  rotate(dx, dy) { this.destination = null; this.yaw += dx * .004; this.pitch = clamp(this.pitch + dy * .004, -1.25, 1.25); }
  pan(dx, dy) { this.destination = null; this.panX += dx; this.panY += dy; }
  scale(factor) { this.zoom = clamp(this.zoom * factor, .35, 4.5); }
  focus(point) { this.destination = { x: point.x, y: point.y, z: point.z }; this.targetZoom = 1.9; this.panX = 0; this.panY = 0; }
  tick() {
    if (!this.destination) return;
    for (const axis of ['x', 'y', 'z']) this.target[axis] += (this.destination[axis] - this.target[axis]) * .09;
    this.zoom += (this.targetZoom - this.zoom) * .06;
    if (Math.hypot(this.destination.x - this.target.x, this.destination.y - this.target.y, this.destination.z - this.target.z) < .3) this.destination = null;
  }
  project(point, width, height) {
    const dx = point.x - this.target.x, dy = point.y - this.target.y, dz = point.z - this.target.z;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x = dx * c + dz * s, z = -dx * s + dz * c;
    const y = dy * cp - z * sp, depth = dy * sp + z * cp;
    const perspective = 1800 / Math.max(250, 1800 - depth);
    const scale = Math.min(width / 1940, height / 1450) * this.zoom * perspective;
    return { x: width / 2 + x * scale + this.panX, y: height * .54 - y * scale + this.panY, scale, depth, visible: depth < 1650 };
  }
}
