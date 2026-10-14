/*
 * sound.S - FIQ コールバック (1サンプル分の処理)
 *
 * BIOS の FIQ ハンドラから BX で呼ばれ、BX lr で戻る。
 * 使ってよいレジスタ: r0, r1, r12 (BIOSが保存) と r8-r11 (FIQ専用バンク)。
 * それ以外 (r2-r7, sp) には触らないこと。
 * FIQ スタックは 70h バイトしかないのでスタックも使わない。
 */
    .syntax unified
    .arm

    .equ INT_BASE,   0x0A000000
    .equ INT_LATCH,  0x00
    .equ INT_ACK,    0x10
    .equ DAC_DATA,   0x0D800014

    .equ S_ON,      0x00
    .equ S_SHIFT,   0x04
    .equ S_PTR,     0x08
    .equ S_LEFT,    0x0C
    .equ S_GATE,    0x10
    .equ S_REMAIN,  0x14
    .equ S_START,   0x18
    .equ S_COUNT,   0x1C
    .equ S_STEPLEN, 0x20
    .equ S_GATELEN, 0x24
    .equ S_VOICE,   0x28
    .equ S_PHASE,   0x38

    .section .text.snd_fiq, "ax"
    .global snd_fiq
    .type snd_fiq, %function
snd_fiq:
    /* タイマ2 の要求か確認して受け付ける */
    ldr     r12, =INT_BASE
    ldr     r0, [r12, #INT_LATCH]
    tst     r0, #0x2000
    bxeq    lr
    mov     r0, #0x2000
    str     r0, [r12, #INT_ACK]

    ldr     r12, =snd
    ldr     r0, [r12, #S_ON]
    cmp     r0, #0
    beq     .Lsilent

    /* ステップの残りを数える */
    ldr     r0, [r12, #S_LEFT]
    subs    r0, r0, #1
    beq     .Lnext_step
    str     r0, [r12, #S_LEFT]

.Lgate:
    /* 次のステップが「のばす」でない音は、ゲート時間で切って音の区切りを作る */
    ldr     r0, [r12, #S_GATE]
    cmp     r0, #0
    beq     .Lmix
    subs    r0, r0, #1
    str     r0, [r12, #S_GATE]
    beq     .Lcut

.Lmix:
    mov     r11, #0
    .irp    i, 0, 1, 2, 3
    ldr     r8, [r12, #(S_VOICE + \i * 4)]
    ldr     r9, [r12, #(S_PHASE + \i * 4)]
    add     r9, r9, r8, lsl #16         /* 位相 += 増分 */
    str     r9, [r12, #(S_PHASE + \i * 4)]
    and     r10, r8, #0x00FF0000        /* デューティ << 16 */
    cmp     r10, r9, lsr #8             /* 波形の位置 < デューティ なら山 */
    mov     r10, r8, lsr #24            /* 音量 */
    addhi   r11, r11, r10
    subls   r11, r11, r10
    .endr
    ldr     r0, [r12, #S_SHIFT]
    mov     r11, r11, asr r0
    mov     r11, r11, lsl #6            /* DAC は bit6-15 */
    ldr     r12, =DAC_DATA
    str     r11, [r12]
    bx      lr

.Lsilent:
    mov     r0, #0
    ldr     r12, =DAC_DATA
    str     r0, [r12]
    bx      lr

.Lnext_step:
    /* 4音ぶん読む。0xFFFFFFFF (のばす) なら今の音を残す */
    ldr     r8, [r12, #S_PTR]
    .irp    i, 0, 1, 2, 3
    ldr     r9, [r8], #4
    cmn     r9, #1
    strne   r9, [r12, #(S_VOICE + \i * 4)]
    .endr
    ldr     r0, [r12, #S_REMAIN]
    subs    r0, r0, #1
    ldreq   r8, [r12, #S_START]         /* 最後まで来たら先頭に戻る */
    ldreq   r0, [r12, #S_COUNT]
    str     r0, [r12, #S_REMAIN]
    str     r8, [r12, #S_PTR]
    ldr     r0, [r12, #S_STEPLEN]
    str     r0, [r12, #S_LEFT]
    ldr     r0, [r12, #S_GATELEN]
    str     r0, [r12, #S_GATE]
    b       .Lgate

.Lcut:
    ldr     r8, [r12, #S_PTR]           /* 次のステップ */
    .irp    i, 0, 1, 2, 3
    ldr     r9, [r8, #(\i * 4)]
    cmn     r9, #1
    movne   r9, #0
    strne   r9, [r12, #(S_VOICE + \i * 4)]
    .endr
    b       .Lmix

    .pool
    .size snd_fiq, . - snd_fiq
