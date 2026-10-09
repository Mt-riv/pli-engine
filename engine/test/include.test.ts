/**
 * %INCLUDE の検証。
 *
 * 取り込みそのものより、**位置情報が正しいこと**に重点を置く。
 * 取り込んだ先の誤りを主ファイルの行として報告すると、
 * Linter も VSCode の問題タブも嘘をつくことになる。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost, runProgram } from "../src/index.js";
import { parse } from "../src/parser.js";
import { preprocess } from "../src/preprocess.js";
import { lex } from "../src/lexer.js";

describe("%INCLUDE", () => {
  it("宣言を取り込んで使える", () => {
    const host = new MemoryHost({
      "DECLS.inc": "dcl total fixed dec(7,2);\ndcl rate fixed dec(3,2);\n",
    });
    const r = runProgram(
      `p: proc options(main);
%include 'DECLS.inc';
  total = 100;
  rate = 0.05;
  put list(total * rate);
end p;
`,
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("5.0000");
  });

  it("拡張子なしの名前でも探す", () => {
    const host = new MemoryHost({ "DECLS.inc": "dcl x fixed bin(31);\n" });
    const r = runProgram(
      "p: proc options(main);\n%include decls;\n  x = 7;\n  put list(x);\nend p;\n",
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("7");
  });

  it("ライブラリ指定は括弧の中の名前で探す", () => {
    const host = new MemoryHost({ DSA: "dcl y fixed bin(31);\n" });
    const r = runProgram(
      "p: proc options(main);\n%include syslib(dsa);\n  y = 3;\n  put list(y);\nend p;\n",
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("3");
  });

  it("カンマで複数を取り込める", () => {
    const host = new MemoryHost({ A: "dcl a fixed bin(31);\n", B: "dcl b fixed bin(31);\n" });
    const r = runProgram(
      "p: proc options(main);\n%include a, b;\n  a = 1; b = 2;\n  put list(a + b);\nend p;\n",
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("3");
  });

  it("入れ子の取り込みができる", () => {
    const host = new MemoryHost({
      OUTER: "%include inner;\ndcl b fixed bin(31);\n",
      INNER: "dcl a fixed bin(31);\n",
    });
    const r = runProgram(
      "p: proc options(main);\n%include outer;\n  a = 1; b = 2;\n  put list(a + b);\nend p;\n",
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("3");
  });

  it("取り込んだ側の %REPLACE が呼び出し元にも効く", () => {
    // 段を分けていないと、取り込みの中で置換が閉じてしまう
    const host = new MemoryHost({ CONST: "%replace limit by 42;\n" });
    const r = runProgram(
      "p: proc options(main);\n%include const;\n  put list(limit);\nend p;\n",
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("42");
  });

  it("見つからなければ誤りにする", () => {
    const r = runProgram("p: proc options(main);\n%include nope;\nend p;\n", {
      host: new MemoryHost(),
    });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.phase).toBe("preprocess");
    expect(r.diagnostics[0]?.message).toContain("nope");
    expect(r.diagnostics[0]?.line).toBe(2);
  });

  it("ホストを渡さなければ取り込めないと言う", () => {
    const r = runProgram("p: proc options(main);\n%include a;\nend p;\n");
    expect(r.diagnostics[0]?.phase).toBe("preprocess");
  });

  it("循環を検出する", () => {
    const host = new MemoryHost({ A: "%include b;\n", B: "%include a;\n" });
    const r = runProgram("p: proc options(main);\n%include a;\nend p;\n", { host });
    expect(r.diagnostics[0]?.message).toContain("循環");
    expect(r.diagnostics[0]?.file).toBe("b");
  });

  it("深すぎる入れ子を止める", () => {
    // 自分自身ではなく毎回違う名前にして、循環ではなく深さで止まることを見る
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`F${i}`] = `%include f${i + 1};\n`;
    const r = runProgram("p: proc options(main);\n%include f0;\nend p;\n", {
      host: new MemoryHost(files),
    });
    expect(r.diagnostics[0]?.message).toContain("深すぎます");
  });
});

describe("取り込んだ先の位置情報", () => {
  it("取り込んだ中で完結する誤りは、そのファイルの行で報告される", () => {
    const host = new MemoryHost({
      BAD: "dcl a fixed bin(31);\ndcl ;\n", // 2 行目に名前が無い
    });
    const r = runProgram("p: proc options(main);\n%include bad;\nend p;\n", { host });
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0]!;
    expect(d.file).toBe("bad");
    expect(d.line).toBe(2); // 取り込んだファイルの 2 行目
  });

  it("取り込んだ中の字句の誤りも、そのファイルの位置で報告される", () => {
    const host = new MemoryHost({ BAD: "dcl s char(3) init('abc);\n" });
    const r = runProgram("p: proc options(main);\n%include bad;\nend p;\n", { host });
    expect(r.diagnostics[0]?.file).toBe("bad");
    expect(r.diagnostics[0]?.phase).toBe("preprocess");
  });

  it("境界で見つかる誤りは、誤りが分かった位置（次の語）で報告される", () => {
    // 取り込んだ末尾のセミコロン抜けは、主ファイル側の次の語で判明する。
    // コンパイラと同じ挙動なので、そう報告されることを固定しておく
    const host = new MemoryHost({ BAD: "dcl x fixed bin(31)\n" });
    const r = runProgram("p: proc options(main);\n%include bad;\n  x = 1;\nend p;\n", { host });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.file).toBeUndefined();
    expect(r.diagnostics[0]?.line).toBe(3);
  });

  it("主ソースの誤りには file が付かない", () => {
    const r = runProgram("p: proc options(main);\n  dcl x fixed bin(31)\nend p;\n");
    expect(r.diagnostics[0]?.file).toBeUndefined();
  });

  it("取り込んだトークンに取り込み元が付く", () => {
    const toks = preprocess(lex("a;\n%include inc;\nb;\n"), {
      host: new MemoryHost({ INC: "c;\n" }),
    });
    const names = toks.filter((t) => t.kind === "word").map((t) => `${t.text}:${t.file ?? "-"}`);
    expect(names).toEqual(["a:-", "c:inc", "b:-"]);
  });

  it("parse にホストを渡せる", () => {
    const program = parse("p: proc options(main);\n%include d;\nend p;\n", {
      host: new MemoryHost({ D: "dcl q fixed bin(31);\n" }),
    });
    expect(program.body).toHaveLength(1);
  });
});
