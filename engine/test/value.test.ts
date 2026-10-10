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

  /*
   * **10 進の最大精度は 15 桁。実機とは意図的に違えている。**
   *
   * 突き合わせに使っている処理系（Iron Spring PL/I 1.4.1）の N は **18** で、
   * `put list(1/3)` が `0.33333333333333333`（小数 17 桁）になる。
   * この処理系は 15 なので `0.33333333333333`（14 桁）。
   *   実機: dcl b fixed dec(18); も受け付け、18 桁をそのまま出す
   *
   * 15 を選んでいるのは、互換の目標が **IBM PL/I for MVS and VM 1.1** で、
   * そこでの FIXED DECIMAL の上限が 15 桁だからである（Iron Spring も MVS 1.1
   * 互換を謳っているが、この点は実機側の拡張）。表明の窓 FIXED DEC(15,5) や
   * 文書の「15 桁」もここに揃えてある。
   *
   * 除算の結果の桁数は N で決まるので、**どんな除算もゴールデンでは
   * バイト一致しない**。だから golden/decimal.pli には除算を入れていない。
   */
  it("DEC の最大精度は 15（実機の 18 ではない）", () => {
    const r = div(fixedFromLiteral("1"), fixedFromLiteral("3"));
    expect(r).toMatchObject({ base: "dec", p: 15, q: 14 });
    expect(render(r)).toBe("0.33333333333333");
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

/**
 * 基数混在。
 *
 * README の表どおり BINARY に変換する（13 の階乗がちょうど溢れることで
 * 裏が取れている）。ただし**尺度も移す**必要がある。
 * 以前は整数尺度（q=0）に落としていたため、`I`〜`N` の暗黙変数
 * （FIXED BIN(15,0)）と小数を混ぜたごく普通のコードで、
 * 小数部が黙って消えていた。比較まで逆の答えを返していた。
 */
describe("基数混在", () => {
  const dec = (v: string) => fixedFromLiteral(v);
  const bin = (v: number) => makeFixed("bin", 15, 0, BigInt(v));

  it("結果は BINARY になる", () => {
    expect(mul(bin(10), dec("1.5")).base).toBe("bin");
  });

  it("小数部を捨てない", () => {
    // 10 * 1.5 = 15。以前は 1.5 を 1 と見て 10 を返していた
    expect(Number(render(mul(bin(10), dec("1.5"))))).toBeCloseTo(15, 6);
    expect(Number(render(add(bin(10), dec("0.5"))))).toBeCloseTo(10.5, 6);
  });

  it("比較が正しい向きになる", () => {
    // 以前は 10 = 10.5 が真、10 < 10.5 が偽だった
    expect(compare(bin(10), dec("10.5"))).toBeLessThan(0);
    expect(compare(bin(10), dec("10.5"))).not.toBe(0);
    expect(compare(bin(11), dec("10.5"))).toBeGreaterThan(0);
  });

  it("2 進尺度は 10 進桁数から決まる（1 桁 ≒ 3.32 ビット）", () => {
    // DEC(2,1) → q = ceil(1 * log2(10)) = 4
    const r = mul(bin(1), dec("1.5"));
    expect(r.q).toBe(4);
  });

  it("2 進で表せない小数は丸められる（混在そのものの性質）", () => {
    // 0.1 は 2 進では循環小数。Linter が mixed-base-arithmetic で
    // 警告するのはこのため
    const r = mul(bin(10), dec("0.1"));
    expect(Number(render(r))).not.toBe(10);
    expect(Number(render(r))).toBeGreaterThan(0.5);
    expect(Number(render(r))).toBeLessThan(2);
  });

  /*
   * 端数の扱いは**実機（Iron Spring PL/I 1.4.1）で確かめた**。
   * `dcl i fixed bin(15); i = 1;` として:
   *   put list(i*0.1)        →  0.06      （四捨五入なら 0.12）
   *   put list((i*0.1)*16)   →  1.00      （四捨五入なら 2.00）
   *   put list((i*0.3)*16)   →  4.00      （四捨五入なら 5.00）
   *   put list((i*(-0.1))*16) → -1.00     （床なら -2.00）
   * 2 進尺度を掛け戻すと蓄えた整数がそのまま見えるので、丸めの向きが分かる。
   */
  it("尺度を移すときの端数は 0 方向へ切り捨てる", () => {
    // DEC(2,1) の 0.1 は q = 4 の 2 進尺度へ移る。0.1 × 2⁴ = 1.6 なので
    // 切り捨てなら 1（0.0625）、四捨五入なら 2（0.125）
    const r = mul(bin(1), dec("0.1"));
    expect(r.q).toBe(4);
    expect(r.v).toBe(1n);
    // 0.3 × 2⁴ = 4.8。四捨五入なら 5
    expect(mul(bin(1), dec("0.3")).v).toBe(4n);
  });

  it("負の値も 0 方向へ切り捨てる（床ではない）", () => {
    // -0.1 × 2⁴ = -1.6。0 方向なら -1、床なら -2
    expect(mul(bin(1), dec("-0.1")).v).toBe(-1n);
    expect(mul(bin(1), dec("-0.3")).v).toBe(-4n);
  });

  it("整数同士は正確（13 の階乗がちょうど溢れる根拠を保つ）", () => {
    let acc = makeFixed("bin", 31, 0, 1n);
    for (let i = 2; i <= 12; i++) acc = mul(acc, dec(String(i)));
    expect(render(acc).trim()).toBe("479001600");
  });
});
