/**
 * SSA（セグメント検索引数）の構文解析。
 *
 * 書式は固定で、1〜8 桁がセグメント名。その後に
 *   空白            無修飾
 *   `*` + 命令記号   コマンドコード
 *   `(` …… `)`      修飾（項目名 8 桁 + 関係演算子 2 桁 + 値）
 * が続く。項目名が 8 桁に満たない分は空白で埋めるので、
 * `STUDNO` と `=` の間は空白 3 つになる（6 + 2 = 8 桁、演算子が ` =`）。
 */

import { describe, it, expect } from "vitest";
import { parseDbd } from "../src/dli/dbd.js";
import { parseSsa } from "../src/dli/ssa.js";

const DBD = parseDbd(
  `         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=0,BYTES=25
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=20,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=20
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=16,START=5,TYPE=C
         DBDGEN
         END
`,
  "STUDENT.dbd",
);

/** 修飾の 1 条件を規定の桁で組む。演算子は 2 桁。 */
function cond(field: string, op: string, value: string): string {
  return field.padEnd(8) + op.padStart(2) + value;
}

/** 成功した解析を取り出す。失敗したらテストを落とす。 */
function ok(text: string) {
  const r = parseSsa(text, DBD);
  if (!r.ok) throw new Error(`解析できませんでした: ${r.status} ${r.reason}`);
  return r.ssa;
}

describe("SSA の構文解析", () => {
  it("無修飾 SSA はセグメント名だけ", () => {
    const ssa = ok("STUDENT ");
    expect(ssa.segment).toBe("STUDENT");
    expect(ssa.conditions).toEqual([]);
    expect(ssa.commands).toEqual([]);
    expect(ssa.qualified).toBe(false);
  });

  it("セグメント名だけで終わる SSA も読む", () => {
    expect(ok("STUDENT").segment).toBe("STUDENT");
  });

  it("修飾 SSA は項目名・演算子・値に分かれる", () => {
    const ssa = ok(`STUDENT (${cond("STUDNO", "=", "S0001")})`);
    expect(ssa.qualified).toBe(true);
    expect(ssa.conditions).toEqual([{ field: "STUDNO", op: "EQ", value: "S0001" }]);
  });

  it("値が項目長より短くても読む（手で書くときのため）", () => {
    expect(ok(`STUDENT (${cond("STUDNO", "=", "S1")})`).conditions[0]!.value).toBe("S1");
  });

  it("関係演算子を読む", () => {
    const cases: [string, string][] = [
      ["=", "EQ"],
      ["= ", "EQ"],
      ["EQ", "EQ"],
      [">", "GT"],
      ["GT", "GT"],
      ["<", "LT"],
      ["LT", "LT"],
      [">=", "GE"],
      ["=>", "GE"],
      ["GE", "GE"],
      ["<=", "LE"],
      ["=<", "LE"],
      ["LE", "LE"],
      ["!=", "NE"],
      ["=!", "NE"],
      ["NE", "NE"],
      ["^=", "NE"],
    ];
    for (const [text, op] of cases) {
      const ssa = ok(`STUDENT (${cond("STUDNO", text, "S0001")})`);
      expect(ssa.conditions[0]!.op, `演算子 "${text}"`).toBe(op);
    }
  });

  it("複数条件を論理記号でつなぐ", () => {
    const ssa = ok(
      `STUDENT (${cond("STUDNO", ">=", "S0001")}&${cond("STUDNO", "<=", "S0009")})`,
    );
    expect(ssa.conditions).toEqual([
      { field: "STUDNO", op: "GE", value: "S0001" },
      { field: "STUDNO", op: "LE", value: "S0009", join: "AND" },
    ]);
  });

  it("`*` も AND、`|` は OR、`#` は独立 AND", () => {
    const two = (c: string) =>
      ok(`STUDENT (${cond("STUDNO", "=", "S0001")}${c}${cond("STUDNO", "=", "S0002")})`)
        .conditions[1]!.join;
    expect(two("*")).toBe("AND");
    expect(two("&")).toBe("AND");
    expect(two("|")).toBe("OR");
    expect(two("#")).toBe("IAND");
  });

  it("コマンドコードを読む", () => {
    expect(ok("COURSE  *F").commands).toEqual(["F"]);
    expect(ok("COURSE  *FL").commands).toEqual(["F", "L"]);
    expect(ok("COURSE  *-").commands).toEqual([]);
  });

  it("コマンドコードと修飾を同時に書ける", () => {
    const ssa = ok(`COURSE  *D(${cond("COURSEID", "=", "C001")})`);
    expect(ssa.commands).toEqual(["D"]);
    expect(ssa.conditions[0]!.value).toBe("C001");
  });

  it("C コマンドコードは連結キーでの修飾になる", () => {
    const ssa = ok("COURSE  *C(S0001C001)");
    expect(ssa.commands).toEqual(["C"]);
    expect(ssa.concatenatedKey).toBe("S0001C001");
    expect(ssa.conditions).toEqual([]);
  });

  it("DBD に無いセグメント名は AJ", () => {
    const r = parseSsa("NOSUCH  ", DBD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("AJ");
  });

  it("DBD に無い項目名は AJ", () => {
    const r = parseSsa(`STUDENT (${cond("NOSUCH", "=", "X")})`, DBD);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe("AJ");
      expect(r.reason).toContain("NOSUCH");
    }
  });

  it("括弧が閉じていなければ AJ", () => {
    const r = parseSsa(`STUDENT (${cond("STUDNO", "=", "S0001")}`, DBD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("AJ");
  });

  it("知らない関係演算子は AJ", () => {
    const r = parseSsa(`STUDENT (${cond("STUDNO", "??", "S0001")})`, DBD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("AJ");
  });

  it("知らないコマンドコードは AJ", () => {
    const r = parseSsa("STUDENT *Z", DBD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("AJ");
  });

  it("空の SSA は AJ", () => {
    const r = parseSsa("        ", DBD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("AJ");
  });
});
