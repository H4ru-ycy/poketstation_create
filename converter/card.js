/* ============================================================
 * card.js - PS メモリーカード (.mcr 128KB) の読み書き
 *   ポケステのフラッシュも同じ並び: 8KB × 16 ブロック。ブロック0 が管理情報。
 *   管理情報: 0x80 バイトのフレーム。0 = "MC"、1-15 = 各ブロックのディレクトリ。
 *     +00 状態 (51h=先頭, 52h=途中, 53h=最後, A0h=空き, A1h-A3h=消したもの)
 *     +04 ファイルの大きさ (先頭だけ)  +08 次のブロック (番号-1, FFFFh=終わり)
 *     +0A ファイル名 (20文字まで)      +7F それまでの XOR
 * ============================================================ */
const CARD_SIZE = 0x20000, CARD_BLOCK = 0x2000;

function cardXor(f) { let c = 0; for (let i = 0; i < 0x7F; i++) c ^= f[i]; return c; }
function cardFrame(card, i) { return card.subarray(i * 0x80, (i + 1) * 0x80); }

/* 空のカード (tools/mkpoc.py の build_mcr と同じ並び) */
function cardBlank() {
  const card = new Uint8Array(CARD_SIZE);
  card.fill(0xFF, 0, CARD_BLOCK);
  const head = new Uint8Array(0x80); head[0] = 0x4D; head[1] = 0x43; head[0x7F] = cardXor(head);
  card.set(head, 0); card.set(head, 63 * 0x80);
  for (let i = 1; i < 16; i++) cardSetDir(card, i, 0xA0, 0, 0xFFFF, "");
  for (let i = 16; i < 36; i++) {
    const f = new Uint8Array(0x80); new DataView(f.buffer).setUint32(0, 0xFFFFFFFF, true); f[0x7F] = cardXor(f);
    card.set(f, i * 0x80);
  }
  card.fill(0, CARD_BLOCK);
  return card;
}

function cardSetDir(card, i, st, size, next, name) {
  const f = new Uint8Array(0x80), v = new DataView(f.buffer);
  v.setUint32(0, st, true); v.setUint32(4, size, true); v.setUint16(8, next, true);
  for (let k = 0; k < Math.min(20, name.length); k++) f[0x0A + k] = name.charCodeAt(k) & 0x7F;
  f[0x7F] = cardXor(f);
  card.set(f, i * 0x80);
}

/* 読み取り: { saves: [{name, first, blocks:[...], size, title, ok}], free: [...], warnings: [] } */
function cardParse(card) {
  if (!(card instanceof Uint8Array) || card.length !== CARD_SIZE) throw new Error("メモリーカードのイメージ (128KB の .mcr) ではありません");
  if (card[0] !== 0x4D || card[1] !== 0x43) throw new Error("メモリーカードのイメージではありません (先頭が MC ではない)");
  const dir = [], warnings = [];
  for (let i = 1; i < 16; i++) {
    const f = cardFrame(card, i), v = new DataView(f.buffer, f.byteOffset, 0x80);
    let name = "";
    for (let k = 0; k < 20 && f[0x0A + k]; k++) name += String.fromCharCode(f[0x0A + k]);
    dir[i] = { st: v.getUint32(0, true) & 0xFF, size: v.getUint32(4, true), next: v.getUint16(8, true), name, sumOk: cardXor(f) === f[0x7F] };
  }
  const used = new Set(), saves = [];
  for (let i = 1; i < 16; i++) {
    if (dir[i].st !== 0x51) continue;
    const blocks = [i];
    let b = i, ok = true;
    while (dir[b].next !== 0xFFFF) {
      const nb = dir[b].next + 1;
      if (nb < 1 || nb > 15 || blocks.includes(nb) || ![0x52, 0x53].includes(dir[nb].st)) { ok = false; break; }
      blocks.push(nb); b = nb;
    }
    if (blocks.length > 1 && dir[b].st !== 0x53) ok = false;
    if (dir[i].size && dir[i].size !== blocks.length * CARD_BLOCK) ok = false;
    blocks.forEach((x) => used.add(x));
    const blk = card.subarray(i * CARD_BLOCK, (i + 1) * CARD_BLOCK);
    saves.push({ name: dir[i].name, first: i, blocks, size: dir[i].size, ok, title: cardTitle(blk), pocket: blk[0x52] === 0x4D && blk[0x53] === 0x43 && blk[0x54] === 0x58 });
    if (!ok) warnings.push(`${dir[i].name || "名前なし"} のつながりがおかしいです`);
  }
  const free = [];
  for (let i = 1; i < 16; i++) {
    if (used.has(i)) continue;
    if ([0x52, 0x53].includes(dir[i].st)) warnings.push(`ブロック ${i} はどのセーブにもつながっていません (空きとして扱います)`);
    free.push(i);
  }
  for (let i = 1; i < 16; i++) if (!dir[i].sumOk) warnings.push(`ブロック ${i} の管理情報のチェックサムが合いません`);
  return { saves, free, warnings };
}

/* セーブのタイトル (Shift-JIS 64バイト) */
function cardTitle(blk) {
  if (blk[0] !== 0x53 || blk[1] !== 0x43) return "";
  let end = 4; while (end < 68 && blk[end]) end++;
  try { return new TextDecoder("shift_jis").decode(blk.subarray(4, end)).replace(/　+$/, ""); }
  catch (e) { return ""; }
}

/* セーブの中身 (ブロックをつながりの順に) */
function cardSaveData(card, save) {
  const out = new Uint8Array(save.blocks.length * CARD_BLOCK);
  save.blocks.forEach((b, k) => out.set(card.subarray(b * CARD_BLOCK, (b + 1) * CARD_BLOCK), k * CARD_BLOCK));
  return out;
}

/* .mcs (ディレクトリ1フレーム + 中身) */
function cardSaveMcs(card, save) {
  const data = cardSaveData(card, save), out = new Uint8Array(0x80 + data.length);
  const f = new Uint8Array(0x80), v = new DataView(f.buffer);
  v.setUint32(0, 0x51, true); v.setUint32(4, data.length, true); v.setUint16(8, 0xFFFF, true);
  for (let k = 0; k < Math.min(20, save.name.length); k++) f[0x0A + k] = save.name.charCodeAt(k);
  f[0x7F] = cardXor(f);
  out.set(f); out.set(data, 0x80);
  return out;
}
function cardParseMcs(u8) {
  if (u8.length < 0x80 + CARD_BLOCK || (u8.length - 0x80) % CARD_BLOCK || u8[0] !== 0x51) throw new Error(".mcs (セーブ1件) の形式ではありません");
  let name = ""; for (let k = 0; k < 20 && u8[0x0A + k]; k++) name += String.fromCharCode(u8[0x0A + k]);
  return { name, data: u8.slice(0x80) };
}

/* 消す: ディレクトリを空きにして、中身を 0 にする */
function cardDelete(card, first) {
  const out = card.slice(), p = cardParse(card);
  const s = p.saves.find((x) => x.first === first);
  if (!s) throw new Error("そのセーブはありません");
  for (const b of s.blocks) { cardSetDir(out, b, 0xA0, 0, 0xFFFF, ""); out.fill(0, b * CARD_BLOCK, (b + 1) * CARD_BLOCK); }
  return out;
}

/* 足す: 同じ名前があれば置き換える。空きブロック (できればつながった所) に書く */
function cardAdd(card, name, data) {
  if (!data.length || data.length % CARD_BLOCK) throw new Error("セーブの大きさが 8KB 単位ではありません");
  let out = card.slice();
  const old = cardParse(out).saves.find((x) => x.name === name);
  if (old) out = cardDelete(out, old.first);
  const n = data.length / CARD_BLOCK, free = cardParse(out).free;
  if (free.length < n) throw new Error(`空きが足りません (${n}ブロック必要、空き ${free.length}ブロック)`);
  let pick = null;
  for (let k = 0; k + n <= free.length && !pick; k++) if (free[k + n - 1] - free[k] === n - 1) pick = free.slice(k, k + n);
  if (!pick) pick = free.slice(0, n);
  pick.forEach((b, k) => {
    const st = n === 1 || k === 0 ? 0x51 : k === n - 1 ? 0x53 : 0x52;
    cardSetDir(out, b, st, k === 0 ? n * CARD_BLOCK : 0, k < n - 1 ? pick[k + 1] - 1 : 0xFFFF, k === 0 ? name : "");
    out.set(data.subarray(k * CARD_BLOCK, (k + 1) * CARD_BLOCK), b * CARD_BLOCK);
  });
  return { card: out, replaced: !!old, blocks: pick };
}

/* セーブのアイコン (16x16, 16色) を RGBA で */
function cardIconRgba(card, save) {
  const blk = card.subarray(save.first * CARD_BLOCK, save.first * CARD_BLOCK + 0x100);
  if (blk[0] !== 0x53 || blk[1] !== 0x43) return null;
  const pal = [];
  for (let i = 0; i < 16; i++) {
    const c = blk[0x60 + i * 2] | (blk[0x61 + i * 2] << 8);
    pal.push([(c & 31) * 255 / 31, ((c >> 5) & 31) * 255 / 31, ((c >> 10) & 31) * 255 / 31]);
  }
  const out = new Uint8ClampedArray(16 * 16 * 4);
  for (let p = 0; p < 256; p++) {
    const v = (blk[0x80 + (p >> 1)] >> ((p & 1) * 4)) & 15, c = pal[v];
    out.set([c[0], c[1], c[2], 255], p * 4);
  }
  return out;
}
if (typeof module !== "undefined") module.exports = { cardBlank, cardParse, cardAdd, cardDelete, cardSaveData, cardSaveMcs, cardParseMcs, cardIconRgba, CARD_SIZE, CARD_BLOCK };
