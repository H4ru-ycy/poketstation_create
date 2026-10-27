// tests/test_chara.py から呼ぶ: converter/chara.js を同じ入力で動かして、1tickごとの画面を返す
const fs = require("fs");
const path = require("path");
const load = (f) => fs.readFileSync(path.join(__dirname, "..", "converter", f), "utf8");
eval(load("font.js").replace(/^const /gm, "global."));
const { CharaEngine } = require("../converter/chara.js");
const inp = JSON.parse(fs.readFileSync(0, "utf8"));
const eng = CharaEngine(inp.cfg, inp.frames.map((f) => Uint32Array.from(f)), inp.song);
const out = [];
for (let t = 1; t < inp.buttons.length; t++) {
  const r = eng.tick(inp.buttons[t], inp.rtc[t]);
  out.push({ t, fb: Array.from(r.fb), event: r.event, settime: r.settime, exit: r.exit, mode: r.mode });
  if (r.exit) break;
}
process.stdout.write(JSON.stringify(out));
