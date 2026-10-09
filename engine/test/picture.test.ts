/**
 * PICTURE 属性。
 *
 * 編集の規則は PL/I の規定に従う。
 */
import { describe, expect, it } from "vitest";
import {
  editPicture,
  parsePicture,
  uneditPicture,
  PictureError,
  PictureSizeError,
} from "../src/picture.js";
import { fixedFromLiteral } from "../src/value.js";
import { runProgram } from "../src/index.js";

/** ピクチャで編集した結果。 */
function ed(picture: string, value: string): string {
  return editPicture(parsePicture(picture), fixedFromLiteral(value));
}

describe("parsePicture", () => {
  it("桁数と小数桁を数える", () => {
    const s = parsePicture("$$$,$$9V.99");
    expect(s.p).toBe(7); // 浮動記号 5 個 = 数字 4 桁 + 9 が 1 桁 + 小数 2 桁
    expect(s.q).toBe(2);
    expect(s.width).toBe(10);
  });

  it("V は文字を占めない", () => {
    expect(parsePicture("9V99").width).toBe(3);
    expect(parsePicture("9V99").q).toBe(2);
  });

  it("浮動記号は 1 個なら固定、2 個以上で浮動", () => {
    expect(parsePicture("$999").p).toBe(3);
    expect(parsePicture("$$99").p).toBe(3); // $ 2 個 = 記号 + 数字 1 桁
  });

  it("浮動記号の間の挿入文字は列の一部", () => {
    // $$$,$$9 は 1 つの浮動記号列。カンマで切れたりしない
    expect(parsePicture("$$$,$$9").p).toBe(5);
  });

  it("数字の位置が無ければ誤り", () => {
    expect(() => parsePicture("$$")).not.toThrow(); // $$ は数字 1 桁
    expect(() => parsePicture("..")).toThrow(PictureError);
  });

  it("V は 1 つだけ", () => {
    expect(() => parsePicture("9V9V9")).toThrow(PictureError);
  });

  it("対応しない文字は誤りとして知らせる", () => {
    expect(() => parsePicture("A(3)")).toThrow(PictureError);
    expect(() => parsePicture("9E99")).toThrow(PictureError);
  });

  it("桁数の上限を超えたら誤り", () => {
    expect(() => parsePicture("9".repeat(16))).toThrow(PictureError);
  });
});

describe("ゼロ抑制", () => {
  it("Z は先行ゼロを空白にする", () => {
    expect(ed("ZZZ9", "42")).toBe("  42");
    expect(ed("ZZZ9", "0")).toBe("   0");
  });

  it("全桁が Z なら値 0 は全部空白", () => {
    expect(ed("ZZZZ", "0")).toBe("    ");
    expect(ed("ZZZZ", "7")).toBe("   7");
  });

  it("9 はゼロも表示する", () => {
    expect(ed("9999", "42")).toBe("0042");
  });

  it("* は先行ゼロを * にする（小切手の桁埋め）", () => {
    expect(ed("**,**9V.99", "12.3")).toBe("****12.30");
  });

  it("抑制された範囲の挿入文字も詰め文字になる", () => {
    expect(ed("ZZ,ZZ9", "123")).toBe("   123");
  });
});

describe("通貨記号と符号", () => {
  it("浮動する $ は最初の有効数字の直前に付く", () => {
    expect(ed("$$$9V.99", "12.3")).toBe(" $12.30");
    expect(ed("$$$,$$9V.99", "1234.5")).toBe(" $1,234.50");
    expect(ed("$$$,$$9V.99", "0.07")).toBe("     $0.07");
  });

  it("S は常に符号を出す", () => {
    expect(ed("S999", "5")).toBe("+005");
    expect(ed("S999", "-5")).toBe("-005");
  });

  it("+ は正のときだけ、- は負のときだけ出す", () => {
    expect(ed("+999", "5")).toBe("+005");
    expect(ed("+999", "-5")).toBe(" 005");
    expect(ed("-999", "5")).toBe(" 005");
    expect(ed("-999", "-5")).toBe("-005");
  });

  it("浮動する符号も最初の有効数字の直前に付く", () => {
    expect(ed("---9", "-12")).toBe(" -12");
    expect(ed("---9", "12")).toBe("  12");
  });

  it("CR / DB は負のときだけ出る", () => {
    expect(ed("$$$9V.99CR", "-12.3")).toBe(" $12.30CR");
    expect(ed("$$$9V.99CR", "12.3")).toBe(" $12.30  ");
    expect(ed("ZZZ9DB", "-1")).toBe("   1DB");
  });
});

describe("挿入文字", () => {
  it("小数点とカンマはそのまま置かれる", () => {
    expect(ed("9V.999", "1.5")).toBe("1.500");
    expect(ed("9,999", "1234")).toBe("1,234");
  });

  it("スラッシュで日付の形にできる", () => {
    expect(ed("99/99/99", "123125")).toBe("12/31/25");
  });

  it("B は空白になる", () => {
    expect(ed("99B99", "1234")).toBe("12 34");
  });
});

describe("桁あふれ", () => {
  it("収まらない値は SIZE として知らせる", () => {
    expect(() => ed("ZZ9", "1234")).toThrow(PictureSizeError);
  });

  it("小数は切り捨てる", () => {
    expect(ed("9V.9", "1.26")).toBe("1.2");
  });
});

describe("uneditPicture", () => {
  it("編集文字を外して数値にする", () => {
    const spec = parsePicture("$$$,$$9V.99");
    expect(uneditPicture(" $1,234.50", spec)).toBe("1234.50");
  });

  it("CR は負の数", () => {
    const spec = parsePicture("ZZZ9V.99CR");
    expect(uneditPicture("  12.30CR", spec)).toBe("-12.30");
  });
});

describe("プログラムの中の PICTURE", () => {
  const run = (body: string) =>
    runProgram(`p: proc options(main);\n${body}\nend p;\n`);

  it("宣言して代入し、編集された形で出力される", () => {
    const r = run(`  dcl amt pic'$$$,$$9V.99';
  amt = 1234.5;
  put list(amt);`);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("$1,234.50");
  });

  it("算術に使える。結果を代入すると再び編集される", () => {
    const r = run(`  dcl amt pic'$$$,$$9V.99';
  amt = 100;
  amt = amt * 3 + 0.5;
  put list(amt);`);
    expect(r.stdout.trim()).toBe("$300.50");
  });

  it("CHAR への代入でも編集した形になる", () => {
    const r = run(`  dcl amt pic'$$$,$$9V.99';
  dcl memo char(30) varying;
  amt = 1234.5;
  memo = amt;
  put list('[' || memo || ']');`);
    expect(r.stdout.trim()).toBe("[ $1,234.50]");
  });

  it("文字列との連結では編集した形になる", () => {
    const r = run(`  dcl amt pic'ZZZ9V.99';
  dcl memo char(30) varying;
  amt = 12.5;
  memo = 'total=' || amt;
  put list(memo);`);
    expect(r.stdout.trim()).toBe("total=  12.50");
  });

  it("GET で編集された文字列を読める", () => {
    const r = run(`  dcl amt pic'$$$9V.99';
  get string(' $12.30') list(amt);
  put list(amt);`);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("$12.30");
  });

  it("桁に収まらない代入は SIZE 条件になる", () => {
    const r = run(`  dcl amt pic'ZZ9';
  on size put list('あふれました');
  amt = 1234;
  put skip list(amt);`);
    expect(r.stdout).toContain("あふれました");
  });

  it("使えないピクチャは診断で知らせる", () => {
    const r = run(`  dcl x pic'A(3)';
  x = 1;`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("PICTURE");
  });
});
