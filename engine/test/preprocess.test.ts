import { describe, expect, it } from "vitest";
import { lex } from "../src/lexer.js";
import { preprocess } from "../src/preprocess.js";

const words = (src: string) =>
  preprocess(lex(src)).map((t) => t.text).filter((t) => t !== "");

/**
 * この処理系が扱うプリプロセッサ文は %INCLUDE と %REPLACE、
 * および一覧制御の %PAGE / %SKIP / %PRINT / %NOPRINT。
 * %INCLUDE の検証は include.test.ts にある。
 */
describe("%REPLACE", () => {
  it("識別子を定数に置き換える", () => {
    expect(words("%replace LIMIT by 3; x = LIMIT;")).toEqual(["x", "=", "3", ";"]);
  });

  it("文字列定数にも置き換えられる", () => {
    const ts = preprocess(lex("%replace G by 'hi'; put list(G);"));
    const str = ts.find((t) => t.kind === "string");
    expect(str?.value).toBe("hi");
  });

  it("大文字小文字を区別しない", () => {
    expect(words("%replace Limit by 3; x = LIMIT + limit;")).toEqual([
      "x", "=", "3", "+", "3", ";",
    ]);
  });

  it("文字列リテラルの中は置き換えない", () => {
    const ts = preprocess(lex("%replace A by 9; put list('A');"));
    const str = ts.find((t) => t.kind === "string");
    expect(str?.value).toBe("A");
  });

  it("複数の %replace を扱える", () => {
    expect(words("%replace A by 1; %replace B by 2; x = A + B;")).toEqual([
      "x", "=", "1", "+", "2", ";",
    ]);
  });

  it("定義より前の出現は置き換えない（宣言位置から有効）", () => {
    // %REPLACE の有効範囲はその出現位置から末尾まで
    expect(words("x = A; %replace A by 1; y = A;")).toEqual([
      "x", "=", "A", ";", "y", "=", "1", ";",
    ]);
  });
});

describe("一覧制御文", () => {
  it("%PAGE / %SKIP / %PRINT / %NOPRINT は取り除かれる", () => {
    expect(words("%page; x = 1; %skip(2); y = 2; %print; %noprint;")).toEqual([
      "x", "=", "1", ";", "y", "=", "2", ";",
    ]);
  });
});

describe("未対応のプリプロセッサ文", () => {
  it("%DECLARE などはエラーにする", () => {
    expect(() => preprocess(lex("%declare x character;"))).toThrow(/未対応|未実装/);
  });
});
