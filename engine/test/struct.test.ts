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

  it("葉の配列の要素数が違えば断る", () => {
    expect(
      fails(`  dcl 1 a, 2 v(3) fixed bin(15);
  dcl 1 b, 2 v(2) fixed bin(15);
  a.v = 1;
  b = a;`),
    ).toMatch(/要素数が合いません/);
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

describe("構造体を引数に渡す", () => {
  const GAME = `  dcl 1 game, 2 total fixed bin(31), 2 hist(5) fixed bin(31), 2 st, 3 n fixed bin(31);`;
  const ADD = `add: proc(g, pts);
  dcl 1 g, 2 total fixed bin(31), 2 hist(5) fixed bin(31), 2 st, 3 n fixed bin(31);
  dcl pts fixed bin(31);
  g.st.n = g.st.n + 1;
  g.hist(g.st.n) = pts;
  g.total = g.total + pts;
end add;`;

  it("参照渡しで、呼び先の書き換えが呼び元へ戻る", () => {
    expect(
      out(`${GAME}
  game.total = 0; game.st.n = 0;
  call add(game, 5);
  call add(game, 7);
  put list(game.total, game.st.n, game.hist(1), game.hist(2));
${ADD}`),
    ).toBe("12 2 5 7");
  });

  it("関数の引数にも渡せ、項目名が違っても宣言順で結び付く", () => {
    expect(
      out(`${GAME}
  game.total = 3; game.st.n = 4;
  put list(score(game));
score: proc(x) returns(fixed bin(31));
  dcl 1 x, 2 t fixed bin(31), 2 h(5) fixed bin(31), 2 s, 3 c fixed bin(31);
  return(x.t * 10 + x.s.c);
end score;`),
    ).toBe("34");
  });

  it("受け取った構造体をさらに別の手続きへ渡せる", () => {
    expect(
      out(`${GAME}
  game.total = 0; game.st.n = 0;
  call outer(game);
  put list(game.total);
outer: proc(g);
  dcl 1 g, 2 total fixed bin(31), 2 hist(5) fixed bin(31), 2 st, 3 n fixed bin(31);
  call add(g, 100);
end outer;
${ADD}`),
    ).toBe("100");
  });

  it("形が違えば断る（黙って詰めると別の項目を書き換える）", () => {
    expect(
      fails(`${GAME}
  call bad(game);
bad: proc(g);
  dcl 1 g, 2 total fixed bin(31), 2 hist(3) fixed bin(31), 2 st, 3 n fixed bin(31);
end bad;`),
    ).toMatch(/2 番目の項目 G\.HIST の属性が、渡された構造体と合いません/);
    expect(
      fails(`${GAME}
  call bad(game);
bad: proc(g);
  dcl 1 g, 2 total fixed bin(31), 2 hist(5) fixed bin(31);
end bad;`),
    ).toMatch(/項目の数（2）が、渡された構造体（3）と合いません/);
  });

  it("受け取った構造体へ構造体を代入しても呼び元に戻る（配列の葉も）", () => {
    // 葉の配列を作り直すと共有が切れ、呼び元の hist が元のまま残っていた
    expect(
      out(`${GAME}
  game.total = 1; game.hist = 1; game.st.n = 1;
  call reset(game);
  put list(game.total, game.hist(1), game.hist(5), game.st.n);
reset: proc(g);
  dcl 1 g, 2 total fixed bin(31), 2 hist(5) fixed bin(31), 2 st, 3 n fixed bin(31);
  dcl 1 zero, 2 t fixed bin(31) init(0), 2 h(5) fixed bin(31) init(0, 0, 0, 0, 0), 2 s, 3 c fixed bin(31) init(0);
  g = zero;
end reset;`),
    ).toBe("0 0 0 0");
  });

  it("受け取った構造体の配列の葉にスカラを配っても呼び元に戻る", () => {
    expect(
      out(`${GAME}
  game.hist = 3;
  call clear(game);
  put list(game.hist(1), game.hist(5));
clear: proc(g);
  dcl 1 g, 2 total fixed bin(31), 2 hist(5) fixed bin(31), 2 st, 3 n fixed bin(31);
  g.hist = 0;
end clear;`),
    ).toBe("0 0");
  });

  it("構造体を渡したのに引数をスカラで宣言していれば断る", () => {
    expect(
      fails(`${GAME}
  call bad(game);
bad: proc(g);
  dcl g fixed bin(31);
end bad;`),
    ).toMatch(/構造体として宣言されていません/);
  });
});
