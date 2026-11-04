"""Splits a song into vocals / drums / bass / other with Demucs and reports progress for MV Studio.

Output protocol (stdout, one line each): "PROGRESS <0-100>", then "DONE" on success. Errors go to stderr and exit code 1.
The four stems are written as <out-dir>/{vocals,drums,bass,other}.wav.
"""
import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

STEMS = ("vocals", "drums", "bass", "other")
PERCENT = re.compile(r"(\d{1,3})%")


def report(percent: int) -> None:
    print(f"PROGRESS {max(0, min(100, percent))}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    if not args.input.is_file():
        print(f"input file not found: {args.input}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="mvs-demucs-") as work:
        command = [sys.executable, "-m", "demucs", "-n", args.model, "--device", args.device, "-o", work, str(args.input)]
        report(1)
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        tail = b""
        buffer = b""
        # Demucs draws a tqdm bar on stderr, redrawn with carriage returns: read it piece by piece.
        while True:
            chunk = process.stderr.read(64)
            if not chunk:
                break
            tail = (tail + chunk)[-2000:]
            buffer = (buffer + chunk)[-200:]
            found = PERCENT.findall(buffer.decode("utf-8", "ignore"))
            if found:
                # Keep a little headroom: the last percent is reported only after the files are in place.
                report(min(int(found[-1]), 99))
        if process.wait() != 0:
            print(tail.decode("utf-8", "ignore").strip() or "demucs failed", file=sys.stderr)
            return 1

        produced = Path(work) / args.model / args.input.stem
        missing = [name for name in STEMS if not (produced / f"{name}.wav").is_file()]
        if missing:
            print(f"demucs did not produce: {', '.join(missing)}", file=sys.stderr)
            return 1
        args.out_dir.mkdir(parents=True, exist_ok=True)
        for name in STEMS:
            shutil.move(str(produced / f"{name}.wav"), str(args.out_dir / f"{name}.wav"))
    report(100)
    print("DONE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
