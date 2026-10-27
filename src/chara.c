/*
 * chara.c - キャラクターモード
 *
 *   待機      : キャラクターの顔。ボタンを押すと表情が変わり、しばらくすると戻る
 *   2回押し   : 決めたボタンを素早く2回押すと、日付と時計を表示
 *   長押し    : 決めたボタンを長押しすると、基準日 (公開日など) からの日数を表示
 *   コマンド  : 決めた順にボタンを押すと、曲を最後まで1回鳴らして待機に戻る
 *   時計の表示中に決定を長押し : 日付と時刻を合わせる (上下で変える、左右で項目、決定で決める)
 *   3秒押し続ける (どのボタンでも) : 時計画面 (GUI) に戻る
 *
 * 設定は変換ツールが書き出す PCHR ブロック (32bitワードの並び。tools/mkpoc.py を参照)。
 * フレーム (表情や背景の絵) はアニメ再生と同じ 1コマ32ワード。
 */
#include "poc.h"
#include "sound.h"
#include "app.h"
#include "font.h"

#define NONE 0xFFFFFFFFu

/* PCHR ブロックのワード位置 */
enum {
    C_MAGIC = 0, C_VERSION, C_IDLE, C_BLINK,
    C_FACE = 4,              /* 4..8: ボタン bit0..4 (決定,右,左,下,上) を押したときの表情 */
    C_FACE_HOLD = 9,         /* 表情を戻すまで (tick) */
    C_CLOCK_BG, C_DAYS_BG,   /* 時計・日数の背景のコマ (NONE = 白) */
    C_SING_A, C_SING_B,      /* 曲の間の表情 (B があれば 4分音符ごとに交互) */
    C_DBL_BTN, C_LONG_BTN,   /* 2回押し・長押しに使うボタン (bit, 0=使わない) */
    C_CMD_LEN,               /* コマンドの長さ (0-8) */
    C_CMD = 17,              /* 17..24: コマンドのボタン */
    C_BASE_DAY = 25,         /* 基準日 (2000年1月1日からの日数) */
    C_DAY_OFFSET,            /* 基準日当日を何日とするか (0 か 1) */
    C_SHOW,                  /* 時計・日数を出しておく時間 (tick) */
    C_DBL_WIN,               /* 2回押しとみなす間隔 (tick) */
    C_LONG,                  /* 長押しとみなす時間 (tick) */
    C_CMD_GAP,               /* コマンドのボタンとボタンの間の最大の間隔 (tick) */
    C_DAYS_Y,                /* 日数の数字を描く高さ (上の行) */
    C_EXIT,                  /* 終了する長押しの時間 (tick) */
    C_RESERVED,
    /* ここから version 2 */
    C_SING_MODE = 34,        /* 曲の間の表示: 0 = 表情 A/B を4分音符ごとに交互, 1 = アニメーション */
    C_SING_FIRST,            /* アニメーションの最初のコマ */
    C_SING_COUNT,            /* アニメーションのコマ数 */
    C_SING_DELAY,            /* 1コマの時間 (tick)。C_SING_SYNC = 0 のとき */
    C_SING_SYNC,             /* 0 = 時間で進める, 1-4 = 曲に合わせる (16分・8分・4分・2分音符ごと) */
    /* ここから version 3 */
    C_IDLE_CLOCK = 40,       /* 1 = 待機は日付と時計 (顔の代わりに) */
    C_IDLE_OFF,              /* 待機の表示を消すまで (tick, 0 = 消さない)。消えたら決定で戻る */
    C_WORDS = 44
};
#define PCHR_MAGIC 0x52484350u   /* "PCHR" */

enum { M_IDLE, M_CLOCK, M_DAYS, M_SING, M_SET };

/* 小さい文字の番号 (font.h の SMALL_CHARS の並び) */
enum { S_A = 10, S_D, S_E, S_F, S_H, S_I, S_M, S_N, S_O, S_R, S_S, S_T, S_U, S_W, S_SLASH, S_COLON, S_MINUS, S_SPACE };
#define WD(a, b, c) ((a) | ((b) << 8) | ((c) << 16))
static const u32 weekday_name[7] = {
    WD(S_S, S_U, S_N), WD(S_M, S_O, S_N), WD(S_T, S_U, S_E), WD(S_W, S_E, S_D),
    WD(S_T, S_H, S_U), WD(S_F, S_R, S_I), WD(S_S, S_A, S_T),
};
static const u32 month_days[12] = { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 };

static const u32 *cfg, *frames;
static u32 count;
static u32 fb[32];

/* ---------------- 描画 ---------------- */
static void fb_frame(u32 idx)
{
    for (u32 y = 0; y < 32; y++)
        fb[y] = (idx < count) ? frames[idx * 32 + y] : 0;
}

static void fb_clear_rect(int x, int y, int w, int h)
{
    if (x < 0) { w += x; x = 0; }
    if (x + w > 32) w = 32 - x;
    if (w <= 0) return;
    u32 m = (w >= 32 ? 0xFFFFFFFFu : ((1u << w) - 1)) << x;
    for (int r = y; r < y + h; r++)
        if (r >= 0 && r < 32) fb[r] &= ~m;
}

static void put_small(int x, int y, u32 ch)
{
    u32 w = font_small[ch];
    for (int r = 0; r < 5; r++)
        if (y + r >= 0 && y + r < 32 && x >= 0 && x <= 29)
            fb[y + r] |= ((w >> (3 * r)) & 7u) << x;
}

static void put_big(int x, int y, u32 ch)
{
    u32 w0 = font_big[ch * 2], w1 = font_big[ch * 2 + 1];
    for (int r = 0; r < 10; r++) {
        u32 bits = (r < 5 ? (w0 >> (6 * r)) : (w1 >> (6 * (r - 5)))) & 63u;
        if (y + r >= 0 && y + r < 32 && x >= 0 && x <= 26)
            fb[y + r] |= bits << x;
    }
}

static u32 bcd(u32 b) { return (b >> 4) * 10 + (b & 15); }

/* 10進の桁に分ける (割り算命令が無いので引き算で)。戻り値 = 桁数 */
static u32 to_digits(u32 v, u32 *d)
{
    static const u32 pw[5] = { 10000, 1000, 100, 10, 1 };
    u32 n = 0;
    if (v > 99999) v = 99999;
    for (u32 i = 0; i < 5; i++) {
        u32 k = 0;
        while (v >= pw[i]) { v -= pw[i]; k++; }
        if (k || n || i == 4) d[n++] = k;
    }
    return n;
}

/* 2000年1月1日を 0 とした日数 (2000-2099年) */
static u32 day_number(u32 y, u32 m, u32 d)
{
    u32 n = 0;
    for (u32 yy = 2000; yy < y; yy++) n += (yy & 3) ? 365 : 366;
    n += month_days[m - 1] + d - 1;
    if (m > 2 && (y & 3) == 0) n++;
    return n;
}

static void draw_clock_at(u32 date, u32 time)
{
    fb_frame(cfg[C_CLOCK_BG]);
    /* 1行目: 月/日 (まん中) */
    u32 mon = (date >> 8) & 0xFF, day = date & 0xFF;
    fb_clear_rect(0, 0, 32, 7);
    put_small(7, 1, mon >> 4);  put_small(11, 1, mon & 15);
    put_small(15, 1, S_SLASH);
    put_small(19, 1, day >> 4); put_small(23, 1, day & 15);
    /* まん中: 時:分 (大きい数字)。コロンは1秒ごとに点滅 */
    u32 hh = (time >> 16) & 0xFF, mm = (time >> 8) & 0xFF, ss = time & 0xFF;
    fb_clear_rect(0, 8, 32, 12);
    put_big(1, 9, hh >> 4);  put_big(8, 9, hh & 15);
    put_big(18, 9, mm >> 4); put_big(25, 9, mm & 15);
    if ((ss & 1) == 0) {
        fb[11] |= 3u << 15; fb[12] |= 3u << 15;
        fb[15] |= 3u << 15; fb[16] |= 3u << 15;
    }
    /* 下: 年 と 曜日、秒の進み具合 */
    u32 cen = (date >> 24) & 0xFF, yr = (date >> 16) & 0xFF;
    fb_clear_rect(0, 21, 32, 11);
    put_small(1, 22, cen >> 4); put_small(5, 22, cen & 15);
    put_small(9, 22, yr >> 4);  put_small(13, 22, yr & 15);
    u32 wd = (time >> 24) & 0xFF;
    if (wd >= 1 && wd <= 7) {
        u32 nm = weekday_name[wd - 1];
        put_small(21, 22, nm & 0xFF); put_small(25, 22, (nm >> 8) & 0xFF); put_small(29, 22, (nm >> 16) & 0xFF);
    }
    u32 sec = bcd(ss), len = (sec + 2) >> 1;            /* 1-30 ドット */
    if (len > 30) len = 30;
    fb[29] |= ((1u << len) - 1) << 1;
    fb[30] |= 0x15555554u & ~(((1u << len) - 1) << 1);  /* 残りは点線 */
}

static void draw_clock(void) { draw_clock_at(swi_get_bcd_date(), swi_get_bcd_time()); }

/* ---------------- 時刻合わせ ---------------- */
static u32 to_bcd(u32 v) { u32 t = 0; while (v >= 10) { v -= 10; t++; } return (t << 4) | v; }
static u32 month_len(u32 y, u32 m)
{
    static const u32 len[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    return len[m - 1] + (m == 2 && (y & 3) == 0);
}
static u32 day_number(u32 y, u32 m, u32 d);
/* 曜日 (1=日曜 … 7=土曜)。2000年1月1日は土曜 */
static u32 weekday_of(u32 y, u32 m, u32 d)
{
    u32 n = day_number(y, m, d) + 6;
    while (n >= 7 * 64) n -= 7 * 64;
    while (n >= 7) n -= 7;
    return n + 1;
}
/* 項目: 0=年 1=月 2=日 3=時 4=分。点滅させる場所 */
static const u32 set_rect[5] = {
    1 | (22 << 8) | (15 << 16) | (5u << 24), 7 | (1 << 8) | (7 << 16) | (5u << 24), 19 | (1 << 8) | (7 << 16) | (5u << 24),
    1 | (9 << 8) | (13 << 16) | (10u << 24), 18 | (9 << 8) | (13 << 16) | (10u << 24),
};
static u32 ed[5], ed_f;
static void set_load(void)
{
    u32 date = swi_get_bcd_date(), time = swi_get_bcd_time();
    u32 y = bcd((date >> 24) & 0xFF) * 100 + bcd((date >> 16) & 0xFF);
    ed[0] = (y >= 2000 && y <= 2099) ? y - 2000 : 26;
    ed[1] = bcd((date >> 8) & 0xFF); ed[2] = bcd(date & 0xFF);
    if (ed[1] < 1 || ed[1] > 12) ed[1] = 1;
    if (ed[2] < 1 || ed[2] > 31) ed[2] = 1;
    ed[3] = bcd((time >> 16) & 0xFF); ed[4] = bcd((time >> 8) & 0xFF);
    if (ed[3] > 23) ed[3] = 0;
    if (ed[4] > 59) ed[4] = 0;
    ed_f = 0;
}
static void set_step(int dir)
{
    static const u32 lo[5] = { 0, 1, 1, 0, 0 }, hi[5] = { 99, 12, 31, 23, 59 };
    u32 h = ed_f == 2 ? month_len(2000 + ed[0], ed[1]) : hi[ed_f];
    if (dir > 0) ed[ed_f] = ed[ed_f] >= h ? lo[ed_f] : ed[ed_f] + 1;
    else         ed[ed_f] = ed[ed_f] <= lo[ed_f] ? h : ed[ed_f] - 1;
    u32 ml = month_len(2000 + ed[0], ed[1]);
    if (ed[2] > ml) ed[2] = ml;
}
static u32 set_date(void) { return (0x20u << 24) | (to_bcd(ed[0]) << 16) | (to_bcd(ed[1]) << 8) | to_bcd(ed[2]); }
static u32 set_time(void) { return (weekday_of(2000 + ed[0], ed[1], ed[2]) << 24) | (to_bcd(ed[3]) << 16) | (to_bcd(ed[4]) << 8); }
static void draw_set(u32 now)
{
    draw_clock_at(set_date(), set_time() | 1);   /* 秒は1 (コロンは消える) */
    fb[11] |= 3u << 15; fb[12] |= 3u << 15; fb[15] |= 3u << 15; fb[16] |= 3u << 15;
    fb[29] = 0; fb[30] = 0;
    if ((now >> 3) & 1) {                          /* 選んでいる項目を点滅 */
        u32 r = set_rect[ed_f];
        fb_clear_rect(r & 0xFF, (r >> 8) & 0xFF, (r >> 16) & 0xFF, r >> 24);
    }
    /* 曜日の所に「SET」 (曜日は決めたときに計算して入れる) */
    fb_clear_rect(20, 21, 12, 7);
    put_small(21, 22, S_S); put_small(25, 22, S_E); put_small(29, 22, S_T);
}

static void draw_days(void)
{
    u32 date = swi_get_bcd_date();
    u32 y = bcd((date >> 24) & 0xFF) * 100 + bcd((date >> 16) & 0xFF);
    u32 m = bcd((date >> 8) & 0xFF), d = bcd(date & 0xFF);
    fb_frame(cfg[C_DAYS_BG]);
    int ny = (int)cfg[C_DAYS_Y];
    u32 dig[5], n;
    if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) {
        dig[0] = dig[1] = BIG_MINUS; n = 2;              /* 時計が合っていない: "--" */
    } else {
        int v = (int)day_number(y, m, d) - (int)cfg[C_BASE_DAY] + (int)cfg[C_DAY_OFFSET];
        n = to_digits(v < 0 ? 0 : (u32)v, dig);
    }
    if (n <= 4) {
        int w = (int)n * 7 - 1, x = (32 - w) / 2;
        fb_clear_rect(x - 1, ny - 1, w + 2, BIG_H + 2);
        for (u32 i = 0; i < n; i++) put_big(x + (int)i * 7, ny, dig[i]);
    } else {
        int w = (int)n * 4 - 1, x = (32 - w) / 2;
        fb_clear_rect(x - 1, ny + 1, w + 2, 7);
        for (u32 i = 0; i < n; i++) put_small(x + (int)i * 4, ny + 2, dig[i]);
    }
}

static void fb_show(void)
{
    volatile u32 *vram = LCD_VRAM;
    for (u32 y = 0; y < 32; y++) vram[y] = fb[y];
}

/* ---------------- ボタンの記録 ---------------- */
#define HIST 8
static u32 hist_btn[HIST], hist_t[HIST], hist_n;

static void hist_push(u32 b, u32 t)
{
    if (hist_n == HIST) {
        for (u32 i = 1; i < HIST; i++) { hist_btn[i - 1] = hist_btn[i]; hist_t[i - 1] = hist_t[i]; }
        hist_n--;
    }
    hist_btn[hist_n] = b; hist_t[hist_n] = t; hist_n++;
}

/* 最後に押した k 個が、コマンドの先頭 k 個と同じ (間隔も守っている) か */
static int hist_matches(u32 k)
{
    if (k == 0 || k > hist_n) return 0;
    u32 base = hist_n - k;
    for (u32 i = 0; i < k; i++) {
        if (hist_btn[base + i] != cfg[C_CMD + i]) return 0;
        if (i && hist_t[base + i] - hist_t[base + i - 1] > cfg[C_CMD_GAP]) return 0;
    }
    return 1;
}

static int cmd_in_progress(void)
{
    for (u32 k = cfg[C_CMD_LEN] - 1; k >= 1 && k < 8; k--)
        if (hist_matches(k)) return 1;
    return 0;
}

/* ---------------- 本体 ---------------- */
int chara_main(const u32 *c)
{
    cfg = c;
    frames = (const u32 *)anim_info[INFO_FRAMES];
    count = anim_info[INFO_COUNT];
    if (cfg[C_MAGIC] != PCHR_MAGIC) return 0;
    const u32 *music = (const u32 *)anim_info[INFO_MUSIC];
    u32 cmd_len = cfg[C_CMD_LEN] > 8 ? 8 : cfg[C_CMD_LEN];

    timer_init();
    DAC_CTRL = 0;
    IOP_STOP = IOP_SOUND;

    u32 now = 0, mode = M_IDLE, mode_t = 0;
    u32 face = cfg[C_IDLE], face_t = 0;
    u32 blink_t = 0, blink_next = 100, blink_on = 0;
    u32 prev = 0, hold = 0, long_t = 0, long_done = 0;
    u32 pending = 0, singing_sound = 0;
    u32 anim_idx = 0, anim_wait = 0, anim_k = 0, sing_t0 = 0;
    u32 clock_fire = 0, set_wait = 0, set_idle = 0, rep = 0;
    u32 idle_clock = cfg[C_VERSION] >= 3 && cfg[C_IDLE_CLOCK];
    u32 idle_off = cfg[C_VERSION] >= 3 ? cfg[C_IDLE_OFF] : 0, idle_t = 0, asleep = 0;

    for (;;) {
        wait_tick();
        now++;
        lcd_update_mode();

        u32 btn = INT_INPUT & BTN_MASK;
        u32 down = btn & ~prev;

        /* どのボタンでも押し続けると終了 */
        hold = (btn && btn == prev) ? hold + 1 : (btn ? 1 : 0);
        prev = btn;
        if (mode == M_SET) hold = 0;                  /* 時刻合わせの間は終了しない */
        if (hold >= cfg[C_EXIT]) {
            if (singing_sound) snd_stop();
            LCD_MODE = 0;
            return 0;
        }

        /* 待機の表示が消えているとき: 決定で戻る。ほかのボタンは何もしない */
        if (mode != M_IDLE) { idle_t = 0; asleep = 0; }
        else if (asleep) {
            if (down & BTN_FIRE) { asleep = 0; idle_t = 0; long_done = 1; hist_n = 0; }
            down = 0;
        } else if (btn) idle_t = 0;
        else if (idle_off && ++idle_t >= idle_off) { asleep = 1; face = cfg[C_IDLE]; face_t = 0; pending = 0; hist_n = 0; }

        /* 長押し → 日数 */
        if (cfg[C_LONG_BTN] && (btn & cfg[C_LONG_BTN])) {
            if (++long_t >= cfg[C_LONG] && !long_done) {
                long_done = 1;
                if (mode == M_IDLE && !asleep) { mode = M_DAYS; mode_t = cfg[C_SHOW]; pending = 0; hist_n = 0; }
            }
        } else { long_t = 0; long_done = 0; }

        /* 時刻合わせ */
        if (mode == M_SET) {
            if (set_wait) { if (!btn) set_wait = 0; down = 0; }   /* 入ったときの決定を離すまで待つ */
            if (down) set_idle = 0;
            if (++set_idle >= TICK_HZ * 30) mode = M_IDLE;    /* 30秒さわらなければやめる */
            if (down & BTN_UP) set_step(1);
            if (down & BTN_DOWN) set_step(-1);
            if (down & BTN_LEFT) ed_f = ed_f ? ed_f - 1 : 4;
            if (down & BTN_RIGHT) ed_f = ed_f == 4 ? 0 : ed_f + 1;
            if (btn & (BTN_UP | BTN_DOWN)) {                  /* 押し続けると連続で変わる */
                if (++rep >= 12 && ((rep - 12) & 3) == 3) set_step((btn & BTN_UP) ? 1 : -1);
            } else rep = 0;
            if (down & BTN_FIRE) {
                swi_set_bcd_datetime(set_date(), set_time());
                mode = M_CLOCK; mode_t = cfg[C_SHOW]; clock_fire = 0; long_done = 1;
            }
            down = 0;
        }
        /* 時計の表示中に決定を長押し → 時刻合わせ */
        if (mode == M_CLOCK && clock_fire) {
            if (btn & BTN_FIRE) {
                if (++clock_fire > cfg[C_LONG]) { mode = M_SET; set_load(); set_wait = 1; set_idle = 0; rep = 0; clock_fire = 0; hold = 0; }
            } else { clock_fire = 0; mode = M_IDLE; long_done = 1; hist_n = 0; }   /* 短く押した → 待機へ */
        }

        for (u32 b = 1; b <= BTN_UP; b <<= 1) {
            if (!(down & b)) continue;
            if (mode == M_SING) {
                if (b == BTN_FIRE) {                   /* 決定で曲を止める */
                    if (singing_sound) snd_stop();
                    singing_sound = 0; mode = M_IDLE; face = cfg[C_IDLE];
                }
                continue;
            }
            if (mode == M_CLOCK && b == BTN_FIRE) { clock_fire = 1; continue; }   /* 長押しか見る */
            if (mode == M_CLOCK || mode == M_DAYS) {   /* どれか押すと待機に戻る */
                mode = M_IDLE; long_done = 1; hist_n = 0; clock_fire = 0;
                continue;
            }
            hist_push(b, now);
            if (cmd_len && hist_matches(cmd_len)) {    /* コマンド → 曲 */
                hist_n = 0; pending = 0;
                mode = M_SING; mode_t = cfg[C_SHOW];
                anim_idx = 0; anim_wait = 0; anim_k = 0; sing_t0 = now;
                int r = snd_init(music);
                if (r) {
                    int muted = (r == 2);
                    snd.loop = 0;
                    snd_start();
                    if (muted) { DAC_CTRL = 0; IOP_STOP = IOP_SOUND; }   /* 消音設定: 音は出さずに進める */
                    snd.on = 1;
                    singing_sound = 1;
                }
                continue;
            }
            u32 f = cfg[C_FACE + (b == 1 ? 0 : b == 2 ? 1 : b == 4 ? 2 : b == 8 ? 3 : 4)];
            if (f < count) { face = f; face_t = cfg[C_FACE_HOLD]; }
            if (pending) pending = 0;                   /* 2回押しのあとに続けて押した = コマンドの途中 */
            else if (b == cfg[C_DBL_BTN] && hist_n >= 2 && hist_btn[hist_n - 2] == b &&
                     now - hist_t[hist_n - 2] <= cfg[C_DBL_WIN]) {
                if (cmd_len && cmd_in_progress()) pending = now + cfg[C_DBL_WIN];
                else { mode = M_CLOCK; mode_t = cfg[C_SHOW]; hist_n = 0; }
            }
        }
        if (pending && now >= pending) {
            pending = 0; hist_n = 0;
            if (mode == M_IDLE) { mode = M_CLOCK; mode_t = cfg[C_SHOW]; }
        }

        /* 表示 */
        switch (mode) {
        case M_CLOCK:
        case M_DAYS:
            if (mode == M_CLOCK) draw_clock(); else draw_days();
            if (!clock_fire && --mode_t == 0) mode = M_IDLE;
            break;
        case M_SET:
            draw_set(now);
            break;
        case M_SING: {
            u32 first = cfg[C_SING_FIRST], n = cfg[C_SING_COUNT];
            if (cfg[C_VERSION] >= 2 && cfg[C_SING_MODE] == 1 && n && first < count) {
                /* アニメーション: first から n コマをくり返す */
                if (first + n > count) n = count - first;
                u32 sync = cfg[C_SING_SYNC];
                if (sync) {                                  /* 曲 (ステップ) に合わせて進める */
                    u32 k = singing_sound ? ((snd.count - snd.remain) >> (sync - 1)) : ((now - sing_t0) >> 3);
                    while (anim_k < k) { anim_k++; if (++anim_idx >= n) anim_idx = 0; }
                } else if (anim_wait++ >= cfg[C_SING_DELAY] && cfg[C_SING_DELAY]) {
                    anim_wait = 1;
                    if (++anim_idx >= n) anim_idx = 0;
                }
                fb_frame(first + anim_idx);
            } else {
                u32 fa = cfg[C_SING_A] < count ? cfg[C_SING_A] : cfg[C_IDLE];
                u32 fbb = cfg[C_SING_B] < count ? cfg[C_SING_B] : fa;
                u32 beat = singing_sound ? ((snd.count - snd.remain) >> 2) : (now >> 4);
                fb_frame((beat & 1) ? fbb : fa);
            }
            if (singing_sound ? (snd.on == 0) : (--mode_t == 0)) {   /* 曲が最後まで鳴った */
                if (singing_sound) snd_stop();
                singing_sound = 0; mode = M_IDLE; face = cfg[C_IDLE]; face_t = 0;
            }
            break;
        }
        default:
            if (face_t && --face_t == 0) face = cfg[C_IDLE];
            if (asleep) { for (u32 y = 0; y < 32; y++) fb[y] = 0; break; }   /* 表示を消している */
            if (idle_clock && !face_t) { draw_clock(); break; }          /* 待機は日付と時計 */
            /* まばたき: 待機の顔のときだけ、ときどき */
            if (face == cfg[C_IDLE] && cfg[C_BLINK] < count) {
                if (blink_on) { if (--blink_on == 0) blink_t = 0; }
                else if (++blink_t >= blink_next) { blink_on = 4; blink_next = blink_next == 100 ? 160 : 100; }
            } else { blink_on = 0; blink_t = 0; }
            fb_frame(blink_on ? cfg[C_BLINK] : face);
            break;
        }
        fb_show();
    }
}
