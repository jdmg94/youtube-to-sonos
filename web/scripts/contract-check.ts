/**
 * Runtime contract check. Calls the real backend and asserts the responses
 * match `lib/api/types.ts`.
 *
 * The compiler cannot see the wire: `as T` on a fetch response is an assertion,
 * not a check, so a backend that quietly renames a field type-checks perfectly
 * and fails at runtime. This is the thing that notices.
 *
 *   pnpm check:contract                          # against the dev proxy
 *   NEXT_PUBLIC_API_BASE=http://127.0.0.1:5001 pnpm check:contract   # straight at Flask
 *
 * Needs a running backend, and a Sonos speaker for the speaker-bound half.
 * Read-only: it never plays, stops, or changes volume — and on the Hue side it
 * never pairs a bridge or starts a light stream, since the bridge allows only
 * one and taking the slot would stop whatever is currently driving the room.
 */
import { api, ApiError } from "../src/lib/api/client.ts";
import { isAnalysisPending } from "../src/lib/api/types.ts";
import type {
  CacheState,
  HueAnalysis,
  HueAnalysisPending,
  PlaybackState,
} from "../src/lib/api/types.ts";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const isNullOr = (v: unknown, t: string) => v === null || typeof v === t;
const HMS = /^\d+:\d{2}:\d{2}$/;

/**
 * Run a group of checks, recording an unexpected throw as a failure instead of
 * abandoning the run.
 *
 * Everything else here throws straight out to the harness handler, which is
 * right for `health` and `devices` — nothing downstream means anything without
 * them. The Hue sections are different: they sit in the middle of the script,
 * they are the newest thing in it, and an older backend answers all of them
 * with a 404. Without this, one missing endpoint reports as a harness crash and
 * silently takes the station, now-playing, volume and SSE checks with it — the
 * script says nothing about the parts that were working fine.
 */
async function section(run: () => Promise<void>) {
  try {
    await run();
  } catch (e) {
    const detail = e instanceof ApiError && e.status === 404
      ? `${e.message} — is the backend older than this feature?`
      : String(e);
    check("section completed", false, detail);
  }
}

const CACHE_STATES: CacheState[] = ["done", "running", "queued", "failed", "missing"];
const PLAYBACK_STATES: PlaybackState[] = [
  "PLAYING",
  "PAUSED_PLAYBACK",
  "STOPPED",
  "TRANSITIONING",
];

async function main() {
  console.log(`\n# health`);
  const h = await api.health();
  check("status is ok", h.status === "ok");
  check("stream_host is string", typeof h.stream_host === "string");
  check("port is number", typeof h.port === "number");
  check("ytdlp_age_days is number|null", isNullOr(h.ytdlp_age_days, "number"));
  check("ytdlp_stale is boolean", typeof h.ytdlp_stale === "boolean");
  check("js_runtimes is string[]", Array.isArray(h.js_runtimes));
  check("cookies is boolean", typeof h.cookies === "boolean");
  check("stations is number", typeof h.stations === "number");
  console.log(
    `  ->    yt-dlp ${h.ytdlp_version}, ${h.ytdlp_age_days}d old, stale=${h.ytdlp_stale}, ` +
      `runtimes=[${h.js_runtimes}], cookies=${h.cookies}`,
  );
  if (h.ytdlp_stale) console.log("  WARN  yt-dlp is stale — downloads are likely to fail");
  if (h.js_runtimes.length === 0) console.log("  WARN  no JS runtime — extraction will fail");

  console.log(`\n# devices`);
  const devices = await api.devices();
  check("is a bare array", Array.isArray(devices));
  check(
    "entries are {name, ip}",
    devices.every((d) => typeof d.name === "string" && typeof d.ip === "string"),
  );
  console.log(`  ->    ${devices.map((d) => `${d.name}@${d.ip}`).join(", ") || "none"}`);

  console.log(`\n# downloads`);
  const dl = await api.downloads();
  check("workers is number", typeof dl.workers === "number");
  check("gate is boolean", typeof dl.gate === "boolean");
  check("running is an object map", !!dl.running && typeof dl.running === "object");
  check("pending is an object map", !!dl.pending && typeof dl.pending === "object");
  check("downloads is an array", Array.isArray(dl.downloads));
  check("priority is number|null", dl.downloads.every((d) => isNullOr(d.priority, "number")));

  console.log(`\n# errors`);
  try {
    // Deliberately violating the signature: the 400 path is part of the contract.
    await api.info(undefined as unknown as string);
    check("missing url rejects", false, "resolved instead of throwing");
  } catch (e) {
    check("missing url throws ApiError(400)", e instanceof ApiError && e.status === 400, String(e));
  }
  try {
    await fetchUnknownEndpoint();
    check("unknown /api/ path rejects", false, "resolved instead of throwing");
  } catch (e) {
    const isJson404 = e instanceof ApiError && e.status === 404 && e.message.length > 0;
    check("unknown /api/ path returns JSON 404, not HTML", isJson404, String(e));
  }

  console.log(`\n# hue`);
  await section(checkHue);

  const ip = process.env.DEVICE_IP ?? devices[0]?.ip;
  if (!ip) {
    console.log("\n! no speaker discovered — skipping speaker-bound checks");
    return;
  }

  console.log(`\n# station (${ip})`);
  const st = await api.station(ip);
  check("device_ip is echoed back", st.device_ip === ip, `got ${st.device_ip}`);
  check("index is number", typeof st.index === "number");
  check("exhausted is boolean", typeof st.exhausted === "boolean");
  check("tracks is an array", Array.isArray(st.tracks));
  check(
    "tracks key on `id`, not `video_id`",
    st.tracks.every((t) => typeof t.id === "string" && !("video_id" in t)),
  );
  check("cached is in the union", st.tracks.every((t) => CACHE_STATES.includes(t.cached)));
  check("queue_pos is number|null", st.tracks.every((t) => isNullOr(t.queue_pos, "number")));
  check("duration is seconds|null", st.tracks.every((t) => isNullOr(t.duration, "number")));
  check("title is string|null", st.tracks.every((t) => isNullOr(t.title, "string")));
  console.log(`  ->    ${st.tracks.length} track(s), cursor at ${st.index}`);

  console.log(`\n# hue analysis`);
  await section(() => checkAnalysis(st.tracks.find((t) => t.cached === "done")?.id ?? null));

  console.log(`\n# now-playing (${ip})`);
  const np = await api.nowPlaying(ip);
  check("state is in the union", PLAYBACK_STATES.includes(np.state), `got ${np.state}`);
  check("playlist_position is number", typeof np.playlist_position === "number");
  check("station_index is number|null", isNullOr(np.station_index, "number"));
  check("is_radio is boolean", typeof np.is_radio === "boolean");
  check("video_id is string|null", isNullOr(np.video_id, "string"));
  check("duration is H:MM:SS|null", np.duration === null || HMS.test(np.duration));
  check("position is H:MM:SS|null", np.position === null || HMS.test(np.position));
  check("is_radio agrees with video_id", np.is_radio === (np.video_id !== null));
  console.log(`  ->    ${np.state} "${np.title}" ${np.position}/${np.duration}`);

  console.log(`\n# volume (${ip})`);
  const vol = await api.getVolume(ip);
  check("volume is number", typeof vol.volume === "number");
  check("volume is 0-100", vol.volume >= 0 && vol.volume <= 100);
  check("mute is boolean", typeof vol.mute === "boolean");
  check("GET includes device_ip", typeof vol.device_ip === "string");
  console.log(`  ->    ${vol.volume}, mute=${vol.mute}`);

  console.log(`\n# events (SSE)`);
  await checkFirstEventFrame(ip);
}

/**
 * The bridge half of the Hue contract.
 *
 * Never starts or stops a stream: the bridge permits exactly one, so a check
 * that started one would take the slot from whatever is actually playing the
 * lights, and a check that stopped one would turn the room off. Health is free
 * — it touches no network — and the rest is a read against a bridge on the LAN.
 */
async function checkHue() {
  const h = await api.hueHealth();
  check("paired is boolean", typeof h.paired === "boolean");
  check("bridge_ip is string|null", isNullOr(h.bridge_ip, "string"));
  check("bridge_id is string|null", isNullOr(h.bridge_id, "string"));
  check("streaming is boolean", typeof h.streaming === "boolean");
  check("area is string|null", isNullOr(h.area, "string"));
  check("error is string|null", isNullOr(h.error, "string"));
  check("channels is number[]", isNumberArray(h.channels));
  check(
    "psk_profile is [identity, ciphersuite]|null",
    h.psk_profile === null ||
      (Array.isArray(h.psk_profile) &&
        h.psk_profile.length === 2 &&
        h.psk_profile.every((s) => typeof s === "string")),
    JSON.stringify(h.psk_profile),
  );
  // Never: it is the shared secret for the light stream and the UI has no use
  // for it, so it leaking into the payload is a security regression, not a
  // typing one.
  check("clientkey is never echoed", !("clientkey" in h));
  console.log(
    `  ->    paired=${h.paired} bridge=${h.bridge_ip ?? "none"} ` +
      `streaming=${h.streaming} psk=${h.psk_profile?.join(" / ") ?? "not yet known"}`,
  );

  if (!h.paired) {
    /*
     * Discovery is the only Hue surface an unpaired backend has, and it is the
     * entire input to the pairing UI — so it is checked exactly when there is
     * nothing else to check. It costs a 5s mDNS sweep plus a possible round
     * trip to Philips, which is why a paired setup skips it.
     */
    console.log("  ->    not paired; scanning instead (mDNS, ~5s)");
    const { bridges } = await api.hueDiscover();
    check("bridges is an array", Array.isArray(bridges));
    check("bridge ip is string", bridges.every((b) => typeof b.ip === "string"));
    check("bridge id is string|null", bridges.every((b) => isNullOr(b.id, "string")));
    check("bridge name is string|null", bridges.every((b) => isNullOr(b.name, "string")));
    check(
      "source is mdns|cloud",
      bridges.every((b) => b.source === "mdns" || b.source === "cloud"),
      bridges.map((b) => b.source).join(","),
    );
    console.log(`  ->    ${bridges.map((b) => `${b.ip}(${b.source})`).join(", ") || "none"}`);
    return;
  }

  const { areas } = await api.hueAreas();
  check("areas is an array", Array.isArray(areas));
  check("area id is string", areas.every((a) => typeof a.id === "string"));
  check("area name is string|null", areas.every((a) => isNullOr(a.name, "string")));
  check("area status is string|null", areas.every((a) => isNullOr(a.status, "string")));
  check("area channels is number[]", areas.every((a) => isNumberArray(a.channels)));
  check(
    "area positions is an object map",
    areas.every((a) => !!a.positions && typeof a.positions === "object"),
  );
  /*
   * The two things the gradient reads. Both fail silently if the bridge ever
   * changes shape: a key that is not a channel is a position that never gets
   * looked up, and a value missing an axis makes the spatial sort NaN — which
   * `Array.prototype.sort` leaves in whatever order it found, so the lights
   * would still light and the gradient would simply stop being spatial.
   */
  check(
    "every positions key is one of the area's channels",
    areas.every((a) => Object.keys(a.positions).every((key) => a.channels.includes(Number(key)))),
    areas.map((a) => `${a.name}: ${Object.keys(a.positions).join(",")}`).join(" | "),
  );
  check(
    "every position is {x,y,z} numbers or null",
    areas.every((a) =>
      Object.values(a.positions).every(
        (p) => p === null || (["x", "y", "z"] as const).every((axis) => typeof p[axis] === "number"),
      ),
    ),
  );
  const placed = areas.reduce(
    (n, a) => n + Object.values(a.positions).filter((p) => p !== null).length,
    0,
  );
  console.log(
    `  ->    ${areas.length} area(s): ` +
      `${areas.map((a) => `${a.name}[${a.channels.length}]`).join(", ") || "none"}`,
  );
  // Worth printing even though nothing asserts on it: zero positions is the
  // expected answer for an area nobody arranged in the Hue app, and it is the
  // difference between a spatial gradient and one laid out by channel id.
  console.log(`  ->    ${placed} channel(s) with a position`);

  const { lights } = await api.hueLights();
  check("lights is an array", Array.isArray(lights));
  check("light id is string", lights.every((l) => typeof l.id === "string"));
  check("light name is string|null", lights.every((l) => isNullOr(l.name, "string")));
  check("light archetype is string|null", lights.every((l) => isNullOr(l.archetype, "string")));
  check("light owner is string|null", lights.every((l) => isNullOr(l.owner, "string")));
  check("light on is boolean|null", lights.every((l) => isNullOr(l.on, "boolean")));
  check("light brightness is number|null", lights.every((l) => isNullOr(l.brightness, "number")));
  // The bridge reports brightness as a percentage. A 0-255 value here would
  // type-check and render as a full bar on every lamp.
  check(
    "brightness is 0-100, not 0-255",
    lights.every((l) => l.brightness === null || (l.brightness >= 0 && l.brightness <= 100)),
  );

  const { groups } = await api.hueGroups();
  check("groups is an array", Array.isArray(groups));
  check("group id is string", groups.every((g) => typeof g.id === "string"));
  check("group name is string|null", groups.every((g) => isNullOr(g.name, "string")));
  check(
    "group kind is room|zone",
    groups.every((g) => g.kind === "room" || g.kind === "zone"),
    groups.map((g) => g.kind).join(","),
  );
  check(
    "group grouped_light is string|null",
    groups.every((g) => isNullOr(g.grouped_light, "string")),
  );
  check(
    "group children is string[]",
    groups.every((g) => Array.isArray(g.children) && g.children.every((c) => typeof c === "string")),
  );
  console.log(`  ->    ${lights.length} light(s), ${groups.length} group(s)`);
}

/**
 * The analysis sidecar the render loop parses.
 *
 * All three answers are contractual, so none of them is a failure: 200 with
 * features, 202 while a capture is being analysed, and 404 for a track cached
 * with `HUE_ANALYZE` off — which is every track downloaded before the bridge
 * was paired. Only a *fourth* answer, or a 200 that does not fit `HueAnalysis`,
 * is a break.
 */
async function checkAnalysis(videoId: string | null) {
  if (!videoId) {
    console.log("  ->    no fully-cached track to ask about — skipped");
    return;
  }

  let body: HueAnalysis | HueAnalysisPending;
  try {
    body = await api.hueAnalysis(videoId);
  } catch (e) {
    check(
      "analysis answers 200, 202 or 404",
      e instanceof ApiError && e.status === 404,
      String(e),
    );
    if (e instanceof ApiError && e.status === 404) {
      console.log(`  ->    ${videoId}: not analysed, and none scheduled`);
    }
    return;
  }

  if (isAnalysisPending(body)) {
    check("pending carries a numeric queue depth", typeof body.queued === "number");
    console.log(`  ->    ${videoId}: analysing, ${body.queued} queued`);
    return;
  }

  check("version is number", typeof body.version === "number");
  check("duration is number", typeof body.duration === "number");
  check("tempo is number", typeof body.tempo === "number");
  check("frame_seconds is number", typeof body.frame_seconds === "number");
  check("beats is number[]", isNumberArray(body.beats));
  check("energy is number[]", isNumberArray(body.energy));
  check("brightness is number[]", isNumberArray(body.brightness));
  // `createRenderer` indexes the two together off one frame number. Different
  // lengths would read past the end of the shorter one and render `undefined`
  // as a colour component for the rest of the track.
  check(
    "energy and brightness are parallel",
    body.energy.length === body.brightness.length,
    `${body.energy.length} vs ${body.brightness.length}`,
  );
  check(
    "envelopes span the track",
    Math.abs(body.energy.length * body.frame_seconds - body.duration) < 1,
    `${body.energy.length} frames x ${body.frame_seconds}s vs ${body.duration}s`,
  );
  check("beats are in seconds and ascending", isAscending(body.beats));
  check(
    "beats land inside the track",
    body.beats.every((b) => b >= 0 && b <= body.duration + 1),
  );
  check(
    "energy and brightness are 0-1",
    [...body.energy, ...body.brightness].every((v) => v >= 0 && v <= 1),
  );
  console.log(
    `  ->    ${videoId}: v${body.version}, ${body.duration.toFixed(0)}s, ` +
      `${body.tempo.toFixed(1)} bpm, ${body.beats.length} beats, ${body.energy.length} frames`,
  );
}

const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n));

const isAscending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

/** There is no client method for a bogus path — that is the point of the test. */
async function fetchUnknownEndpoint() {
  const base = process.env.NEXT_PUBLIC_API_BASE ?? "";
  const res = await fetch(`${base}/api/definitely-not-an-endpoint`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "";
    throw new ApiError(message, res.status);
  }
}

/**
 * Reads one frame off the SSE stream. Node has no EventSource, and we only need
 * the first `data:` line, so this parses by hand rather than pulling a
 * dependency in for a check that runs once.
 */
async function checkFirstEventFrame(ip: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(api.eventsUrl(ip), { signal: controller.signal });
    check("content-type is text/event-stream", !!res.headers.get("content-type")?.includes("text/event-stream"));
    check("X-Accel-Buffering: no is set", res.headers.get("x-accel-buffering") === "no");

    // This runs on Node's fetch, which sends `Accept-Encoding: gzip` exactly
    // like a browser. A proxy that honours it buffers the whole stream in the
    // compressor and delivers nothing — headers arrive, bytes never do. The
    // backend prevents it with `Cache-Control: no-transform`; check that the
    // header survived, so the symptom is one legible line and not a 20s hang.
    const encoding = res.headers.get("content-encoding");
    check(
      "stream is not compressed",
      encoding === null,
      `Content-Encoding: ${encoding} — a compressed SSE stream never reaches the client`,
    );
    check(
      "Cache-Control carries no-transform",
      !!res.headers.get("cache-control")?.includes("no-transform"),
    );
    if (encoding !== null) return;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let frame: string | null = null;
    try {
      while (frame === null) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split("\n")) {
          if (line.startsWith("data: ")) frame = line.slice(6);
        }
      }
    } catch {
      // The 20s abort fired mid-read: nothing is streaming.
    }
    await reader.cancel().catch(() => {});

    if (frame === null) {
      check("a data frame arrives", false, "no data frame within 20s");
      return;
    }
    const parsed = JSON.parse(frame);
    check("frame parses as JSON", typeof parsed === "object" && parsed !== null);
    if ("error" in parsed) {
      console.log(`  ->    error frame: ${parsed.error}`);
      return;
    }
    check("frame carries `station`", "station" in parsed);
    check("station has index+tracks+exhausted",
      typeof parsed.station?.index === "number" &&
      Array.isArray(parsed.station?.tracks) &&
      typeof parsed.station?.exhausted === "boolean");
    check("station in a frame has no device_ip", !("device_ip" in parsed.station));
    check("frame carries now-playing state", PLAYBACK_STATES.includes(parsed.state));
    console.log(`  ->    ${parsed.state}, ${parsed.station.tracks.length} station track(s)`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nCONTRACT OK\n" : `\n${failures} CONTRACT FAILURE(S)\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("\nHARNESS ERROR:", e);
    process.exit(2);
  });
