#!/usr/bin/env python3
"""converter.src.html にビルド済み player.bin と楽譜読み取り (omr.js) を埋め込んで単体HTMLを作る"""
import base64
import os
import sys

src, player, out = sys.argv[1:4]
html = open(src, encoding="utf-8").read()
b64 = base64.b64encode(open(player, "rb").read()).decode()
assert "__PLAYER_B64__" in html
html = html.replace("__PLAYER_B64__", b64)
omr_path = os.path.join(os.path.dirname(os.path.abspath(src)), "omr.js")
if "/*__OMR_JS__*/" in html:
    omr = open(omr_path, encoding="utf-8").read()
    assert "</script" not in omr
    html = html.replace("/*__OMR_JS__*/", omr)
open(out, "w", encoding="utf-8").write(html)
print(f"{out} を作成 (player {len(b64)} 文字)")
