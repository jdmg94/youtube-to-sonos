import { useEffect, useRef } from "react";
import type { NowPlaying, StationBody } from "@/lib/api/types";
import { api } from "@/lib/api/client";

/**
 * Integrates with the browser's Media Session API to enable native OS controls:
 * - Lock screen controls on mobile
 * - Media keys on desktop (play/pause/prev/next)
 * - Notification tray controls
 * - Bluetooth/AirPods controls
 * - System media widgets
 *
 * IMPORTANT: Since audio plays on Sonos speakers (not in the browser), we create
 * a silent audio element to activate the Media Session API. The browser requires
 * an actual media element to enable OS controls.
 *
 * Gracefully degrades when Media Session API is unavailable.
 */
export function useMediaSession(
  nowPlaying: NowPlaying | null,
  station: StationBody | null,
  deviceIp: string | null
) {
  // Track the last video_id to detect track changes
  const lastVideoIdRef = useRef<string | null>(null);
  // Reference to the silent audio element
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Feature detection: bail early if Media Session API not supported
    if (!("mediaSession" in navigator)) {
      console.log("[Media Session] API not supported in this browser");
      return;
    }

    console.log("[Media Session] Initializing with nowPlaying:", {
      video_id: nowPlaying?.video_id,
      title: nowPlaying?.title,
      state: nowPlaying?.state,
      station_index: station?.index,
      deviceIp,
    });

    const mediaSession = navigator.mediaSession;

    // Create a silent audio element if it doesn't exist
    // This is required because Media Session API only activates when
    // the browser is actually playing media
    if (!audioRef.current) {
      console.log("[Media Session] Creating silent audio element");
      audioRef.current = new Audio();
      audioRef.current.loop = true;
      audioRef.current.volume = 0; // Silent

      // Create a 1-second silent MP3 (44.1kHz mono, minimal size)
      // This is more compatible across browsers than WAV
      const silentMp3 = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4S2FzbwAAAAAAAAAAAAAAAAAAAAD/+xDEAAAAAAAAAAAAAAAAAAAAAABJbmZvAAAADwAAAAIAAAOEALu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7v//////////////////////////////////////////////////////////////////wAAAExhdmM1OC4xMwAAAAAAAAAAAAAAACQAAAAAAAAAAAOEthZW8AAAAAAAAAAAAAAAAAAAA//sQxAADgnKCFAAAAIAAAP+AAAAAQAAAB4AAAACAgICAgICAgICAgICAgICAgICAgIA=";
      audioRef.current.src = silentMp3;
      audioRef.current.preload = "auto";
    }

    // Get the current track from station data (has YouTube thumbnail URL)
    const currentTrack = station && nowPlaying?.station_index != null
      ? station.tracks[nowPlaying.station_index]
      : null;

    // Helper to create artwork array (Media Session spec expects multiple sizes)
    const createArtwork = (thumbnailUrl: string): MediaImage[] => {
      // Use YouTube's CDN thumbnail (already available, no proxy needed)
      // Provide multiple size hints for OS optimization
      return [
        { src: thumbnailUrl, sizes: "120x90", type: "image/jpeg" },
        { src: thumbnailUrl, sizes: "320x180", type: "image/jpeg" },
        { src: thumbnailUrl, sizes: "480x360", type: "image/jpeg" },
      ];
    };

    // Update metadata when track changes or playback state changes
    if (nowPlaying && nowPlaying.video_id && currentTrack) {
      lastVideoIdRef.current = nowPlaying.video_id;

      console.log("[Media Session] Setting metadata:", {
        title: currentTrack.title || "Unknown Title",
        artist: currentTrack.uploader || "Unknown Artist",
        thumbnail: currentTrack.thumbnail,
        state: nowPlaying.state,
      });

      // Set metadata (title, artist, album, artwork)
      // Use station track data which has YouTube CDN thumbnail
      mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || nowPlaying.title || "Unknown Title",
        artist: currentTrack.uploader || nowPlaying.artist || "Unknown Artist",
        album: currentTrack.uploader || nowPlaying.artist || "", // Use artist/uploader as album
        artwork: currentTrack.thumbnail ? createArtwork(currentTrack.thumbnail) : undefined,
      });

      // Set playback state and control silent audio element
      if (nowPlaying.state === "PLAYING") {
        console.log("[Media Session] Setting state to PLAYING");
        mediaSession.playbackState = "playing";
        // Start silent audio to activate media controls
        audioRef.current?.play().catch((err) => {
          console.warn("[Media Session] Could not start silent audio:", err);
        });
      } else if (nowPlaying.state === "PAUSED_PLAYBACK") {
        console.log("[Media Session] Setting state to PAUSED");
        mediaSession.playbackState = "paused";
        // Pause silent audio
        audioRef.current?.pause();
      } else {
        console.log("[Media Session] Setting state to NONE (state was:", nowPlaying.state, ")");
        mediaSession.playbackState = "none";
        // Stop silent audio
        audioRef.current?.pause();
      }
    } else {
      console.log("[Media Session] Clearing metadata (no nowPlaying or no video_id)");
      // No track playing - clear metadata
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
      audioRef.current?.pause();
      lastVideoIdRef.current = null;
    }

    // Set up action handlers (only needs to be done once, but setting repeatedly is safe)
    // These handlers call the backend transport API

    mediaSession.setActionHandler("play", async () => {
      console.log("[Media Session] Play action triggered");
      if (!deviceIp) {
        console.warn("[Media Session] No device IP available for play action");
        return;
      }
      try {
        // Start silent audio immediately for responsive UI
        audioRef.current?.play().catch(() => {});
        await api.transport({ device_ip: deviceIp, action: "play" });
        console.log("[Media Session] Play action completed");
      } catch (err) {
        console.error("[Media Session] Play action failed:", err);
      }
    });

    mediaSession.setActionHandler("pause", async () => {
      console.log("[Media Session] Pause action triggered");
      if (!deviceIp) {
        console.warn("[Media Session] No device IP available for pause action");
        return;
      }
      try {
        // Pause silent audio immediately for responsive UI
        audioRef.current?.pause();
        await api.transport({ device_ip: deviceIp, action: "pause" });
        console.log("[Media Session] Pause action completed");
      } catch (err) {
        console.error("[Media Session] Pause action failed:", err);
      }
    });

    mediaSession.setActionHandler("previoustrack", async () => {
      console.log("[Media Session] Previous track action triggered");
      if (!deviceIp) {
        console.warn("[Media Session] No device IP available for prev action");
        return;
      }
      try {
        await api.transport({ device_ip: deviceIp, action: "prev" });
        console.log("[Media Session] Previous track action completed");
      } catch (err) {
        console.error("[Media Session] Previous track action failed:", err);
      }
    });

    mediaSession.setActionHandler("nexttrack", async () => {
      console.log("[Media Session] Next track action triggered");
      if (!deviceIp) {
        console.warn("[Media Session] No device IP available for next action");
        return;
      }
      try {
        await api.transport({ device_ip: deviceIp, action: "next" });
        console.log("[Media Session] Next track action completed");
      } catch (err) {
        console.error("[Media Session] Next track action failed:", err);
      }
    });

    console.log("[Media Session] Action handlers registered");

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
      // Stop and clean up the silent audio element
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
    };
  }, [nowPlaying, station, deviceIp]);
}
