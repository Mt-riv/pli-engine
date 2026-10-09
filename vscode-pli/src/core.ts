/**
 * VSCode API に依存しない部分。
 * ここを分離しておくと VSCode 無しでテストできる。
 */

import {
  lint,
  runProgram,
  isTestFileName,
  isTestSource,
  runTestSource,
  SNIPPETS,
  formatReport,
  type Diagnostic,
  type LintMessage,
  type LintOptions,
  type LintSeverity,
  type PliHost,
  type ProgramResult,
  type TestReport,
} from "../../engine/src/index.js";

export interface Position {
  /** 0 始まり（VSCode の流儀）。 */
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface EditorDiagnostic {
  range: Range;
  message: string;
  /** VSCode の DiagnosticSeverity に対応する。 */
  severity: "error" | "warning" | "info";
  source: string;
  /** Linter の規則 id。問題タブに出して設定で切れるようにする。 */
  code?: string;
}

/**
 * エンジンの診断（1 始まりの行・桁）を
 * エディタの範囲（0 始まり）に変換する。
 *
 * 桁が分からない実行時エラーでは、その行全体を範囲にする。
 */
export function toEditorDiagnostics(
  source: string,
  diagnostics: readonly Diagnostic[],
): EditorDiagnostic[] {
  const lines = source.split("\n");
  return diagnostics.map((d) => {
    const lineIndex = Math.max(0, Math.min(d.line - 1, Math.max(0, lines.length - 1)));
    const text = lines[lineIndex] ?? "";
    // 桁が分かる場合はその位置から行末まで、分からない場合は
    // 行頭の空白を除いた範囲にして、空行でも 1 文字分の幅を持たせる。
    const startCol = d.col === undefined ? text.length - text.trimStart().length : d.col - 1;
    const start = Math.max(0, Math.min(startCol, text.length));
    const end = Math.max(start + 1, text.length);
    return {
      range: {
        start: { line: lineIndex, character: start },
        end: { line: lineIndex, character: end },
      },
      message: `${d.message} (${d.phase})`,
      severity: "error" as const,
      source: "pli",
    };
  });
}

export interface CheckOptions {
  maxSteps?: number;
  maxOutputBytes?: number;
  /** `%INCLUDE` とファイル入出力に使う。 */
  host?: PliHost;
  /**
   * DL/I（IMS/DB）で使う PSB の名前。
   * 指定すると `<名前>.psb` をホストから読み、主手続きの引数が
   * PCB のポインタになる。
   */
  psb?: string;
}

/** Linter の指摘をエディタの範囲に移す。 */
export function toEditorLint(
  source: string,
  messages: readonly LintMessage[],
): EditorDiagnostic[] {
  const lines = source.split("\n");
  return messages.map((m) => {
    const lineIndex = Math.max(0, Math.min(m.line - 1, Math.max(0, lines.length - 1)));
    const text = lines[lineIndex] ?? "";
    const startCol =
      m.col === undefined ? text.length - text.trimStart().length : m.col - 1;
    const start = Math.max(0, Math.min(startCol, text.length));
    const end = Math.max(start + 1, text.length);
    return {
      range: {
        start: { line: lineIndex, character: start },
        end: { line: lineIndex, character: end },
      },
      message: m.message,
      severity: m.severity satisfies LintSeverity as EditorDiagnostic["severity"],
      source: "pli-lint",
      code: m.rule,
    };
  });
}

export interface CheckSyntaxOptions {
  /** Linter を動かすか。既定は動かす。 */
  lint?: boolean;
  lintOptions?: LintOptions;
  /** `%INCLUDE` の解決に使う。 */
  host?: PliHost;
}

/**
 * 構文を検査し、通れば Linter もかける（実行はしない）。
 *
 * 入力のたびに走らせるので、実行時エラーは対象にしない。
 * 構文が壊れている間は Linter が何も返さないので、
 * 打鍵の途中で指摘が増減してちらつくことはない。
 */
export function checkSyntax(
  source: string,
  opts: CheckSyntaxOptions = {},
): EditorDiagnostic[] {
  // 文を1つも実行させないことで解析だけを行う
  const host = opts.host;
  const r = runProgram(source, { maxSteps: 0, ...(host ? { host } : {}) });
  const syntaxOnly = r.diagnostics.filter((d) => d.phase !== "runtime");
  const out = toEditorDiagnostics(source, syntaxOnly);
  if (opts.lint === false || syntaxOnly.length > 0) return out;
  return [
    ...out,
    ...toEditorLint(source, lint(source, { ...(opts.lintOptions ?? {}), ...(host ? { host } : {}) })),
  ];
}

export interface RunOutcome {
  result: ProgramResult;
  /** 出力パネルに出す整形済みの本文。 */
  report: string;
  diagnostics: EditorDiagnostic[];
}

/** 実行して、出力パネル用の本文と診断を組み立てる。 */
export function runForEditor(
  source: string,
  fileName: string,
  opts: CheckOptions & { args?: string[] } = {},
): RunOutcome {
  const result = runProgram(source, {
    maxSteps: opts.maxSteps ?? 5_000_000,
    maxOutputBytes: opts.maxOutputBytes ?? 1_000_000,
    ...(opts.args ? { args: opts.args } : {}),
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.psb === undefined || opts.psb === "" ? {} : { psb: opts.psb }),
  });

  const head = `--- ${fileName} ---`;
  const body = result.stdout === "" ? "(出力なし)" : result.stdout.replace(/\n$/, "");
  const parts = [head, body];

  if (result.diagnostics.length > 0) {
    parts.push("");
    for (const d of result.diagnostics) {
      const where = d.col === undefined ? `${d.line}行` : `${d.line}行${d.col}桁`;
      parts.push(`[${d.phase}] ${where}: ${d.message}`);
    }
  }
  const flags: string[] = [];
  flags.push(result.ok ? "成功" : "失敗");
  if (result.truncated) flags.push("出力打ち切り");
  flags.push(`${result.durationMs}ms`);
  parts.push("", flags.join(" / "));

  return {
    result,
    report: parts.join("\n"),
    diagnostics: toEditorDiagnostics(source, result.diagnostics),
  };
}

/**
 * テストファイルらしいかを判定する。
 *
 * 名前の規約（`*_test.pli` など）だけでなく中身も見る。
 * 判定の実体はエンジン側（`testing.ts`）にあり、
 * ブラウザ版と同じ基準になるようにしている。
 */
export function looksLikeTestFile(
  fileName: string,
  source: string,
  host?: PliHost,
): boolean {
  return isTestFileName(fileName) || isTestSource(source, host);
}

export interface TestOutcome {
  report: TestReport;
  /** 出力パネルに出す整形済みの本文。 */
  text: string;
}

/** テストとして実行して、出力パネル用の本文を組み立てる。 */
export function runTestsForEditor(
  source: string,
  fileName: string,
  opts: CheckOptions = {},
): TestOutcome {
  const report = runTestSource(source, {
    maxSteps: opts.maxSteps ?? 5_000_000,
    maxOutputBytes: opts.maxOutputBytes ?? 1_000_000,
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.psb === undefined || opts.psb === "" ? {} : { psb: opts.psb }),
  });

  return { report, text: formatReport(report, fileName, { failedOutput: true }) };
}

export interface SnippetCompletion {
  /** 入力して展開する語。 */
  label: string;
  /** VSCode の Snippet 記法を含む本文。 */
  body: string;
  detail: string;
  documentation: string;
}

/**
 * Snippet を補完項目の形にする。
 *
 * `pli`（この拡張が登録する言語）には package.json の宣言で
 * Snippet を載せている。しかし `pl1` は**こちらが宣言していない言語**
 * なので、宣言的な寄与を書くと「Unknown language」の警告になる。
 * そこで `pl1` では補完として提供する。
 */
export function snippetCompletions(): SnippetCompletion[] {
  return SNIPPETS.map((s) => ({
    label: s.prefix,
    body: s.body.join("\n"),
    detail: s.name,
    documentation: s.description,
  }));
}
