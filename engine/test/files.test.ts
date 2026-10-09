/**
 * 付随ファイルの記法。ブラウザ版でしか使わないが、
 * 記法を間違えると %INCLUDE が静かに効かなくなるので固定しておく。
 */
import { describe, expect, it } from "vitest";
import { parseFiles, serializeFiles } from "../web/files.js";
import { MemoryHost, runProgram } from "../src/index.js";

describe("parseFiles", () => {
  it("区切りごとに分ける", () => {
    expect(parseFiles("::: a.inc\ndcl x;\n::: b.txt\n1 2\n")).toEqual({
      "a.inc": "dcl x;\n",
      "b.txt": "1 2\n",
    });
  });

  it("区切りの前の文字は捨てる", () => {
    expect(parseFiles("これは説明\n::: a\nx\n")).toEqual({ a: "x\n" });
  });

  it("空なら何も無い", () => {
    expect(parseFiles("")).toEqual({});
    expect(parseFiles("区切りが無い文章だけ")).toEqual({});
  });

  it("名前の前後の空白を落とす", () => {
    expect(Object.keys(parseFiles(":::   a.inc  \nx\n"))).toEqual(["a.inc"]);
  });

  it("中身が空でも名前は残る", () => {
    expect(parseFiles("::: empty\n")).toEqual({ empty: "\n" });
  });

  it("書き戻すと同じものになる", () => {
    const files = { "a.inc": "dcl x;\n", "b.txt": "1 2\n" };
    expect(parseFiles(serializeFiles(files))).toEqual(files);
  });
});

describe("付随ファイルから %INCLUDE する", () => {
  it("UI に書いた内容をそのまま取り込める", () => {
    const text = "::: DECLS.inc\ndcl total fixed dec(7,2);\n";
    const r = runProgram(
      "p: proc options(main);\n%include 'DECLS.inc';\n  total = 3;\n  put list(total);\nend p;\n",
      { host: new MemoryHost(parseFiles(text)) },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("3.00");
  });
});
