/**
 * pli-engine の公開 API。
 *
 * 実体は 7 つに分かれている:
 *   - `run.ts`      — ソースを実行して診断を返す
 *   - `host.ts`     — 外界（%INCLUDE とファイル）への差し込み口
 *   - `lint.ts`     — 構文は通るが怪しい書き方を指摘する
 *   - `snippets.ts` — コード Snippet の定義（単一の定義源）
 *   - `testing.ts`  — テストフレームワーク
 *   - `mfs/`        — 画面の書式（MID / MOD / DIF / DOF）と画面そのもの
 *   - `tm/`         — メッセージキューと、画面との往復
 *
 * 利用側（ブラウザ版・VSCode Extension・CLI）はここだけを見ればよい。
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

export { lint, formatLint, isFragmentFileName, RULES } from "./lint.js";
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

// ---- MFS（画面入出力）と IMS TM ----

export {
  EMPTY_LIBRARY,
  MfsBlockError,
  MfsDefError,
  MfsLibrary,
  segmentLength,
} from "./mfs/blocks.js";
export type {
  Attr,
  DeviceFormat,
  Dfld,
  Dpage,
  Dsca,
  Fill,
  Lpage,
  MessageDesc,
  Mfld,
  MsgSeg,
} from "./mfs/blocks.js";

export { loadMfs, mfsFileNames, parseMfs } from "./mfs/source.js";
export {
  addressOf,
  blankScreen,
  cells,
  fieldAt,
  fieldNamed,
  layout,
  positionOf,
  rowText,
} from "./mfs/device.js";
export type { Screen, ScreenField } from "./mfs/device.js";
export { formatOutput, modNameFor, systemLiteral } from "./mfs/output.js";
export type { OutputOptions } from "./mfs/output.js";
export { aidName, formatInput } from "./mfs/input.js";
export type { Aid, DeviceInput } from "./mfs/input.js";
export { allRows, attrText, renderScreen, ruler } from "./mfs/render.js";
export type { RenderOptions } from "./mfs/render.js";

export { julianDate, timeOfDay, TmRuntime, TmUnsupported } from "./tm/tm.js";
export type { InputMessage, IoPcbState, OutputMessage, TmOptions } from "./tm/tm.js";
export { Session, firstWord } from "./tm/session.js";
export type { SessionOptions, SessionStep } from "./tm/session.js";
