"""Local, model-free image inspection for the product base library.

Pure PIL + numpy pixel work: decode/verify, EXIF orientation, perceptual
hashes, sharpness/exposure/flatness checks and dominant colours. No network,
no model, no side effects — the caller decides where a verdict is stored.

Scope boundary: this module deliberately stops before semantic recognition.
It can tell a broken, blurry or near-identical image from a clean one, but it
cannot name the product or write a description — that stays with the remote
vision model (see docs/product-library-import-architecture.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any

import numpy as np
from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 8 * 1024 * 1024
MIN_SIDE = 320
BLUR_MIN = 60.0
FLAT_STD_MIN = 8.0
DARK_MEAN = 10.0
BRIGHT_MEAN = 245.0
EXTREME_RATIO = 0.6
# Both hashes must agree. A pHash alone is dominated by a common studio
# background and would flag two different products shot on the same set.
PHASH_DUP_BITS = 6
DHASH_DUP_BITS = 8

_REASONS = (
    "too_small",
    "blurry",
    "flat",
    "underexposed",
    "overexposed",
)


@dataclass(frozen=True)
class ImageQuality:
    """Deterministic measurements for one image."""

    corrupt: bool = False
    corrupt_reason: str = ""
    width: int = 0
    height: int = 0
    phash: str = ""
    dhash: str = ""
    blur_score: float = 0.0
    brightness: float = 0.0
    flatness: float = 0.0
    quality_score: float = 0.0
    dominant_colors: tuple[str, ...] = ()
    defects: tuple[str, ...] = ()

    @property
    def usable(self) -> bool:
        return not self.corrupt and not self.defects

    def verdict(self) -> str:
        if self.corrupt:
            return "corrupt"
        if self.defects:
            return "low_quality"
        return "ready"


def _bits_to_hex(bits: Any) -> str:
    value = 0
    for bit in bits:
        value = (value << 1) | int(bool(bit))
    return f"{value:016x}"


def _phash(gray64: Any) -> str:
    """64-bit pHash from the low frequencies of a DCT."""
    matrix = np.cos(np.pi * (np.arange(64)[:, None] + 0.5) * np.arange(64)[None, :] / 64)
    dct = matrix @ gray64 @ matrix.T
    low = dct[:8, :8]
    threshold = float(np.median(low[1:]))
    return _bits_to_hex((low > threshold).flatten())


def _dhash(rgb: Image.Image) -> str:
    gray = np.asarray(rgb.resize((9, 8), Image.Resampling.LANCZOS).convert("L"), dtype=np.int16)
    return _bits_to_hex((gray[:, 1:] > gray[:, :-1]).flatten())


def _dominant_colors(rgb: Image.Image) -> tuple[str, ...]:
    pixels = np.asarray(rgb.resize((64, 64), Image.Resampling.LANCZOS), dtype=np.uint8)
    quantised = pixels // 32
    flat = quantised.reshape(-1, 3)
    keys, counts = np.unique(flat, axis=0, return_counts=True)
    top = np.argsort(counts)[-3:][::-1]
    colors = []
    for index in top:
        red, green, blue = (int(channel) * 32 + 16 for channel in keys[index])
        colors.append(f"#{red:02x}{green:02x}{blue:02x}")
    return tuple(colors)


def _laplacian_variance(gray: Any) -> float:
    center = gray[1:-1, 1:-1]
    lap = -4 * center + gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:]
    return float(lap.var())


def inspect_image(data: bytes) -> ImageQuality:
    """Inspect image bytes. Any decode failure is reported, never raised."""
    if not data:
        return ImageQuality(corrupt=True, corrupt_reason="empty file")
    try:
        with Image.open(BytesIO(data)) as raw:
            raw.load()
            rgb = ImageOps.exif_transpose(raw).convert("RGB")
    except Exception as exc:  # noqa: BLE001 - untrusted bytes, report as corrupt
        return ImageQuality(corrupt=True, corrupt_reason=f"decode failed: {exc}"[:200])

    width, height = rgb.size
    small = np.asarray(
        rgb.resize((64, 64), Image.Resampling.LANCZOS).convert("L"), dtype=np.float32
    )
    phash = _phash(small)
    dhash = _dhash(rgb)
    gray = np.asarray(
        rgb.resize((256, 256), Image.Resampling.LANCZOS).convert("L"), dtype=np.float32
    )
    blur = _laplacian_variance(gray)
    brightness = float(gray.mean())
    flatness = float(gray.std())
    white_ratio = float((gray > 250).mean())
    black_ratio = float((gray < 5).mean())

    sharpness = min(1.0, blur / 300.0)
    contrast = min(1.0, flatness / 50.0)
    exposure = 1.0 - min(1.0, abs(brightness - 128.0) / 128.0)
    resolution = min(1.0, min(width, height) / 1200.0)
    score = 0.35 * sharpness + 0.25 * contrast + 0.25 * exposure + 0.15 * resolution

    defects: list[str] = []
    if min(width, height) < MIN_SIDE:
        defects.append("too_small")
    if blur < BLUR_MIN:
        defects.append("blurry")
    if flatness < FLAT_STD_MIN:
        defects.append("flat")
    if brightness < DARK_MEAN or black_ratio > EXTREME_RATIO:
        defects.append("underexposed")
    if brightness > BRIGHT_MEAN or white_ratio > EXTREME_RATIO:
        defects.append("overexposed")

    return ImageQuality(
        width=width,
        height=height,
        phash=phash,
        dhash=dhash,
        blur_score=round(blur, 3),
        brightness=round(brightness, 3),
        flatness=round(flatness, 3),
        quality_score=round(score, 4),
        dominant_colors=_dominant_colors(rgb),
        defects=tuple(defect for defect in _REASONS if defect in defects),
    )


def hamming(left: str, right: str) -> int:
    """Bit distance between two 64-bit hex hashes."""
    if not left or not right:
        return 64
    return (int(left, 16) ^ int(right, 16)).bit_count()


def is_duplicate(left: ImageQuality, right: ImageQuality) -> bool:
    """True only when both perceptual hashes land inside the duplicate radius.

    Requiring agreement avoids isolating different products that merely share a
    studio background, which skews pHash towards the same low frequencies.
    """
    return (
        hamming(left.phash, right.phash) <= PHASH_DUP_BITS
        and hamming(left.dhash, right.dhash) <= DHASH_DUP_BITS
    )
