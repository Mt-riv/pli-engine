/**
 * 書式定義の「止めるほどではないが、たぶん間違い」。
 *
 * 画面が組めない誤り（重なり・参照先が無い・画面の外）は読んだ時点で
 * 断っているので、ここで見るのは動かしてみて初めて困るものだけ。
 */
import { describe, expect, it } from "vitest";
import { loadMfs } from "../src/mfs/source.js";
import { checkMfs, formatWarning } from "../src/mfs/check.js";

const of = (text: string) => checkMfs(loadMfs({ "t.mfs": text }));

const FMT = (dflds: string, dpage = "         DPAGE") =>
  `F        FMT\n         DEV   TYPE=3270-A2,FEAT=IGNORE\n         DIV   TYPE=INOUT\n` +
  `${dpage}\n${dflds}         FMTEND\n`;

describe("書式定義の点検", () => {
  it("正しい定義には何も言わない", () => {
    expect(
      of(
        FMT(`A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,NOPROT)\n`, "         DPAGE CURSOR=((2,10))") +
          `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=4\n         MSGEND\n`,
      ),
    ).toEqual([]);
  });

  it("打ち込める項目が 1 つも無い書式を入力に使っていれば言う", () => {
    const w = of(
      FMT(`A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,PROT)\n`) +
        `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=4\n         MSGEND\n`,
    );
    expect(w.map((x) => x.message).join()).toMatch(/打ち込める項目が 1 つもありません/);
  });

  it("出力だけに使う書式なら言わない", () => {
    const w = of(
      FMT(`A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,PROT)\n`) +
        `M        MSG   TYPE=OUTPUT,SOR=F\n         MFLD  A,LTH=4\n         MSGEND\n`,
    );
    expect(w).toEqual([]);
  });

  it("カーソルが項目の無い位置を指していれば言う", () => {
    const w = of(
      FMT(`A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,NOPROT)\n`, "         DPAGE CURSOR=((5,5))") +
        `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=4\n         MSGEND\n`,
    );
    expect(w.map((x) => x.message).join()).toMatch(/位置に項目がありません/);
  });

  it("カーソルが保護された項目を指していれば言う", () => {
    const w = of(
      FMT(
        `A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,PROT)\nB        DFLD  POS=(4,10),LTH=4,ATTR=(ALPHA,NOPROT)\n`,
        "         DPAGE CURSOR=((2,10))",
      ) + `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=4\n         MFLD  B,LTH=4\n         MSGEND\n`,
    );
    expect(w.map((x) => x.message).join()).toMatch(/保護された項目 A を指しています/);
  });

  it("どの MFLD からも指されていない項目を言う（綴り違いの手がかり）", () => {
    const w = of(
      FMT(`A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,NOPROT)\nZ        DFLD  POS=(4,10),LTH=4\n`, "         DPAGE CURSOR=((2,10))") +
        `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=4\n         MSGEND\n`,
    );
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/項目 Z はどの MFLD からも指されていません/);
    expect(w[0]!.line).toBe(6);
  });

  it("出処は「ファイル 行」で出せる", () => {
    const w = of(
      FMT(`A        DFLD  POS=(2,10),LTH=4\nZ        DFLD  POS=(4,10),LTH=4\n`, "         DPAGE CURSOR=((2,10))") +
        `M        MSG   TYPE=INPUT,SOR=F\n         MFLD  A,LTH=4\n         MSGEND\n`,
    );
    expect(formatWarning(w[0]!)).toMatch(/^t\.mfs \d+ 行: /);
  });
});
