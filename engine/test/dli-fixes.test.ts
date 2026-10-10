/**
 * DL/I の意味論の修正。
 *
 * どれも既存の 116 件が通る状態で壊れていたもの。
 * **IMS には突き合わせる実機が無い**ので、各項目に IBM の仕様の
 * どの規則に基づくかをコメントで残す（この処理系の DL/I の担保の仕方）。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost, runProgram } from "../src/index.js";

/** 学生 → 履修 → 成績 の 3 階層。 */
const DBD = `         DBD  NAME=SCHOOL,ACCESS=HDAM
         DATASET DD1=SCHDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         SEGM NAME=GRADE,PARENT=COURSE,BYTES=4
         FIELD NAME=(GRD,SEQ,M),BYTES=2,START=1,TYPE=C
         DBDGEN
         END
`;

const psb = (opts = "") => `         PCB  TYPE=DB,DBDNAME=SCHOOL,PROCOPT=A,KEYLEN=11
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT${opts}
         SENSEG NAME=GRADE,PARENT=COURSE
         PSBGEN LANG=PLI,PSBNAME=P1
         END
`;

/** C003 だけが 2 人目の学生の配下にある。親の後戻りを試すための形。 */
const DATA = `STUDENT S0001YAMAKAWA
COURSE  C001MATH
GRADE   A1
COURSE  C002PHYS
STUDENT S0002TSUKIMI
COURSE  C003CHEM
`;

const PCB = `dcl 1 db_pcb based(db_ptr),
      2 dbname     char(8),
      2 seg_level  char(2),
      2 stat_code  char(2),
      2 proc_opt   char(4),
      2 reserved   fixed bin(31),
      2 seg_name   char(8),
      2 len_kfb    fixed bin(31),
      2 no_senseg  fixed bin(31),
      2 key_fb     char(11);`;

interface Opts {
  data?: string;
  dbd?: string;
  psbText?: string;
}

/** DL/I を使うプログラムを走らせ、標準出力を返す。 */
function dli(body: string, opts: Opts = {}): string {
  const host = new MemoryHost({
    "SCHOOL.dbd": opts.dbd ?? DBD,
    "P1.psb": opts.psbText ?? psb(),
    "SCHOOL.dat": opts.data ?? DATA,
  });
  const src = `m: proc(db_ptr) options(main);
  dcl plitdli entry;
  dcl db_ptr pointer;
  ${PCB}
  dcl func char(4);
  dcl io   char(13);
${body}
end m;`;
  const r = runProgram(src, { host, psb: "P1" });
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join(" / "));
  return r.stdout.replace(/\s+/g, " ").trim();
}

/** 定義の誤りを受け取る。 */
function defError(body: string, opts: Opts = {}): string {
  const host = new MemoryHost({
    "SCHOOL.dbd": opts.dbd ?? DBD,
    "P1.psb": opts.psbText ?? psb(),
    "SCHOOL.dat": opts.data ?? DATA,
  });
  const src = `m: proc(db_ptr) options(main);
  dcl plitdli entry;
  dcl db_ptr pointer;
  ${PCB}
  dcl func char(4);
  dcl io   char(13);
${body}
end m;`;
  const r = runProgram(src, { host, psb: "P1" });
  expect(r.ok).toBe(false);
  return r.diagnostics.map((d) => d.message).join(" / ");
}

describe("GU の経路探索", () => {
  /**
   * IBM の規則: GU は SSA の並び全体を満たす最初の経路まで
   * 階層順に探す。上位のレベルで最初に合った親だけを見るのではない。
   */
  it("上位が無修飾なら、後続の親へも戻って探す", () => {
    // C003 は 2 人目の学生の配下。1 人目で打ち切ると GE になる
    expect(
      dli(`  func = 'GU  ';
  call plitdli(5, func, db_pcb, io, 'STUDENT ', 'COURSE  (COURSEID =C003)');
  put list(db_pcb.stat_code, io);`),
    ).toBe("C003CHEM");
  });

  it("どこにも無ければ GE", () => {
    expect(
      dli(`  func = 'GU  ';
  call plitdli(5, func, db_pcb, io, 'STUDENT ', 'COURSE  (COURSEID =C999)');
  put list(db_pcb.stat_code);`),
    ).toBe("GE");
  });

  it("L コマンドコードはそのレベルの最後の候補から試す", () => {
    expect(
      dli(`  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT *L');
  put list(io);`),
    ).toBe("S0002TSUKIMI");
  });
});

describe("ISRT の親", () => {
  /**
   * IBM の規則: ISRT で親側の SSA を省くと、直前の呼び出しが
   * 確立した位置から親を決める。「GU で親を取る → 子を
   * 無修飾 SSA 1 つで ISRT」が実務で最もよく書かれる形。
   */
  it("親の SSA を省いたら現在位置から親を決める", () => {
    expect(
      dli(`  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  func = 'ISRT';
  io = 'C009NEW ';
  call plitdli(4, func, db_pcb, io, 'COURSE  ');
  put list(db_pcb.stat_code);
  func = 'GU  ';
  call plitdli(5, func, db_pcb, io,
               'STUDENT (STUDNO   =S0001)', 'COURSE  (COURSEID =C009)');
  put list(db_pcb.stat_code, io);`),
    ).toBe("C009NEW");
  });

  it("位置が無ければ GE（黙って別の親へ挿さない）", () => {
    expect(
      dli(`  func = 'ISRT';
  io = 'C009NEW ';
  call plitdli(4, func, db_pcb, io, 'COURSE  ');
  put list(db_pcb.stat_code);`),
    ).toBe("GE");
  });

  it("挿入する側の SSA に修飾を付けたら AJ", () => {
    // 条件は使われないので、通すと「条件に合うものを挿入した」と誤解される
    expect(
      dli(`  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  func = 'ISRT';
  io = 'C009NEW ';
  call plitdli(4, func, db_pcb, io, 'COURSE  (COURSEID =C009)');
  put list(db_pcb.stat_code);`),
    ).toBe("AJ");
  });

  it("制御文字を含むデータは断る（データファイルが壊れる）", () => {
    expect(
      dli(`  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  func = 'ISRT';
  io = 'C00' || '0A'x || 'NEW ';
  call plitdli(4, func, db_pcb, io, 'COURSE  ');
  put list(db_pcb.stat_code);`),
    ).toBe("AJ");
  });
});

describe("SENSEG", () => {
  /**
   * IBM の規則: PCB からは SENSEG で宣言したセグメントだけが見える。
   * 感知していない型は、無修飾の GN でも返らない。
   */
  it("感知していないセグメントは返らない", () => {
    const only2 = `         PCB  TYPE=DB,DBDNAME=SCHOOL,PROCOPT=A,KEYLEN=11
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=P1
         END
`;
    const got = dli(
      `  func = 'GN  ';
  do while (db_pcb.stat_code ^= 'GB');
    call plitdli(3, func, db_pcb, io);
    if db_pcb.stat_code ^= 'GB' then put list(db_pcb.seg_name);
  end;`,
      { psbText: only2 },
    );
    expect(got).not.toMatch(/GRADE/);
    expect(got).toMatch(/STUDENT/);
    expect(got).toMatch(/COURSE/);
  });

  it("SENSEG ごとの PROCOPT が効く", () => {
    expect(
      dli(
        `  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  func = 'ISRT';
  io = 'C009NEW ';
  call plitdli(4, func, db_pcb, io, 'COURSE  ');
  put list(db_pcb.stat_code);`,
        { psbText: psb(",PROCOPT=G") },
      ),
    ).toBe("AM");
  });
});

describe("ホールドと親の確立", () => {
  /**
   * IBM の規則: REPL / DLET の直前は GH 系でなければならない（DJ）。
   * ホールドは 1 回の呼び出しで使い切る。
   */
  it("失敗した GU を挟んだらホールドは消える", () => {
    expect(
      dli(`  func = 'GHU ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S9999)');
  func = 'REPL';
  io = 'S0001CHANGED ';
  call plitdli(3, func, db_pcb, io);
  put list(db_pcb.stat_code);`),
    ).toBe("DJ");
  });

  it("失敗した GU のあとは親の確立も解ける", () => {
    expect(
      dli(`  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S9999)');
  func = 'GNP ';
  call plitdli(3, func, db_pcb, io);
  put list(db_pcb.stat_code);`),
    ).toBe("GP");
  });

  it("GNP が配下を走査し終えても親の確立は残る", () => {
    // GNP の GE で親を解くと、続けて GNP を呼んだときに GP になり
    // 「終わった」のか「親が無い」のか区別が付かなくなる
    expect(
      dli(`  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0002)');
  func = 'GNP ';
  call plitdli(3, func, db_pcb, io);
  put list(db_pcb.stat_code);
  call plitdli(3, func, db_pcb, io);
  put list(db_pcb.stat_code);`),
    ).toBe("GE");
  });
});

describe("ロードモード", () => {
  it("非一意キーの重複は LB にしない", () => {
    // GRADE のキーは (GRD,SEQ,M) で重複を許す
    const load = `         PCB  TYPE=DB,DBDNAME=SCHOOL,PROCOPT=L,KEYLEN=11
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         SENSEG NAME=GRADE,PARENT=COURSE
         PSBGEN LANG=PLI,PSBNAME=P1
         END
`;
    expect(
      dli(
        `  func = 'ISRT';
  io = 'S0001YAMAKAWA';
  call plitdli(4, func, db_pcb, io, 'STUDENT ');
  io = 'C001MATH';
  call plitdli(4, func, db_pcb, io, 'COURSE  ');
  io = 'A1';
  call plitdli(4, func, db_pcb, io, 'GRADE   ');
  put list(db_pcb.stat_code);
  io = 'A1';
  call plitdli(4, func, db_pcb, io, 'GRADE   ');
  put list(db_pcb.stat_code);`,
        { psbText: load, data: "" },
      ),
    ).toBe("");
  });
});

describe("構造体の SSA", () => {
  /**
   * PL/I の IMS プログラムは SSA を構造体で組み立てるのが典型。
   * 値として評価すると構造体はスカラにならないので、
   * I/O 領域と同じく葉を宣言順に連結する必要がある。
   */
  it("構造体で組み立てた SSA が通る", () => {
    const src = `m: proc(db_ptr) options(main);
  dcl plitdli entry;
  dcl db_ptr pointer;
  ${PCB}
  dcl 1 ssa,
        2 seg_name char(8) init('STUDENT '),
        2 lparen   char(1) init('('),
        2 fld      char(8) init('STUDNO  '),
        2 op       char(2) init(' ='),
        2 val      char(5) init('S0002'),
        2 rparen   char(1) init(')');
  dcl func char(4) init('GU  ');
  dcl io char(13);
  call plitdli(4, func, db_pcb, io, ssa);
  put list(db_pcb.stat_code, io);
end m;`;
    const host = new MemoryHost({
      "SCHOOL.dbd": DBD,
      "P1.psb": psb(),
      "SCHOOL.dat": DATA,
    });
    const r = runProgram(src, { host, psb: "P1" });
    expect(r.ok).toBe(true);
    expect(r.stdout.replace(/\s+/g, " ").trim()).toBe("S0002TSUKIMI");
  });
});

describe("定義の誤りを名指しで断る", () => {
  it("扱えないアクセス方式", () => {
    expect(defError("  put list('x');", { dbd: DBD.replace("HDAM", "DEDB") }))
      .toMatch(/ACCESS=DEDB は未実装/);
  });

  it("論理関係（二重親）", () => {
    expect(
      defError("  put list('x');", {
        dbd: DBD.replace("PARENT=STUDENT,BYTES=8", "PARENT=((STUDENT,SNGL),(GRADE,PHYS)),BYTES=8"),
      }),
    ).toMatch(/未実装/);
  });

  it("SOURCE=（論理セグメント）", () => {
    expect(
      defError("  put list('x');", {
        dbd: DBD.replace("SEGM NAME=GRADE,PARENT=COURSE,BYTES=4", "SEGM NAME=GRADE,PARENT=COURSE,BYTES=4,SOURCE=((X,DATA,Y))"),
      }),
    ).toMatch(/SOURCE= は未実装/);
  });

  it("扱えない項目の型", () => {
    expect(
      defError("  put list('x');", { dbd: DBD.replace("BYTES=2,START=1,TYPE=C", "BYTES=2,START=1,TYPE=P") }),
    ).toMatch(/TYPE=P は未実装/);
  });

  it("9 桁以上のセグメント名", () => {
    expect(
      defError("  put list('x');", { dbd: DBD.replace("NAME=GRADE", "NAME=TOOLONGNAME") }),
    ).toMatch(/IMS の名前として使えません/);
  });
});

describe("データファイルの読み込み", () => {
  it("CRLF でも読める", () => {
    expect(
      dli(
        `  func = 'GU  ';
  call plitdli(4, func, db_pcb, io, 'STUDENT (STUDNO   =S0001)');
  put list(db_pcb.stat_code, io);`,
        { data: DATA.replace(/\n/g, "\r\n") },
      ),
    ).toBe("S0001YAMAKAWA");
  });

  it("BYTES= を超える行は断る（黙って切らない）", () => {
    expect(
      defError("  put list('x');", {
        data: "STUDENT S0001YAMAKAWAXXXXXXXXXX\n",
      }),
    ).toMatch(/長すぎます/);
  });

  it("兄弟の型が DBD の順から外れていたら断る", () => {
    // STUDENT の子を COURSE → ADDR の順で宣言した DBD を使う
    const twoChildren = `         DBD  NAME=SCHOOL,ACCESS=HDAM
         DATASET DD1=SCHDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         SEGM NAME=ADDR,PARENT=STUDENT,BYTES=6
         FIELD NAME=(CITY,SEQ,U),BYTES=6,START=1,TYPE=C
         DBDGEN
         END
`;
    const psbTwo = `         PCB  TYPE=DB,DBDNAME=SCHOOL,PROCOPT=A,KEYLEN=11
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         SENSEG NAME=ADDR,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=P1
         END
`;
    // ADDR のあとに COURSE が来るのは DBD の宣言順と逆
    expect(
      defError("  put list('x');", {
        dbd: twoChildren,
        psbText: psbTwo,
        data: `STUDENT S0001YAMAKAWA
COURSE  C001MATH
ADDR    TOKYO
COURSE  C002PHYS
`,
      }),
    ).toMatch(/宣言順に並べてください/);
  });

  it("DBD の宣言順どおりなら通る", () => {
    const twoChildren = `         DBD  NAME=SCHOOL,ACCESS=HDAM
         DATASET DD1=SCHDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         SEGM NAME=ADDR,PARENT=STUDENT,BYTES=6
         FIELD NAME=(CITY,SEQ,U),BYTES=6,START=1,TYPE=C
         DBDGEN
         END
`;
    const psbTwo = `         PCB  TYPE=DB,DBDNAME=SCHOOL,PROCOPT=A,KEYLEN=11
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         SENSEG NAME=ADDR,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=P1
         END
`;
    expect(
      dli(
        `  func = 'GU  ';
  call plitdli(5, func, db_pcb, io, 'STUDENT ', 'ADDR    (CITY     =TOKYO )');
  put list(db_pcb.stat_code, io);`,
        {
          dbd: twoChildren,
          psbText: psbTwo,
          data: `STUDENT S0001YAMAKAWA
COURSE  C001MATH
COURSE  C002PHYS
ADDR    TOKYO
`,
        },
      ),
    ).toBe("TOKYO");
  });
});
