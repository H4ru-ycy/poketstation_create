/* ============================================================
 * chara.js - キャラクターモードの動き (src/chara.c と同じ手順)
 *   変換ツールのプレビューと、tests/test_chara.py の照合に使う。
 *   CharaEngine(cfg, frames, song) → { tick(buttons, rtc) }
 *     cfg    : PCHR ブロックのワード配列 (34個)
 *     frames : [Uint32Array(32), ...] (bit0=左, 1=黒)
 *     song   : { count, steplen } (曲が無ければ null)
 *     rtc    : { date, time } = SWI 0Dh / 0Eh と同じ BCD の値
 *   tick() は 1/30 秒ごとに呼ぶ。戻り値 { fb, exit, event, singStart }
 *     event: "sing" (曲を鳴らし始める) / "stop" (曲を止める) / null
 * ============================================================ */
const PCHR = {
  MAGIC: 0, VERSION: 1, IDLE: 2, BLINK: 3, FACE: 4, FACE_HOLD: 9, CLOCK_BG: 10, DAYS_BG: 11,
  SING_A: 12, SING_B: 13, DBL_BTN: 14, LONG_BTN: 15, CMD_LEN: 16, CMD: 17, BASE_DAY: 25,
  DAY_OFFSET: 26, SHOW: 27, DBL_WIN: 28, LONG: 29, CMD_GAP: 30, DAYS_Y: 31, EXIT: 32,
  SING_MODE: 34, SING_FIRST: 35, SING_COUNT: 36, SING_DELAY: 37, SING_SYNC: 38, WORDS: 40,
};
const CHARA_NONE = 0xFFFFFFFF;
const CHARA_BTN = { fire: 1, right: 2, left: 4, down: 8, up: 16 };
const SAMPLES_PER_TICK = 260;   /* 7808Hz ÷ 30Hz (タイマ0 の 260 カウント) */

function CharaEngine(cfg, frames, song) {
  const count = frames.length;
  const fb = new Uint32Array(32);
  const S = { A: 10, D: 11, E: 12, F: 13, H: 14, I: 15, M: 16, N: 17, O: 18, R: 19, S: 20, T: 21, U: 22, W: 23, SLASH: 24, COLON: 25, MINUS: 26 };
  const WEEK = [[S.S, S.U, S.N], [S.M, S.O, S.N], [S.T, S.U, S.E], [S.W, S.E, S.D], [S.T, S.H, S.U], [S.F, S.R, S.I], [S.S, S.A, S.T]];
  const MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const BIG_MINUS = 10, BIG_H = 10;

  const fbFrame = (idx) => { for (let y = 0; y < 32; y++) fb[y] = idx < count ? frames[idx][y] : 0; };
  function clearRect(x, y, w, h) {
    if (x < 0) { w += x; x = 0; }
    if (x + w > 32) w = 32 - x;
    if (w <= 0) return;
    const m = ((w >= 32 ? 0xFFFFFFFF : ((1 << w) >>> 0) - 1) << x) >>> 0;
    for (let r = y; r < y + h; r++) if (r >= 0 && r < 32) fb[r] = (fb[r] & ~m) >>> 0;
  }
  function putSmall(x, y, ch) {
    const w = FONT_SMALL[ch];
    for (let r = 0; r < 5; r++) if (y + r >= 0 && y + r < 32 && x >= 0 && x <= 29) fb[y + r] = (fb[y + r] | (((w >> (3 * r)) & 7) << x)) >>> 0;
  }
  function putBig(x, y, ch) {
    const w0 = FONT_BIG[ch * 2], w1 = FONT_BIG[ch * 2 + 1];
    for (let r = 0; r < 10; r++) {
      const bits = (r < 5 ? (w0 >>> (6 * r)) : (w1 >>> (6 * (r - 5)))) & 63;
      if (y + r >= 0 && y + r < 32 && x >= 0 && x <= 26) fb[y + r] = (fb[y + r] | (bits << x)) >>> 0;
    }
  }
  const bcd = (b) => (b >> 4) * 10 + (b & 15);
  function toDigits(v) {
    if (v > 99999) v = 99999;
    const d = [];
    for (const p of [10000, 1000, 100, 10, 1]) { let k = 0; while (v >= p) { v -= p; k++; } if (k || d.length || p === 1) d.push(k); }
    return d;
  }
  function dayNumber(y, m, d) {
    let n = 0;
    for (let yy = 2000; yy < y; yy++) n += (yy & 3) ? 365 : 366;
    n += MONTH[m - 1] + d - 1;
    if (m > 2 && (y & 3) === 0) n++;
    return n;
  }
  function drawClock(rtc) {
    const date = rtc.date >>> 0, time = rtc.time >>> 0;
    fbFrame(cfg[PCHR.CLOCK_BG]);
    const mon = (date >>> 8) & 0xFF, day = date & 0xFF;
    clearRect(0, 0, 32, 7);
    putSmall(7, 1, mon >> 4); putSmall(11, 1, mon & 15); putSmall(15, 1, S.SLASH); putSmall(19, 1, day >> 4); putSmall(23, 1, day & 15);
    const hh = (time >>> 16) & 0xFF, mm = (time >>> 8) & 0xFF, ss = time & 0xFF;
    clearRect(0, 8, 32, 12);
    putBig(1, 9, hh >> 4); putBig(8, 9, hh & 15); putBig(18, 9, mm >> 4); putBig(25, 9, mm & 15);
    if ((ss & 1) === 0) for (const r of [11, 12, 15, 16]) fb[r] = (fb[r] | (3 << 15)) >>> 0;
    const cen = (date >>> 24) & 0xFF, yr = (date >>> 16) & 0xFF;
    clearRect(0, 21, 32, 11);
    putSmall(1, 22, cen >> 4); putSmall(5, 22, cen & 15); putSmall(9, 22, yr >> 4); putSmall(13, 22, yr & 15);
    const wd = (time >>> 24) & 0xFF;
    if (wd >= 1 && wd <= 7) { const nm = WEEK[wd - 1]; putSmall(21, 22, nm[0]); putSmall(25, 22, nm[1]); putSmall(29, 22, nm[2]); }
    let len = (bcd(ss) + 2) >> 1; if (len > 30) len = 30;
    const bar = ((((1 << len) >>> 0) - 1) << 1) >>> 0;
    fb[29] = (fb[29] | bar) >>> 0;
    fb[30] = (fb[30] | (0x15555554 & ~bar)) >>> 0;
  }
  function drawDays(rtc) {
    const date = rtc.date >>> 0;
    const y = bcd((date >>> 24) & 0xFF) * 100 + bcd((date >>> 16) & 0xFF), m = bcd((date >>> 8) & 0xFF), d = bcd(date & 0xFF);
    fbFrame(cfg[PCHR.DAYS_BG]);
    const ny = cfg[PCHR.DAYS_Y] | 0;
    let dig;
    if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) dig = [BIG_MINUS, BIG_MINUS];
    else { const v = dayNumber(y, m, d) - cfg[PCHR.BASE_DAY] + cfg[PCHR.DAY_OFFSET]; dig = toDigits(v < 0 ? 0 : v); }
    const n = dig.length;
    if (n <= 4) {
      const w = n * 7 - 1, x = Math.trunc((32 - w) / 2);
      clearRect(x - 1, ny - 1, w + 2, BIG_H + 2);
      dig.forEach((v, i) => putBig(x + i * 7, ny, v));
    } else {
      const w = n * 4 - 1, x = Math.trunc((32 - w) / 2);
      clearRect(x - 1, ny + 1, w + 2, 7);
      dig.forEach((v, i) => putSmall(x + i * 4, ny + 2, v));
    }
  }

  // 状態 (chara.c の chara_main のローカル変数と同じ)
  const IDLE = 0, CLOCK = 1, DAYS = 2, SING = 3;
  const cmdLen = Math.min(8, cfg[PCHR.CMD_LEN]);
  let now = 0, mode = IDLE, modeT = 0, face = cfg[PCHR.IDLE], faceT = 0;
  let blinkT = 0, blinkNext = 100, blinkOn = 0;
  let prev = 0, hold = 0, longT = 0, longDone = 0, pending = 0;
  let singing = 0, singAt = 0;
  let animIdx = 0, animWait = 0, animK = 0, singT0 = 0;
  const histB = [], histT = [];
  const histPush = (b, t) => { if (histB.length === 8) { histB.shift(); histT.shift(); } histB.push(b); histT.push(t); };
  const histClear = () => { histB.length = 0; histT.length = 0; };
  function histMatches(k) {
    if (k === 0 || k > histB.length) return false;
    const base = histB.length - k;
    for (let i = 0; i < k; i++) {
      if (histB[base + i] !== cfg[PCHR.CMD + i]) return false;
      if (i && histT[base + i] - histT[base + i - 1] > cfg[PCHR.CMD_GAP]) return false;
    }
    return true;
  }
  function cmdInProgress() { for (let k = cfg[PCHR.CMD_LEN] - 1; k >= 1 && k < 8; k--) if (histMatches(k)) return true; return false; }
  // 曲の進み具合 (FIQ が 1tick に 260 サンプル進める)
  function songState() {
    const el = (now - singAt) * SAMPLES_PER_TICK, total = song.count * song.steplen;
    const reads = el < 1 ? 0 : Math.min(song.count, Math.floor((el - 1) / song.steplen) + 1);
    return { reads, done: el >= total + 1 };
  }

  function tick(btn, rtc) {
    let event = null;
    now++;
    btn &= 0x1F;
    const down = btn & ~prev;
    hold = (btn && btn === prev) ? hold + 1 : (btn ? 1 : 0);
    prev = btn;
    if (hold >= cfg[PCHR.EXIT]) return { fb, exit: true, event: singing ? "stop" : null };
    if (cfg[PCHR.LONG_BTN] && (btn & cfg[PCHR.LONG_BTN])) {
      if (++longT >= cfg[PCHR.LONG] && !longDone) {
        longDone = 1;
        if (mode === IDLE) { mode = DAYS; modeT = cfg[PCHR.SHOW]; pending = 0; histClear(); }
      }
    } else { longT = 0; longDone = 0; }
    for (let b = 1; b <= 16; b <<= 1) {
      if (!(down & b)) continue;
      if (mode === SING) {
        if (b === 1) { if (singing) event = "stop"; singing = 0; mode = IDLE; face = cfg[PCHR.IDLE]; }
        continue;
      }
      if (mode === CLOCK || mode === DAYS) { mode = IDLE; longDone = 1; histClear(); continue; }
      histPush(b, now);
      if (cmdLen && histMatches(cmdLen)) {
        histClear(); pending = 0;
        mode = SING; modeT = cfg[PCHR.SHOW];
        animIdx = 0; animWait = 0; animK = 0; singT0 = now;
        if (song) { singing = 1; singAt = now; event = "sing"; }
        continue;
      }
      const f = cfg[PCHR.FACE + [1, 2, 4, 8, 16].indexOf(b)];
      if (f < count) { face = f; faceT = cfg[PCHR.FACE_HOLD]; }
      const n = histB.length;
      if (pending) pending = 0;
      else if (b === cfg[PCHR.DBL_BTN] && n >= 2 && histB[n - 2] === b && now - histT[n - 2] <= cfg[PCHR.DBL_WIN]) {
        if (cmdLen && cmdInProgress()) pending = now + cfg[PCHR.DBL_WIN];
        else { mode = CLOCK; modeT = cfg[PCHR.SHOW]; histClear(); }
      }
    }
    if (pending && now >= pending) { pending = 0; histClear(); if (mode === IDLE) { mode = CLOCK; modeT = cfg[PCHR.SHOW]; } }

    if (mode === CLOCK || mode === DAYS) {
      if (mode === CLOCK) drawClock(rtc); else drawDays(rtc);
      if (--modeT === 0) mode = IDLE;
    } else if (mode === SING) {
      const st = singing ? songState() : null;
      const first = cfg[PCHR.SING_FIRST];
      let n = cfg[PCHR.SING_COUNT];
      if (cfg[PCHR.VERSION] >= 2 && cfg[PCHR.SING_MODE] === 1 && n && first < count) {
        if (first + n > count) n = count - first;
        const sync = cfg[PCHR.SING_SYNC];
        if (sync) {
          const k = singing ? (st.reads >> (sync - 1)) : ((now - singT0) >> 3);
          while (animK < k) { animK++; if (++animIdx >= n) animIdx = 0; }
        } else if (animWait++ >= cfg[PCHR.SING_DELAY] && cfg[PCHR.SING_DELAY]) {
          animWait = 1;
          if (++animIdx >= n) animIdx = 0;
        }
        fbFrame(first + animIdx);
      } else {
        const fa = cfg[PCHR.SING_A] < count ? cfg[PCHR.SING_A] : cfg[PCHR.IDLE];
        const fbb = cfg[PCHR.SING_B] < count ? cfg[PCHR.SING_B] : fa;
        const beat = singing ? (st.reads >> 2) : (now >> 4);
        fbFrame((beat & 1) ? fbb : fa);
      }
      if (singing ? st.done : (--modeT === 0)) {
        if (singing) event = "end";
        singing = 0; mode = IDLE; face = cfg[PCHR.IDLE]; faceT = 0;
      }
    } else {
      if (faceT && --faceT === 0) face = cfg[PCHR.IDLE];
      if (face === cfg[PCHR.IDLE] && cfg[PCHR.BLINK] < count) {
        if (blinkOn) { if (--blinkOn === 0) blinkT = 0; }
        else if (++blinkT >= blinkNext) { blinkOn = 4; blinkNext = blinkNext === 100 ? 160 : 100; }
      } else { blinkOn = 0; blinkT = 0; }
      fbFrame(blinkOn ? cfg[PCHR.BLINK] : face);
    }
    return { fb, exit: false, event, mode: ["idle", "clock", "days", "sing"][mode] };
  }
  return { tick };
}

/* Date → SWI 0Dh / 0Eh と同じ BCD */
function rtcFromDate(dt) {
  const b = (v) => ((Math.floor(v / 10) % 10) << 4) | (v % 10);
  const y = dt.getFullYear();
  return {
    date: ((b(Math.floor(y / 100)) << 24) | (b(y % 100) << 16) | (b(dt.getMonth() + 1) << 8) | b(dt.getDate())) >>> 0,
    time: (((dt.getDay() + 1) << 24) | (b(dt.getHours()) << 16) | (b(dt.getMinutes()) << 8) | b(dt.getSeconds())) >>> 0,
  };
}
if (typeof module !== "undefined") module.exports = { CharaEngine, rtcFromDate, PCHR, CHARA_NONE, CHARA_BTN };
