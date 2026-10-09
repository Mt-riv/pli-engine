import { describe, expect, it } from "vitest";
import {
  FixedOverflow,
  add, div, mul, sub, pow, neg,
  fixedFromLiteral, makeFixed, render, compare,
  toCharString,
} from "../src/value.js";

const dec = (text: string) => fixedFromLiteral(text);
const bin = (n: bigint | number, p = 31, q = 0) =>
  makeFixed("bin", p, q, BigInt(n));

describe("定数リテラルの型", () => {
  /** PL/I の算術定数は FIXED DECIMAL。桁数がそのまま精度になる。 */
  it("整数定数は FIXED DEC(桁数,0)", () => {
    expect(dec("7")).toMatchObject({ base: "dec", p: 1, q: 0 });
    expect(dec("123")).toMatchObject({ base: "dec", p: 3, q: 0 });
  });

  it("小数定数は小数部が尺度になる", () => {
    expect(dec("123.45")).toMatchObject({ base: "dec", p: 5, q: 2 });
    expect(dec("6.7")).toMatchObject({ base: "dec", p: 2, q: 1 });
  });
});

describe("加減算の精度規則", () => {
  /**
   * PL/I: p = max(p1-q1, p2-q2) + max(q1,q2) + 1, q = max(q1,q2)
   * DEC(5,2) + DEC(3,1) -> DEC(6,2) になり
   * 130.15 がフィールド幅 9（= p+3）で出力されることと一致する。
   */
  it("DEC(5,2) + DEC(3,1) は DEC(6,2)", () => {
    const r = add(makeFixed("dec", 5, 2, 12345n), makeFixed("dec", 3, 1, 67n));
    expect(r).toMatchObject({ base: "dec", p: 6, q: 2 });
    expect(render(r)).toBe("130.15");
  });

  it("減算も同じ規則", () => {
    const r = sub(makeFixed("dec", 5, 2, 12345n), makeFixed("dec", 3, 1, 67n));
    expect(r).toMatchObject({ p: 6, q: 2 });
    expect(render(r)).toBe("116.75");
  });

  it("整数同士", () => {
    expect(render(add(bin(7), bin(3)))).toBe("10");
    expect(render(sub(bin(7), bin(3)))).toBe("4");
  });
});

describe("乗算の精度規則", () => {
  /** PL/I: p = p1+p2+1, q = q1+q2 */
  it("DEC(5,2) * DEC(3,1) は DEC(9,3)", () => {
    const r = mul(makeFixed("dec", 5, 2, 12345n), makeFixed("dec", 3, 1, 67n));
    expect(r).toMatchObject({ base: "dec", p: 9, q: 3 });
    // 123.45 * 6.7 = 827.115（10進で正確に出る）
    expect(render(r)).toBe("827.115");
  });

  it("浮動小数で代用すると出ない値が正確に出る", () => {
    // 0.1 * 0.2 は2進浮動小数だと 0.020000000000000004 になる
    const r = mul(dec("0.1"), dec("0.2"));
    expect(render(r)).toBe("0.02");
  });

  it("整数同士", () => expect(render(mul(bin(7), bin(3)))).toBe("21"));
});

describe("除算の精度規則", () => {
  /**
   * PL/I: 結果は FIXED(N, N-((p1-q1)+q2))、N は最大精度（DEC=15, BIN=31）。
   * 規定どおりの挙動:
   *   BIN(31,0)/BIN(31,0) -> q=0 なので 7/3 = 2（切り捨て）
   *   BIN(15,0)/BIN(15,0) -> q=16 なので 7/2 = 3.5 を小数付きで出す
   */
  it("BIN(31,0)/BIN(31,0) は整数除算になる", () => {
    const r = div(bin(7), bin(3));
    expect(r).toMatchObject({ base: "bin", p: 31, q: 0 });
    expect(render(r)).toBe("2");
  });

  it("BIN(15,0)/BIN(15,0) は小数尺度を持つ", () => {
    const r = div(bin(7, 15), bin(2, 15));
    expect(r).toMatchObject({ base: "bin", p: 31, q: 16 });
    // 2進尺度16は10進5桁相当（ceil(16*log10 2) = 5）
    expect(render(r)).toBe("3.50000");
  });

  it("0 除算はエラー", () => {
    expect(() => div(bin(1), bin(0))).toThrow();
  });
});

describe("基数が混在した場合", () => {
  /**
   * PL/I では BINARY と DECIMAL が混ざると DECIMAL を BINARY に変換する。
   * これが基数混在のときの挙動を説明する:
   *   f fixed dec(15,0) に対し i fixed bin(31) で f = f * i とすると
   *   12! = 479001600 までは通り、13! = 6227020800 が 2^31-1 を超えて溢れる。
   */
  it("DEC と BIN の混在は BIN になる", () => {
    const r = mul(makeFixed("dec", 15, 0, 100n), bin(3));
    expect(r.base).toBe("bin");
  });

  it("13! で BIN(31) を超えて FIXEDOVERFLOW になる", () => {
    let f = makeFixed("dec", 15, 0, 1n);
    // 12! までは通る
    for (let i = 1; i <= 12; i++) {
      f = mul(f, bin(i));
      f = assignTo(f, "dec", 15, 0);
    }
    expect(render(f)).toBe("479001600");
    expect(() => {
      const g = mul(f, bin(13));
      assignTo(g, "dec", 15, 0);
    }).toThrow(FixedOverflow);
  });
});

/** 代入時の切り詰め（宣言された型へ合わせる）。 */
import { assignTo } from "../src/value.js";

describe("代入時の変換", () => {
  it("尺度を合わせて切り捨てる", () => {
    const r = assignTo(dec("1.999"), "dec", 5, 2);
    expect(render(r)).toBe("1.99");
  });

  it("桁が収まらなければ FIXEDOVERFLOW", () => {
    expect(() => assignTo(dec("12345"), "dec", 3, 0)).toThrow(FixedOverflow);
  });

  it("DEC(15,0) に 15! は収まる", () => {
    const r = assignTo(makeFixed("dec", 20, 0, 1307674368000n), "dec", 15, 0);
    expect(render(r)).toBe("1307674368000");
  });
});

describe("べき乗と符号反転", () => {
  it("2 ** 10", () => expect(render(pow(dec("2"), dec("10")))).toBe("1024"));
  it("単項マイナス", () => expect(render(neg(bin(7)))).toBe("-7"));
  it("負数の加算", () => expect(render(add(neg(bin(7)), bin(3)))).toBe("-4"));
});

describe("比較", () => {
  it("尺度が違っても正しく比べる", () => {
    expect(compare(dec("1.5"), dec("1.50"))).toBe(0);
    expect(compare(dec("1.5"), dec("1.6"))).toBeLessThan(0);
    expect(compare(dec("2"), dec("1.9"))).toBeGreaterThan(0);
  });

  it("基数が違っても比べられる", () => {
    expect(compare(bin(3), dec("3"))).toBe(0);
  });
});

describe("文字への変換", () => {
  it("数値を文字列に連結できる形にする", () => {
    // hanoi.pli の 'move' || f のために必要
    expect(toCharString(bin(1))).toBe("             1");
  });
});
