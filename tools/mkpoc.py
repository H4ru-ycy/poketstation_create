#!/usr/bin/env python3
"""
mkpoc.py - PocketStation 実行ファイル作成ツール

ビルド済みの再生プログラム (player.bin) にドット絵アニメ (.pda) を付け足し、
SCヘッダ・アイコンを付けて以下を出力する:

  <out>.bin  生ファイル ("SC"形式 .BIN, 8KB単位)
  <out>.mcs  単体セーブ形式 (ディレクトリ1フレーム + ファイル)
  <out>.mcr  128KB メモリーカードイメージ (ブロック1に配置)

.pda 形式 (変換ツールが書き出す):
  00h 4  "PDA1"
  04h 4  フレーム数 N (little endian)
  08h 4  1フレームの表示時間 (30Hz単位)
  0Ch 4  予約 (0)
  10h    N x 128 バイト (1フレーム = 32行 x 32bit, bit0=左端, 1=黒)

使い方:
  python3 mkpoc.py build/player.bin -o build/anime [--frames anim.pda] [--music song.pmu]
         [--delay 4] [--title "タイトル"] [--filename BISLPSP00000ANIME]
  python3 mkpoc.py --sample-pda sample.pda   (サンプルアニメを書き出すだけ)
"""
import argparse
import math
import struct
import sys

BASE = 0x02000000
HEADER_SIZE = 0x180          # タイトル80h + PSアイコン80h + 実行アイコンリスト80h
BLOCK = 0x2000
MAX_BLOCKS = 15
INFO_MAGIC = b"PANM"


# ---------------------------------------------------------------- フレーム

def frame_from_rows(rows):
    """rows: 32個の文字列 ('#'=黒) か 32x32 の 0/1 リスト → 32個の u32"""
    out = []
    for y in range(32):
        w = 0
        for x in range(32):
            v = rows[y][x]
            if v in ("#", 1, True):
                w |= 1 << x
        out.append(w)
    return out


def sample_frames():
    """サンプル: 影つきで弾むボール (12コマ)"""
    frames = []
    n = 12
    for i in range(n):
        t = i / n
        h = abs(math.sin(math.pi * t))          # 0..1..0
        cy = 25 - h * 16                         # ボール中心Y
        squash = 1.0 if h > 0.15 else 0.8 + h    # 着地でつぶれる
        rx, ry = 5 / squash ** 0.5, 5 * squash
        shadow_w = 3 + (1 - h) * 4
        grid = [[0] * 32 for _ in range(32)]
        for y in range(32):
            for x in range(32):
                dx, dy = (x + 0.5 - 16) / rx, (y + 0.5 - cy) / ry
                d = dx * dx + dy * dy
                if d <= 1.0:
                    # ハイライト(左上)を白く抜く
                    hx, hy = (x + 0.5 - (16 - rx * 0.4)) / 1.6, (y + 0.5 - (cy - ry * 0.4)) / 1.6
                    grid[y][x] = 0 if hx * hx + hy * hy < 1 else 1
                if y == 30 and abs(x + 0.5 - 16) < shadow_w:
                    grid[y][x] = 1
                if y == 31:                       # 地面
                    grid[y][x] = 1 if x % 2 == 0 else 0
        frames.append(frame_from_rows(grid))
    return frames, 2


def read_pda(path):
    data = open(path, "rb").read()
    if data[:4] != b"PDA1":
        sys.exit(f"{path}: .pda ファイルではありません")
    count, delay = struct.unpack_from("<II", data, 4)
    need = 16 + count * 128
    if count == 0 or len(data) < need:
        sys.exit(f"{path}: フレーム数が不正です")
    frames = [list(struct.unpack_from("<32I", data, 16 + i * 128)) for i in range(count)]
    return frames, delay


def write_pda(path, frames, delay):
    with open(path, "wb") as f:
        f.write(b"PDA1" + struct.pack("<III", len(frames), delay, 0))
        for fr in frames:
            f.write(struct.pack("<32I", *fr))


# ---------------------------------------------------------------- ヘッダ

def sjis_title(text):
    """半角英数は全角にしてから Shift-JIS (最大64バイト)"""
    conv = []
    for ch in text:
        if ch == " ":
            conv.append("　")
        elif "!" <= ch <= "~":
            conv.append(chr(ord(ch) + 0xFEE0))
        else:
            conv.append(ch)
    raw = "".join(conv).encode("shift_jis", errors="replace")
    out = b""
    i = 0
    while i < len(raw):                    # 2バイト文字の途中で切らない
        step = 2 if raw[i] >= 0x80 and not (0xA1 <= raw[i] <= 0xDF) else 1
        if len(out) + step > 64:
            break
        out += raw[i:i + step]
        i += step
    return out.ljust(64, b"\0")


def color_icon(frame):
    """32x32 モノクロ → 16x16 4bpp のPS本体用アイコン (2x2のどれかが黒なら黒)"""
    out = bytearray(0x80)
    for y in range(16):
        for x in range(16):
            black = 0
            for sy in (0, 1):
                w = frame[y * 2 + sy]
                black |= (w >> (x * 2)) & 3
            idx = 1 if black else 0
            o = y * 8 + x // 2
            out[o] |= idx << (4 * (x & 1))   # 下位ニブル = 左
    return bytes(out)


# ---------------------------------------------------------------- キャラクターモード

BUTTONS = {"fire": 1, "right": 2, "left": 4, "down": 8, "up": 16}
NONE = 0xFFFFFFFF
PCHR_WORDS = 44


def day_number(y, m, d):
    """2000年1月1日を 0 とした日数 (chara.c の day_number と同じ)"""
    import datetime
    return (datetime.date(y, m, d) - datetime.date(2000, 1, 1)).days


def build_pchr(c):
    """キャラクターモードの設定 (辞書) → PCHR ブロック (src/chara.c を参照)
    フレーム番号は 0 始まり。None か -1 は「なし」。時間は秒。ボタンは fire/right/left/down/up
    曲の間: singMode="faces" (singA/singB を4分音符ごとに交互) か "anim" (singFirst から singCount コマ。
    singSync=0 なら singDelay (1/30秒単位) ごと、1-4 なら曲の16分・8分・4分・2分音符ごと)"""
    fr = lambda v: NONE if v is None or v < 0 else int(v)
    tick = lambda sec: max(1, round(float(sec) * 30))
    btn = lambda b: BUTTONS[b] if b else 0
    y, m, d = (int(x) for x in c.get("baseDate", "2026-01-22").split("-"))
    cmd = [btn(b) for b in c.get("cmd", [])][:8]
    w = [0] * PCHR_WORDS
    w[0], w[1] = 0x52484350, 3
    w[2], w[3] = fr(c.get("idle", 0)), fr(c.get("blink"))
    faces = (c.get("faces") or [None] * 5) + [None] * 5
    for i in range(5):
        w[4 + i] = fr(faces[i])
    w[9] = tick(c.get("faceHold", 2))
    w[10], w[11] = fr(c.get("clockBg")), fr(c.get("daysBg"))
    w[12], w[13] = fr(c.get("singA")), fr(c.get("singB"))
    w[14], w[15] = btn(c.get("dbl")), btn(c.get("long"))
    w[16] = len(cmd)
    for i, b in enumerate(cmd):
        w[17 + i] = b
    w[25] = day_number(y, m, d)
    w[26] = 1 if c.get("countFrom", 0) else 0
    w[27] = tick(c.get("show", 5))
    w[28] = tick(c.get("dblWin", 0.4))
    w[29] = tick(c.get("longTime", 1.0))
    w[30] = tick(c.get("cmdGap", 1.0))
    w[31] = int(c.get("daysY", 12))
    w[32] = tick(c.get("exit", 3))
    # version 2: 曲の間のアニメーション
    anim = c.get("singMode") == "anim"
    if c.get("singMode") == "image":
        w[13] = NONE
    w[34] = 1 if anim else 0
    w[35] = max(0, int(c.get("singFirst", 0) or 0))
    w[36] = max(0, int(c.get("singCount", 0) or 0)) if anim else 0
    w[37] = max(1, min(30, int(c.get("singDelay", 4) or 4)))
    w[38] = max(0, min(4, int(c.get("singSync", 3) or 0)))
    # version 3: 待機を日付と時計にする・一定時間で表示を消す
    w[40] = 1 if c.get("idleShow") == "clock" else 0
    w[41] = 0 if not c.get("idleOff") else tick(c.get("idleOff"))
    w[33] = BUTTONS.get(c.get("volBtn") or "", 0)              # 待機中に音量を変えるボタン (0 = 使わない)
    w[42] = BUTTONS.get(c.get("setBtn") or "down", 8)          # 時刻合わせに入るボタン
    w[43] = tick(c.get("setHold", 4))                         # 押し続ける時間
    return struct.pack(f"<{PCHR_WORDS}I", *w)


def build_file(player, frames, delay, title, music=b"", chara=None):
    """music: PMUS 形式の曲データ (無ければ空)。フレームの後ろに付ける
    chara: キャラクターモードの設定 (辞書)。あれば曲の後ろに PCHR ブロックを付ける"""
    player = bytearray(player)
    if player[:4] != INFO_MAGIC:
        sys.exit("player.bin の先頭に PANM 情報テーブルがありません (リンク順を確認)")
    entry = struct.unpack_from("<I", player, 4)[0]

    body = bytes(player) + b"\0" * (-len(player) % 4)
    frames_addr = BASE + HEADER_SIZE + len(body)
    count = len(frames)
    delay = max(1, min(30, int(delay)))
    frame_bytes = b"".join(struct.pack("<32I", *f) for f in frames)
    if music and music[:4] != b"PMUS":
        sys.exit("曲データ (.pmu) の形式が違います")
    music_addr = frames_addr + len(frame_bytes) if music else 0
    if chara is not None and music:
        music = bytes(music) + b"\0" * (-len(music) % 4) + b"\0" * 16   # 1回だけ鳴らす曲の終わりの目印 (休符1ステップ)
    chara_bytes = build_pchr(chara) if chara is not None else b""
    chara_addr = frames_addr + len(frame_bytes) + len(music) if chara is not None else 0
    struct.pack_into("<IIIII", player, 8, frames_addr, count, delay, music_addr, chara_addr)
    body = bytes(player) + b"\0" * (-len(player) % 4)

    # タイトルセクタ
    hdr = bytearray(0x80)
    hdr[0:2] = b"SC"
    hdr[2] = 0x11                      # PSアイコン1枚
    hdr[3] = 0x01
    hdr[4:0x44] = sjis_title(title)
    struct.pack_into("<H", hdr, 0x50, 0)          # ファイルビューア用アイコン無し → 実行アイコンを使う
    hdr[0x52:0x56] = b"MCX0"
    hdr[0x56] = 1                                  # 実行アイコンリスト 1件
    hdr[0x57] = 0                                  # 独自BUコマンド無し
    struct.pack_into("<I", hdr, 0x5C, entry)
    struct.pack_into("<HH", hdr, 0x60, 0x7FFF, 0x8000)   # パレット: 0=白, 1=黒

    icon_list = bytearray(0x80)
    icon = 0
    if chara is not None:      # キャラクターモード: アイコンは待機の顔1枚
        icon = struct.unpack_from("<I", chara_bytes, 8)[0]
        icon = icon if icon < count else 0
        struct.pack_into("<HHI", icon_list, 0, 1, delay, frames_addr + icon * 128)
    else:
        struct.pack_into("<HHI", icon_list, 0, count, delay, frames_addr)

    data = bytes(hdr) + color_icon(frames[icon]) + bytes(icon_list) + body + frame_bytes + bytes(music) + chara_bytes
    assert struct.unpack_from("<I", data, HEADER_SIZE + 4)[0] == entry
    blocks = (len(data) + BLOCK - 1) // BLOCK
    if blocks > MAX_BLOCKS:
        sys.exit(f"大きすぎます: {blocks} ブロック (最大 {MAX_BLOCKS})。フレーム数か曲の長さを減らしてください")
    return data.ljust(blocks * BLOCK, b"\0"), blocks


# ---------------------------------------------------------------- カード

def xor_sum(frame):
    c = 0
    for b in frame[:0x7F]:
        c ^= b
    return c


def dir_frame(state, size=0, nxt=0xFFFF, name=b""):
    f = bytearray(0x80)
    struct.pack_into("<IIH", f, 0, state, size, nxt)
    f[0x0A:0x0A + len(name)] = name
    f[0x7F] = xor_sum(f)
    return bytes(f)


def check_filename(name):
    raw = name.encode("ascii")
    if len(raw) > 20:
        sys.exit("ファイル名は20文字以内にしてください")
    if len(raw) < 7 or raw[6:7] != b"P":
        sys.exit('ポケステ実行ファイルはファイル名の7文字目が "P" である必要があります (例: BISLPSP00000ANIME)')
    return raw


def build_mcs(filedata, blocks, name):
    return dir_frame(0x51, blocks * BLOCK, 0xFFFF, name) + filedata


def build_mcr(filedata, blocks, name):
    card = bytearray(b"\xFF" * (16 * BLOCK))
    head = bytearray(0x80)
    head[0:2] = b"MC"
    head[0x7F] = xor_sum(head)
    card[0:0x80] = head
    for i in range(1, 16):
        if i <= blocks:
            if blocks == 1:
                st = 0x51
            else:
                st = 0x51 if i == 1 else (0x53 if i == blocks else 0x52)
            nxt = i if i < blocks else 0xFFFF       # 次のブロック番号-1
            fr = dir_frame(st, blocks * BLOCK if i == 1 else 0, nxt, name if i == 1 else b"")
        else:
            fr = dir_frame(0xA0)
        card[i * 0x80:(i + 1) * 0x80] = fr
    for i in range(16, 36):                          # 不良セクタリスト(無し)
        f = bytearray(0x80)
        struct.pack_into("<I", f, 0, 0xFFFFFFFF)
        f[0x7F] = xor_sum(f)
        card[i * 0x80:(i + 1) * 0x80] = f
    card[63 * 0x80:64 * 0x80] = head                 # 書き込みテストフレーム
    card[BLOCK:BLOCK + len(filedata)] = filedata
    # 未使用ブロックは 00h で埋める
    card[BLOCK + len(filedata):] = b"\0" * (len(card) - BLOCK - len(filedata))
    return bytes(card)


def main():
    ap = argparse.ArgumentParser(description="PocketStation 実行ファイル作成")
    ap.add_argument("player", nargs="?", help="ビルドした player.bin")
    ap.add_argument("-o", "--out", default="anime", help="出力ファイル名 (拡張子なし)")
    ap.add_argument("--frames", help="変換ツールで書き出した .pda (省略時はサンプル)")
    ap.add_argument("--music", help="変換ツールで書き出した曲 .pmu (省略時は曲なし)")
    ap.add_argument("--sample-music", action="store_true", help="サンプル曲 (きらきら星) を入れる")
    ap.add_argument("--delay", type=int, help="1コマの時間 (30Hz単位, 1～30)")
    ap.add_argument("--title", default="ドット絵アニメ", help="メモリーカード画面に出るタイトル")
    ap.add_argument("--filename", default="BISLPSP00000ANIME", help="セーブのファイル名 (7文字目はP)")
    ap.add_argument("--sample-pda", help="サンプルアニメを .pda で書き出して終了")
    ap.add_argument("--chara", help="キャラクターモードの設定 (.json)。変換ツールの project.json でも可")
    a = ap.parse_args()

    if a.sample_pda:
        fr, d = sample_frames()
        write_pda(a.sample_pda, fr, d)
        print(f"{a.sample_pda}: {len(fr)} フレーム")
        return
    if not a.player:
        ap.error("player.bin を指定してください")

    frames, delay = read_pda(a.frames) if a.frames else sample_frames()
    if a.delay:
        delay = a.delay
    name = check_filename(a.filename)
    player = open(a.player, "rb").read()
    music = b""
    if a.music:
        music = open(a.music, "rb").read()
    elif a.sample_music:
        sys.path.insert(0, __file__.rsplit("/", 1)[0])
        from pmus import sample_song
        music = sample_song()
    chara = None
    if a.chara:
        import json
        j = json.load(open(a.chara, encoding="utf-8"))
        chara = j.get("chara", j)
        if "enabled" in chara and not chara["enabled"]:
            chara = None
    filedata, blocks = build_file(player, frames, delay, a.title, music, chara)

    open(a.out + ".bin", "wb").write(filedata)
    open(a.out + ".mcs", "wb").write(build_mcs(filedata, blocks, name))
    open(a.out + ".mcr", "wb").write(build_mcr(filedata, blocks, name))
    extra = f", 曲 {struct.unpack_from('<I', music, 8)[0]} ステップ" if music else ""
    print(f"{a.out}.bin/.mcs/.mcr を作成: {len(frames)} フレーム{extra}, {blocks} ブロック")


if __name__ == "__main__":
    main()
