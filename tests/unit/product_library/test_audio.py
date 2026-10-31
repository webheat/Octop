"""Audio planning for product-library packages."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.product_library.audio import (
    align_scene_durations,
    build_package_audio,
    estimate_speech_seconds,
    load_catalog,
    pick_track,
    resolve_narration,
    scene_narration_text,
    track_path,
)


def _write_library(root: Path, tracks: list[dict], default: str = "634") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for track in tracks:
        (root / track["file"]).write_bytes(b"ID3" + b"\x00" * 64)
    (root / "catalog.json").write_text(
        json.dumps({"version": 1, "default": default, "tracks": tracks}),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def library(tmp_path: Path) -> Path:
    return _write_library(
        tmp_path / "bgm-library",
        [
            {
                "id": "634",
                "name": "Your Breath",
                "file": "tech_clean__634__your-breath.mp3",
                "bpm": 120.0,
                "bar": 2.0,
                "onset": 0.5,
                "cat": "tech_clean",
            },
            {
                "id": "33",
                "name": "Motivating Mornings",
                "file": "energetic__33__motivating-mornings.mp3",
                "bpm": 128.0,
                "bar": 1.875,
                "onset": 0.2,
                "cat": "energetic",
            },
        ],
    )


SCRIPT = {
    "title": "Camera",
    "fps": 30,
    "width": 1080,
    "height": 1920,
    "scenes": [
        {"id": "product-title", "type": "title", "duration": 3, "text": "Camera"},
        {
            "id": "selling-points",
            "type": "bullets",
            "duration": 4,
            "bullets": ["Light", "Waterproof"],
        },
        {"id": "endcard", "type": "endcard", "duration": 2, "text": "Camera"},
    ],
}


def test_narration_mode_follows_the_account_tier() -> None:
    assert resolve_narration(enabled=False, premium=False) == "off"
    assert resolve_narration(enabled=True, premium=False) == "local"
    assert resolve_narration(enabled=True, premium=True) == "bundled"


def test_scene_narration_text_joins_bullets() -> None:
    assert scene_narration_text(SCRIPT["scenes"][1]) == "Light，Waterproof"
    assert scene_narration_text(SCRIPT["scenes"][0]) == "Camera"
    assert scene_narration_text({"id": "x", "type": "image"}) == ""


def test_estimate_speech_seconds_scales_with_length() -> None:
    assert estimate_speech_seconds("") == 0.0
    short = estimate_speech_seconds("短")
    long = estimate_speech_seconds("短" * 20)
    assert 0 < short < long


def test_align_scene_durations_snaps_to_whole_bars() -> None:
    aligned = align_scene_durations([3, 4, 5], [0, 0, 0], 2.0)
    assert aligned == [4.0, 4.0, 6.0]
    for value in aligned:
        assert abs(value / 2.0 - round(value / 2.0)) < 1e-6


def test_align_scene_durations_grows_for_long_narration() -> None:
    aligned = align_scene_durations([2], [9.0], 2.0)
    assert aligned[0] >= 9.35
    assert abs(aligned[0] / 2.0 - round(aligned[0] / 2.0)) < 1e-6


def test_align_scene_durations_without_a_bar_keeps_authored_lengths() -> None:
    assert align_scene_durations([3, 4], [10, 10], 0.0) == [3.0, 4.0]


def test_catalog_skips_entries_with_unsafe_names(library: Path) -> None:
    catalog = library / "catalog.json"
    payload = json.loads(catalog.read_text(encoding="utf-8"))
    payload["tracks"].append(
        {"id": "evil", "name": "x", "file": "../escape.mp3", "bpm": 120, "bar": 2}
    )
    catalog.write_text(json.dumps(payload), encoding="utf-8")
    tracks = load_catalog(library)
    assert "evil" not in {track.id for track in tracks}


def test_pick_track_prefers_the_catalog_default(library: Path) -> None:
    track = pick_track(library)
    assert track is not None
    assert track.id == "634"
    assert track.bar_seconds == 2.0


def test_pick_track_rejects_an_unknown_id(library: Path) -> None:
    with pytest.raises(OctopError) as excinfo:
        pick_track(library, "does-not-exist")
    assert excinfo.value.code == ErrorCode.NOT_FOUND


def test_track_path_rejects_files_outside_the_library(library: Path) -> None:
    track = pick_track(library)
    assert track is not None
    assert track_path(library, track) is not None
    outside = library.parent / "outside.mp3"
    outside.write_bytes(b"x")
    rogue = type(track)(**{**track.__dict__, "file": "../outside.mp3"})
    assert track_path(library, rogue) is None


def test_package_without_narration_still_gets_bgm(library: Path) -> None:
    package = build_package_audio(library, SCRIPT)
    assert package is not None
    assert package.plan["bgm"]["src"] == "tech_clean__634__your-breath.mp3"
    assert package.plan["bgm"]["bpm"] == 120.0
    assert "narration" not in package.plan
    assert [name for name, _ in package.files] == ["tech_clean__634__your-breath.mp3"]


def test_free_tier_declares_local_clips_without_audio(library: Path) -> None:
    package = build_package_audio(library, SCRIPT, narration_enabled=True)
    assert package is not None
    assert package.plan["narration"]["mode"] == "local"
    assert package.plan["narration"]["engine"] == "sapi"
    title = package.plan["scenes"]["product-title"]
    assert title["audio"]["src"] == "voice-product-title.wav"
    # The clip itself is produced on the client, so it is not shipped.
    assert all(not name.endswith(".wav") for name, _ in package.files)


def test_paid_tier_ships_the_rendered_clips(library: Path, tmp_path: Path) -> None:
    clip = tmp_path / "title.mp3"
    clip.write_bytes(b"ID3audio")
    package = build_package_audio(
        library,
        SCRIPT,
        narration_enabled=True,
        premium=True,
        voice_clips={"product-title": clip},
        voice_durations={"product-title": 3.2},
    )
    assert package is not None
    assert package.plan["narration"]["mode"] == "bundled"
    assert package.plan["narration"]["engine"] == "minimax"
    title = package.plan["scenes"]["product-title"]
    assert title["audio"]["src"] == "voice-product-title.mp3"
    assert any(name.endswith("voice-product-title.mp3") for name, _ in package.files)


def test_measured_durations_size_the_scene(library: Path) -> None:
    package = build_package_audio(
        library,
        SCRIPT,
        narration_enabled=True,
        premium=True,
        voice_durations={"product-title": 9.0},
    )
    assert package is not None
    title = package.plan["scenes"]["product-title"]
    assert title["duration"] >= 9.35
    assert abs(title["duration"] / 2.0 - round(title["duration"] / 2.0)) < 1e-6


def test_missing_library_yields_no_audio_plan(tmp_path: Path) -> None:
    assert build_package_audio(tmp_path / "absent", SCRIPT) is None


def test_empty_script_yields_no_audio_plan(library: Path) -> None:
    assert build_package_audio(library, {"scenes": []}) is None


def test_music_can_be_turned_off_entirely(library: Path) -> None:
    """Turning BGM off must not fall back to the catalogue default."""
    assert build_package_audio(library, SCRIPT, bgm_enabled=False) is None

    with_voice = build_package_audio(library, SCRIPT, narration_enabled=True, bgm_enabled=False)
    assert with_voice is not None
    assert "bgm" not in with_voice.plan
    assert [name for name, _ in with_voice.files] == []
    # No music grid means no beat snapping: authored durations stay untouched.
    assert "duration" not in with_voice.plan["scenes"]["product-title"]


def test_explicit_track_wins_over_the_catalogue_default(library: Path) -> None:
    package = build_package_audio(library, SCRIPT, bgm_id="33")
    assert package is not None
    assert package.plan["bgm"]["src"] == "energetic__33__motivating-mornings.mp3"
    assert [name for name, _ in package.files] == ["energetic__33__motivating-mornings.mp3"]


def test_music_can_be_turned_off_entirely(library: Path) -> None:
    """Turning BGM off must not fall back to the catalogue default."""
    assert build_package_audio(library, SCRIPT, bgm_enabled=False) is None

    with_voice = build_package_audio(library, SCRIPT, narration_enabled=True, bgm_enabled=False)
    assert with_voice is not None
    assert "bgm" not in with_voice.plan
    assert [name for name, _ in with_voice.files] == []
    # No music grid means no beat snapping: authored durations stay untouched.
    assert "duration" not in with_voice.plan["scenes"]["product-title"]


def test_explicit_track_wins_over_the_catalogue_default(library: Path) -> None:
    package = build_package_audio(library, SCRIPT, bgm_id="33")
    assert package is not None
    assert package.plan["bgm"]["src"] == "energetic__33__motivating-mornings.mp3"
    assert [name for name, _ in package.files] == ["energetic__33__motivating-mornings.mp3"]
