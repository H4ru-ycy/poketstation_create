/*
 * sound.h - 4音の矩形波サウンドエンジン
 *
 * タイマ2 (FIQ) を 1秒に 7808 回鳴らし、そのたびに 4 つの矩形波を足して
 * DAC (符号付き10bit) に書き込む。曲は 16分音符などの「ステップ」の並びで、
 * 1ステップに 4音ぶんの 32bit ワードを持つ (tools/mkpoc.py の PMUS 形式)。
 *
 * ステップのワード:
 *   0x00000000  休符 (音を止める)
 *   0xFFFFFFFF  前の音をのばす
 *   それ以外    bit0-15  位相の増分 (周波数 × 65536 / 7808)
 *               bit16-23 デューティ (32=12.5%, 64=25%, 128=50%)
 *               bit24-31 音量 (0-127。4音の合計が ±511 を超えないこと)
 */
#ifndef SOUND_H
#define SOUND_H

#include "poc.h"

#define SND_RATE      7808u   /* 3997696Hz / 32 / 16 */
#define SND_VOICES    4
#define SND_HOLD      0xFFFFFFFFu

/* sound.S と同じ並び。順番を変えたら sound.S のオフセットも直すこと */
struct snd_state {
    u32 on;         /* 00 1=鳴らす */
    u32 shift;      /* 04 音量を右シフトで下げる (時計画面の音量設定) */
    u32 ptr;        /* 08 次に読むステップ */
    u32 left;       /* 0C 今のステップの残りサンプル数 */
    u32 gate;       /* 10 音を切るまでの残りサンプル数 (0=済) */
    u32 remain;     /* 14 ループまでの残りステップ数 */
    u32 start;      /* 18 先頭ステップのアドレス */
    u32 count;      /* 1C ステップ数 */
    u32 steplen;    /* 20 1ステップのサンプル数 (テンポ) */
    u32 gatelen;    /* 24 ステップ先頭から音を切るまでのサンプル数 */
    u32 voice[SND_VOICES];  /* 28 今鳴っている音のワード */
    u32 phase[SND_VOICES];  /* 38 位相 (上位8bitが波形の位置) */
    u32 loop;       /* 48 1=最後まで来たら先頭に戻る, 0=1回だけ鳴らして on を 0 にする */
};

extern struct snd_state snd;

/* 曲データ (PMUS) が正しければ準備して 1 (消音設定なら 2)、無ければ 0。loop は 1 になる */
int  snd_init(const u32 *music);
void snd_start(void);   /* タイマ2・FIQ・DAC を有効にする */
void snd_stop(void);    /* すべて止める (GUI に戻る前に必ず呼ぶ) */
void snd_fiq(void);     /* sound.S: FIQ コールバック */

#endif
