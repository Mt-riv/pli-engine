/**
 * DL/I エンジン本体。位置づけとステータスコード。
 *
 * ここは PL/I を通さずに DL/I の意味論だけを見る。
 * ステータスコードの根拠は IBM IMS の仕様で、各テストに引用を添える。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { parseDbd } from "../src/dli/dbd.js";
import { parsePsb } from "../src/dli/psb.js";
import { Database } from "../src/dli/store.js";
import { DliRuntime, DliUnsupported } from "../src/dli/dli.js";

const DBD_SOURCE = `         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=0,BYTES=25
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=20,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=20
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=16,START=5,TYPE=C
         SEGM NAME=ADDRESS,PARENT=STUDENT,BYTES=20
         FIELD NAME=(KIND,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=CITY,BYTES=16,START=5,TYPE=C
         SEGM NAME=GRADE,PARENT=COURSE,BYTES=6
         FIELD NAME=(TERM,SEQ,U),BYTES=2,START=1,TYPE=C
         FIELD NAME=SCORE,BYTES=4,START=3,TYPE=C
         DBDGEN
         FINISH
         END
`;

const DBD = parseDbd(DBD_SOURCE, "STUDENT.dbd");
const resolveDbd = (name: string) => (name === "STUDENT" ? DBD : undefined);

function rec(type: string, ...fields: string[]): string {
  const seg = DBD.segments.get(type)!;
  return type.padEnd(8) + fields.join("").padEnd(seg.bytes).slice(0, seg.bytes);
}

const DATA = [
  rec("STUDENT", "S0001", "YAMAKAWA"),
  rec("COURSE", "C001", "MATH"),
  rec("GRADE", "1A", "0090"),
  rec("GRADE", "2A", "0085"),
  rec("COURSE", "C002", "PHYSICS"),
  rec("ADDRESS", "HOME", "SENDAI"),
  rec("STUDENT", "S0002", "TSUKIMI"),
  rec("COURSE", "C001", "MATH"),
  "",
].join("\n");

/** 修飾の 1 条件を規定の桁で組む。 */
function cond(field: string, op: string, value: string): string {
  return field.padEnd(8) + op.padStart(2) + value;
}

/** SSA を組む。 */
function ssa(segment: string, qualification?: string, commands = ""): string {
  const head = segment.padEnd(8) + (commands === "" ? "" : `*${commands}`);
  return qualification === undefined ? `${head} ` : `${head}(${qualification})`;
}

function build(psbSource = `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         SENSEG NAME=ADDRESS,PARENT=STUDENT
         SENSEG NAME=GRADE,PARENT=COURSE
         PSBGEN LANG=PLI,PSBNAME=STUPSB
         END
`) {
  const psb = parsePsb(psbSource, "STUPSB.psb", resolveDbd);
  const databases = new Map([["STUDENT", Database.load(DBD, DATA, "STUDENT.dat")]]);
  return new DliRuntime(psb, databases);
}

describe("GU（Get Unique）", () => {
  let dli: DliRuntime;
  beforeEach(() => {
    dli = build();
  });

  it("修飾 SSA でルートを 1 件取る", () => {
    const r = dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    expect(r.status).toBe("  ");
    expect(r.ioArea!.slice(0, 5)).toBe("S0002");
    expect(dli.pcb(0).segName).toBe("STUDENT");
    expect(dli.pcb(0).level).toBe(1);
    expect(dli.pcb(0).keyFeedback).toBe("S0002");
  });

  it("該当がなければ GE", () => {
    // GE — 指定した条件に合うセグメントが見つからなかった
    const r = dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S9999"))]);
    expect(r.status).toBe("GE");
    expect(r.ioArea).toBeUndefined();
  });

  it("複数レベルの SSA で親を絞って子を取る", () => {
    const r = dli.call(0, "GU", "", [
      ssa("STUDENT", cond("STUDNO", "=", "S0001")),
      ssa("COURSE", cond("COURSEID", "=", "C002")),
    ]);
    expect(r.status).toBe("  ");
    expect(r.ioArea!.slice(0, 4)).toBe("C002");
    expect(dli.pcb(0).level).toBe(2);
    expect(dli.pcb(0).keyFeedback).toBe("S0001C002");
  });

  it("SSA 無しの GU は先頭のセグメントを取る", () => {
    const r = dli.call(0, "GU", "", []);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).segName).toBe("STUDENT");
    expect(r.ioArea!.slice(0, 5)).toBe("S0001");
  });

  it("無修飾 SSA はその型の最初の出現を取る", () => {
    const r = dli.call(0, "GU", "", [ssa("STUDENT"), ssa("COURSE")]);
    expect(r.status).toBe("  ");
    expect(r.ioArea!.slice(0, 4)).toBe("C001");
  });

  it("L コマンドコードは最後の出現を取る", () => {
    const r = dli.call(0, "GU", "", [ssa("STUDENT"), ssa("COURSE", undefined, "L")]);
    expect(r.ioArea!.slice(0, 4)).toBe("C002");
  });

  it("階層になっていない SSA の並びは AC", () => {
    // AC — SSA の階層関係が DBD と合っていない
    const r = dli.call(0, "GU", "", [ssa("COURSE"), ssa("STUDENT")]);
    expect(r.status).toBe("AC");
  });

  it("C コマンドコードは連結キーで引く", () => {
    const r = dli.call(0, "GU", "", [ssa("GRADE", "S0001C0012A", "C")]);
    expect(r.status).toBe("  ");
    expect(r.ioArea!.slice(0, 2)).toBe("2A");
    expect(dli.pcb(0).level).toBe(3);
  });
});

describe("GN（Get Next）", () => {
  let dli: DliRuntime;
  beforeEach(() => {
    dli = build();
  });

  it("繰り返すと階層順に全件たどり、末尾で GB", () => {
    const seen: string[] = [];
    for (;;) {
      const r = dli.call(0, "GN", "", []);
      if (r.status === "GB") break;
      seen.push(`${dli.pcb(0).segName.trim()}:${dli.pcb(0).keyFeedback}`);
      if (seen.length > 20) throw new Error("終わらない");
    }
    expect(seen).toEqual([
      "STUDENT:S0001",
      "COURSE:S0001C001",
      "GRADE:S0001C0011A",
      "GRADE:S0001C0012A",
      "COURSE:S0001C002",
      "ADDRESS:S0001HOME",
      "STUDENT:S0002",
      "COURSE:S0002C001",
    ]);
  });

  it("下位階層へ下りるときは空白、同じレベルの別の型に移ると GK", () => {
    // GK — 無修飾の順次処理で、同じレベルの別のセグメント型に移った
    dli.call(0, "GU", "", [
      ssa("STUDENT", cond("STUDNO", "=", "S0001")),
      ssa("COURSE", cond("COURSEID", "=", "C002")),
    ]);
    const r = dli.call(0, "GN", "", []);
    expect(dli.pcb(0).segName).toBe("ADDRESS");
    expect(r.status).toBe("GK");
  });

  it("上位階層へ跨ぐと GA", () => {
    // GA — 無修飾の順次処理で、より上位のレベルへ移った
    dli.call(0, "GU", "", [ssa("GRADE", "S0001C0012A", "C")]);
    const r = dli.call(0, "GN", "", []);
    expect(dli.pcb(0).segName).toBe("COURSE");
    expect(r.status).toBe("GA");
  });

  it("修飾 SSA を付けると、合うものだけを順にたどる", () => {
    const keys: string[] = [];
    for (;;) {
      const r = dli.call(0, "GN", "", [ssa("COURSE", cond("COURSEID", "=", "C001"))]);
      if (r.status !== "  ") {
        expect(r.status).toBe("GB");
        break;
      }
      keys.push(dli.pcb(0).keyFeedback);
    }
    expect(keys).toEqual(["S0001C001", "S0002C001"]);
  });

  it("GU の後の GN は、その位置から続く", () => {
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    const r = dli.call(0, "GN", "", []);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).keyFeedback).toBe("S0002C001");
  });
});

describe("GNP（Get Next in Parent）", () => {
  let dli: DliRuntime;
  beforeEach(() => {
    dli = build();
  });

  it("親を確立してから配下だけをたどり、尽きたら GE", () => {
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0001"))]);
    const seen: string[] = [];
    for (;;) {
      const r = dli.call(0, "GNP", "", []);
      if (r.status !== "  ") {
        // GE — 配下のセグメントが尽きた
        expect(r.status).toBe("GE");
        break;
      }
      seen.push(dli.pcb(0).keyFeedback);
    }
    expect(seen).toEqual([
      "S0001C001",
      "S0001C0011A",
      "S0001C0012A",
      "S0001C002",
      "S0001HOME",
    ]);
  });

  it("修飾 SSA で配下の型を絞れる", () => {
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0001"))]);
    const r = dli.call(0, "GNP", "", [ssa("ADDRESS")]);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).keyFeedback).toBe("S0001HOME");
  });

  it("親が確立していなければ GP", () => {
    // GP — 親が確立していないのに GNP が呼ばれた
    const r = dli.call(0, "GNP", "", []);
    expect(r.status).toBe("GP");
  });

  it("P コマンドコードは上位のレベルに親を確立する", () => {
    dli.call(0, "GU", "", [
      ssa("STUDENT", cond("STUDNO", "=", "S0001"), "P"),
      ssa("COURSE", cond("COURSEID", "=", "C002")),
    ]);
    // 親は COURSE ではなく STUDENT なので、ADDRESS も配下に入る
    const seen: string[] = [];
    for (;;) {
      const r = dli.call(0, "GNP", "", []);
      if (r.status !== "  ") break;
      seen.push(dli.pcb(0).segName.trim());
    }
    expect(seen).toContain("ADDRESS");
  });
});

describe("更新（ISRT / REPL / DLET）", () => {
  let dli: DliRuntime;
  beforeEach(() => {
    dli = build();
  });

  it("GHU の後の REPL で内容が変わる", () => {
    dli.call(0, "GHU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    const r = dli.call(0, "REPL", "S0002TSUKIMI DANGO".padEnd(25), []);
    expect(r.status).toBe("  ");
    expect(dli.database("STUDENT").unload()).toContain("TSUKIMI DANGO");
  });

  it("GHU を経ていない REPL は DJ", () => {
    // DJ — 直前に GHU / GHN / GHNP が無い
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    expect(dli.call(0, "REPL", "S0002X".padEnd(25), []).status).toBe("DJ");
  });

  it("REPL で順序キーを変えたら DA", () => {
    // DA — REPL でキー項目を変更した
    dli.call(0, "GHU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    expect(dli.call(0, "REPL", "S9999X".padEnd(25), []).status).toBe("DA");
  });

  it("REPL は 1 回で使い切る（続けて呼ぶと DJ）", () => {
    dli.call(0, "GHU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    expect(dli.call(0, "REPL", "S0002A".padEnd(25), []).status).toBe("  ");
    expect(dli.call(0, "REPL", "S0002B".padEnd(25), []).status).toBe("DJ");
  });

  it("ISRT で子を順序キーの順に挿入する", () => {
    const r = dli.call(0, "ISRT", "C000ALGEBRA".padEnd(20), [
      ssa("STUDENT", cond("STUDNO", "=", "S0001")),
      ssa("COURSE"),
    ]);
    expect(r.status).toBe("  ");
    const lines = dli.database("STUDENT").unload().split("\n");
    expect(lines.slice(0, 3).map((l) => l.slice(0, 12))).toEqual([
      "STUDENT S000",
      "COURSE  C000",
      "COURSE  C001",
    ]);
  });

  it("一意キーの重複挿入は II", () => {
    // II — 挿入しようとしたセグメントが既にある
    const r = dli.call(0, "ISRT", "C001DUP".padEnd(20), [
      ssa("STUDENT", cond("STUDNO", "=", "S0001")),
      ssa("COURSE"),
    ]);
    expect(r.status).toBe("II");
  });

  it("親が見つからない挿入は GE", () => {
    const r = dli.call(0, "ISRT", "C009X".padEnd(20), [
      ssa("STUDENT", cond("STUDNO", "=", "S9999")),
      ssa("COURSE"),
    ]);
    expect(r.status).toBe("GE");
  });

  it("ルートの挿入は SSA 1 つ", () => {
    const r = dli.call(0, "ISRT", "S0003NEW".padEnd(25), [ssa("STUDENT")]);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).keyFeedback).toBe("S0003");
  });

  it("GHU の後の DLET で配下もまとめて消える", () => {
    dli.call(0, "GHU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0001"))]);
    expect(dli.call(0, "DLET", "", []).status).toBe("  ");
    const left = dli.database("STUDENT").unload().split("\n").filter((l) => l !== "");
    expect(left).toHaveLength(2);
    expect(left[0]!.slice(0, 13)).toBe("STUDENT S0002");
  });

  it("DLET の後の GN は消したところの次から続く", () => {
    dli.call(0, "GHU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0001"))]);
    dli.call(0, "DLET", "", []);
    const r = dli.call(0, "GN", "", []);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).keyFeedback).toBe("S0002");
  });
});

describe("PROCOPT と呼び出しの誤り", () => {
  const readOnly = `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=G
         SENSEG NAME=STUDENT,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=ROPSB
         END
`;

  it("PROCOPT=G の PCB に ISRT すると AM", () => {
    // AM — PROCOPT で許されていない呼び出し
    const dli = build(readOnly);
    expect(dli.call(0, "ISRT", "S0003X".padEnd(25), [ssa("STUDENT")]).status).toBe("AM");
  });

  it("PROCOPT=G の PCB に REPL / DLET も AM", () => {
    const dli = build(readOnly);
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0001"))]);
    expect(dli.call(0, "REPL", "S0001X".padEnd(25), []).status).toBe("AM");
    expect(dli.call(0, "DLET", "", []).status).toBe("AM");
  });

  it("感知していないセグメントを指すと AM", () => {
    const dli = build(readOnly);
    expect(dli.call(0, "GU", "", [ssa("COURSE")]).status).toBe("AM");
  });

  it("知らない機能コードは AD", () => {
    // AD — 機能コードが正しくない
    expect(build().call(0, "XX", "", []).status).toBe("AD");
  });

  it("未実装の呼び出しは、何が未実装かを名指しで断る", () => {
    expect(() => build().call(0, "CHKP", "", [])).toThrow(DliUnsupported);
    expect(() => build().call(0, "CHKP", "", [])).toThrow(/CHKP/);
  });

  it("SSA が壊れていれば AJ", () => {
    // AJ — SSA の書式が正しくない
    expect(build().call(0, "GU", "", ["STUDENT (STUDNO"]).status).toBe("AJ");
  });

  // 評価器は入出力 PCB への呼び出しを TmRuntime へ回すので、この経路は
  // DL/I 層を直に呼んだときの守り。IMS TM 自体は実装済み（src/tm/）
  it("入出力 PCB への呼び出しは DL/I 層では扱わないと断る", () => {
    const dli = build(`         PCB  TYPE=TP
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A
         SENSEG NAME=STUDENT,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=P
         END
`);
    expect(() => dli.call(0, "GU", "", [])).toThrow(DliUnsupported);
    expect(() => dli.call(0, "GU", "", [])).toThrow(/DL\/I 層では扱いません/);
  });
});

describe("ロードモード（PROCOPT=L）", () => {
  const loadPsb = `         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=L
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=LOADPSB
         END
`;

  function empty() {
    const psb = parsePsb(loadPsb, "LOADPSB.psb", resolveDbd);
    return new DliRuntime(psb, new Map([["STUDENT", Database.load(DBD, "", "STUDENT.dat")]]));
  }

  it("順序キーの昇順なら入る", () => {
    const dli = empty();
    expect(dli.call(0, "ISRT", "S0001A".padEnd(25), [ssa("STUDENT")]).status).toBe("  ");
    expect(dli.call(0, "ISRT", "S0002B".padEnd(25), [ssa("STUDENT")]).status).toBe("  ");
    expect(dli.database("STUDENT").roots).toHaveLength(2);
  });

  it("キーの順が逆なら LC", () => {
    // LC — ロード中にキーの順序が崩れた
    const dli = empty();
    dli.call(0, "ISRT", "S0002B".padEnd(25), [ssa("STUDENT")]);
    expect(dli.call(0, "ISRT", "S0001A".padEnd(25), [ssa("STUDENT")]).status).toBe("LC");
  });

  it("同じキーなら LB", () => {
    // LB — ロードしようとしたセグメントが既にある
    const dli = empty();
    dli.call(0, "ISRT", "S0001A".padEnd(25), [ssa("STUDENT")]);
    expect(dli.call(0, "ISRT", "S0001A".padEnd(25), [ssa("STUDENT")]).status).toBe("LB");
  });

  it("ロードモードでは取り出せない（AM）", () => {
    const dli = empty();
    expect(dli.call(0, "GU", "", [ssa("STUDENT")]).status).toBe("AM");
  });
});

describe("パス呼び出し（D コマンドコード）", () => {
  it("D を付けたレベルから下までを 1 回で I/O 領域に入れる", () => {
    const dli = build();
    const r = dli.call(0, "GU", "", [
      ssa("STUDENT", cond("STUDNO", "=", "S0001"), "D"),
      ssa("COURSE", cond("COURSEID", "=", "C002")),
    ]);
    expect(r.status).toBe("  ");
    // STUDENT(25) + COURSE(20)
    expect(r.ioArea).toHaveLength(45);
    expect(r.ioArea!.slice(0, 5)).toBe("S0001");
    expect(r.ioArea!.slice(25, 29)).toBe("C002");
    // 位置づけは最下位のセグメント
    expect(dli.pcb(0).segName).toBe("COURSE");
  });
});

describe("コマンドコード F / U / V", () => {
  it("V は現在位置をそのレベルの修飾として使う", () => {
    const dli = build();
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    // STUDENT は修飾しないが、V があるので S0002 の配下だけを見る
    const r = dli.call(0, "GU", "", [ssa("STUDENT", undefined, "V"), ssa("COURSE")]);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).keyFeedback).toBe("S0002C001");
  });

  it("U も同じレベルの現在位置で絞る", () => {
    const dli = build();
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0002"))]);
    const r = dli.call(0, "GU", "", [ssa("STUDENT", undefined, "U"), ssa("COURSE")]);
    expect(dli.pcb(0).keyFeedback).toBe("S0002C001");
    expect(r.status).toBe("  ");
  });

  it("位置が無いまま V を使うと、絞るものが無いので GE", () => {
    const dli = build();
    expect(dli.call(0, "GU", "", [ssa("STUDENT", undefined, "V")]).status).toBe("GE");
  });

  it("F は親の下の最初の出現に戻る", () => {
    const dli = build();
    dli.call(0, "GU", "", [ssa("STUDENT", cond("STUDNO", "=", "S0001"))]);
    dli.call(0, "GNP", "", [ssa("COURSE")]);
    expect(dli.pcb(0).keyFeedback).toBe("S0001C001");
    dli.call(0, "GNP", "", [ssa("COURSE")]);
    expect(dli.pcb(0).keyFeedback).toBe("S0001C002");
    // F を付けると先頭へ戻る
    dli.call(0, "GNP", "", [ssa("COURSE", undefined, "F")]);
    expect(dli.pcb(0).keyFeedback).toBe("S0001C001");
  });
});

describe("修飾の論理演算", () => {
  it("OR はどちらかが成り立てばよい", () => {
    const dli = build();
    const keys: string[] = [];
    for (;;) {
      const r = dli.call(0, "GN", "", [
        ssa(
          "COURSE",
          `${cond("COURSEID", "=", "C002")}|${cond("TITLE", "=", "MATH".padEnd(16))}`,
        ),
      ]);
      if (r.status !== "  ") break;
      keys.push(dli.pcb(0).keyFeedback);
    }
    expect(keys).toEqual(["S0001C001", "S0001C002", "S0002C001"]);
  });

  it("AND は両方が成り立つ必要がある", () => {
    const dli = build();
    const r = dli.call(0, "GN", "", [
      ssa(
        "COURSE",
        `${cond("COURSEID", "=", "C002")}&${cond("TITLE", "=", "MATH".padEnd(16))}`,
      ),
    ]);
    expect(r.status).toBe("GB");
  });

  it("NE で除外できる", () => {
    const dli = build();
    const r = dli.call(0, "GN", "", [ssa("COURSE", cond("COURSEID", "!=", "C001"))]);
    expect(r.status).toBe("  ");
    expect(dli.pcb(0).keyFeedback).toBe("S0001C002");
  });
});
