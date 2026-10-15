/* ============================================================
 * 楽譜読み取り (OMR): 印刷された・画面に表示された五線譜の画像から音符を読む
 *   OMR.read([ImageData, ...], opts) -> { systems, measures, warnings, debug }
 * 対象: きれいに描かれたピアノ譜 (ト音記号/ヘ音記号、大譜表または1段)
 * ============================================================ */
const OMR = (() => {
  const SEMI = [0, 2, 4, 5, 7, 9, 11];
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
  const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
  const BASE = { treble: 30, bass: 18 };   // 第1線 (いちばん下の線) の音: E4 / G2 (C0=0 の全音階番号)

  /* ---------- 2値化 ---------- */
  function binarize(img) {
    const W = img.width, H = img.height, d = img.data;
    const gray = new Uint8Array(W * H), hist = new Float64Array(256);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      const a = d[j + 3] / 255;
      const g = Math.round((0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a));
      gray[i] = g; hist[g]++;
    }
    // 紙の色 (いちばん多い明るさ) とインクの色から、細い灰色の線も拾えるしきい値を決める
    let bg = 255, bgN = -1;
    for (let t = 0; t < 256; t++) if (hist[t] > bgN) { bgN = hist[t]; bg = t; }
    let acc = 0, ink = 0;
    const far = (t) => Math.abs(t - bg);
    // 紙から最も遠い側の 3% 点をインクとする
    const order = Array.from({ length: 256 }, (_, t) => t).sort((p, q) => far(q) - far(p));
    for (const t of order) { acc += hist[t]; if (acc >= W * H * 0.03) { ink = t; break; } }
    const thr = bg > ink ? bg - 0.22 * (bg - ink) : bg + 0.22 * (ink - bg);
    // 白い文字の暗い画面 (ダークモード) なら反転
    const invert = bg < ink;
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bin[i] = (invert ? gray[i] > thr : gray[i] < thr) ? 1 : 0;
    return { bin, W, H };
  }

  /* ---------- 五線を探す ---------- */
  function findStaves(bin, W, H) {
    const rows = [];
    for (let y = 0; y < H; y++) {
      let best = 0, bs = 0, start = -1, gap = 0, len = 0;
      for (let x = 0; x <= W; x++) {
        const on = x < W && bin[y * W + x];
        if (on) { if (start < 0) { start = x; len = 0; } len = x - start + 1; gap = 0; }
        else if (start >= 0) { if (++gap > 2) { if (len > best) { best = len; bs = start; } start = -1; } }
      }
      rows.push({ len: best, x0: bs, x1: bs + best - 1 });
    }
    const group = (minRun, skip) => {
      const lines = [];
      for (let y = 0; y < H; y++) {
        if (rows[y].len < minRun || skip(y)) continue;
        const last = lines[lines.length - 1];
        if (last && y - last.y1 <= 1) { last.y1 = y; last.x0 = Math.min(last.x0, rows[y].x0); last.x1 = Math.max(last.x1, rows[y].x1); }
        else lines.push({ y0: y, y1: y, x0: rows[y].x0, x1: rows[y].x1 });
      }
      lines.forEach((l) => { l.yc = (l.y0 + l.y1) / 2; l.t = l.y1 - l.y0 + 1; });
      const out = [];
      for (let i = 0; i + 4 < lines.length;) {
        const g = []; for (let k = 0; k < 4; k++) g.push(lines[i + k + 1].yc - lines[i + k].yc);
        const m = g.reduce((a, b) => a + b, 0) / 4;
        const thick = Math.max(...lines.slice(i, i + 5).map((l) => l.t));
        if (m >= 4 && m <= 80 && g.every((v) => Math.abs(v - m) <= Math.max(1.2, 0.15 * m)) && thick < m * 0.5) {
          const ls = lines.slice(i, i + 5);
          const xs0 = ls.map((l) => l.x0).sort((a, b) => a - b), xs1 = ls.map((l) => l.x1).sort((a, b) => a - b);
          out.push({ lines: ls, s: m, top: ls[0].yc, bot: ls[4].yc, x0: xs0[2], x1: xs1[2], thick });
          i += 5;
        } else i++;
      }
      return out;
    };
    // 1回目: 長い線だけ (連桁が線にくっついて太く見えるのを避ける)。2回目: 見つからなかった所で短い段 (最後の段) を探す
    const staves = group(Math.max(40, W * 0.4), () => false);
    const covered = (y) => staves.some((st) => y >= st.top - 2 * st.s && y <= st.bot + 2 * st.s);
    for (const st of group(Math.max(40, W * 0.08), covered)) staves.push(st);
    staves.sort((a, b) => a.top - b.top);
    return staves;
  }

  /* ---------- 五線を消す ---------- */
  function removeLines(bin, W, H, staves) {
    const sym = bin.slice(), closed = bin.slice();
    for (const st of staves) for (const l of st.lines) {
      const xa = Math.max(0, st.x0 - 3), xb = Math.min(W - 1, st.x1 + 3);
      const side = new Uint8Array(xb - xa + 1);   // 0=何も触れていない 1=上だけ 2=下だけ 3=両方
      for (let x = xa; x <= xb; x++) {
        const above = l.y0 > 0 ? bin[(l.y0 - 1) * W + x] : 0;
        const below = l.y1 < H - 1 ? bin[(l.y1 + 1) * W + x] : 0;
        side[x - xa] = (above ? 1 : 0) | (below ? 2 : 0);
      }
      const restore = new Uint8Array(side.length);
      // 片側から触れている記号にはさまれた短い区間 (線の上に乗った白い符頭の輪) は、穴を探すときだけ残す
      const maxGap = Math.round(0.7 * st.s);
      for (let i = 0; i < side.length;) {
        if (side[i]) { i++; continue; }
        let j = i; while (j < side.length && !side[j]) j++;
        if (i > 0 && j < side.length && j - i <= maxGap && (side[i - 1] === 1 || side[i - 1] === 2) && side[j] === side[i - 1]) for (let k = i; k < j; k++) restore[k] = 1;
        i = j;
      }
      for (let x = xa; x <= xb; x++) {
        if (side[x - xa]) continue;
        for (let y = l.y0; y <= l.y1; y++) { sym[y * W + x] = 0; if (!restore[x - xa]) closed[y * W + x] = 0; }
      }
    }
    return { sym, closed };
  }

  /* ---------- 連結成分 ---------- */
  function components(img, W, H) {
    const lab = new Int32Array(W * H).fill(-1), comps = [], stack = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (!img[i] || lab[i] >= 0) continue;
      const id = comps.length; let sp = 0; stack[sp++] = i; lab[i] = id;
      let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p / W) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && img[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < W - 1 && img[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && img[p - W] && lab[p - W] < 0) { lab[p - W] = id; stack[sp++] = p - W; }
        if (y < H - 1 && img[p + W] && lab[p + W] < 0) { lab[p + W] = id; stack[sp++] = p + W; }
      }
      comps.push({ id, x0, y0, x1, y1, n, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return { lab, comps };
  }

  function integral(img, W, H) {
    const I = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += img[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
    }
    return I;
  }
  const rsum = (I, W, x0, y0, x1, y1) => I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];

  /* ---------- 穴 (白抜きの符頭) を埋めた画像 ---------- */
  function fillHoles(sym, closed, W, H, sAvg) {
    const outside = new Uint8Array(W * H), stack = new Int32Array(W * H);
    let sp = 0;
    const push = (p) => { if (!closed[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp) {
      const p = stack[--sp], x = p % W;
      if (x > 0) push(p - 1); if (x < W - 1) push(p + 1);
      if (p >= W) push(p - W); if (p < W * (H - 1)) push(p + W);
    }
    const holes = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) holes[i] = !closed[i] && !outside[i] ? 1 : 0;
    const { lab, comps } = components(holes, W, H);
    const filled = sym.slice(), holeMask = new Uint8Array(W * H);
    const keep = comps.map((c) => c.n <= 1.1 * sAvg * sAvg && c.w <= 1.3 * sAvg && c.h <= 1.0 * sAvg && c.n >= 2);
    for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && keep[lab[i]]) { filled[i] = 1; holeMask[i] = 1; }
    return { filled, holeMask };
  }

  function longestRunH(img, W, x, y, maxLen) {
    if (!img[y * W + x]) return 0;
    let a = x, b = x;
    while (a > 0 && img[y * W + a - 1] && x - a < maxLen) a--;
    while (b < W - 1 && img[y * W + b + 1] && b - x < maxLen) b++;
    return b - a + 1;
  }
  function runV(img, W, H, x, y, dir, gapAllow) {
    // y から dir 方向に黒が続く長さ (gapAllow 画素までの切れ目は許す)
    let yy = y, gap = 0, last = y;
    while (yy >= 0 && yy < H) {
      if (img[yy * W + x]) { last = yy; gap = 0; } else if (++gap > gapAllow) break;
      yy += dir;
    }
    return Math.abs(last - y);
  }

  /* ---------- 臨時記号の形を見分ける ---------- */
  function classifyAcc(sym, W, c, s) {
    // 縦の太い線 (列ごとの最長の縦の連なり) を数える
    const strokes = [];
    let cur = null;
    for (let x = c.x0; x <= c.x1; x++) {
      let best = 0, bt = 0, run = 0, rs = 0;
      for (let y = c.y0; y <= c.y1 + 1; y++) {
        if (y <= c.y1 && sym[y * W + x]) { if (!run) rs = y; run++; }
        else { if (run > best) { best = run; bt = rs; } run = 0; }
      }
      if (best >= 0.6 * c.h && best >= 1.3 * s) {
        if (cur && x - cur.xe <= 1 && cur.xe - cur.xs + 2 > 0.5 * s + 1) { cur.bad = true; }
        if (cur && x - cur.xe <= 1) { cur.xe = x; cur.top = Math.min(cur.top, bt); cur.bot = Math.max(cur.bot, bt + best - 1); }
        else { cur = { xs: x, xe: x, top: bt, bot: bt + best - 1 }; strokes.push(cur); }
      }
    }
    if (strokes.some((k) => k.bad || k.xe - k.xs + 1 > 0.5 * s + 1)) return null;
    if (c.n / (c.w * c.h) > 0.72) return null;
    if (strokes.length >= 2) {
      const a = strokes[0], b = strokes[strokes.length - 1];
      if (b.xs - a.xe - 1 > 0.8 * s) return null;      // 縦線の間が広い = 2つ重なった全音符など
      if (a.top < b.top - 0.45 * s && a.bot < b.bot - 0.45 * s) return { type: "natural", anchor: (c.y0 + c.y1) / 2 };
      return { type: "sharp", anchor: (c.y0 + c.y1) / 2 };
    }
    if (strokes.length === 1 && strokes[0].xs - c.x0 <= 0.3 * s && c.w >= 0.45 * s) {
      // ♭: 上半分は縦線だけ (細い)、下に丸いふくらみ
      const rowW = (y) => { let a = -1, b = -1; for (let x = c.x0; x <= c.x1; x++) if (sym[y * W + x]) { if (a < 0) a = x; b = x; } return a < 0 ? 0 : b - a + 1; };
      let topMax = 0, botMax = 0;
      for (let y = c.y0; y < c.y0 + 0.4 * c.h; y++) topMax = Math.max(topMax, rowW(y));
      for (let y = Math.round(c.y1 - 0.35 * c.h); y <= c.y1; y++) botMax = Math.max(botMax, rowW(y));
      if (topMax <= 0.45 * s + 1 && botMax >= 0.55 * s) return { type: "flat", anchor: c.y1 - 0.45 * s };
    }
    return null;
  }

  /* ---------- 1枚の画像を読む ---------- */
  function readImage(img, imgIndex, opts) {
    const { bin, W, H } = binarize(img);
    const staves = findStaves(bin, W, H);
    if (!staves.length) return { systems: [], debug: { W, H, staves: [] } };
    const sAvg = staves.reduce((a, b) => a + b.s, 0) / staves.length;
    const { sym, closed } = removeLines(bin, W, H, staves);
    // 五線を消したときにできた縦の切れ目 (線の太さぶん) をつないだ画像で記号をまとめる
    const gapV = Math.max(...staves.map((st) => st.thick)) + 1;
    const vdil = sym.slice();
    for (let x = 0; x < W; x++) {
      let last = -1000;
      for (let y = 0; y < H; y++) {
        if (sym[y * W + x]) { if (y - last > 1 && y - last <= gapV + 1) for (let k = last + 1; k < y; k++) vdil[k * W + x] = 1; last = y; }
      }
    }
    const { lab, comps } = components(vdil, W, H);
    const { filled, holeMask } = fillHoles(sym, closed, W, H, sAvg);
    const IF = integral(filled, W, H), IH = integral(holeMask, W, H);

    // ---- 段 (システム): 左端の縦線でつながった五線をまとめる
    const systems = [];
    for (let i = 0; i < staves.length; i++) {
      const a = staves[i], b = staves[i + 1];
      let joined = false;
      if (b && b.top - a.bot < 12 * a.s) {
        for (let x = Math.max(0, Math.min(a.x0, b.x0) - 2); x <= Math.min(a.x0, b.x0) + 3 && !joined; x++) {
          let cnt = 0; for (let y = Math.round(a.bot); y <= Math.round(b.top); y++) cnt += bin[y * W + x];
          if (cnt >= 0.9 * (b.top - a.bot)) joined = true;
        }
      }
      if (joined) { systems.push([a, b]); i++; } else systems.push([a]);
    }
    staves.forEach((st, i) => { st.index = i; });

    // ---- 各五線の頭 (音部記号・調号・拍子記号)
    for (const sys of systems) sys.forEach((st, k) => {
      const s = st.s;
      const inStaff = (c) => c.y1 >= st.top - 4 * s && c.y0 <= st.bot + 4 * s && (c.y0 + c.y1) / 2 >= st.top - 2 * s && (c.y0 + c.y1) / 2 <= st.bot + 2 * s;
      const cand = comps.filter((c) => c.x0 >= st.x0 - 0.5 * s && c.x0 <= st.x0 + 14 * s && inStaff(c) && c.n >= 3 && c.h < 9 * s)
        .sort((p, q) => p.x0 - q.x0);
      // 五線を消して2つに分かれた記号 (♭の縦線とふくらみ) をつなぐ
      for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const a = cand[i], b = cand[j];
        if (!a || !b) continue;
        const xgap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const yov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (xgap <= 1 && yov >= 0.5 * s && a.h < 3.6 * s && b.h < 3.6 * s && Math.min(a.w, b.w) < 0.6 * s) {
          cand[i] = { ...a, id: -1, x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), n: a.n + b.n,
            w: Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0) + 1, h: Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0) + 1 };
          cand[j] = null;
        }
      }
      for (let i = cand.length - 1; i >= 0; i--) if (!cand[i]) cand.splice(i, 1);
      st.hdrDebug = cand.slice(0, 12).map((c) => ({ x0: c.x0 - st.x0, x1: c.x1 - st.x0, y0: +((c.y0 - st.top) / s).toFixed(1), y1: +((c.y1 - st.top) / s).toFixed(1), w: +(c.w / s).toFixed(2), h: +(c.h / s).toFixed(2), acc: (classifyAcc(vdil, W, c, s) || {}).type }));
      let x = st.x0 + 0.2 * s, clef = null;
      // 音部記号: 五線の左端から始まる部品をまとめる (五線を消すと切れるため)
      const zone = cand.filter((c) => c.x0 <= st.x0 + 1.6 * s && c.y1 > st.top - 0.3 * s);
      if (zone.length) {
        const y0 = Math.min(...zone.map((c) => c.y0)), y1 = Math.max(...zone.map((c) => c.y1));
        const x1 = Math.max(...zone.map((c) => c.x1));
        const h = (y1 - y0) / s, w = (x1 - Math.min(...zone.map((c) => c.x0))) / s;
        if (h >= 2.4 && w >= 1.2) {
          clef = h >= 5 ? "treble" : "bass";
          x = x1;
          // ヘ音記号の2つの点
          for (const c of cand) if (c.x0 > x1 - 0.2 * s && c.x0 < x1 + 0.9 * s && c.w < 0.8 * s && c.h < 1.8 * s) x = Math.max(x, c.x1);
        }
      }
      st.clef = clef || (sys.length === 2 ? (k === 0 ? "treble" : "bass") : "treble");
      st.clefFound = !!clef;
      // 調号: 臨時記号の大きさの部品が続くあいだ数える (形が分からないものも数え、種類は多数決)
      let sharps = 0, flats = 0, unknown = 0, lastX0 = x;
      for (const c of cand) {
        if (c.x0 <= lastX0 || c.x1 <= x - 0.6 * s) continue;     // ♭は左右に重なって並ぶ
        if (c.x0 - x > 1.4 * s) break;
        if (c.h < 1.5 * s || c.h > 3.6 * s || c.w > 1.5 * s || c.w < 0.4 * s) break;
        if ((c.y0 + c.y1) / 2 < st.top - 1.5 * s || (c.y0 + c.y1) / 2 > st.bot + 1 * s) break;
        const a = classifyAcc(vdil, W, c, s);
        if (a && a.type === "natural") break;
        if (!a) {
          // 形が分からないもの: 臨時記号らしい大きさで、符頭のような塊を含まないものだけ数える
          if (c.h < 2.0 * s || c.h > 3.3 * s || c.w > 1.3 * s || c.n / (c.w * c.h) > 0.6) break;
          let core = false;
          const hx = Math.max(2, Math.round(0.4 * s)), hy = Math.max(1, Math.round(0.27 * s));
          for (let y = c.y0 + hy; y <= c.y1 - hy && !core; y++) for (let xx = c.x0 + hx; xx <= c.x1 - hx && !core; xx++)
            if (rsum(IF, W, xx - hx, y - hy, xx + hx + 1, y + hy + 1) >= 0.97 * (2 * hx + 1) * (2 * hy + 1)) core = true;
          if (core) break;
          unknown++;
        }
        else if (a.type === "sharp") sharps++; else flats++;
        x = Math.max(x, c.x1); lastX0 = c.x0;
      }
      if (unknown) { if (sharps >= flats) sharps += unknown; else flats += unknown; }
      st.key = sharps >= flats ? Math.min(7, sharps) : -Math.min(7, flats);
      // 拍子記号 (上下に積まれた2つの数字)
      const rest = cand.filter((c) => c.x0 > x && c.x0 - x < 2 * s);
      const tsTop = rest.find((c) => c.h >= 1.4 * s && c.h <= 2.4 * s && (c.y0 + c.y1) / 2 < st.top + 2 * s);
      const tsBot = rest.find((c) => c.h >= 1.4 * s && c.h <= 2.4 * s && (c.y0 + c.y1) / 2 > st.top + 2 * s && tsTop && Math.abs(c.x0 - tsTop.x0) < 0.8 * s);
      const tsOne = rest.find((c) => c.h >= 1.7 * s && c.h <= 4.6 * s && c.w >= 0.9 * s && c.w <= 2.6 * s && Math.abs((c.y0 + c.y1) / 2 - (st.top + st.bot) / 2) < 0.7 * s && !classifyAcc(vdil, W, c, s));
      if (tsTop && tsBot) { x = Math.max(tsTop.x1, tsBot.x1); st.timeSig = true; }
      else if (tsOne && (tsOne.h >= 3.4 * s)) { x = tsOne.x1; st.timeSig = true; }
      else {
        const big = rest.find((c) => c.h >= 1.8 * s && c.h <= 4.4 * s && c.w >= 1.2 * s && Math.abs((c.y0 + c.y1) / 2 - (st.top + st.bot) / 2) < 0.6 * s && c.x0 - x < 1.2 * s);
        if (big && !st.clefFound) { /* 何もしない */ }
      }
      st.headerEnd = x + 0.3 * s;
    });

    // ---- オクターブ記号 (8va / 8vb): 五線の上下にある点線・破線
    for (const st of staves) {
      st.ottava = [];
      const s = st.s;
      const sysOf = systems.find((sy) => sy.includes(st));
      const k = sysOf.indexOf(st);
      for (const where of ["above", "below"]) {
        let ya, yb;
        if (where === "above") { ya = st.top - 7 * s; yb = st.top - 1.0 * s; if (k > 0) ya = Math.max(ya, (sysOf[k - 1].bot + st.top) / 2); }
        else { ya = st.bot + 1.0 * s; yb = st.bot + 7 * s; if (k < sysOf.length - 1) yb = Math.min(yb, (st.bot + sysOf[k + 1].top) / 2); }
        ya = Math.max(0, Math.round(ya)); yb = Math.min(H - 2, Math.round(yb));
        const found = [];
        for (let y = ya; y <= yb; y++) {
          // 2行ぶんの OR で、短い線分が規則正しく並ぶ所
          const segs = [];
          let rs = -1;
          for (let x = Math.round(st.headerEnd - 2 * s); x <= st.x1 + 1; x++) {
            const on = x >= 0 && x < W && x <= st.x1 && (sym[y * W + x] || sym[(y + 1) * W + x]) && !sym[(y - 2) * W + x] && !sym[(y + 3) * W + x];
            if (on) { if (rs < 0) rs = x; }
            else if (rs >= 0) { segs.push([rs, x - 1]); rs = -1; }
          }
          const short = segs.filter(([a, b]) => b - a + 1 <= 0.95 * s);
          // 間隔がそろった線分の連なり
          let run = [];
          const flush = () => {
            if (run.length >= 8) {
              const gaps = run.slice(1).map((g, i) => g[0] - run[i][1]);
              const mg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
              const ok = gaps.filter((g) => Math.abs(g - mg) <= Math.max(2, 0.35 * mg)).length >= 0.8 * gaps.length;
              if (ok && mg <= 1.0 * s) found.push({ y, x0: run[0][0], x1: run[run.length - 1][1], n: run.length });
            }
            run = [];
          };
          for (const g of short) {
            if (run.length && g[0] - run[run.length - 1][1] > 1.1 * s) flush();
            run.push(g);
          }
          flush();
        }
        // 近い行の重複をまとめる
        found.sort((a, b) => b.n - a.n);
        (st.ottDebug = st.ottDebug || []).push(...found.slice(0, 3).map((f) => ({ where, y: f.y, x0: f.x0, x1: f.x1, n: f.n })));
        for (const f of found) {
          if (st.ottava.some((o) => Math.abs(o.y - f.y) < 1.5 * s && f.x0 < o.x1 && f.x1 > o.x0)) continue;
          // 始まりの「8」: 線の左にある数字 (段の頭の続きなら無いこともある)
          const atStart = f.x0 < st.headerEnd + 3 * s;
          const eight = comps.some((c) => c.x0 >= f.x0 - 3.0 * s && c.x0 <= f.x0 - 0.2 * s && c.h >= 1.0 * s && c.h <= 2.8 * s && c.w >= 0.6 * s &&
            c.y0 <= f.y + 0.5 * s && c.y1 >= f.y - 1.5 * s);
          if (!atStart && !eight) continue;
          st.ottava.push({ y: f.y, x0: f.x0 - 2.2 * s, x1: f.x1 + 0.6 * s, shift: where === "above" ? 12 : -12 });
        }
      }
    }

    // ---- 符頭
    const heads = [];
    for (const st of staves) {
      const s = st.s, hx = Math.max(2, Math.round(0.4 * s)), hy = Math.max(1, Math.round(0.27 * s));
      const area = (2 * hx + 1) * (2 * hy + 1);
      const ya = Math.max(hy + 1, Math.round(st.top - 5.5 * s)), yb = Math.min(H - hy - 2, Math.round(st.bot + 5.5 * s));
      const xa = Math.max(hx + 1, Math.round(st.headerEnd)), xb = Math.min(W - hx - 2, Math.round(st.x1 + 0.5 * s));
      const cw = xb - xa + 1, ch = yb - ya + 1;
      if (cw <= 0 || ch <= 0) continue;
      const cand = new Uint8Array(cw * ch);
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        if (!filled[y * W + x]) continue;
        if (rsum(IF, W, x - hx, y - hy, x + hx + 1, y + hy + 1) >= 0.97 * area) cand[(y - ya) * cw + (x - xa)] = 1;
      }
      const cc = components(cand, cw, ch);
      for (const c of cc.comps) {
        let sx = 0, sy = 0, n = 0;
        for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (cc.lab[y * cw + x] === c.id) { sx += x; sy += y; n++; }
        let cx = Math.round(sx / n) + xa, cy = Math.round(sy / n) + ya;
        // 縦に長い候補 (3度で接した和音) は分ける
        const parts = c.h > 0.7 * s ? Math.round((c.h + 0.5 * s) / s) : 1;
        let ys = [cy];
        if (parts > 1) {
          // 1つの符頭の候補は縦に約 0.45 間隔ぶん。上下の端からその半分だけ内側が中心
          const d = Math.min(0.23 * s, c.h / (2 * parts));
          const top = c.y0 + ya + d, bot = c.y1 + ya - d;
          ys = Array.from({ length: parts }, (_, k) => top + (bot - top) * k / (parts - 1));
        }
        for (const y0 of ys) {
          const y = Math.round(y0);
          if (parts > 1) {
            // その高さの帯にある候補の x の平均 (2度で左右にずれた符頭)
            let sxx = 0, nn = 0;
            for (let yy = Math.round(y - 0.3 * s - ya); yy <= Math.round(y + 0.3 * s - ya); yy++) {
              if (yy < c.y0 || yy > c.y1) continue;
              for (let xx = c.x0; xx <= c.x1; xx++) if (cc.lab[yy * cw + xx] === c.id) { sxx += xx; nn++; }
            }
            if (nn) cx = Math.round(sxx / nn) + xa;
          }
          // 形の確認: 中心の上下で横に長すぎない (連桁ではない)
          const dy = Math.max(1, Math.round(0.3 * s));
          const r1 = longestRunH(filled, W, cx, Math.max(0, y - dy), Math.ceil(3 * s)), r2 = longestRunH(filled, W, cx, Math.min(H - 1, y + dy), Math.ceil(3 * s));
          if (Math.max(r1, r2) > 3.0 * s) continue;
          // 斜めの連桁の一部ではないか: 中心を通る線の両側の遠い所が両方黒いなら線
          let lineLike = false;
          for (let a = -40; a <= 40 && !lineLike; a += 5) {
            const ca = Math.cos(a * Math.PI / 180), sa = Math.sin(a * Math.PI / 180);
            let both = true;
            for (const r of [0.9 * s, 1.3 * s, 1.7 * s, 2.1 * s]) for (const sg of [1, -1]) {
              const px = Math.round(cx + sg * r * ca), py = Math.round(y + sg * r * sa);
              if (px < 0 || px >= W || py < 0 || py >= H || !filled[py * W + px]) both = false;
            }
            if (both) lineLike = true;
          }
          if (lineLike) continue;
          // 楕円の中がほぼ黒い
          let inE = 0, tot = 0;
          const ax = 0.55 * s, ay = 0.4 * s;
          for (let yy = Math.floor(y - ay); yy <= Math.ceil(y + ay); yy++) for (let xx = Math.floor(cx - ax); xx <= Math.ceil(cx + ax); xx++) {
            const ex = (xx - cx) / ax, ey = (yy - y) / ay;
            if (ex * ex + ey * ey <= 1 && yy >= 0 && yy < H && xx >= 0 && xx < W) { tot++; inE += filled[yy * W + xx]; }
          }
          if (inE < 0.88 * tot) continue;
          // 符頭の高さ (縦の黒の長さ) が 0.8 間隔以上 (連桁の端は細い)
          let thin = 0;
          for (const ox of [-0.25, 0, 0.25]) {
            const xx = Math.round(cx + ox * s);
            const up = runV(filled, W, H, xx, y, -1, 0), dn = runV(filled, W, H, xx, y, 1, 0);
            if (up + dn + 1 < 0.8 * s) thin++;
          }
          if (thin >= 2) continue;
          // 白抜き: 穴が符頭の真ん中にある
          let hollow = false;
          if (rsum(IH, W, cx - hx, y - hy, cx + hx + 1, y + hy + 1) > 0.08 * area) {
            let hsx = 0, hn = 0;
            for (let yy = y - Math.round(0.4 * s); yy <= y + Math.round(0.4 * s); yy++) for (let xx = cx - Math.round(0.7 * s); xx <= cx + Math.round(0.7 * s); xx++) {
              if (yy >= 0 && yy < H && xx >= 0 && xx < W && holeMask[yy * W + xx]) { hsx += xx; hn++; }
            }
            hollow = hn > 0 && Math.abs(hsx / hn - cx) <= 0.3 * s;
          }
          if (hollow) {
            const lc = comps[lab[y * W + cx]];
            if (lc && lc.h >= 1.4 * s && lc.h <= 3.4 * s && lc.w <= 1.5 * s && classifyAcc(vdil, W, lc, s)) continue;
          }
          // 縦の中心を、符頭の上下の端の真ん中に合わせる
          let yy = y;
          {
            const ups = [], dns = [];
            for (const ox of [-0.2, 0, 0.2]) {
              const xx = Math.round(cx + ox * s);
              ups.push(runV(filled, W, H, xx, y, -1, 0)); dns.push(runV(filled, W, H, xx, y, 1, 0));
            }
            ups.sort((a, b) => a - b); dns.sort((a, b) => a - b);
            const u = ups[1], dn = dns[1];
            if (false && u + dn + 1 >= 0.7 * s && u + dn + 1 <= 1.35 * s) yy = Math.round(y + (dn - u) / 2);
          }
          heads.push({ x: cx, y: yy, st, hollow });
        }
      }
    }
    // 重複を除く
    heads.sort((a, b) => a.x - b.x);
    const uniq = [];
    for (const h of heads) {
      const s = h.st.s;
      const dup = uniq.find((u) => Math.abs(u.x - h.x) < 0.6 * s && Math.abs(u.y - h.y) < 0.4 * s);
      if (!dup) uniq.push(h);
    }
    // 符頭をどの五線のものか決め直す (中間の加線の音)
    // 加線があるか: 五線の外側1本目の加線の位置に、符頭の幅くらいの横線がある
    const hasLedger = (h, st) => {
      const s = st.s, above = h.y < st.top;
      const yl = Math.round(above ? st.top - s : st.bot + s);
      for (let dy = -1; dy <= 1; dy++) {
        const y = yl + dy;
        if (y < 0 || y >= H) continue;
        let a = h.x, b = h.x;
        while (a > 0 && bin[y * W + a - 1] && h.x - a < 2 * s) a--;
        while (b < W - 1 && bin[y * W + b + 1] && b - h.x < 2 * s) b++;
        if (bin[y * W + h.x] && b - a + 1 >= 1.2 * s && b - a + 1 <= 3.2 * s) return true;
      }
      return false;
    };
    for (const h of uniq) {
      const opts = [];
      for (const st of staves) {
        if (h.x < st.headerEnd - st.s || h.x > st.x1 + st.s) continue;
        const d = h.y < st.top ? st.top - h.y : h.y > st.bot ? h.y - st.bot : 0;
        opts.push({ st, d });
      }
      opts.sort((a, b) => a.d - b.d);
      if (!opts.length) continue;
      let best = opts[0].st;
      // 2つの五線の間で、近い方に加線がなく遠い方にあるなら遠い方
      if (opts.length > 1 && opts[0].d > 1.2 * opts[0].st.s && opts[1].d < 7 * opts[1].st.s) {
        const l0 = hasLedger(h, opts[0].st), l1 = hasLedger(h, opts[1].st);
        if (!l0 && l1) best = opts[1].st;
      }
      h.st = best;
    }
    let H2 = uniq.filter((h) => {
      const st = h.st;
      // オクターブ記号の「8」の上は音符ではない
      for (const q of staves) for (const o of q.ottava || []) {
        if (h.x >= o.x0 - 0.3 * q.s && h.x <= o.x0 + 2.8 * q.s && Math.abs(h.y - o.y) < 1.8 * q.s) return false;
      }
      return h.y >= st.top - 5.6 * st.s && h.y <= st.bot + 5.6 * st.s && h.x > st.headerEnd;
    });

    // ---- 符幹 (縦線) と小節線
    const vlines = [];
    for (const st of staves) {
      const s = st.s, maxW = Math.max(2, Math.round(0.28 * s));
      const ya = Math.max(0, Math.round(st.top - 7 * s)), yb = Math.min(H - 1, Math.round(st.bot + 7 * s));
      let open = [];
      for (let x = Math.round(st.headerEnd - 0.3 * s); x <= Math.min(W - 1, Math.round(st.x1 + 1)); x++) {
        // その列の長い縦の連なり
        const runs = [];
        let rs = -1, gap = 0, last = -1;
        for (let y = ya; y <= yb + 1; y++) {
          const on = y <= yb && sym[y * W + x];
          if (on) { if (rs < 0) rs = y; last = y; gap = 0; }
          else if (rs >= 0 && ++gap > 1) { if (last - rs + 1 >= 2.2 * s) runs.push([rs, last]); rs = -1; gap = 0; }
        }
        const next = [];
        for (const [a, b] of runs) {
          const o = open.find((v) => v.xe === x - 1 && Math.min(v.y1, b) - Math.max(v.y0, a) > 1.5 * s);
          if (o) { o.xe = x; o.y0 = Math.min(o.y0, a); o.y1 = Math.max(o.y1, b); next.push(o); }
          else { const v = { xs: x, xe: x, y0: a, y1: b, st }; vlines.push(v); next.push(v); }
        }
        open = next;
      }
      void maxW;
    }
    const stems = [], bars = [];
    for (const v of vlines) {
      const st = v.st, s = st.s, w = v.xe - v.xs + 1;
      v.x = (v.xs + v.xe) / 2;
      if (w > 0.9 * s) continue;
      const coversStaff = v.y0 <= st.top + 0.3 * s && v.y1 >= st.bot - 0.3 * s;
      const sysOf = systems.find((sy) => sy.includes(st));
      const idx = sysOf.indexOf(st);
      const above = idx === 0 ? v.y0 < st.top - 0.6 * s : false;
      const below = idx === sysOf.length - 1 ? v.y1 > st.bot + 0.6 * s : false;
      const nearHead = H2.some((h) => h.st === st && Math.abs(h.x - v.x) < 1.0 * s && h.y > v.y0 - 0.5 * s && h.y < v.y1 + 0.5 * s);
      if (coversStaff && !above && !below && !nearHead && w <= 0.6 * s) bars.push({ x: v.x, w, st });
    }

    // ---- 符幹: 符頭の左右の端から縦に伸びる細い線を探す
    const stemList = [];
    const colRun = (x, yc, s) => {
      // 列 x で、yc の近くを通る最長の縦の連なり
      if (x < 0 || x >= W) return null;
      const ya = Math.max(0, Math.round(yc - 11 * s)), yb = Math.min(H - 1, Math.round(yc + 11 * s));
      let best = null, rs = -1, gap = 0, last = -1;
      for (let y = ya; y <= yb + 1; y++) {
        const on = y <= yb && sym[y * W + x];
        if (on) { if (rs < 0) rs = y; last = y; gap = 0; }
        else if (rs >= 0 && (++gap > 1 || y > yb)) {
          if (rs <= yc + 0.5 * s && last >= yc - 0.5 * s && (!best || last - rs > best.y1 - best.y0)) best = { y0: rs, y1: last };
          rs = -1; gap = 0;
        }
      }
      return best;
    };
    for (const h of H2) {
      const s = h.st.s;
      let best = null;
      for (const side of [1, -1]) {
        for (let dx = Math.round(0.3 * s); dx <= Math.round(0.95 * s); dx++) {
          const x = h.x + side * dx;
          const r = colRun(x, h.y, s);
          if (!r) continue;
          const ext = Math.max(h.y - r.y0, r.y1 - h.y);
          if (ext < 2.0 * s) continue;
          // 細い線か (外側の 2px 先が、符頭から離れた所で白い)
          const ox = x + side * 2;
          if (ox < 0 || ox >= W) continue;
          // 他の符頭の高さは除いて、外側が白いか
          const near = H2.filter((q) => Math.abs(q.x - x) < 1.6 * s);
          let dark = 0, tot = 0;
          for (let y = r.y0; y <= r.y1; y++) {
            if (Math.abs(y - h.y) < 0.8 * s || near.some((q) => Math.abs(q.y - y) < 0.7 * s)) continue;
            tot++; dark += sym[y * W + ox];
          }
          if (tot && dark / tot > 0.5) continue;
          if (!best || ext > best.ext + 1) best = { x, y0: r.y0, y1: r.y1, ext };
        }
      }
      if (!best) { h.stem = null; continue; }
      let v = stemList.find((q) => Math.abs(q.x - best.x) <= 1.5 && Math.min(q.y1, best.y1) - Math.max(q.y0, best.y0) > s);
      if (v) { v.y0 = Math.min(v.y0, best.y0); v.y1 = Math.max(v.y1, best.y1); }
      else { v = { x: best.x, y0: best.y0, y1: best.y1, st: h.st }; stemList.push(v); }
      h.stem = v;
    }
    for (const v of stemList) stems.push(v);

    // ---- 和音 (同じ符幹) にまとめる → イベント
    const events = [];
    const byStem = new Map();
    for (const h of H2) {
      if (h.stem) {
        if (!byStem.has(h.stem)) byStem.set(h.stem, []);
        byStem.get(h.stem).push(h);
      }
    }
    for (const [v, hs] of byStem) {
      const s = v.st.s;
      // 符幹の先 (符頭から遠い方)
      const ys = hs.map((h) => h.y);
      const up = v.y1 - Math.max(...ys) < Math.min(...ys) - v.y0;   // 上向き: 先が上
      const tip = up ? v.y0 : v.y1;
      // 連桁・旗の数
      let beams = 0;
      for (const off of [-0.5, -0.7, 0.5, 0.7]) {
        const cx = Math.round(v.x + off * s);
        const sideX = off < 0 ? -1 : 1;
        if (cx < 0 || cx >= W) continue;
        // 先端から順に: 太い横線 (0.22〜0.8間隔) が短い隙間で続く数
        let n = 0, run = 0, gapR = 0, started = false;
        // 先端からいちばん近い符頭の手前まで (短い符幹で符頭を連桁と数えないように)
        const nearestHead = Math.min(...hs.map((h) => Math.abs(h.y - tip)));
        const len = Math.round(Math.min(2.4 * s, nearestHead - 0.25 * s)), st0 = Math.round(tip - (up ? 0.35 : -0.35) * s);
        for (let k = 0; k <= len; k++) {
          const y = up ? st0 + k : st0 - k;
          if (y < 0 || y >= H) break;
          if (sym[y * W + cx]) { run++; gapR = 0; continue; }
          if (run) {
            // 横につながっているか (縦線ではないか) を run の真ん中で確かめる
            const my = up ? y - Math.ceil(run / 2) : y + Math.ceil(run / 2);
            let horiz = cx - 2 >= 0 && cx + 2 < W && sym[my * W + cx - 2] && sym[my * W + cx + 2];
            // この符幹につながっている連桁か (符幹から cx まで黒が続く)
            if (horiz) for (let xx = Math.round(v.x); xx !== cx; xx += sideX) {
              if (!sym[my * W + xx] && !sym[(my - 1) * W + xx] && !sym[(my + 1) * W + xx]) { horiz = false; break; }
            }
            if (run >= Math.max(2, 0.22 * s) && run <= 2.2 * s && horiz) { n += Math.max(1, Math.round((run + 0.25 * s) / (0.75 * s))); started = true; }
            run = 0;
          }
          gapR++;
          if (!started && k > 0.9 * s) break;           // 先端の近くに何もない
          if (started && gapR > 0.55 * s) break;        // 連桁のまとまりが終わった
        }

        beams = Math.max(beams, n);
      }
      // 旗 (連桁のない8分・16分): 符幹の右側、先端の近くに付く
      if (!beams && !hs.some((h) => h.hollow)) {
        const fx = Math.round(v.x + Math.max(2, 0.4 * s));
        if (fx < W) {
          let runs = 0, run = 0, first = -1;
          const len = Math.round(2.6 * s);
          for (let k = 0; k <= len; k++) {
            const y = up ? Math.round(tip) + k : Math.round(tip) - k;
            if (y < 0 || y >= H) break;
            if (sym[y * W + fx]) { if (!run && first < 0) first = k; run++; }
            else { if (run >= Math.max(2, 0.2 * s)) runs++; run = 0; }
          }
          if (run >= Math.max(2, 0.2 * s)) runs++;
          // 先端のすぐ近くから始まり、符幹とつながっている
          if (runs && first >= 0 && first <= 0.8 * s) {
            const y = up ? Math.round(tip) + first + 1 : Math.round(tip) - first - 1;
            let att = true;
            for (let x = Math.round(v.x) + 1; x < fx; x++) if (!sym[y * W + x] && !sym[(y + 1) * W + x] && !sym[(y - 1) * W + x]) { att = false; break; }
            if (att) beams = Math.min(runs, 3);
          }
        }
      }
      beams = Math.min(beams, 3);
      const hollow = hs.filter((h) => h.hollow).length > hs.length / 2;
      // 符頭の列の x (2度でずれた符頭は除く)
      const normal = hs.filter((h) => (up ? h.x < v.x : h.x > v.x));
      const ex = (normal.length ? normal : hs).reduce((a, h) => a + h.x, 0) / (normal.length || hs.length);
      let dur = hollow ? 8 : [4, 2, 1, 0.5][beams];
      events.push({ kind: "note", st: v.st, x: ex, heads: hs, dur, hollow, beams, up, stem: v });
    }
    // 符幹のない白い符頭 = 全音符
    const loose = H2.filter((h) => !h.stem);
    loose.sort((a, b) => a.x - b.x);
    for (const h of loose) {
      const s = h.st.s;
      const ev = events.find((e) => e.kind === "note" && !e.stem && e.st === h.st && Math.abs(e.x - h.x) < 1.6 * s);
      if (ev) { ev.heads.push(h); continue; }
      events.push({ kind: "note", st: h.st, x: h.x, heads: [h], dur: h.hollow ? 16 : 4, hollow: h.hollow, beams: 0, stem: null });
    }

    // ---- 付点 (五線をつないでいない画像の部品で見る: 上下の点がくっつかないように)
    const symC = components(sym, W, H);
    for (const e of events) {
      const s = e.st.s;
      const right = Math.max(...e.heads.map((h) => h.x)) + 0.6 * s;
      let dotted = false;
      for (const h of e.heads) {
        const xa = Math.round(right + 0.1 * s), xb = Math.round(right + 1.5 * s);
        const ya = Math.round(h.y - 0.75 * s), yb = Math.round(h.y + 0.25 * s);
        const seen = new Set();
        for (let y = ya; y <= yb && !dotted; y++) for (let x = xa; x <= xb && !dotted; x++) {
          if (x < 0 || x >= W || y < 0 || y >= H || !sym[y * W + x]) continue;
          const c = symC.comps[symC.lab[y * W + x]];
          if (!c || seen.has(c.id)) continue; seen.add(c.id);
          if (c.w >= 0.22 * s && c.w <= 0.7 * s && c.h >= 0.22 * s && c.h <= 0.7 * s && c.n >= 0.5 * c.w * c.h) dotted = true;
        }
      }
      if (dotted) e.dur *= 1.5;
      e.dotted = dotted;
    }

    // ---- 臨時記号
    const headComp0 = new Set();
    for (const h of H2) { const id = lab[h.y * W + h.x]; if (id >= 0) headComp0.add(id); }
    const usedComp = new Set();
    for (const h of H2) {
      const s = h.st.s;
      const xa = h.x - 2.6 * s, xb = h.x - 0.5 * s;
      let best = null, bd = 1e9;
      const seen = new Set();
      for (let y = Math.round(h.y - 1.8 * s); y <= Math.round(h.y + 1.8 * s); y += 1) {
        if (y < 0 || y >= H) continue;
        for (let x = Math.round(xa); x <= Math.round(xb); x++) {
          if (x < 0 || x >= W || !vdil[y * W + x]) continue;
          const c = comps[lab[y * W + x]];
          if (!c || seen.has(c.id)) continue; seen.add(c.id);
          if (c.h < 1.4 * s || c.h > 3.4 * s || c.w < 0.35 * s || c.w > 1.5 * s) continue;
          if (c.x1 > h.x - 0.4 * s) continue;
          const a = classifyAcc(vdil, W, c, s);
          if (!a) continue;
          const d = Math.abs(a.anchor - h.y);
          if (d > 0.45 * s) continue;
          const score = d + (h.x - c.x1) * 0.05;
          if (score < bd) { bd = score; best = { ...a, comp: c }; }
        }
      }
      if (best) { h.acc = best.type; usedComp.add(best.comp.id); }
    }

    // ---- 休符
    const headComp = headComp0;
    for (const st of staves) {
      const s = st.s;
      for (const c of comps) {
        if (headComp.has(c.id) || usedComp.has(c.id)) continue;
        const cy = (c.y0 + c.y1) / 2, cx = (c.x0 + c.x1) / 2;
        if (cx < st.headerEnd || cx > st.x1 || cy < st.top - 0.6 * s || cy > st.bot + 0.6 * s) continue;
        if (bars.some((b) => b.st === st && Math.abs(b.x - cx) < 0.8 * s)) continue;
        if (stems.some((v) => v.st === st && v.x >= c.x0 - 1 && v.x <= c.x1 + 1 && v.y0 <= c.y1 && v.y1 >= c.y0 && v.y1 - v.y0 > 2.5 * s && c.h > 3.2 * s)) continue;
        const w = c.w / s, h = c.h / s, fill = c.n / (c.w * c.h);
        const mid = (st.top + st.bot) / 2;
        let dur = 0;
        if (w >= 0.9 && w <= 1.6 && h >= 0.35 && h <= 0.8 && fill > 0.75) {
          dur = cy < mid - 0.5 * s ? 16 : 8;     // 全休符は第4線から下がる、2分休符は第3線の上
        } else if (h >= 2.3 && h <= 3.4 && w >= 0.6 && w <= 1.4 && fill > 0.25 && fill < 0.7) {
          dur = 4;
          // 16分休符: 左上に小さな玉が2つ
          let lobes = 0, run = 0;
          const colx = Math.round(c.x0 + 0.2 * c.w);
          for (let y = c.y0; y <= c.y1 + 1; y++) {
            if (y <= c.y1 && vdil[y * W + colx] && lab[y * W + colx] === c.id) run++;
            else { if (run >= 0.3 * s) lobes++; run = 0; }
          }
          if (lobes >= 2 && c.x1 - c.x0 > 1.0 * s) dur = 1;
        } else if (h >= 1.4 && h < 2.3 && w >= 0.6 && w <= 1.4 && fill > 0.2 && fill < 0.7) {
          dur = 2;
        }
        if (!dur) continue;
        if (dur === 4 || dur === 2) { if (classifyAcc(vdil, W, c, s)) continue; }
        // 付点
        let dotted = false;
        for (const d of comps) {
          if (d.x0 > c.x1 + 0.1 * s && d.x0 < c.x1 + 1.2 * s && d.w <= 0.7 * s && d.h <= 0.7 * s && d.w >= 0.22 * s && d.h >= 0.22 * s &&
              (d.y0 + d.y1) / 2 > c.y0 - 0.3 * s && (d.y0 + d.y1) / 2 < c.y1 + 0.3 * s) { dotted = true; break; }
        }
        events.push({ kind: "rest", st, x: cx, dur: dotted ? dur * 1.5 : dur, dotted, comp: c, heads: [] });
      }
    }

    // ---- タイの弧の候補: 細く横に長い部品で、両端の近くに符頭がある
    const tieComps = [];
    for (const c of comps) {
      if (c.w < 1.0 * sAvg || c.h > 1.6 * sAvg || c.h < 0.2 * sAvg || c.n / (c.w * c.h) > 0.5) continue;
      if (headComp0.has(c.id)) continue;
      // 端の高さ: 左端の列の黒の平均
      let ys = 0, yn = 0;
      for (let x = c.x0; x <= c.x0 + 1; x++) for (let y = c.y0; y <= c.y1; y++) if (lab[y * W + x] === c.id) { ys += y; yn++; }
      const yEnd = yn ? ys / yn : (c.y0 + c.y1) / 2;
      let st = null, bd = 1e9;
      for (const q of staves) { const d = yEnd < q.top ? q.top - yEnd : yEnd > q.bot ? yEnd - q.bot : 0; if (d < bd && c.x0 > q.headerEnd - q.s && c.x0 < q.x1) { bd = d; st = q; } }
      if (!st || bd > 6 * st.s) continue;
      tieComps.push({ x0: c.x0, x1: c.x1, yEnd, st });
    }

    // ---- 小節線 (段の中でそろえる)
    const result = [];
    for (const sys of systems) {
      const s = sys[0].s;
      const xs = [];
      for (const b of bars) if (sys.includes(b.st)) xs.push(b.x);
      xs.sort((a, b) => a - b);
      const merged = [];
      for (const x of xs) {
        const last = merged[merged.length - 1];
        if (last && x - last.x1 < 1.4 * s) { last.x1 = x; last.n++; }
        else merged.push({ x0: x, x1: x, n: 1 });
      }
      // 2段なら、両方の五線で同じ位置に見つかった線か、五線の間もつながっている線だけ
      const barX = merged.filter((m) => {
        if (sys.length === 1) return true;
        const sts = new Set(bars.filter((b) => sys.includes(b.st) && b.x >= m.x0 - 1 && b.x <= m.x1 + 1).map((b) => b.st));
        if (sts.size >= 2) return true;
        const x = Math.round((m.x0 + m.x1) / 2);
        let cnt = 0;
        const ya = Math.round(sys[0].bot), yb = Math.round(sys[1].top);
        for (let y = ya; y <= yb; y++) cnt += bin[y * W + x] || bin[y * W + x - 1] || bin[y * W + x + 1] ? 1 : 0;
        return cnt >= 0.9 * (yb - ya + 1);
      }).map((m) => ({ x: (m.x0 + m.x1) / 2, x0: m.x0, x1: m.x1 }));
      const start = Math.min(...sys.map((st) => st.headerEnd)) - 1;
      const end = Math.max(...sys.map((st) => st.x1));
      const bounds = [start, ...barX.map((b) => b.x).filter((x) => x > start + 1.5 * s && x < end - 1.0 * s), end + 1];
      // 段の終わりの小節線が五線の右端と重なるとき
      const meas = [];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const a = bounds[i], b = bounds[i + 1];
        const evs = events.filter((e) => sys.includes(e.st) && e.x > a && e.x < b);
        if (!evs.length && b - a < 4 * s) continue;
        // 小節の頭の調号の変更 (小節線の直後の臨時記号のまとまり)
        const keyChange = {};
        if (i > 0) for (const st of sys) {
          const ss = st.s;
          let x = a + 0.2 * ss, sharps = 0, flats = 0, nat = 0, found = false;
          const cs = comps.filter((c) => c.x0 > x && c.x0 < x + 9 * ss && (c.y0 + c.y1) / 2 > st.top - 1.5 * ss && (c.y0 + c.y1) / 2 < st.bot + 1.5 * ss && !usedComp.has(c.id) && !headComp.has(c.id))
            .sort((p, q) => p.x0 - q.x0);
          let lastX0 = -1;
          for (const c of cs) {
            if (c.x0 <= lastX0) continue;
            if (c.x0 - x > 1.3 * ss) break;
            if (c.h < 1.5 * ss || c.h > 3.4 * ss || c.w > 1.5 * ss) break;
            const t = classifyAcc(vdil, W, c, ss);
            if (!t) break;
            found = true;
            if (t.type === "sharp") sharps++; else if (t.type === "flat") flats++; else nat++;
            x = Math.max(x, c.x1); lastX0 = c.x0;
          }
          if (found && (sharps + flats + nat) >= 1) keyChange[st.index] = sharps >= flats ? sharps : -flats;
        }
        meas.push({ x0: a, x1: b, events: evs, keyChange });
      }
      result.push({ staves: sys, measures: meas, s });
    }
    return { systems: result, debug: { W, H, staves, heads: H2, stems, bars, events, imgIndex, tieComps, ...(opts.keepImages ? { bin, sym, vdil, filled, holeMask } : {}) } };
  }

  /* ---------- 音の高さ ---------- */
  function keyAlter(key) {
    const a = [0, 0, 0, 0, 0, 0, 0];
    if (key > 0) SHARP_ORDER.slice(0, key).forEach((d) => { a[d] = 1; });
    if (key < 0) FLAT_ORDER.slice(0, -key).forEach((d) => { a[d] = -1; });
    return a;
  }

  /* ---------- 小節ごとに時間をならべる ---------- */
  function timeline(meas, staffIdx) {
    // 五線ごとに: 同じ x (0.9 間隔以内) は同時。進む時間 = その瞬間のいちばん短い音
    let end = 0;
    for (const si of staffIdx) {
      const evs = meas.events.filter((e) => e.st.index === si).slice().sort((a, b) => a.x - b.x);
      const cols = [];
      for (const e of evs) {
        const s = e.st.s;
        const last = cols[cols.length - 1];
        if (last && e.x - last.x < 0.9 * s) { last.evs.push(e); last.x = (last.x + e.x) / 2; }
        else cols.push({ x: e.x, evs: [e] });
      }
      let t = 0;
      for (const c of cols) {
        for (const e of c.evs) { e.t = t; end = Math.max(end, t + e.dur); }
        t += Math.min(...c.evs.map((e) => e.dur));
      }
      end = Math.max(end, t);
    }
    return end;
  }

  function read(images, opts = {}) {
    const pages = images.map((img, i) => readImage(img, i, opts));
    if (opts.pagesOnly) return { pages };
    const measures = [], warnings = [];
    let keyBy = {};   // 五線の種類ごと (0=上段, 1=下段) の現在の調
    let sysCount = 0;
    pages.forEach((pg, pi) => { pg.debug.imgIndex = pi; });
    for (const [pi, pg] of pages.entries()) for (const sys of pg.systems) {
      sysCount++;
      const nSt = sys.staves.length;
      sys.staves.forEach((st, k) => { keyBy[k] = st.key; });
      for (const m of sys.measures) {
        sys.staves.forEach((st, k) => { if (m.keyChange[st.index] !== undefined) keyBy[k] = m.keyChange[st.index]; });
        const total = timeline(m, sys.staves.map((st) => st.index));
        const parts = sys.staves.map((st, k) => {
          const kal = keyAlter(keyBy[k]);
          const accState = {};
          const evs = m.events.filter((e) => e.st === st).sort((a, b) => a.t - b.t || a.x - b.x);
          return evs.map((e) => {
            if (e.kind === "rest") return { t: e.t, d: e.dur, notes: [] };
            const notes = [], headList = [];
            const hs = e.heads.slice().sort((a, b) => a.x - b.x);
            for (const h of hs) {
              const p = Math.round((st.bot - h.y) / (st.s / 2));
              const dia = BASE[st.clef] + p;
              if (h.acc) accState[dia] = h.acc === "sharp" ? 1 : h.acc === "flat" ? -1 : 0;
              const alter = accState[dia] !== undefined ? accState[dia] : kal[((dia % 7) + 7) % 7];
              let midi = 12 * (Math.floor(dia / 7) + 1) + SEMI[((dia % 7) + 7) % 7] + alter;
              const ott = (st.ottava || []).find((o) => h.x >= o.x0 && h.x <= o.x1);
              if (ott) midi += ott.shift;
              notes.push(midi);
              headList.push({ midi, h });
            }
            return { t: e.t, d: e.dur, notes: [...new Set(notes)].sort((a, b) => a - b), x: e.x, heads: headList };
          });
        });
        measures.push({ page: pi, x0: m.x0, x1: m.x1, top: sys.staves[0].top, bot: sys.staves[nSt - 1].bot, total, width: m.x1 - m.x0, s: sys.s, staves: nSt, parts, clefs: sys.staves.map((st) => st.clef), keys: sys.staves.map((st, k) => keyBy[k]), sys: sysCount });
      }
    }
    // 小節の長さ = いちばん多い合計
    const cnt = {};
    for (const m of measures) if (m.total > 0) cnt[m.total] = (cnt[m.total] || 0) + 1;
    let len = 16, bestN = 0;
    for (const [k, v] of Object.entries(cnt)) if (v > bestN && [16, 12, 8, 6, 4, 24, 20, 10, 14].includes(+k)) { bestN = v; len = +k; }
    if (opts.measureLen) len = opts.measureLen;
    // 曲全体の時間: 小節の長さの倍数に丸める (小節線を見落として2小節がつながっても後ろがずれない)
    let at = 0;
    const widths = measures.map((m) => m.width / m.s).sort((p, q) => p - q);
    const medW = widths[Math.floor(widths.length / 2)] || 1;
    measures.forEach((m) => {
      m.start = at;
      const k = Math.round(m.total / len);
      m.span = k >= 2 && m.width / m.s > 1.6 * medW ? k * len : len;
      at += m.span;
    });
    measures.forEach((m, i) => {
      m.len = len;
      if (Math.abs(m.total - len) > 0.01 && !(i === 0 && m.total < len) && !(i === measures.length - 1 && m.total < len)) {
        warnings.push({ measure: i, total: m.total, len });
      }
    });
    // ---- 曲全体の音符の一覧 (上段=0, 下段=1)。タイでつながった音はまとめる
    const notes = [];
    measures.forEach((m) => m.parts.forEach((p, k) => {
      for (const e of p) for (const nn of e.heads || []) notes.push({ st: k, t: m.start + e.t, d: e.d, n: nn.midi, head: nn.h, sys: m.sys, page: m.page });
    }));
    for (const pg of pages) {
      const { tieComps } = pg.debug;
      for (const tc of tieComps || []) {
        // 弧の左右の端の近くにある、同じ高さの音を探す
        const cand = notes.filter((n) => n.page === pg.debug.imgIndex && n.head && n.head.st === tc.st);
        const s = tc.st.s;
        const left = cand.filter((n) => Math.abs(n.head.x - tc.x0) < 1.3 * s && Math.abs(n.head.y - tc.yEnd) < 1.3 * s);
        for (const a of left) {
          const b = cand.filter((n) => n.n === a.n && n.t > a.t && Math.abs(n.head.x - tc.x1) < 1.3 * s && Math.abs(n.head.y - a.head.y) < 0.3 * s)
            .sort((p, q) => p.t - q.t)[0];
          if (b && !b.tiedFrom) { b.tiedFrom = a; }
        }
      }
    }
    // つなぐ (後ろから順に)
    notes.sort((a, b) => a.t - b.t);
    for (const b of notes) if (b.tiedFrom) { const a = b.tiedFrom; a.d = Math.max(a.d, b.t + b.d - a.t); b.drop = true; }
    const flat = notes.filter((n) => !n.drop).map((n) => ({ st: n.st, t: n.t, d: n.d, n: n.n }));
    return { pages, measures, measureLen: len, warnings, notes: flat };
  }

  return { read, keyAlter, BASE };
})();
if (typeof module !== "undefined") module.exports = OMR;
