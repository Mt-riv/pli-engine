import { describe, expect, it } from "vitest";
import {
  ASSERT_PRELUDE,
  discover,
  formatReport,
  runTestSource,
  toXmlReport,
} from "../src/testing.js";
import { runProgram } from "../src/index.js";

/**
 * PL/I 向けのテストフレームワーク。
 *
 * テストファイルは「手続きの並び」とし、主手続きは書かない。
 * 実行器が アサーション一式 ＋ 利用者の手続き ＋ 1件分の呼び出し
 * を組み立てて、**テストごとに1回ずつ**実行する。
 *
 * 決めごと:
 *   - ASSERT_EQUALS(期待, 実際, 説明) の引数順
 *   - 表明が失敗したらそのテストは即座に中断する
 *   - failure（表明の失敗）と error（想定外の異常）を区別する
 *   - SETUP / TEARDOWN は各テストの前後に走る。失敗しても TEARDOWN は走る
 *   - DISABLED_ 接頭辞で実行を止め、SKIP_TEST でその場から読み飛ばす
 *   - CI が読める XML 出力
 */

describe("discover", () => {
  const SRC = `
TEST_ADD: proc;
end TEST_ADD;

DISABLED_TEST_WIP: proc;
end DISABLED_TEST_WIP;

SETUP: proc;
end SETUP;

TEARDOWN: proc;
end TEARDOWN;

HELPER: proc(x) returns(fixed bin(31));
  dcl x fixed bin(31);
  return(x);
end HELPER;
`;

  it("TEST_ で始まる手続きをテストとして拾う", () => {
    expect(discover(SRC).tests).toEqual(["TEST_ADD"]);
  });

  it("DISABLED_ の付いたテストは無効として拾う", () => {
    expect(discover(SRC).disabled).toEqual(["DISABLED_TEST_WIP"]);
  });

  it("SETUP / TEARDOWN を認識する", () => {
    expect(discover(SRC).hasSetup).toBe(true);
    expect(discover(SRC).hasTeardown).toBe(true);
  });

  it("補助手続きはテストに含めない", () => {
    expect(discover(SRC).tests).not.toContain("HELPER");
  });

  it("引数を取る手続きはテストとみなさない（引数なしで呼ぶため）", () => {
    expect(discover("TEST_X: proc(a); dcl a fixed bin(31); end TEST_X;").tests).toEqual([]);
  });

  it("大文字小文字を区別しない", () => {
    expect(discover("test_lower: proc; end test_lower;").tests).toEqual(["test_lower"]);
  });

  it("解析できないソースでは誤りを返す", () => {
    const d = discover("これは PL/I ではない");
    expect(d.tests).toEqual([]);
    expect(d.error).toBeTruthy();
  });
});

describe("アサーションの前置き", () => {
  it("それ自体が解析でき、実行できる", () => {
    const src = `t: proc options(main);\n${ASSERT_PRELUDE}\ncall ASSERT_TRUE('1'b, 'x');\nend t;\n`;
    const r = runProgram(src, { maxSteps: 100_000 });
    expect(r.diagnostics).toEqual([]);
  });
});

const one = (body: string, opts = {}) =>
  runTestSource(`TEST_X: proc;\n${body}\nend TEST_X;`, opts).results[0];

describe("アサーション", () => {
  /**
   * 引数順は (期待, 実際)。
   * 取り違えると失敗の説明が逆になるので、順序もテストで固定する。
   */
  it("failedOutput は失敗したテストの出力だけを添える", () => {
    const r = runTestSource(`
TEST_OK: proc;
  put skip list('成功したテストの出力');
  call ASSERT_EQUALS(4, 2 + 2, '足し算');
end TEST_OK;
TEST_NG: proc;
  put skip list('失敗したテストの出力');
  call ASSERT_EQUALS(5, 2 + 2, 'わざと間違える');
end TEST_NG;
`);
    const plain = formatReport(r, "x");
    expect(plain).not.toContain("の出力 ---");

    const withOutput = formatReport(r, "x", { failedOutput: true });
    expect(withOutput).toContain("--- TEST_NG の出力 ---");
    expect(withOutput).toContain("失敗したテストの出力");
    expect(withOutput).not.toContain("TEST_OK の出力");
    expect(withOutput).not.toContain("成功したテストの出力");
  });

  it("報告の数値は桁合わせの空白と末尾の 0 を落とす", () => {
    const r = runTestSource(`
TEST_INT: proc;
  call ASSERT_EQUALS(10, 7 + 2, '整数');
end TEST_INT;
TEST_DEC: proc;
  call ASSERT_EQUALS(3.25, 1.5, '小数');
end TEST_DEC;
TEST_NEG: proc;
  call ASSERT_EQUALS(-1, 0, '負とゼロ');
end TEST_NEG;
`);
    const msg = (name: string) =>
      r.results.find((x) => x.name === name)?.message;
    expect(msg("TEST_INT")).toBe("整数 : 期待 10 / 実際 9");
    expect(msg("TEST_DEC")).toBe("小数 : 期待 3.25 / 実際 1.5");
    expect(msg("TEST_NEG")).toBe("負とゼロ : 期待 -1 / 実際 0");
  });

  it("ASSERT_EQUALS は (期待, 実際) の順", () => {
    expect(one("call ASSERT_EQUALS(3, 3, 'eq');")?.status).toBe("passed");
    const f = one("call ASSERT_EQUALS(3, 4, 'eq');");
    expect(f?.status).toBe("failed");
    // 期待 3、実際 4 と報告される
    expect(f?.message).toMatch(/期待.*3/);
    expect(f?.message).toMatch(/実際.*4/);
  });

  it("ASSERT_EQUALS は10進固定小数点も正確に比べる", () => {
    const src = `
  dcl x fixed dec(5,2);
  dcl y fixed dec(3,1);
  x = 123.45;
  y = 6.7;
  call ASSERT_EQUALS(827.115, x * y, '10進');
`;
    expect(one(src)?.status).toBe("passed");
  });

  it("ASSERT_EQUALS_CHAR は文字列を比べる", () => {
    expect(one("call ASSERT_EQUALS_CHAR('abc', 'abc', 'c');")?.status).toBe("passed");
    expect(one("call ASSERT_EQUALS_CHAR('abc', 'abd', 'c');")?.status).toBe("failed");
  });

  it("ASSERT_NOT_EQUALS", () => {
    expect(one("call ASSERT_NOT_EQUALS(1, 2, 'ne');")?.status).toBe("passed");
    expect(one("call ASSERT_NOT_EQUALS(1, 1, 'ne');")?.status).toBe("failed");
  });

  it("ASSERT_TRUE / ASSERT_FALSE", () => {
    expect(one("call ASSERT_TRUE('1'b, 't');")?.status).toBe("passed");
    expect(one("call ASSERT_TRUE('0'b, 't');")?.status).toBe("failed");
    expect(one("call ASSERT_FALSE('0'b, 'f');")?.status).toBe("passed");
    expect(one("call ASSERT_FALSE('1'b, 'f');")?.status).toBe("failed");
  });

  it("FAIL は必ず失敗にする", () => {
    const r = one("call FAIL('ここは通らないはず');");
    expect(r?.status).toBe("failed");
    expect(r?.message).toContain("ここは通らないはず");
  });

  /**
   * 表明が失敗した時点でそのテストは中断され、
   * そのテストの以降の処理は実行されない。同じ挙動にする。
   */
  it("表明が失敗したらそこでテストを中断する", () => {
    const r = one("call FAIL('一つ目'); put skip list('ここには来ない');");
    expect(r?.status).toBe("failed");
    expect(r?.message).toContain("一つ目");
    expect(r?.stdout).not.toContain("ここには来ない");
  });
});

describe("テストの状態", () => {
  it("passed / failed / error / skipped を区別する", () => {
    const src = `
TEST_PASS: proc;
  call ASSERT_TRUE('1'b, 'ok');
end TEST_PASS;

TEST_FAIL: proc;
  call ASSERT_EQUALS(1, 2, 'ちがう');
end TEST_FAIL;

TEST_ERROR: proc;
  dcl a fixed dec(3,0);
  a = 99999;
end TEST_ERROR;

TEST_SKIPPED: proc;
  call SKIP_TEST('まだ実装していない');
  call FAIL('ここには来ない');
end TEST_SKIPPED;

DISABLED_TEST_OFF: proc;
  call FAIL('無効なので走らない');
end DISABLED_TEST_OFF;
`;
    const r = runTestSource(src);
    const byName = Object.fromEntries(r.results.map((x) => [x.name, x]));
    expect(byName["TEST_PASS"]?.status).toBe("passed");
    expect(byName["TEST_FAIL"]?.status).toBe("failed");
    // 想定外の異常は failure ではなく error
    expect(byName["TEST_ERROR"]?.status).toBe("error");
    expect(byName["TEST_ERROR"]?.message).toContain("FIXEDOVERFLOW");
    expect(byName["TEST_SKIPPED"]?.status).toBe("skipped");
    expect(byName["TEST_SKIPPED"]?.message).toContain("まだ実装していない");
    expect(byName["DISABLED_TEST_OFF"]?.status).toBe("skipped");
  });

  it("集計する", () => {
    const src = `
TEST_A: proc; call ASSERT_TRUE('1'b, 'a'); end TEST_A;
TEST_B: proc; call FAIL('b'); end TEST_B;
TEST_C: proc; dcl a fixed dec(3,0); a = 99999; end TEST_C;
DISABLED_TEST_D: proc; end DISABLED_TEST_D;
`;
    const r = runTestSource(src);
    expect(r.total).toBe(4);
    expect(r.passed).toBe(1);
    expect(r.failures).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("全部成功すれば ok", () => {
    expect(runTestSource("TEST_A: proc; call ASSERT_TRUE('1'b, 'a'); end TEST_A;").ok).toBe(true);
  });

  it("無効なテストしか無い場合も ok とする（失敗は無いため）", () => {
    expect(runTestSource("DISABLED_TEST_A: proc; end DISABLED_TEST_A;").ok).toBe(true);
  });

  it("テストが1つも無ければ ok にしない", () => {
    const r = runTestSource("HELPER: proc; end HELPER;");
    expect(r.total).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.note).toContain("TEST_");
  });

  it("構文エラーは全体の誤りとして報告する", () => {
    const r = runTestSource("TEST_A: proc; x = 1 end TEST_A;");
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });

  it("無限ループは上限で止まり error になる", () => {
    const r = runTestSource("TEST_LOOP: proc; do while('1'b); end; end TEST_LOOP;", {
      maxSteps: 10_000,
    });
    expect(r.results[0]?.status).toBe("error");
    expect(r.results[0]?.message).toMatch(/上限/);
  });

  it("テストごとに所要時間を測る", () => {
    const r = runTestSource("TEST_A: proc; call ASSERT_TRUE('1'b, 'a'); end TEST_A;");
    expect(typeof r.results[0]?.durationMs).toBe("number");
    expect(typeof r.durationMs).toBe("number");
  });
});

describe("SETUP / TEARDOWN", () => {
  it("各テストの前後で呼ばれる", () => {
    const src = `
SETUP: proc;
  put skip list('setup');
end SETUP;

TEARDOWN: proc;
  put skip list('teardown');
end TEARDOWN;

TEST_A: proc;
  put skip list('body');
end TEST_A;
`;
    const out = runTestSource(src).results[0]?.stdout ?? "";
    expect(out.indexOf("setup")).toBeLessThan(out.indexOf("body"));
    expect(out.indexOf("body")).toBeLessThan(out.indexOf("teardown"));
  });

  /** テストが失敗しても後処理は走る。 */
  it("テストが失敗しても TEARDOWN は走る", () => {
    const src = `
TEARDOWN: proc;
  put skip list('teardown');
end TEARDOWN;

TEST_A: proc;
  call FAIL('だめ');
end TEST_A;
`;
    const r = runTestSource(src).results[0];
    expect(r?.status).toBe("failed");
    expect(r?.stdout).toContain("teardown");
  });

  it("想定外の異常でも TEARDOWN は走る", () => {
    const src = `
TEARDOWN: proc;
  put skip list('teardown');
end TEARDOWN;

TEST_A: proc;
  dcl a fixed dec(3,0);
  a = 99999;
end TEST_A;
`;
    const r = runTestSource(src).results[0];
    expect(r?.status).toBe("error");
    expect(r?.stdout).toContain("teardown");
  });

  it("テストごとに状態が分離される", () => {
    // 1件ずつ別に実行するので、前のテストの代入が残らない
    const src = `
TEST_A: proc;
  call ASSERT_EQUALS(0, SHARED, '初期値');
  SHARED = 99;
end TEST_A;

TEST_B: proc;
  call ASSERT_EQUALS(0, SHARED, '初期値のまま');
end TEST_B;
`;
    const r = runTestSource(src);
    expect(r.passed).toBe(2);
  });
});

describe("報告の整形", () => {
  const report = runTestSource(`
TEST_A: proc; call ASSERT_TRUE('1'b, 'a'); end TEST_A;
TEST_B: proc; call FAIL('わざと'); end TEST_B;
DISABLED_TEST_C: proc; end DISABLED_TEST_C;
`);

  it("コンソール向けの要約を作る", () => {
    const t = formatReport(report, "math_test.pli");
    expect(t).toContain("TEST_A");
    expect(t).toContain("TEST_B");
    expect(t).toMatch(/テスト 3/);
    expect(t).toMatch(/失敗 1/);
    expect(t).toContain("わざと");
  });

  it("CI が読める XML を作る", () => {
    const xml = toXmlReport(report, "math_test");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuite name="math_test"');
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<testcase name="TEST_A"');
    expect(xml).toContain("<failure");
    expect(xml).toContain("<skipped");
  });

  it("XML の特殊文字を逃がす", () => {
    const r = runTestSource(`TEST_X: proc; call FAIL('a<b>&"c"'); end TEST_X;`);
    const xml = toXmlReport(r, "s");
    expect(xml).toContain("&lt;b&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).not.toMatch(/message="[^"]*<b>/);
  });

  it("error は failure と別の要素になる", () => {
    const r = runTestSource("TEST_E: proc; dcl a fixed dec(3,0); a = 99999; end TEST_E;");
    const xml = toXmlReport(r, "s");
    expect(xml).toContain('errors="1"');
    expect(xml).toContain("<error");
    expect(xml).not.toContain("<failure");
  });
});
