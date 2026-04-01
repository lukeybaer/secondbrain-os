"""
thumbnail_styles.py — Multiple thumbnail templates for A/B testing.

Usage:
    from thumbnail_styles import make_thumbnail_v2, STYLES
    make_thumbnail_v2(out_path, headline, subline, style='split_red')
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import math, colorsys

FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_REG  = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
W, H = 1080, 1920
SAFE_W = 920  # max text width — 80px padding each side


def _fit_font(path, text, max_size, min_size=32):
    """Return a font that fits `text` within SAFE_W, starting at max_size."""
    for size in range(max_size, min_size - 1, -2):
        f = _font(path, size)
        dummy = Image.new('RGB', (1,1))
        d = ImageDraw.Draw(dummy)
        bb = d.textbbox((0,0), text, font=f)
        if (bb[2] - bb[0]) <= SAFE_W:
            return f, size
    return _font(path, min_size), min_size


def _fit_font_lines(path, lines, max_size, min_size=32):
    """Return font that fits ALL lines within SAFE_W."""
    for size in range(max_size, min_size - 1, -2):
        f = _font(path, size)
        dummy = Image.new('RGB', (1,1))
        d = ImageDraw.Draw(dummy)
        if all((d.textbbox((0,0), l, font=f)[2] - d.textbbox((0,0), l, font=f)[0]) <= SAFE_W for l in lines):
            return f, size
    return _font(path, min_size), min_size


def _font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except:
        return ImageFont.load_default()


def _centered_text(draw, text, y, font, color, shadow=True, shadow_color=(0,0,0,180)):
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    # Safety: if text overflows safe width, clamp x to left margin (never clip left edge)
    x = max(80, (W - tw) // 2)
    if shadow:
        draw.text((x+3, y+3), text, font=font, fill=shadow_color)
    draw.text((x, y), text, font=font, fill=color)
    return bbox[3] - bbox[1]  # line height


def _wrap_lines(text, max_chars=18):
    words = text.split()
    lines, cur = [], ''
    for w in words:
        if len(cur) + len(w) + 1 <= max_chars:
            cur = (cur + ' ' + w).strip()
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ─────────────────────────────────────────────
# STYLE 1: Split Red — high energy, danger/alert
# ─────────────────────────────────────────────
def style_split_red(img, draw, headline, subline):
    """Bold red diagonal slash, white on dark, urgent energy."""
    # Red diagonal slash across center
    draw.polygon([(0, H//2 - 120), (W, H//2 - 300), (W, H//2 + 120), (0, H//2 + 300)],
                 fill=(180, 10, 10))
    # Headline above slash
    fb = _font(FONT_BOLD, 110)
    lines = _wrap_lines(headline, 14)
    y = H//2 - 340 - len(lines)*120
    for line in lines:
        h = _centered_text(draw, line, y, fb, (255,255,255))
        y += h + 20
    # Subline below slash
    fs = _font(FONT_REG, 60)
    lines2 = _wrap_lines(subline, 20)
    y = H//2 + 160
    for line in lines2:
        _centered_text(draw, line, y, fs, (230,230,230))
        y += 75
    # Watermark
    fw = _font(FONT_REG, 38)
    _centered_text(draw, '@ailifehacks', H - 90, fw, (200,200,200), shadow=False)


# ─────────────────────────────────────────────
# STYLE 2: Glow Neon — futuristic, tech, AI
# ─────────────────────────────────────────────
def style_glow_neon(img, draw, headline, subline):
    """Cyan/purple neon glow on near-black. Tech/AI aesthetic."""
    # Subtle radial gradient vignette
    for i in range(300, 0, -1):
        alpha = int(80 * (1 - i/300))
        color = (0, 200, 255, alpha)
        draw.ellipse([(W//2 - i*2, H//2 - i*2), (W//2 + i*2, H//2 + i*2)],
                     outline=(0, int(200*(i/300)), 255))
    # Neon line
    draw.rectangle([(80, H//2 - 10), (W-80, H//2 + 10)], fill=(0, 230, 255))
    # Headline
    fb = _font(FONT_BOLD, 100)
    lines = _wrap_lines(headline, 15)
    y = H//2 - 60 - len(lines)*115
    for line in lines:
        h = _centered_text(draw, line, y, fb, (255,255,255), shadow=True, shadow_color=(0,200,255,120))
        y += h + 18
    # Subline
    fs = _font(FONT_REG, 58)
    y = H//2 + 40
    for line in _wrap_lines(subline, 22):
        _centered_text(draw, line, y, fs, (0, 230, 255))
        y += 70
    # Watermark
    fw = _font(FONT_REG, 36)
    _centered_text(draw, '@ailifehacks', H-85, fw, (0, 180, 200), shadow=False)


# ─────────────────────────────────────────────
# STYLE 3: Classified — government/conspiracy
# ─────────────────────────────────────────────
def style_classified(img, draw, headline, subline):
    """Classified document stamp aesthetic. Red CLASSIFIED diagonal stamp."""
    # Subtle grid lines (classified doc feel)
    for y in range(0, H, 60):
        draw.line([(0, y), (W, y)], fill=(30, 30, 40), width=1)
    for x in range(0, W, 60):
        draw.line([(x, 0), (x, H)], fill=(30, 30, 40), width=1)
    # Red diagonal CLASSIFIED stamp
    stamp_font = _font(FONT_BOLD, 130)
    bbox = draw.textbbox((0,0), 'CLASSIFIED', font=stamp_font)
    tw = bbox[2]-bbox[0]
    img2 = Image.new('RGBA', (W, H), (0,0,0,0))
    d2 = ImageDraw.Draw(img2)
    d2.text(((W-tw)//2, H//2 - 80), 'CLASSIFIED', font=stamp_font, fill=(200,10,10,160))
    img2 = img2.rotate(-30, center=(W//2, H//2))
    img.paste(img2, mask=img2)
    draw = ImageDraw.Draw(img)
    # Headline
    fb = _font(FONT_BOLD, 95)
    lines = _wrap_lines(headline, 16)
    y = 280
    for line in lines:
        h = _centered_text(draw, line, y, fb, (255,255,255))
        y += h + 22
    # Subline
    fs = _font(FONT_REG, 56)
    y = H - 420
    for line in _wrap_lines(subline, 22):
        _centered_text(draw, line, y, fs, (220, 220, 220))
        y += 68
    # Red border
    draw.rectangle([(20,20),(W-20,H-20)], outline=(200,10,10), width=6)
    # Watermark
    fw = _font(FONT_REG, 36)
    _centered_text(draw, '@ailifehacks', H-80, fw, (180,180,180), shadow=False)


# ─────────────────────────────────────────────
# STYLE 4: Gold Money — wealth/income
# ─────────────────────────────────────────────
def style_gold_money(img, draw, headline, subline):
    """Dark bg with gold gradient headline. Money/opportunity feel."""
    # Gold shimmer bars
    for i, y in enumerate(range(0, H, 8)):
        v = int(15 + 10 * math.sin(i * 0.3))
        draw.line([(0,y),(W,y)], fill=(v, int(v*0.8), 0), width=1)
    # Gold gradient text simulation — draw 3 layers
    fb = _font(FONT_BOLD, 115)
    lines = _wrap_lines(headline, 14)
    y = H//2 - len(lines)*130//2 - 60
    gold_colors = [(255,215,0), (255,180,0), (200,140,0)]
    for line in lines:
        bbox = draw.textbbox((0,0), line, font=fb)
        tw = bbox[2]-bbox[0]
        x = (W-tw)//2
        for offset, gc in enumerate(gold_colors):
            draw.text((x+offset, y+offset), line, font=fb, fill=gc)
        draw.text((x, y), line, font=fb, fill=(255,215,0))
        y += (bbox[3]-bbox[1]) + 24
    # Subline white
    fs = _font(FONT_REG, 60)
    y += 20
    for line in _wrap_lines(subline, 22):
        _centered_text(draw, line, y, fs, (255,255,255))
        y += 74
    # Gold divider
    draw.rectangle([(W//2-100, H//2-20), (W//2+100, H//2-14)], fill=(255,215,0))
    # Watermark
    fw = _font(FONT_REG, 36)
    _centered_text(draw, '@ailifehacks', H-85, fw, (180,160,80), shadow=False)


# ─────────────────────────────────────────────
# STYLE 5: Minimal Bold — clean, authoritative
# ─────────────────────────────────────────────
def style_minimal_bold(img, draw, headline, subline):
    """White bg, massive black headline, accent color block. Clean authority."""
    # Recolor bg to white
    img.paste((245,245,245), [0,0,W,H])
    draw = ImageDraw.Draw(img)
    # Accent color block top
    draw.rectangle([(0,0),(W,320)], fill=(20,20,180))
    # Channel in accent block
    fw = _font(FONT_BOLD, 52)
    _centered_text(draw, 'AI LIFE HACKS', 130, fw, (255,255,255), shadow=False)
    # Big black headline
    fb = _font(FONT_BOLD, 118)
    lines = _wrap_lines(headline, 13)
    y = 400
    for line in lines:
        h = _centered_text(draw, line, y, fb, (10,10,10), shadow=False)
        y += h + 20
    # Blue accent line
    draw.rectangle([(80, y+20),(W-80, y+28)], fill=(20,20,180))
    y += 60
    # Subline
    fs = _font(FONT_REG, 62)
    for line in _wrap_lines(subline, 20):
        _centered_text(draw, line, y, fs, (60,60,60), shadow=False)
        y += 76
    # Watermark on white
    fw2 = _font(FONT_REG, 36)
    _centered_text(draw, '@ailifehacks', H-85, fw2, (120,120,120), shadow=False)


# ─────────────────────────────────────────────
# DISPATCHER
# ─────────────────────────────────────────────
STYLES = {
    'navy_bold':    None,          # original — plain navy + white text
    'split_red':    style_split_red,
    'glow_neon':    style_glow_neon,
    'classified':   style_classified,
    'gold_money':   style_gold_money,
    'minimal_bold': style_minimal_bold,
}

BG_COLORS = {
    'navy_bold':    (10, 10, 26),
    'split_red':    (12, 12, 18),
    'glow_neon':    (5, 5, 15),
    'classified':   (15, 15, 22),
    'gold_money':   (12, 10, 5),
    'minimal_bold': (245, 245, 245),
}


def make_thumbnail_v2(out_path: Path, headline: str, subline: str,
                      style: str = 'navy_bold') -> Path:
    """
    Generate a thumbnail using the specified style.
    style options: navy_bold | split_red | glow_neon | classified | gold_money | minimal_bold
    """
    out_path = Path(out_path)
    bg = BG_COLORS.get(style, (10, 10, 26))
    img = Image.new('RGB', (W, H), color=bg)
    draw = ImageDraw.Draw(img)

    fn = STYLES.get(style)
    if fn:
        fn(img, draw, headline, subline)
    else:
        # navy_bold fallback (original approved style)
        draw.rectangle([(W//2 - 40, 380), (W//2 + 40, 388)], fill=(70, 130, 230))
        fb = _font(FONT_BOLD, 108)
        fs = _font(FONT_REG, 58)
        fw = _font(FONT_REG, 36)
        lines = _wrap_lines(headline, 16)
        y = 440
        for line in lines:
            h = _centered_text(draw, line, y, fb, (255,255,255))
            y += h + 24
        for line in _wrap_lines(subline, 22):
            _centered_text(draw, line, y+30, fs, (200,200,200))
            y += 70
        _centered_text(draw, '@ailifehacks', H-80, fw, (150,150,180), shadow=False)

    img.save(out_path, 'JPEG', quality=95)
    return out_path


if __name__ == '__main__':
    # Preview all styles
    import sys
    headline = sys.argv[1] if len(sys.argv) > 1 else 'They Banned Claude. Then Used It.'
    subline  = sys.argv[2] if len(sys.argv) > 2 else 'What They Found Was Wild'
    out_dir = Path('empire/analytics/thumb_previews')
    out_dir.mkdir(parents=True, exist_ok=True)
    for s in STYLES:
        out = out_dir / f'thumb_{s}.jpg'
        make_thumbnail_v2(out, headline, subline, style=s)
        print(f'{s}: {out} ({out.stat().st_size//1024}KB)')
