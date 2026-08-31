import type { NextConfig } from "next";

/**
 * Where the Flask backend lives. Server-side only — the browser never sees it,
 * and never needs to: every request the UI makes is same-origin against this
 * Next server, which forwards it. That is what removes CORS from the picture
 * and what makes the app work unchanged behind a tunnel or reverse proxy,
 * where the backend's LAN IP would not be reachable from the browser at all.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:5000";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: "standalone",

  /*
   * Development only, and ignored entirely by `next build`.
   *
   * `next dev` serves /_next/* to `localhost` and nothing else, answering every
   * other origin with 403. That default is a poor fit here: this is a LAN app,
   * so the realistic dev loop is opening http://<lan-ip>:3100 on a phone to
   * check the layout on a real device — and the failure is silent and
   * misleading. The HTML is served fine, only the scripts are refused, so the
   * page renders its server-side markup and then simply never hydrates. What
   * you see is a perfectly styled UI stuck on its initial state, which looks
   * exactly like a hung network scan rather than a blocked asset.
   *
   * Private ranges only, matched segment-wise (`*` spans one octet). A public
   * address still has to be named explicitly via ALLOWED_DEV_ORIGINS.
   */
  allowedDevOrigins: [
    "127.0.0.1",
    "192.168.*.*",
    "10.*.*.*",
    ...(process.env.ALLOWED_DEV_ORIGINS?.split(",").map((host) => host.trim()).filter(Boolean) ??
      []),
  ],

  async rewrites() {
    return {
      // beforeFiles, so the proxy wins over anything in app/ that might later
      // sit at the same path. An accidental local route silently shadowing the
      // real API is a confusing failure; this makes the backend authoritative
      // for /api by construction.
      beforeFiles: [
        {
          source: "/api/:path*",
          destination: `${API_ORIGIN}/api/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },

  images: {
    // Station thumbnails come straight from YouTube's CDN, and are the only
    // remote images in the app.
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "*.ytimg.com" },
      { protocol: "https", hostname: "yt3.ggpht.com" },
    ],
  },
};

export default nextConfig;

/*
 * Deliberately NOT proxied: /media/<id>.mp3 and /media/<id>.jpg.
 *
 * Those are fetched by the Sonos speakers, not by the browser, using absolute
 * http://STREAM_HOST:PORT URLs the backend baked into the queue item's DIDL
 * metadata. A rewrite here would be dead code — the speaker never consults this
 * server — and "fixing" that by pointing STREAM_HOST at this app would break
 * playback outright, since Next does not serve the audio. STREAM_HOST must
 * always be an address the speakers can reach.
 */
