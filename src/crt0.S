/*
 * crt0.S - スタートアップ
 *
 * ファイル全体が 0x02000000 に割り当てられ、本体(Body)は 0x02000180 から始まる。
 * Body の先頭には「アニメ情報テーブル」を置く。ビルダー(mkpoc.py / 変換ツール)が
 * 後ろにフレームデータを付け足し、このテーブルの値を書き換える。
 */
    .syntax unified
    .arm

    .section .pocinfo, "a"
    .global anim_info
anim_info:
    .ascii  "PANM"          /* +00 識別子 */
    .word   _start          /* +04 エントリポイント (ヘッダの[5Ch]に入れる値) */
    .word   0               /* +08 フレームデータのアドレス (ビルダーが書き込む) */
    .word   0               /* +0C フレーム数 */
    .word   4               /* +10 1フレームの表示時間 (30Hz単位) */
    .word   0               /* +14 曲データのアドレス (0=曲なし) */
    .word   0               /* +18 キャラクターモードの設定のアドレス (0=アニメ再生) */
    .word   0               /* +1C 予約 */

    .section .text.start, "ax"
    .global _start
_start:
    /* ユーザーモードで呼ばれる。r0 = 起動パラメータ(GUIからなら0) */
    ldr     sp, =__stack_top

    /* .data をフラッシュからRAMへコピー (32bit単位: フラッシュは8bit読み不可) */
    ldr     r1, =__data_load
    ldr     r2, =__data_start
    ldr     r3, =__data_end
1:  cmp     r2, r3
    ldrlo   r12, [r1], #4
    strlo   r12, [r2], #4
    blo     1b

    /* .bss をゼロクリア */
    ldr     r2, =__bss_start
    ldr     r3, =__bss_end
    mov     r12, #0
2:  cmp     r2, r3
    strlo   r12, [r2], #4
    blo     2b

    bl      main

    /* main から戻ったら GUI へ (PrepareExecute(1,0,dir+30h) → DoExecute(0)) */
3:  swi     0x16
    add     r2, r0, #0x30
    mov     r1, #0
    mov     r0, #1
    swi     0x08
    mov     r0, #0
    swi     0x09
    b       3b

    .pool
