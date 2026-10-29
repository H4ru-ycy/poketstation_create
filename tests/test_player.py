"""
test_player.py - build/anime.bin をシミュレータで動かして動作を確認する

  python3 tests/test_player.py build/anime.bin
"""
import struct
import sys

HERE = __file__.rsplit("/", 1)[0]
sys.path.insert(0, HERE)
sys.path.insert(0, HERE + "/../tools")
from armsim import ARM, Halt, M32  # noqa: E402
from pmus import render  # noqa: E402

MAGIC_RET = 0xFFFFFFF0

K = 3            # 1タイマカウントあたりの命令数 (模擬)


class PocBus:
    def __init__(self, filedata):
        self.flash = bytearray(filedata)
        self.flash_writes = []    # (tick, sector, FIQ が動いていたか)
        self.ram = bytearray(0x800)
        self.io = {}
        self.vram = [0] * 32
        self.draws = []          # (tick, tuple(vram))
        self.lcd_modes = {}      # tick -> LCD_MODE
        self.swis = []
        self.byte_flash_reads = []
        self.cpu = None
        self.t0_start = None
        self.buttons = lambda tick: 0
        self.fiq_cb = 0
        self.dac = []            # DAC_DATA に書かれた値
        self.io_log = []         # (addr, value)

    # 時刻
    def reload(self):
        return self.io.get(0x0A800000, 0) & 0xFFFF

    def tick(self):
        if self.t0_start is None:
            return 0
        return (self.cpu.steps - self.t0_start) // (K * (self.reload() + 1))

    def fetch(self, a):
        if 0x02000000 <= a < 0x02000000 + len(self.flash):
            return struct.unpack_from("<I", self.flash, a - 0x02000000)[0]
        raise Halt(f"フラッシュ外を実行: {a:08x}")

    def read(self, a, size):
        if a < 0x800:
            return int.from_bytes(self.ram[a:a + size], "little")
        if 0x02000000 <= a < 0x02000000 + len(self.flash):
            if size == 1:
                self.byte_flash_reads.append(a)
            o = a - 0x02000000
            return int.from_bytes(self.flash[o:o + size], "little")
        if a == 0x0A800004:      # T0_COUNT
            r = self.reload()
            n = (self.cpu.steps - self.t0_start) // K
            return r - (n % (r + 1))
        if a == 0x0A000004:      # INT_INPUT
            return self.buttons(self.tick())
        if 0x0D000100 <= a < 0x0D000180:
            return self.vram[(a - 0x0D000100) // 4]
        return self.io.get(a, 0)

    def write(self, a, v, size):
        if a < 0x800:
            self.ram[a:a + size] = v.to_bytes(size, "little")
            return
        if 0x0D000100 <= a < 0x0D000180:
            y = (a - 0x0D000100) // 4
            self.vram[y] = v
            if y == 31:
                self.draws.append((self.tick(), tuple(self.vram)))
            return
        if 0x02000000 <= a < 0x04000000:
            raise Halt(f"フラッシュに書き込み: {a:08x}")
        if a == 0x0A800008 and v & 4 and self.t0_start is None:
            self.t0_start = self.cpu.steps
        if a == 0x0D000000:
            self.lcd_modes[self.tick()] = v
        if a == 0x0D800014:
            self.dac.append(v)
        self.io_log.append((a, v))
        self.io[a] = v

    def swi(self, cpu, n):
        args = tuple(cpu.r[:3])
        self.swis.append((n, args, self.tick()))
        if n == 0x04:
            cpu.r[0] = 7
        elif n == 0x16:
            cpu.r[0] = 3
        elif n == 0x08:
            cpu.r[0] = args[1]
        elif n == 0x09:
            raise Halt("exit")
        elif n == 0x01:
            old = self.fiq_cb if args[0] == 2 else 0
            if args[0] == 2:
                self.fiq_cb = args[1]
            cpu.r[0] = old
        elif n == 0x03:                  # FlashWriteVirtual(sector, src): 128バイト書く
            sector, src = args[0], args[1]
            data = bytes(self.ram[src:src + 128]) if src + 128 <= 0x800 else None
            o = sector * 128
            if data is None or o + 128 > len(self.flash):
                raise Halt(f"フラッシュの書き込みがおかしい: sector {sector} src {src:x}")
            fiq_on = False
            for a, v in self.io_log:
                if a == 0x0A000008 and v & 0x2000: fiq_on = True
                if a == 0x0A00000C and v & 0x2000: fiq_on = False
            self.flash[o:o + 128] = data
            self.flash_writes.append((self.tick(), sector, fiq_on))
            cpu.r[0] = 0
        elif n == 0x13:
            cpu.r[0] = 0xD8              # カーネルRAM上のアラーム設定
        else:
            raise Halt(f"想定外の SWI {n:02x}")


def run_fiq(cpu, bus, n):
    """FIQ コールバックを n 回呼ぶ。BIOS と同じく呼び出し前後でユーザーの状態を戻す"""
    out, worst, broken = [], 0, []
    for _ in range(n):
        saved, flags, steps = list(cpu.r), (cpu.N, cpu.Z, cpu.C, cpu.V), cpu.steps
        bus.io[0x0A000000] = 0x2000          # INT_LATCH: タイマ2
        cpu.r[14] = MAGIC_RET
        cpu.r[15] = bus.fiq_cb
        before = len(bus.dac)
        while cpu.r[15] != MAGIC_RET:
            cpu.step()
            if cpu.steps - steps > 500:
                raise SystemExit("FIQ が戻りません")
        worst = max(worst, cpu.steps - steps)
        for r in (2, 3, 4, 5, 6, 7, 13):
            if cpu.r[r] != saved[r]:
                broken.append(r)
        out.extend(bus.dac[before:])
        cpu.r = saved
        cpu.N, cpu.Z, cpu.C, cpu.V = flags
        cpu.steps = steps
        bus.io[0x0A000000] = 0
    return out, worst, broken


def signed10(v):
    x = (v >> 6) & 0x3FF
    return x - 0x400 if x & 0x200 else x


def main(path, volume=0):
    data = open(path, "rb").read()
    assert data[:2] == b"SC" and data[0x52:0x56] == b"MCX0"
    entry = struct.unpack_from("<I", data, 0x5C)[0]
    info = struct.unpack_from("<8I", data, 0x180)
    fr_addr, count, delay, music_addr = info[2], info[3], info[4], info[5]
    frames = [struct.unpack_from("<32I", data, fr_addr - 0x02000000 + i * 128) for i in range(count)]
    print(f"entry={entry:08x} frames={count} @ {fr_addr:08x} delay={delay}")
    icount, idelay, iaddr = struct.unpack_from("<HHI", data, 0x100)
    assert (icount, idelay, iaddr) == (count, delay, fr_addr), "実行アイコンリストが不一致"

    bus = PocBus(data)
    cpu = ARM(bus)
    bus.cpu = cpu
    bus.ram[0xD8:0xDC] = struct.pack("<I", volume << 18)
    music = data[music_addr - 0x02000000:] if music_addr else b""
    print("曲:", f"{struct.unpack_from('<I', music, 8)[0]} ステップ @ {music_addr:08x}" if music else "なし",
          "/ 時計画面の音量:", ["普通", "小", "消音"][volume])
    cpu.r[15] = entry
    cpu.r[13] = 0x12345678     # crt0 が sp を設定するはず

    F, R, L, D, U, DOCK = 1, 2, 4, 8, 16, 1 << 11

    def buttons(t):
        b = 0
        if 40 <= t < 42: b |= R          # 速く
        if 60 <= t < 62: b |= F          # 一時停止
        if 50 <= t < 51: b |= D          # 音を止める
        if 55 <= t < 56: b |= D          # 音を戻す
        if 70 <= t < 71: b |= D          # コマ送り
        if 80 <= t < 82: b |= F          # 再開
        if 90 <= t < 91: b |= U          # 反転
        if t >= 100: b |= DOCK           # 本体に挿す
        if t >= 120: b |= F              # 長押しで終了
        return b
    bus.buttons = buttons

    fiq = {}                       # tick -> (DAC値, 最大命令数, 壊したレジスタ)
    plan = {10: 4000, 52: 100, 57: 100, 65: 100, 85: 100}
    try:
        while cpu.steps < 5_000_000:
            cpu.step()
            t = bus.tick()
            if music and t in plan and t not in fiq and bus.fiq_cb:
                fiq[t] = run_fiq(cpu, bus, plan[t])
        raise SystemExit("終了しませんでした")
    except Halt as e:
        if str(e) != "exit":
            raise SystemExit(f"停止: {e}")

    ok = True

    def check(cond, msg):
        nonlocal ok
        print(("OK   " if cond else "NG   ") + msg)
        ok &= bool(cond)

    check(cpu.r[13] <= 0x800, f"スタックがユーザRAM内 (sp={cpu.r[13]:x})")
    check(not bus.byte_flash_reads, "フラッシュの8bit読み出し無し")
    check(bus.swis[0][0] == 0x04 and bus.swis[0][1][0] == 7, "CPU速度を7に設定")
    exe = [s for s in bus.swis if s[0] == 0x08]
    check(exe and exe[0][1] == (1, 0, 3 + 0x30), f"GUIへ戻る PrepareExecute(1,0,dir+30h) {exe[0][1] if exe else None}")
    exit_tick = bus.swis[-1][2]
    check(178 <= exit_tick <= 182, f"決定2秒長押しで終了 (tick {exit_tick}, 押し始め120)")

    # 描画内容がフレーム列どおりか (同じ絵のコマがあるので順番を追って照合)
    seq, cur, order_ok = [], 0, True
    for t, v in bus.draws:
        inv = t >= 90
        img = tuple(x ^ M32 for x in v) if inv else v
        if img == frames[cur]:
            pass
        elif img == frames[(cur + 1) % count]:
            cur = (cur + 1) % count
        else:
            order_ok = False
        seq.append((t, cur, inv))
    check(order_ok, f"描画 {len(seq)} 回すべて、正しいコマ順のフレームデータと一致")

    before = [t for t, i, _ in seq if 2 < t < 40]
    gaps = {b - a for a, b in zip(before, before[1:])}
    check(gaps == {delay}, f"速さ変更前: {delay}tickごとに更新 (実測 {sorted(gaps)})")
    after = [t for t, i, _ in seq if 43 < t < 60]
    gaps = {b - a for a, b in zip(after, after[1:])}
    check(gaps == {delay - 1}, f"右ボタン後: {delay - 1}tickごと (実測 {sorted(gaps)})")
    paused = [t for t, i, _ in seq if 62 <= t < 81]
    check(paused == [70], f"一時停止中は描画なし・下ボタンで1コマ送り (描画tick {paused})")
    check(any(t >= 81 for t, _, _ in seq if t < 90), "決定ボタンで再開")
    check(order_ok and any(t > 90 for t, _, _ in seq), "上ボタンで白黒反転 (反転後の描画も一致)")
    docked = [m for t, m in bus.lcd_modes.items() if 101 <= t < 120]
    undocked = [m for t, m in bus.lcd_modes.items() if 5 <= t < 99]
    check(docked and all(m == 0xE8 for m in docked), "本体に挿すと LCD_MODE の回転ビットON (0xE8)")
    check(undocked and all(m == 0x68 for m in undocked), "手持ちでは LCD_MODE=0x68")

    # ---- 音 ----
    writes = dict()
    for a, v in bus.io_log:
        writes.setdefault(a, []).append(v)
    if music:
        shift = 2 if volume == 1 else 0
        ref = render(music, 4300, shift)
        regs = [s[1] for s in bus.swis if s[0] == 0x01]
        check(regs and regs[0][0] == 2 and 0x02000000 < regs[0][1] < 0x02020000,
              f"FIQ コールバックを登録 (SetCallbacks(2, {regs[0][1]:08x}))" if regs else "FIQ コールバックを登録")
        check(writes.get(0x0A800020) == [15] and 5 in writes.get(0x0A800028, []), "タイマ2: reload 15, DIV32+有効 (7808Hz)")
        check(0x2000 in writes.get(0x0A000008, []), "タイマ2 の FIQ を有効化")
        check(1 in writes.get(0x0D800010, []) and 0x20 in writes.get(0x0D800008, []), "DAC_CTRL と IOP_START.bit5 で音を有効化")
        worst = max(v[1] for v in fiq.values())
        broken = sorted({r for v in fiq.values() for r in v[2]})
        check(not broken, f"FIQ が r2-r7, sp を壊さない {broken}")
        check(worst < 120, f"FIQ 1回の最大命令数 {worst} (7808Hzで1回あたり約512サイクルの予算)")
        dac10 = [signed10(v) for v in fiq[10][0]]
        check(all((v & 0x3F) == 0 for v in fiq[10][0]), "DAC の bit0-5 は 0")
        if volume == 2:
            check(all(v == 0 for v in dac10), "消音設定では最初は無音")
        else:
            check(dac10 == ref[:4000], f"DAC 出力 4000 サンプルが参照シンセと一致 (最大 {max(map(abs, dac10))})")
            check(max(map(abs, dac10)) <= 511, "10bit の範囲内")
            check(all(signed10(v) == 0 for v in fiq[52][0]), "下ボタンで音を止めると無音")
            check([signed10(v) for v in fiq[57][0]] == ref[4000:4100], "もう一度押すと続きから鳴る")
            check(all(signed10(v) == 0 for v in fiq[65][0]), "一時停止中は無音")
            check([signed10(v) for v in fiq[85][0]] == ref[4100:4200], "再開で続きから鳴る")
        check(0x2000 in writes.get(0x0A00000C, []) and bus.fiq_cb == 0, "終了時にFIQを止めてコールバックを解除")
        check(writes.get(0x0D800010, [None])[-1] == 0, "終了時に DAC を止める")
    else:
        check(not any(s[0] == 0x01 for s in bus.swis), "曲なしでは FIQ を使わない")
        check(writes.get(0x0D800010, [None])[-1] == 0, "曲なしでは DAC を止めておく")
    print("命令数:", cpu.steps)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "build/anime.bin",
         int(sys.argv[2]) if len(sys.argv) > 2 else 0)
