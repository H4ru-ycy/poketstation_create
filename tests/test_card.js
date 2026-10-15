// node tests/test_card.js <カード.mcr> <足すファイル.bin> [ファイル名]
// converter/card.js (メモリーカードへの追加・削除・書き出し) を確かめる
const fs = require("fs");
const C = require("../converter/card.js");
let ok = true;
const check = (c, m) => { console.log((c ? "OK   " : "NG   ") + m); ok = ok && !!c; };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const card = new Uint8Array(fs.readFileSync(process.argv[2]));
const bin = new Uint8Array(fs.readFileSync(process.argv[3]));
const NAME = process.argv[4] || "BISLPSP00000ANIME";
const p0 = C.cardParse(card);
check(p0.warnings.length === 0, `元のカードを読める: セーブ ${p0.saves.map((s) => s.name + "(" + s.blocks.length + ")").join(", ")}, 空き ${p0.free.length}`);
const r = C.cardAdd(card, NAME, bin);
const p1 = C.cardParse(r.card);
check(p1.warnings.length === 0 && p1.saves.length === p0.saves.length + 1, `追加したカードも正しい (セーブ ${p1.saves.length}件, 空き ${p1.free.length})`);
const mine = p1.saves.find((s) => s.name === NAME);
check(mine && eq(C.cardSaveData(r.card, mine), bin), `追加したファイルを取り出すと元と同じ (ブロック ${mine && mine.blocks})`);
for (const s of p0.saves) {
  const s1 = p1.saves.find((x) => x.name === s.name);
  check(s1 && eq(C.cardSaveData(r.card, s1), C.cardSaveData(card, s)) && eq(s1.blocks, s.blocks), `前からあった ${s.name} はそのまま`);
}
for (let i = 0; i < 0x80 * 64; i++) if (i >= 0x80 * 16 && r.card[i] !== card[i]) { check(false, `管理情報の 16 フレーム目以降が変わった (${i})`); break; }
const r2 = C.cardAdd(r.card, NAME, bin);
check(C.cardParse(r2.card).saves.length === p1.saves.length && r2.replaced, "同じ名前をもう一度足すと置き換え");
const d = C.cardDelete(r.card, mine.first);
check(eq(d, card) || C.cardParse(d).free.length === p0.free.length, "消すと空きが元に戻る");
check(eq(d.subarray(0, 0x80 * 16), card.subarray(0, 0x80 * 16)), "消したあとの管理情報は元のカードと同じ");
const mcs = C.cardSaveMcs(r.card, mine), back = C.cardParseMcs(mcs);
check(back.name === mine.name && eq(back.data, bin), ".mcs に書き出して読み戻せる");
const big = new Uint8Array(C.CARD_BLOCK * (p1.free.length + 1));
let threw = false; try { C.cardAdd(r.card, "BISLPSP00000BIG", big); } catch (e) { threw = /空きが足りません/.test(e.message); }
check(threw, "空きが足りないときは書かない (エラー)");
const blank = C.cardBlank(), pb = C.cardParse(blank);
check(pb.saves.length === 0 && pb.free.length === 15 && pb.warnings.length === 0, "空のカードを作れる");
process.exit(ok ? 0 : 1);
