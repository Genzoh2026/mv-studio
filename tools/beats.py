"""Local beat analysis for MV Studio. Needs only numpy and ffmpeg (to decode any audio file).

Finds kick / snare / hat hits, general pulses, a tempo estimate and a beat grid, plus 30 fps energy curves that a
renderer can follow. If the drums stem is given, the hits come from it (much cleaner); the pulse and the tempo always
come from the full mix.

The tempo is an ESTIMATE: onset autocorrelation is prone to double / half errors, so the result also lists the
alternatives. The hit times are the reliable part.

Output protocol (stdout): "PROGRESS <0-100>", then "DONE". The JSON is written to --out. Errors go to stderr, exit 1.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 22050
FPS = 30                 # curve and hit resolution
TEMPO_HOP = 256          # finer hop for the tempo (about 86 frames per second)
BAND_LOW = (30, 160)
BAND_MID = (160, 2500)
BAND_HIGH = (2500, 11000)
BPM_MIN, BPM_MAX = 60.0, 200.0
BPM_PRIOR_CENTER, BPM_PRIOR_SPREAD = 120.0, 1.0  # octaves; mild preference for common tempos
HALF_TEMPO_MIN = 85.0    # a detected tempo is halved only if the half is still at least this fast...
HALF_TEMPO_RATIO = 0.7   # ...and its autocorrelation peak is at least this fraction of the double tempo's
KICK_LEAK = 0.6          # share of the low band's rise subtracted from the mid band, so kicks do not read as snares


def progress(percent: int) -> None:
    print(f"PROGRESS {percent}", flush=True)


def decode(path: Path) -> np.ndarray:
    """Mono float32 samples at SR, via ffmpeg."""
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg was not found on PATH (it is needed to read audio files)")
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode != 0 or not result.stdout:
        raise SystemExit(f"ffmpeg could not read {path.name}: {result.stderr.decode('utf-8', 'ignore').strip()[:300]}")
    return np.frombuffer(result.stdout, dtype=np.float32)


def spectrogram(samples: np.ndarray, n_fft: int, hop: int) -> np.ndarray:
    """Magnitude STFT, shape (frames, n_fft // 2 + 1)."""
    padded = np.pad(samples, (n_fft // 2, n_fft // 2), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, n_fft)[::hop]
    return np.abs(np.fft.rfft(frames * np.hanning(n_fft).astype(np.float32), axis=1)).astype(np.float32)


def band_envelope(spec: np.ndarray, freqs: np.ndarray, band: tuple) -> np.ndarray:
    values = spec[:, (freqs >= band[0]) & (freqs < band[1])].sum(axis=1)
    scale = np.percentile(values, 99)
    return values / (scale if scale > 0 else 1.0)


def peak_pick(x: np.ndarray, pre_max: int, post_max: int, pre_avg: int, post_avg: int, delta: float, wait: int) -> list:
    """Indices of local maxima that rise above their surroundings by `delta` (same idea as librosa's peak_pick)."""
    peaks = []
    last = -wait - 1
    for n in range(len(x)):
        window = x[max(0, n - pre_max): n + post_max + 1]
        around = x[max(0, n - pre_avg): n + post_avg + 1]
        if x[n] >= window.max() and x[n] >= around.mean() + delta and n - last > wait:
            peaks.append(n)
            last = n
    return peaks


def rise_of(envelope: np.ndarray) -> np.ndarray:
    return np.maximum(np.diff(envelope, prepend=envelope[0]), 0)


def hits(rise: np.ndarray, delta: float) -> list:
    return [round(i / FPS, 3) for i in peak_pick(rise, 2, 2, 6, 6, delta, 2)]


def estimate_tempo(samples: np.ndarray):
    """(bpm, confidence, alternatives, beat times) from the full mix."""
    spec = spectrogram(samples, 1024, TEMPO_HOP)
    flux = np.maximum(np.diff(np.log1p(spec * 10), axis=0), 0).sum(axis=1)
    flux = flux - flux.mean()
    if len(flux) < 200 or not np.any(flux):
        return None, 0.0, [], []
    rate = SR / TEMPO_HOP
    size = 1 << (2 * len(flux) - 1).bit_length()
    spectrum = np.fft.rfft(flux, size)
    auto = np.fft.irfft(spectrum * np.conj(spectrum))[: len(flux)]
    auto /= auto[0] or 1.0
    lags = np.arange(len(auto), dtype=np.float64)
    lo, hi = int(rate * 60 / BPM_MAX), int(rate * 60 / BPM_MIN)
    candidates = np.arange(lo, min(hi, len(auto) - 2))
    if not len(candidates):
        return None, 0.0, [], []
    bpm_of = rate * 60 / candidates
    prior = np.exp(-0.5 * (np.log2(bpm_of / BPM_PRIOR_CENTER) / BPM_PRIOR_SPREAD) ** 2)
    best = candidates[np.argmax(auto[candidates] * prior)]
    # Hi-hats and eighth notes make the autocorrelation peak at double the tempo as well; when the half tempo is
    # still a musical tempo and nearly as strong, it is the beat people count.
    double = 2 * int(best)
    if rate * 60 / double >= HALF_TEMPO_MIN and double + 2 < len(auto):
        near = np.arange(double - 2, double + 3)
        half = near[np.argmax(auto[near])]
        if auto[half] >= HALF_TEMPO_RATIO * auto[best]:
            best = half
    # Parabolic interpolation around the best lag for a sub-frame tempo.
    a, b, c = auto[best - 1], auto[best], auto[best + 1]
    shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    lag = float(best + shift)
    bpm = rate * 60 / lag
    confidence = float(np.clip(auto[best] / (np.abs(auto[lo:hi]).mean() or 1.0) / 10, 0, 1))
    alternatives = [round(v, 1) for v in (bpm * 2, bpm / 2) if BPM_MIN <= v <= BPM_MAX]
    # Beat phase: the grid offset whose points land on the strongest onsets.
    grid_scores = [flux[np.arange(offset, len(flux), lag).astype(int)].sum() for offset in range(int(lag))]
    phase = int(np.argmax(grid_scores))
    beats = [round(t / rate, 3) for t in np.arange(phase, len(flux), lag)]
    return round(bpm, 2), round(confidence, 2), alternatives, beats


def analyse(audio: Path, drums: Path | None) -> dict:
    progress(5)
    full = decode(audio)
    if len(full) < SR:  # less than a second: nothing to analyse
        raise SystemExit("the audio is too short to analyse")
    progress(25)
    source = decode(drums) if drums else full
    hop = SR // FPS
    spec = spectrogram(source, 2048, hop)
    freqs = np.fft.rfftfreq(2048, 1 / SR)
    low, mid, high = (band_envelope(spec, freqs, band) for band in (BAND_LOW, BAND_MID, BAND_HIGH))
    low_rise = rise_of(low)
    progress(50)
    full_spec = spec if source is full else spectrogram(full, 2048, hop)
    rms = np.sqrt((full_spec ** 2).mean(axis=1))
    rms = rms / (rms.max() or 1.0)
    mix_rise = np.maximum(np.diff(np.log1p(full_spec * 10), axis=0, prepend=full_spec[:1]), 0).sum(axis=1)
    mix_rise = mix_rise / (np.percentile(mix_rise, 99) or 1.0)
    pulse = [round(i / FPS, 3) for i in peak_pick(mix_rise, 2, 2, 6, 6, 0.15, 3)]
    progress(75)
    bpm, confidence, alternatives, beats = estimate_tempo(full)
    frames = min(len(low), len(mid), len(high), len(rms))
    curve = lambda a: [round(float(v), 3) for v in np.clip(a[:frames], 0, 1.5)]
    return {
        "version": 1,
        "source": "local",
        "used_drums_stem": drums is not None,
        "fps": FPS,
        "duration": round(len(full) / SR, 2),
        "bpm": bpm,
        "bpm_note": "estimate; double or half the real tempo is a common mistake (see bpm_alternatives)",
        "bpm_confidence": confidence,
        "bpm_alternatives": alternatives,
        "beats": beats,
        "kick": hits(low_rise, 0.12),
        "snare": hits(np.maximum(rise_of(mid) - KICK_LEAK * low_rise, 0), 0.12),
        "hat": hits(rise_of(high), 0.15),
        "pulse": pulse,
        "low": curve(low), "mid": curve(mid), "high": curve(high), "rms": curve(rms),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--drums", type=Path, default=None, help="drums stem, if one exists")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    for path in (args.input, args.drums):
        if path is not None and not path.is_file():
            print(f"file not found: {path}", file=sys.stderr)
            return 1
    result = analyse(args.input, args.drums)
    args.out.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    progress(100)
    print("DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
