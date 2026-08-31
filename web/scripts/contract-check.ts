/**
 * Runtime contract check. Calls the real backend and asserts the responses
 * match `lib/api/types.ts`.
 *
 * The compiler cannot see the wire: `as T` on a fetch response is an assertion,
 * not a check, so a backend that quietly renames a field type-checks perfectly
 * and fails at runtime. This is the thing that notices.
 *
 *   npm run check:contract                       # against the dev proxy
 *   API=http://127.0.0.1:5001 npm run check:contract   # straight at Flask
 *
 * Needs a running backend, and a Sonos speaker for the speaker-bound half.
 * Read-only: it never plays, stops, or changes volume.
 */
import { api, ApiError } from "../src/lib/api/client.ts";
import type { CacheState, PlaybackState } from "../src/lib/api/types.ts";

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
