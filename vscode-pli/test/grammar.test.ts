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

/**
 * 組込関数の着色と実装の同期。
 *
 * 文法が `sqrt` を組込関数として色付けするのに、実行すると
 * 「未知の関数です」で止まるのは誤解を生む。実装済みと未実装を
 * 別スコープにして、両者が重ならないことと、
 * 実装済みの集合が `BUILTIN_NAMES` と一致することを固定する。
 */
describe("組込関数のスコープ", () => {
  /** 選択肢の並びから名前を取り出す。 */
  const namesOf = (match: string): string[] => {
    const inner = match
      .replace("(?i)\\b(", "")
      .replace(")\\b(?=\\s*\\()", "");
    return inner.split("|").map((n) => n.toUpperCase()).sort();
  };

  const implemented = namesOf(grammar.repository.builtin.match);
  const unimplemented = namesOf(grammar.repository.unimplemented.match);

  it("実装済みの集合はエンジンの BUILTIN_NAMES と一致する", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../engine/src/interp.ts"),
      "utf8",
    );
    const m = /export const BUILTIN_NAMES: ReadonlySet<string> = new Set\(\[(.*?)\]\);/s.exec(src);
    expect(m).not.toBeNull();
    const engine = [...m![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((x) => x[1]!).sort();
    expect(implemented).toEqual(engine);
  });

  it("実装済みと未実装は重ならない", () => {
    const both = implemented.filter((n) => unimplemented.includes(n));
    expect(both).toEqual([]);
  });

  it("未実装にも PL/I の組込関数が残っている（文法は言語を表す）", () => {
    expect(unimplemented).toContain("SQRT");
    expect(unimplemented).toContain("DATE");
    expect(unimplemented.length).toBeGreaterThan(50);
  });

  /*
   * 未実装の表は**エンジンが正**。
   *
   * 同じ一覧が文法ファイルとエンジンの 2 か所にあると、
   * 片方だけ直したときに「色は未実装のままなのに動く」
   * （あるいは逆）という食い違いが生まれる。
   * 機械で突き合わせて、1 つの表として扱う。
   */
  it("未実装の集合はエンジンの UNIMPLEMENTED_BUILTINS と一致する", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../engine/src/interp.ts"),
      "utf8",
    );
    const m =
      /export const UNIMPLEMENTED_BUILTINS: ReadonlySet<string> = new Set\(\[(.*?)\]\);/s.exec(
        src,
      );
    expect(m).not.toBeNull();
    const engine = [
      ...new Set([...m![1]!.matchAll(/"([A-Z0-9_]+)"/g)].map((x) => x[1]!)),
    ].sort();
    expect(unimplemented).toEqual(engine);
  });

  it("どちらも関数呼び出しの形のときだけ着色する", () => {
    expect(grammar.repository.builtin.match).toContain("(?=\\s*\\()");
    expect(grammar.repository.unimplemented.match).toContain("(?=\\s*\\()");
  });
});

/**
 * 字下げの規則。
 *
 * `put list('do it');` のように文字列の中に `do` があるだけで
 * 字下げを増やしてはいけない。1 行で閉じた DO 群も増やさない。
 */
describe("字下げ", () => {
  const config = JSON.parse(
    readFileSync(join(import.meta.dirname, "../language-configuration.json"), "utf8"),
  );
  const increase = new RegExp(
    config.indentationRules.increaseIndentPattern.replace("(?i)", ""),
    "i",
  );
  const decrease = new RegExp(
    config.indentationRules.decreaseIndentPattern.replace("(?i)", ""),
    "i",
  );

  it("ブロックを開く行で増やす", () => {
    for (const line of [
      "do i = 1 to 3;",
      "  do while(x);",
      "outer: do i = 1 to 3;",
      "m: proc options(main);",
      "select (x);",
      "  begin;",
    ]) {
      expect(increase.test(line), line).toBe(true);
    }
  });

  it("文字列の中の do や 1 行完結の DO 群では増やさない", () => {
    for (const line of [
      "  put list('do it');",
      "  do i=1 to 3; put list(i); end;",
      "  x = 1;",
      "  /* begin の説明 */",
    ]) {
      expect(increase.test(line), line).toBe(false);
    }
  });

  it("END で減らす", () => {
    expect(decrease.test("  end m;")).toBe(true);
    expect(decrease.test("end;")).toBe(true);
    expect(decrease.test("  x = 1;")).toBe(false);
  });
});
