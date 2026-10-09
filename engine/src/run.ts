/**
 * ソースを 1 本のプログラムとして実行する層。
 *
 * ブラウザ版（`web/`）と VSCode 拡張（`../vscode-pli/`）の両方がこれを使う。
 * どちらも「何行目で何が起きたか」を構造化された形で必要とするため、
 * 文字列のメッセージではなく診断の配列を返す。
 *
 * 公開 API のまとめは `index.ts`。テストフレームワーク（`testing.ts`）が
 * ここを使うので、循環参照を避けるために `index.ts` から分けてある。
 */

import { LexError } from "./lexer.js";
import { ParseError } from "./parser.js";
import { PreprocessError } from "./preprocess.js";
import {
  OutputLimitExceeded,
  StepLimitExceeded,
  Interpreter,
  type RunOptions,
} from "./interp.js";

export const VERSION = "0.1.0";

export type DiagnosticPhase = "preprocess" | "lex" | "parse" | "runtime";

export interface Diagnostic {
  severity: "error";
  phase: DiagnosticPhase;
  /** 1 始まりの行番号。 */
  line: number;
  /** 1 始まりの桁。実行時エラーでは分からないことがある。 */
  col?: number;
  /**
   * 取り込み元のファイル名。`%INCLUDE` した先で起きた誤りにだけ入る。
   * 主ソースの誤りは undefined。
   */
  file?: string;
  message: string;
}

export interface ProgramResult {
  ok: boolean;
  stdout: string;
  diagnostics: Diagnostic[];
  /** 出力が上限で打ち切られたか。 */
  truncated: boolean;
  durationMs: number;
}

/** 位置情報付きのメッセージから "行:桁: " の接頭辞を取り除く。 */
function stripPrefix(message: string): string {
  return message.replace(/^\d+(:\d+)?:\s*/, "").replace(/^\d+行:\s*/, "");
}

export interface ProgramOptions extends RunOptions {}

/**
 * ソースを実行する。
 * 例外は投げず、必ず結果オブジェクトを返す（UI 側で扱いやすくするため）。
 */
export function runProgram(
  source: string,
  opts: ProgramOptions = {},
): ProgramResult {
  const started = Date.now();
  const interp = new Interpreter(opts);
  const done = (
    diagnostics: Diagnostic[],
    truncated = false,
  ): ProgramResult => {
    // 開いたままの出力ファイルをホストへ書き戻す。
    // 異常終了でも、ここまでに書いた分は残す
    try {
      interp.finishFiles();
    } catch {
      // 書き戻しに失敗しても、実行結果の報告は続ける
    }
    let stdout = interp.text();
    // 上限は「超えた時点で止める」判定なので、実際の出力は少し超える。
    // 呼び出し側に渡すときに上限へ切り詰める。
    if (opts.maxOutputBytes !== undefined && stdout.length > opts.maxOutputBytes) {
      stdout = stdout.slice(0, opts.maxOutputBytes);
      truncated = true;
    }
    return {
      ok: diagnostics.length === 0,
      stdout,
      diagnostics,
      truncated,
      durationMs: Date.now() - started,
    };
  };

  try {
    interp.runSource(source);
    return done([]);
  } catch (e) {
    if (e instanceof PreprocessError) {
      return done([
        {
          severity: "error",
          phase: "preprocess",
          line: e.line,
          col: e.col,
          ...(e.file === undefined ? {} : { file: e.file }),
          message: stripPrefix(e.message),
        },
      ]);
    }
    if (e instanceof LexError) {
      return done([
        {
          severity: "error",
          phase: "lex",
          line: e.line,
          col: e.col,
          ...(e.file === undefined ? {} : { file: e.file }),
          message: stripPrefix(e.message),
        },
      ]);
    }
    if (e instanceof ParseError) {
      return done([
        {
          severity: "error",
          phase: "parse",
          line: e.line,
          col: e.col,
          ...(e.file === undefined ? {} : { file: e.file }),
          message: stripPrefix(e.message),
        },
      ]);
    }
    if (e instanceof OutputLimitExceeded) {
      return done([], true);
    }
    if (e instanceof StepLimitExceeded) {
      return done([
        { severity: "error", phase: "runtime", line: 1, message: e.message },
      ]);
    }
    // 実行時エラー。メッセージに "<行>行: " が付いていれば分離する。
    const err = e as Error & { line?: number };
    const m = /^(\d+)行:\s*(.*)$/s.exec(err.message ?? "");
    return done([
      {
        severity: "error",
        phase: "runtime",
        line: m ? Number(m[1]) : (err.line ?? 1),
        message: m ? m[2]! : (err.message ?? String(e)),
      },
    ]);
  }
}

export { LexError, ParseError, PreprocessError };
export type { RunOptions };
