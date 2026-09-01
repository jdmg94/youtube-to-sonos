/**
 * Typed client for the Flask API.
 *
 * Requests go to a relative `/api/...` path, which `next.config.ts` rewrites to
 * the backend. That is why there is no CORS handling and no base URL here: to
 * the browser this is all same-origin. `API_BASE` exists only so non-browser
 * callers (tests, a future server component) can point somewhere absolute.
 */
import type {
  ApiErrorBody,
  Device,
  Downloads,
  Health,
  HueAnalysis,
  HueAnalysisPending,
  HueArea,
  HueBridge,
  HueGroup,
  HueHealth,
  HueLight,
  HuePairResponse,
  HueStreamResponse,
  NowPlaying,
  PlayRequest,
  PlayResponse,
  Rgb,
  Station,
  StationRefreshResponse,
  StopResponse,
  TransportRequest,
  TransportResponse,
  VideoInfo,
  VolumeGetResponse,
  VolumeRequest,
  VolumeState,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

/**
 * Default ceiling for a request. Deliberately not applied to `play` — see
 * `PLAY_TIMEOUT_MS`.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `/api/play` in `now` mode blocks until the seed's first bytes are on disk
 * (PLAY_START_TIMEOUT, 45s worst case) before it touches the speaker. Timing
 * out below that aborts a request the server is about to satisfy, and the user
 * sees "failed" on a song that then starts playing.
 */
const PLAY_TIMEOUT_MS = 90_000;

/** Discovery is an SSDP multicast scan; it is slow by nature. */
const DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Starting the light stream does an HTTPS PUT to the bridge and then up to four
 * DTLS handshakes while it works out which PSK profile this firmware wants.
 * Only the first start pays for all four, but that is the one a user is
 * watching, and timing out on it would abort a stream that is about to come up.
 */
const HUE_STREAM_TIMEOUT_MS = 45_000;

/**
 * A colour frame, unlike everything else here, has a deadline: it is one sample
 * of a render loop running many times a second, and a frame that takes longer
 * than this has already been superseded by the next one. Failing fast keeps a
 * stalled backend from accumulating in-flight requests.
 */
const HUE_COLOR_TIMEOUT_MS = 2_000;

/**
 * A failed API call. Carries the HTTP status and the yt-dlp failure flags so
 * callers can tell "the user did something impossible" (409) from "YouTube is
 * angry and retrying won't help" (429/502) from "the backend is gone" (0).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly botDetected: boolean;
  readonly forbidden: boolean;
  readonly staleExtractor: boolean;

  constructor(
    message: string,
    status: number,
    flags: {
      bot_detected?: boolean;
      forbidden?: boolean;
      stale_extractor?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.botDetected = flags.bot_detected ?? false;
    this.forbidden = flags.forbidden ?? false;
    this.staleExtractor = flags.stale_extractor ?? false;
  }

  /** The backend could not be reached at all, as opposed to refusing. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  /**
   * A yt-dlp failure class. All three mean the same retry will fail the same
   * way, so the UI must not offer a bare "try again".
   */
  get isYoutubeFailure(): boolean {
    return this.botDetected || this.forbidden || this.staleExtractor;
  }

  /**
   * A legitimate user action the server declined — Next on the last track,
   * refresh while on line-in. Show it as a no-op, not an error.
   */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** Caller's own cancellation, combined with the timeout. */
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * Turn a non-2xx response into an ApiError.
 *
 * The body is *usually* `{"error": ...}` — the backend has JSON handlers for
 * 404/405/500. But not always: when Flask is down, the Next proxy answers the
 * rewrite itself with an HTML 502, and blindly `JSON.parse`ing that is how a
 * client reports "Unexpected token '<'" instead of "backend unreachable".
 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(
      `${response.status} ${response.statusText || "Request failed"}`,
      response.status,
    );
  }
  if (body && typeof body === "object" && "error" in body) {
    const err = body as Partial<ApiErrorBody>;
    const message =
      typeof err.error === "string" && err.error
        ? err.error
        : `Request failed (${response.status})`;
    // Coerced rather than trusted: these drive whether the UI offers a retry.
    return new ApiError(message, response.status, {
      bot_detected: Boolean(err.bot_detected),
      forbidden: Boolean(err.forbidden),
      stale_extractor: Boolean(err.stale_extractor),
    });
  }
  return new ApiError(`Request failed (${response.status})`, response.status);
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    query,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  // Combine the caller's signal with our timeout so either can abort, and so
  // the timer is always cleared — an uncleared 90s timer on every play call
  // keeps the tab awake for no reason.
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
      cache: "no-store",
    });
  } catch (cause) {
    // A caller-initiated abort is not an error condition — let it propagate as
    // the AbortError it is so `useEffect` teardown doesn't surface a toast.
    if (signal?.aborted) throw cause;
    if (timeout.aborted) {
      throw new ApiError(`Request timed out after ${timeoutMs / 1000}s`, 0);
    }
    throw new ApiError("Could not reach the server", 0);
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------

export const api = {
  health: (signal?: AbortSignal) => request<Health>("/api/health", { signal }),

  devices: (signal?: AbortSignal) =>
    request<Device[]>("/api/devices", {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      signal,
    }),

  info: (url: string, signal?: AbortSignal) =>
    request<VideoInfo>("/api/info", { query: { url }, signal }),

  play: (body: PlayRequest, signal?: AbortSignal) =>
    request<PlayResponse>("/api/play", {
      method: "POST",
      body,
      timeoutMs: PLAY_TIMEOUT_MS,
      signal,
    }),

  transport: (body: TransportRequest, signal?: AbortSignal) =>
    request<TransportResponse>("/api/transport", { method: "POST", body, signal }),

  station: (deviceIp?: string, signal?: AbortSignal) =>
    request<Station>("/api/station", { query: { device_ip: deviceIp }, signal }),

  refreshStation: (deviceIp?: string, signal?: AbortSignal) =>
    request<StationRefreshResponse>("/api/station/refresh", {
      method: "POST",
      body: { device_ip: deviceIp },
      // Picking replacement tracks resolves them through yt-dlp synchronously.
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      signal,
    }),

  nowPlaying: (deviceIp?: string, signal?: AbortSignal) =>
    request<NowPlaying>("/api/now-playing", {
      query: { device_ip: deviceIp },
      signal,
    }),

  getVolume: (deviceIp?: string, signal?: AbortSignal) =>
    request<VolumeGetResponse>("/api/volume", {
      query: { device_ip: deviceIp },
      signal,
    }),

  setVolume: (body: VolumeRequest, signal?: AbortSignal) =>
    request<VolumeState>("/api/volume", { method: "POST", body, signal }),

  downloads: (signal?: AbortSignal) =>
    request<Downloads>("/api/downloads", { signal }),

  stop: (deviceIp?: string, signal?: AbortSignal) =>
    request<StopResponse>("/api/stop", {
      method: "POST",
      body: { device_ip: deviceIp },
      signal,
    }),

  /** The SSE URL. Not fetched here — `useEvents` owns the EventSource. */
  eventsUrl: (deviceIp?: string) =>
    buildUrl("/api/events", { device_ip: deviceIp }),

  // -- Philips Hue ---------------------------------------------------------

  /** Bridge and stream state. Touches no network server-side, so polling is cheap. */
  hueHealth: (signal?: AbortSignal) => request<HueHealth>("/api/hue/health", { signal }),

  hueDiscover: (signal?: AbortSignal) =>
    request<{ bridges: HueBridge[] }>("/api/hue/discover", {
      // mDNS, then possibly a round trip to discovery.meethue.com.
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      signal,
    }),

  /**
   * One attempt at the link-button flow. Throws `ApiError(428)` until the
   * button is pressed — which is a state to poll through, not a failure.
   * `ip` may be omitted to re-pair with the stored bridge.
   */
  huePair: (ip?: string, signal?: AbortSignal) =>
    request<HuePairResponse>("/api/hue/pair", { method: "POST", body: { ip }, signal }),

  hueLights: (signal?: AbortSignal) =>
    request<{ lights: HueLight[] }>("/api/hue/lights", { signal }),

  hueGroups: (signal?: AbortSignal) =>
    request<{ groups: HueGroup[] }>("/api/hue/groups", { signal }),

  hueAreas: (signal?: AbortSignal) =>
    request<{ areas: HueArea[] }>("/api/hue/areas", { signal }),

  /**
   * Beat and timbre features for a track.
   *
   * Resolves for a 202 as well as a 200 — analysis in flight is not an error —
   * so callers must narrow with `isAnalysisPending` before reading `beats`. A
   * 404 throws, and is final: nothing will ever analyse that track.
   */
  hueAnalysis: (videoId: string, signal?: AbortSignal) =>
    request<HueAnalysis | HueAnalysisPending>(
      `/api/hue/analysis/${encodeURIComponent(videoId)}`,
      { signal },
    ),

  hueStartStream: (area?: string, signal?: AbortSignal) =>
    request<HueStreamResponse>("/api/hue/stream", {
      method: "POST",
      body: { action: "start", area },
      timeoutMs: HUE_STREAM_TIMEOUT_MS,
      signal,
    }),

  hueStopStream: (signal?: AbortSignal) =>
    request<HueStreamResponse>("/api/hue/stream", {
      method: "POST",
      body: { action: "stop" },
      signal,
    }),

  /**
   * Push one colour at the running stream. Separate from `hueStartStream` only
   * for its timeout: this is the render loop's hot path.
   *
   * The backend's writer thread keeps resending whatever it last held at 25 Hz,
   * so this is a *setpoint*, not a frame — dropping one costs nothing and the
   * caller should never queue or retry them.
   */
  hueColor: (color: Rgb | Record<string, Rgb>, signal?: AbortSignal) =>
    request<HueStreamResponse>("/api/hue/stream", {
      method: "POST",
      body: { action: "color", color },
      timeoutMs: HUE_COLOR_TIMEOUT_MS,
      signal,
    }),
};
