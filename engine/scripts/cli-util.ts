/**
 * CLI 3 本（`pli` / `plitest` / `plilint`）で共通の引数処理と終了処理。
 *
 * ここに集めた理由は 2 つある。
 *
 * 1. **`process.exit` を使わない。** macOS ではパイプへの書き込みが非同期で、
 *    書き終わる前に `exit` すると未送出分が黙って捨てられる。
 *    `pli x.pli | grep ...` で出力が 65536 バイトに切れるのがこれ。
 *    終了コードは `process.exitCode` に入れ、自然終了させる。
 * 2. **値を取るオプションの検査。** `--max-steps abc` は `Number()` が NaN を返し、
 *    `steps > NaN` が常に偽になるのでステップ上限そのものが無効になる。
 *    無限ループが止まらなくなるので、受け取った時点で弾く。
 */
import { readFileSync } from "node:fs";

/** 終了コードを立てて、以降の処理を止める。 */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "CliExit";
  }
}

/** 使い方を表示して終わる。`--help` は誤りではないので 0。 */
export function usage(text: string, code = 0): never {
  (code === 0 ? console.log : console.error)(text);
  throw new CliExit(code);
}

export function fail(message: string): never {
  console.error(message);
  throw new CliExit(2);
}

/** 値を取るオプションの値を受け取る。欠けていれば弾く。 */
export function value(argv: string[], i: number, name: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("-")) {
    fail(`${name} には値が必要です`);
  }
  return v;
}

/** 1 以上の整数。`--max-steps` のように上限として使う値に。 */
export function positiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    fail(`${name} には 1 以上の整数を指定してください: ${JSON.stringify(raw)}`);
  }
  return n;
}

/** ファイルを読む。失敗を Node のスタックトレースではなく 1 行で報告する。 */
export function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    fail(`${what}を読めません: ${path}（${err.code ?? err.message}）`);
  }
}

/**
 * CLI の本体を走らせる。
 * `CliExit` を終了コードに変え、それ以外の例外は 1 行で報告する。
 */
export function main(body: () => void): void {
  try {
    body();
  } catch (e) {
    if (e instanceof CliExit) {
      process.exitCode = e.code;
      return;
    }
    const err = e as Error;
    console.error(err.message ?? String(e));
    process.exitCode = 1;
  }
}
