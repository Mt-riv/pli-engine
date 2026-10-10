/**
 * PL/I の字句解析。
 *
 * 設計上の最重要事項: **キーワードを判定しない**。
 * PL/I には予約語が無く、次のコードは合法である。
 *   IF IF = THEN THEN THEN = ELSE;
 * （IF と THEN が等しければ THEN に ELSE を代入する）
 * つまり語がキーワードか識別子かは文脈でしか決まらないため、
 * 字句解析は一律に "word" として返し、判断は構文解析に委ねる。
 */


import { m } from "./i18n/index.js";
export type TokenKind =
  | "word"
  | "number"
  | "string"
  | "bitstr"
  | "hexstr"
  | "op"
  | "lparen"
  | "rparen"
  | "comma"
  | "semi"
  | "colon"
  /** プリプロセッサ文の先頭に付く % 。 */
  | "percent"
  /** 構造体の修飾名に使う '.'（数値の小数点とは区別される）。 */
  | "dot"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** 原文の綴り。診断で原文を見せるために保持する。 */
  text: string;
  /** 比較用に大文字化した綴り。PL/I の識別子は大文字小文字を区別しない。 */
  upper: string;
  /**
   * 意味のある値。
   * string: デコード済みの内容 / bitstr,hexstr: 中身 / op: 正規化した演算子。
   */
  value?: string;
  line: number;
  col: number;
  /**
   * 取り込み元のファイル名。`%INCLUDE` で差し込まれた分にだけ入る。
   * 主ソースの分は undefined。診断を正しいファイルに出すために要る。
   */
  file?: string;
}

export class LexError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
    readonly file?: string,
  ) {
    super(`${line}:${col}: ${message}`);
    this.name = "LexError";
  }
}

/** 識別子の先頭に使える文字。PL/I は $ # @ も許す。 */
const isIdentStart = (c: string) => /[A-Za-z_$#@]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$#@]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * 演算子。長いものから順に並べる（最長一致）。
 * '^' は '¬'(U+00AC) の別表記として受け付け、value では '¬' に正規化する。
 * 端末で入力しやすい '^' を書けるようにするため。
 */
const OPERATORS: ReadonlyArray<readonly [string, string]> = [
  ["**", "**"],
  // ポインタ修飾 p -> x。最長一致のため '-' より前に置く
  ["->", "->"],
  ["||", "||"],
  ["<=", "<="],
  [">=", ">="],
  ["¬=", "¬="],
  ["¬<", "¬<"],
  ["¬>", "¬>"],
  ["^=", "¬="],
  ["^<", "¬<"],
  ["^>", "¬>"],
  ["<", "<"],
  [">", ">"],
  ["=", "="],
  ["+", "+"],
  ["-", "-"],
  ["*", "*"],
  ["/", "/"],
  ["|", "|"],
  ["&", "&"],
  ["¬", "¬"],
  ["^", "¬"],
];

const SIMPLE: Readonly<Record<string, TokenKind>> = {
  "%": "percent",
  ".": "dot",
  "(": "lparen",
  ")": "rparen",
  ",": "comma",
  ";": "semi",
  ":": "colon",
};

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const push = (
    kind: TokenKind,
    text: string,
    startLine: number,
    startCol: number,
    value?: string,
  ) => {
    const t: Token = { kind, text, upper: text.toUpperCase(), line: startLine, col: startCol };
    if (value !== undefined) t.value = value;
    tokens.push(t);
  };

  while (i < source.length) {
    const c = source[i]!;

    // 空白
    if (/\s/.test(c)) {
      advance();
      continue;
    }

    // 改行以外の制御文字は無視する。
    // 入力の扱いの規定:
    //   "Other than newlines, characters lower in the collating-sequence
    //    than spaces ('20'x) are ignored."
    // 同梱サンプル numwrd.pli は末尾に 0x1A（DOS の EOF マーカー）を持つため
    // これを無視しないと解析できない。
    if (c < " " && c !== "\n") {
      advance();
      continue;
    }

    // コメント（入れ子にならない）
    if (c === "/" && source[i + 1] === "*") {
      const sl = line;
      const sc = col;
      advance(2);
      for (;;) {
        if (i >= source.length) {
          throw new LexError(m`コメントが閉じていません`, sl, sc);
        }
        if (source[i] === "*" && source[i + 1] === "/") {
          advance(2);
          break;
        }
        advance();
      }
      continue;
    }

    const startLine = line;
    const startCol = col;

    // 文字列・ビット列・16進列
    if (c === "'" || c === '"') {
      const quote = c;
      const raw: string[] = [];
      advance();
      let closed = false;
      while (i < source.length) {
        const ch = source[i]!;
        if (ch === quote) {
          if (source[i + 1] === quote) {
            // '' は埋め込みの引用符
            raw.push(quote);
            advance(2);
            continue;
          }
          advance();
          closed = true;
          break;
        }
        raw.push(ch);
        advance();
      }
      if (!closed) {
        throw new LexError(m`文字列が閉じていません`, startLine, startCol);
      }
      const body = raw.join("");

      // 後続の B / X は接尾辞
      const suffix = source[i];
      if (suffix === "B" || suffix === "b") {
        advance();
        if (!/^[01]*$/.test(body)) {
          throw new LexError(
            m`ビット定数に 0/1 以外が含まれています: '${body}'`,
            startLine,
            startCol,
          );
        }
        push("bitstr", `${quote}${body}${quote}${suffix}`, startLine, startCol, body);
        continue;
      }
      if (suffix === "X" || suffix === "x") {
        advance();
        if (!/^[0-9A-Fa-f]*$/.test(body)) {
          throw new LexError(
            m`16進定数に16進数字以外が含まれています: '${body}'`,
            startLine,
            startCol,
          );
        }
        push("hexstr", `${quote}${body}${quote}${suffix}`, startLine, startCol, body);
        continue;
      }
      push("string", `${quote}${body}${quote}`, startLine, startCol, body);
      continue;
    }

    // 数値定数
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      const start = i;
      while (i < source.length && isDigit(source[i]!)) advance();
      if (source[i] === ".") {
        advance();
        while (i < source.length && isDigit(source[i]!)) advance();
      }
      // 指数部。'**' を指数と誤認しないよう、E の直後が符号か数字のときだけ取る。
      const e = source[i];
      if (e === "E" || e === "e") {
        const sign = source[i + 1];
        const after = sign === "+" || sign === "-" ? source[i + 2] : sign;
        if (after !== undefined && isDigit(after)) {
          advance(sign === "+" || sign === "-" ? 2 : 1);
          while (i < source.length && isDigit(source[i]!)) advance();
        }
      }
      push("number", source.slice(start, i), startLine, startCol);
      continue;
    }

    // 識別子・キーワード候補（区別しない）
    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]!)) advance();
      push("word", source.slice(start, i), startLine, startCol);
      continue;
    }

    // 演算子（最長一致）
    let matched = false;
    for (const [sym, normalized] of OPERATORS) {
      if (source.startsWith(sym, i)) {
        advance(sym.length);
        push("op", sym, startLine, startCol, normalized);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 単純な区切り記号
    const simple = SIMPLE[c];
    if (simple) {
      advance();
      push(simple, c, startLine, startCol);
      continue;
    }

    throw new LexError(m`解釈できない文字です: ${JSON.stringify(c)}`, startLine, startCol);
  }

  push("eof", "", line, col);
  return tokens;
}
