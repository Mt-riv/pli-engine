/**
 * 構造体を「名前」として扱う。
 *
 * `declare.ts` は構造体を葉の修飾名に潰すので、グループ名は `vars` に入らない。
 * そのため以前は `b = a;` も `PUT LIST(r);` も「未宣言のスカラ」として
 * 暗黙宣言の 0 に落ちていた。**無言で間違う**のがこの処理系で最も悪い
 * 壊れ方なので、動くことと、できないことを名指しで断ることを対で固定する。
 */
import { describe, expect, it } from "vitest";
import { runProgram } from "../src/index.js";

const MAIN = (body: string) => `m: proc options(main);\n${body}\nend m;`;
const out = (body: string): string => {
  const r = runProgram(MAIN(body));
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join(" / "));
  return r.stdout.replace(/\s+/g, " ").trim();
};
const fails = (body: string): string => {
  const r = runProgram(MAIN(body));
  expect(r.ok).toBe(false);
  return r.diagnostics.map((d) => d.message).join(" / ");
};

describe("構造体全体の代入", () => {
  it("葉を宣言順に写す", () => {
    expect(
      out(`  dcl 1 a, 2 n char(3), 2 m fixed bin(15);
  dcl 1 b, 2 n char(3), 2 m fixed bin(15);
  a.n = 'xyz'; a.m = 7;
  b = a;
  put list(b.n, b.m);`),
    ).toBe("xyz 7");
  });

  it("項目名が違っても形が同じなら写せる（結び付けは宣言順）", () => {
    expect(
      out(`  dcl 1 a, 2 n char(3), 2 m fixed bin(15);
  dcl 1 b, 2 x char(3), 2 y fixed bin(15);
  a.n = 'abc'; a.m = 5;
  b = a;
  put list(b.x, b.y);`),
    ).toBe("abc 5");
  });

  it("形が違えば断る（黙って一部だけ写さない）", () => {
    expect(
      fails(`  dcl 1 a, 2 n char(3), 2 m fixed bin(15);
  dcl 1 b, 2 n char(3);
  a.n = 'xyz'; a.m = 7;
  b = a;`),
    ).toMatch(/形が違います/);
  });

  it("構造体にスカラは代入できない", () => {
    expect(
      fails(`  dcl 1 a, 2 n char(3), 2 m fixed bin(15);
  a = 1;`),
    ).toMatch(/同じ形の構造体だけ/);
  });
});

describe("データリストの構造体", () => {
  it("葉を宣言順に展開する", () => {
    expect(
      out(`  dcl 1 r, 2 a char(3) init('xyz'), 2 b fixed bin(15) init(9);
  put list(r);`),
    ).toBe("xyz 9");
  });

  it("入れ子も展開する", () => {
    expect(
      out(`  dcl 1 r,
        2 a char(2) init('ab'),
        2 inner,
          3 x fixed bin(15) init(1),
          3 y fixed bin(15) init(2);
  put list(r);`),
    ).toBe("ab 1 2");
  });
});

describe("構造体をスカラの位置で使ったとき", () => {
  it("0 を返さず断る", () => {
    const msg = fails(`  dcl 1 r, 2 a char(3) init('xyz'), 2 b fixed bin(15) init(9);
  dcl x fixed bin(15);
  x = r;`);
    expect(msg).toMatch(/構造体です/);
    expect(msg).toMatch(/項目を指定/);
  });
});

describe("未宣言の名前", () => {
  it("括弧を付けた呼び出しは、引数が無くても関数として扱う", () => {
    // date() が「未宣言のスカラ」に落ちると 0 を返して無言で間違う
    expect(fails("  put list(date());")).toMatch(/未実装/);
  });

  it("知らない名前の呼び出しは「未知の関数」", () => {
    expect(fails("  put list(nosuchname());")).toMatch(/未知の関数/);
  });

  it("知っている組込関数で未実装のものは名指しで断る", () => {
    for (const [name, call] of [
      ["oncode", "  put list(oncode);"],
      ["sqrt", "  put list(sqrt(16));"],
      ["time", "  put list(time());"],
    ] as const) {
      expect(fails(call), name).toMatch(/未実装/);
    }
  });

  it("自分で宣言すれば組込関数の名前も使える（名前は奪わない）", () => {
    expect(
      out(`  dcl date char(8) init('20261010');
  put list(date);`),
    ).toBe("20261010");
  });

  it("ふつうの未宣言のスカラは暗黙宣言のまま（PL/I の規定）", () => {
    // I〜N は FIXED BIN(15,0)、それ以外は FLOAT DEC(6)
    expect(out("  i = 3;\n  put list(i);")).toBe("3");
  });
});
