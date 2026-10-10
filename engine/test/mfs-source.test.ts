/**
 * MFS の書式定義を読む層。
 *
 * ここで固定するのは**実機の規則のうち、書いたとおりに動くかどうかが
 * 利用者から見える部分**。扱えないものを黙って既定値に落とさず、
 * 名指しで断ることも併せて固定する（断らないと、書いた属性が
 * 効いていないことに気づけない）。
 *
 * 期待値の出どころは IBM の仕様文書（実機の出力ではない）。
 * IMS は z/OS 専用で、手元に突き合わせる処理系が無い。
 */
import { describe, expect, it } from "vitest";
import { loadMfs, parseMfs } from "../src/mfs/source.js";
import { MfsBlockError, MfsDefError } from "../src/mfs/blocks.js";

const FMT = `INVFMT   FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE,PFK=(PFKEY,3='/EXIT     ')
         DIV   TYPE=INOUT
         DPAGE CURSOR=((5,20))
         DFLD  '在庫照会',POS=(1,30)
ITEMIN   DFLD  POS=(5,20),LTH=6,ATTR=(NUM,NOPROT,HI)
NAMEOUT  DFLD  POS=(7,20),LTH=20,ATTR=(ALPHA,PROT)
PFKEY    DFLD  POS=(24,2),LTH=10
SYSDATE  DFLD  POS=(1,2),LTH=8,ATTR=(PROT)
         FMTEND
`;

const MSG = `INVIN    MSG   TYPE=INPUT,SOR=(INVFMT,IGNORE),NXT=INVOUT
         SEG
         MFLD  (PFKEY,'INVQ      '),LTH=10
         MFLD  ITEMIN,LTH=6,JUST=R,FILL=C'0'
         MSGEND
INVOUT   MSG   TYPE=OUTPUT,SOR=(INVFMT,IGNORE),NXT=INVIN
         SEG
         MFLD  NAMEOUT,LTH=20
         MFLD  (SYSDATE,DATE2)
         MSGEND
`;

describe("書式定義（FMT → DIF / DOF）", () => {
  it("DEV TYPE から画面の大きさが決まる", () => {
    const { formats } = parseMfs(FMT, "INVFMT.mfs");
    expect(formats).toHaveLength(1);
    expect(formats[0]!.rows).toBe(24);
    expect(formats[0]!.cols).toBe(80);
    expect(formats[0]!.div).toBe("INOUT");
  });

  it("固定文字だけの項目は名前を持たず、長さは文字の長さになる", () => {
    const dflds = parseMfs(FMT, "f.mfs").formats[0]!.dpages[0]!.dflds;
    const title = dflds[0]!;
    expect(title.name).toBeUndefined();
    expect(title.literal).toBe("在庫照会");
    expect(title.length).toBe(4);
    expect(title.line).toBe(1);
    expect(title.col).toBe(30);
  });

  it("ATTR を省くと ALPHA・NOPROT・NORM・NOMOD（IBM の規定）", () => {
    const dflds = parseMfs(FMT, "f.mfs").formats[0]!.dpages[0]!.dflds;
    const pfkey = dflds.find((d) => d.name === "PFKEY")!;
    expect(pfkey.attr).toEqual({
      numeric: false,
      protect: false,
      display: "norm",
      modified: false,
    });
  });

  it("ATTR は書いたものだけが既定から変わる", () => {
    const dflds = parseMfs(FMT, "f.mfs").formats[0]!.dpages[0]!.dflds;
    expect(dflds.find((d) => d.name === "ITEMIN")!.attr).toEqual({
      numeric: true,
      protect: false,
      display: "hi",
      modified: false,
    });
  });

  it("CURSOR と PFK を読む", () => {
    const fmt = parseMfs(FMT, "f.mfs").formats[0]!;
    expect(fmt.dpages[0]!.cursor).toEqual({ line: 5, col: 20 });
    expect(fmt.pfk.get(3)).toEqual({ dfld: "PFKEY", literal: "/EXIT     " });
  });

  it("DSCA の印を読む（X'00A0' は打ち込める項目を消す / X'00C0' は全部消す）", () => {
    const of = (dsca: string) =>
      parseMfs(
        `F        FMT\n         DEV   TYPE=3270-A2,DSCA=${dsca}\n         DIV   TYPE=INOUT\n` +
          `A        DFLD  POS=(1,2),LTH=4\n         FMTEND\n`,
        "f.mfs",
      ).formats[0]!.dsca;
    expect(of("X'00A0'")).toEqual({ eraseAll: false, eraseUnprotected: true, alarm: false });
    expect(of("X'00C0'")).toEqual({ eraseAll: true, eraseUnprotected: false, alarm: false });
    expect(of("X'00B0'").alarm).toBe(true);
  });
});

describe("メッセージ記述（MSG → MID / MOD）", () => {
  it("MFLD は宣言順に並び、長さと詰め方を持つ", () => {
    const { messages } = parseMfs(MSG, "m.mfs");
    const mid = messages.find((m) => m.name === "INVIN")!;
    expect(mid.type).toBe("INPUT");
    expect(mid.sor).toBe("INVFMT");
    expect(mid.next).toBe("INVOUT");
    const mflds = mid.lpages[0]!.segs[0]!.mflds;
    expect(mflds).toHaveLength(2);
    expect(mflds[0]!.source).toEqual({ kind: "dfld-literal", name: "PFKEY", text: "INVQ      " });
    expect(mflds[1]!).toMatchObject({ length: 6, just: "R", fill: { kind: "char", c: "0" } });
  });

  it("SEG を書かなくても 1 つのセグメントになる", () => {
    const { messages } = parseMfs(
      `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=3\n         MSGEND\n`,
      "m.mfs",
    );
    expect(messages[0]!.lpages[0]!.segs[0]!.mflds).toHaveLength(1);
  });

  it("システム定数は長さを自分で決める", () => {
    const mod = parseMfs(MSG, "m.mfs").messages.find((m) => m.name === "INVOUT")!;
    const last = mod.lpages[0]!.segs[0]!.mflds[1]!;
    expect(last.source).toEqual({ kind: "system", name: "SYSDATE", which: "DATE2" });
    expect(last.length).toBe(8);
  });

  it("ATTR=YES は長さに 2 バイト足す（プログラムが属性を書けるため）", () => {
    const mod = parseMfs(
      `M        MSG   TYPE=OUTPUT,SOR=F\n         MFLD  A,LTH=8,ATTR=YES\n         MSGEND\n`,
      "m.mfs",
    ).messages[0]!;
    const f = mod.lpages[0]!.segs[0]!.mflds[0]!;
    expect(f.length).toBe(10);
    expect(f.attrBytes).toBe(true);
  });
});

describe("DO / ENDDO", () => {
  it("DFLD を繰り返し、ラベルに通し番号を付け、位置をずらす", () => {
    const fmt = parseMfs(
      `F        FMT
         DEV   TYPE=3270-A2
         DIV   TYPE=INOUT
         DPAGE
         DO    3,1,0
ITEM     DFLD  POS=(5,10),LTH=6
         ENDDO
         FMTEND
`,
      "f.mfs",
    ).formats[0]!;
    expect(fmt.dpages[0]!.dflds.map((d) => [d.name, d.line, d.col])).toEqual([
      ["ITEM01", 5, 10],
      ["ITEM02", 6, 10],
      ["ITEM03", 7, 10],
    ]);
  });

  it("MFLD 側の繰り返しは DFLD 側と同じ名前になる（SUF の既定は 01）", () => {
    const msg = parseMfs(
      `M        MSG   TYPE=INPUT,SOR=F
         SEG
         DO    2
         MFLD  ITEM,LTH=6
         ENDDO
         MSGEND
`,
      "m.mfs",
    ).messages[0]!;
    expect(msg.lpages[0]!.segs[0]!.mflds.map((f) => f.source)).toEqual([
      { kind: "dfld", name: "ITEM01" },
      { kind: "dfld", name: "ITEM02" },
    ]);
  });

  it("SUF で通し番号の始まりを変えられる", () => {
    const msg = parseMfs(
      `M        MSG   TYPE=INPUT,SOR=F\n         DO    2,SUF=05\n         MFLD  A,LTH=1\n` +
        `         ENDDO\n         MSGEND\n`,
      "m.mfs",
    ).messages[0]!;
    expect(msg.lpages[0]!.segs[0]!.mflds.map((f) => f.source)).toEqual([
      { kind: "dfld", name: "A05" },
      { kind: "dfld", name: "A06" },
    ]);
  });

  it("入れ子は断る", () => {
    expect(() =>
      parseMfs(
        `M        MSG   TYPE=INPUT,SOR=F\n         DO    2\n         DO    2\n` +
          `         MFLD  A,LTH=1\n         ENDDO\n         ENDDO\n         MSGEND\n`,
        "m.mfs",
      ),
    ).toThrow(/DO の入れ子は未実装/);
  });

  /**
   * 位置オペランドを**カンマを続けて**省く書き方。
   *
   * アセンブラのマクロ命令の常識的な書き方で、`DO 3,,5` は
   * 「回数 3 / 行の増分は既定 / 桁の増分 5」。空を落として詰めると
   * 5 が行の増分に入り、**横に並べたい項目が縦に並ぶ**。
   * 誤りも出ないので気づけない。
   */
  it("DO 3,,5 は桁の増分（カンマを続けて位置を省ける）", () => {
    const fields = (doLine: string) =>
      parseMfs(
        `F        FMT
         DEV   TYPE=3270-A2
         DIV   TYPE=INOUT
         DPAGE
         DO    ${doLine}
A        DFLD  POS=(4,10),LTH=4
         ENDDO
         FMTEND
`,
        "f.mfs",
      ).formats[0]!.dpages[0]!.dflds.map((d) => [d.name, d.line, d.col]);

    expect(fields("3,,5")).toEqual([
      ["A01", 4, 10],
      ["A02", 4, 15],
      ["A03", 4, 20],
    ]);
    // 0 を明示したときと同じ
    expect(fields("3,0,5")).toEqual(fields("3,,5"));
    // 行の増分だけを書いた形は従来どおり
    expect(fields("2,1")).toEqual([
      ["A01", 4, 10],
      ["A02", 5, 10],
    ]);
  });

  it("位置オペランドが 4 つ以上あれば断る", () => {
    expect(() =>
      parseMfs(
        `F        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n` +
          `         DPAGE\n         DO    3,1,0,9\nA        DFLD  POS=(4,10),LTH=4\n` +
          `         ENDDO\n         FMTEND\n`,
        "f.mfs",
      ),
    ).toThrow(/位置オペランドは 3 つまで/);
  });
});

describe("断るもの", () => {
  const bad = (text: string): () => unknown => () => parseMfs(text, "x.mfs");

  it("MFS の文でない命令", () => {
    expect(bad("         FOO   BAR=1\n")).toThrow(/MFS の定義文ではありません/);
  });

  it("DFLD に POS が無い", () => {
    expect(
      bad(`F        FMT\n         DEV   TYPE=3270-A2\nA        DFLD  LTH=3\n         FMTEND\n`),
    ).toThrow(/POS= がありません/);
  });

  it("画面の外にある項目", () => {
    expect(
      bad(
        `F        FMT\n         DEV   TYPE=3270-A2\nA        DFLD  POS=(25,1),LTH=3\n         FMTEND\n`,
      ),
    ).toThrow(/画面（24 行 × 80 桁）の外/);
  });

  it("右端を越える項目", () => {
    expect(
      bad(
        `F        FMT\n         DEV   TYPE=3270-A2\nA        DFLD  POS=(1,75),LTH=10\n         FMTEND\n`,
      ),
    ).toThrow(/右端（80 桁）を越えます/);
  });

  it("知らない装置", () => {
    expect(bad(`F        FMT\n         DEV   TYPE=3270P\n         FMTEND\n`)).toThrow(
      /DEV TYPE=3270P は未実装/,
    );
  });

  it("OPT=2 と PAGE=YES", () => {
    expect(bad(`M        MSG   TYPE=INPUT,SOR=F,OPT=2\n         MSGEND\n`)).toThrow(/OPT=2/);
    expect(bad(`M        MSG   TYPE=OUTPUT,SOR=F,PAGE=YES\n         MSGEND\n`)).toThrow(
      /論理ページング/,
    );
  });

  it("選択ペンと EGCS の属性", () => {
    expect(
      bad(
        `F        FMT\n         DEV   TYPE=3270-A2\nA        DFLD  POS=(1,2),LTH=3,ATTR=(DET)\n` +
          `         FMTEND\n`,
      ),
    ).toThrow(/選択ペン/);
  });

  it("閉じ忘れ", () => {
    expect(bad(`F        FMT\n         DEV   TYPE=3270-A2\nA        DFLD  POS=(1,2),LTH=1\n`)).toThrow(
      /FMT が FMTEND で閉じていません/,
    );
  });

  it("誤りは MfsDefError で、ファイル名と行を持つ", () => {
    try {
      parseMfs(`F        FMT\n         DEV   TYPE=9999\n         FMTEND\n`, "x.mfs");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MfsDefError);
      expect((e as MfsDefError).file).toBe("x.mfs");
      expect((e as MfsDefError).line).toBe(2);
    }
  });
});

/**
 * オペランド欄の切れ目。
 *
 * アセンブラのオペランド欄は空白で終わり、その後ろは注釈。
 * カンマで終わっているのに空白を挟んで続きがあるのは不完全な文で、
 * 黙って捨てると**書いた指定が効かない**。
 * `ATTR=` が消えると見出しのつもりの固定文字が打ち込める項目になる。
 */
describe("カンマの後に空白を入れた指定", () => {
  it("黙って捨てずに断る", () => {
    expect(() =>
      parseMfs(
        `G        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n` +
          `         DPAGE\nB        DFLD  POS=(1,2),LTH=5, ATTR=(ALPHA,PROT)\n` +
          `         FMTEND\n`,
        "g.mfs",
      ),
    ).toThrow(/カンマで終わっていますが/);
  });

  it("空白を入れなければ従来どおり効く", () => {
    const d = parseMfs(
      `G        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n` +
        `         DPAGE\nB        DFLD  POS=(1,2),LTH=5,ATTR=(ALPHA,PROT)\n` +
        `         FMTEND\n`,
      "g.mfs",
    ).formats[0]!.dpages[0]!.dflds[0]!;
    expect(d.attr.protect).toBe(true);
  });

  it("オペランドの後ろの注釈は従来どおり読み飛ばす", () => {
    const d = parseMfs(
      `G        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n` +
        `         DPAGE\nB        DFLD  POS=(1,2),LTH=5   ここは注釈\n` +
        `         FMTEND\n`,
      "g.mfs",
    ).formats[0]!.dpages[0]!.dflds[0]!;
    expect(d.length).toBe(5);
  });
});

/**
 * 読んだのに効かない指定を断る。
 *
 * 「書式としては通るが、実行時に黙って無視される」のが一番たちが悪い。
 */
describe("読んでも効かない形は断る", () => {
  const head = `F        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n         DPAGE\n`;

  it("PFK= に項目名が無ければ断る（PF キーが ENTER と同じになる）", () => {
    expect(() =>
      parseMfs(
        `F        FMT\n         DEV   TYPE=3270-A2,PFK=(3='/FOR MENU.')\n` +
          `         DIV   TYPE=INOUT\n         DPAGE\nA        DFLD  POS=(1,2),LTH=4\n` +
          `         FMTEND\n`,
        "f.mfs",
      ),
    ).toThrow(/PFK= に固定文字を入れる項目名がありません/);
  });

  it("項目名を書けば通る", () => {
    const fmt = parseMfs(
      `F        FMT\n         DEV   TYPE=3270-A2,PFK=(A,3='/FOR MENU.')\n` +
        `         DIV   TYPE=INOUT\n         DPAGE\nA        DFLD  POS=(1,2),LTH=10\n` +
        `         FMTEND\n`,
      "f.mfs",
    ).formats[0]!;
    expect(fmt.pfk.get(3)?.dfld).toBe("A");
  });

  it("DFLD のラベルが重なれば断る（2 つめに永久に届かない）", () => {
    expect(() =>
      loadMfs({
        "f.mfs":
          head + `SAME     DFLD  POS=(1,2),LTH=4\nSAME     DFLD  POS=(3,2),LTH=4\n         FMTEND\n`,
      }),
    ).toThrow(/DFLD SAME が 2 つあります/);
  });

  it("DEV を 2 つ書けば断る（最後の装置の大きさに黙って混ざる）", () => {
    expect(() =>
      parseMfs(
        `F        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n` +
          `A        DFLD  POS=(1,2),LTH=4\n         DEV   TYPE=3270-A1\n` +
          `B        DFLD  POS=(2,2),LTH=4\n         FMTEND\n`,
        "f.mfs",
      ),
    ).toThrow(/複数装置の書式/);
  });
});

describe("マクロの書式", () => {
  it("固定文字の中の = は区切りにしない", () => {
    const d = parseMfs(
      `F        FMT\n         DEV   TYPE=3270-A2\n         DFLD  'A=B',POS=(1,2)\n         FMTEND\n`,
      "f.mfs",
    ).formats[0]!.dpages[0]!.dflds[0]!;
    expect(d.literal).toBe("A=B");
  });

  it("72 桁目の印で継続する（続きは 16 桁目から）", () => {
    const head = "         DEV   TYPE=3270-A2,";
    const line = head.padEnd(71) + "X";
    const text = `F        FMT\n${line}\n               FEAT=IGNORE\nA        DFLD  POS=(1,2),LTH=2\n         FMTEND\n`;
    expect(parseMfs(text, "f.mfs").formats[0]!.rows).toBe(24);
  });

  it("固定文字の大小は変えない", () => {
    const d = parseMfs(
      `F        FMT\n         DEV   TYPE=3270-A2\n         DFLD  'Item No.',POS=(1,2)\n         FMTEND\n`,
      "f.mfs",
    ).formats[0]!.dpages[0]!.dflds[0]!;
    expect(d.literal).toBe("Item No.");
  });
});

describe("表（IMS.FORMAT 相当）", () => {
  const files = { "INV.mfs": FMT + MSG };

  it("名前で引ける。MID / MOD / DIF / DOF の区別も持つ", () => {
    const lib = loadMfs(files);
    expect(lib.mid("INVIN").name).toBe("INVIN");
    expect(lib.mod("INVOUT").name).toBe("INVOUT");
    expect(lib.dif("INVFMT").name).toBe("INVFMT");
    expect(lib.dof("INVFMT").name).toBe("INVFMT");
  });

  it("向きが違えば断る", () => {
    const lib = loadMfs(files);
    expect(() => lib.mod("INVIN")).toThrow(MfsBlockError);
    expect(() => lib.mid("INVOUT")).toThrow(/MOD/);
    expect(() => lib.mid("NOSUCH")).toThrow(/ありません/);
  });

  it("DIV TYPE=OUTPUT の書式は入力に使えない", () => {
    const lib = loadMfs({
      "o.mfs":
        `F        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=OUTPUT\n` +
        `A        DFLD  POS=(1,2),LTH=3\n         FMTEND\n`,
    });
    expect(() => lib.dif("F")).toThrow(/DIF がありません/);
    expect(lib.dof("F").name).toBe("F");
  });

  it("SOR と NXT の食い違いは読んだ時点で断る", () => {
    expect(() =>
      loadMfs({ "m.mfs": `M        MSG   TYPE=INPUT,SOR=NOPE\n         MFLD  A,LTH=1\n         MSGEND\n` }),
    ).toThrow(/SOR=NOPE にあたる FMT がありません/);
    expect(() =>
      loadMfs({
        "m.mfs":
          FMT +
          `M        MSG   TYPE=INPUT,SOR=INVFMT,NXT=NOPE\n         MFLD  A,LTH=1\n         MSGEND\n`,
      }),
    ).toThrow(/NXT=NOPE にあたる MSG がありません/);
  });

  it("同じ名前が 2 つあれば断る", () => {
    expect(() => loadMfs({ "a.mfs": FMT, "b.mfs": FMT })).toThrow(/INVFMT は a.mfs にもあります/);
  });

  it("*.mfs 以外は読まない", () => {
    expect(loadMfs({ "note.txt": "でたらめ" }).empty).toBe(true);
  });
});
