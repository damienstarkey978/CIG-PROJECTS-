"""The Shop Mix pipeline: scan stems, pick an engine, mix, write to output/."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mixer import PENDING_KEY, BaseMixer, LocalMixer, MixerError, RoExMixer, categorize  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STEMS_DIR = ROOT / "stems"
OUTPUT_DIR = ROOT / "output"
AUDIO_EXT = {".wav"}

BANNER = """
╔══════════════════════════════════════════════╗
║  💈  T H E   S H O P   M I X                 ║
║      autonomous AI audio engineer            ║
╚══════════════════════════════════════════════╝"""


def scan_stems(directory: Path = STEMS_DIR) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    return sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXT)


def print_drop_guide() -> None:
    print("📦 The stems/ folder is empty. To run a mix:")
    print(f"   1. In Pro Tools export every track as WAV, same start point, same sample rate.")
    print(f"   2. Name files by role, e.g. lead_vox.wav, kick.wav, bass.wav, guitar.wav.")
    print(f"   3. Drop them into: {STEMS_DIR}")
    print("   4. Run again: python src/pipeline.py")


def select_mixer() -> BaseMixer:
    key = os.getenv("ROEX_API_KEY", "").strip().strip('"').strip("'")
    if not key or key == PENDING_KEY:
        print("🎛️  No RoEx credentials yet, using offline LocalMixer.")
        return LocalMixer()
    print("🤖 RoEx API key detected, booting cloud RoExMixer.")
    return RoExMixer(api_key=key, target_loudness=-14.0, stereo_enhancement=True, creative_effects="dynamic")


def main() -> int:
    load_dotenv(ROOT / ".env")
    print(BANNER)
    stems = scan_stems()
    if not stems:
        print_drop_guide()
        return 0

    print(f"📦 Found {len(stems)} stems:")
    for s in stems:
        print(f"   • {s.name:<34} → {categorize(s.name)}")

    try:
        mixer = select_mixer()
    except MixerError as exc:
        print(f"❌ {exc}")
        return 1

    out = OUTPUT_DIR / ("shop_mix_master.wav" if isinstance(mixer, RoExMixer) else "shop_mix_preview.wav")
    print(f"💈 Engine: {mixer.name}")
    t0 = time.time()
    try:
        result = mixer.process_mix(stems, out)
    except MixerError as exc:
        print(f"❌ {exc}")
        return 1
    except Exception as exc:  # network / API failures
        print(f"❌ {mixer.name} failed: {exc}")
        return 1
    print(f"✨ Done in {time.time() - t0:.1f}s")
    print(f"🔊 Output: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
