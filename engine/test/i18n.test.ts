/**
 * 多言語化の検査。
 *
 * ここが落ちるときは、たいてい次のどれかが起きている。
 *
 *   1. `m` で包み忘れた日本語がある（英語でも日本語が出る）
 *   2. 日本語の文を書き換えたのに表を作り直していない（鍵が変わった）
 *   3. 訳が空のまま残っている
 *
 * どれも**英語で動かさないと気づけない**たちの不具合で、
 * 日本語のテストは全部緑のまま通る。だから構文木から鍵を集めて
 * 突き合わせる。手で一覧を保守しない。
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  DEFAULT_LOCALE,
  getLocale,
  keyOf,
  LOCALES,
  m,
  normalizeLocale,
  tr,
  withLocale,
} from "../src/i18n/index.js";
import { EN } from "../src/i18n/en.js";
import { EXT_EN } from "../../vscode-pli/src/i18n.en.js";
import { scanTree } from "../scripts/i18n-keys.js";
import { lint, formatLint, runProgram, runTestSource, formatReport } from "../src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const scan = scanTree(
  ["src", "scripts", "web"].map((d) => resolve(ROOT, d)),
  ROOT,
);

/**
 * 包み忘れとして報告しなくてよいファイルと、その理由。
 *
 * ここに足すのは「利用者が見ない日本語」だけ。見えるものを
 * 足すと、英語で日本語が出たまま検査が緑になる。
 */
const ALLOWED_LEFTOVER: Record<string, string> = {
  // 生成する PL/I プログラムの中の注釈。利用者には見えない
  // （見えるのは FAIL が出すメッセージで、そちらは m を通してある）
  "src/testing.ts": "駆動プログラムの注釈",
  // 表そのものを書き出す道具。書き出す見出しは日本語で固定で、
  // 進捗の報告を読むのは保守する人だけ
  "scripts/gen-i18n.ts": "表を作る道具",
};

describe("日本語が既定で、ja では何も変わらない", () => {
  it("既定は ja", () => {
    expect(DEFAULT_LOCALE).toBe("ja");
    expect(getLocale()).toBe("ja");
  });

  it("ja の `m` は素の文字列連結と同じ", () => {
    const name = "X";
    expect(m`${name} は配列ではありません`).toBe("X は配列ではありません");
  });

  it("withLocale は元の言語に戻す", () => {
    const inside = withLocale("en", () => getLocale());
    expect(inside).toBe("en");
    expect(getLocale()).toBe("ja");
  });

  it("訳の無い鍵は原文のまま出す（空にしない）", () => {
    const out = withLocale("en", () => m`この文は表にありません`);
    expect(out).toBe("この文は表にありません");
  });
});

describe("鍵の抽出", () => {
  it("十分な数の鍵が見つかる（抽出そのものが壊れていないこと）", () => {
    expect(new Set(scan.keys.map((k) => k.key)).size).toBeGreaterThan(600);
  });

  it("HTML の data-i18n も拾う", () => {
    const html = scan.keys.filter((k) => k.file.endsWith(".html"));
    expect(html.length).toBeGreaterThan(10);
  });

  it("m で包み忘れた日本語が無い", () => {
    const left = scan.leftovers.filter((l) => ALLOWED_LEFTOVER[l.file] === undefined);
    expect(
      left.map((l) => `${l.file}:${l.line} ${l.text.slice(0, 40)}`),
      "m`...` で包むか、表（msg）に入れて tr で訳す",
    ).toEqual([]);
  });

  it("鍵の固定部分に {0} の形を書かない（差し込みと見分けが付かない）", () => {
    const bad = scan.keys.filter((k) => {
      const holes = [...k.key.matchAll(/\{(\d+)\}/g)].map((x) => Number(x[1]));
      // 0 から順に 1 つずつ増えていなければ、文そのものに {n} がある
      return holes.some((n, i) => n !== i);
    });
    expect(bad.map((k) => `${k.file}:${k.line} ${k.key}`)).toEqual([]);
  });
});

describe("英語の表", () => {
  const keys = new Set(scan.keys.map((k) => k.key));

  it("すべての鍵に訳がある", () => {
    const missing = [...keys].filter((k) => (EN[k] ?? "") === "");
    expect(missing, "npm run gen:i18n のあと訳を書く").toEqual([]);
  });

  it("使われていない鍵が残っていない", () => {
    expect(Object.keys(EN).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("差し込みの数が鍵と訳で一致する", () => {
    const holes = (s: string): number => new Set(s.match(/\{\d+\}/g) ?? []).size;
    const bad = Object.entries(EN).filter(([k, v]) => holes(k) !== holes(v));
    expect(bad.map(([k, v]) => `${k} -> ${v}`)).toEqual([]);
  });

  it("訳に日本語が残っていない", () => {
    const bad = Object.entries(EN).filter(([, v]) => /[ぁ-んァ-ヶー一-龠々〆〇]/.test(v));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("鍵は keyOf と同じ形（差し込みは {0} から）", () => {
    expect(keyOf(["a", "b", "c"])).toBe("a{0}b{1}c");
  });
});

/**
 * VSCode 拡張の中で定義した文字列。
 *
 * **こちらで見るのは、構文木の走査に `typescript` が要るため。**
 * それは engine の devDependency なので、`vscode-pli` の `npm ci` だけでは
 * 入っていない（CI の vscode ジョブで実際に落ちた）。
 * 表そのものの検査（空・差し込みの数・日本語の残り・エンジンの表との
 * 食い違い）は `vscode-pli/test/i18n.test.ts` にある。
 */
describe("VSCode 拡張の中の文字列", () => {
  const ext = scanTree([resolve(ROOT, "..", "vscode-pli", "src")], resolve(ROOT, ".."));
  const keys = new Set(ext.keys.map((k) => k.key));

  it("鍵が見つかる（抽出が壊れていないこと）", () => {
    expect(keys.size).toBeGreaterThan(20);
  });

  it("m で包み忘れた日本語が無い", () => {
    expect(ext.leftovers.map((l) => `${l.file}:${l.line} ${l.text.slice(0, 40)}`)).toEqual(
      [],
    );
  });

  it("すべての鍵に訳がある", () => {
    expect([...keys].filter((k) => (EXT_EN[k] ?? "") === "")).toEqual([]);
  });

  it("使われていない鍵が残っていない", () => {
    expect(Object.keys(EXT_EN).filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe("言語タグの解釈", () => {
  it("地域を落とす", () => {
    expect(normalizeLocale("ja")).toBe("ja");
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("EN")).toBe("en");
  });

  it("知らないものと空は undefined（呼び出し側が既定を決める）", () => {
    expect(normalizeLocale("fr")).toBeUndefined();
    expect(normalizeLocale("auto")).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
  });

  it("対応している言語は 2 つ", () => {
    expect([...LOCALES]).toEqual(["ja", "en"]);
  });
});

/**
 * 端から端まで英語で出ること。
 *
 * 表に訳があることと、実際に英語で出ることは別。間に `tr` の
 * 呼び忘れ（表に入れただけで使うところを直していない）が挟まる。
 */
describe("英語で動かす", () => {
  const en = <T>(fn: () => T): T => withLocale("en", fn);

  it("構文の誤り", () => {
    const r = en(() => runProgram("m: proc options(main);\n  x = ;\nend m;\n"));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toBe("an expression expected (found \";\")");
  });

  it("実行時の誤り", () => {
    const r = en(() =>
      runProgram("m: proc options(main);\n  dcl p pointer;\n  p = 1;\nend m;\n"),
    );
    expect(r.diagnostics[0]?.message).toBe("Only a pointer can be assigned to a pointer");
  });

  it("未実装の名指し", () => {
    const r = en(() => runProgram("m: proc options(main);\n  dcl x complex;\nend m;\n"));
    expect(r.diagnostics[0]?.message).toContain("not implemented");
    expect(r.diagnostics[0]?.message).toContain("complex numbers");
  });

  it("上限に達したとき", () => {
    const r = en(() =>
      runProgram("m: proc options(main);\n  do while('1'b); end;\nend m;\n", {
        maxSteps: 100,
      }),
    );
    expect(r.diagnostics[0]?.message).toContain("may be an infinite loop");
  });

  it("DL/I の誤り（PSB が無い）", () => {
    const r = en(() =>
      runProgram(
        "m: proc(io_ptr) options(main);\n  dcl io_ptr pointer;\nend m;\n",
      ),
    );
    expect(r.diagnostics[0]?.message).toContain("declared as pointers");
    expect(r.diagnostics[0]?.message).toContain("name a PSB");
  });

  it("Linter の指摘", () => {
    const messages = en(() => lint("m: proc options(main);\n  x = 1;\nend m;\n"));
    const text = en(() => formatLint(messages, "x.pli"));
    expect(text).toContain("line 2");
    expect(text).toContain("is not declared");
    expect(text).toContain("warnings");
  });

  it("テストの報告", () => {
    const report = en(() =>
      runTestSource("TEST_A: proc;\n  call ASSERT_EQUALS(1, 2, 'x');\nend TEST_A;\n"),
    );
    const text = en(() => formatReport(report, "Tests"));
    expect(text).toContain("tests 1");
    expect(text).toContain("failed 1");
    // 表明の失敗は PL/I の前置きが出す文字列
    expect(text).toContain("expected");
    expect(text).toContain("actual");
  });

  it("表明の失敗の文にアポストロフィを入れない（PL/I の文字列定数が壊れる）", () => {
    const report = en(() =>
      runTestSource("TEST_A: proc;\n  call ASSERT_TRUE('0'b, 'x');\nend TEST_A;\n"),
    );
    expect(report.results[0]?.status).toBe("failed");
    expect(report.results[0]?.message).toBe("x : expected true but was false");
  });

  it("日本語に戻る", () => {
    const r = runProgram("m: proc options(main);\n  dcl p pointer;\n  p = 1;\nend m;\n");
    expect(r.diagnostics[0]?.message).toBe("ポインタにはポインタしか代入できません");
  });
});

describe("RunOptions.locale", () => {
  it("1 回の実行だけ英語にできる", () => {
    const r = runProgram("m: proc options(main);\n  dcl p pointer;\n  p = 1;\nend m;\n", {
      locale: "en",
    });
    expect(r.diagnostics[0]?.message).toBe("Only a pointer can be assigned to a pointer");
    // 呼び出し側の設定は戻る
    expect(getLocale()).toBe("ja");
  });

  it("テストの報告も英語にできる", () => {
    const report = runTestSource(
      "TEST_A: proc;\n  call ASSERT_TRUE('0'b, 'x');\nend TEST_A;\n",
      { locale: "en" },
    );
    expect(report.results[0]?.message).toBe("x : expected true but was false");
    expect(getLocale()).toBe("ja");
  });
});

describe("tr（表に入れた日本語を訳す）", () => {
  it("差し込みも埋める", () => {
    expect(withLocale("en", () => tr("{0} 行", 3))).toBe("3 lines");
  });

  it("表に無ければそのまま", () => {
    expect(withLocale("en", () => tr("知らない語"))).toBe("知らない語");
  });
});
