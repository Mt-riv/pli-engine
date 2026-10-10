import { describe, expect, it } from "vitest";
import { ListWriter, fixedBinWidth, fixedDecWidth } from "../src/format.js";
import { runProgram } from "../src/index.js";

/**
 * PUT LIST の出力書式は実在の PL/I 処理系の出力と突き合わせて決めた。
 *
 *   FIXED DEC(p,q) -> フィールド幅 p + 3
 *     DEC(5,2) 123.45  -> "  123.45 "  (幅8 + 空白1)
 *     DEC(3,1) 6.7     -> "   6.7 "    (幅6 + 空白1)
 *     DEC(9,3) 827.115 -> "     827.115 " (幅12 + 空白1)
 *   FIXED BIN(p,0)  -> 10進桁 d = ceil(p*log10(2)) + 1, 幅 d + 3
 *     BIN(31) 10 -> "            10 " (幅14 + 空白1)
 *   項目は24桁ごとのタブストップに配置、行幅(LINESIZE)は120
 */
describe("フィールド幅", () => {
  it("FIXED DEC(p,q) は p+3", () => {
    expect(fixedDecWidth(5)).toBe(8);
    expect(fixedDecWidth(3)).toBe(6);
    expect(fixedDecWidth(9)).toBe(12);
    expect(fixedDecWidth(15)).toBe(18);
    expect(fixedDecWidth(2)).toBe(5);
  });

  it("FIXED BIN(31) は 14、BIN(15) は 9", () => {
    expect(fixedBinWidth(31)).toBe(14);
    expect(fixedBinWidth(15)).toBe(9);
  });
});

describe("ListWriter: 文字データ", () => {
  it("文字列は左詰めで、後ろに空白1個", () => {
    const w = new ListWriter();
    w.putChar("HELLO, PL/I");
    expect(w.text()).toBe("HELLO, PL/I ");
  });

  it("CHAR(n) は宣言長まで空白で埋める", () => {
    // 04-char-ops: dcl s char(10); s='ABC' -> "ABC        " (10桁 + 空白1)
    const w = new ListWriter();
    w.putChar("ABC".padEnd(10));
    expect(w.text()).toBe("ABC        ");
  });

  it("VARYING は実際の長さのまま", () => {
    const w = new ListWriter();
    w.putChar("hello");
    expect(w.text()).toBe("hello ");
  });
});

describe("ListWriter: ビットデータ", () => {
  it("'0'B 形式で出力する", () => {
    // 05-bit-ops: "'0'B " len=5
    const w = new ListWriter();
    w.putBit("0");
    expect(w.text()).toBe("'0'B ");
  });
});

describe("ListWriter: 数値データ", () => {
  it("BIN(31) の 10 は幅14に右詰め", () => {
    const w = new ListWriter();
    w.putNumber("10", fixedBinWidth(31));
    expect(w.text()).toBe("            10 ");
    expect(w.text()).toHaveLength(15);
  });

  it("負数も幅14に収まる", () => {
    const w = new ListWriter();
    w.putNumber("-4", fixedBinWidth(31));
    expect(w.text()).toBe("            -4 ");
  });

  it("DEC(5,2) の 123.45 は幅8", () => {
    const w = new ListWriter();
    w.putNumber("123.45", fixedDecWidth(5));
    expect(w.text()).toBe("  123.45 ");
  });

  it("DEC(4,0) の 14 は幅7", () => {
    // 02-arith: 2+3*4 は定数式で DEC(4,0) になり "     14 " len=8
    const w = new ListWriter();
    w.putNumber("14", fixedDecWidth(4));
    expect(w.text()).toBe("     14 ");
  });
});

describe("ListWriter: タブストップ（24桁）", () => {
  it("2項目目は25桁目から始まる", () => {
    // 10-factorial: put skip list(i, f) で i=DEC(2,0), f=DEC(15,0)
    //   "    1                                    1 " len=43
    const w = new ListWriter();
    w.putNumber("1", fixedDecWidth(2));   // 幅5 -> cols 1-5, 空白 col6
    w.putNumber("1", fixedDecWidth(15));  // cols 25-42, 空白 col43
    const out = w.text();
    expect(out).toHaveLength(43);
    expect(out).toBe("    1".padEnd(24) + "                 1 ");
  });

  it("タブストップの境界をちょうど埋めた場合も次の停止位置へ進む", () => {
    const w = new ListWriter();
    w.putChar("x".repeat(23));  // cols 1-23, 空白 col24
    w.putChar("y");             // 次の停止位置は col25
    expect(w.text()).toBe("x".repeat(23) + " " + "y ");
  });
});

describe("ListWriter: 行幅120での折り返し", () => {
  it("6項目目は折り返され、前の行は120桁まで埋められる", () => {
    // 09-mult-table: put list を9回 -> 1行目120桁(5項目)、2行目87桁(4項目)
    const w = new ListWriter();
    const vals = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    for (const v of vals) w.putNumber(v, fixedBinWidth(31));
    const lines = w.text().split("\n");
    expect(lines[0]).toHaveLength(120);
    expect(lines[1]).toHaveLength(87);
  });

  it("折り返し後の行も24桁のタブストップに従う", () => {
    const w = new ListWriter();
    for (const v of ["1", "2", "3", "4", "5", "6"]) w.putNumber(v, fixedBinWidth(31));
    const lines = w.text().split("\n");
    // 6項目目は2行目の先頭（幅14に右詰め）
    expect(lines[1]).toBe("             6 ");
  });
});

describe("ListWriter: SKIP", () => {
  it("skip は改行を入れる", () => {
    const w = new ListWriter();
    w.skip();
    w.putChar("a");
    expect(w.text()).toBe("\na ");
  });

  it("先頭の put skip list(...) は空行で始まる", () => {
    // 02-arith の出力は "\n            10 \n..." のように空行で始まる
    const w = new ListWriter();
    w.skip();
    w.putNumber("10", fixedBinWidth(31));
    w.skip();
    w.putNumber("4", fixedBinWidth(31));
    expect(w.text().split("\n")).toEqual(["", "            10 ", "             4 "]);
  });

  it("skip(n) は n 行進む", () => {
    const w = new ListWriter();
    w.putChar("a");
    w.skip(2);
    w.putChar("b");
    expect(w.text()).toBe("a \n\nb ");
  });
});

describe("ListWriter: 終端", () => {
  /**
   * プログラム終了時に最終行を改行で終端する。
   * 01-hello の期待出力は "HELLO, PL/I \n" で末尾に改行が付く。
   */
  it("finish は書きかけの行を改行で終端する", () => {
    const w = new ListWriter();
    w.putChar("HELLO, PL/I");
    w.finish();
    expect(w.text()).toBe("HELLO, PL/I \n");
  });

  it("既に改行で終わっていれば二重に足さない", () => {
    const w = new ListWriter();
    w.putChar("a");
    w.skip();
    w.finish();
    expect(w.text()).toBe("a \n");
  });

  it("何も出力していなければ空のまま", () => {
    const w = new ListWriter();
    w.finish();
    expect(w.text()).toBe("");
  });
});

/**
 * EDIT の出力は LIST と違い、24桁タブストップを使わず
 * 書式項目の指定どおりの位置・幅に書く。末尾に空白も足さない。
 *
 * 根拠はEDIT 出力の例:
 *   put skip edit('b: ',b)(a,(9)f(4));
 *   -> "b:    1   2   3   4   5   6   7   8   9"  len=39 = 3 + 9*4
 * （LIST なら末尾に空白が付き、24桁ごとに配置される）
 */
describe("EditWriter: 書式項目", () => {
  it("A は幅を指定しなければデータ長のまま", () => {
    const w = new ListWriter();
    w.editChar("b: ");
    expect(w.text()).toBe("b: ");
  });

  it("A(w) は左詰めで幅 w", () => {
    const w = new ListWriter();
    w.editChar("ab", 5);
    expect(w.text()).toBe("ab   ");
  });

  it("A(w) はデータが長ければ切り詰める", () => {
    const w = new ListWriter();
    w.editChar("abcdef", 3);
    expect(w.text()).toBe("abc");
  });

  it("F(w) は右詰め、末尾空白なし", () => {
    const w = new ListWriter();
    w.editNumber("1", 4);
    w.editNumber("2", 4);
    expect(w.text()).toBe("   1   2");
  });

  it("EDIT で桁を指定した1行を組み立てられる", () => {
    const w = new ListWriter();
    w.editChar("b: ");
    for (const v of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) w.editNumber(v, 4);
    const out = w.text();
    expect(out).toBe("b:    1   2   3   4   5   6   7   8   9");
    expect(out).toHaveLength(39);
  });

  it("負数も幅に収まる", () => {
    const w = new ListWriter();
    w.editChar("b: ");
    for (const v of ["-1", "2", "3"]) w.editNumber(v, 4);
    expect(w.text()).toBe("b:   -1   2   3");
  });

  it("X(w) は空白を置く", () => {
    const w = new ListWriter();
    w.editChar("a");
    w.editX(3);
    w.editChar("b");
    expect(w.text()).toBe("a   b");
  });

  it("COLUMN(n) はその桁まで空白で送る", () => {
    const w = new ListWriter();
    w.editChar("ab");
    w.column(6);
    w.editChar("c");
    expect(w.text()).toBe("ab   c");
  });

  it("COLUMN が現在位置より手前なら改行して送る", () => {
    const w = new ListWriter();
    w.editChar("abcdef");
    w.column(3);
    w.editChar("x");
    expect(w.text()).toBe("abcdef\n  x");
  });

  it("EDIT と LIST は同じ行を共有する", () => {
    const w = new ListWriter();
    w.putChar("x");       // LIST: "x "
    w.editChar("y");      // EDIT: 続けて "y"
    expect(w.text()).toBe("x y");
  });
});

/**
 * F 書式の丸めと桁あふれ。**実機（Iron Spring PL/I 1.4.1）で確かめた。**
 *
 * 丸めは**書式の性質**で、代入の性質ではない。同じ値が通る道で違う:
 *
 * | | `dcl y fixed dec(5,1); y = x;` | `put edit(x)(f(6,1))` |
 * |---|---|---|
 * | 1.26 | 1.2（切り捨て） | 1.3（丸め） |
 * | 1.25 | 1.2 | 1.3（0 から遠い側） |
 * | -1.26 | -1.2 | -1.3 |
 *
 * 同じ経路で実装するとどちらかが必ず間違う（この処理系は実際に
 * `assignTo` を使い回していて、F 書式が切り捨てになっていた）。
 *
 * バイト一致での固定は `test/golden/fmt-round.*` と `fmt-overflow.*`。
 * ここは規則そのものを読めるようにしておく。
 */
describe("F 書式の丸めと桁あふれ", () => {
  const out = (body: string): string =>
    runProgram(`m: proc options(main);\n${body}\nend m;`).stdout;
  const edit = (literal: string, fmt: string): string =>
    out(`  put edit('[', ${literal}, ']')(a, ${fmt}, a);`);

  it("小数部は 0 から遠い側へ丸める（切り捨てではない）", () => {
    expect(edit("1.26", "f(6,1)")).toBe("[   1.3]\n");
    expect(edit("1.24", "f(6,1)")).toBe("[   1.2]\n");
  });

  it("ちょうど半分は 0 から遠い側（偶数側ではない）", () => {
    expect(edit("1.25", "f(6,1)")).toBe("[   1.3]\n");
    expect(edit("1.35", "f(6,1)")).toBe("[   1.4]\n");
  });

  it("負の値も 0 から遠い側へ丸める", () => {
    expect(edit("-1.26", "f(6,1)")).toBe("[  -1.3]\n");
    expect(edit("-1.25", "f(6,1)")).toBe("[  -1.3]\n");
  });

  it("小数部の指定が無ければ 0 桁（丸めて整数にする）", () => {
    // 以前は値をそのまま出していた（1.99 → "1.99"）
    expect(edit("1.99", "f(4)")).toBe("[   2]\n");
    expect(edit("1.49", "f(4)")).toBe("[   1]\n");
  });

  it("指定が値より細かければ 0 を足す", () => {
    expect(edit("1.5", "f(6,3)")).toBe("[ 1.500]\n");
    expect(edit("12", "f(6,2)")).toBe("[ 12.00]\n");
  });

  it("代入は切り捨てのまま（丸めるのは書式だけ）", () => {
    expect(
      out(
        "  dcl x fixed dec(5,2);\n  dcl y fixed dec(5,1);\n" +
          "  x = 1.26;\n  y = x;\n  put list(y);",
      ).trim(),
    ).toBe("1.2");
  });

  it("幅に収まらない値は右から w 文字を残す（上位桁が黙って落ちる）", () => {
    expect(edit("123456", "f(3)")).toBe("[456]\n");
    // 符号も落ちる。実機も同じ（-12345 を f(4) で 2345）
    expect(edit("-12345", "f(4)")).toBe("[2345]\n");
  });
});
