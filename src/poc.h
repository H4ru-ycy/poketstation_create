/*
 * poc.h - PocketStation (SCPH-4000) ハードウェア定義
 *
 * 出典: psx-spx "Pocketstation" 章 (https://psx-spx.consoledev.net/pocketstation/)
 *
 * 注意: FLASH と BIOS ROM は 8bit 単位で読めない (16/32bit のみ)。
 *       フラッシュ上の定数データは必ず uint32_t (32bit) で持つこと。
 */
#ifndef POC_H
#define POC_H

typedef unsigned int   u32;
typedef unsigned short u16;
typedef unsigned char  u8;

#define REG(a) (*(volatile u32 *)(a))

/* ---- 割り込み / ボタン ---- */
#define INT_LATCH     REG(0x0A000000)
#define INT_INPUT     REG(0x0A000004)   /* 生の入力レベル(ボタンはここを直接読む) */
#define INT_MASK_SET  REG(0x0A000008)
#define INT_MASK_CLR  REG(0x0A00000C)
#define INT_ACK       REG(0x0A000010)

#define BTN_FIRE   (1u << 0)
#define BTN_RIGHT  (1u << 1)
#define BTN_LEFT   (1u << 2)
#define BTN_DOWN   (1u << 3)
#define BTN_UP     (1u << 4)
#define BTN_MASK   0x1Fu
#define IN_DOCKED  (1u << 11)   /* 1 = PS本体に挿さっている */

/* ---- タイマ ---- */
#define T0_RELOAD  REG(0x0A800000)
#define T0_COUNT   REG(0x0A800004)      /* 減算カウンタ */
#define T0_MODE    REG(0x0A800008)
#define T2_RELOAD  REG(0x0A800020)
#define T2_COUNT   REG(0x0A800024)
#define T2_MODE    REG(0x0A800028)
#define INT_TIMER2 (1u << 13)       /* タイマ2 は FIQ */
#define TMODE_DIV2    0u
#define TMODE_DIV32   1u
#define TMODE_DIV512  2u
#define TMODE_ENABLE  (1u << 2)

/* ---- 液晶 ---- */
#define LCD_MODE   REG(0x0D000000)
#define LCD_VRAM   ((volatile u32 *)0x0D000100)  /* 32行 x 32bit, bit0=左, 1=黒 */
#define LCDM_CPEN     (1u << 3)
#define LCDM_32HZ     (2u << 4)
#define LCDM_ON       (1u << 6)
#define LCDM_ROTATE   (1u << 7)  /* 本体に挿したときは 1 にする */

/* ---- 音 ----
 * DAC_DATA は bit6-15 が符号付き10bitの出力値 (bit0-5 は 0)。
 * 音を出すには DAC_CTRL.bit0 と IOP_START.bit5 の両方が必要。 */
#define DAC_CTRL   REG(0x0D800010)
#define DAC_DATA   REG(0x0D800014)
#define IOP_STOP   REG(0x0D800004)
#define IOP_START  REG(0x0D800008)
#define IOP_SOUND  (1u << 5)

/* ---- BIOS (SWI) ---- r0..r2 が引数, r0 が戻り値 ---- */
static inline u32 swi_set_cpu_speed(u32 speed)
{
    register u32 r0 __asm__("r0") = speed;
    __asm__ volatile("swi 0x04" : "+r"(r0) : : "memory", "lr");
    return r0;
}

/* SetCallbacks(index, proc): index 1=IRQ, 2=FIQ。起動し直すと自動で0に戻る */
static inline u32 swi_set_callback(u32 index, void (*proc)(void))
{
    register u32 r0 __asm__("r0") = index;
    register u32 r1 __asm__("r1") = (u32)proc;
    __asm__ volatile("swi 0x01" : "+r"(r0) : "r"(r1) : "memory", "lr");
    return r0;
}

/* 時計画面のアラーム設定へのポインタ。bit18-19 が音量 (0=普通, 1=小, 2=消音) */
static inline volatile u32 *swi_get_alarm_setting(void)
{
    register u32 r0 __asm__("r0");
    __asm__ volatile("swi 0x13" : "=r"(r0) : : "memory", "lr");
    return (volatile u32 *)r0;
}

/* GetBcdDate: bit0-7 日, bit8-15 月, bit16-23 年 (下2桁), bit24-31 世紀 (すべてBCD) */
static inline u32 swi_get_bcd_date(void)
{
    register u32 r0 __asm__("r0");
    __asm__ volatile("swi 0x0D" : "=r"(r0) : : "memory", "lr");
    return r0;
}

/* GetBcdTime: bit0-7 秒, bit8-15 分, bit16-23 時 (BCD), bit24-31 曜日 (1=日曜 … 7=土曜) */
static inline u32 swi_get_bcd_time(void)
{
    register u32 r0 __asm__("r0");
    __asm__ volatile("swi 0x0E" : "=r"(r0) : : "memory", "lr");
    return r0;
}

static inline u32 swi_prepare_execute(u32 flag, u32 dir_index, u32 param)
{
    register u32 r0 __asm__("r0") = flag;
    register u32 r1 __asm__("r1") = dir_index;
    register u32 r2 __asm__("r2") = param;
    __asm__ volatile("swi 0x08" : "+r"(r0) : "r"(r1), "r"(r2) : "memory", "lr");
    return r0;
}

static inline u32 swi_do_execute(u32 flag)
{
    register u32 r0 __asm__("r0") = flag;
    __asm__ volatile("swi 0x09" : "+r"(r0) : : "memory", "lr");
    return r0;
}

static inline u32 swi_get_dir_index(void)
{
    register u32 r0 __asm__("r0");
    __asm__ volatile("swi 0x16" : "=r"(r0) : : "memory", "lr");
    return r0;
}

/* GUI (時計画面のファイル選択) に戻る。成功すると戻ってこない */
static inline void poc_exit_to_gui(void)
{
    swi_prepare_execute(1, 0, swi_get_dir_index() + 0x30);
    swi_do_execute(0);
}

#endif
