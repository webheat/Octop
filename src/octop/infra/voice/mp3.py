"""MPEG audio (mp3) duration probing.

The MiniMax native endpoint reports the rendered length in the response
(``extra_info.audio_length``). OpenAI-compatible gateways do not: they stream
the encoded audio and nothing else. The scene length still has to match the
narration exactly, so the length is recovered from the file itself.

Only what a decoder needs is implemented — the frame header of MPEG-1/2/2.5
Layer III — so no external dependency (ffprobe, mutagen) is required.
"""

from __future__ import annotations

# Bitrate tables in kbit/s for Layer III, indexed by the 4-bit rate field.
_BITRATES_MPEG1 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_BITRATES_MPEG2 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
# Sample rates in Hz, indexed by the 2-bit rate field.
_SAMPLE_RATES = {
    3: (44100, 48000, 32000),  # MPEG 1
    2: (22050, 24000, 16000),  # MPEG 2
    0: (11025, 12000, 8000),  # MPEG 2.5
}
_SAMPLES_PER_FRAME = {3: 1152, 2: 576, 0: 576}


def _id3_offset(data: bytes) -> int:
    """Length of the leading ID3v2 tag, if any."""
    if len(data) < 10 or data[:3] != b"ID3":
        return 0
    size = (
        ((data[6] & 0x7F) << 21)
        | ((data[7] & 0x7F) << 14)
        | ((data[8] & 0x7F) << 7)
        | (data[9] & 0x7F)
    )
    return min(len(data), 10 + size)


def mp3_duration(data: bytes) -> float:
    """Length of an MPEG Layer III stream in seconds; ``0.0`` when unknown.

    The frames are walked rather than assuming a constant bit rate, so
    variable-bit-rate files report the real length.
    """
    offset = _id3_offset(data)
    total = 0.0
    frames = 0
    size = len(data)
    while offset + 4 <= size:
        header = int.from_bytes(data[offset : offset + 4], "big")
        if (header & 0xFFE00000) != 0xFFE00000:
            # Not a frame sync; resynchronise on the next candidate.
            offset += 1
            continue
        version_bits = (header >> 19) & 0x03
        layer_bits = (header >> 17) & 0x03
        if version_bits == 1 or layer_bits != 1:  # reserved version / not layer III
            offset += 1
            continue
        bitrate_index = (header >> 12) & 0x0F
        rate_index = (header >> 10) & 0x03
        padding = (header >> 9) & 0x01
        if bitrate_index in (0, 15) or rate_index == 3:
            offset += 1
            continue
        table = _BITRATES_MPEG1 if version_bits == 3 else _BITRATES_MPEG2
        bitrate = table[bitrate_index] * 1000
        sample_rate = _SAMPLE_RATES[version_bits][rate_index]
        if bitrate == 0 or sample_rate == 0:
            offset += 1
            continue
        if version_bits == 3:
            frame_length = (144 * bitrate) // sample_rate + padding
            samples = _SAMPLES_PER_FRAME[3]
        else:
            frame_length = (72 * bitrate) // sample_rate + padding
            samples = _SAMPLES_PER_FRAME[version_bits]
        if frame_length < 4:
            offset += 1
            continue
        total += samples / sample_rate
        frames += 1
        offset += frame_length
    return total if frames else 0.0
