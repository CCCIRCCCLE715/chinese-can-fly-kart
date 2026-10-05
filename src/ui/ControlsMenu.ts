/**
 * ============================================================================
 *  The controls screen — schemes, handedness, assists, and a LIVE preview.
 * ============================================================================
 *  The bet this screen makes: the range of players on phones is too wide for
 *  one control scheme, and being able to switch is itself the feature. A player
 *  with small hands, a player who props the phone on a table, a player with a
 *  tremor and a player who grew up on tilt racers do not want the same thing,
 *  and no amount of tuning one stick serves all four.
 *
 *  What stops that becoming a wall of sliders:
 *
 *  1. **The default is chosen, not deferred.** Floating stick, right hand,
 *     auto-accelerate, steering assist OFF, auto-drift half. A player who never
 *     opens this screen gets the scheme that is best for a first-time player,
 *     and every reason is written down in `ControlPrefs.ts`.
 *
 *  2. **Every option is TRIED, not described.** The screen occupies the top of
 *     the frame and leaves the bottom clear, `TouchControls.setPreview(true)`
 *     re-reveals the live steering source underneath it, and the meter across
 *     the middle shows `state.steer` at 60 Hz. You pick "tilt", you tilt the
 *     phone, the bar moves. A scheme nobody has held is not a shipped scheme —
 *     which is exactly why tilt and the button pads had to come with this
 *     screen rather than before it.
 *
 *  3. **The preview shows the STEERING SOURCE ONLY.** Not the action cluster.
 *     A preview that could fire an item, toggle AUTO or open the pause menu by
 *     mis-tap would be a new bug shipped to fix an old one.
 *
 *  4. **Nothing here can end a race.** `setScheme` releases every pointer and
 *     zeroes the command; it never touches `IRace`. This screen is reachable
 *     from the pause menu mid-race and switching schemes there resumes into the
 *     new one. The pause menu that permanently ended your race is the reason
 *     that sentence is in this comment.
 *
 *  LANDSCAPE PHONE, 390 CSS px OF HEIGHT. There is no scrolling: `touch-action`
 *  is `none` on `html` and its EFFECT intersects down the tree, so a child
 *  cannot re-enable panning however it is styled. Everything therefore fits, in
 *  two columns, or it does not ship.
 * ============================================================================
 */
import { RaceState, type Ctx } from '../types';
import type { TouchControls } from '../core/TouchControls';
import type { Scheme } from '../core/ControlPrefs';
import { el, clamp } from './uiUtil';

type Opt<T> = { value: T; label: string; note?: string };

const SCHEMES: { id: Scheme; name: string; blurb: string; glyph: string }[] = [
  {
    id: 'floating', name: '浮动摇杆', glyph: 'ring',
    blurb: '手指落在哪里，摇杆就出现在哪里。',
  },
  {
    id: 'fixed', name: '固定摇杆', glyph: 'ring-fixed',
    blurb: '摇杆位置固定，方便凭手感操作。',
  },
  {
    id: 'tilt', name: '体感转向', glyph: 'tilt',
    blurb: '左右倾斜手机，双手拇指可操作按键。',
  },
  {
    id: 'buttons', name: '方向按键', glyph: 'pads',
    blurb: '两个大按键，按住即可转弯。',
  },
];

export class ControlsMenu {
  /** true while this screen owns the frame */
  open = false;

  private root: HTMLDivElement;
  private meterFill!: HTMLElement;
  private meterNum!: HTMLElement;
  private tiltRow!: HTMLElement;
  private tiltVal!: HTMLElement;
  private cards = new Map<Scheme, HTMLElement>();
  private segs: { key: string; wrap: HTMLElement; get: () => unknown }[] = [];
  private pad: TouchControls | null = null;
  private ctx: Ctx | null = null;
  /** cached so the meter is one style write a frame and only when it moved */
  private lastSteer = 2;

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = el('div', 'kc-root', parent);
    this.build();
  }

  // ------------------------------------------------------------------ build

  private build() {
    const head = el('div', 'kc-head', this.root);
    el('div', 'kc-title', head, '操作设置');

    // The live meter lives in the HEAD, not in a row of its own. On a 390 px
    // landscape phone a row is 6% of the frame, and this screen has to fit
    // without scrolling — `touch-action: none` on `html` means a child cannot
    // re-enable panning however it is styled, so "it scrolls" is not available.
    const meter = el('div', 'kc-meter', head);
    el('div', 'kc-meter-lab', meter, '转向');
    const track = el('div', 'kc-meter-track', meter);
    el('i', 'kc-meter-mid', track);
    this.meterFill = el('b', 'kc-meter-fill', track);
    this.meterNum = el('div', 'kc-meter-num', meter, '+0.00');

    const done = el('div', 'kc-done', head, '完成');
    done.onclick = () => this.close();

    const body = el('div', 'kc-body', this.root);

    // --- left column: the four schemes, as cards you can actually read.
    const left = el('div', 'kc-schemes', body);
    for (const s of SCHEMES) {
      const c = el('div', 'kc-card', left);
      c.innerHTML =
        `<div class="kc-glyph kc-g-${s.glyph}"><i></i><b></b></div>` +
        `<div class="kc-card-t"><em>${s.name}</em><span>${s.blurb}</span></div>`;
      c.onclick = () => this.chooseScheme(s.id);
      this.cards.set(s.id, c);
    }

    // --- right column: the meter, then the settings.
    const right = el('div', 'kc-right', body);

    this.tiltRow = el('div', 'kc-tilt', right);
    this.tiltVal = el('span', undefined, this.tiltRow, '等待体感数据…');
    const re = el('div', 'kc-mini', this.tiltRow, '校准中位');
    re.onclick = () => this.pad?.recentreTilt();

    const grid = el('div', 'kc-grid', right);
    this.seg<'right' | 'left'>(grid, 'hand', '惯用手', [
      { value: 'right', label: '右手' }, { value: 'left', label: '左手' },
    ], () => this.pad?.prefs.hand, (v) => this.pad?.setHand(v));

    this.seg<boolean>(grid, 'auto', '油门', [
      { value: true, label: '自动' }, { value: false, label: '手动' },
    ], () => this.pad?.auto, (v) => this.pad?.setAuto(v));

    this.seg<number>(grid, 'steerAssist', '转向辅助', [
      { value: 0, label: '关闭' }, { value: 0.35, label: '轻度' }, { value: 0.6, label: '强力' },
    ], () => this.pad?.prefs.steerAssist, (v) => this.pad?.setSteerAssist(v));

    this.seg<number>(grid, 'driftAssist', '漂移辅助', [
      { value: 0, label: '关闭' }, { value: 0.5, label: '适中' }, { value: 1, label: '完全' },
    ], () => this.pad?.prefs.driftAssist, (v) => this.pad?.setDriftAssist(v));

    this.seg<boolean>(grid, 'haptics', '震动', [
      { value: true, label: '开启' }, { value: false, label: '关闭' },
    ], () => this.pad?.prefs.haptics, (v) => this.pad?.setHaptics(v));

    this.seg<number>(grid, 'tiltRange', '转向幅度', [
      { value: 20, label: '20°' }, { value: 26, label: '26°' }, { value: 34, label: '34°' },
    ], () => this.pad?.prefs.tiltRange, (v) => this.pad?.setTiltRange(v));

    el('div', 'kc-try', this.root,
      typeof navigator.vibrate === 'function'
        ? '在下方区域试用操控 · 设置已保存在本机'
        : '在下方区域试用操控 · 当前浏览器不支持震动');

    /**
     * Swallow pointer events on the CONTENT, not on the whole sheet.
     *
     * `TouchControls` listens on `window`, which is the last thing a bubbling
     * event reaches, so stopping propagation on these two subtrees is enough to
     * keep a tap on a SETTING from also spawning a steering stick underneath
     * it. Everything below the dashed rule is deliberately NOT covered: that
     * band is `pointer-events: none` and reaches the pad, which is the whole
     * mechanism behind "try it".
     */
    for (const n of [head, body]) {
      n.addEventListener('pointerdown', (e) => e.stopPropagation());
      n.addEventListener('pointermove', (e) => e.stopPropagation());
    }
  }

  /** A segmented control. Every setting on this screen is one of these. */
  private seg<T>(
    parent: HTMLElement, key: string, label: string,
    opts: Opt<T>[], get: () => T | undefined, set: (v: T) => void,
  ) {
    const row = el('div', 'kc-row', parent);
    el('div', 'kc-row-l', row, label);
    const wrap = el('div', 'kc-seg', row);
    wrap.dataset.key = key;
    for (const o of opts) {
      const b = el('div', 'kc-opt', wrap, o.label);
      b.dataset.v = String(o.value);
      b.onclick = () => {
        set(o.value);
        this.sync();
      };
    }
    this.segs.push({ key, wrap, get: get as () => unknown });
  }

  // ------------------------------------------------------------------- state

  attach(ctx: Ctx) {
    this.ctx = ctx;
    // `IInput` in types.ts carries only `state` and `touch`, and widening the
    // contract for a UI screen is exactly what that file forbids. The concrete
    // `Input` exposes `pad` publicly for this reason; the cast is the honest
    // shape of "I know more about this object than the interface says".
    this.pad = (ctx.input as unknown as { pad?: TouchControls }).pad ?? null;
    this.sync();
  }

  show() {
    if (this.open) return;
    this.open = true;
    this.root.classList.add('on');
    // The screen underneath stays where it is — `Menus.update` returns early
    // while this is open, so no screen transition can happen behind the
    // player's back — but it is dimmed, or a pause board reads through it.
    document.documentElement.dataset.kcOpen = '';
    this.pad?.setPreview(true);
    this.sync();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('on');
    delete document.documentElement.dataset.kcOpen;
    this.pad?.setPreview(false);
    this.ctx?.bus.emit({ type: 'ui', name: 'confirm' });
  }

  private async chooseScheme(id: Scheme) {
    const pad = this.pad;
    if (!pad) return;
    if (id === 'tilt') {
      // iOS 13+ will only hand over DeviceOrientation from a user gesture, and
      // this click IS one. If it is refused, do not silently select a scheme
      // that cannot steer — say so and stay put.
      const ok = await pad.requestTilt();
      if (!ok) {
        this.tiltVal.textContent = '体感权限未获允许';
        return;
      }
    }
    pad.setScheme(id);
    this.ctx?.bus.emit({ type: 'ui', name: 'move' });
    this.sync();
  }

  private sync() {
    const pad = this.pad;
    if (!pad) return;
    for (const [id, c] of this.cards) c.classList.toggle('sel', pad.prefs.scheme === id);
    for (const s of this.segs) {
      const cur = String(s.get());
      for (const o of Array.from(s.wrap.children) as HTMLElement[]) {
        o.classList.toggle('sel', o.dataset.v === cur);
      }
    }
    this.root.dataset.scheme = pad.prefs.scheme;
  }

  /**
   * One style write a frame, and only when the value actually moved. This
   * screen is up while the game is still rendering behind it.
   */
  update(ctx: Ctx) {
    if (!this.open) return;
    const pad = this.pad;
    if (!pad) return;
    const s = pad.prefs.scheme === 'buttons' ? pad.state.digital : pad.state.steer;
    if (Math.abs(s - this.lastSteer) > 0.004) {
      this.lastSteer = s;
      const half = clamp(Math.abs(s), 0, 1) * 50;
      this.meterFill.style.left = s >= 0 ? '50%' : `${50 - half}%`;
      this.meterFill.style.width = `${half}%`;
      this.meterNum.textContent = (s >= 0 ? '+' : '−') + Math.abs(s).toFixed(2);
    }
    if (pad.prefs.scheme === 'tilt') {
      this.tiltVal.textContent = pad.tiltAvailable
        ? `${pad.tiltDegrees >= 0 ? '+' : '−'}${Math.abs(pad.tiltDegrees).toFixed(0)}° 倾斜`
        : '等待体感数据…';
    }
    // Pausing is fine; finishing a race behind this screen is not a state it
    // should survive, and neither is the race being reset out from under it.
    if (ctx.race?.state === RaceState.Results) this.close();
  }
}

const CSS = `
/* A SHEET, not a wash of text over the road.
   The first cut had no background at all and the game read straight through
   it: "惯用手", "油门" and "转向辅助" were unreadable over a sunlit
   gravel texture. A settings surface has to be opaque where the words are.
   The scrim then FADES OUT over the bottom fifth, on purpose — that band is
   where the live preview is driven from, and it has to show the road so the
   player can see they are still in the game. */
.kc-root {
  position: absolute; inset: 0;
  z-index: 30; pointer-events: none; opacity: 0;
  transition: opacity .18s ease;
  padding: calc(env(safe-area-inset-top, 0px) + 8px)
           calc(env(safe-area-inset-right, 0px) + 16px) 0
           calc(env(safe-area-inset-left, 0px) + 16px);
  color: #eef3fa;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background:
    linear-gradient(180deg,
      rgba(5, 9, 18, 0.96) 0%,
      rgba(5, 9, 18, 0.95) 58%,
      rgba(5, 9, 18, 0.86) 72%,
      rgba(5, 9, 18, 0.34) 84%,
      rgba(5, 9, 18, 0.04) 96%);
  backdrop-filter: blur(9px) saturate(0.8);
  display: flex; flex-direction: column;
}
/* The SHEET never takes pointer events; only its content does. That is what
   leaves the preview band live underneath. */
.kc-root.on { opacity: 1; }
.kc-root.on .kc-head, .kc-root.on .kc-body { pointer-events: auto; }
/* The screen this was opened from stays mounted (so nothing can transition
   behind the player) but must not read through the panel. */
html[data-kc-open] .kr-screens { opacity: 0; }

/* The bottom band belongs to the preview. The rule is a real affordance, not
   decoration: everything below it reaches the pad, everything above it does
   not, and the panel stops swallowing pointer events exactly there. */
.kc-try {
  pointer-events: none;
  margin-top: 6px; padding-top: 6px;
  border-top: 1.5px dashed rgba(255, 255, 255, 0.26);
  font-size: clamp(9px, 1.5vmin, 13px); letter-spacing: .16em;
  text-transform: uppercase; color: rgba(233, 240, 250, 0.62);
  text-align: center;
}

.kc-head { display: flex; align-items: center; gap: 14px; margin-bottom: 8px; }
.kc-title {
  font-size: clamp(15px, 3.1vmin, 26px); font-weight: 900; letter-spacing: .12em;
  text-transform: uppercase;
  background: linear-gradient(180deg, #fff 10%, #ffd27a 62%, #f0a23c 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.kc-done {
  min-width: 78px; min-height: 46px;
  display: grid; place-items: center; padding: 0 16px; border-radius: 999px;
  font-size: clamp(12px, 2.3vmin, 18px); font-weight: 800; letter-spacing: .1em;
  color: #10202f; background: linear-gradient(180deg, #ffe6a8, #f2b445);
  box-shadow: 0 4px 14px rgba(0,0,0,.45);
}

.kc-body { display: grid; grid-template-columns: 1.05fr 1fr; gap: 14px; }

/* --- scheme cards --------------------------------------------------------- */
.kc-schemes { display: grid; gap: 5px; align-content: start; }
.kc-card {
  display: flex; align-items: center; gap: 10px;
  min-height: 46px; padding: 5px 10px; border-radius: 12px;
  background: rgba(10,16,28,.62); border: 1.5px solid rgba(255,255,255,.16);
  backdrop-filter: blur(6px);
}
.kc-card.sel {
  border-color: rgba(255,214,110,.9);
  background: linear-gradient(180deg, rgba(255,214,110,.22), rgba(10,16,28,.62));
  box-shadow: 0 0 18px rgba(255,190,90,.28);
}
.kc-card-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.kc-card-t em {
  font-style: normal; font-weight: 800; letter-spacing: .04em;
  font-size: clamp(12px, 2.2vmin, 17px);
}
.kc-card-t span {
  font-size: clamp(10px, 1.7vmin, 14px); color: #a9b6c9; line-height: 1.25;
}

/* Miniature renderings of the REAL controls at their real colours, so the card
   shows the thing rather than naming it. */
.kc-glyph {
  position: relative; flex: none; width: 30px; height: 30px; border-radius: 50%;
}
.kc-glyph i, .kc-glyph b { position: absolute; border-radius: 50%; }
.kc-g-ring i, .kc-g-ring-fixed i {
  inset: 0; border: 2px solid rgba(255,255,255,.55);
}
.kc-g-ring-fixed i { border-style: dashed; }
.kc-g-ring b, .kc-g-ring-fixed b {
  width: 42%; height: 42%; left: 46%; top: 29%;
  background: radial-gradient(circle at 40% 35%, #fff, #f0a93c);
}
.kc-g-tilt i {
  inset: 12% 26%; border-radius: 5px; border: 2px solid rgba(255,255,255,.55);
  transform: rotate(-18deg);
}
.kc-g-tilt b {
  width: 34%; height: 34%; left: 33%; top: 33%;
  background: radial-gradient(circle at 40% 35%, #fff, #4fc3ff);
}
.kc-g-pads i, .kc-g-pads b {
  width: 42%; height: 62%; top: 19%; border-radius: 5px;
  border: 2px solid rgba(255,255,255,.55); background: rgba(255,255,255,.10);
}
.kc-g-pads i { left: 2%; }
.kc-g-pads b { left: 56%; }

/* --- live preview meter --------------------------------------------------- */
.kc-right { display: grid; gap: 6px; align-content: start; }
.kc-meter { flex: 1; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; }
.kc-meter-lab, .kc-meter-num {
  font-size: clamp(10px, 1.8vmin, 14px); letter-spacing: .12em;
  text-transform: uppercase; color: #a9b6c9;
}
.kc-meter-num { font-variant-numeric: tabular-nums; color: #ffd27a; font-weight: 800; }
.kc-meter-track {
  position: relative; height: 14px; border-radius: 999px;
  background: rgba(8,13,24,.75); border: 1.5px solid rgba(255,255,255,.18);
  overflow: hidden;
}
.kc-meter-mid { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; background: rgba(255,255,255,.35); }
.kc-meter-fill {
  position: absolute; top: 0; bottom: 0; left: 50%; width: 0;
  background: linear-gradient(90deg, #6ad2ff, #ffd27a);
  box-shadow: 0 0 10px rgba(255,200,120,.6);
}

.kc-tilt {
  display: none; align-items: center; gap: 8px;
  font-size: clamp(10px, 1.7vmin, 14px); color: #a9b6c9;
}
.kc-root[data-scheme="tilt"] .kc-tilt { display: flex; }
.kc-mini {
  margin-left: auto; min-height: 34px; display: grid; place-items: center;
  padding: 0 12px; border-radius: 999px; color: #eef3fa;
  background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.22);
  font-size: clamp(10px, 1.7vmin, 14px);
}

/* --- settings rows -------------------------------------------------------- */
.kc-grid { display: grid; gap: 3px; }
.kc-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; }
.kc-row-l { font-size: clamp(10px, 1.8vmin, 15px); color: #cfd8e6; letter-spacing: .04em; }
.kc-seg {
  display: flex; gap: 2px; padding: 2px; border-radius: 999px;
  background: rgba(8,13,24,.7); border: 1px solid rgba(255,255,255,.16);
}
/* 34 px, not 46: these are inside a panel the player is not steering from, and
   a 46 px floor on six rows does not fit 390 px of landscape phone. The floor
   applies to controls used WHILE DRIVING, which is what it is for. */
.kc-opt {
  min-width: 46px; min-height: 32px; display: grid; place-items: center;
  padding: 0 10px; border-radius: 999px; color: #a9b6c9;
  font-size: clamp(10px, 1.7vmin, 14px); font-weight: 700; letter-spacing: .06em;
}
.kc-opt.sel {
  color: #10202f; background: linear-gradient(180deg, #ffe6a8, #f2b445);
}

.kc-foot {
  margin-top: 6px; font-size: clamp(9px, 1.5vmin, 12px);
  color: #8797ac; letter-spacing: .04em;
}
`;
