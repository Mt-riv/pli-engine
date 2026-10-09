import { describe, expect, it } from "vitest";
import { insertSnippet } from "../web/insert.js";
import { SNIPPETS, plainText, runProgram } from "../src/index.js";

describe("insertSnippet", () => {
  it("空のエディタではそのまま挿入し、カーソルを末尾へ移す", () => {
    const r = insertSnippet("", 0, 0, "XY");
    expect(r.text).toBe("XY");
    expect(r.cursor).toBe(2);
  });

  it("選択範囲を置き換える", () => {
    // Snippet は文や塊なので、行の途中に来たときは改行して置く
    expect(insertSnippet("abcd", 1, 3, "X").text).toBe("a\nXd");
    // 行頭からの選択なら改行は足さない
    expect(insertSnippet("\nabcd", 1, 3, "X").text).toBe("\nXcd");
  });

  it("行頭の字下げに 2 行目以降を揃える", () => {
    const r = insertSnippet("p: proc;\n    ", 13, 13, "do i = 1 to 3;\n  x = i;\nend;");
    expect(r.text).toBe("p: proc;\n    do i = 1 to 3;\n      x = i;\n    end;");
  });

  it("空行は字下げしない（行末の空白を作らない）", () => {
    const r = insertSnippet("  ", 2, 2, "a;\n\nb;");
    expect(r.text).toBe("  a;\n\n  b;");
  });

  it("文の途中に差し込むときは改行で区切る", () => {
    const r = insertSnippet("  x = 1;", 8, 8, "y = 2;");
    expect(r.text).toBe("  x = 1;\n  y = 2;");
  });

  it("挿入後の末尾に余計な改行を足さない", () => {
    expect(insertSnippet("", 0, 0, "a;\n").text).toBe("a;");
  });
});

describe("ブラウザ版の Snippet 挿入", () => {
  for (const sn of SNIPPETS.filter((s) => s.standalone)) {
    it(`「${sn.name}」は空のエディタに挿入してそのまま実行できる`, () => {
      const r = insertSnippet("", 0, 0, plainText(sn.body));
      const run = runProgram(r.text, { maxSteps: 1_000_000 });
      expect(run.diagnostics).toEqual([]);
    });
  }
});
