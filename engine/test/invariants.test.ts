/**
 * 不変量の検査。
 *
 * ここまでのテストは「1 つの例を固定する」形で、1000 件を超えていても
 * **2 つの経路が食い違っている**ことは捕まえられなかった。実際に、
 * 表示は正しいのに比較では 0 になる FLOAT、`unifyBase` を通らない `MOD`、
 * `CEIL` / `FLOOR` と違う精度を返す `TRUNC`、画面へ出す経路と読み戻す
 * 経路の取り違えが、すべて全テスト緑のまま通り抜けていた。
 *
 * ここで見るのは**内部の整合**であって「実機と一致するか」ではない。
 * 実機と突き合わせた期待値は `test/golden/` にある。この区別は大事で、
 * ここの検査は実機が無くても回せる。
 *
 * 乱数は固定した種から作る（依存を増やさず、落ちたら必ず再現する）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_BIN,
  MAX_DEC,
  add,
  compare,
  div,
  divideTo,
  fixedFromFloat,
  makeFixed,
  mod,
  mul,
  render,
  sub,
  type FixedVal,
} from "../src/value.js";
import { fixedBinWidth, fixedDecWidth } from "../src/format.js";
import { editPicture, parsePicture, uneditPicture } from "../src/picture.js";
import { runProgram } from "../src/run.js";
import { MemoryHost } from "../src/host.js";
import { loadMfs } from "../src/mfs/source.js";
import { formatInput } from "../src/mfs/input.js";
import { formatOutput } from "../src/mfs/output.js";
import { fieldNamed } from "../src/mfs/device.js";

/**
 * 固定した種の擬似乱数（xorshift32）。
 * 落ちたときに同じ並びが出ることが要る。
 */
function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

describe("精度規則と出力幅の整合", () => {
  /**
   * `FIXED DEC(p,q)` の `PUT LIST` のフィールド幅は p+3。
   * 演算の結果精度は `value.ts` が決めるので、
   * **実際に出した幅**がその p から計算した幅と一致しなければ、
   * どちらかが間違っている。
   */
  it("どの精度の組み合わせでも、出した幅が結果精度から計算した幅と一致する", () => {
    const r = rng(20261010);
    const ops: [string, (a: FixedVal, b: FixedVal) => FixedVal][] = [
      ["+", add],
      ["-", sub],
      ["*", mul],
    ];
    for (let k = 0; k < 400; k++) {
      const [name, fn] = pick(r, ops);
      const p1 = int(r, 1, 7);
      const q1 = int(r, 0, p1);
      const p2 = int(r, 1, 7);
      const q2 = int(r, 0, p2);
      // 桁あふれしない小さな値で見る（幅は値ではなく精度で決まる）
      const a = makeFixed("dec", p1, q1, BigInt(int(r, 0, 9)));
      const b = makeFixed("dec", p2, q2, BigInt(int(r, 0, 9)));
      let got: FixedVal;
      try {
        got = fn(a, b);
      } catch {
        // 桁あふれは別の性質（ここで見るのは精度と幅の整合）
        continue;
      }
      const label = `${name} (${p1},${q1}) (${p2},${q2})`;
      expect(got.p, label).toBeLessThanOrEqual(MAX_DEC);
      expect(got.q, label).toBeGreaterThanOrEqual(0);
      expect(got.q, label).toBeLessThanOrEqual(got.p);
      // 出力幅は p+3。render の桁数がそれに収まる
      expect(render(got).length, `${label} の桁数`).toBeLessThanOrEqual(
        fixedDecWidth(got.p),
      );
    }
  });

  it("BINARY でも尺度が 0 以上に保たれる", () => {
    const r = rng(42);
    for (let k = 0; k < 200; k++) {
      const p1 = int(r, 1, 15);
      const q1 = int(r, 0, p1);
      const a = makeFixed("bin", p1, q1, BigInt(int(r, 0, 100)));
      const b = makeFixed("bin", int(r, 1, 15), 0, BigInt(int(r, 1, 100)));
      for (const fn of [add, sub, mul, div, mod]) {
        let got: FixedVal;
        try {
          got = fn(a, b);
        } catch {
          continue;
        }
        const label = `${fn.name} (${p1},${q1})`;
        expect(got.q, label).toBeGreaterThanOrEqual(0);
        expect(got.p, label).toBeLessThanOrEqual(MAX_BIN);
        expect(render(got).length, label).toBeLessThanOrEqual(fixedBinWidth(got.p) + 1);
      }
    }
  });

  /**
   * 基数混在はどの演算でも同じ向きに揃う。
   * `MOD` だけが `unifyBase` を通らず、`mod(i, 0.5)` が 1.0 になっていた。
   */
  it("基数混在の結果の基数が、どの演算でも同じになる", () => {
    const r = rng(7);
    for (let k = 0; k < 100; k++) {
      const dec = makeFixed("dec", int(r, 2, 7), int(r, 1, 2), BigInt(int(r, 1, 99)));
      const bin = makeFixed("bin", int(r, 4, 15), 0, BigInt(int(r, 1, 9)));
      const bases: string[] = [];
      for (const fn of [add, sub, mul, div, mod]) {
        try {
          bases.push(fn(bin, dec).base);
        } catch {
          // 桁あふれはここでは見ない
        }
      }
      if (bases.length === 0) continue;
      expect(new Set(bases).size, `基数が揃っていない: ${bases.join(",")}`).toBe(1);
      expect(bases[0]).toBe("bin");
    }
  });

  /**
   * `MOD(a,b)` は必ず `0 <= 結果 < |b|`（b が正のとき）。
   *
   * 基数を揃えずに尺度だけ移していたときは `mod(i, 0.5)` が 1.0 を返し、
   * この性質を破っていた。基数の一致を見るだけでは捕まらない
   * （結果の基数は合っていて、値だけが間違っていた）。
   */
  it("MOD の結果は必ず 0 以上で、第 2 引数より小さい", () => {
    const r = rng(31337);
    for (let k = 0; k < 300; k++) {
      const mixBase = r() < 0.5;
      const a = makeFixed(
        mixBase ? "bin" : "dec",
        int(r, 2, 15),
        mixBase ? 0 : int(r, 0, 2),
        BigInt(int(r, 0, 999)),
      );
      const b = makeFixed("dec", int(r, 1, 5), int(r, 0, 2), BigInt(int(r, 1, 99)));
      let got: FixedVal;
      try {
        got = mod(a, b);
      } catch {
        continue;
      }
      const label = `mod(${render(a)}[${a.base}], ${render(b)}[${b.base}])`;
      const x = Number(render(got));
      const limit = Math.abs(Number(render(b)));
      expect(x, `${label} = ${x} が負`).toBeGreaterThanOrEqual(0);
      expect(x, `${label} = ${x} が ${limit} 以上`).toBeLessThan(limit);
    }
  });

  /**
   * `DIVIDE(a,b,p,q)` は指定した精度で返る。
   *
   * 既定の除算精度を先に通していたときは、被除数の精度が広いと
   * q=0 の整数除算になって情報が戻らなかった。
   */
  it("DIVIDE は指定した精度と尺度で返る", () => {
    const r = rng(8888);
    for (let k = 0; k < 200; k++) {
      const p = int(r, 2, 12);
      const q = int(r, 0, p);
      const a = makeFixed("dec", int(r, 1, MAX_DEC), 0, BigInt(int(r, 0, 99)));
      const b = makeFixed("dec", int(r, 1, MAX_DEC), 0, BigInt(int(r, 1, 99)));
      let got: FixedVal;
      try {
        got = divideTo(a, b, p, q);
      } catch {
        continue;
      }
      const label = `divide(${render(a)}, ${render(b)}, ${p}, ${q})`;
      expect(got.p, label).toBe(p);
      expect(got.q, label).toBe(q);
      // 商の値が数の割り算と一致する（指定した桁まで）
      const want = Number(render(a)) / Number(render(b));
      const step = 10 ** -q;
      expect(Math.abs(Number(render(got)) - want), `${label} = ${render(got)}`)
        .toBeLessThan(step + 1e-9);
    }
  });
});

describe("FLOAT と FIXED の往復", () => {
  /**
   * `fixedFromFloat` は桁を落とさない（10 進 15 桁に収まる範囲で）。
   * 文字列を経由していたときは `1e-9` が 0 になっていた。
   */
  it("FIXED で表せる値は往復しても符号と大小が保たれる", () => {
    const r = rng(99);
    for (let k = 0; k < 300; k++) {
      const exp = int(r, -12, 12);
      const mant = int(r, 1, 999999);
      const sign = r() < 0.5 ? -1 : 1;
      const x = sign * mant * 10 ** exp;
      if (!Number.isFinite(x)) continue;
      const f = fixedFromFloat(x);
      expect(f.q, `${x}`).toBeGreaterThanOrEqual(0);
      expect(f.q, `${x}`).toBeLessThanOrEqual(MAX_DEC);
      // 0 でない値が 0 に落ちない（15 桁に収まる範囲）
      if (Math.abs(x) >= 1e-15 && Math.abs(x) < 1e15) {
        expect(f.v !== 0n, `${x} が 0 に落ちた`).toBe(true);
        expect(f.v < 0n, `${x} の符号`).toBe(x < 0);
      }
      // 比較の向きが数値と一致する
      const zero = makeFixed("dec", 1, 0, 0n);
      if (Math.abs(x) >= 1e-15 && Math.abs(x) < 1e15) {
        expect(Math.sign(compare(f, zero)), `${x} と 0 の比較`).toBe(Math.sign(x));
      }
    }
  });
});

describe("PICTURE の往復", () => {
  /**
   * 編集して読み戻すと元の値になる（編集で桁が落ちない範囲で）。
   * `editPicture` と `uneditPicture` は独立に書かれているので、
   * 片方の取り違えをここで捕まえられる。
   */
  it("ゼロ抑制と挿入文字を通しても値が戻る", () => {
    const r = rng(1234);
    const pics = ["ZZZ9", "ZZZ9V.99", "999V.99", "ZZ,ZZ9", "$ZZ9V.99", "ZZZ9CR"];
    for (let k = 0; k < 200; k++) {
      const pic = pick(r, pics);
      const spec = parsePicture(pic);
      // その PICTURE に収まる値を作る（全桁 = spec.p、小数部 = spec.q）
      const v = BigInt(int(r, 0, 10 ** Math.min(spec.p, 6) - 1));
      const x = makeFixed("dec", spec.p, spec.q, v);
      const text = editPicture(spec, x);
      const back = uneditPicture(text, spec);
      // 文字の形は編集で変わるので、数として一致することを見る
      expect(Number(back), `${pic}: ${render(x)} → "${text}" → "${back}"`).toBeCloseTo(
        Number(render(x)),
        spec.q,
      );
    }
  });
});

describe("MFS の往復", () => {
  /**
   * セグメント → 画面 → 読み戻し → セグメント が同じものに戻る。
   *
   * `output.ts`（MOD → DOF の `place`）と `input.ts`（DIF → MID の `fit`）は
   * 独立に書かれていて、`JUST` と `FILL` の扱いを**両方**持っている。
   * 片方の埋め方向を取り違えると往復が壊れるので、ここで捕まえられる。
   *
   * 画面の項目を MFLD より長くしてあるのが要点。同じ長さだと埋める処理を
   * 通らないので、方向を間違えても気づけない。
   */
  const mfs = (just: string, fill: string, lth: number, extra: number) => `F        FMT
         DEV   TYPE=3270-A2
         DIV   TYPE=INOUT
         DPAGE
A        DFLD  POS=(2,2),LTH=${lth + extra}
         FMTEND
IN       MSG   TYPE=INPUT,SOR=F,NXT=OUT
         SEG
         MFLD  A,LTH=${lth},JUST=${just},FILL=${fill}
         MSGEND
OUT      MSG   TYPE=OUTPUT,SOR=F,NXT=IN
         SEG
         MFLD  A,LTH=${lth},JUST=${just},FILL=${fill}
         MSGEND
`;

  it("JUST と FILL のどの組み合わせでも往復が閉じる", () => {
    const r = rng(555);
    const opts = { now: new Date(2026, 9, 10), lterm: "T" };
    for (let k = 0; k < 200; k++) {
      const just = pick(r, ["L", "R"]);
      const fill = pick(r, ["C' '", "C'0'", "C'.'"]);
      const lth = int(r, 3, 8);
      const extra = int(r, 0, 4);
      const lib = loadMfs({ "f.mfs": mfs(just, fill, lth, extra) });
      const label = `JUST=${just} FILL=${fill} LTH=${lth}(+${extra})`;

      // 打ち込んだ短い値 → セグメント（ここで JUST / FILL が効く）
      const typed = String(int(r, 0, 999));
      const seg1 = formatInput(lib, "IN", {
        aid: { kind: "enter" },
        fields: new Map([["A", typed]]),
      })[0]!;
      expect(seg1.length, label).toBe(lth);

      // セグメント → 画面（ここでも JUST / FILL が効く）
      const screen = formatOutput(lib, "OUT", [seg1], opts);
      const text = fieldNamed(screen, "A")!.text;
      expect(text.length, label).toBe(lth + extra);

      // 画面の中身をそのまま打ち込んだことにして読み戻す
      const seg2 = formatInput(lib, "IN", {
        aid: { kind: "enter" },
        fields: new Map([["A", text]]),
      })[0]!;
      expect(seg2, `${label} typed=${typed} seg1="${seg1}" 画面="${text}"`).toBe(seg1);
    }
  });

  /**
   * `JUST` と `FILL` の規則そのもの。
   *
   * 往復だけを見ると、両端で同じ関数を使っている部分の取り違えは
   * 閉じてしまって捕まらない。向きを直接縛る。
   */
  it("JUST=R は右に寄せ、JUST=L は左に寄せる", () => {
    const r = rng(777);
    for (let k = 0; k < 200; k++) {
      const just = pick(r, ["L", "R"]);
      const fillChar = pick(r, [" ", "0", "."]);
      const lth = int(r, 4, 9);
      const lib = loadMfs({ "f.mfs": mfs(just, `C'${fillChar}'`, lth, 0) });
      // 項目より短い値を打つ（埋める処理を必ず通る）
      const typed = String(int(r, 1, 99));
      const seg = formatInput(lib, "IN", {
        aid: { kind: "enter" },
        fields: new Map([["A", typed]]),
      })[0]!;
      const label = `JUST=${just} FILL=C'${fillChar}' LTH=${lth} typed=${typed}`;
      expect(seg.length, label).toBe(lth);
      const pad = fillChar.repeat(lth - typed.length);
      expect(seg, label).toBe(just === "R" ? pad + typed : typed + pad);
    }
  });

  /**
   * 出力側の埋め文字は **`DPAGE` / `MSG` の `FILL=`** から来る
   * （`MFLD FILL=` は入力側で効く）。この非対称は実装の仕様なので、
   * どちらの経路がどちらの `FILL=` を見るかを固定しておく。
   */
  const outMfs = (just: string, dpageFill: string, lth: number, extra: number) =>
    `F        FMT
         DEV   TYPE=3270-A2
         DIV   TYPE=INOUT
         DPAGE FILL=${dpageFill}
A        DFLD  POS=(2,2),LTH=${lth + extra}
         FMTEND
OUT      MSG   TYPE=OUTPUT,SOR=F
         SEG
         MFLD  A,LTH=${lth},JUST=${just}
         MSGEND
`;

  it("出力は JUST=R で右に寄せ、JUST=L で左に寄せる", () => {
    const r = rng(778);
    const opts = { now: new Date(2026, 9, 10), lterm: "T" };
    for (let k = 0; k < 200; k++) {
      const just = pick(r, ["L", "R"]);
      const fillChar = pick(r, [" ", "0", "."]);
      const lth = int(r, 2, 5);
      const extra = int(r, 1, 4);
      const lib = loadMfs({ "f.mfs": outMfs(just, `C'${fillChar}'`, lth, extra) });
      // セグメントは MFLD の長さぴったり。画面の項目はそれより長い
      const data = String(int(r, 0, 10 ** lth - 1)).padStart(lth, "0");
      const screen = formatOutput(lib, "OUT", [data], opts);
      const text = fieldNamed(screen, "A")!.text;
      const label = `JUST=${just} DPAGE FILL=C'${fillChar}' LTH=${lth}(+${extra}) data=${data}`;
      const pad = fillChar.repeat(extra);
      expect(text, label).toBe(just === "R" ? pad + data : data + pad);
    }
  });
});

describe("DL/I の階層順", () => {
  const DBD = `         DBD  NAME=T,ACCESS=HDAM
         DATASET DD1=D,DEVICE=3390
         SEGM NAME=ROOT,PARENT=0,BYTES=8
         FIELD NAME=(RKEY,SEQ,U),BYTES=4,START=1,TYPE=C
         SEGM NAME=CHILD,PARENT=ROOT,BYTES=8
         FIELD NAME=(CKEY,SEQ,U),BYTES=4,START=1,TYPE=C
         DBDGEN
         FINISH
         END
`;
  const PSB = `         PCB  TYPE=DB,DBDNAME=T,PROCOPT=A,KEYLEN=8
         SENSEG NAME=ROOT,PARENT=0
         SENSEG NAME=CHILD,PARENT=ROOT
         PSBGEN LANG=PLI,PSBNAME=P
         END
`;

  /**
   * `GN` の連続が、記憶形式の並び（階層順）と一致する。
   *
   * 走査の順序を変える改修（二次索引など）を入れたときに、
   * 既存の順序が壊れたことを必ず検出できるようにしておく。
   */
  it("GN を繰り返すと .dat の行の順に取れる", () => {
    const r = rng(2024);
    for (let k = 0; k < 20; k++) {
      // 根を何件か、それぞれに子を何件か持たせる
      const lines: string[] = [];
      const roots = int(r, 1, 4);
      for (let i = 1; i <= roots; i++) {
        const rk = `R${String(i).padStart(3, "0")}`;
        lines.push(`ROOT    ${rk}    `.slice(0, 16));
        for (let j = 1; j <= int(r, 0, 3); j++) {
          lines.push(`CHILD   C${String(j).padStart(3, "0")}    `.slice(0, 16));
        }
      }
      const data = lines.map((l) => l.trimEnd()).join("\n") + "\n";
      const host = new MemoryHost({ "T.dbd": DBD, "P.psb": PSB, "T.dat": data });
      const src = `m: proc(p) options(main);
  dcl plitdli entry;
  dcl p pointer;
  dcl 1 pcb based(p),
        2 dbname char(8), 2 seg_level char(2), 2 stat_code char(2),
        2 proc_opt char(4), 2 reserved fixed bin(31), 2 seg_name char(8),
        2 len_kfb fixed bin(31), 2 no_senseg fixed bin(31), 2 key_fb char(8);
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl io char(8);
  do while (pcb.stat_code ^= 'GB');
    call plitdli(three, func, pcb, io);
    if pcb.stat_code ^= 'GB' then put skip edit(pcb.seg_name, io)(a, a);
  end;
end m;`;
      const res = runProgram(src, { host, psb: "P" });
      expect(res.diagnostics, `k=${k}`).toEqual([]);
      const got = res.stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => l.trim().replace(/\s+/g, " "));
      const want = lines.map((l) => {
        const type = l.slice(0, 8).trim();
        const body = l.slice(8).trim();
        return `${type} ${body}`;
      });
      expect(got, `k=${k}`).toEqual(want);
    }
  });
});
