#!/usr/bin/env python3
"""converter.src.html にビルド済み player.bin を埋め込んで単体HTMLを作る"""
import base64
import sys

src, player, out = sys.argv[1:4]
html = open(src, encoding="utf-8").read()
b64 = base64.b64encode(open(player, "rb").read()).decode()
assert "__PLAYER_B64__" in html
open(out, "w", encoding="utf-8").write(html.replace("__PLAYER_B64__", b64))
print(f"{out} を作成 (player {len(b64)} 文字)")
