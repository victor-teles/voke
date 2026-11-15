"""Crops the illustration masters in ../illustrations to their artwork, reprints their blue ink in
the site's grey, and writes WebP files to ../public/illustrations. The hero is not built here: it
is drawn in code (components/home/hero-art.tsx). Run it after replacing a master: python3 scripts/build-illustrations.py
Needs Pillow and cwebp."""
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops

BACKGROUND = (12, 14, 18)  # --color-voke-bakelite; the masters are printed on it.
INK = (138, 144, 156)  # --color-voke-ink; replaces the ultramarine ink of the masters.
ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "illustrations"
OUTPUT = ROOT / "public" / "illustrations"
SPOTS = ["functions", "http", "events", "durable", "local", "deploy", "plugins", "reference"]
# Extra margin for artwork that is one solid block and would otherwise look heavier than the rest.
PADDING = {"local": 0.9, "plugins": 0.6}


def ink_box(image: Image.Image) -> tuple[int, int, int, int]:
    """The bounding box of everything that is not background."""
    flat = Image.new("RGB", image.size, BACKGROUND)
    difference = ImageChops.difference(image, flat).convert("L")
    box = difference.point(lambda value: 255 if value > 18 else 0).getbbox()
    if box is None:
        raise ValueError("the image is only background")
    return box


def reink(image: Image.Image) -> Image.Image:
    """Reprints the masters' ultramarine ink in INK, keeping the paper grain and the overprint
    tones. Bone, amber and the background are left as they are."""
    hue, saturation, value = image.convert("HSV").split()
    # Pillow hues run 0-255; ultramarine sits near 163.
    blue = hue.point(lambda h: 255 if 140 <= h <= 190 else 0)
    # The background is a very dark blue itself; only ink (anything brighter) is reprinted.
    blue = ImageChops.multiply(blue, value.point(lambda v: 255 if v > 56 else 0))
    amount = ImageChops.multiply(saturation.point(lambda s: min(255, s * 255 // 185)), blue)
    ink = ImageChops.multiply(Image.new("RGB", image.size, INK), Image.merge("RGB", (value, value, value)))
    neutral = Image.composite(image.convert("L").convert("RGB"), image, blue)
    return Image.composite(ink, neutral, amount)


def write_webp(image: Image.Image, name: str, quality: int) -> None:
    with tempfile.NamedTemporaryFile(suffix=".png") as file:
        image.save(file.name)
        subprocess.run(
            ["cwebp", "-quiet", "-q", str(quality), "-m", "6", file.name, "-o", str(OUTPUT / f"{name}.webp")],
            check=True,
        )


def spot(name: str, ratio: float = 16 / 10, padding: float = 0.34, width: int = 1280) -> None:
    """Centres the artwork on a card-shaped canvas with even margins."""
    image = reink(Image.open(MASTERS / f"{name}.png").convert("RGB"))
    left, top, right, bottom = ink_box(image)
    canvas_width = max((right - left) * (1 + padding), (bottom - top) * (1 + padding) * ratio)
    canvas_height = canvas_width / ratio
    canvas = Image.new("RGB", (round(canvas_width), round(canvas_height)), BACKGROUND)
    canvas.paste(image, (round(canvas_width / 2 - (left + right) / 2), round(canvas_height / 2 - (top + bottom) / 2)))
    write_webp(canvas.resize((width, round(width / ratio)), Image.LANCZOS), name, 84)


OUTPUT.mkdir(parents=True, exist_ok=True)
for spot_name in SPOTS:
    spot(spot_name, padding=PADDING.get(spot_name, 0.34))
