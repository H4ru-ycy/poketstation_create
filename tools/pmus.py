"""
pmus.py - 曲データ (PMUS 形式) の作成と、実機と同じ計算の参照シンセ

PMUS 形式 (リトルエンディアン, すべて32bitワード):
  00h "PMUS"
  04h バージョン (1)
  08h ステップ数 S
  0Ch 1ステップのサンプル数 (7808Hz 単位。テンポを決める)
  10h ゲート: ステップ先頭から音を切るまでのサンプル数
  14h-1Fh 予約 (0)
  20h S x 4ワード (メロディ, ハモリ, 和音, ベース)

ワード: 0=休符 / 0xFFFFFFFF=のばす /
        bit0-15 位相増分, bit16-23 デューティ, bit24-31 音量(0-127)
"""
import struct

RATE = 7808                 # 3997696 / 32 / 16
HOLD = 0xFFFFFFFF
STEPS_PER_BEAT = 4          # 16分音符単位
DUTY = {"12.5": 32, "25": 64, "50": 128}


def note_inc(midi):
    f = 440.0 * 2 ** ((midi - 69) / 12)
    return max(1, min(0xFFFF, round(f * 65536 / RATE)))


def note_word(midi, duty, amp):
    return note_inc(midi) | (duty << 16) | (amp << 24)


def step_len(bpm):
    return round(RATE * 60 / (bpm * STEPS_PER_BEAT))


def gate_len(steplen):
    return steplen - max(1, round(steplen / 8))


def compile_song(bpm, steps, tracks):
    """tracks: 4個の dict {notes:[(start, length, midi)], duty:int, vol:0-15, mute:bool}"""
    sl = step_len(bpm)
    words = [[0] * 4 for _ in range(steps)]
    for t, tr in enumerate(tracks):
        if tr.get("mute"):
            continue
        amp = min(127, tr.get("vol", 10) * 8)
        for (s, l, n) in tr["notes"]:
            if s >= steps:
                continue
            words[s][t] = note_word(n, tr.get("duty", 128), amp)
            for k in range(s + 1, min(steps, s + l)):
                words[k][t] = HOLD
    out = b"PMUS" + struct.pack("<IIII", 1, steps, sl, gate_len(sl)) + b"\0" * 12
    for w in words:
        out += struct.pack("<4I", *w)
    return out


def render(pmu, n, shift=0, loop=True):
    """sound.S の snd_fiq と同じ手順で n サンプル作る (DAC に書く値 = 返り値 << 6)
    loop=False: 1回だけ鳴らす (曲のあとには 0 のステップが1つ続いているものとする)"""
    steps, steplen, gatelen = struct.unpack_from("<III", pmu, 8)
    data = [struct.unpack_from("<4I", pmu, 32 + i * 16) for i in range(steps)] + [(0, 0, 0, 0)]
    voice, phase = [0] * 4, [0] * 4
    ptr, remain, left, gate = 0, steps, 1, 0
    out = []
    for _ in range(n):
        left -= 1
        if left == 0 and remain == 0:          # 1回だけの曲が終わった
            out.extend([0] * (n - len(out)))
            return out
        if left == 0:
            for i, w in enumerate(data[ptr]):
                if w != HOLD:
                    voice[i] = w
            ptr += 1
            remain -= 1
            if remain == 0 and loop:
                ptr, remain = 0, steps
            left, gate = steplen, gatelen
        if gate:
            gate -= 1
            if gate == 0:
                for i, w in enumerate(data[ptr]):
                    if w != HOLD:
                        voice[i] = 0
        acc = 0
        for i in range(4):
            w = voice[i]
            phase[i] = (phase[i] + (w << 16)) & 0xFFFFFFFF
            duty = w & 0x00FF0000
            amp = w >> 24
            acc += amp if duty > (phase[i] >> 8) else -amp
        out.append(acc >> shift)
    return out


def sample_song():
    """きらきら星 (メロディ + 3度下のハモリ + アルペジオ + ベース), BPM 110"""
    C4 = 60
    mel = [0, 0, 7, 7, 9, 9, 7, None, 5, 5, 4, 4, 2, 2, 0, None]
    melody, harmony = [], []
    scale = [0, 2, 4, 5, 7, 9, 11]
    for i, d in enumerate(mel):
        if d is None:
            continue
        length = 8 if i + 1 < len(mel) and mel[i + 1] is None else 4
        melody.append((i * 4, length, C4 + 12 + d))
        deg = scale.index(d % 12)
        lower = scale[(deg - 2) % 7] - (12 if deg < 2 else 0)
        harmony.append((i * 4, length, C4 + 12 + lower))
    chords = ["C", "C", "F", "C", "F", "C", "G", "C"]   # 半小節ずつ
    roots = {"C": 0, "F": 5, "G": 7}
    arp, bass = [], []
    for h, c in enumerate(chords):
        r = roots[c]
        tones = [r, r + 4, r + 7, r + 12]
        for k in range(8):
            arp.append((h * 8 + k, 1, C4 + tones[k % 4]))
        bass.append((h * 8, 4, 36 + r))
        bass.append((h * 8 + 4, 4, 48 + r))
    tracks = [
        {"notes": melody, "duty": 128, "vol": 13},
        {"notes": harmony, "duty": 64, "vol": 8},
        {"notes": arp, "duty": 32, "vol": 6},
        {"notes": bass, "duty": 128, "vol": 11},
    ]
    return compile_song(110, 64, tracks)
