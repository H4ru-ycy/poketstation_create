"""
armsim.py - テスト用の最小 ARMv4 (ARM命令のみ) シミュレータ

PocketStation 実機の代わりに player を動かし、
液晶VRAM・ボタン・タイマ・SWI を模擬して動作を確認するためのもの。
対応: データ処理命令, LDR/STR(B/H無しのword/byte), LDM/STM, B/BL/BX, SWI
"""
import struct

M32 = 0xFFFFFFFF


class Halt(Exception):
    pass


class ARM:
    def __init__(self, bus):
        self.r = [0] * 16
        self.N = self.Z = self.C = self.V = 0
        self.bus = bus
        self.steps = 0

    # -------------------------------------------------- helpers
    def cond(self, c):
        N, Z, C, V = self.N, self.Z, self.C, self.V
        return [Z, not Z, C, not C, N, not N, V, not V,
                C and not Z, (not C) or Z, N == V, N != V,
                (not Z) and N == V, Z or N != V, True, False][c]

    def shift(self, val, typ, amt, carry_in, by_reg):
        if by_reg and amt == 0:
            return val, carry_in
        if typ == 0:   # LSL
            if amt == 0:
                return val, carry_in
            if amt < 32:
                return (val << amt) & M32, (val >> (32 - amt)) & 1
            return 0, (val & 1) if amt == 32 else 0
        if typ == 1:   # LSR
            if amt == 0 and not by_reg:
                amt = 32
            if amt < 32:
                return val >> amt, (val >> (amt - 1)) & 1
            return 0, (val >> 31) & 1 if amt == 32 else 0
        if typ == 2:   # ASR
            if amt == 0 and not by_reg:
                amt = 32
            sv = val - (1 << 32) if val & 0x80000000 else val
            if amt >= 32:
                res = M32 if sv < 0 else 0
                return res, res & 1
            return (sv >> amt) & M32, (val >> (amt - 1)) & 1
        # ROR / RRX
        if amt == 0 and not by_reg:
            return ((carry_in << 31) | (val >> 1)) & M32, val & 1
        amt &= 31
        if amt == 0:
            return val, (val >> 31) & 1
        res = ((val >> amt) | (val << (32 - amt))) & M32
        return res, (res >> 31) & 1

    def reg(self, n):
        return self.pc8 if n == 15 else self.r[n]

    # -------------------------------------------------- step
    def step(self):
        pc = self.r[15]
        ins = self.bus.fetch(pc)
        self.pc8 = (pc + 8) & M32
        self.steps += 1
        nxt = (pc + 4) & M32
        if not self.cond(ins >> 28):
            self.r[15] = nxt
            return
        self.r[15] = nxt
        op = (ins >> 25) & 7

        if (ins & 0x0FFFFFF0) == 0x012FFF10:          # BX
            self.r[15] = self.reg(ins & 15) & ~1
            return
        if op == 5:                                    # B / BL
            off = ins & 0xFFFFFF
            if off & 0x800000:
                off -= 0x1000000
            if ins & (1 << 24):
                self.r[14] = nxt
            self.r[15] = (pc + 8 + off * 4) & M32
            return
        if (ins >> 24) & 15 == 15:                     # SWI
            self.bus.swi(self, ins & 0xFF)
            return
        if op in (0, 1):
            if op == 0 and (ins & 0x90) == 0x90:
                raise Halt(f"未対応命令 {ins:08x} @ {pc:08x}")
            return self.dataproc(ins)
        if op in (2, 3):
            return self.ldst(ins)
        if op == 4:
            return self.ldm(ins)
        raise Halt(f"未対応命令 {ins:08x} @ {pc:08x}")

    def dataproc(self, ins):
        I = (ins >> 25) & 1
        opc = (ins >> 21) & 15
        S = (ins >> 20) & 1
        rn = (ins >> 16) & 15
        rd = (ins >> 12) & 15
        if I:
            rot = ((ins >> 8) & 15) * 2
            imm = ins & 0xFF
            op2 = ((imm >> rot) | (imm << (32 - rot))) & M32 if rot else imm
            sc = (op2 >> 31) & 1 if rot else self.C
        else:
            rm = self.reg(ins & 15)
            typ = (ins >> 5) & 3
            if ins & 0x10:
                amt = self.r[(ins >> 8) & 15] & 0xFF
                op2, sc = self.shift(rm, typ, amt, self.C, True)
            else:
                op2, sc = self.shift(rm, typ, (ins >> 7) & 31, self.C, False)
        a = self.reg(rn)
        C, V = self.C, self.V
        logic = False
        if opc == 0: res = a & op2; logic = True
        elif opc == 1: res = a ^ op2; logic = True
        elif opc in (2, 10):
            full = a + ((~op2) & M32) + 1; res = full & M32; C = full >> 32
            V = ((a ^ op2) & (a ^ res)) >> 31 & 1
        elif opc == 3:
            full = op2 + ((~a) & M32) + 1; res = full & M32; C = full >> 32
            V = ((op2 ^ a) & (op2 ^ res)) >> 31 & 1
        elif opc in (4, 11):
            full = a + op2; res = full & M32; C = full >> 32
            V = (~(a ^ op2) & (a ^ res)) >> 31 & 1
        elif opc == 5:
            full = a + op2 + self.C; res = full & M32; C = full >> 32
            V = (~(a ^ op2) & (a ^ res)) >> 31 & 1
        elif opc == 6:
            full = a + ((~op2) & M32) + self.C; res = full & M32; C = full >> 32
            V = ((a ^ op2) & (a ^ res)) >> 31 & 1
        elif opc == 7:
            full = op2 + ((~a) & M32) + self.C; res = full & M32; C = full >> 32
            V = ((op2 ^ a) & (op2 ^ res)) >> 31 & 1
        elif opc == 8: res = a & op2; logic = True
        elif opc == 9: res = a ^ op2; logic = True
        elif opc == 12: res = a | op2; logic = True
        elif opc == 13: res = op2; logic = True
        elif opc == 14: res = a & ~op2 & M32; logic = True
        else: res = (~op2) & M32; logic = True
        if S:
            self.N, self.Z = res >> 31, int(res == 0)
            if logic:
                self.C = sc
            else:
                self.C, self.V = C, V
        if opc not in (8, 9, 10, 11):
            self.r[rd] = res
            if rd == 15:
                self.r[15] = res & ~3

    def ldst(self, ins):
        I = (ins >> 25) & 1
        P, U, B, W, L = [(ins >> s) & 1 for s in (24, 23, 22, 21, 20)]
        rn = (ins >> 16) & 15
        rd = (ins >> 12) & 15
        if I:
            off, _ = self.shift(self.r[ins & 15], (ins >> 5) & 3, (ins >> 7) & 31, self.C, False)
        else:
            off = ins & 0xFFF
        base = self.reg(rn)
        addr = (base + off if U else base - off) & M32
        ea = addr if P else base
        if L:
            v = self.bus.read(ea, 1 if B else 4)
            if not B and ea & 3:
                rot = (ea & 3) * 8
                v = ((v >> rot) | (v << (32 - rot))) & M32
        else:
            v = self.reg(rd)
            self.bus.write(ea, v & 0xFF if B else v, 1 if B else 4)
        if (not P) or W:
            self.r[rn] = addr
        if L:
            self.r[rd] = v
            if rd == 15:
                self.r[15] = v & ~3

    def ldm(self, ins):
        P, U, S, W, L = [(ins >> s) & 1 for s in (24, 23, 22, 21, 20)]
        rn = (ins >> 16) & 15
        regs = [i for i in range(16) if ins & (1 << i)]
        n = len(regs)
        base = self.r[rn]
        if U:
            start = base + 4 if P else base
            newb = base + 4 * n
        else:
            start = base - 4 * n + (0 if P else 4)
            newb = base - 4 * n
        a = start & M32
        for i in regs:
            if L:
                self.r[i] = self.bus.read(a, 4)
                if i == 15:
                    self.r[15] &= ~3
            else:
                self.bus.write(a, self.reg(i), 4)
            a += 4
        if W and not (L and rn in regs):
            self.r[rn] = newb & M32
