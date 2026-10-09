import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const grammar = JSON.parse(
  readFileSync(join(import.meta.dirname, "../syntaxes/pli.tmLanguage.json"), "utf8"),
);
const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
);

describe("文法ファイル", () => {
  it("scopeName が package.json と一致する", () => {
    expect(grammar.scopeName).toBe(pkg.contributes.grammars[0].scopeName);
  });

  /**
   * TextMate の正規表現は Oniguruma で、JS の RegExp には無い記法を使う。
   * `(?i)` のインラインフラグがその代表なので、JS で検証する前に
   * 先頭のフラグを取り除いてから構文の妥当性だけを確かめる。
   */
  it("正規表現がすべて有効", () => {
    const toJsRegex = (src: string): RegExp => {
      const m = /^\(\?([imx]+)\)/.exec(src);
      if (!m) return new RegExp(src);
      const flags = m[1]!.replace(/x/g, "");
      return new RegExp(src.slice(m[0].length), flags);
    };
    const check = (o: unknown, path: string): void => {
      if (Array.isArray(o)) {
        o.forEach((v, i) => check(v, `${path}[${i}]`));
        return;
      }
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if ((k === "match" || k === "begin" || k === "end") && typeof v === "string") {
            expect(() => toJsRegex(v), `${path}.${k} = ${v}`).not.toThrow();
          } else {
            check(v, `${path}.${k}`);
          }
        }
      }
    };
    check(grammar, "grammar");
  });

  /**
   * PL/I には予約語が無いので、キーワードの着色は本質的に近似でしかない。
   * `IF IF = THEN THEN THEN = ELSE;` では2つ目の IF が変数なのに
   * キーワードとして着色される。これは避けられないので、
   * 文法ファイルにその旨を明記してあることを確認する。
   */
  it("予約語が無いことへの注意書きがある", () => {
    expect(grammar._comment).toContain("予約語");
  });

  it("主要なキーワードを含む", () => {
    const kw = grammar.repository.keyword.match as string;
    for (const w of ["procedure", "declare", "select", "otherwise", "iterate"]) {
      expect(kw).toContain(w);
    }
  });

  it("組込関数は関数呼び出しの形のときだけ着色する", () => {
    // length が変数名として使われたときに着色されないよう (?=\() を付けている
    expect(grammar.repository.builtin.match).toContain("(?=\\s*\\()");
  });

  it("NOT の別表記（^ と ¬）を演算子に含む", () => {
    const op = grammar.repository.operator.match as string;
    expect(op).toContain("¬");
    expect(op).toContain("^");
  });
});

describe("拡張の定義", () => {
  it("PL/I の拡張子を関連付ける", () => {
    const exts = pkg.contributes.languages[0].extensions;
    expect(exts).toContain(".pli");
    expect(exts).toContain(".pl1");
  });

  it("実行コマンドを公開する", () => {
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    expect(ids).toContain("pli.run");
    expect(ids).toContain("pli.runWithArgs");
  });

  it("キーバインドの対象言語を限定している", () => {
    expect(pkg.contributes.keybindings[0].when).toContain("resourceLangId == pli");
  });

  it("上限の設定を公開する（無限ループ対策）", () => {
    const props = pkg.contributes.configuration.properties;
    expect(props["pli.run.maxSteps"]).toBeDefined();
    expect(props["pli.run.maxOutputBytes"]).toBeDefined();
  });

  it("バンドル結果を main に指定している", () => {
    expect(pkg.main).toBe("./dist/extension.js");
  });
});

describe("DL/I の入口", () => {
  it("PLITDLI が組込として色付けされる", () => {
    const dli = grammar.repository.dli;
    expect(dli).toBeDefined();
    expect(dli.name).toBe("support.function.dli.pli");
    const re = new RegExp(dli.match.replace(/^\(\?i\)/, ""), "i");
    for (const name of ["plitdli", "PLITDLI", "cbltdli", "asmtdli", "aibtdli"]) {
      expect(re.test(name), name).toBe(true);
    }
    expect(re.test("plitdliX")).toBe(false);
  });

  it("組込関数より先に見る（長い列に混ぜない）", () => {
    const order = grammar.patterns.map((p: { include: string }) => p.include);
    expect(order.indexOf("#dli")).toBeLessThan(order.indexOf("#builtin"));
  });
});
