"""Mix engines for The Shop Mix: abstract BaseMixer, offline LocalMixer, cloud RoExMixer."""

from __future__ import annotations

import array
import math
import struct
import tempfile
import time
import wave
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

PENDING_KEY = "PENDING_DEVELOPER_APPROVAL"

# Category keyword tables, checked in order (first hit wins).
CATEGORY_KEYWORDS: Dict[str, Tuple[str, ...]] = {
    "vocals": ("vox", "vocal", "lead", "bgv", "harmony", "choir", "adlib", "ad-lib", "rap"),
    "drums": ("kick", "snare", "drum", "hat", "tom", "cymbal", "overhead", "oh", "perc", "clap"),
    "bass": ("bass", "sub", "808"),
}
DEFAULT_CATEGORY = "instruments"


def categorize(filename: str) -> str:
    """Classify a stem as vocals, drums, bass or instruments from its filename."""
    name = Path(filename).stem.lower().replace("_", " ").replace("-", " ").replace(".", " ")
    words = name.split()
    for category, keys in CATEGORY_KEYWORDS.items():
        for key in keys:
            # short keys must match a whole word to avoid false hits ("oh" in "choir")
            if (len(key) <= 3 and key in words) or (len(key) > 3 and key in name):
                return category
    return DEFAULT_CATEGORY


class MixerError(RuntimeError):
    """Raised when a mixer cannot complete a job."""


class BaseMixer(ABC):
    """Provider interface: take stems, write a finished mix/master to output_path."""

    name = "base"

    @abstractmethod
    def process_mix(self, stems: Sequence[Path], output_path: Path) -> Path:
        """Mix the given stem files and write the result to output_path."""


# ---------------------------------------------------------------------------
# Local offline engine
# ---------------------------------------------------------------------------

def _db(x: float) -> float:
    return 20.0 * math.log10(max(x, 1e-9))


def _read_wav(path: Path, max_seconds: Optional[float]) -> Tuple[int, List[List[float]]]:
    """Decode a PCM WAV (16/24/32-bit) into per-channel float lists in [-1, 1]."""
    with wave.open(str(path), "rb") as w:
        ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        n = w.getnframes()
        if max_seconds:
            n = min(n, int(max_seconds * rate))
        raw = w.readframes(n)
    if width == 2:
        data = array.array("h")
        data.frombytes(raw[: len(raw) // 2 * 2])
        scale = 32768.0
        vals = list(data)
    elif width == 3:
        count = len(raw) // 3
        vals = [int.from_bytes(raw[i * 3:i * 3 + 3], "little", signed=True) for i in range(count)]
        scale = 8388608.0
    elif width == 4:
        data = array.array("i")
        data.frombytes(raw[: len(raw) // 4 * 4])
        vals = list(data)
        scale = 2147483648.0
    else:
        raise MixerError(f"{path.name}: unsupported sample width {width * 8}-bit (use 16/24/32-bit PCM WAV)")
    chans = [[v / scale for v in vals[c::ch]] for c in range(ch)]
    return rate, chans


class LocalMixer(BaseMixer):
    """Offline backup engine: category based gain staging, panning and a preview render."""

    name = "LocalMixer"

    # target RMS (dBFS) per category, pan position (-1 left .. +1 right) cycle per category
    TARGET_RMS = {"vocals": -18.0, "drums": -20.0, "bass": -21.0, "instruments": -23.0}
    PAN_CYCLE = {
        "vocals": [0.0], "bass": [0.0], "drums": [0.0, -0.3, 0.3],
        "instruments": [-0.6, 0.6, -0.35, 0.35],
    }
    MAX_GAIN_DB = 18.0
    PREVIEW_SECONDS = 60.0

    def __init__(self, log: Callable[[str], None] = print, preview_seconds: Optional[float] = PREVIEW_SECONDS):
        self.log = log
        self.preview_seconds = preview_seconds
        self.last_plan: List[Dict[str, object]] = []

    def process_mix(self, stems: Sequence[Path], output_path: Path) -> Path:
        stems = [Path(s) for s in stems]
        if not stems:
            raise MixerError("No stems supplied.")
        counters: Dict[str, int] = {}
        rate: Optional[int] = None
        rendered: List[Tuple[List[float], List[float]]] = []
        self.last_plan = []

        for stem in stems:
            r, chans = _read_wav(stem, self.preview_seconds)
            if rate is None:
                rate = r
            elif r != rate:
                raise MixerError(f"{stem.name}: sample rate {r} Hz differs from {rate} Hz. Export all stems at one rate.")
            cat = categorize(stem.name)
            flat = [s for c in chans for s in c]
            rms = math.sqrt(sum(s * s for s in flat) / max(len(flat), 1))
            if rms < 1e-6:
                self.log(f"   ⚠️  {stem.name}: silent, skipped")
                continue
            gain_db = max(-self.MAX_GAIN_DB, min(self.MAX_GAIN_DB, self.TARGET_RMS[cat] - _db(rms)))
            cycle = self.PAN_CYCLE[cat]
            idx = counters.get(cat, 0)
            counters[cat] = idx + 1
            pan = cycle[idx % len(cycle)]
            g = 10 ** (gain_db / 20.0)
            # constant power pan law
            ang = (pan + 1.0) * math.pi / 4.0
            gl, gr = math.cos(ang), math.sin(ang)
            if len(chans) == 1:
                left = [s * g * gl * math.sqrt(2) for s in chans[0]]
                right = [s * g * gr * math.sqrt(2) for s in chans[0]]
            else:
                left = [s * g for s in chans[0]]
                right = [s * g for s in chans[1]]
            rendered.append((left, right))
            self.last_plan.append({"stem": stem.name, "category": cat, "gain_db": round(gain_db, 1), "pan": pan})
            self.log(f"   🎚️  {stem.name:<32} {cat:<12} gain {gain_db:+5.1f} dB  pan {pan:+.2f}")

        if not rendered or rate is None:
            raise MixerError("All stems were silent; nothing to mix.")

        length = max(len(l) for l, _ in rendered)
        mix_l, mix_r = [0.0] * length, [0.0] * length
        for chan_l, chan_r in rendered:
            for i, v in enumerate(chan_l):
                mix_l[i] += v
            for i, v in enumerate(chan_r):
                mix_r[i] += v

        peak = max(max(map(abs, mix_l)), max(map(abs, mix_r)), 1e-9)
        norm = 10 ** (-1.0 / 20.0) / peak  # peak normalise to -1 dBFS
        out = array.array("h", [0] * (length * 2))
        out[0::2] = array.array("h", (max(-32768, min(32767, int(s * norm * 32767))) for s in mix_l))
        out[1::2] = array.array("h", (max(-32768, min(32767, int(s * norm * 32767))) for s in mix_r))

        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(output_path), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(out.tobytes())
        return output_path


# ---------------------------------------------------------------------------
# RoEx Tonn cloud engine
# ---------------------------------------------------------------------------

class RoExMixer(BaseMixer):
    """Cloud AI engine on the RoEx Tonn API: upload, mix, master, download.

    The Tonn API has no literal target_loudness / stereo_enhancement / creative_effects
    fields, so they are mapped onto what it does expose:
      target_loudness=-14.0   -> streaming level master (DesiredLoudness.MEDIUM)
      stereo_enhancement=True -> pan_preference NO_PREFERENCE so the AI sets stereo width
                                 (False pins every track to CENTRE)
      creative_effects="dynamic" -> per group reverb sends (vocals/snare/instruments),
                                 "off" disables them
    """

    name = "RoExMixer"
    POLL_SECONDS = 5
    MAX_POLLS = 120  # 10 minutes per stage

    def __init__(
        self,
        api_key: Optional[str],
        target_loudness: float = -14.0,
        stereo_enhancement: bool = True,
        creative_effects: str = "dynamic",
        musical_style: str = "POP",
        log: Callable[[str], None] = print,
    ):
        key = (api_key or "").strip().strip('"').strip("'")
        if not key or key == PENDING_KEY:
            raise MixerError(
                "RoExMixer needs a real RoEx API key. ROEX_API_KEY is still "
                f'"{PENDING_KEY}" or empty. Get your key from https://tonn-portal.roexaudio.com, '
                "paste it into the .env file as ROEX_API_KEY=\"your-key\", then run again. "
                "Until then use LocalMixer for offline dry runs."
            )
        self.api_key = key
        self.target_loudness = target_loudness
        self.stereo_enhancement = stereo_enhancement
        self.creative_effects = creative_effects
        self.musical_style = musical_style
        self.log = log
        self._client = None

    @property
    def client(self):
        if self._client is None:
            from roex_python.client import RoExClient
            self._client = RoExClient(api_key=self.api_key)
        return self._client

    def _loudness_bucket(self):
        from roex_python.models.common import DesiredLoudness
        if self.target_loudness <= -16.0:
            return DesiredLoudness.LOW
        if self.target_loudness <= -11.0:
            return DesiredLoudness.MEDIUM  # -14 LUFS streaming territory
        return DesiredLoudness.HIGH

    def _track_settings(self, filename: str, index: int, lead_taken: bool):
        from roex_python.models.common import (
            InstrumentGroup as G, PanPreference, PresenceSetting, ReverbPreference as R,
        )
        low = Path(filename).stem.lower()
        cat = categorize(filename)
        if cat == "vocals":
            group = G.BACKING_VOX_GROUP if any(k in low for k in ("bgv", "harm", "backing", "choir")) else G.VOCAL_GROUP
        elif cat == "bass":
            group = G.BASS_GROUP
        elif cat == "drums":
            group = (
                G.KICK_GROUP if "kick" in low else G.SNARE_GROUP if "snare" in low
                else G.CYMBALS_GROUP if any(k in low for k in ("hat", "cymbal", "overhead")) else G.DRUMS_GROUP
            )
        elif any(k in low for k in ("gtr", "guitar")):
            group = G.ACOUSTIC_GUITAR_GROUP if "ac" in low else G.E_GUITAR_GROUP
        elif any(k in low for k in ("key", "piano", "organ", "rhodes")):
            group = G.KEYS_GROUP
        elif any(k in low for k in ("synth", "pad", "lead synth")):
            group = G.SYNTH_GROUP
        elif any(k in low for k in ("string", "violin", "cello")):
            group = G.STRINGS_GROUP
        else:
            group = G.BACKING_TRACK_GROUP

        presence = PresenceSetting.LEAD if group == G.VOCAL_GROUP and not lead_taken else (
            PresenceSetting.BACKGROUND if group == G.BACKING_VOX_GROUP else PresenceSetting.NORMAL)

        if self.creative_effects == "dynamic":
            reverb = {
                G.VOCAL_GROUP: R.MEDIUM, G.BACKING_VOX_GROUP: R.HIGH, G.SNARE_GROUP: R.LOW,
                G.KEYS_GROUP: R.LOW, G.SYNTH_GROUP: R.LOW, G.STRINGS_GROUP: R.MEDIUM,
                G.E_GUITAR_GROUP: R.LOW, G.ACOUSTIC_GUITAR_GROUP: R.LOW,
            }.get(group, R.NONE)
        else:
            reverb = R.NONE
        pan = PanPreference.NO_PREFERENCE if self.stereo_enhancement else PanPreference.CENTRE
        if group in (G.VOCAL_GROUP, G.BASS_GROUP, G.KICK_GROUP, G.SNARE_GROUP):
            pan = PanPreference.CENTRE  # anchors stay centred either way
        return group, presence, pan, reverb

    def process_mix(self, stems: Sequence[Path], output_path: Path) -> Path:
        from roex_python.models import (
            FinalMixRequest, MasteringRequest, MultitrackMixRequest, MusicalStyle, TrackData, TrackGainData,
        )
        from roex_python.utils import upload_file

        stems = [Path(s) for s in stems]
        if not 2 <= len(stems) <= 32:
            raise MixerError(f"RoEx Tonn needs between 2 and 32 stems, found {len(stems)}.")
        style = MusicalStyle[self.musical_style.upper()]
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        self.log("📦 Uploading stems to RoEx...")
        tracks: List[TrackData] = []
        lead_taken = False
        for i, stem in enumerate(stems):
            url = upload_file(self.client, str(stem))
            group, presence, pan, reverb = self._track_settings(stem.name, i, lead_taken)
            lead_taken = lead_taken or presence.name == "LEAD"
            tracks.append(TrackData(url, group, presence, pan, reverb))
            self.log(f"   ⬆️  {stem.name:<32} {group.value}")

        self.log("🤖 Starting cloud mix preview...")
        task = self.client.mix.create_mix_preview(MultitrackMixRequest(track_data=tracks, musical_style=style))
        task_id = task.multitrack_task_id
        self.log(f"🎛️  Mix task {task_id}, polling every {self.POLL_SECONDS}s...")
        self.client.mix.retrieve_preview_mix(task_id, max_attempts=self.MAX_POLLS, poll_interval=self.POLL_SECONDS)

        self.log("🎛️  Rendering final mix...")
        final = self.client.mix.retrieve_final_mix(FinalMixRequest(
            multitrack_task_id=task_id,
            track_data=[TrackGainData(track_url=t.track_url, gain_db=0.0) for t in tracks],
        ))
        if not final.download_url_mixed:
            raise MixerError("RoEx returned no final mix URL.")

        self.log(f"🔊 Mastering to about {self.target_loudness:g} LUFS...")
        m_task = self.client.mastering.create_mastering_preview(MasteringRequest(
            track_url=final.download_url_mixed, musical_style=style, desired_loudness=self._loudness_bucket(),
        ))
        self.client.mastering.retrieve_preview_master(
            m_task.mastering_task_id, max_attempts=self.MAX_POLLS, poll_interval=self.POLL_SECONDS)
        master = self.client.mastering.retrieve_final_master(m_task.mastering_task_id)
        if not master.download_url_mastered:
            raise MixerError("RoEx returned no mastered file URL.")

        self.log("📥 Downloading finished master...")
        if not self.client.api_provider.download_file(master.download_url_mastered, str(output_path)):
            raise MixerError(f"Download failed for {master.download_url_mastered[:60]}...")
        return output_path
