/**
 * DBD / PSB の読み取り。
 *
 * 書式はアセンブラのマクロ命令（DBDGEN / PSBGEN への入力）。
 * 1 桁目の `*` は注釈、72 桁目が非空白なら次行へ継続し、
 * オペランドの後の空白から先は注釈になる。
 */

import { describe, it, expect } from "vitest";
import { parseDbd } from "../src/dli/dbd.js";
import { parsePsb } from "../src/dli/psb.js";
import { DliDefError } from "../src/dli/types.js";

const STUDENT_DBD = `         DBD  NAME=STUDENT,ACCESS=(HDAM,OSAM)
         DATASET DD1=STUDDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=40
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=20,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=30
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=16,START=5,TYPE=C
         SEGM NAME=GRADE,PARENT=COURSE,BYTES=10
         FIELD NAME=(TERM,SEQ,U),BYTES=4,START=1,TYPE=C
         DBDGEN
         FINISH
         END
`;

describe("DBD の読み取り", () => {
  it("名前とアクセス方式を取る", () => {
    const dbd = parseDbd(STUDENT_DBD, "STUDENT.dbd");
    expect(dbd.name).toBe("STUDENT");
    expect(dbd.access).toBe("HDAM");
  });

  it("階層とセグメント長を取る", () => {
    const dbd = parseDbd(STUDENT_DBD, "STUDENT.dbd");
    expect(dbd.root).toBe("STUDENT");
    expect(dbd.segments.get("COURSE")!.parent).toBe("STUDENT");
    expect(dbd.segments.get("COURSE")!.bytes).toBe(30);
    expect(dbd.segments.get("GRADE")!.level).toBe(3);
    expect(dbd.segments.get("STUDENT")!.children).toEqual(["COURSE"]);
  });

  it("順序キー項目を取る", () => {
    const dbd = parseDbd(STUDENT_DBD, "STUDENT.dbd");
    const seg = dbd.segments.get("STUDENT")!;
    expect(seg.sequence).toEqual({
      name: "STUDNO",
      start: 1,
      bytes: 5,
      type: "C",
      unique: true,
    });
    expect(seg.fields.map((f) => f.name)).toEqual(["STUDNO", "STUDNAME"]);
  });

  it("注釈行と、オペランドの後の注釈を読み飛ばす", () => {
    const dbd = parseDbd(
      `* 学生データベース
         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=S,PARENT=0,BYTES=8   ルートセグメント
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1
         DBDGEN
         END
`,
      "S.dbd",
    );
    expect(dbd.segments.get("S")!.bytes).toBe(8);
  });

  it("72 桁目が非空白なら次の行へ継続する", () => {
    // オペランドは 16 桁目から続ける
    const line1 = "         SEGM NAME=S,PARENT=0,".padEnd(71) + "X";
    const dbd = parseDbd(
      `         DBD  NAME=S,ACCESS=HDAM
${line1}
               BYTES=8
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1
         DBDGEN
         END
`,
      "S.dbd",
    );
    expect(dbd.segments.get("S")!.bytes).toBe(8);
  });

  it("親が未定義なら、どの行のどのセグメントかを言って止める", () => {
    expect(() =>
      parseDbd(
        `         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=S,PARENT=0,BYTES=8
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1
         SEGM NAME=C,PARENT=NOSUCH,BYTES=8
         FIELD NAME=(K2,SEQ,U),BYTES=2,START=1
         DBDGEN
         END
`,
        "S.dbd",
      ),
    ).toThrow(/4 行.*NOSUCH/);
  });

  it("BYTES が無ければ止める", () => {
    expect(() =>
      parseDbd(
        `         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=S,PARENT=0
         DBDGEN
         END
`,
        "S.dbd",
      ),
    ).toThrow(/BYTES/);
  });

  it("ルートが 2 つあれば止める", () => {
    expect(() =>
      parseDbd(
        `         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=A,PARENT=0,BYTES=8
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1
         SEGM NAME=B,PARENT=0,BYTES=8
         FIELD NAME=(K2,SEQ,U),BYTES=2,START=1
         DBDGEN
         END
`,
        "S.dbd",
      ),
    ).toThrow(/ルート/);
  });

  it("DBDGEN が無ければ止める", () => {
    expect(() =>
      parseDbd(
        `         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=S,PARENT=0,BYTES=8
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1
`,
        "S.dbd",
      ),
    ).toThrow(/DBDGEN/);
  });

  it("二次索引と論理関係は、何が未実装かを名指しで断る", () => {
    expect(() =>
      parseDbd(
        `         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=S,PARENT=0,BYTES=8
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1
         LCHILD NAME=(X,OTHER),POINTER=INDX
         DBDGEN
         END
`,
        "S.dbd",
      ),
    ).toThrow(/未実装/);
  });

  it("順序キーの無いセグメントも許す（挿入は末尾になる）", () => {
    const dbd = parseDbd(
      `         DBD  NAME=S,ACCESS=HDAM
         SEGM NAME=S,PARENT=0,BYTES=8
         FIELD NAME=K,BYTES=2,START=1
         DBDGEN
         END
`,
      "S.dbd",
    );
    expect(dbd.segments.get("S")!.sequence).toBeUndefined();
  });

  it("誤りは DliDefError で、ファイル名と行を持つ", () => {
    try {
      parseDbd("         SEGM NAME=S,PARENT=0,BYTES=8\n", "S.dbd");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DliDefError);
      expect((e as DliDefError).file).toBe("S.dbd");
      expect((e as DliDefError).line).toBe(1);
    }
  });
});

const STUDENT_PSB = `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=13
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         SENSEG NAME=GRADE,PARENT=COURSE
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
`;

describe("PSB の読み取り", () => {
  const dbd = parseDbd(STUDENT_DBD, "STUDENT.dbd");
  /** DBD の解決。実行時はホストから読むが、ここでは手元の 1 つだけ。 */
  const dbds = (name: string) => (name === "STUDENT" ? dbd : undefined);

  it("PCB と感知セグメントを取る", () => {
    const psb = parsePsb(STUDENT_PSB, "STUPSB.psb", dbds);
    expect(psb.name).toBe("STUPSB");
    expect(psb.lang).toBe("PLI");
    // CMPAT=YES なので先頭が IO-PCB
    expect(psb.pcbs).toHaveLength(2);
    expect(psb.pcbs[0]!.kind).toBe("io");
    expect(psb.pcbs[1]!.dbdName).toBe("STUDENT");
    expect(psb.pcbs[1]!.procopt).toBe("A");
    expect(psb.pcbs[1]!.keylen).toBe(13);
    expect([...psb.pcbs[1]!.senseg.keys()]).toEqual(["STUDENT", "COURSE", "GRADE"]);
  });

  it("CMPAT=YES が無ければ IO-PCB を作らない", () => {
    const psb = parsePsb(STUDENT_PSB.replace(",CMPAT=YES", ""), "STUPSB.psb", dbds);
    expect(psb.pcbs).toHaveLength(1);
    expect(psb.pcbs[0]!.kind).toBe("db");
  });

  it("DBD に無いセグメントを SENSEG したら止める", () => {
    expect(() =>
      parsePsb(
        `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=13
         SENSEG NAME=NOSUCH,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=STUPSB
         END
`,
        "STUPSB.psb",
        dbds,
      ),
    ).toThrow(/NOSUCH/);
  });

  it("DBDNAME の DBD が読めなければ止める", () => {
    expect(() =>
      parsePsb(
        `         PCB  TYPE=DB,DBDNAME=OTHER,PROCOPT=A,KEYLEN=5
         SENSEG NAME=S,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=P
         END
`,
        "P.psb",
        dbds,
      ),
    ).toThrow(/OTHER/);
  });

  it("PROCOPT の既定は A、KEYLEN の既定は連結キーの最大長", () => {
    const psb = parsePsb(
      `         PCB  TYPE=DB,DBDNAME=STUDENT
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         SENSEG NAME=GRADE,PARENT=COURSE
         PSBGEN LANG=PLI,PSBNAME=P
         END
`,
      "P.psb",
      dbds,
    );
    expect(psb.pcbs[0]!.procopt).toBe("A");
    // STUDNO(5) + COURSEID(4) + TERM(4)
    expect(psb.pcbs[0]!.keylen).toBe(13);
  });

  it("PSBGEN が無ければ止める", () => {
    expect(() =>
      parsePsb(
        `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A
         SENSEG NAME=STUDENT,PARENT=0
`,
        "P.psb",
        dbds,
      ),
    ).toThrow(/PSBGEN/);
  });

  it("TYPE=TP の PCB は、メッセージ処理が未実装であることを断らずに場所だけ確保する", () => {
    const psb = parsePsb(
      `         PCB  TYPE=TP
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=G
         SENSEG NAME=STUDENT,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=P
         END
`,
      "P.psb",
      dbds,
    );
    expect(psb.pcbs.map((p) => p.kind)).toEqual(["io", "db"]);
  });
});
