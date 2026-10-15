/*
 * app.h - main.c と chara.c で共有するもの
 */
#ifndef APP_H
#define APP_H
#include "poc.h"

/* crt0.S の .pocinfo。フラッシュ上なので必ず 32bit で読む */
extern const u32 anim_info[8];
#define INFO_FRAMES  2
#define INFO_COUNT   3
#define INFO_DELAY   4
#define INFO_MUSIC   5   /* 曲データ (PMUS) のアドレス, 0=曲なし */
#define INFO_CHARA   6   /* キャラクターモードの設定 (PCHR) のアドレス, 0=アニメ再生 */

#define TICK_HZ      30

void timer_init(void);
void wait_tick(void);
void lcd_update_mode(void);
void lcd_draw(const u32 *frame, u32 invert);
int  chara_main(const u32 *cfg);

#endif
