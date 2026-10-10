/**
 * 画面の器（`device.ts`）と出力の経路（`output.ts`）、
 * テキスト起こし（`render.ts`）。
 *
 * 期待値の出どころは IBM の仕様文書（実機の出力ではない）。
 * 特に次の 2 つは仕様に明記された規則なので、そのまま固定する。
 *
 *   - `POS=` と `LTH=` は属性バイトを数えない。属性バイトは項目の
 *     1 つ前の位置を食う（1 桁目から始まる項目は前の行の末尾を食う）
 *   - 定義された項目が 2 桁以上あいていると、MFS が隙間を表す項目を
 *     作る。その属性は NUM・PROT・NODISP
 */
import { describe, expect, it } from "vitest";
import { loadMfs } from "../src/mfs/source.js";
import { MfsBlockError } from "../src/mfs/blocks.js";
import { blankScreen, fieldNamed, layout, rowText } from "../src/mfs/device.js";
import { formatOutput, modNameFor, systemLiteral } from "../src/mfs/output.js";
import { renderScreen } from "../src/mfs/render.js";

const SMALL = `SMALL    FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE
         DIV   TYPE=INOUT
         DPAGE CURSOR=((2,10))
         DFLD  'NAME:',POS=(2,2)
NAMEF    DFLD  POS=(2,10),LTH=6,ATTR=(ALPHA,NOPROT)
         FMTEND
SMALLO   MSG   TYPE=OUTPUT,SOR=SMALL
         SEG
         MFLD  NAMEF,LTH=6
         MSGEND
`;

const small = () => loadMfs({ "s.mfs": SMALL });

/** 1 つの書式と 1 つの MOD を組み立てる小道具。 */
function build(fmtBody: string, msgBody: string, dpage = "         DPAGE") {
  return loadMfs({
    "t.mfs":
      `F        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n${dpage}\n` +
      `${fmtBody}         FMTEND\nM        MSG   TYPE=OUTPUT,SOR=F\n         SEG\n` +
      `${msgBody}         MSGEND\n`,
  });
}

const NOW = new Date(2026, 9, 10, 15, 4, 5);
const opts = { now: NOW, lterm: "TERM0001" };

describe("画面の器", () => {
  it("固定文字は最初から入っている", () => {
    const lib = small();
    const screen = blankScreen(lib.dof("SMALL"), lib.dof("SMALL").dpages[0]!);
    expect(fieldNamed(screen, "NAMEF")!.text).toBe("");
    expect(rowText(screen, 2)).toBe(" NAME:");
  });

  it("2 桁以上あいた隙間に NUM PROT NODISP の項目ができる", () => {
    const lib = small();
    const fields = layout(lib.dof("SMALL"), lib.dof("SMALL").dpages[0]!);
    const gap = fields.find((f) => f.generated)!;
    expect([gap.line, gap.col, gap.length]).toEqual([2, 8, 1]);
    expect(gap.attr).toEqual({
      numeric: true,
      protect: true,
      display: "none",
      modified: false,
    });
  });

  it("隙間が 1 桁なら作らない（属性バイトで埋まるため）", () => {
    const lib = build(
      `A        DFLD  POS=(2,2),LTH=5\nB        DFLD  POS=(2,9),LTH=3\n`,
      `         MFLD  A,LTH=5\n`,
    );
    const fields = layout(lib.dof("F"), lib.dof("F").dpages[0]!);
    expect(fields.filter((f) => f.generated)).toHaveLength(0);
  });

  it("属性バイトを含めて重なるなら断る", () => {
    expect(() =>
      build(`A        DFLD  POS=(2,2),LTH=5\nB        DFLD  POS=(2,7),LTH=3\n`, `         MFLD  A,LTH=5\n`),
    ).toThrow(/前の項目と重なります/);
  });

  it("1 桁目から始まる項目の属性バイトは前の行の末尾を食う", () => {
    // 1 行目の 80 桁（最後）に項目を置くと、2 行 1 桁の項目と重なる
    expect(() =>
      build(
        `A        DFLD  POS=(1,80),LTH=1\nB        DFLD  POS=(2,1),LTH=3\n`,
        `         MFLD  A,LTH=1\n`,
      ),
    ).toThrow(/前の項目と重なります/);
  });
});

describe("出力（MOD + DOF → 画面）", () => {
  it("セグメントが項目に切り分けられる", () => {
    const screen = formatOutput(small(), "SMALLO", ["ABC"], opts);
    expect(fieldNamed(screen, "NAMEF")!.text).toBe("ABC   ");
    expect(rowText(screen, 2)).toBe(" NAME:   ABC");
  });

  it("JUST と FILL で詰める", () => {
    const lib = build(
      `A        DFLD  POS=(1,2),LTH=6\nB        DFLD  POS=(2,2),LTH=6\n`,
      `         MFLD  A,LTH=3,JUST=L\n         MFLD  B,LTH=3,JUST=R\n`,
      `         DPAGE FILL=C'.'`,
    );
    const screen = formatOutput(lib, "M", ["abcxyz"], opts);
    expect(fieldNamed(screen, "A")!.text).toBe("abc...");
    expect(fieldNamed(screen, "B")!.text).toBe("...xyz");
  });

  it("FILL を書かなければ空白で埋める", () => {
    const lib = build(
      `A        DFLD  POS=(1,2),LTH=6\n`,
      `         MFLD  A,LTH=3\n`,
    );
    expect(fieldNamed(formatOutput(lib, "M", ["ab"], opts), "A")!.text).toBe("ab    ");
  });

  it("長すぎれば切る（L は右を落とし、R は左を落とす）", () => {
    const lib = build(
      `A        DFLD  POS=(1,2),LTH=4\nB        DFLD  POS=(2,2),LTH=4\n`,
      `         MFLD  A,LTH=8,JUST=L\n         MFLD  B,LTH=8,JUST=R\n`,
    );
    const screen = formatOutput(lib, "M", ["12345678abcdefgh"], opts);
    expect(fieldNamed(screen, "A")!.text).toBe("1234");
    expect(fieldNamed(screen, "B")!.text).toBe("efgh");
  });

  it("セグメントが短ければ、その先の項目は空のまま", () => {
    const lib = build(
      `A        DFLD  POS=(1,2),LTH=4\nB        DFLD  POS=(2,2),LTH=4\n`,
      `         MFLD  A,LTH=4\n         MFLD  B,LTH=4\n`,
    );
    const screen = formatOutput(lib, "M", ["ab"], opts);
    expect(fieldNamed(screen, "A")!.text).toBe("ab  ");
    expect(fieldNamed(screen, "B")!.text).toBe("    ");
  });

  it("セグメントが定義より多ければ断る", () => {
    expect(() => formatOutput(small(), "SMALLO", ["A", "B"], opts)).toThrow(MfsBlockError);
    expect(() => formatOutput(small(), "SMALLO", ["A", "B"], opts)).toThrow(/1 個ですが、2 個/);
  });

  it("MID を MOD として使おうとすれば断る", () => {
    const lib = loadMfs({
      "s.mfs": SMALL + `SMALLI   MSG   TYPE=INPUT,SOR=SMALL\n         MFLD  NAMEF,LTH=6\n         MSGEND\n`,
    });
    expect(() => formatOutput(lib, "SMALLI", ["A"], opts)).toThrow(/MID/);
  });

  it("場所取りの MFLD はセグメントを読み飛ばすだけ", () => {
    const lib = build(
      `A        DFLD  POS=(1,2),LTH=4\n`,
      `         MFLD  ,LTH=2\n         MFLD  A,LTH=4\n`,
    );
    expect(fieldNamed(formatOutput(lib, "M", ["XXabcd"], opts), "A")!.text).toBe("abcd");
  });
});

describe("システム定数", () => {
  it("渡した時刻から作る（内部で現在時刻を見ない）", () => {
    expect(systemLiteral("DATE1", opts)).toBe("26.283");
    expect(systemLiteral("DATE2", opts)).toBe("10/10/26");
    expect(systemLiteral("DATE3", opts)).toBe("10/10/26");
    expect(systemLiteral("DATE4", opts)).toBe("26/10/10");
    expect(systemLiteral("TIME", opts)).toBe("15:04:05");
    expect(systemLiteral("LTNAME", opts)).toBe("TERM0001");
  });

  it("DATE3 と DATE4 は並びが違う", () => {
    const o = { now: new Date(2026, 0, 2, 0, 0, 0), lterm: "T" };
    expect(systemLiteral("DATE2", o)).toBe("01/02/26");
    expect(systemLiteral("DATE3", o)).toBe("02/01/26");
    expect(systemLiteral("DATE4", o)).toBe("26/01/02");
    expect(systemLiteral("DATE1", o)).toBe("26.002");
  });

  it("項目へ入る", () => {
    const lib = build(
      `D        DFLD  POS=(1,2),LTH=8\n`,
      `         MFLD  (D,DATE2)\n`,
    );
    expect(fieldNamed(formatOutput(lib, "M", [""], opts), "D")!.text).toBe("10/10/26");
  });
});

describe("ATTR=YES（プログラムが属性を書く）", () => {
  const lib = () =>
    build(
      `A        DFLD  POS=(1,2),LTH=4,ATTR=(ALPHA,PROT)\n`,
      `         MFLD  A,LTH=4,ATTR=YES\n`,
    );
  const seg = (b0: number, b1: number) => String.fromCharCode(b0, b1) + "abcd";

  it("2 バイト目の先頭ビットが立っていなければ指定なし（DOF のまま）", () => {
    const f = fieldNamed(formatOutput(lib(), "M", ["  abcd"], opts), "A")!;
    expect(f.attr.protect).toBe(true);
    expect(f.text).toBe("abcd");
  });

  it("置き換え（2 ビット目）では DOF の属性を捨てる", () => {
    // X'80' 指定あり + X'40' 置き換え → 保護も強調も指定どおり
    const f = fieldNamed(formatOutput(lib(), "M", [seg(0x00, 0xc0)], opts), "A")!;
    expect(f.attr).toEqual({
      numeric: false,
      protect: false,
      display: "norm",
      modified: false,
    });
  });

  it("論理和では DOF の属性に足す", () => {
    // X'88' = 指定あり + 強調。置き換えではないので PROT は残る
    const f = fieldNamed(formatOutput(lib(), "M", [seg(0x00, 0x88)], opts), "A")!;
    expect(f.attr.protect).toBe(true);
    expect(f.attr.display).toBe("hi");
  });

  it("数字と保護を指定できる", () => {
    const f = fieldNamed(formatOutput(lib(), "M", [seg(0x00, 0xf0)], opts), "A")!;
    expect(f.attr.numeric).toBe(true);
    expect(f.attr.protect).toBe(true);
  });

  it("1 バイト目の先頭 2 ビットが 11 なら、その項目にカーソルが来る", () => {
    const screen = formatOutput(lib(), "M", [seg(0xc0, 0x80)], opts);
    expect(screen.cursor).toEqual({ line: 1, col: 2 });
  });
});

describe("MOD 名の決め方", () => {
  it("ISRT の指定が優先、無ければ MID の NXT=", () => {
    const lib = loadMfs({
      "s.mfs": SMALL + `SMALLI   MSG   TYPE=INPUT,SOR=SMALL,NXT=SMALLO\n         MFLD  NAMEF,LTH=6\n         MSGEND\n`,
    });
    const mid = lib.mid("SMALLI");
    expect(modNameFor("OTHER   ", mid)).toBe("OTHER");
    expect(modNameFor(undefined, mid)).toBe("SMALLO");
    expect(modNameFor("        ", mid)).toBe("SMALLO");
  });

  it("どちらも無ければ断る", () => {
    expect(() => modNameFor(undefined, undefined)).toThrow(/出力の書式が決まりません/);
  });
});

describe("テキスト起こし", () => {
  it("画面像・カーソル・警報・項目が 1 本のテキストになる", () => {
    const screen = formatOutput(small(), "SMALLO", ["ABC"], opts);
    expect(renderScreen(screen)).toBe(
      "書式 SMALL（24 行 × 80 桁）\n" +
        "   |----+----1----+----2----+----3----+----4----+----5----+----6----+----7----+----8\n" +
        " 2 | NAME:   ABC\n" +
        "カーソル (2,10)\n" +
        "警報 なし\n" +
        "消去 なし\n" +
        "項目\n" +
        '  (固定)   (2,2)       5 桁  ALPHA NOPROT NORM  "NAME:"\n' +
        '  NAMEF    (2,10)      6 桁  ALPHA NOPROT NORM  "ABC"\n',
    );
  });

  it("DSCA の指示も出す", () => {
    const lib = loadMfs({
      "d.mfs":
        `F        FMT\n         DEV   TYPE=3270-A2,DSCA=X'00D0'\n         DIV   TYPE=OUTPUT\n` +
        `A        DFLD  POS=(1,2),LTH=3\n         FMTEND\n` +
        `M        MSG   TYPE=OUTPUT,SOR=F\n         MFLD  A,LTH=3\n         MSGEND\n`,
    });
    const text = renderScreen(formatOutput(lib, "M", ["xyz"], opts));
    expect(text).toContain("警報 鳴らす\n");
    expect(text).toContain("消去 画面全部\n");
  });

  it("何も無い行は出さない（出すこともできる）", () => {
    const screen = formatOutput(small(), "SMALLO", ["ABC"], opts);
    expect(renderScreen(screen).split("\n").filter((l) => /^ *\d+ \|/.test(l))).toHaveLength(1);
    expect(
      renderScreen(screen, { blankLines: true }).split("\n").filter((l) => /^ *\d+ \|/.test(l)),
    ).toHaveLength(24);
  });
});
