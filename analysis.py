"""Beat and timbre analysis of cached tracks, for driving the Hue lights.

Imported by app.py, which owns the policy (whether to analyse at all) and the
HTTP surface. Nothing here imports app.py — paths are passed in.

Three decisions shape this module:

**Analysis rides the transcode we already do.** ffmpeg is decoding the whole
track to produce the mp3, so a second output costs one more encode of already
decoded frames rather than a separate decode pass over the finished file.
`pcm_output_args` supplies that output; this module consumes what it wrote.

**It produces features, not colours.** Mapping energy and brightness onto a
palette belongs in the render loop, where it is cheap to change and can be unit
tested. Baking colours in here would mean re-analysing every cached track to
adjust a palette — minutes of CPU to change a constant.

**It runs on its own worker, not the download scheduler.** That scheduler
prioritises by distance from what the speaker needs and gates on *the wire*;
this work is CPU-bound, so a job of ours sitting on a download worker would
starve the downloads it shares a pool with, under a gate that means nothing for
it. One worker, because librosa is already internally parallel and a second
concurrent analysis mostly buys cache contention.
"""

import json
import logging
import os
import queue
import threading
import time

logger = logging.getLogger(__name__)

# What ffmpeg is told to emit and what we read back. 22050 Hz mono is librosa's
# own default sample rate, so this is the resampling it would do anyway — done
# once, by ffmpeg, in C.
SAMPLE_RATE = 22050
# librosa's default analysis hop: 512 samples, ~23ms at 22050.
HOP_LENGTH = 512
# The timeline we publish, in seconds per step. 10 Hz is finer than a listener
# can distinguish a light changing at, and coarse enough that a five minute
# track is a ~25 KB sidecar instead of a ~100 KB one.
FRAME_SECONDS = float(os.environ.get('ANALYSIS_FRAME_SECONDS', 0.1))
# Spectral centroid is mapped across this band, logarithmically — pitch is
# perceived in octaves, so a linear map would spend most of its range on the
# top octave where almost nothing sits.
CENTROID_MIN_HZ = 100.0
CENTROID_MAX_HZ = SAMPLE_RATE / 2
# Bounded on purpose. A backlog means PCM files piling up at ~2.6 MB per minute
# of audio each; dropping the oldest analysis is far better than filling the
# disk, because a missing analysis degrades the lights while a full disk stops
# playback.
QUEUE_MAX = int(os.environ.get('ANALYSIS_QUEUE_MAX', 8))

SIDECAR_VERSION = 1


_AVAILABLE = None


def available():
    """Whether librosa is installed, so nothing is captured that can't be used.

    `find_spec`, not an import: this is consulted once per download, and
    importing librosa costs seconds of numba JIT warmup that a machine with no
    Hue bridge should never pay. Memoised because a package does not appear
    mid-process, and because the negative case is the one on the hot path.

    Without this the PCM would still be written and still be queued, and the
    failure would surface only in the worker — after ~2.6 MB per minute of
    audio had already been spent on every track, on a machine that was never
    going to analyse any of them.
    """
    global _AVAILABLE
    if _AVAILABLE is None:
        import importlib.util
        _AVAILABLE = importlib.util.find_spec('librosa') is not None
        if not _AVAILABLE:
            logger.info("librosa is not installed; Hue beat analysis disabled")
    return _AVAILABLE


def pcm_output_args(pcm_path):
    """A second ffmpeg output writing raw mono PCM alongside the mp3.

    Deliberately raw: a container would need a seekable output to finalise its
    header, and this is written to a pipe-fed transcode that may be killed by
    the stall watchdog partway through. Headerless PCM truncates harmlessly —
    a short analysis is still a usable one.
    """
    return ['-map', '0:a', '-f', 's16le', '-acodec', 'pcm_s16le',
            '-ar', str(SAMPLE_RATE), '-ac', '1', pcm_path]


def analysis_paths(cache_dir, video_id):
    """(pcm, sidecar) for a video id.

    The PCM is named `.pcm.part` so that the startup sweep, which already
    deletes stray `*.part`, cleans up after a crash mid-transcode without
    needing to know this feature exists.
    """
    base = os.path.join(cache_dir, video_id)
    return base + '.pcm.part', base + '.beats.json'


def load(cache_dir, video_id):
    """The stored analysis for a track, or None. Never raises."""
    _, sidecar = analysis_paths(cache_dir, video_id)
    try:
        with open(sidecar) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    # A sidecar from an older layout is worse than none: the render loop would
    # read fields that have moved. Treat it as absent and let it be rebuilt.
    return data if data.get('version') == SIDECAR_VERSION else None


# --- feature extraction ------------------------------------------------------

def _bin_to_timeline(frame_times, values, n_out, reducer):
    """Collapse librosa's ~43 Hz frames onto our 10 Hz timeline.

    `reducer` is 'max' for energy and 'mean' for centroid, which is not
    interchangeable: a transient that peaks inside one bin is the whole point
    of the energy track and averaging would flatten it, while an averaged
    centroid is a more stable colour than whichever frame happened to be
    brightest.
    """
    import numpy as np

    out = np.zeros(n_out, dtype=np.float64)
    if len(values) == 0:
        return out
    idx = np.clip((frame_times / FRAME_SECONDS).astype(np.int64), 0, n_out - 1)
    if reducer == 'max':
        # Scatter-reduce rather than reduceat: bins with no frame in them (a
        # rounding artefact at these rates) simply stay 0 instead of needing a
        # special case.
        np.maximum.at(out, idx, values)
        return out
    totals = np.zeros(n_out, dtype=np.float64)
    counts = np.zeros(n_out, dtype=np.float64)
    np.add.at(totals, idx, values)
    np.add.at(counts, idx, 1.0)
    nonempty = counts > 0
    out[nonempty] = totals[nonempty] / counts[nonempty]
    return out


# How far an inter-beat interval may sit from the median and still count as
# one beat rather than a missed or doubled one. Beat tracking's characteristic
# error is skipping a beat (2x interval) or inserting one (0.5x), and 25% is
# comfortably clear of both while still admitting real tempo drift.
_BEAT_INTERVAL_TOLERANCE = 0.25


def _tempo_from_beats(beats, fallback):
    """BPM implied by the beat list we actually publish.

    librosa returns its own scalar tempo, but that number is quantised onto the
    discrete, log-spaced grid its estimator searches, so it can disagree with
    the beats it returned alongside: on a synthetic 120 BPM click track it says
    117.45 while its own beats average 0.5001s apart — 119.98 BPM. A consumer
    reading `tempo` and one reading `beats` would then disagree about the same
    track, and the one trusting `tempo` would drift out of time. Deriving it
    from the beats we ship makes that disagreement impossible.

    Median to *select*, mean to *measure*, because the two error sources here
    want opposite treatment. Beat times are snapped to librosa's 23.2ms frame
    grid, so on a steady tempo the intervals alternate between the two frame
    counts that straddle the truth (21 and 22 frames for our click track); the
    median returns one of those two quantised values — 117.65 BPM — while the
    mean averages the quantisation away. But a plain mean is hostage to a
    single missed beat, which contributes a whole extra period. So the median
    picks out which intervals are one beat long, and the mean of just those
    recovers the sub-frame precision.

    Falls back to librosa's scalar when there are too few intervals to judge.
    """
    import numpy as np

    if len(beats) < 4:
        return fallback
    intervals = np.diff(np.asarray(beats, dtype=np.float64))
    median = float(np.median(intervals))
    if median <= 0:
        return fallback
    inliers = intervals[np.abs(intervals - median) <= median * _BEAT_INTERVAL_TOLERANCE]
    # Can't be empty — the median is itself an interval (or the mean of two),
    # so at least one is always within tolerance of it.
    return 60.0 / float(np.mean(inliers))


def analyze_pcm(pcm_path):
    """Extract beat and timbre features from raw mono PCM.

    Returns the sidecar dict. Raises on unreadable or empty input.
    """
    # Imported here, not at module scope. librosa pulls in numba, whose JIT
    # warmup costs seconds on first use — a cost every startup would pay even
    # with no Hue bridge in the house.
    import numpy as np
    import librosa

    with open(pcm_path, 'rb') as fh:
        raw = fh.read()
    # Odd trailing byte if the transcode was killed mid-sample.
    if len(raw) % 2:
        raw = raw[:-1]
    if not raw:
        raise ValueError("no PCM data")

    y = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    duration = len(y) / SAMPLE_RATE

    tempo, beat_frames = librosa.beat.beat_track(
        y=y, sr=SAMPLE_RATE, hop_length=HOP_LENGTH)
    beats = librosa.frames_to_time(beat_frames, sr=SAMPLE_RATE,
                                   hop_length=HOP_LENGTH)

    rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)[0]
    centroid = librosa.feature.spectral_centroid(
        y=y, sr=SAMPLE_RATE, hop_length=HOP_LENGTH)[0]
    frame_times = librosa.frames_to_time(
        np.arange(len(rms)), sr=SAMPLE_RATE, hop_length=HOP_LENGTH)

    n_out = max(1, int(np.ceil(duration / FRAME_SECONDS)))
    energy = _bin_to_timeline(frame_times, rms, n_out, 'max')
    # Normalise against a high percentile, not the maximum: one clipped
    # transient would otherwise scale the entire track down and leave the
    # lights dim for four minutes. Values above it clamp to 1.
    ceiling = float(np.percentile(energy, 99)) if n_out > 1 else float(energy[0])
    energy = np.clip(energy / ceiling, 0.0, 1.0) if ceiling > 0 else energy

    centroid_t = _bin_to_timeline(frame_times[:len(centroid)], centroid,
                                  n_out, 'mean')
    # Log scale: pitch is perceived in octaves, so a linear map would compress
    # everything a listener cares about into the bottom of the range.
    lo, hi = np.log(CENTROID_MIN_HZ), np.log(CENTROID_MAX_HZ)
    with np.errstate(divide='ignore'):
        logc = np.log(np.maximum(centroid_t, CENTROID_MIN_HZ))
    brightness = np.clip((logc - lo) / (hi - lo), 0.0, 1.0)

    def compact(values):
        # 3 decimals is well below what a light can show, and roughly halves
        # the sidecar against full float repr.
        return [round(float(v), 3) for v in values]

    # Derived from the rounded list, not the raw one, so `tempo` describes
    # exactly the beats a client can read rather than ones we discarded.
    beats_out = compact(beats)
    tempo_out = _tempo_from_beats(beats_out, float(np.atleast_1d(tempo)[0]))

    return {
        'version': SIDECAR_VERSION,
        'duration': round(duration, 3),
        'tempo': round(tempo_out, 2),
        'frame_seconds': FRAME_SECONDS,
        'beats': beats_out,
        # Both are 0..1 and the same length, sampled every `frame_seconds`.
        'energy': compact(energy),
        'brightness': compact(brightness),
    }


def _write_sidecar(sidecar, data):
    tmp = sidecar + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(data, fh)
    os.replace(tmp, sidecar)


def analyze_to_sidecar(cache_dir, video_id):
    """Analyse a track's PCM and write its sidecar. Always removes the PCM."""
    pcm, sidecar = analysis_paths(cache_dir, video_id)
    try:
        started = time.time()
        data = analyze_pcm(pcm)
        _write_sidecar(sidecar, data)
        logger.info(f"Analysed {video_id}: {data['tempo']:.0f} BPM, "
                    f"{len(data['beats'])} beats, "
                    f"{time.time() - started:.1f}s")
        return data
    finally:
        # Unconditional. The PCM is ~2.6 MB per minute of audio and is useless
        # once read; leaving it behind on the failure path is how a disk fills
        # up over a long session.
        _unlink(pcm)


def _unlink(path):
    try:
        os.unlink(path)
    except OSError:
        pass


# --- the worker --------------------------------------------------------------

_QUEUE = queue.Queue(maxsize=QUEUE_MAX)
_WORKER = None
_WORKER_LOCK = threading.Lock()


def _worker():
    while True:
        cache_dir, video_id = _QUEUE.get()
        try:
            analyze_to_sidecar(cache_dir, video_id)
        except Exception as e:
            # Never fatal. A track without analysis still plays; the lights
            # just fall back to whatever the render loop does without one.
            logger.warning(f"Analysis failed for {video_id}: {e}")
        finally:
            _QUEUE.task_done()


def submit(cache_dir, video_id):
    """Queue a track for analysis. Best-effort: returns False if it was dropped.

    Started lazily so a deployment with no Hue bridge never spawns the thread.
    """
    global _WORKER
    with _WORKER_LOCK:
        if _WORKER is None or not _WORKER.is_alive():
            _WORKER = threading.Thread(target=_worker, name='analysis',
                                       daemon=True)
            _WORKER.start()
    try:
        _QUEUE.put_nowait((cache_dir, video_id))
        return True
    except queue.Full:
        # Drop rather than block: this is called from a download worker, and
        # blocking it would stall the pipeline that actually feeds the speaker.
        logger.warning(f"Analysis backlog full; skipping {video_id}")
        _unlink(analysis_paths(cache_dir, video_id)[0])
        return False


def pending():
    """Queue depth, for /api/downloads-style introspection."""
    return _QUEUE.qsize()
