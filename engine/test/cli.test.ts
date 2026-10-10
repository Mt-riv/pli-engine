/**
 * CLI 3 本の引数処理と終了コード。
 *
 * ここにテストが無かったため、次のような壊れ方が見つからなかった。
 *   - `plilint` が構文エラーのファイルを「指摘なし・終了コード 0」にする
 *   - `plitest` が出力上限に達したテストを成功にする
 *   - `--max-steps abc` が NaN になってステップ上限そのものを無効にする
 *   - パイプへの出力が 65536 バイトで黙って切れる
 *
 * CLI はプロセスとして起こす。終了コードと、パイプ越しの出力量まで見たいため。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

let dir: string;

/** CLI を 1 本走らせる。終了コードと標準出力・標準エラーを返す。 */
function run(
  script: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", join(SCRIPTS, script), ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pli-cli-"));
  writeFileSync(
    join(dir, "ok.pli"),
    "m: proc options(main);\n  put list('HI');\nend m;\n",
  );
  writeFileSync(
    join(dir, "broken.pli"),
    "m: proc options(main);\n  dcl x fixed bin(15);\n  x = ;\nend m;\n",
  );
  writeFileSync(
    join(dir, "loop.pli"),
    "m: proc options(main);\n  dcl i fixed bin(31);\n  i = 0;\n  do while('1'b); i = i + 1; end;\nend m;\n",
  );
  writeFileSync(
    join(dir, "big.pli"),
    `m: proc options(main);
  dcl i fixed bin(31);
  do i = 1 to 4000;
    put skip list('0123456789012345678901234567890123456789');
  end;
end m;
`,
  );
  // 出力上限に達したあとで必ず失敗する表明を置く
  writeFileSync(
    join(dir, "flood_test.pli"),
    `test_flood: proc;
  dcl i fixed bin(31);
  do i = 1 to 200000;
    put skip list('0123456789012345678901234567890123456789');
  end;
  call assert_true('0'b, 'ここは必ず失敗する');
end test_flood;
`,
  );
  // 失敗する表明の位置を固定して、報告の行番号を見る
  writeFileSync(
    join(dir, "fails_test.pli"),
    `test_fails: proc;
  dcl n fixed bin(31);
  call assert_equals(1, 2, 'わざと');
  n = 1;
end test_fails;
`,
  );
  mkdirSync(join(dir, "nested"));
  writeFileSync(
    join(dir, "nested", "good_test.pli"),
    "test_a: proc;\n  call assert_equals(1, 1, 'ok');\nend test_a;\n",
  );
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pli", () => {
  it("正常なプログラムは終了コード 0", () => {
    const r = run("pli.ts", [join(dir, "ok.pli")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("HI");
  });

  it("構文エラーは終了コード 1", () => {
    const r = run("pli.ts", [join(dir, "broken.pli")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/式が必要です/);
  });

  it("--max-steps に数でない値を渡したら終了コード 2（NaN で上限が消えるのを防ぐ）", () => {
    const r = run("pli.ts", [join(dir, "loop.pli"), "--max-steps", "abc"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/1 以上の整数/);
  });

  it("値を取るオプションの値が欠けていたら終了コード 2", () => {
    expect(run("pli.ts", [join(dir, "ok.pli"), "--psb"]).code).toBe(2);
    expect(run("pli.ts", [join(dir, "ok.pli"), "--max-steps"]).code).toBe(2);
  });

  it("無限ループは止まった行を指す", () => {
    const r = run("pli.ts", [join(dir, "loop.pli"), "--max-steps", "1000"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/loop\.pli:4:/);
  });

  it("読めないソースはスタックトレースではなく 1 行で報告する", () => {
    const r = run("pli.ts", [join(dir, "nope.pli")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/ソースを読めません/);
    expect(r.stderr).not.toMatch(/at /);
  });

  it("--help は終了コード 0", () => {
    const r = run("pli.ts", ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/使い方: pli/);
  });

  it("パイプ越しでも出力が切れない", () => {
    // execFileSync は標準出力をパイプで受ける。
    // process.exit を使っていると 65536 バイトで切れる
    const r = run("pli.ts", [join(dir, "big.pli")]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(100_000);
  });
});

describe("plilint", () => {
  it("構文エラーのファイルは終了コード 1（「指摘なし」で通してはいけない）", () => {
    const r = run("plilint.ts", [join(dir, "broken.pli")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/構文/);
    expect(r.stdout).not.toMatch(/指摘はありません/);
  });

  it("正常なファイルは終了コード 0", () => {
    expect(run("plilint.ts", [join(dir, "ok.pli")]).code).toBe(0);
  });

  it("--list-rules は規則数を出す", () => {
    const r = run("plilint.ts", ["--list-rules"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/合計 \d+ 規則/);
  });

  it("知らない規則 id は終了コード 2", () => {
    const r = run("plilint.ts", [join(dir, "ok.pli"), "--rule", "nope=off"]);
    expect(r.code).toBe(2);
  });
});

describe("plitest", () => {
  it("出力上限に達したテストは成功にしない", () => {
    const r = run("plitest.ts", [join(dir, "flood_test.pli")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/異常 1/);
  });

  it("構文エラーのテストファイルは読み込み不能として数える", () => {
    const r = run("plitest.ts", [join(dir, "broken.pli")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/読み込み不能 1/);
  });

  it("通るテストは終了コード 0", () => {
    const r = run("plitest.ts", [join(dir, "nested")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/成功 1/);
  });

  it("PSB を指定しなくても隣の .psb を使う", () => {
    // 同梱の examples/tests には DL/I のテストと STUPSB.psb が同居している
    const examples = join(SCRIPTS, "..", "examples", "tests");
    const r = run("plitest.ts", [examples]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/異常 0/);
  });

  it("失敗した表明の行をテストファイルの行で報告する", () => {
    const r = run("plitest.ts", [join(dir, "fails_test.pli")]);
    expect(r.code).toBe(1);
    // 3 行目が失敗する表明。前置きの 80 行ほどを足した行ではない
    expect(r.stdout).toMatch(/失敗 \(3 行\)/);
  });

  it("--xml に file と line を入れる（CI が注釈を付けられる形）", () => {
    const out = join(dir, "xml");
    const r = run("plitest.ts", [join(dir, "fails_test.pli"), "--xml", out, "-q"]);
    expect(r.code).toBe(1);
    const xml = readFileSync(join(out, "fails_test.xml"), "utf8");
    expect(xml).toContain('line="3"');
    expect(xml).toMatch(/file="[^"]*fails_test\.pli"/);
  });

  it("--help は終了コード 0", () => {
    expect(run("plitest.ts", ["--help"]).code).toBe(0);
  });
});
