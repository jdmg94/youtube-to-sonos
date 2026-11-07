import { useEffect, useRef } from "react";
import type { NowPlaying } from "@/lib/api/types";
import { api } from "@/lib/api/client";

/**
 * Integrates with the browser's Media Session API to enable native OS controls:
 * - Lock screen controls on mobile
 * - Media keys on desktop (play/pause/prev/next)
 * - Notification tray controls
 * - Bluetooth/AirPods controls
 * - System media widgets
 *
 * Gracefully degrades when Media Session API is unavailable.
 */
export function useMediaSession(
  nowPlaying: NowPlaying | null,
  deviceIp: string | null
) {
  // Track the last video_id to detect track changes
  const lastVideoIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Feature detection: bail early if Media Session API not supported
    if (!("mediaSession" in navigator)) {
      return;
    }

    const mediaSession = navigator.mediaSession;

    // Helper to construct absolute artwork URL
    const getArtworkUrl = (videoId: string): string => {
      // Use window.location.origin to ensure absolute URL
      // This goes through Next.js proxy to backend /media/<id>.jpg
      return `${window.location.origin}/api/media/${videoId}.jpg`;
    };

    // Helper to create artwork array (Media Session spec expects multiple sizes)
    const createArtwork = (
      videoId: string
    ): MediaImage[] => {
      const url = getArtworkUrl(videoId);
      // Provide multiple size hints (backend serves one resolution, but OS can pick optimal)
      return [
        { src: url, sizes: "96x96", type: "image/jpeg" },
        { src: url, sizes: "128x128", type: "image/jpeg" },
        { src: url, sizes: "256x256", type: "image/jpeg" },
        { src: url, sizes: "512x512", type: "image/jpeg" },
      ];
    };

    // Update metadata when track changes or playback state changes
    if (nowPlaying && nowPlaying.video_id) {
      lastVideoIdRef.current = nowPlaying.video_id;

      // Set metadata (title, artist, album, artwork)
      mediaSession.metadata = new MediaMetadata({
        title: nowPlaying.title || "Unknown Title",
        artist: nowPlaying.artist || "Unknown Artist",
        album: nowPlaying.artist || "", // Use artist/uploader as album
        artwork: createArtwork(nowPlaying.video_id),
      });

      // Set playback state
      if (nowPlaying.state === "PLAYING") {
        mediaSession.playbackState = "playing";
      } else if (nowPlaying.state === "PAUSED_PLAYBACK") {
        mediaSession.playbackState = "paused";
      } else {
        mediaSession.playbackState = "none";
      }
    } else {
      // No track playing - clear metadata
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
      lastVideoIdRef.current = null;
    }

    // Set up action handlers (only needs to be done once, but setting repeatedly is safe)
    // These handlers call the backend transport API

    mediaSession.setActionHandler("play", async () => {
      if (!deviceIp) return;
      try {
        await api.transport({ device_ip: deviceIp, action: "play" });
      } catch (err) {
        console.error("Media Session play action failed:", err);
      }
    });

    mediaSession.setActionHandler("pause", async () => {
      if (!deviceIp) return;
      try {
        await api.transport({ device_ip: deviceIp, action: "pause" });
      } catch (err) {
        console.error("Media Session pause action failed:", err);
      }
    });

    mediaSession.setActionHandler("previoustrack", async () => {
      if (!deviceIp) return;
      try {
        await api.transport({ device_ip: deviceIp, action: "prev" });
      } catch (err) {
        console.error("Media Session prev action failed:", err);
      }
    });

    mediaSession.setActionHandler("nexttrack", async () => {
      if (!deviceIp) return;
      try {
        await api.transport({ device_ip: deviceIp, action: "next" });
      } catch (err) {
        console.error("Media Session next action failed:", err);
      }
    });

    // Cleanup: clear handlers and metadata on unmount
    return () => {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      }
    };
  }, [nowPlaying, deviceIp]);
}
