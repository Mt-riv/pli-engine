/**
 * PL/I 向けのテストフレームワーク。
 *
 * テストファイルは**手続きの並び**で、主手続きは書かない。
 * 実行器が「アサーション一式＋利用者の手続き＋1件分の呼び出し」を
 * 組み立てて、**テストごとに1回ずつ**実行する。
 *
 * 決めごと:
 *   - `ASSERT_EQUALS(期待, 実際, 説明)` の引数順。報告の
 *     「期待 / 実際」が入れ替わらないよう、この順で固定する
 *   - 表明が失敗したらそのテストを即座に中断する
 *   - failure（表明の失敗）と error（想定外の異常）を区別する
 *   - `SETUP` / `TEARDOWN` は各テストの前後に走る。失敗しても TEARDOWN は走る
 *   - `DISABLED_` 接頭辞で実行を止め、`SKIP_TEST` でその場から読み飛ばす
 *   - CI が読める XML（testsuite / testcase）で結果を出せる
 *
 * **全体の前後に一度だけ走る仕掛けは持たない。** テストごとに別々に
 * 実行するので複数のテストにまたがる状態が存在せず、設けても意味を
 * 持たない。守れない約束を用意する方が害が大きいと考えた。
 */

import type { PliHost } from "./host.js";
import { parse } from "./parser.js";
import { runProgram, type ProgramOptions } from "./run.js";

/** 出力に混ぜる目印。実行結果から状態を読み取るために使う。 */
const MARK = "__PLITEST:";

/**
 * アサーションの一式（PL/I で書かれた前置き）。
 *
 * 失敗したら目印を出力してから `signal error` で中断する。
 * ERROR は再開可能でないため、実行器が仕掛けた ON 単位が走ったあと
 * プログラムが終わる。これで「表明の失敗でテストを中断しつつ
 * TEARDOWN は実行する」という形になる。
 */
export const ASSERT_PRELUDE = `
  /* ---- テストフレームワーク（自動挿入） ---- */
  __REPORT: proc(kind, msg);
    dcl kind char(8) varying;
    dcl msg  char(200) varying;
    put skip edit('${MARK}', kind, ':', msg)(a, a, a, a);
  end __REPORT;

  /* 数値を読みやすい文字列にする。
     FIXED DEC(15,5) をそのまま連結すると '          10.00000' のように
     桁合わせの空白と末尾の 0 が付くので、報告の前に落とす。 */
  __NUM: proc(v) returns(char(32) varying);
    dcl v fixed dec(15,5);
    dcl s char(32) varying;
    s = v;
    do while(length(s) > 0 & substr(s, 1, 1) = ' ');
      s = substr(s, 2);
    end;
    do while(length(s) > 0 & substr(s, length(s), 1) = ' ');
      s = substr(s, 1, length(s) - 1);
    end;
    if index(s, '.') > 0 then do;
      do while(substr(s, length(s), 1) = '0');
        s = substr(s, 1, length(s) - 1);
      end;
      if substr(s, length(s), 1) = '.' then s = substr(s, 1, length(s) - 1);
    end;
    return(s);
  end __NUM;

  __ABORT: proc(kind, msg);
    dcl kind char(8) varying;
    dcl msg  char(200) varying;
    call __REPORT(kind, msg);
    signal error;
  end __ABORT;

  FAIL: proc(msg);
    dcl msg char(200) varying;
    call __ABORT('FAIL', msg);
  end FAIL;

  SKIP_TEST: proc(msg);
    dcl msg char(200) varying;
    call __ABORT('SKIP', msg);
  end SKIP_TEST;

  ASSERT_TRUE: proc(cond, msg);
    dcl cond bit(1);
    dcl msg  char(200) varying;
    if ^cond then call FAIL(msg || ' : 真であるべきところが偽');
  end ASSERT_TRUE;

  ASSERT_FALSE: proc(cond, msg);
    dcl cond bit(1);
    dcl msg  char(200) varying;
    if cond then call FAIL(msg || ' : 偽であるべきところが真');
  end ASSERT_FALSE;

  ASSERT_EQUALS: proc(expected, actual, msg);
    dcl expected fixed dec(15,5);
    dcl actual   fixed dec(15,5);
    dcl msg      char(200) varying;
    if expected ^= actual then
      call FAIL(msg || ' : 期待 ' || __NUM(expected) || ' / 実際 ' || __NUM(actual));
  end ASSERT_EQUALS;

  ASSERT_NOT_EQUALS: proc(unexpected, actual, msg);
    dcl unexpected fixed dec(15,5);
    dcl actual     fixed dec(15,5);
    dcl msg        char(200) varying;
    if unexpected = actual then
      call FAIL(msg || ' : ' || __NUM(actual) || ' と異なるべきところが同じ');
  end ASSERT_NOT_EQUALS;

  ASSERT_EQUALS_CHAR: proc(expected, actual, msg);
    dcl expected char(200) varying;
    dcl actual   char(200) varying;
    dcl msg      char(200) varying;
    if expected ^= actual then
      call FAIL(msg || ' : 期待 ''' || expected || ''' / 実際 ''' || actual || '''');
  end ASSERT_EQUALS_CHAR;
  /* ---- ここまで ---- */
`;

/**
 * フレームワークが注入する手続きの名前。
 *
 * テストファイルの中では宣言せずに呼ぶので、 Linter が
 * 「定義されていない手続き」と報告しないために公開する。
 */
export const ASSERT_PROCEDURES: ReadonlySet<string> = new Set([
  "ASSERT_EQUALS",
  "ASSERT_NOT_EQUALS",
  "ASSERT_EQUALS_CHAR",
  "ASSERT_TRUE",
  "ASSERT_FALSE",
  "FAIL",
  "SKIP_TEST",
]);

export interface Discovery {
  tests: string[];
  disabled: string[];
  hasSetup: boolean;
  hasTeardown: boolean;
  /** 解析できなかった場合の説明。 */
  error?: string;
}

const TEST_RE = /^TEST_/i;
const DISABLED_RE = /^DISABLED_TEST_/i;

/**
 * テストファイルから手続きを見つける。
 * テストは引数なしで呼ぶので、引数を取る手続きは対象にしない。
 */
export function discover(source: string, host?: PliHost): Discovery {
  const tests: string[] = [];
  const disabled: string[] = [];
  let hasSetup = false;
  let hasTeardown = false;
  try {
    const program = parse(source, host === undefined ? {} : { host });
    for (const s of program.body) {
      if (s.kind !== "procedure") continue;
      const upper = s.name.toUpperCase();
      if (upper === "SETUP") hasSetup = true;
      else if (upper === "TEARDOWN") hasTeardown = true;
      else if (s.params.length === 0) {
        if (DISABLED_RE.test(s.name)) disabled.push(s.name);
        else if (TEST_RE.test(s.name)) tests.push(s.name);
      }
    }
  } catch (e) {
    return {
      tests: [],
      disabled: [],
      hasSetup: false,
      hasTeardown: false,
      error: (e as Error).message,
    };
  }
  return { tests, disabled, hasSetup, hasTeardown };
}

/**
 * 名前の規約からテストファイルとみなせるか。
 * `*_test.pli` / `test_*.pli` / `*.test.pli`（拡張子は .pli / .pl1）。
 */
export function isTestFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (!/\.(pli|pl1)$/.test(lower)) return false;
  const base = lower.slice(lower.search(/[^/\\]*$/)).replace(/\.[^.]*$/, "");
  return base.endsWith("_test") || base.startsWith("test_") || base.endsWith(".test");
}

/**
 * 中身からテストファイルとみなせるか。
 * 主手続きが無く、`TEST_` で始まる引数なしの手続きがあるとき。
 * そのまま実行しても「主手続きが無い」で終わるだけなので、
 * 名前の規約に合っていなくてもテストとして扱って差し支えない。
 */
export function isTestSource(source: string, host?: PliHost): boolean {
  if (/\boptions\s*\(\s*main\s*\)/i.test(source)) return false;
  return discover(source, host).tests.length > 0;
}

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface TestResult {
  name: string;
  status: TestStatus;
  /** 失敗・異常・読み飛ばしの理由。 */
  message?: string;
  stdout: string;
  durationMs: number;
}

export interface TestReport {
  results: TestResult[];
  total: number;
  passed: number;
  /** 表明が失敗した件数。 */
  failures: number;
  /** 想定外の異常で終わった件数。 */
  errors: number;
  skipped: number;
  ok: boolean;
  durationMs: number;
  /** テストが見つからない、解析できないなど全体に関わる注記。 */
  note?: string;
}

/**
 * 1件分の駆動プログラムを組み立てる。
 *
 * ON ERROR を仕掛けてあるので、表明の失敗（signal error）でも
 * 想定外の異常でも TEARDOWN が走る。ERROR は再開可能でないため
 * ON 単位のあとプログラムは終わる。
 * TEARDOWN 自身が異常を起こしたときに ON 単位へ再入しないよう
 * 旗で守っている。
 */
function buildDriver(
  source: string,
  testName: string,
  d: Discovery,
): string {
  const setup = d.hasSetup ? "  call SETUP;\n" : "";
  const teardown = d.hasTeardown ? "  call TEARDOWN;\n" : "";
  const teardownOnError = d.hasTeardown
    ? "      if ^__INTD then do; __INTD = '1'b; call TEARDOWN; end;\n"
    : "";
  return `__PLITEST_RUNNER: proc options(main);
  dcl __INTD bit(1);
  __INTD = '0'b;
${ASSERT_PRELUDE}
${source}
  on error
    begin;
${teardownOnError}    end;
${setup}  call ${testName};
${teardown}end __PLITEST_RUNNER;
`;
}

/** 出力から目印の行を取り出す。 */
function readMarks(stdout: string): { kind: string; message: string }[] {
  const out: { kind: string; message: string }[] = [];
  for (const line of stdout.split("\n")) {
    const i = line.indexOf(MARK);
    if (i < 0) continue;
    const rest = line.slice(i + MARK.length);
    const sep = rest.indexOf(":");
    if (sep < 0) continue;
    out.push({ kind: rest.slice(0, sep).trim(), message: rest.slice(sep + 1).trim() });
  }
  return out;
}

/** 目印の行を取り除いて、利用者が出した内容だけにする。 */
function stripMarks(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => !l.includes(MARK))
    .join("\n");
}

export interface TestOptions extends ProgramOptions {}

/** テストファイルの中身を実行して結果をまとめる。 */
export function runTestSource(source: string, opts: TestOptions = {}): TestReport {
  const started = Date.now();
  const d = discover(source, opts.host);

  const empty = (note: string): TestReport => ({
    results: [],
    total: 0,
    passed: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    ok: false,
    durationMs: Date.now() - started,
    note,
  });

  if (d.error) return empty(`テストファイルを解析できません: ${d.error}`);
  if (d.tests.length === 0 && d.disabled.length === 0) {
    return empty("テストが見つかりません。TEST_ で始まる引数なしの手続きを定義してください。");
  }

  const results: TestResult[] = [];

  for (const name of d.disabled) {
    results.push({
      name,
      status: "skipped",
      message: "DISABLED_ が付いているため実行しません",
      stdout: "",
      durationMs: 0,
    });
  }

  for (const name of d.tests) {
    const t0 = Date.now();
    const r = runProgram(buildDriver(source, name, d), {
      maxSteps: opts.maxSteps ?? 5_000_000,
      maxOutputBytes: opts.maxOutputBytes ?? 1_000_000,
      ...(opts.args ? { args: opts.args } : {}),
      // %INCLUDE とファイル入出力はテストの中でも使える
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    });
    const marks = readMarks(r.stdout);
    const stdout = stripMarks(r.stdout);
    const durationMs = Date.now() - t0;

    const skip = marks.find((m) => m.kind === "SKIP");
    if (skip) {
      results.push({ name, status: "skipped", message: skip.message, stdout, durationMs });
      continue;
    }
    const fail = marks.find((m) => m.kind === "FAIL");
    if (fail) {
      results.push({ name, status: "failed", message: fail.message, stdout, durationMs });
      continue;
    }
    // 表明の失敗が無いのに異常終了していれば error。
    // ただし表明の中断で出る ERROR condition は上で拾っているのでここには来ない。
    if (r.diagnostics.length > 0) {
      results.push({
        name,
        status: "error",
        message: r.diagnostics.map((x) => x.message).join(" / "),
        stdout,
        durationMs,
      });
      continue;
    }
    results.push({ name, status: "passed", stdout, durationMs });
  }

  const count = (s: TestStatus) => results.filter((r) => r.status === s).length;
  const failures = count("failed");
  const errors = count("error");
  return {
    results,
    total: results.length,
    passed: count("passed"),
    failures,
    errors,
    skipped: count("skipped"),
    ok: failures === 0 && errors === 0,
    durationMs: Date.now() - started,
  };
}

const STATUS_LABEL: Record<TestStatus, string> = {
  passed: "成功",
  failed: "失敗",
  error: "異常",
  skipped: "省略",
};

export interface FormatOptions {
  /**
   * 失敗・異常で終わったテストが `PUT` で出した内容を末尾に添えるか。
   * 成功した分まで出すと報告が埋もれるので、添えるのは失敗した分だけ。
   */
  failedOutput?: boolean;
}

/** コンソール向けの報告を作る。 */
export function formatReport(
  report: TestReport,
  title = "テスト",
  opts: FormatOptions = {},
): string {
  const lines: string[] = [`--- ${title} ---`];
  if (report.note) lines.push(report.note);

  for (const r of report.results) {
    const mark =
      r.status === "passed" ? "OK  "
      : r.status === "failed" ? "FAIL"
      : r.status === "error" ? "ERR "
      : "SKIP";
    lines.push(`  ${mark} ${r.name} (${r.durationMs}ms)`);
    if (r.message) lines.push(`       ${STATUS_LABEL[r.status]}: ${r.message}`);
  }

  lines.push(
    "",
    `テスト ${report.total} / 成功 ${report.passed} / 失敗 ${report.failures} / ` +
      `異常 ${report.errors} / 省略 ${report.skipped} / ${report.durationMs}ms`,
  );

  if (opts.failedOutput) {
    for (const r of report.results) {
      if (r.status === "passed" || r.status === "skipped") continue;
      const body = r.stdout.trim();
      if (body !== "") lines.push("", `--- ${r.name} の出力 ---`, body);
    }
  }
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CI が読める XML（testsuite / testcase）を作る。 */
export function toXmlReport(report: TestReport, suiteName: string): string {
  const cases = report.results
    .map((r) => {
      const head =
        `    <testcase name="${escapeXml(r.name)}" classname="${escapeXml(suiteName)}"` +
        ` time="${(r.durationMs / 1000).toFixed(3)}"`;
      const msg = escapeXml(r.message ?? "");
      if (r.status === "passed") return `${head} />`;
      if (r.status === "skipped") {
        return `${head}>\n      <skipped message="${msg}" />\n    </testcase>`;
      }
      const tag = r.status === "failed" ? "failure" : "error";
      return (
        `${head}>\n      <${tag} message="${msg}">${msg}</${tag}>\n    </testcase>`
      );
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(suiteName)}" tests="${report.total}"` +
      ` failures="${report.failures}" errors="${report.errors}"` +
      ` skipped="${report.skipped}" time="${(report.durationMs / 1000).toFixed(3)}">`,
    cases,
    "</testsuite>",
    "",
  ].join("\n");
}
