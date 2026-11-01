"""MPEG audio duration probing."""

from __future__ import annotations

from octop.infra.voice.mp3 import mp3_duration


def _mpeg1_layer3_frame(bitrate_kbps: int, sample_rate: int, padding: int = 0) -> bytes:
    """Build one MPEG-1 Layer III frame header plus a zeroed payload."""
    bitrates = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
    rates = (44100, 48000, 32000)
    bitrate_index = bitrates.index(bitrate_kbps)
    rate_index = rates.index(sample_rate)
    header = (
        0xFFE00000
        | (3 << 19)  # MPEG 1
        | (1 << 17)  # Layer III
        | (bitrate_index << 12)
        | (rate_index << 10)
        | (padding << 9)
    )
    length = (144 * bitrate_kbps * 1000) // sample_rate + padding
    return header.to_bytes(4, "big") + b"\x00" * (length - 4)


def test_empty_input_has_no_duration() -> None:
    assert mp3_duration(b"") == 0.0
    assert mp3_duration(b"not audio at all") == 0.0


def test_single_frame_duration() -> None:
    # One MPEG-1 Layer III frame carries 1152 samples.
    frame = _mpeg1_layer3_frame(128, 32000)
    assert mp3_duration(frame) == 1152 / 32000


def test_many_frames_add_up() -> None:
    frames = _mpeg1_layer3_frame(128, 44100) * 10
    assert mp3_duration(frames) == 10 * 1152 / 44100


def test_id3_tag_is_skipped() -> None:
    frame = _mpeg1_layer3_frame(128, 32000)
    # A minimal ID3v2.4 tag: 10-byte header plus a 64-byte body.
    tag = b"ID3\x04\x00\x00" + bytes([0, 0, 0, 64]) + b"\x00" * 64
    assert mp3_duration(tag + frame) == 1152 / 32000


def test_garbage_before_the_frames_is_resynchronised() -> None:
    frame = _mpeg1_layer3_frame(128, 32000)
    assert mp3_duration(b"\x00" * 137 + frame) == 1152 / 32000


def test_mpeg2_uses_576_samples_per_frame() -> None:
    # MPEG 2 uses half the sample count and half the frame length.
    header = (
        0xFFE00000
        | (2 << 19)  # MPEG 2
        | (1 << 17)  # Layer III
        | (9 << 12)  # 80 kbit/s
        | (0 << 10)  # 22050 Hz
    )
    length = (72 * 80000) // 22050
    frame = header.to_bytes(4, "big") + b"\x00" * (length - 4)
    assert mp3_duration(frame) == 576 / 22050
