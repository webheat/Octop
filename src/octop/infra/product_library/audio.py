"""Audio planning for local video packages.

Two independent audio tracks feed a rendered video:

* **BGM** — a royalty-free track picked from ``PathLayout.bgm_library_dir``.
  The files never live in git and are never shipped on their own; a single track
  is copied into the package ``assets/`` directory so the licence permits its use
  inside the finished video only.
* **Narration** — one clip per scene. Paid tiers get the clips pre-rendered by
  the server (``mode="bundled"``); the free tier synthesises them on the Windows
  desktop client with SAPI (``mode="local"``); ``mode="off"`` disables voice.

Scene timing is driven by the music: every scene is snapped to a whole number of
bars so cuts land on the beat. Narration only grows a scene, never shrinks it.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from octop.infra.errors import ErrorCode, OctopError

CATALOG_FILE = "catalog.json"

#: Chinese TTS runs at roughly four characters per second including punctuation
#: pauses; the constant pad absorbs the non-determinism of neural voices.
#: Measured rates differ sharply between engines — the local Windows voice
#: manages ~2.8 chars/s while MiniMax reaches ~8 — so this figure is only a
#: fallback for clients that cannot report their own clip length.
CHARS_PER_SECOND = 4.0
SPEECH_PAD_SECONDS = 0.6
#: BGM sits well under the voice track; without narration it can be louder.
BGM_VOLUME_WITH_VOICE = 0.22
BGM_VOLUME_SOLO = 0.34
BGM_FADE_IN_SECONDS = 0.8
BGM_FADE_OUT_SECONDS = 1.2
#: Extra attenuation while a scene is speaking (poor-man's sidechain ducking).
BGM_DUCK_FACTOR = 0.55

NARRATION_MODES = ("off", "local", "bundled")


@dataclass(frozen=True)
class BgmTrack:
    """One catalogued background track."""

    id: str
    name: str
    file: str
    bpm: float
    bar: float
    onset: float
    category: str
    author: str = ""

    @property
    def bar_seconds(self) -> float:
        if self.bar > 0:
            return self.bar
        if self.bpm > 0:
            return 240.0 / self.bpm
        return 2.0


def _coerce_track(raw: dict[str, Any]) -> BgmTrack | None:
    try:
        track = BgmTrack(
            id=str(raw["id"]),
            name=str(raw.get("name") or raw["id"]),
            file=str(raw["file"]),
            bpm=float(raw.get("bpm") or 0),
            bar=float(raw.get("bar") or 0),
            onset=max(0.0, float(raw.get("onset") or 0)),
            category=str(raw.get("cat") or ""),
            author=str(raw.get("author") or ""),
        )
    except (KeyError, TypeError, ValueError):
        return None
    # Reject path traversal early: only plain file names are allowed.
    if "/" in track.file or "\\" in track.file or track.file.startswith("."):
        return None
    return track


def load_catalog(root: Path) -> list[BgmTrack]:
    """Read ``catalog.json`` from the BGM library, skipping unusable entries."""
    path = root / CATALOG_FILE
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    tracks: list[BgmTrack] = []
    seen: set[str] = set()
    for raw in payload.get("tracks") or []:
        if not isinstance(raw, dict):
            continue
        track = _coerce_track(raw)
        if track is None or track.id in seen:
            continue
        seen.add(track.id)
        tracks.append(track)
    return tracks


def _default_track_id(root: Path) -> str | None:
    path = root / CATALOG_FILE
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = payload.get("default")
    return str(value) if value else None


def pick_track(root: Path, track_id: str | None = None) -> BgmTrack | None:
    """Resolve a catalogue entry, falling back to the catalogue default."""
    tracks = load_catalog(root)
    if not tracks:
        return None
    if track_id:
        for track in tracks:
            if track.id == track_id or track.file == track_id:
                return track
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    default_id = _default_track_id(root)
    if default_id:
        for track in tracks:
            if track.id == default_id:
                return track
    # Prefer a track whose bar length divides two seconds evenly: those align
    # with the 4-second scene rhythm most shorts use.
    return sorted(tracks, key=lambda t: (abs(t.bpm - 120), t.id))[0]


def track_path(root: Path, track: BgmTrack) -> Path | None:
    candidate = (root / track.file).resolve()
    if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
        return None
    return candidate


def estimate_speech_seconds(text: str) -> float:
    """Rough duration of a narration line in seconds."""
    compact = "".join(ch for ch in (text or "") if not ch.isspace())
    if not compact:
        return 0.0
    return len(compact) / CHARS_PER_SECOND + SPEECH_PAD_SECONDS


def align_scene_durations(
    durations: Iterable[float],
    speech_seconds: Iterable[float],
    bar: float,
) -> list[float]:
    """Snap every scene to a whole number of bars, never cutting narration.

    ``bar`` is one bar in seconds (four beats of 4/4). Each scene keeps at least
    its authored duration and grows by whole bars until the narration fits.
    """
    base_list = [float(d or 0) for d in durations]
    speech_list = [float(s or 0) for s in speech_seconds]
    if bar <= 0:
        return [max(0.25, d) for d in base_list]
    aligned: list[float] = []
    for index, base in enumerate(base_list):
        speech = speech_list[index] if index < len(speech_list) else 0.0
        required = max(base, speech + 0.35)
        bars = max(1, math.ceil(required / bar - 1e-9))
        aligned.append(round(bars * bar, 3))
    return aligned


def scene_narration_text(scene: dict[str, Any]) -> str:
    """The line a narrator should read for one scene."""
    kind = str(scene.get("type") or "")
    if kind == "bullets":
        bullets = [str(b).strip() for b in (scene.get("bullets") or []) if str(b).strip()]
        return "，".join(bullets)
    parts: list[str] = []
    for key in ("text", "subtitle", "caption"):
        value = str(scene.get(key) or "").strip()
        if value:
            parts.append(value)
    return "。".join(parts)


def resolve_narration(*, enabled: bool, premium: bool) -> str:
    """Decide which narration mode the request is entitled to."""
    if not enabled:
        return "off"
    return "bundled" if premium else "local"


def build_audio_block(
    track: BgmTrack | None,
    *,
    mode: str,
    has_voice: bool,
    narration_source: str | None = None,
    voice_id: str | None = None,
    engine: str | None = None,
    degraded: bool = False,
) -> dict[str, Any] | None:
    """Compose the top-level ``audio`` object written into ``script.json``."""
    if track is None and mode == "off":
        return None
    block: dict[str, Any] = {}
    if track is not None:
        block["bgm"] = {
            "src": track.file,
            "volume": BGM_VOLUME_WITH_VOICE if has_voice else BGM_VOLUME_SOLO,
            "fadeIn": BGM_FADE_IN_SECONDS,
            "fadeOut": BGM_FADE_OUT_SECONDS,
            "duck": BGM_DUCK_FACTOR,
            "offset": round(track.onset, 3),
            "bar": round(track.bar_seconds, 3),
            "bpm": round(track.bpm, 1),
            "title": track.name,
            # Tracks are minutes long, but a script may legally reach 180s.
            "loop": True,
        }
    if mode in ("local", "bundled"):
        block["narration"] = {
            "mode": mode,
            # Without a track there is no BGM to duck; the renderer keys ducking
            # off scene-level audio instead, so nothing extra is needed here.
            "voiceId": voice_id or "",
            "engine": engine or ("minimax" if mode == "bundled" else "sapi"),
        }
        if narration_source:
            block["narration"]["source"] = narration_source
        if degraded:
            # The server wanted to render the voice but could not (no quota, an
            # unreachable provider). The client is doing the work instead.
            block["narration"]["degraded"] = True
    return block or None


#: File name the desktop client uses for a locally synthesised narration clip.
LOCAL_VOICE_PREFIX = "voice-"
LOCAL_VOICE_SUFFIX = ".wav"


def local_voice_name(scene_id: str) -> str:
    """Deterministic asset name for a client-side narration clip."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", scene_id).strip("._") or "scene"
    return f"{LOCAL_VOICE_PREFIX}{safe}{LOCAL_VOICE_SUFFIX}"


@dataclass(frozen=True)
class AudioPackage:
    """The audio plan plus the files that must travel with the package.

    ``plan`` is written to ``audio.json`` next to ``script.json``; ``files``
    maps an asset file name to the path it should be copied from.
    """

    plan: dict[str, Any]
    files: list[tuple[str, Path]]


def build_package_audio(
    library_root: Path,
    script: dict[str, Any],
    *,
    narration_enabled: bool = False,
    premium: bool = False,
    voice_id: str | None = None,
    bgm_id: str | None = None,
    bgm_enabled: bool = True,
    voice_clips: dict[str, Path] | None = None,
    voice_durations: dict[str, float] | None = None,
    degraded: bool = False,
) -> AudioPackage | None:
    """Assemble the audio plan for one package.

    ``voice_clips`` maps a scene id to an already rendered narration file
    (server-side MiniMax output for paid tiers); ``voice_durations`` holds the
    measured length of those clips so the scene can be sized to the speech
    instead of to a guess. When no clip is available but narration is on, the
    plan declares the clip names the desktop client is expected to synthesise
    locally.

    ``bgm_enabled`` is separate from ``bgm_id`` because "pick the default
    track" and "no music at all" must be distinguishable: a ``None`` id means
    the catalogue default, while ``bgm_enabled=False`` drops music entirely and
    with it the beat grid that scene durations are snapped to.
    """
    scenes = script.get("scenes") or []
    if not isinstance(scenes, list) or not scenes:
        return None

    mode = resolve_narration(enabled=narration_enabled, premium=premium)
    track = pick_track(library_root, bgm_id) if bgm_enabled and library_root.is_dir() else None
    if track is not None and track_path(library_root, track) is None:
        track = None

    files: list[tuple[str, Path]] = []
    plan: dict[str, Any] = {"scenes": {}}

    if track is not None:
        source = track_path(library_root, track)
        assert source is not None
        files.append((track.file, source))

    lines: list[str] = []
    speech: list[float] = []
    for scene in scenes:
        if not isinstance(scene, dict):
            lines.append("")
            speech.append(0.0)
            continue
        line = scene_narration_text(scene) if mode != "off" else ""
        lines.append(line)
        speech.append(estimate_speech_seconds(line) if line else 0.0)

    # A measured clip length always wins over the estimate.
    measured = voice_durations or {}
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            continue
        scene_id = str(scene.get("id") or "")
        if scene_id and scene_id in measured and measured[scene_id] > 0:
            speech[index] = measured[scene_id]

    durations = [
        float(scene.get("duration") or 0) if isinstance(scene, dict) else 0.0 for scene in scenes
    ]
    bar = track.bar_seconds if track is not None else 0.0
    aligned = align_scene_durations(durations, speech, bar) if bar > 0 else durations

    has_voice = mode != "off" and any(lines)
    for index, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            continue
        scene_id = str(scene.get("id") or "")
        if not scene_id:
            continue
        entry: dict[str, Any] = {}
        if bar > 0 and abs(aligned[index] - durations[index]) > 1e-6:
            entry["duration"] = aligned[index]
        if mode != "off" and lines[index]:
            entry["narration"] = lines[index]
            if voice_clips and scene_id in voice_clips:
                name = f"{LOCAL_VOICE_PREFIX}{re.sub(r'[^A-Za-z0-9._-]+', '_', scene_id).strip('._') or 'scene'}.mp3"
                files.append((name, voice_clips[scene_id]))
                entry["audio"] = {"src": name, "volume": 1.0}
            elif mode == "local":
                entry["audio"] = {"src": local_voice_name(scene_id), "volume": 1.0}
        if entry:
            plan["scenes"][scene_id] = entry

    block = build_audio_block(
        track,
        mode=mode,
        has_voice=has_voice,
        voice_id=voice_id,
        engine="minimax" if mode == "bundled" else "sapi",
        degraded=degraded,
    )
    if block:
        plan.update(block)
    plan["scenes"] = plan.get("scenes") or {}

    if not files and mode == "off" and not plan.get("scenes"):
        return None
    return AudioPackage(plan=plan, files=files)
