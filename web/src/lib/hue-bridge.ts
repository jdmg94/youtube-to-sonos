/**
 * The bridge's view models, and the one piece of real policy in the pairing
 * flow: how long to keep asking.
 *
 * Hue pairing is the only place in this app where an HTTP error is a *normal*
 * state rather than a failure. `POST /api/hue/pair` answers 428 for as long as
 * nobody has pressed the physical link button, which is not a problem to report
 * — it is the flow working. Getting that backwards shows the user an error
 * every second while they walk to the cupboard the bridge lives in.
 */
import type { HueArea, HueBridge, HueHealth } from "@/lib/api/types";
import { present } from "@/lib/api/types";

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * "Precondition Required" — the backend's chosen code for *press the button*.
 * Distinguishing it from every other 4xx is the whole of the pairing logic.
 */
export const LINK_BUTTON_STATUS = 428;

/**
 * Gap between pairing attempts.
 *
 * Each attempt is a real HTTP round trip to the bridge made server-side, and
 * the user is already committed to a physical walk — a second of latency on the
 * confirmation is imperceptible next to that, while a tighter poll would
 * hammer the bridge throughout.
 */
export const PAIR_POLL_MS = 2_000;

/**
 * How long to keep asking after the user starts pairing.
 *
 * The bridge accepts a `devicetype` registration for 30 seconds after the
 * button is pressed, but that clock starts at the *press*, and this one starts
 * when the user taps Pair — which is usually before they have got up. A minute
 * covers "tap, walk to the bridge, press it" with room to spare, and giving up
 * early is the failure that looks like the feature is broken.
 */
export const PAIR_WINDOW_MS = 60_000;

/**
 * What to do about a failed pairing attempt.
 *
 * `retry` — the button has not been pressed yet, which is the expected answer
 * for almost every attempt. `expired` — it was never pressed; a distinct
 * outcome from `failed` because the fix is "try again and press it", not
 * "something is wrong". `failed` — anything else, and it is decisive: a bridge
 * that is unreachable or refusing will refuse the next 29 attempts too, and
 * spending a minute on it hides the actual error behind a countdown.
 */
export type PairStep = "retry" | "expired" | "failed";

export function pairingStep(status: number, elapsedMs: number): PairStep {
  if (status !== LINK_BUTTON_STATUS) return "failed";
  return elapsedMs >= PAIR_WINDOW_MS ? "expired" : "retry";
}

/** Shown when the window runs out. Not an API message — the API never failed. */
export const PAIR_TIMEOUT_MESSAGE =
  "The link button was not pressed in time. Press it on the bridge, then try again.";

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

/** A bridge that told us nothing but its address. */
export const UNNAMED_BRIDGE = "Hue Bridge";

export interface BridgeView {
  label: string;
  /** The line under the label: address, and how we came to know about it. */
  detail: string;
}

/**
 * `source` is worth showing.
 *
 * A `cloud` result came from discovery.meethue.com, which only gets asked when
 * the mDNS scan found nothing — so it means "Philips says you own a bridge at
 * this address" rather than "we can see it". That is exactly the case where
 * pairing fails with a network error, and knowing which scan produced the row
 * turns that into an explicable outcome.
 */
export function describeBridge(bridge: HueBridge): BridgeView {
  return {
    label: present(bridge.name) ? bridge.name : UNNAMED_BRIDGE,
    detail:
      bridge.source === "mdns"
        ? `${bridge.ip} · found on this network`
        : `${bridge.ip} · from Philips' directory`,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * `live` is streaming, `ready` is paired and idle, `setup` needs the user, and
 * `error` is a stream that died on its own. Deliberately not booleans: the
 * banner has one appearance per state and a pile of flags is how two of them
 * end up rendering at once.
 */
export type HueTone = "loading" | "setup" | "ready" | "live" | "error";

export interface HueStatusView {
  tone: HueTone;
  label: string;
  detail: string | null;
}

/** Shown before the first `/api/hue/health` answers. */
export const HUE_UNKNOWN = "Checking for a Hue bridge…";

/**
 * The banner on the dialog trigger.
 *
 * `health.error` outranks everything except being live, because it is the only
 * report of a stream that stopped by itself — the bridge's ten-second idle
 * timeout, a firmware reboot, another app taking the single stream slot. All of
 * those leave `streaming: false`, identical to never having started, and the
 * lights simply stop with the button still saying "Start".
 */
export function describeHue(
  health: HueHealth | null,
  loading: boolean,
  areaName?: string | null,
): HueStatusView {
  if (!health) {
    return loading
      ? { tone: "loading", label: HUE_UNKNOWN, detail: null }
      : { tone: "error", label: "Hue unavailable", detail: null };
  }

  if (!health.paired) {
    return { tone: "setup", label: "Connect Hue lights", detail: null };
  }

  if (health.streaming) {
    const lights = `${health.channels.length} ${health.channels.length === 1 ? "light" : "lights"}`;
    return {
      tone: "live",
      label: present(areaName) ? areaName : "Lights following",
      detail: lights,
    };
  }

  if (present(health.error)) {
    return { tone: "error", label: "Lights stopped", detail: health.error };
  }

  return { tone: "ready", label: "Hue ready", detail: health.bridge_ip };
}

// ---------------------------------------------------------------------------
// Entertainment areas
// ---------------------------------------------------------------------------

/** Hue's own word for "a stream is running against this configuration". */
const AREA_ACTIVE = "active";

/** An area the bridge exposes but no lights have been assigned to. */
export const AREA_EMPTY_NOTE = "No lights assigned";

/** An area some other app is already streaming to. */
export const AREA_BUSY_NOTE = "In use by another app";

export const UNNAMED_AREA = "Entertainment area";

export interface AreaView {
  label: string;
  detail: string;
  /** Whether `POST /api/hue/stream` would be expected to succeed. */
  ready: boolean;
}

/**
 * Describe an area, including whether it can actually be streamed to.
 *
 * Two ways it cannot, and neither is visible from the area alone:
 *
 * An empty `channels` gets a 409 from the backend, which refuses to handshake
 * and send frames to nothing.
 *
 * A `status` of `active` means a stream is already running against this
 * configuration — and the bridge permits exactly one at a time. If that stream
 * is ours it is the normal, good state; if it is not, ours will be refused.
 * Same field, opposite meanings, so `health` has to be consulted to tell them
 * apart. Without this the user picks an area, gets a bridge-level error with no
 * mention of the Hue app they left open on their phone, and concludes this app
 * is broken.
 */
export function describeArea(area: HueArea, health: HueHealth | null): AreaView {
  const label = present(area.name) ? area.name : UNNAMED_AREA;
  const count = area.channels.length;

  if (count === 0) {
    return { label, detail: AREA_EMPTY_NOTE, ready: false };
  }

  const lights = `${count} ${count === 1 ? "light" : "lights"}`;
  const ours = Boolean(health?.streaming) && health?.area === area.id;
  if (area.status === AREA_ACTIVE && !ours) {
    return { label, detail: `${lights} · ${AREA_BUSY_NOTE}`, ready: false };
  }

  return { label, detail: lights, ready: true };
}

/**
 * Which area to stream to, derived rather than stored.
 *
 * Same reasoning as `useSpeaker`: a saved id that is missing from the current
 * list falls back to the first area *without* overwriting the saved id, so an
 * area that comes back — renamed group, bridge still booting — is silently
 * returned to. Writing the fallback back would forget the user's choice because
 * of a transient read.
 */
export function pickArea(areas: HueArea[], savedId: string | null): HueArea | null {
  return areas.find((area) => area.id === savedId) ?? areas[0] ?? null;
}
