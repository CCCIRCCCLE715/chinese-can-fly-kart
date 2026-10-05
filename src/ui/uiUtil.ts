/**
 * Small, allocation-conscious helpers shared by the HUD, minimap and menus.
 * Everything that writes to the DOM goes through the cached setters below —
 * the HUD touches a dozen elements every frame and un-cached writes would
 * force a style recalc on each one even when the value has not moved.
 */

export const TIER_COLORS = ['#a8b6cc', '#4fc3ff', '#ff9d2e', '#c05cff'];

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** Ordinal suffix only — "st" / "nd" / "rd" / "th". */
export function ordinalSuffix(_n: number) { return '名'; }

const PAD2 = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'];
function p2(n: number) { return n < 10 ? PAD2[n] : String(n); }

/** `m:ss.hh` by default; `frac = 3` for lap times. */
export function formatClock(seconds: number, frac = 2) {
  const s = seconds < 0 ? 0 : seconds;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  const f = Math.floor((s - m * 60 - sec) * (frac === 3 ? 1000 : 100));
  const ff = frac === 3 ? (f < 10 ? '00' + f : f < 100 ? '0' + f : String(f)) : p2(f);
  return `${m}:${p2(sec)}.${ff}`;
}

/** Signed delta, e.g. "-0.42" / "+1.08". */
export function formatDelta(seconds: number) {
  const sign = seconds < 0 ? '-' : '+';
  const a = Math.abs(seconds);
  return a >= 60 ? `${sign}${formatClock(a)}` : `${sign}${a.toFixed(2)}`;
}

type Cached = Element & { __ut?: string; __us?: Record<string, string> };

export function setText(e: Element, v: string) {
  const c = e as Cached;
  if (c.__ut === v) return;
  c.__ut = v;
  e.textContent = v;
}

/** Cached inline-style write (also used for custom properties). */
export function setStyle(e: HTMLElement, prop: string, v: string) {
  const c = e as unknown as Cached;
  const s = c.__us || (c.__us = {});
  if (s[prop] === v) return;
  s[prop] = v;
  if (prop.charCodeAt(0) === 45) e.style.setProperty(prop, v);
  else (e.style as any)[prop] = v;
}

/** Cached numeric style write, quantised so sub-perceptual jitter is free. */
export function setNum(e: HTMLElement, prop: string, v: number, q = 0.005, unit = '') {
  const r = Math.round(v / q) * q;
  setStyle(e, prop, (Math.abs(r) < 1e-6 ? 0 : +r.toFixed(4)) + unit);
}

/** Restart a CSS animation on an element that may already be running one. */
export function retrigger(e: HTMLElement, cls: string) {
  e.classList.remove(cls);
  void e.offsetWidth; // force reflow so the removal is committed
  e.classList.add(cls);
}

/** A light second-order spring — used for the needle so it overshoots. */
export class Spring {
  value = 0;
  vel = 0;
  target = 0;
  constructor(public stiffness = 220, public damping = 18) {}

  step(dt: number) {
    // two substeps keeps a stiff spring stable at a 50 ms clamped frame
    const h = dt * 0.5;
    for (let i = 0; i < 2; i++) {
      const a = -this.stiffness * (this.value - this.target) - this.damping * this.vel;
      this.vel += a * h;
      this.value += this.vel * h;
    }
  }

  snap(v: number) { this.value = v; this.target = v; this.vel = 0; }
}

/** #rrggbb for a three.js colour without importing three at runtime. */
export function cssColor(c: { getHexString(): string }) {
  return '#' + c.getHexString();
}
