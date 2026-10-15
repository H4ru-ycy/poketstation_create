/*
 * main.c - PocketStation ドット絵アニメーション再生プログラム
 *
 * 操作:
 *   決定ボタン(短押し) : 一時停止 / 再開
 *   決定ボタン(2秒長押し): 時計画面(GUI)に戻る
 *   右 / 左            : 速く / 遅く (1コマ 1/30秒 ～ 1秒)
 *   上                 : 白黒反転
 *   下                 : 音を鳴らす / 止める (再生中)、1コマ送り (一時停止中)
 *
 * フレームデータと曲データは Body 末尾に付け足され、anim_info に場所が入る
 * (crt0.S と tools/mkpoc.py を参照)。
 * anim_info にキャラクターモードの設定があれば chara.c の chara_main を動かす。
 */
#include "poc.h"
#include "sound.h"
#include "app.h"

#define HOLD_EXIT    (TICK_HZ * 2)   /* 2秒長押しで終了 */
#define DELAY_MIN    1
#define DELAY_MAX    30

/* フレームが無いときに表示する市松模様 (8x8 マス) */
static const u32 test_pattern_row[2] = { 0x00FF00FFu, 0xFF00FF00u };

/* ---- 30Hz のタイマ (Timer0 を割り込みなしでポーリング) ----
 * CPU 3.99MHz (速度7) / 512 = 7808Hz → 260 カウントで約 30.03Hz */
static u32 last_count;

void timer_init(void)
{
    swi_set_cpu_speed(7);
    T0_MODE   = 0;                 /* 停止中でないと RELOAD が書けない */
    T0_RELOAD = 7808 / TICK_HZ - 1;
    T0_MODE   = TMODE_DIV512 | TMODE_ENABLE;
    last_count = T0_COUNT & 0xFFFFu;
}

void wait_tick(void)
{
    for (;;) {
        u32 c = T0_COUNT & 0xFFFFu;
        if (c > last_count) {      /* 減算カウンタが巻き戻った = 1周期経過 */
            last_count = c;
            return;
        }
        last_count = c;
    }
}

void lcd_update_mode(void)
{
    u32 mode = LCDM_ON | LCDM_CPEN | LCDM_32HZ;
    if (INT_INPUT & IN_DOCKED)     /* PS本体に挿すと向きが逆になる */
        mode |= LCDM_ROTATE;
    LCD_MODE = mode;
}

void lcd_draw(const u32 *frame, u32 invert)
{
    volatile u32 *vram = LCD_VRAM;
    for (u32 y = 0; y < 32; y++)
        vram[y] = frame[y] ^ invert;
}

static void lcd_draw_test(u32 invert)
{
    volatile u32 *vram = LCD_VRAM;
    for (u32 y = 0; y < 32; y++)
        vram[y] = test_pattern_row[(y >> 3) & 1] ^ invert;
}

int main(void)
{
    /* キャラクターモードの設定があればそちらを動かす (chara.c) */
    if (anim_info[INFO_CHARA])
        return chara_main((const u32 *)anim_info[INFO_CHARA]);

    const u32 *frames = (const u32 *)anim_info[INFO_FRAMES];
    u32 count = anim_info[INFO_COUNT];
    u32 delay = anim_info[INFO_DELAY];
    if (delay < DELAY_MIN) delay = DELAY_MIN;
    if (delay > DELAY_MAX) delay = DELAY_MAX;

    timer_init();
    last_count = T0_COUNT & 0xFFFFu;

    /* 曲があれば鳴らす (時計画面で消音にしていたら、下ボタンで鳴らすまで待つ) */
    int music = snd_init((const u32 *)anim_info[INFO_MUSIC]);
    u32 sound_on = (music == 1);
    if (music) {
        snd_start();
        snd.on = sound_on;
    } else {
        DAC_CTRL = 0;
        IOP_STOP = IOP_SOUND;
    }

    u32 frame = 0, wait = 0, paused = 0, invert = 0;
    u32 prev_btn = 0, fire_hold = 0;
    u32 redraw = 1;

    for (;;) {
        wait_tick();
        lcd_update_mode();

        u32 btn  = INT_INPUT & BTN_MASK;
        u32 down = btn & ~prev_btn;          /* 今押された */
        u32 up   = prev_btn & ~btn;          /* 今離された */
        prev_btn = btn;

        /* 決定ボタン: 短押し=一時停止, 長押し=終了 */
        if (btn & BTN_FIRE) {
            if (++fire_hold == HOLD_EXIT) {
                if (music) snd_stop();
                LCD_MODE = 0;
                return 0;                    /* crt0 が GUI に戻す */
            }
        } else {
            if ((up & BTN_FIRE) && fire_hold < HOLD_EXIT) {
                paused ^= 1;
                snd.on = paused ? 0 : sound_on;   /* 一時停止中は音も止める */
            }
            fire_hold = 0;
        }

        /* 再生中の下ボタン: 音の ON / OFF */
        if (!paused && (down & BTN_DOWN) && music) {
            sound_on ^= 1;
            snd.on = sound_on;
        }

        if ((down & BTN_RIGHT) && delay > DELAY_MIN) delay--;
        if ((down & BTN_LEFT)  && delay < DELAY_MAX) delay++;
        if (down & BTN_UP) { invert ^= 0xFFFFFFFFu; redraw = 1; }

        if (count > 0) {
            if (paused) {
                if (down & BTN_DOWN) {
                    if (++frame >= count) frame = 0;  /* ARMv4Tは割り算命令なし */
                    redraw = 1;
                }
            } else if (++wait >= delay) {
                wait = 0;
                if (++frame >= count) frame = 0;  /* ARMv4Tは割り算命令なし */
                redraw = 1;
            }
        }

        if (redraw) {
            if (count > 0) lcd_draw(frames + frame * 32, invert);
            else           lcd_draw_test(invert);
            redraw = 0;
        }
    }
}
