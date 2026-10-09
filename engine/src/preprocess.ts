/**
 * プリプロセッサ。トークン列を受けて取り込み・置換・不要文の除去を行う。
 *
 * 扱うのは %INCLUDE と %REPLACE、および一覧制御の
 * %PAGE / %SKIP / %PRINT / %NOPRINT。
 *
 * ソース文字列ではなくトークン列に対して処理するので、
 * 文字列リテラルの中身を誤って置換する心配がない。
 *
 * 処理は 2 段に分ける。
 *   1. 取り込み（%INCLUDE）を解決して 1 本のトークン列にする
 *   2. 置換（%REPLACE）と一覧制御文を処理する
 *
 * 分けるのは、取り込んだファイルで定義した `%REPLACE` を
 * **取り込んだ側でも効かせる**ため。1 段でやると、取り込みの中で
 * 置換を閉じてしまい、呼び出し元に届かない。
 *
 * 取り込んだトークンには**取り込み元の名前**を付ける。付けないと、
 * 取り込んだ先で出た誤りの行番号が主ファイルの行番号として報告され、
 * 診断が嘘になる（Linter も VSCode の問題タブも行番号で動いている）。
 */

import { lex, type Token } from "./lexer.js";
import type { PliHost } from "./host.js";

export class PreprocessError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
    readonly file?: string,
  ) {
    super(`${line}:${col}: ${message}`);
    this.name = "PreprocessError";
  }
}

/** 一覧制御文（出力に影響しないので取り除く）。 */
const LISTING_CONTROL = new Set(["PAGE", "SKIP", "PRINT", "NOPRINT"]);

/** 取り込みの深さの上限。これを超えたら誤りとして止める。 */
const MAX_INCLUDE_DEPTH = 16;

export interface PreprocessOptions {
  /** `%INCLUDE` の解決に使う。渡さなければ `%INCLUDE` は誤りになる。 */
  host?: PliHost;
}

export function preprocess(tokens: Token[], opts: PreprocessOptions = {}): Token[] {
  return substitute(expandIncludes(tokens, opts.host, []));
}

// ---- 1 段目: 取り込み ----

/**
 * `%INCLUDE a, b(c), 'd';` の対象名を読む。
 *
 * 書ける形は 3 つ:
 *   `%INCLUDE DSA;`            名前そのまま
 *   `%INCLUDE SYSLIB(DSA);`    ライブラリ指定（**括弧の中の名前**を使う）
 *   `%INCLUDE 'dsa.inc';`      文字列
 *
 * ライブラリ名を捨てるのは、ブラウザにもローカルにも「ライブラリ」に
 * 当たるものが無いため（本来は ddname の割り当てで解決される）。
 */
function readIncludeNames(
  tokens: readonly Token[],
  start: number,
): { names: { name: string; token: Token }[]; next: number } {
  const names: { name: string; token: Token }[] = [];
  let i = start;
  for (;;) {
    const t = tokens[i];
    if (t === undefined || t.kind === "eof") break;
    if (t.kind === "string") {
      names.push({ name: t.value ?? t.text, token: t });
      i++;
    } else if (t.kind === "word") {
      let name = t.text;
      if (tokens[i + 1]?.kind === "lparen" && tokens[i + 2]?.kind === "word") {
        name = tokens[i + 2]!.text;
        i += 3;
        if (tokens[i]?.kind === "rparen") i++;
      } else {
        i++;
      }
      names.push({ name, token: t });
    } else {
      throw new PreprocessError("%INCLUDE には取り込む名前が必要です", t.line, t.col, t.file);
    }
    if (tokens[i]?.kind === "comma") {
      i++;
      continue;
    }
    break;
  }
  if (names.length === 0) {
    const t = tokens[start] ?? tokens[Math.max(0, start - 1)]!;
    throw new PreprocessError("%INCLUDE には取り込む名前が必要です", t.line, t.col, t.file);
  }
  if (tokens[i]?.kind === "semi") i++;
  return { names, next: i };
}

/** `%INCLUDE` を解決して 1 本のトークン列にする。 */
function expandIncludes(
  tokens: readonly Token[],
  host: PliHost | undefined,
  stack: readonly string[],
): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const kw = tokens[i + 1];
    if (t.kind === "percent" && kw?.kind === "word" && kw.upper === "INCLUDE") {
      const { names, next } = readIncludeNames(tokens, i + 2);
      for (const { name, token } of names) {
        out.push(...includeOne(name, token, host, stack));
      }
      i = next;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

/** 1 つの名前を取り込んでトークン列にする。 */
function includeOne(
  name: string,
  at: Token,
  host: PliHost | undefined,
  stack: readonly string[],
): Token[] {
  const key = name.toUpperCase();

  if (stack.length >= MAX_INCLUDE_DEPTH) {
    throw new PreprocessError(
      `%INCLUDE の入れ子が深すぎます（上限 ${MAX_INCLUDE_DEPTH}）: ${name}`,
      at.line,
      at.col,
      at.file,
    );
  }
  if (stack.some((s) => s.toUpperCase() === key)) {
    // 放っておくと止まらないので、必ず誤りにする
    throw new PreprocessError(
      `%INCLUDE が循環しています: ${[...stack, name].join(" -> ")}`,
      at.line,
      at.col,
      at.file,
    );
  }

  const source = host?.readInclude?.(name);
  if (source === undefined) {
    throw new PreprocessError(`%INCLUDE の ${name} が見つかりません`, at.line, at.col, at.file);
  }

  let inner: Token[];
  try {
    inner = lex(source);
  } catch (e) {
    // 取り込んだ側の字句の誤りは、そのファイルの位置として報告する
    const le = e as { message?: string; line?: number; col?: number };
    throw new PreprocessError(
      le.message?.replace(/^\d+:\d+:\s*/, "") ?? String(e),
      le.line ?? 1,
      le.col ?? 1,
      name,
    );
  }

  // 取り込み元の名前を付ける。eof は呼び出し元の分が残るので落とす
  const tagged = inner
    .filter((t) => t.kind !== "eof")
    .map((t) => (t.file === undefined ? { ...t, file: name } : t));

  return expandIncludes(tagged, host, [...stack, name]);
}

// ---- 2 段目: 置換と一覧制御 ----

function substitute(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  /** %REPLACE で定義された置換。出現位置から末尾まで有効。 */
  const replacements = new Map<string, Token>();
  let i = 0;

  const skipToSemi = () => {
    while (i < tokens.length && tokens[i]!.kind !== "semi") {
      if (tokens[i]!.kind === "eof") return;
      i++;
    }
    if (tokens[i]?.kind === "semi") i++;
  };

  while (i < tokens.length) {
    const t = tokens[i]!;

    if (t.kind === "percent") {
      const kw = tokens[i + 1];
      if (kw?.kind !== "word") {
        throw new PreprocessError("% の後にプリプロセッサ文が必要です", t.line, t.col, t.file);
      }
      if (kw.upper === "REPLACE") {
        // %REPLACE <識別子> BY <定数>;
        const name = tokens[i + 2];
        const by = tokens[i + 3];
        const value = tokens[i + 4];
        if (
          name?.kind !== "word" ||
          by?.kind !== "word" ||
          by.upper !== "BY" ||
          value === undefined
        ) {
          throw new PreprocessError(
            "%REPLACE の書式は %REPLACE <識別子> BY <定数>; です",
            kw.line,
            kw.col,
            kw.file,
          );
        }
        replacements.set(name.upper, value);
        i += 5;
        if (tokens[i]?.kind === "semi") i++;
        continue;
      }
      if (LISTING_CONTROL.has(kw.upper)) {
        // 一覧の見た目を変えるだけなので取り除く
        i += 2;
        skipToSemi();
        continue;
      }
      throw new PreprocessError(
        `%${kw.text.toUpperCase()} は未対応です（%INCLUDE・%REPLACE と一覧制御文のみ対応）`,
        kw.line,
        kw.col,
        kw.file,
      );
    }

    // 語の置換。置換先の位置情報は元の語のものに差し替えて診断を合わせる。
    if (t.kind === "word") {
      const rep = replacements.get(t.upper);
      if (rep !== undefined) {
        out.push({ ...rep, line: t.line, col: t.col, ...(t.file === undefined ? {} : { file: t.file }) });
        i++;
        continue;
      }
    }

    out.push(t);
    i++;
  }

  return out;
}
