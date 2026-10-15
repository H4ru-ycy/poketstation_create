/*
 * sound.c - サウンドエンジンの準備と開始・停止 (ユーザーモードで動く部分)
 * 1サンプルごとの処理は sound.S の snd_fiq。
 */
#include "sound.h"

struct snd_state snd;

_Static_assert(__builtin_offsetof(struct snd_state, voice) == 0x28, "sound.S と並びを合わせる");
_Static_assert(__builtin_offsetof(struct snd_state, phase) == 0x38, "sound.S と並びを合わせる");
_Static_assert(__builtin_offsetof(struct snd_state, loop) == 0x48, "sound.S と並びを合わせる");

/* PMUS ヘッダ (32バイト) */
#define PMUS_MAGIC    0x53554D50u   /* "PMUS" */
#define PMUS_STEPS    2
#define PMUS_STEPLEN  3
#define PMUS_GATELEN  4
#define PMUS_HEADER_WORDS 8

int snd_init(const u32 *music)
{
    snd.on = 0;
    if (!music || music[0] != PMUS_MAGIC)
        return 0;
    u32 steps = music[PMUS_STEPS];
    u32 steplen = music[PMUS_STEPLEN];
    if (steps == 0 || steplen < 2)
        return 0;

    snd.start   = (u32)(music + PMUS_HEADER_WORDS);
    snd.count   = steps;
    snd.steplen = steplen;
    snd.gatelen = music[PMUS_GATELEN];
    snd.ptr     = snd.start;
    snd.remain  = steps;
    snd.left    = 1;        /* 最初のサンプルでステップ0を読む */
    snd.gate    = 0;
    snd.loop    = 1;
    for (int i = 0; i < SND_VOICES; i++) {
        snd.voice[i] = 0;
        snd.phase[i] = 0;
    }

    /* 時計画面の音量設定に従う: 0=普通, 1=小 (1/4), 2=消音 */
    u32 vol = (swi_get_alarm_setting()[0] >> 18) & 3;
    snd.shift = (vol == 1) ? 2 : 0;
    return vol == 2 ? 2 : 1;   /* 2 = 消音設定なので最初は鳴らさない */
}

void snd_start(void)
{
    DAC_DATA = 0;
    swi_set_callback(2, snd_fiq);       /* FIQ コールバック */
    T2_MODE   = 0;                      /* 停止中に RELOAD を書く */
    T2_RELOAD = 15;                     /* 3997696/32 = 124928Hz, 16カウントで 7808Hz */
    T2_MODE   = TMODE_DIV32 | TMODE_ENABLE;
    INT_ACK      = INT_TIMER2;
    INT_MASK_SET = INT_TIMER2;
    DAC_CTRL  = 1;
    IOP_START = IOP_SOUND;
}

void snd_stop(void)
{
    snd.on = 0;
    INT_MASK_CLR = INT_TIMER2;
    T2_MODE   = 0;
    DAC_DATA  = 0;
    DAC_CTRL  = 0;
    IOP_STOP  = IOP_SOUND;
    swi_set_callback(2, 0);
}
