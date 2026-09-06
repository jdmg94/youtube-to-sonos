/**
 * The volume panel's view model.
 *
 * One decision, which is why this file is three lines of logic and twenty of
 * reasoning: which speaker glyph to show. It matters because the icon is the
 * only thing on screen that distinguishes *muted* from *turned all the way
 * down*, and those need different fixes — one is a button press, the other is a
 * drag.
 */

/**
 * Ordered loudest to quietest, plus the mute case which is not on that scale.
 *
 * `off` and `muted` are deliberately separate. A speaker at zero is unmuted and
 * obeying a slider the user set; a muted speaker is holding a level it will
 * snap back to. Showing one glyph for both is how you get a listener dragging a
 * slider that is already where they want it.
 */
export type VolumeIcon = "muted" | "off" | "low" | "high";

/**
 * The threshold between one wave and two.
 *
 * Matches the original. There is nothing acoustic about 50 — Sonos volume is
 * not linear in loudness — but the icon is a rough gauge sitting next to an
 * exact number, and its only job is to change while you drag.
 */
export const LOUD_FROM = 50;

export function volumeIcon(volume: number, muted: boolean): VolumeIcon {
  // Mute wins over the level, always. The level is what the speaker will
  // return to, not what it is doing, and reporting it as `high` while nothing
  // is audible is the one genuinely misleading combination here.
  if (muted) return "muted";
  if (volume <= 0) return "off";
  return volume < LOUD_FROM ? "low" : "high";
}

/**
 * The one-tap levels.
 *
 * Not a uniform ramp: the steps widen as they climb (10, 10, 20, 20), because
 * the useful resolution is all at the quiet end — 25 to 35 is a real change in
 * a room, and 65 to 85 is barely one.
 *
 * Neither end of the scale is offered. Zero would duplicate the mute button
 * sitting next to these, and 100 is not something to put one tap away — the
 * drag it takes to reach is the confirmation.
 */
export const VOLUME_PRESETS: readonly number[] = [25, 35, 45, 65, 85];
