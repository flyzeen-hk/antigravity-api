# -*- coding: utf-8 -*-
"""
Генератор профессиональной, ультра-чёткой и контрастной иконки Antigravity API.

Особенности дизайна:
1. Фирменный скругленный суперэллипс (Squircle) в стиле современных настольных ОС.
2. Глубокий премиальный тёмно-синий/индиго фон с микро-градиентом (#0F1117 -> #151926).
3. Тонкая акцентная кайма Antigravity Electric Blue (#3A89FF) и мягкое внутреннее свечение.
4. Прецизионно отцентрированный и очищенный от полей глиф Antigravity.
5. Интегрированный стильный бейдж "API" в фирменном стиле Google / Cloud Code.
6. Экспорт полного набора разрешений Windows ICO: 16, 20, 24, 32, 40, 48, 64, 128, 256 px
   с индивидуальной суперсэмплерной фильтрацией LANCZOS.
"""

import os
import sys

try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(BASE_DIR, "assets")
RAW_LOGO = os.path.join(ASSETS_DIR, "antigravity_logo.png")
OUT_ICO = os.path.join(ASSETS_DIR, "antigravity_api.ico")
ROOT_ICO = os.path.join(BASE_DIR, "antigravity_api.ico")
OUT_PNG = os.path.join(ASSETS_DIR, "antigravity_icon_512.png")
UI_LOGO = os.path.join(ASSETS_DIR, "antigravity_logo_ui.png")


def create_premium_icon(size=1024):
    """
    Рендерит иконку в супер-разрешении 1024x1024 для идеального сглаживания при даунскейле.
    """
    # 1. Загрузка исходного логотипа и обрезка пустых краёв (46px)
    src = Image.open(RAW_LOGO).convert("RGBA")
    bbox = src.getbbox()
    glyph = src.crop(bbox)

    # 2. Холст супер-разрешения
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 3. Рисуем мягкую тень под плиткой
    shadow_margin = int(size * 0.08)
    shadow_radius = int(size * 0.22)
    shadow_box = [shadow_margin, shadow_margin + int(size * 0.03), size - shadow_margin, size - shadow_margin + int(size * 0.03)]
    
    shadow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    s_draw = ImageDraw.Draw(shadow_layer)
    s_draw.rounded_rectangle(shadow_box, radius=shadow_radius, fill=(0, 0, 0, 160))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(int(size * 0.035)))
    canvas.alpha_composite(shadow_layer)

    # 4. Базовая форма плитки (Squircle)
    margin = int(size * 0.08)
    radius = int(size * 0.22)
    tile_box = [margin, margin, size - margin, size - margin]

    # Градиент плитки: глубокий индиго/графит
    tile_gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(tile_gradient)
    
    top_color = (20, 24, 34, 255)       # #141822
    bottom_color = (9, 11, 16, 255)     # #090B10
    
    for y in range(margin, size - margin):
        ratio = (y - margin) / float(size - 2 * margin)
        r = int(top_color[0] * (1 - ratio) + bottom_color[0] * ratio)
        g = int(top_color[1] * (1 - ratio) + bottom_color[1] * ratio)
        b = int(top_color[2] * (1 - ratio) + bottom_color[2] * ratio)
        g_draw.line([(margin, y), (size - margin, y)], fill=(r, g, b, 255))

    # Маска плитки
    tile_mask = Image.new("L", (size, size), 0)
    tm_draw = ImageDraw.Draw(tile_mask)
    tm_draw.rounded_rectangle(tile_box, radius=radius, fill=255)

    canvas.paste(tile_gradient, (0, 0), tile_mask)

    # 5. Тонкая акцентная рамка плитки (Antigravity Blue + блик)
    border_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    b_draw = ImageDraw.Draw(border_layer)
    b_draw.rounded_rectangle(tile_box, radius=radius, outline=(58, 137, 255, 200), width=int(size * 0.012))
    
    inner_box = [margin + 4, margin + 4, size - margin - 4, size - margin - 4]
    b_draw.rounded_rectangle(inner_box, radius=radius - 4, outline=(255, 255, 255, 36), width=int(size * 0.005))
    canvas.alpha_composite(border_layer)

    # 6. Масштабируем и размещаем символ Antigravity в центр
    target_glyph_size = int(size * 0.54)
    glyph_resized = glyph.resize((target_glyph_size, target_glyph_size), Image.Resampling.LANCZOS)
    
    gx = (size - target_glyph_size) // 2
    gy = int(size * 0.16)

    # Мягкое неоновое свечение глифа на тёмной плитке
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow.paste(glyph_resized, (gx, gy), glyph_resized)
    glow_alpha = glow.split()[3]
    glow_blue = Image.new("RGBA", (size, size), (58, 137, 255, 100))
    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_layer.paste(glow_blue, (0, 0), glow_alpha)
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(int(size * 0.025)))
    canvas.alpha_composite(glow_layer)

    # Накладываем сам глиф
    canvas.alpha_composite(glyph_resized, (gx, gy))

    # 7. Стильный технологичный бейдж "API" внизу плитки
    badge_w = int(size * 0.34)
    badge_h = int(size * 0.13)
    bx = (size - badge_w) // 2
    by = int(size * 0.73)
    badge_box = [bx, by, bx + badge_w, by + badge_h]
    badge_radius = int(badge_h * 0.45)

    badge_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    badge_draw = ImageDraw.Draw(badge_layer)
    badge_draw.rounded_rectangle(badge_box, radius=badge_radius, fill=(58, 137, 255, 245),
                                 outline=(255, 255, 255, 140), width=int(size * 0.004))

    font_size = int(badge_h * 0.62)
    font = None
    for font_name in ["segoeui.ttf", "arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"]:
        try:
            font = ImageFont.truetype(font_name, font_size)
            break
        except Exception:
            continue
    if not font:
        font = ImageFont.load_default()

    text = "API"
    t_bbox = badge_draw.textbbox((0, 0), text, font=font)
    tw = t_bbox[2] - t_bbox[0]
    th = t_bbox[3] - t_bbox[1]
    tx = bx + (badge_w - tw) // 2
    ty = by + (badge_h - th) // 2 - int(badge_h * 0.08)

    badge_draw.text((tx, ty), text, fill=(255, 255, 255, 255), font=font)
    canvas.alpha_composite(badge_layer)

    return canvas


def main():
    print("Генерация мастер-изображения иконки 1024x1024...")
    master = create_premium_icon(size=1024)

    # Сохраняем 512x512 PNG
    png512 = master.resize((512, 512), Image.Resampling.LANCZOS)
    png512.save(OUT_PNG, format="PNG", optimize=True)
    print(f"[OK] Master PNG created: {OUT_PNG}")

    # Полная сетка размеров Windows ICO:
    ico_sizes = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]
    
    png512.save(OUT_ICO, format="ICO", sizes=ico_sizes)
    png512.save(ROOT_ICO, format="ICO", sizes=ico_sizes)
    print(f"[OK] Windows ICO generated: {OUT_ICO} ({os.path.getsize(OUT_ICO)} bytes)")

    # Обновляем уменьшенную версию для UI
    ui_logo = master.resize((128, 128), Image.Resampling.LANCZOS)
    ui_logo.save(UI_LOGO, format="PNG")
    print(f"[OK] UI logo saved: {UI_LOGO}")


if __name__ == "__main__":
    main()
