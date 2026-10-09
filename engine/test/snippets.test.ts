import { describe, expect, it } from "vitest";
import { SNIPPETS, toVscodeSnippets, plainText } from "../src/snippets.js";
import { MemoryHost, runProgram } from "../src/index.js";

describe("Snippet の定義", () => {
  it("20 個以上ある", () => {
    expect(SNIPPETS.length).toBeGreaterThanOrEqual(20);
  });

  it("prefix が重複していない", () => {
    const p = SNIPPETS.map((s) => s.prefix);
    expect(new Set(p).size).toBe(p.length);
  });

  it("すべてに説明が付いている", () => {
    for (const s of SNIPPETS) {
      expect(s.description, s.prefix).toBeTruthy();
      expect(s.name, s.prefix).toBeTruthy();
    }
  });

  it("タブ位置の番号が飛んでいない", () => {
    for (const s of SNIPPETS) {
      const body = s.body.join("\n");
      // \$ は退避された通貨記号。タブ位置ではない
      const nums = [...body.matchAll(/(?<!\\)\$\{?(\d+)/g)]
        .map((m) => Number(m[1]))
        .filter((n) => n > 0);
      const uniq = [...new Set(nums)].sort((a, b) => a - b);
      uniq.forEach((n, i) => {
        expect(n, `${s.prefix}: タブ位置が ${uniq.join(",")} で飛んでいる`).toBe(i + 1);
      });
    }
  });
});

describe("plainText", () => {
  it("タブ位置の記法を取り除く", () => {
    expect(plainText(["${1:name}: proc;", "\t$0", "end ${1:name};"])).toBe(
      "name: proc;\n\t\nend name;",
    );
  });

  it("選択肢の記法も展開する", () => {
    expect(plainText(["${1|a,b,c|}"])).toBe("a");
  });
});

/**
 * Snippet は利用者が最初に挿入するものなので、
 * 展開した結果がそのまま動く（または意図した断片である）ことを確かめる。
 * 完結したプログラムになるものは実際に実行して検証する。
 */
describe("Snippet の妥当性", () => {
  const complete = SNIPPETS.filter((s) => s.standalone);

  it("完結する Snippet が 5 個以上ある", () => {
    expect(complete.length).toBeGreaterThanOrEqual(5);
  });

  for (const s of complete) {
    it(`「${s.name}」は展開すると動く`, () => {
      const r = runProgram(plainText(s.body), { maxSteps: 1_000_000 });
      expect(r.diagnostics, `${s.prefix}: ${JSON.stringify(r.diagnostics)}`).toEqual([]);
    });
  }

  // 断片は主手続きに入れれば解析が通ること
  for (const s of SNIPPETS.filter((x) => !x.standalone)) {
    it(`「${s.name}」は手続きの中で解析できる`, () => {
      const src = `t: proc options(main);\n${plainText(s.body)}\nend t;\n`;
      // 取り込みの Snippet は解決先が要る。名前は定義どおり decls
      const r = runProgram(src, {
        maxSteps: 0,
        host: new MemoryHost({ decls: "dcl dummy fixed bin(31);\n" }),
      });
      const syntax = r.diagnostics.filter((d) => d.phase !== "runtime");
      expect(syntax, `${s.prefix}: ${JSON.stringify(syntax)}`).toEqual([]);
    });
  }
});

describe("toVscodeSnippets", () => {
  const json = toVscodeSnippets();

  it("VSCode の形式になっている", () => {
    for (const [name, v] of Object.entries(json)) {
      expect(typeof name).toBe("string");
      expect(Array.isArray(v.body)).toBe(true);
      expect(typeof v.prefix).toBe("string");
      expect(typeof v.description).toBe("string");
    }
  });

  it("定義と同じ数ある", () => {
    expect(Object.keys(json)).toHaveLength(SNIPPETS.length);
  });
});
