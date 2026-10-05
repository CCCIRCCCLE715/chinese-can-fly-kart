/**
 * ============================================================================
 *  Live "sense of speed" tuning.  window.__feel
 * ============================================================================
 *  Reported by the player: "when going full speed it doesn't really feel as
 *  fast as the odometer."
 *
 *  Measured at the two ends, driving flat out on a straight:
 *
 *      46 km/h   fov 52.4   arm 6.08 m
 *     106 km/h   fov 58.9   arm 6.47 m
 *
 *  Two things fall out of that. The field of view opens by 6.5 degrees across
 *  the entire usable speed range, and the arm gets LONGER as the kart goes
 *  faster — both of which push against the sense of speed rather than with it.
 *  Optical flow at the frame edge is what the eye reads as speed, and it rises
 *  when the lens widens, when the camera drops toward the ground, and when the
 *  camera moves CLOSER to the things rushing past.
 *
 *  This is not a regression from the camera rebuild — the old rig carried the
 *  same three constants and applied them the same way. What changed is that the
 *  rebuild cut peak camera swing from 990 to 116 deg/s, and the old rig's
 *  thrashing was masking how thin the real cues are. The camera got better and
 *  made the deficit visible.
 *
 *  Feel is not a thing to guess at from a measurement, so this exists to be
 *  driven: change a value, keep playing, and the rig responds on the next
 *  frame. Defaults reproduce the shipped behaviour exactly, so nothing moves
 *  until someone moves it.
 *
 *      __feel.punchy()   apply a stronger set, all at once
 *      __feel.reset()    back to shipped
 *      __feel.show()     print the current values, ready to paste back
 * ============================================================================
 */

export interface FeelParams {
  /** degrees of FOV gained between a standstill and flat out */
  fovSpeed: number;
  /** metres the arm lengthens at flat out; NEGATIVE pulls the camera in */
  armDistSpeed: number;
  /** metres the arm drops at flat out; more negative sits lower */
  armHeightSpeed: number;
  /** multiplier on the post chain's speed-line gain */
  streak: number;
  /** multiplier on the radial zoom blur */
  rush: number;
  /** multiplier on the chromatic aberration ramp */
  fringe: number;
}

/** Exactly what the game shipped with, so the default path is a no-op. */
const SHIPPED: FeelParams = {
  fovSpeed: 5.0,
  armDistSpeed: 0.55,
  armHeightSpeed: -0.22,
  streak: 1,
  rush: 1,
  fringe: 1,
};

/**
 * A deliberately stronger set, as a starting point for a conversation rather
 * than an answer. The lens opens three times as far, the arm comes IN instead
 * of going out, the camera sits lower, and the three screen-space cues are
 * lifted together. Every one of these raises edge optical flow.
 */
const PUNCHY: FeelParams = {
  fovSpeed: 15.0,
  armDistSpeed: -0.9,
  armHeightSpeed: -0.55,
  streak: 1.6,
  rush: 1.8,
  fringe: 1.35,
};

export const feel: FeelParams = { ...SHIPPED };

export function installFeel(): void {
  const api = {
    ...feel,
    punchy() { Object.assign(feel, PUNCHY); return api.show(); },
    reset() { Object.assign(feel, SHIPPED); return api.show(); },
    set(patch: Partial<FeelParams>) { Object.assign(feel, patch); return api.show(); },
    show() {
      console.table(feel);
      return JSON.stringify(feel);
    },
  };
  // Live view: reading __feel.fovSpeed should show the current value, and
  // writing it should take effect on the next frame.
  for (const key of Object.keys(SHIPPED) as (keyof FeelParams)[]) {
    Object.defineProperty(api, key, {
      get: () => feel[key],
      set: (v: number) => { feel[key] = v; },
      enumerable: true,
    });
  }
  (window as any).__feel = api;
  console.info(
    '%c[feel] speed-cue tuning is live. Try __feel.punchy() while driving, ' +
    'then __feel.show() to copy the numbers you liked.',
    'color:#8ab4ff',
  );
}
