/**
 * 階層セグメント記憶。
 *
 * データの実体は IMS のアンロードに倣った行指向のテキスト。
 * 1 行 = 1 セグメント出現で、先頭 8 桁がセグメント名。
 * 階層は**行の順**で決まる（子の親は、直前に現れた親の型の出現）。
 */

import { describe, it, expect } from "vitest";
import { parseDbd } from "../src/dli/dbd.js";
import { Database } from "../src/dli/store.js";
import { DliDefError } from "../src/dli/types.js";

const DBD = parseDbd(
  `         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=0,BYTES=25
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=20,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=20
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=16,START=5,TYPE=C
         SEGM NAME=GRADE,PARENT=COURSE,BYTES=6
         FIELD NAME=(TERM,SEQ,U),BYTES=2,START=1,TYPE=C
         FIELD NAME=SCORE,BYTES=4,START=3,TYPE=C
         DBDGEN
         FINISH
         END
`,
  "STUDENT.dbd",
);

/** 行を組み立てる。長さの間違いでテストが壊れないように計算で作る。 */
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
  rec("STUDENT", "S0002", "TSUKIMI"),
  rec("COURSE", "C001", "MATH"),
  "",
].join("\n");

describe("階層セグメント記憶", () => {
  it("行の順から階層を組む", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    expect(db.roots.map((o) => o.data.slice(0, 5))).toEqual(["S0001", "S0002"]);
    const s1 = db.roots[0]!;
    expect(s1.children.map((o) => o.type)).toEqual(["COURSE", "COURSE"]);
    expect(s1.children[0]!.children.map((o) => o.data.slice(0, 2))).toEqual(["1A", "2A"]);
  });

  it("階層順に走査する（親 → 子 → 孫 → 次の子）", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    expect(
      db.hierarchy().map((o) => `${o.type}:${Database.keyValue(DBD, o).trim()}`),
    ).toEqual([
      "STUDENT:S0001",
      "COURSE:C001",
      "GRADE:1A",
      "GRADE:2A",
      "COURSE:C002",
      "STUDENT:S0002",
      "COURSE:C001",
    ]);
  });

  it("書き戻すと元のテキストに戻る", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    expect(db.unload()).toBe(DATA);
  });

  it("連結キーを組める", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    const grade = db.hierarchy().find((o) => o.type === "GRADE")!;
    expect(Database.concatenatedKey(DBD, grade)).toBe("S0001C0011A");
  });

  it("項目を名前で取れる", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    const s1 = db.roots[0]!;
    expect(Database.fieldValue(DBD, s1, "STUDNAME")).toBe("YAMAKAWA            ");
    expect(Database.fieldValue(DBD, s1, "STUDNO")).toBe("S0001");
  });

  it("空のテキストは空のデータベースになる", () => {
    const db = Database.load(DBD, "", "STUDENT.dat");
    expect(db.roots).toEqual([]);
    expect(db.unload()).toBe("");
  });

  it("DBD に無いセグメント名の行は止める", () => {
    expect(() => Database.load(DBD, `${rec("STUDENT", "S1")}\nNOSUCH  x\n`, "d.dat")).toThrow(
      /2 行.*NOSUCH/,
    );
  });

  it("親がまだ現れていない子の行は止める", () => {
    expect(() => Database.load(DBD, `${rec("COURSE", "C001")}\n`, "d.dat")).toThrow(
      /1 行.*STUDENT/,
    );
  });

  it("順序キーの重複は止める（一意キーのとき）", () => {
    const text = [rec("STUDENT", "S0001"), rec("STUDENT", "S0001"), ""].join("\n");
    expect(() => Database.load(DBD, text, "d.dat")).toThrow(/2 行.*S0001/);
  });

  it("挿入は順序キーの順に入る", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    const s1 = db.roots[0]!;
    db.insert(s1, "COURSE", rec("COURSE", "C0015", "ALGEBRA").slice(8));
    expect(s1.children.map((o) => o.data.slice(0, 4))).toEqual(["C001", "C001", "C002"]);
  });

  it("ルートも順序キーの順に入る", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    db.insert(undefined, "STUDENT", "S0000NEW".padEnd(25));
    expect(db.roots.map((o) => o.data.slice(0, 5))).toEqual(["S0000", "S0001", "S0002"]);
  });

  it("削除は配下の子も一緒に消す", () => {
    const db = Database.load(DBD, DATA, "STUDENT.dat");
    db.remove(db.roots[0]!);
    expect(db.hierarchy().map((o) => o.type)).toEqual(["STUDENT", "COURSE"]);
  });

  it("誤りは DliDefError で、ファイル名と行を持つ", () => {
    try {
      Database.load(DBD, "SHORT\n", "d.dat");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DliDefError);
      expect((e as DliDefError).file).toBe("d.dat");
    }
  });
});
