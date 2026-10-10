/**
 * PL/I から DL/I を呼ぶ。ここが実際の使い方。
 *
 * PCB マスクは主手続きの引数で受けたポインタに BASED で宣言する。
 * 本物の PL/I と同じ書き方がそのまま動くことを確かめる。
 */

import { describe, it, expect } from "vitest";
import { runProgram } from "../src/run.js";
import { MemoryHost } from "../src/host.js";

const DBD = `         DBD  NAME=STUDENT,ACCESS=HDAM
         DATASET DD1=STUDDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=4,START=5,TYPE=C
         DBDGEN
         FINISH
         END
`;

const PSB = `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=9
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
`;

const DATA = `STUDENT S0001YAMAKAWA
COURSE  C001MATH
COURSE  C002PHYS
STUDENT S0002TSUKIMI
COURSE  C001MATH
`;

/** PCB マスクの規定の並び。`KEYLEN=9` に合わせて KEY_FB は CHAR(9)。 */
const PCB_MASK = `  dcl 1 db_pcb based(db_ptr),
        2 dbname     char(8),
        2 seg_level  char(2),
        2 stat_code  char(2),
        2 proc_opt   char(4),
        2 reserved   fixed bin(31),
        2 seg_name   char(8),
        2 len_kfb    fixed bin(31),
        2 no_senseg  fixed bin(31),
        2 key_fb     char(9);`;

function host(data = DATA): MemoryHost {
  return new MemoryHost({
    "STUDENT.dbd": DBD,
    "STUPSB.psb": PSB,
    "STUDENT.dat": data,
  });
}

function run(body: string, h = host()) {
  const src = `stuprt: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl (io_ptr, db_ptr) pointer;
${PCB_MASK}
${body}
end stuprt;`;
  return { result: runProgram(src, { host: h, psb: "STUPSB" }), host: h };
}

describe("PL/I から DL/I を呼ぶ", () => {
  it("GN を繰り返して全セグメントを階層順に取る", () => {
    const { result } = run(`  dcl three fixed bin(31) init(3);
  dcl func_gn char(4) init('GN  ');
  dcl seg_io char(13);
  /* GA / GK は警告でセグメントは返るので、GB まで続ける */
  do while (db_pcb.stat_code ^= 'GB');
    call plitdli(three, func_gn, db_pcb, seg_io);
    if db_pcb.stat_code ^= 'GB' then
      put skip edit(db_pcb.stat_code, db_pcb.seg_name, db_pcb.seg_level, db_pcb.key_fb)
                   (a, a, a, a);
  end;
  put skip edit('END ', db_pcb.stat_code)(a, a);`);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toBe(
      [
        "",
        "  STUDENT 01S0001    ",
        "  COURSE  02S0001C001",
        "  COURSE  02S0001C002",
        "GASTUDENT 01S0002    ",
        "  COURSE  02S0002C001",
        "END GB",
        "",
      ].join("\n"),
    );
  });

  it("修飾 SSA で 1 件取り、構造体の I/O 領域へ項目ごとに入る", () => {
    const { result } = run(`  dcl four fixed bin(31) init(4);
  dcl func_gu char(4) init('GU  ');
  dcl 1 stu,
        2 studno   char(5),
        2 studname char(8);
  dcl ssa char(25) init('STUDENT (STUDNO   =S0002)');
  call plitdli(four, func_gu, db_pcb, stu, ssa);
  put skip edit(db_pcb.stat_code, '|', stu.studno, '|', stu.studname)(a, a, a, a, a);`);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toBe("\n  |S0002|TSUKIMI \n");
  });

  it("該当が無ければ GE が返り、I/O 領域は変わらない", () => {
    const { result } = run(`  dcl four fixed bin(31) init(4);
  dcl func_gu char(4) init('GU  ');
  dcl seg_io char(13) init('UNTOUCHED    ');
  dcl ssa char(25) init('STUDENT (STUDNO   =S9999)');
  call plitdli(four, func_gu, db_pcb, seg_io, ssa);
  put skip edit(db_pcb.stat_code, '|', seg_io)(a, a, a);`);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toBe("\nGE|UNTOUCHED    \n");
  });

  it("GHU の後の REPL が .dat へ書き戻る", () => {
    const { result, host: h } = run(`  dcl four fixed bin(31) init(4);
  dcl three fixed bin(31) init(3);
  dcl func_ghu char(4) init('GHU ');
  dcl func_repl char(4) init('REPL');
  dcl 1 stu,
        2 studno   char(5),
        2 studname char(8);
  dcl ssa char(25) init('STUDENT (STUDNO   =S0001)');
  call plitdli(four, func_ghu, db_pcb, stu, ssa);
  stu.studname = 'DANGO';
  call plitdli(three, func_repl, db_pcb, stu);
  put skip edit(db_pcb.stat_code)(a);`);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toBe("\n  \n");
    // 末尾の空白が見えないと読み違えるので、桁を計算で組む
    expect(h.get("STUDENT.dat")).toBe(
      [
        `STUDENT S0001${"DANGO".padEnd(8)}`,
        "COURSE  C001MATH",
        "COURSE  C002PHYS",
        `STUDENT S0002${"TSUKIMI".padEnd(8)}`,
        "COURSE  C001MATH",
        "",
      ].join("\n"),
    );
  });

  it("ISRT で子を挿入し、順序キーの位置に入る", () => {
    const { result, host: h } = run(`  dcl five fixed bin(31) init(5);
  dcl func_isrt char(4) init('ISRT');
  dcl 1 crs,
        2 courseid char(4),
        2 title    char(4);
  dcl ssa1 char(25) init('STUDENT (STUDNO   =S0001)');
  dcl ssa2 char(9) init('COURSE   ');
  crs.courseid = 'C000';
  crs.title = 'ALGB';
  call plitdli(five, func_isrt, db_pcb, crs, ssa1, ssa2);
  put skip edit(db_pcb.stat_code, '|', db_pcb.key_fb)(a, a, a);`);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toBe("\n  |S0001C000\n");
    expect(h.get("STUDENT.dat")!.split("\n")[1]).toBe("COURSE  C000ALGB");
  });

  it("GHU を経ない REPL は DJ", () => {
    const { result } = run(`  dcl four fixed bin(31) init(4);
  dcl three fixed bin(31) init(3);
  dcl func_gu char(4) init('GU  ');
  dcl func_repl char(4) init('REPL');
  dcl seg_io char(13);
  dcl ssa char(25) init('STUDENT (STUDNO   =S0001)');
  call plitdli(four, func_gu, db_pcb, seg_io, ssa);
  call plitdli(three, func_repl, db_pcb, seg_io);
  put skip edit(db_pcb.stat_code)(a);`);
    expect(result.stdout).toBe("\nDJ\n");
  });

  it("GU で親を取り GNP で配下だけをたどる", () => {
    const { result } = run(`  dcl four fixed bin(31) init(4);
  dcl three fixed bin(31) init(3);
  dcl func_gu char(4) init('GU  ');
  dcl func_gnp char(4) init('GNP ');
  dcl seg_io char(13);
  dcl ssa char(25) init('STUDENT (STUDNO   =S0001)');
  call plitdli(four, func_gu, db_pcb, seg_io, ssa);
  do while (db_pcb.stat_code = '  ');
    call plitdli(three, func_gnp, db_pcb, seg_io);
    if db_pcb.stat_code = '  ' then put skip edit(db_pcb.key_fb)(a);
  end;
  put skip edit('END ', db_pcb.stat_code)(a, a);`);
    expect(result.stdout).toBe("\nS0001C001\nS0001C002\nEND GE\n");
  });

  it("PCB は BASED でなく構造体をそのまま渡しても受け付ける（DB の PCB が 1 つのとき）", () => {
    const src = `p: proc options(main);
  dcl plitdli entry;
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl seg_io char(13);
  dcl 1 pcb,
        2 dbname     char(8),
        2 seg_level  char(2),
        2 stat_code  char(2),
        2 proc_opt   char(4),
        2 reserved   fixed bin(31),
        2 seg_name   char(8),
        2 len_kfb    fixed bin(31),
        2 no_senseg  fixed bin(31),
        2 key_fb     char(9);
  call plitdli(three, func, pcb, seg_io);
  put skip edit(pcb.dbname, pcb.stat_code, pcb.seg_name, pcb.no_senseg)(a, a, a, f(2));
end p;`;
    const r = runProgram(src, { host: host(), psb: "STUPSB" });
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("\nSTUDENT   STUDENT  2\n");
  });
});

describe("DL/I の使い方を間違えたとき", () => {
  it("引数の個数が合わなければ、宣言した数と実際の数を添えて止める", () => {
    const { result } = run(`  dcl four fixed bin(31) init(4);
  dcl func char(4) init('GN  ');
  dcl seg_io char(13);
  call plitdli(four, func, db_pcb, seg_io);`);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toBe(
      "CALL PLITDLI の第 1 引数は 4 ですが、後ろに渡した引数は 3 個です",
    );
  });

  it("PSB が見つからなければ、探した名前を添えて止める", () => {
    // PCB のポインタを受け取る形（引数を取る主手続き）で初めて PSB を読む
    const r = runProgram("p: proc(a) options(main); end p;", {
      host: host(),
      psb: "NOSUCH",
    });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toContain("NOSUCH.psb");
  });

  it("ホストが無ければ、DL/I には必要だと言う", () => {
    const r = runProgram("p: proc(a) options(main); end p;", { psb: "STUPSB" });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toContain("ホスト");
  });

  it("PSB の PCB より多く受け取ろうとしたら個数を添えて止める", () => {
    const r = runProgram("p: proc(a, b, c) options(main); end p;", {
      host: host(),
      psb: "STUPSB",
    });
    expect(r.diagnostics[0]!.message).toBe(
      "PSB STUPSB の PCB は 2 個ですが、主手続きは 3 個受け取っています",
    );
  });

  it("PCB マスクの項目が足りなければ、必要な数を言う", () => {
    const src = `p: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl (io_ptr, db_ptr) pointer;
  dcl 1 db_pcb based(db_ptr),
        2 dbname    char(8),
        2 stat_code char(2);
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl seg_io char(13);
  call plitdli(three, func, db_pcb, seg_io);
end p;`;
    const r = runProgram(src, { host: host(), psb: "STUPSB" });
    expect(r.diagnostics[0]!.message).toBe(
      "PCB マスクの項目が 2 個しかありません（9 個必要です）",
    );
  });

  it("PCB マスクを構造体でなく宣言したら断る", () => {
    const src = `p: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl (io_ptr, db_ptr) pointer;
  dcl db_pcb char(40);
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl seg_io char(13);
  call plitdli(three, func, db_pcb, seg_io);
end p;`;
    const r = runProgram(src, { host: host(), psb: "STUPSB" });
    expect(r.diagnostics[0]!.message).toContain("PCB マスクとして使えません");
  });

  it("入出力 PCB への DB 呼び出しは、メッセージ処理が未実装だと断る", () => {
    const { result } = run(`  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GU  ');
  dcl seg_io char(13);
  dcl 1 io_pcb based(io_ptr),
        2 ltermname char(8),
        2 reserved  char(2),
        2 stat_code char(2),
        2 prefix    char(12),
        2 msg_id    char(8),
        2 mod_name  char(8),
        2 user_id   char(8),
        2 group_nm  char(8),
        2 time_stmp char(12);
  call plitdli(three, func, io_pcb, seg_io);`);
    expect(result.diagnostics[0]!.message).toContain("メッセージ");
  });

  it("COBOL / アセンブラの入口を呼んだら、PL/I の入口を教える", () => {
    const { result } = run("  call cbltdli;");
    expect(result.diagnostics[0]!.message).toContain("PLITDLI");
  });

  it("AIB インタフェースは未実装だと名指しで断る", () => {
    const { result } = run("  call aibtdli;");
    expect(result.diagnostics[0]!.message).toContain("AIB");
  });

  it("DBD の記述が誤っていれば、ファイル名と行を添えて止める", () => {
    const h = new MemoryHost({
      "STUDENT.dbd": `         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=NOSUCH,BYTES=13
         DBDGEN
         END
`,
      "STUPSB.psb": PSB,
    });
    const r = runProgram("p: proc(a, b) options(main); end p;", { host: h, psb: "STUPSB" });
    expect(r.diagnostics[0]!.message).toContain("STUDENT.dbd 2 行");
  });

  it("Linter は CALL PLITDLI を未定義の手続きとは言わない", async () => {
    const { lint } = await import("../src/lint.js");
    const src = `p: proc options(main);
  dcl plitdli entry;
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl seg_io char(13);
  dcl 1 pcb, 2 stat_code char(2);
  call plitdli(three, func, pcb, seg_io);
  put skip list(pcb.stat_code, seg_io);
end p;`;
    const found = lint(src).filter((d) => d.rule === "undefined-procedure");
    expect(found).toEqual([]);
  });

  /**
   * 幅の検査の文面。
   *
   * レコード入出力・セグメント I/O 領域・メッセージ I/O 領域が
   * 同じ検査を使うので、文面はどの用途かを言い当てる必要がある。
   * セグメント領域を書いた人に「RECORD 入出力で扱えません」と
   * 答えると、指す先が違って原因が分からなくなる。
   */
  it("セグメント I/O 領域に扱えない項目があれば、その用途を言う", () => {
    const { result } = run(`  dcl three fixed bin(31) init(3);
  dcl func_gn char(4) init('GN  ');
  dcl 1 seg_io, 2 n fixed bin(31);
  call plitdli(three, func_gn, db_pcb, seg_io);`);
    expect(result.diagnostics[0]?.message).toContain("セグメント I/O 領域で扱えません");
  });

  /**
   * PSB 無しで IMS のプログラムを走らせたとき。
   *
   * 主手続きの引数は、PSB が無ければコマンドライン引数（文字列）になる。
   * PCB を受ける `DCL (io_ptr, db_ptr) POINTER;` に文字列が来るので、
   * 直す前は宣言の行で「ポインタにはポインタしか代入できません」とだけ
   * 言っていた。指している行も理由も違うので、足りないものが
   * PSB の指定だと分からない。
   */
  it("引数をポインタで宣言した主手続きは、PSB が無いことを名指しで断る", () => {
    const r = runProgram(
      `stuprt: proc(io_ptr, db_ptr) options(main);
  dcl (io_ptr, db_ptr) pointer;
end stuprt;`,
      { host: new MemoryHost({}) },
    );
    expect(r.ok).toBe(false);
    const message = r.diagnostics[0]?.message ?? "";
    expect(message).toContain("io_ptr, db_ptr");
    expect(message).toContain("PSB");
    expect(message).not.toContain("ポインタにはポインタしか");
    // 宣言の行ではなく、引数を取っている主手続きの行を指す
    expect(r.diagnostics[0]?.line).toBe(1);
  });

  it("引数が文字列の主手続きは、PSB が無くてもコマンドライン引数で動く", () => {
    const r = runProgram(
      `p: proc(parm) options(main);
  dcl parm char(10) varying;
  put list(parm);
end p;`,
      { host: new MemoryHost({}), args: ["abc"] },
    );
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("abc");
  });
});
