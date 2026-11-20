"""Local PIL + numpy gate: deterministic, model-free image inspection."""

from __future__ import annotations

from io import BytesIO

from PIL import Image, ImageDraw

from octop.infra.product_library.image_quality import (
    hamming,
    inspect_image,
    is_duplicate,
)


def _product_image(*, shift: int = 0, size: tuple[int, int] = (900, 700)) -> bytes:
    image = Image.new("RGB", size, (245, 245, 240))
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        shade = 240 - y // 30
        draw.line((0, y, size[0], y), fill=(shade, shade, shade - 5))
    draw.rectangle((300 + shift, 250, 700 + shift, 600), fill=(40, 70, 130))
    buffer = BytesIO()
    image.save(buffer, "JPEG", quality=90)
    return buffer.getvalue()


def _flat_image() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (800, 600), (255, 255, 255)).save(buffer, "PNG")
    return buffer.getvalue()


def test_clean_product_image_is_ready_with_measurements() -> None:
    result = inspect_image(_product_image())
    assert result.usable
    assert result.verdict() == "ready"
    assert result.width == 900 and result.height == 700
    assert len(result.phash) == 16 and len(result.dhash) == 16
    assert result.blur_score > 0
    assert 0.0 <= result.quality_score <= 1.0


def test_corrupt_bytes_are_reported_not_raised() -> None:
    assert inspect_image(b"").corrupt
    broken = inspect_image(b"not an image")
    assert broken.corrupt
    assert broken.verdict() == "corrupt"
    assert broken.corrupt_reason


def test_flat_and_small_images_are_low_quality() -> None:
    assert "flat" in inspect_image(_flat_image()).defects
    small = inspect_image(_product_image(size=(120, 120)))
    assert "too_small" in small.defects


def test_near_duplicate_detected_and_distinct_image_not_flagged() -> None:
    first = inspect_image(_product_image())
    same = inspect_image(_product_image())
    shifted = inspect_image(_product_image(shift=260))
    assert is_duplicate(first, same)
    assert hamming(first.phash, same.phash) == 0
    assert not is_duplicate(first, shifted)
