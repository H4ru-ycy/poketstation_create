"""
test_chara.py - キャラクターモードをシミュレータで動かして確かめる

  python3 tests/test_chara.py build/player.bin [音量 0=普通 1=小 2=消音]

1. ボタン操作の台本どおりに player を動かし、毎 tick の画面と音を記録する
2. 同じ台本で converter/chara.js (変換ツールのプレビュー) を動かし、画面が1tickずつ一致するか比べる
3. 表情・時計・日数・曲 (1回だけ鳴って待機に戻る)・終了 を個別に確かめる
"""
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
from armsim import ARM, Halt  # noqa: E402
import test_player  # noqa: E402
from test_player import PocBus, run_fiq, signed10  # noqa: E402

# 1タイマカウント (CPU 512サイクル) あたりの命令数。実機はおよそ 200。
# 時計の描画などが 1tick (260カウント) に収まるかを見るので、少なめの 40 で動かす
test_player.K = 40
from pmus import render  # noqa: E402
import mkpoc  # noqa: E402

F, R, L, D, U = 1, 2, 4, 8, 16
DATE = 0x20261015                  # 2026-10-15
TIME0 = (5 << 24) | 0x113720      # 木曜 11:37:20


def bcd(v):
    return ((v // 10) << 4) | (v % 10)


def rtc(t):
    """秒だけ進める (11:37:20 から)"""
    return DATE, (TIME0 & 0xFFFFFF00) | bcd((20 + t // 30) % 60)


def make_frames():
    """9コマ: コマ i は i 行目と (i+10) 列目が黒い (どのコマか見分けられる絵)"""
    out = []
    for i in range(9):
        f = [0] * 32
        f[i] = 0xFFFFFFFF
        for y in range(32):
            f[y] |= 1 << (i + 10)
        out.append(f)
    return out


def make_song():
    """8ステップ・BPM 240 の短い曲 (1回で約0.5秒)"""
    steplen = round(7808 * 60 / (240 * 4))
    words = []
    notes = [0x0100, 0x0120, 0x0140, 0xFFFFFFFF, 0x0180, 0, 0x01A0, 0x01C0]
    for n in notes:
        w = n if n in (0, 0xFFFFFFFF) else (n | (128 << 16) | (60 << 24))
        words += [w, 0, 0, w if w not in (0, 0xFFFFFFFF) else w]
    hdr = struct.pack("<4sIIII12x", b"PMUS", 1, len(notes), steplen, steplen - round(steplen / 8))
    return hdr + struct.pack(f"<{len(words)}I", *words)


CHARA = {
    "idle": 0, "blink": 1, "faces": [2, 3, 4, None, 5], "faceHold": 1.0,
    "clockBg": None, "daysBg": 6, "singA": 7, "singB": 8,
    "dbl": "up", "long": "fire", "cmd": ["up", "up", "down", "down", "left", "right"],
    "baseDate": "2026-01-22", "countFrom": 0, "show": 2.0, "dblWin": 0.4, "longTime": 1.0,
    "cmdGap": 1.0, "daysY": 12, "exit": 3.0,
}


def script(t):
    b = 0
    if 20 <= t < 22: b |= R                         # 表情 (右)
    if t in (60, 66): b |= U                         # 2回押し → 時計 (コマンドの途中かもしれないので少し待つ)
    for k, bb in enumerate([U, U, D, D, L, R]):      # コマンド → 曲
        if t == 150 + k * 6: b |= bb
    if 230 <= t < 270: b |= F                       # 長押し → 日数
    if t == 300: b |= R                              # 日数の表示中に押す → 待機
    for k, bb in enumerate([U, U, D, D, L, R]):      # もう一度コマンド
        if t == 420 + k * 6: b |= bb
    if t == 460: b |= F                              # 曲の途中で決定 → 止める
    if t == 470: b |= D                              # 表情なしのボタン
    if t == 480: b |= U                              # 1回だけ (2回押しにならない)
    if t >= 560: b |= L                              # 3秒押し続けて終了
    return b


CHARA_B = dict(CHARA, dbl="fire", long="up", cmd=["left", "right", "left", "right"], countFrom=1, faces=[None] * 5,
               blink=None, daysBg=None, singB=None)
DATE_B = 0x19990101                # 時計が合っていない (BIOS が 1999年1月1日に戻した)


def script_b(t):
    b = 0
    if t in (20, 25): b |= F                         # 2回押し (コマンドとは関係ない) → すぐ時計
    if 100 <= t < 140: b |= U                        # 長押し → 日数 ("--")
    for k, bb in enumerate([L, R, L, R]):            # コマンド (曲なし) → 曲の表情を2秒
        if t == 200 + k * 5: b |= bb
    if t >= 300: b |= R
    return b


def script_set(t):
    b = 0
    if 30 <= t < 155: b |= D                        # 下を4秒押し続ける → 時刻合わせ (3秒でも終了しない)
    if t == 160: b |= U                              # 西暦 +1
    if t in (170, 185, 240): b |= R                  # 右: 月 → 日 → 時
    if t == 175: b |= D                              # 月 -1
    if 190 <= t < 230: b |= U                       # 日を押し続けて連続で +
    if t == 245: b |= D                              # 時 -1
    if t == 255: b |= L                              # 左: 保存して待機へ
    if t >= 330: b |= L
    return b


def scenario_set(player_path):
    """時計の表示中に決定を長押しして日付と時刻を合わせる (SWI 0Ch)"""
    frames = make_frames()
    data, _ = mkpoc.build_file(open(player_path, "rb").read(), frames, 4, "テスト", b"", CHARA)
    cfg_addr = struct.unpack_from("<8I", data, 0x180)[6]
    cfg = list(struct.unpack_from(f"<{mkpoc.PCHR_WORDS}I", data, cfg_addr - 0x02000000))
    bus = PocBus(data)
    cpu = ARM(bus)
    bus.cpu = cpu
    bus.buttons = script_set
    cpu.r[15] = struct.unpack_from("<I", data, 0x5C)[0]
    swi_base = bus.swi
    rtc_state = {"set": None}

    def now_rtc(t):
        if rtc_state["set"] is None:
            return DATE, rtc(t)[1]
        d, tm, t0 = rtc_state["set"]
        return d, (tm & 0xFFFFFF00) | bcd(((t - t0) // 30) % 60)

    def swi(cpu, n):
        t = bus.tick()
        if n == 0x0C:
            rtc_state["set"] = (cpu.r[0], cpu.r[1], t)
            bus.swis.append((n, (cpu.r[0], cpu.r[1]), t))
        elif n in (0x0D, 0x0E):
            cpu.r[0] = now_rtc(t)[0 if n == 0x0D else 1]
        else:
            swi_base(cpu, n)
    bus.swi = swi
    try:
        while cpu.steps < 30_000_000:
            cpu.step()
        raise SystemExit("終了しませんでした")
    except Halt as e:
        if str(e) != "exit":
            raise SystemExit(f"停止: {e}")
    dev = [list(v) for _, v in bus.draws]
    sets = [x for x in bus.swis if x[0] == 0x0C]
    res = []
    res.append((len(sets) == 1, f"決定で SWI 0Ch (SetBcdDateTime) を1回呼ぶ ({len(sets)}回)"))
    if not sets:
        return res
    sd, st, stick = sets[0][1][0], sets[0][1][1], sets[0][2]
    n = len(dev) + 2
    rtcs = []
    for t in range(n + 200):
        if t < stick:
            rtcs.append({"date": DATE, "time": rtc(t)[1]})
        else:
            rtcs.append({"date": sd, "time": (st & 0xFFFFFF00) | bcd(((t - stick) // 30) % 60)})
    inp = {"cfg": cfg, "frames": frames, "song": None, "buttons": [script_set(t) for t in range(n + 200)], "rtc": rtcs}
    js = json.loads(subprocess.run(["node", os.path.join(HERE, "chara_js.js")], input=json.dumps(inp),
                                   capture_output=True, text=True, check=True).stdout)
    js_fb = [j["fb"] for j in js if not j["exit"]]
    mism = [k + 1 for k in range(min(len(dev), len(js_fb))) if dev[k] != js_fb[k]]
    res.append((not mism and len(dev) == len(js_fb), f"[時刻合わせ] プレビューと実機の画面が " + (f"{len(dev)} tick すべて一致" if not mism and len(dev) == len(js_fb) else f"違う tick {mism[:8]} 長さ {len(dev)}/{len(js_fb)}")))
    jset = [j for j in js if j.get("event") == "settime"]
    res.append((jset and jset[0]["settime"]["date"] == sd and jset[0]["settime"]["time"] == st and jset[0]["t"] == stick,
                f"[時刻合わせ] プレビューも同じ日時を同じ tick で合わせる ({sd:08x} {st:08x} @ {stick})"))
    # 2026-10-15 11:37 → 年+1 (2027), 月-1 (9), 日を押し続けて 15→? , 時-1 (10)
    day = (sd & 0xFF)
    res.append(((sd >> 16) == 0x2027 and ((sd >> 8) & 0xFF) == 0x09 and (st >> 16) & 0xFF == 0x10 and (st & 0xFF00) == 0x3700 and (st & 0xFF) == 0,
                f"[時刻合わせ] 2027年9月{day:x}日 10:37:00 に合わせた (日付 {sd:08x} 時刻 {st:08x})"))
    import datetime
    dd = int(f"{day:x}")
    wd = (datetime.date(2027, 9, dd).isoweekday() % 7) + 1
    res.append((st >> 24 == wd, f"[時刻合わせ] 曜日も計算して入れる ({st >> 24}, 正しくは {wd})"))
    res.append((dev[stick - 1] == frames[0], "[時刻合わせ] 左で保存したら待機 (顔) に戻る"))
    in_set = [t for t in range(30, 255) if read_letters(dev[t - 1], 22, [21, 25, 29]) == "SET"]
    res.append((in_set and in_set[0] == 30 + 119, f"[時刻合わせ] 下を4秒押し続けると SET 画面に入る (tick {in_set[:1]})"))
    res.append((not any(x[0] == 0x09 and x[2] < 300 for x in bus.swis), "[時刻合わせ] 下を押し続けても (3秒をこえても) 終了しない"))
    return res[:-2] + res[-1:] if False else [r for r in res if r[1]]


def script_idle_clock(t):
    b = 0
    if 20 <= t < 22: b |= R                         # 表情 (1秒) → 時計に戻る
    if t == 150: b |= U                              # 消えている間はほかのボタンでは戻らない
    if t == 160: b |= F                              # 決定で戻る
    for k, bb in enumerate([U, U, D, D, L, R]):      # 戻ったあとはコマンドも使える
        if t == 200 + k * 6: b |= bb
    if t >= 300: b |= L
    return b


def scenario_idle_clock(player_path):
    """待機を日付と時計にして、3秒さわらないと表示を消す。決定で戻る"""
    conf = dict(CHARA, idleShow="clock", idleOff=3)
    dev, same, note, bus, frames = run_variant(player_path, conf, make_song(), script_idle_clock, DATE, TIME0)
    res = [(same, f"[待機=時計] プレビューと実機の画面が {note}")]
    blank = [0] * 32
    res.append((read_big(dev[10 - 1], 9, [1, 8, 18, 25]) == "1137", "[待機=時計] 待機中は日付と時計を表示"))
    res.append((dev[20 - 1] == frames[3] and read_big(dev[50 - 1], 9, [1, 8, 18, 25]) == "1137", "[待機=時計] ボタンの表情を出したあと時計に戻る"))
    off = next((t for t in range(22, 150) if dev[t - 1] == blank), None)
    res.append((off == 21 + 90, f"[待機=時計] さわらずに3秒で表示を消す (tick {off})"))
    res.append((dev[155 - 1] == blank, "[待機=時計] 消えている間は決定以外では戻らない"))
    res.append((read_big(dev[160 - 1], 9, [1, 8, 18, 25]) == "1137", "[待機=時計] 決定を押すと時計が戻る"))
    sing = [t for t in range(200, 300) if dev[t - 1] in (frames[7], frames[8])]
    res.append((sing and sing[0] == 230, f"[待機=時計] 戻ったあとはコマンドで曲 (tick {sing[:1]})"))
    return res


def script_user(t):
    b = 0
    if 30 <= t < 160: b |= D                        # 待機 (時計) で下を4秒 → 時刻合わせ
    if t == 170: b |= U                              # 西暦 +1
    if t == 180: b |= L                              # 左で保存して待機へ
    if 200 <= t < 240: b |= U                       # 上の長押し → 日数
    for k, bb in enumerate([U, U, D, D, L, R]):
        if t == 400 + k * 6: b |= bb
    if t >= 520: b |= L
    return b


def scenario_user(player_path):
    """待機=時計、上の長押しで日数、2回押しなし、曲の間は1枚の画像。決定の長押しで時刻合わせ"""
    conf = dict(CHARA, idleShow="clock", idleOff=0, dbl="", long="up", singMode="image", singA=7, faces=[None] * 5, blink=None)
    dev, same, note, bus, frames = run_variant(player_path, conf, make_song(), script_user, DATE, TIME0)
    res = [(same, f"[待機=時計・上で日数] プレビューと実機の画面が {note}")]
    set_ticks = [t for t in range(30, 180) if read_letters(dev[t - 1], 22, [21, 25, 29]) == "SET"]
    res.append((set_ticks and set_ticks[0] == 30 + 119, f"[待機=時計・上で日数] 下の4秒長押しで時刻合わせ (tick {set_ticks[:1]})"))
    res.append((read_big(dev[185 - 1], 9, [1, 8, 18, 25]) == "1137", "[待機=時計・上で日数] 左で保存すると待機 (日付と時計) に戻る"))
    res.append((read_big(dev[200 + 29 - 1], 12, [6, 13, 20]) == "266", "[待機=時計・上で日数] 上の長押しで日数 (266)"))
    sing = [t for t in range(400, 520) if dev[t - 1] == frames[7]]
    res.append((sing and sing[0] == 430, f"[待機=時計・上で日数] コマンドで曲と画像 (tick {sing[:1]})"))
    return res


def script_vol(t):
    b = 0
    if t in (20, 40): b |= R                         # 右: 音量 2 → 3 → 4
    for k, bb in enumerate([U, U, D, D, L, R]):      # コマンドの最後の右では音量は変えない
        if t == 100 + k * 6: b |= bb
    if t >= 300: b |= L
    return b


def scenario_volume(player_path):
    """待機 (時計) で右を押すたびに音量を変える。ピッと鳴り、画面の下に出る。曲はその音量で鳴る"""
    song = make_song()
    conf = dict(CHARA, idleShow="clock", idleOff=0, dbl="", long="up", singMode="image", singA=7, faces=[None] * 5, blink=None, volBtn="right")
    dev, same, note, bus, frames, dac = run_variant(player_path, conf, song, script_vol, DATE, TIME0, with_dac=True)
    res = [(same, f"[音量] プレビューと実機の画面が {note}")]
    vol_scr = read_small(dev[21 - 1], 25, [10, 18])
    res.append((vol_scr == "35" and read_big(dev[21 - 1], 9, [1, 8, 18, 25]) != "1137", f"[音量] 右を押すと音量の画面に切りかわる (「3/5」 読み取り {vol_scr})"))
    res.append((read_big(dev[20 + 45 + 1 - 1], 9, [1, 8, 18, 25]) == "1137" and read_big(dev[20 + 44 - 1], 9, [1, 8, 18, 25]) != "1137" or read_big(dev[40 + 46 - 1], 9, [1, 8, 18, 25]) == "1137",
                "[音量] 1.5秒たつと日付と時計に戻る"))
    beep = [signed10(v) for t in range(21, 26) for v in dac.get(t, [])]
    res.append((beep and max(abs(v) for v in beep) == 90 * 24 // 16, f"[音量] ピッと鳴る (音量3: 最大 {max(abs(v) for v in beep) if beep else 0})"))
    steplen = struct.unpack_from("<I", song, 12)[0]
    sing_from = 130
    pcm = [signed10(v) for t in range(sing_from + 1, sing_from + 40) for v in dac.get(t, [])]
    ref = render(song, len(pcm), loop=False, gain=32)
    res.append((pcm[:8 * steplen] == ref[:8 * steplen] and pcm, f"[音量] 曲は音量4 (×2) で鳴る ({len(pcm)} サンプルを比べた)"))
    return [r for r in res if r[1]]


def run_variant(player_path, conf, song, script_fn, date=DATE_B, time=0x07000000, with_dac=False):
    """設定・曲・台本を変えて動かし、(実機の画面の列, プレビューと一致したか, 説明, bus) を返す"""
    frames = make_frames()
    data, _ = mkpoc.build_file(open(player_path, "rb").read(), frames, 4, "テスト", song, conf)
    cfg_addr = struct.unpack_from("<8I", data, 0x180)[6]
    cfg = list(struct.unpack_from(f"<{mkpoc.PCHR_WORDS}I", data, cfg_addr - 0x02000000))
    bus = PocBus(data)
    cpu = ARM(bus)
    bus.cpu = cpu
    bus.buttons = script_fn
    cpu.r[15] = struct.unpack_from("<I", data, 0x5C)[0]
    swi_base = bus.swi

    def swi(cpu, n):
        if n in (0x0D, 0x0E):
            cpu.r[0] = date if n == 0x0D else time
        elif n == 0x0C:                       # 時刻合わせ (ここでは時計は進めない)
            bus.swis.append((n, (cpu.r[0], cpu.r[1]), bus.tick()))
        else:
            swi_base(cpu, n)
    bus.swi = swi
    last_t = 0
    dac = {}
    try:
        while cpu.steps < 30_000_000:
            cpu.step()
            t = bus.tick()
            if t != last_t:
                last_t = t
                if bus.fiq_cb and _fiq_enabled(bus):
                    dac[t] = run_fiq(cpu, bus, 260)[0]
        raise SystemExit("終了しませんでした")
    except Halt as e:
        if str(e) != "exit":
            raise SystemExit(f"停止: {e}")
    dev = [list(v) for _, v in bus.draws]
    n = len(dev) + 2
    steplen = struct.unpack_from("<I", song, 12)[0] if song else 0
    inp = {"cfg": cfg, "frames": frames, "song": {"count": struct.unpack_from("<I", song, 8)[0], "steplen": steplen} if song else None,
           "buttons": [script_fn(t) for t in range(n + 200)], "rtc": [{"date": date, "time": time} for _ in range(n + 200)]}
    js = json.loads(subprocess.run(["node", os.path.join(HERE, "chara_js.js")], input=json.dumps(inp),
                                   capture_output=True, text=True, check=True).stdout)
    js_fb = [j["fb"] for j in js if not j["exit"]]
    mism = [k + 1 for k in range(min(len(dev), len(js_fb))) if dev[k] != js_fb[k]]
    same = not mism and len(dev) == len(js_fb)
    note = f"{len(dev)} tick すべて一致" if same else f"違う tick {mism[:8]} 長さ {len(dev)}/{len(js_fb)}"
    if with_dac:
        return dev, same, note, bus, frames, dac
    return dev, same, note, bus, frames


def script_anim(t):
    b = 0
    for k, bb in enumerate([L, R, L, R]):
        if t == 20 + k * 5: b |= bb
    for k, bb in enumerate([L, R, L, R]):
        if t == 200 + k * 5: b |= bb
    if t >= 330: b |= R
    return b


def scenario_anim(player_path):
    """曲の間のアニメーション: 曲に合わせて (16分音符ごと) と、時間で (3tick ごと・曲なし)"""
    res = []
    song = make_song()
    conf = dict(CHARA_B, singMode="anim", singFirst=2, singCount=4, singSync=1)
    dev, same, note, bus, frames = run_variant(player_path, conf, song, script_anim)
    res.append((same, f"[アニメ・曲に合わせる] プレビューと実機の画面が {note}"))
    which = [next((i for i, f in enumerate(frames) if f == d), None) for d in dev]
    seq = [which[t - 1] for t in range(35, 60)]
    steplen = struct.unpack_from("<I", song, 12)[0]
    expect = []
    for t in range(35, 60):
        el = (t - 35) * 260
        reads = 0 if el < 1 else min(8, (el - 1) // steplen + 1)
        expect.append(2 + (max(0, reads) % 4) if (t - 35) * 260 < 8 * steplen + 1 else 0)
    res.append((seq[:14] == expect[:14], f"[アニメ・曲に合わせる] 16分音符ごとにコマ2→3→4→5→2… ({seq[:14]})"))
    conf2 = dict(conf, singSync=0, singDelay=3)
    dev2, same2, note2, _, _ = run_variant(player_path, conf2, b"", script_anim)
    res.append((same2, f"[アニメ・時間で] プレビューと実機の画面が {note2}"))
    which2 = [next((i for i, f in enumerate(frames) if f == d), None) for d in dev2]
    seq2 = which2[35 - 1:35 - 1 + 15]
    res.append((seq2 == [2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 2, 2, 2], f"[アニメ・時間で] 3tick ごとに次のコマ ({seq2})"))
    res.append((which2[35 + 60 - 1] == 0, "[アニメ・時間で] 曲が無いときは2秒で待機に戻る"))
    conf3 = dict(conf, singFirst=7, singCount=5)      # 範囲がコマ数を超える → あるところまで
    dev3, same3, note3, _, _ = run_variant(player_path, conf3, song, script_anim)
    res.append((same3, f"[アニメ・範囲がはみ出す] プレビューと実機の画面が {note3}"))
    return res


def scenario_b(player_path):
    """2つ目の設定: 曲なし・時計が合っていない・2回押しのボタンがコマンドに無い"""
    frames = make_frames()
    data, _ = mkpoc.build_file(open(player_path, "rb").read(), frames, 4, "テスト", b"", CHARA_B)
    cfg_addr = struct.unpack_from("<8I", data, 0x180)[6]
    cfg = list(struct.unpack_from(f"<{mkpoc.PCHR_WORDS}I", data, cfg_addr - 0x02000000))
    bus = PocBus(data)
    cpu = ARM(bus)
    bus.cpu = cpu
    bus.buttons = script_b
    cpu.r[15] = struct.unpack_from("<I", data, 0x5C)[0]
    swi_base = bus.swi

    def swi(cpu, n):
        if n in (0x0D, 0x0E):
            cpu.r[0] = DATE_B if n == 0x0D else 0x07000000
        else:
            swi_base(cpu, n)
    bus.swi = swi
    try:
        while cpu.steps < 20_000_000:
            cpu.step()
        raise SystemExit("終了しませんでした")
    except Halt as e:
        if str(e) != "exit":
            raise SystemExit(f"停止: {e}")
    dev = [list(v) for _, v in bus.draws]
    n = len(dev) + 2
    inp = {"cfg": cfg, "frames": frames, "song": None, "buttons": [script_b(t) for t in range(n + 200)],
           "rtc": [{"date": DATE_B, "time": 0x07000000} for _ in range(n + 200)]}
    js = json.loads(subprocess.run(["node", os.path.join(HERE, "chara_js.js")], input=json.dumps(inp),
                                   capture_output=True, text=True, check=True).stdout)
    js_fb = [j["fb"] for j in js if not j["exit"]]
    mism = [k + 1 for k in range(min(len(dev), len(js_fb))) if dev[k] != js_fb[k]]
    res = []
    res.append((not mism and len(dev) == len(js_fb), f"[設定2] プレビューと実機の画面が {len(dev)} tick すべて一致" + (f" 違う tick {mism[:8]} 長さ {len(dev)}/{len(js_fb)}" if mism or len(dev) != len(js_fb) else "")))
    clock = dev[25 - 1] != frames[0] and dev[24 - 1] == frames[0]
    res.append((clock, "[設定2] コマンドと関係ない2回押しは、すぐ時計を出す"))
    res.append((read_big(dev[129 - 1], 12, [9, 16]) == "--", "[設定2] 時計が合っていないときは日数を -- にする"))
    res.append((dev[215 - 1] == frames[7] and dev[215 + 60 - 1] == frames[0], "[設定2] 曲が無いときは曲の表情を2秒出して戻る"))
    res.append((not any(s[0] == 0x01 for s in bus.swis), "[設定2] 曲が無いときは FIQ を使わない"))
    return res


def main(player_path, volume=0):
    frames = make_frames()
    song = make_song()
    data, _ = mkpoc.build_file(open(player_path, "rb").read(), frames, 4, "テスト", song, CHARA)
    info = struct.unpack_from("<8I", data, 0x180)
    cfg_addr = info[6]
    cfg = list(struct.unpack_from(f"<{mkpoc.PCHR_WORDS}I", data, cfg_addr - 0x02000000))
    print(f"PCHR @ {cfg_addr:08x}: 基準日 {cfg[25]} 日目 (2000-01-01 から), コマンド {cfg[16]}個")

    bus = PocBus(data)
    cpu = ARM(bus)
    bus.cpu = cpu
    bus.ram[0xD8:0xDC] = struct.pack("<I", volume << 18)
    bus.buttons = script
    cpu.r[15] = struct.unpack_from("<I", data, 0x5C)[0]
    cpu.r[13] = 0x12345678
    swi_base = bus.swi

    def swi(cpu, n):
        if n == 0x0D:
            cpu.r[0] = DATE
            bus.swis.append((n, (), bus.tick()))
        elif n == 0x0E:
            cpu.r[0] = rtc(bus.tick())[1]
            bus.swis.append((n, (), bus.tick()))
        else:
            swi_base(cpu, n)
    bus.swi = swi

    fiq_on, last_t, dac_by_tick, worst, broken = False, 0, {}, 0, set()
    try:
        while cpu.steps < 40_000_000:
            cpu.step()
            t = bus.tick()
            if t != last_t:
                last_t = t
                fiq_on = bus.fiq_cb != 0 and _fiq_enabled(bus)
                if fiq_on:
                    out, w, br = run_fiq(cpu, bus, 260)
                    dac_by_tick[t] = out
                    worst = max(worst, w)
                    broken |= set(br)
        raise SystemExit("終了しませんでした")
    except Halt as e:
        if str(e) != "exit":
            raise SystemExit(f"停止: {e}")

    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("OK   " if cond else "NG   ") + msg)
        ok &= bool(cond)

    # 1tick に1回 VRAM の最後の行まで書く → draws[k] が now=k+1 の画面
    dev = [list(v) for _, v in bus.draws]
    dev_t = [t for t, _ in bus.draws]
    check(dev_t[:5] == [1, 2, 3, 4, 5], f"毎tick 画面を書く (最初の tick {dev_t[:5]})")

    # ---- 変換ツールのプレビュー (chara.js) と照合
    n = dev_t[-1] + 2
    steplen = struct.unpack_from("<I", song, 12)[0]
    inp = {"cfg": cfg, "frames": frames, "song": {"count": 8, "steplen": steplen}, "alarm": volume,
           "buttons": [script(t) for t in range(n + 200)],
           "rtc": [{"date": DATE, "time": rtc(t)[1]} for t in range(n + 200)]}
    js = json.loads(subprocess.run(["node", os.path.join(HERE, "chara_js.js")], input=json.dumps(inp),
                                   capture_output=True, text=True, check=True).stdout)
    js_fb = [j["fb"] for j in js if not j["exit"]]
    mism = [k + 1 for k in range(min(len(dev), len(js_fb))) if dev[k] != js_fb[k]]
    check(not mism and len(dev) == len(js_fb),
          f"プレビュー (chara.js) と実機の画面が {len(dev)} tick すべて一致" + (f" (違う tick: {mism[:8]}, 長さ {len(dev)}/{len(js_fb)})" if mism or len(dev) != len(js_fb) else ""))
    exit_js = [j["t"] for j in js if j["exit"]]
    exit_dev = bus.swis[-1][2]
    check(exit_js and abs(exit_js[0] - exit_dev) <= 1, f"終了する tick が一致 (実機 {exit_dev}, プレビュー {exit_js[:1]})")
    check(559 + 89 <= exit_dev <= 559 + 92, f"3秒押し続けると終了 (tick {exit_dev}, 押し始め 560)")

    def which(fb):
        for i, f in enumerate(frames):
            if fb == f:
                return i
        return None
    face = {k + 1: which(v) for k, v in enumerate(dev)}
    check(face[10] == 0, "最初は待機の顔 (コマ0)")
    check(all(face[t] == 3 for t in range(20, 49)) and face[49] == 0, "右ボタン → 表情 (コマ3) → 1秒で待機の顔に戻る")
    blinks = [t for t, f in face.items() if f == 1]
    check(blinks and blinks[:4] == list(range(blinks[0], blinks[0] + 4)), f"まばたき (コマ1 を 4tick, 最初 tick {blinks[:1]})")

    # 時計: 2回押しのあと 0.4 秒待ってから (コマンドの始まりと同じなので)
    clock_ticks = [t for t in range(60, 150) if face[t] is None]
    check(clock_ticks and clock_ticks[0] == 66 + 12 and len(clock_ticks) == 60, f"2回押し → 時計を2秒 (tick {clock_ticks[:1]}〜, {len(clock_ticks)} tick)")
    big = read_big(dev[78 - 1], 9, [1, 8, 18, 25])
    check(big == "1137", f"時計の時刻 = 11:37 (読み取り {big})")
    small = read_small(dev[78 - 1], 1, [7, 11, 19, 23]) + read_small(dev[78 - 1], 22, [1, 5, 9, 13])
    check(small == "10152026", f"日付 10/15 と 2026 年 (読み取り {small})")
    check(read_letters(dev[78 - 1], 22, [21, 25, 29]) == "THU", "曜日 THU")

    # コマンド → 曲
    sing = [t for t in range(150, 230) if face[t] in (7, 8)]
    check(sing and sing[0] == 180, f"コマンドを最後まで押すと曲の表情 (tick {sing[:1]})")
    check({face[t] for t in sing} == {7, 8}, "曲の間は4分音符ごとに2つの表情を交互に")
    end = sing[-1] + 1
    total = 8 * steplen
    check(face[end] == 0 and (end - 180) * 260 >= total, f"曲を最後まで鳴らしたら待機に戻る (tick {end}, 曲 {total} サンプル = {total / 260:.1f} tick)")
    pcm = []
    for t in range(181, end + 1):
        pcm += dac_by_tick.get(t, [])
    ref = render(song, len(pcm), 2 if volume == 1 else 0, loop=False)
    got = [signed10(v) for v in pcm]
    if volume == 2:
        check(not any(got), "消音設定では音量「切」から始まり、曲は音を出さずに進む")
        dacc = [v for a, v in bus.io_log if a == 0x0D800010]
        check(dacc and dacc[-1] == 0, "消音設定では DAC を切ったまま")
    else:
        check(got == ref, f"曲の音が参照シンセ (1回だけ) と一致 ({len(got)} サンプル)")
    check(got[total + 5:] == [0] * len(got[total + 5:]) and not any(dac_by_tick.get(t) for t in range(end + 2, 230)),
          "曲のあとは無音・FIQ を止める")
    check(worst < 120 and not broken, f"FIQ 1回の最大命令数 {worst}, 壊したレジスタ {sorted(broken)}")

    # 長押し → 日数
    days = [t for t in range(230, 330) if face[t] is None]
    check(days and days[0] == 230 + 29, f"決定を1秒長押し → 日数 (tick {days[:1]})")
    check(len(days) == 300 - days[0], f"日数の表示中にボタンを押すと待機に戻る ({len(days)} tick)")
    num = read_big(dev[days[0] - 1], 12, [6, 13, 20])     # 3桁: 幅20 を中央に
    check(num == "266", f"2026-01-22 から 2026-10-15 は 266 日 (読み取り {num})")
    bg_row = dev[days[0] - 1][6]
    check(bg_row == frames[6][6], "日数の背景にコマ6 を使う")

    # 2回目のコマンド → 途中で決定 → 止める
    sing2 = [t for t in range(420, 470) if face[t] in (7, 8)]
    check(sing2 and sing2[0] == 450 and face[460] == 0, f"曲の途中で決定を押すと止まる (tick {sing2[:1]}〜{sing2[-1:] if sing2 else ''})")
    check(face[472] == 0 and face[482] == 5, "表情なしのボタンは顔が変わらない・上ボタン1回は表情だけ")
    fiq_regs = [s for s in bus.swis if s[0] == 0x01]
    check(len(fiq_regs) >= 4 and bus.fiq_cb == 0, "曲のたびに FIQ を登録し、止めるときに解除")
    check(not bus.byte_flash_reads, "フラッシュの8bit読み出し無し")
    check(cpu.r[13] <= 0x800, "スタックがユーザRAM内")
    icount, _, iaddr = struct.unpack_from("<HHI", data, 0x100)
    check(icount == 1 and iaddr == info[2], "メモリーカード画面のアイコンは待機の顔1枚")
    if volume == 0:
        for cond, msg in scenario_b(player_path) + scenario_anim(player_path) + scenario_set(player_path) + scenario_idle_clock(player_path) + scenario_user(player_path) + scenario_volume(player_path):
            check(cond, msg)
    sys.exit(0 if ok else 1)


def _fiq_enabled(bus):
    on = False
    for a, v in bus.io_log:
        if a == 0x0A000008 and v & 0x2000:
            on = True
        if a == 0x0A00000C and v & 0x2000:
            on = False
    return on


def read_big(fb, y, xs):
    sys.path.insert(0, os.path.join(HERE, "..", "tools"))
    import genfont
    glyphs = {ch: genfont.rows_bits(genfont.BIG[ch]) for ch in genfont.BIG_ORDER}
    out = ""
    for x in xs:
        rows = [(fb[y + r] >> x) & 63 for r in range(10)]
        out += next((ch for ch, g in glyphs.items() if g == rows), "?")
    return out


def read_small(fb, y, xs):
    import genfont
    glyphs = {ch: genfont.rows_bits(genfont.SMALL[ch].split("|")) for ch in "0123456789"}
    return "".join(next((ch for ch, g in glyphs.items() if g == [(fb[y + r] >> x) & 7 for r in range(5)]), "?") for x in xs)


def read_letters(fb, y, xs):
    import genfont
    glyphs = {ch: genfont.rows_bits(genfont.SMALL[ch].split("|")) for ch in genfont.SMALL_ORDER if ch.isalpha()}
    return "".join(next((ch for ch, g in glyphs.items() if g == [(fb[y + r] >> x) & 7 for r in range(5)]), "?") for x in xs)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "build/player.bin", int(sys.argv[2]) if len(sys.argv) > 2 else 0)
