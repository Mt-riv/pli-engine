/**
 * pli-engine の公開 API。
 *
 * 実体は 3 つに分かれている:
 *   - `run.ts`      — ソースを実行して診断を返す
 *   - `host.ts`     — 外界（%INCLUDE とファイル）への差し込み口
 *   - `lint.ts`     — 構文は通るが怪しい書き方を指摘する
 *   - `snippets.ts` — コード Snippet の定義（単一の定義源）
 *   - `testing.ts`  — テストフレームワーク
 *
 * 利用側（ブラウザ版・VSCode 拡張・CLI）はここだけを見ればよい。
 */

export { VERSION, runProgram, LexError, ParseError, PreprocessError } from "./run.js";
export { MemoryHost } from "./host.js";
export type { PliHost, PliFile, FileMode } from "./host.js";
export type {
  Diagnostic,
  DiagnosticPhase,
  ProgramResult,
  ProgramOptions,
  RunOptions,
} from "./run.js";

export { lint, formatLint, RULES } from "./lint.js";
export type {
  LintCategory,
  LintMessage,
  LintOptions,
  LintRule,
  LintSeverity,
  RuleSetting,
} from "./lint.js";

export { SNIPPETS, plainText, toVscodeSnippets } from "./snippets.js";
export type { Snippet, VscodeSnippet } from "./snippets.js";

export {
  ASSERT_PRELUDE,
  ASSERT_PROCEDURES,
  discover,
  isTestFileName,
  isTestSource,
  runTestSource,
  formatReport,
  toXmlReport,
} from "./testing.js";
export type {
  Discovery,
  FormatOptions,
  TestOptions,
  TestReport,
  TestResult,
  TestStatus,
} from "./testing.js";
