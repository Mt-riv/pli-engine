/**
 * 付随ファイルの記法。ブラウザ版でしか使わないが、
 * 記法を間違えると %INCLUDE が静かに効かなくなるので固定しておく。
 */
import { describe, expect, it } from "vitest";
import { parseFiles, psbNames, serializeFiles, splitAux } from "../web/files.js";
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

  it("中身が空でも名前は残り、空のまま保つ", () => {
    // `"\n"` にすると「空行 1 つのファイル」に変わってしまう
    expect(parseFiles("::: empty\n")).toEqual({ empty: "" });
  });

  it("区切りより前の文章は splitAux で取り出せる", () => {
    const { preamble, files } = splitAux("これは説明\nもう 1 行\n::: a\nx\n");
    expect(preamble).toBe("これは説明\nもう 1 行");
    expect(files).toEqual({ a: "x\n" });
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

describe("付随ファイルから PSB を見つける", () => {
  it("`<名前>.psb` を拾う", () => {
    expect(psbNames({ "STUPSB.psb": "", "STUDENT.dbd": "" })).toEqual(["STUPSB"]);
  });

  it("大文字小文字を問わない", () => {
    expect(psbNames({ "App.PSB": "" })).toEqual(["App"]);
  });

  it("無ければ空", () => {
    expect(psbNames({ "data.txt": "" })).toEqual([]);
  });

  it("2 つあれば 2 つ返す（呼ぶ側が決められないと知る）", () => {
    expect(psbNames({ "b.psb": "", "a.psb": "" })).toEqual(["a", "b"]);
  });
});

/**
 * 往復で内容が変わらないこと。
 *
 * 実行後に欄を組み立て直すので、ここで落ちるものは
 * 「実行したら書いたものが消えた」という形で現れる。
 */
describe("往復", () => {
  const roundTrip = (text: string): string => {
    const { preamble, files } = splitAux(text);
    return serializeFiles(files, preamble);
  };

  it("区切りより前の文章が消えない", () => {
    const text = "これは説明\n::: a.inc\ndcl x;\n";
    expect(roundTrip(text)).toBe(text);
  });

  it("空のファイルが空行 1 つに変わらない", () => {
    const text = "::: OUT.txt\n";
    expect(roundTrip(text)).toBe(text);
    expect(splitAux(roundTrip(text)).files).toEqual({ "OUT.txt": "" });
  });

  it("複数のファイルと前置きが揃って戻る", () => {
    const text = "メモ\n::: a.inc\ndcl x;\n::: b.txt\n1 2\n";
    expect(roundTrip(text)).toBe(text);
  });

  it("前置きが無ければ付けない", () => {
    const text = "::: a.inc\ndcl x;\n";
    expect(roundTrip(text)).toBe(text);
  });
});
