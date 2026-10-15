#!/usr/bin/env python3
"""converter.src.html にビルド済み player.bin と、converter/ の JS (楽譜読み取り・フォント・キャラクターモード) を埋め込んで単体HTMLを作る"""
import base64
import os
import sys

src, player, out = sys.argv[1:4]
html = open(src, encoding="utf-8").read()
b64 = base64.b64encode(open(player, "rb").read()).decode()
assert "__PLAYER_B64__" in html
html = html.replace("__PLAYER_B64__", b64)
here = os.path.dirname(os.path.abspath(src))
for mark, name in (("/*__OMR_JS__*/", "omr.js"), ("/*__FONT_JS__*/", "font.js"), ("/*__CHARA_JS__*/", "chara.js")):
    if mark in html:
        js = open(os.path.join(here, name), encoding="utf-8").read()
        assert "</script" not in js, name
        html = html.replace(mark, js)
open(out, "w", encoding="utf-8").write(html)
print(f"{out} を作成 (player {len(b64)} 文字)")
