import { describe, expect, it } from "vitest";
import { lex, LexError } from "../src/lexer.js";

const kinds = (src: string) => lex(src).map((t) => t.kind);
const texts = (src: string) => lex(src).map((t) => t.text);

describe("予約語が存在しないこと（PL/I の最重要の性質）", () => {
  /**
   * PL/I には予約語が無い。IF / THEN / ELSE をそのまま変数名に使える。
   *   IF IF = THEN THEN THEN = ELSE;
   * は「IF と THEN が等しければ THEN に ELSE を代入する」という合法な文。
   *
   * したがって字句解析はキーワードを判定してはならない。
   * 判定は構文解析が文脈を見て行う。この1本が設計を決めるので最初に書く。
   */
  it("字句解析はキーワードと識別子を区別しない", () => {
    expect(kinds("IF IF = THEN THEN THEN = ELSE;")).toEqual([
      "word", "word", "op", "word",
      "word", "word", "op", "word",
      "semi", "eof",
    ]);
  });

  it("語の綴りはそのまま保持される", () => {
    expect(texts("IF IF = THEN THEN THEN = ELSE;")).toEqual([
      "IF", "IF", "=", "THEN", "THEN", "THEN", "=", "ELSE", ";", "",
    ]);
  });

  it("DECLARE の対象にキーワード語を使える", () => {
    expect(kinds("dcl (if, then, else) fixed bin(31);")).toEqual([
      "word", "lparen", "word", "comma", "word", "comma", "word", "rparen",
      "word", "word", "lparen", "number", "rparen", "semi", "eof",
    ]);
  });
});

describe("大文字小文字", () => {
  // PL/I の識別子は大文字小文字を区別しない。比較用に upper を持たせ、
  // 原文は text に残す（診断で原文を見せるため）。
  it("text は原文、upper は大文字化した綴り", () => {
    const [t] = lex("Hello");
    expect(t?.text).toBe("Hello");
    expect(t?.upper).toBe("HELLO");
  });

  it("識別子に $ # @ と _ を使える", () => {
    expect(kinds("a_1 b$c d#e f@g")).toEqual(["word", "word", "word", "word", "eof"]);
  });

  it("識別子は数字で始まれない", () => {
    expect(kinds("1abc")).toEqual(["number", "word", "eof"]);
  });
});

describe("数値定数", () => {
  it("整数", () => {
    const [t] = lex("123");
    expect(t?.kind).toBe("number");
    expect(t?.text).toBe("123");
  });

  it("小数", () => expect(texts("1.5")).toEqual(["1.5", ""]));
  it("先頭が小数点", () => expect(texts(".5")).toEqual([".5", ""]));
  it("指数表記", () => expect(texts("1.5E10")).toEqual(["1.5E10", ""]));
  it("符号付き指数", () => expect(texts("1.5e-3")).toEqual(["1.5e-3", ""]));

  // 2 ** 10 の ** が指数と誤認されないこと
  it("べき乗演算子と指数表記を混同しない", () => {
    expect(kinds("2 ** 10")).toEqual(["number", "op", "number", "eof"]);
    expect(texts("2 ** 10")).toEqual(["2", "**", "10", ""]);
  });
});

describe("文字列定数", () => {
  it("単一引用符", () => {
    const [t] = lex("'abc'");
    expect(t?.kind).toBe("string");
    expect(t?.value).toBe("abc");
  });

  it("二重引用符も使える", () => {
    const [t] = lex('"abc"');
    expect(t?.kind).toBe("string");
    expect(t?.value).toBe("abc");
  });

  // PL/I では '' が埋め込みの引用符になる
  it("'' は引用符1個にデコードされる", () => {
    const [t] = lex("'it''s'");
    expect(t?.value).toBe("it's");
  });

  it("引用符で囲まれた中の別種の引用符はそのまま", () => {
    expect(lex(`'a"b'`)[0]?.value).toBe('a"b');
  });

  it("空文字列", () => expect(lex("''")[0]?.value).toBe(""));

  it("閉じていない文字列はエラー", () => {
    expect(() => lex("'abc")).toThrow(LexError);
  });
});

describe("ビット定数・16進定数", () => {
  it("'1010'B はビット列", () => {
    const [t] = lex("'1010'B");
    expect(t?.kind).toBe("bitstr");
    expect(t?.value).toBe("1010");
  });

  it("小文字の b も受け付ける", () => expect(lex("'1'b")[0]?.kind).toBe("bitstr"));

  it("'0D0A'X は16進列", () => {
    const [t] = lex("'0D0A'X");
    expect(t?.kind).toBe("hexstr");
    expect(t?.value).toBe("0D0A");
  });

  it("ビット列に 0/1 以外が入ったらエラー", () => {
    expect(() => lex("'102'B")).toThrow(LexError);
  });

  it("16進列に16進数字以外が入ったらエラー", () => {
    expect(() => lex("'0G'X")).toThrow(LexError);
  });
});

describe("コメント", () => {
  it("コメントは読み飛ばす", () => {
    expect(kinds("a /* これはコメント */ b")).toEqual(["word", "word", "eof"]);
  });

  it("複数行コメント", () => {
    expect(kinds("a /* 1行目\n2行目 */ b")).toEqual(["word", "word", "eof"]);
  });

  it("コメント内の引用符や演算子は無視される", () => {
    expect(kinds("a /* 'x' ** ; */ b")).toEqual(["word", "word", "eof"]);
  });

  // PL/I のコメントは入れ子にならない
  it("コメントは入れ子にならない", () => {
    expect(kinds("a /* /* */ b")).toEqual(["word", "word", "eof"]);
  });

  it("閉じていないコメントはエラー", () => {
    expect(() => lex("a /* b")).toThrow(LexError);
  });
});

describe("演算子", () => {
  it("最長一致で切り出す", () => {
    expect(texts("** || <= >= ¬= < > = + - * / | &")).toEqual([
      "**", "||", "<=", ">=", "¬=", "<", ">", "=", "+", "-", "*", "/", "|", "&", "",
    ]);
  });

  // 端末で入力しやすい '^' を NOT として受け付ける。
  // 自作エンジンでも両方を NOT として受け付け、同じ正規形に落とす。
  it("^ は ¬ の別表記として受け付ける", () => {
    expect(lex("^p")[0]?.value).toBe("¬");
    expect(lex("^=")[0]?.value).toBe("¬=");
    expect(lex("^<")[0]?.value).toBe("¬<");
  });

  it("¬ の別表記も正規形に落ちる", () => {
    expect(lex("¬=")[0]?.value).toBe("¬=");
  });

  it("| と || を区別する", () => {
    expect(texts("a | b || c")).toEqual(["a", "|", "b", "||", "c", ""]);
  });

  it("未知の文字はエラー", () => {
    expect(() => lex("a ? b")).toThrow(LexError);
  });
});

describe("区切り記号", () => {
  it("ラベルのコロン", () => {
    expect(kinds("lab: proc;")).toEqual(["word", "colon", "word", "semi", "eof"]);
  });

  it("括弧とカンマ", () => {
    expect(kinds("f(a,b)")).toEqual(["word", "lparen", "word", "comma", "word", "rparen", "eof"]);
  });
});

describe("位置情報", () => {
  it("行と桁を記録する", () => {
    const ts = lex("a\n  b");
    expect({ line: ts[0]?.line, col: ts[0]?.col }).toEqual({ line: 1, col: 1 });
    expect({ line: ts[1]?.line, col: ts[1]?.col }).toEqual({ line: 2, col: 3 });
  });

  it("コメントを跨いでも行番号が合う", () => {
    const ts = lex("/* 1\n2\n3 */ x");
    expect(ts[0]?.line).toBe(3);
  });

  it("エラーは位置を持つ", () => {
    try {
      lex("a\n'unterminated");
      expect.unreachable("エラーになるはず");
    } catch (e) {
      expect(e).toBeInstanceOf(LexError);
      expect((e as LexError).line).toBe(2);
    }
  });
});

describe("制御文字", () => {
  /**
   * 入力の扱いの規定:
   *   "Other than newlines, characters lower in the collating-sequence
   *    than spaces ('20'x) are ignored."
   * 実際に同梱サンプル numwrd.pli は末尾に 0x1A（DOS の EOF マーカー）を持つ。
   */
  it("0x20 未満の制御文字は改行以外すべて無視する", () => {
    expect(kinds("a\u001ab")).toEqual(["word", "word", "eof"]);
    expect(kinds("a\u0000b")).toEqual(["word", "word", "eof"]);
    expect(kinds("a\u0007b")).toEqual(["word", "word", "eof"]);
  });

  it("末尾の 0x1A（DOS の EOF）で落ちない", () => {
    expect(kinds("x = 1;\u001a")).toEqual(["word", "op", "number", "semi", "eof"]);
  });

  it("改行は無視せず行番号に反映する", () => {
    const ts = lex("a\nb");
    expect(ts[1]?.line).toBe(2);
  });

  it("タブと復帰は空白として扱う", () => {
    expect(kinds("a\tb\r\nc")).toEqual(["word", "word", "word", "eof"]);
  });
});

describe("終端", () => {
  it("最後は必ず eof", () => {
    expect(lex("")).toHaveLength(1);
    expect(lex("")[0]?.kind).toBe("eof");
  });

  it("空白のみでも eof だけ返す", () => {
    expect(kinds("  \n\t ")).toEqual(["eof"]);
  });
});

describe("プリプロセッサ文の記号", () => {
  it("% は独立したトークンになる", () => {
    expect(kinds("%replace X by 3;")).toEqual([
      "percent", "word", "word", "word", "number", "semi", "eof",
    ]);
  });

  it("% の後に空白があってもよい", () => {
    expect(kinds("% page;")).toEqual(["percent", "word", "semi", "eof"]);
  });
});
