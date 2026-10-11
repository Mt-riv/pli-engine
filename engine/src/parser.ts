/**
 * PL/I サブセットの構文解析。
 *
 * 設計上の核心: **PL/I には予約語が無い**ため、語がキーワードか識別子かを
 * 文脈で判断する必要がある。字句解析は一律 "word" を返し、ここで解決する。
 *
 * 文の種別判定の規則:
 *   先頭が「参照（語 + 省略可能な添字）」に続いて '=' なら代入文。
 *   そうでなければ先頭語を文キーワードとして解釈する。
 *
 * これにより次がすべて正しく解釈される。
 *   IF IF = THEN THEN THEN = ELSE;  -> IF 文（条件 IF=THEN、本体 THEN=ELSE）
 *   THEN = ELSE;                    -> 代入文
 *   do = 5;                         -> 代入文（DO という変数へ）
 *   do i = 1 to 9;                  -> DO 反復文
 */

import { m, msg, tr } from "./i18n/index.js";
import type {
  Bound,
  DataAttr,
  DeclItem,
  DoSpec,
  Expr,
  FormatItem,
  IoTarget,
  OpenAttrs,
  Program,
  PutOption,
  Ref,
  Stmt,
  WhenClause,
} from "./ast.js";
import { lex, type Token } from "./lexer.js";
import { preprocess } from "./preprocess.js";
import type { PliHost } from "./host.js";

export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
    readonly file?: string,
  ) {
    super(`${line}:${col}: ${message}`);
    this.name = "ParseError";
  }
}

/**
 * 二項演算子の優先順位（大きいほど強い）。
 * PL/I の規定順: ** / 単項 > * / > 二項 + - > || > 比較 > & > |
 */
const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  "|": 1,
  // 中置の `¬` は排他的論理和（規定 p.116-117 Table 29/30/31）。
  // `&` と同じ段に置く
  "¬": 2,
  "&": 2,
  "=": 3,
  "¬=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "¬<": 3,
  "¬>": 3,
  "||": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "**": 7,
};

/**
 * 複合代入演算子（規定 p.254-255）と、対応する二項演算子。
 * `x += e;` は `x = x + (e);` と同じ意味にする。
 */
const COMPOUND_ASSIGN: Readonly<Record<string, string>> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "**=": "**",
  "||=": "||",
  "&=": "&",
  "|=": "|",
};

/** ** は右結合。それ以外の二項演算子は左結合。 */
const RIGHT_ASSOC = new Set(["**"]);

const UNARY_OPS = new Set(["+", "-", "¬"]);

/**
 * PL/I の属性のうち実装していないもの。
 * 「知らない語」と区別し、何が未実装かを利用者に伝えるために持つ。
 * 同梱サンプルが実際に使っているもの:
 *   numwrd.pli -> PRINT（ファイル宣言）
 *   isub.pli   -> DEFINED（iSUB 定義配列）
 */
/**
 * PL/I の属性だが実装していないもの。
 *
 * **名指しで断るための表。** ここに無い語は「属性として解釈できません」と
 * いう素の構文エラーになり、綴り間違いと未実装の区別が付かなくなる。
 * README が未実装として挙げている機能は、必ずここにも載せる。
 */
const UNIMPLEMENTED_ATTRS: Readonly<Record<string, string>> = {
  KEYED: msg("索引ファイル"),
  VARYINGZ: msg("終端子付きの可変長文字列"),
  VARZ: msg("終端子付きの可変長文字列"),
  SIGNED: msg("符号の明示（この処理系は常に符号付き）"),
  UNSIGNED: msg("符号なし整数"),
  VALUE: msg("名前付き定数"),
  GENERIC: msg("総称入口"),
  POSITION: msg("文字列重ね合わせ定義の開始位置"),
  POS: msg("文字列重ね合わせ定義の開始位置"),
  TYPE: msg("型定義"),
  HANDLE: msg("型定義への参照"),
  ORDINAL: msg("列挙型"),
  VARIABLE: msg("ファイル変数"),
  REGIONAL: msg("直接編成ファイル"),
  AREA: msg("AREA 記憶域"),
  OFFSET: msg("AREA 記憶域"),
  BUILTIN: msg("BUILTIN 宣言"),
  LABEL: msg("LABEL 変数"),
  REFER: msg("自己定義構造体"),
  UNION: msg("記憶域の重ね合わせ"),
  LIKE: msg("構造体の複製"),
  EVENT: msg("多重処理"),
  TASK: msg("多重処理"),
  COMPLEX: msg("複素数"),
  CPLX: msg("複素数"),
  CONTROLLED: msg("CONTROLLED 記憶域"),
  CTL: msg("CONTROLLED 記憶域"),
};

/**
 * PL/I の文だが実装していないもの。
 *
 * 文の先頭の語がここにあれば「未実装」と断る。
 * 無いと「解釈できない文です」になり、やはり綴り間違いと区別が付かない。
 */
const UNIMPLEMENTED_STATEMENTS: Readonly<Record<string, string>> = {
  WAIT: msg("多重処理"),
  ENTRY: msg("二次入口。手続きを分けてください"),
  PACKAGE: msg("複数の手続きをまとめる単位"),
  ASSERT: msg("表明。テストフレームワークの ASSERT_EQUALS を使ってください"),
  REINIT: msg("INITIAL の入れ直し"),
  RESIGNAL: msg("ON 単位から同じ条件を投げ直す"),
  FLUSH: msg("書き出しの強制。この処理系は終了時に書き戻します"),
  DEFINE: msg("型定義"),
  XDECLARE: msg("型定義の宣言"),
  QUALIFY: msg("名前空間"),
  DISPLAY: msg("PUT を使ってください"),
  DELAY: msg("時間待ち"),
  REVERT: msg("ON 単位の解除は ON ... SYSTEM; を使ってください"),
  LOCATE: msg("LOCATE 割り当て"),
  UNLOCK: msg("レコードのロック"),
  DELETE: msg("索引ファイルが必要"),
  EXIT: msg("STOP を使ってください"),
  DEFAULT: msg("DEFAULT 文"),
  DFT: msg("DEFAULT 文"),
};

/**
 * ロケータの鎖の一番内側に `loc` を付ける。
 * `q -> r -> w` を `w`（locator: `r`（locator: `q`））の形にするために使う。
 */
function attachLocator(target: Ref, loc: Ref): Ref {
  if (target.locator === undefined) return { ...target, locator: loc };
  return { ...target, locator: attachLocator(target.locator, loc) };
}

class Parser {
  private pos = 0;
  /**
   * `END ラベル;` が自分の名前でなかったときの持ち越し（多重閉じ）。
   * 外側の同名の開始が受け取る。誰も受け取らなければ `parseProgram` が断る。
   */
  private pendingEnd:
    | { name: string; text: string; line: number; col: number; file?: string }
    | undefined;

  constructor(private readonly toks: Token[]) {}

  // ---- トークン操作 ----

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private at(kind: Token["kind"]): boolean {
    return this.peek().kind === kind;
  }

  /** 現在位置が指定の語（大文字比較）か。 */
  private atWord(...words: string[]): boolean {
    const t = this.peek();
    return t.kind === "word" && words.includes(t.upper);
  }

  private atOp(...ops: string[]): boolean {
    const t = this.peek();
    return t.kind === "op" && ops.includes(t.value ?? t.text);
  }

  private eat(kind: Token["kind"]): boolean {
    if (this.at(kind)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private eatWord(...words: string[]): boolean {
    if (this.atWord(...words)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(kind: Token["kind"], what: string): Token {
    if (!this.at(kind)) {
      const t = this.peek();
      throw new ParseError(
        m`${what} が必要です（${t.kind === "eof" ? m`入力の終わり` : JSON.stringify(t.text)} が現れました）`,
        t.line,

        t.col,

        t.file,
      );
    }
    return this.next();
  }

  private expectWord(word: string): Token {
    if (!this.atWord(word)) {
      const t = this.peek();
      throw new ParseError(
        m`${word} が必要です（${t.kind === "eof" ? m`入力の終わり` : JSON.stringify(t.text)} が現れました）`,
        t.line,

        t.col,

        t.file,
      );
    }
    return this.next();
  }

  // ---- プログラム ----

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (!this.at("eof")) {
      this.parseInto(body);
      if (this.pendingEnd !== undefined) {
        const e = this.pendingEnd;
        throw new ParseError(
          m`END の名前 ${JSON.stringify(e.text)} に対応する開始がありません`,
          e.line,
          e.col,
          e.file,
        );
      }
    }
    return { kind: "program", body };
  }

  // ---- 文 ----

  /** ラベルを読み取る。`a: b: x = 1;` のように複数付けられる。 */
  private takeLabels(): { name: string; line: number }[] {
    const labels: { name: string; line: number }[] = [];
    while (this.at("word") && this.peek(1).kind === "colon") {
      const lt = this.next();
      labels.push({ name: lt.text, line: lt.line });
      this.next(); // ':'
    }
    return labels;
  }

  /**
   * 次が手続きか（ラベルが**名前**として使われる形）。
   *
   * `BEGIN` は含めない。ラベル付きの BEGIN へは `GOTO` できる
   * （規定 p.164「You can transfer control to a labeled BEGIN statement
   * by using the GO TO statement」）ので、飛び先の `label` 文も要る。
   */
  private atBlockHead(): boolean {
    return this.at("word") && ["PROCEDURE", "PROC"].includes(this.peek().upper);
  }

  /**
   * 文を 1 つ解析して `out` に積む。
   *
   * ラベル付きの文は、GOTO の飛び先となる `label` 文を**ラベルの数だけ**
   * 先に積んでから本体を積む。`execBlock` は同じ並びの中から
   * `kind: "label"` を探すので、飛び先は兄弟として並んでいる必要がある。
   *
   * 以前は「ラベル文を 1 度だけ発行する」状態を持っていたため、
   * 2 つ目以降のラベル付き文でラベルが発行されず、
   * `GOTO` の飛び先が実行時に見つからなかった（しかも 1 つ飛ばしで
   * 発行されるので、単一ラベルのテストでは気づけなかった）。
   */
  private parseInto(out: Stmt[]): void {
    // 条件接頭辞（`(subscriptrange): …`。規定 p.395-396）。
    // この処理系は SIZE / SUBSCRIPTRANGE を常に有効にしているので
    // 有効・無効の切り替えを持てない。名指しで断る
    if (this.at("lparen")) {
      const t = this.peek();
      throw new ParseError(
        m`条件接頭辞（(subscriptrange): の形）は未実装です（この処理系は常に検査します）`,
        t.line,
        t.col,
        t.file,
      );
    }
    const labels = this.takeLabels();
    if (labels.length > 0 && !this.atBlockHead()) {
      for (const l of labels) {
        out.push({ kind: "label", name: l.name, line: l.line });
      }
    }
    out.push(this.parseLabeled(labels));
  }

  /**
   * ラベルを読み飛ばして文を解析する。
   * 単独の文を取る文脈（IF の THEN など）から呼ぶ。
   *
   * 宣言はそこに置けない（規定 p.278「All single statements are
   * considered valid and executable **except DECLARE**, DEFAULT, END,
   * ENTRY FORMAT, PROCEDURE, or a %statement」）。受けてしまうと、
   * 条件付きで宣言したつもりの書き手の勘違いを拾えない。
   */
  private parseStatement(): Stmt {
    const t = this.peek();
    if (
      t.kind === "word" &&
      ["DECLARE", "DCL", "PROCEDURE", "PROC", "DEFAULT", "DFT"].includes(t.upper) &&
      !this.looksLikeAssignment()
    ) {
      throw new ParseError(
        m`${t.text.toUpperCase()} は IF / WHEN などの単位に置けません（規定で実行文でないもの）`,
        t.line,
        t.col,
        t.file,
      );
    }
    return this.parseLabeled(this.takeLabels());
  }

  /**
   * 本体の文を解析する。
   * PROCEDURE はラベル（手続き名）を必要とするため、ラベルを受け取る。
   */
  private parseLabeled(labels: { name: string; line: number }[]): Stmt {
    const label = labels[labels.length - 1]?.name;
    const t = this.peek();
    if (t.kind === "semi") {
      this.next();
      return { kind: "null", line: t.line };
    }

    // 代入文かどうかを先読みで判定する（予約語が無いことへの対応）
    if (this.looksLikeAssignment()) {
      return this.parseAssignment();
    }

    if (t.kind === "word") {
      switch (t.upper) {
        case "PROCEDURE":
        case "PROC":
          return this.parseProcedure(
            labels.map((l) => l.name),
            t.line,
          );
        case "DECLARE":
        case "DCL":
          return this.parseDeclare();
        case "PUT":
          return this.parsePut();
        case "IF":
          return this.parseIf();
        case "DO":
          return this.parseDo(labels.map((l) => l.name.toUpperCase()));
        case "GET":
          return this.parseGet();
        case "ALLOCATE":
        case "ALLOC":
          return this.parseAllocate();
        case "FREE":
          return this.parseFree();
        case "READ":
          return this.parseRecordIo("read");
        case "WRITE":
          return this.parseRecordIo("write");
        case "REWRITE":
          return this.parseRecordIo("rewrite");
        case "OPEN":
          return this.parseOpen();
        case "CLOSE":
          return this.parseClose();
        case "SELECT":
          return this.parseSelect();
        case "BEGIN":
          return this.parseBegin(labels.map((l) => l.name));
        case "LEAVE":
        case "ITERATE": {
          const kw = this.next();
          const label = this.at("word") ? this.next().text : undefined;
          this.expect("semi", m`セミコロン`);
          const kind = kw.upper === "LEAVE" ? ("leave" as const) : ("iterate" as const);
          return label === undefined
            ? { kind, line: kw.line }
            : ({ kind, label, line: kw.line } as Stmt);
        }
        case "GOTO":
          return this.parseGoto();
        case "GO":
          // GO TO（2語）の形
          if (this.peek(1).kind === "word" && this.peek(1).upper === "TO") {
            return this.parseGoto();
          }
          break;
        case "ON":
          return this.parseOn();
        case "SIGNAL": {
          const kw = this.next();
          const cond = this.expect("word", m`条件名`);
          const condFile = this.parseConditionFile();
          this.expect("semi", m`セミコロン`);
          return condFile === undefined
            ? { kind: "signal", condition: cond.upper, line: kw.line }
            : { kind: "signal", condition: cond.upper, conditionFile: condFile, line: kw.line };
        }
        case "STOP": {
          const kw = this.next();
          this.expect("semi", m`セミコロン`);
          return { kind: "stop", line: kw.line };
        }
        case "CALL":
          return this.parseCall();
        case "RETURN":
          return this.parseReturn();
        default:
          break;
      }
    }

    // 知っている PL/I の文なら「未実装」と断る。
    // 素の「解釈できない文です」だと綴り間違いと区別が付かない
    if (t.kind === "word") {
      const why = UNIMPLEMENTED_STATEMENTS[t.upper];
      if (why !== undefined) {
        throw new ParseError(
          m`${t.text.toUpperCase()} は未実装です（${tr(why)}）`,
          t.line,
          t.col,
          t.file,
        );
      }
    }

    throw new ParseError(
      m`解釈できない文です（${JSON.stringify(t.text)}）`,
      t.line,

      t.col,

      t.file,
    );
  }

  /**
   * 先頭が「参照（, 参照...）」に続いて '=' か。
   * 括弧は入れ子を数えて飛ばす。'=' は比較にも使われるが、
   * 文の先頭位置に現れた場合は代入とみなす（PL/I の規則）。
   *
   * 左辺はカンマで複数書ける（`a, b = 0;`）。カンマを見ないと
   * これが「解釈できない文です」になり、しかも診断が 2 つ目の名前を指す。
   */
  private looksLikeAssignment(): boolean {
    if (!this.at("word")) return false;
    let i = this.pos + 1;

    // 参照 1 つ分を読み飛ばす
    const skipRef = (): boolean => {
      // 構造体の修飾名 rec.addr.city を飛ばす
      while (this.toks[i]?.kind === "dot" && this.toks[i + 1]?.kind === "word") {
        i += 2;
      }
      if (this.toks[i]?.kind === "lparen") {
        let depth = 0;
        while (i < this.toks.length) {
          const k = this.toks[i]!.kind;
          if (k === "lparen") depth++;
          else if (k === "rparen") {
            depth--;
            if (depth === 0) {
              i++;
              break;
            }
          } else if (k === "eof") return false;
          i++;
        }
      }
      return true;
    };

    /** 参照 1 つ（ポインタ修飾を含む）を飛ばす。 */
    const skipTarget = (): boolean => {
      if (!skipRef()) return false;
      // ポインタ修飾 p -> x = ... も代入文
      while (this.toks[i]?.kind === "op" && (this.toks[i]!.value ?? "") === "->") {
        i++;
        if (this.toks[i]?.kind !== "word") return false;
        i++;
        if (!skipRef()) return false;
      }
      return true;
    };

    if (!skipTarget()) return false;
    // 2 つ目以降の左辺（`a, b = 0;`）
    while (this.toks[i]?.kind === "comma") {
      i++;
      if (this.toks[i]?.kind !== "word") return false;
      i++;
      if (!skipTarget()) return false;
    }

    const t = this.toks[i];
    if (t?.kind !== "op") return false;
    const op = t.value ?? t.text;
    return op === "=" || COMPOUND_ASSIGN[op] !== undefined;
  }

  private parseAssignment(): Stmt {
    const line = this.peek().line;
    // 左辺はカンマで複数。右辺は 1 度だけ評価して全部へ代入する
    const targets: Ref[] = [this.parseRef()];
    while (this.eat("comma")) targets.push(this.parseRef());
    const op = this.expect("op", "=");
    const opText = op.value ?? op.text;
    const compound = COMPOUND_ASSIGN[opText];
    if (opText !== "=" && compound === undefined) {
      throw new ParseError(m`= が必要です`, op.line, op.col, op.file);
    }
    let value = this.parseExpr();
    // 複合代入は `x = x op (式)` と同じ意味にする（規定 p.255）。
    // 左辺が複数のときは PL/I でも書けないので、1 つに限る
    if (compound !== undefined) {
      const first = targets[0];
      if (first === undefined || targets.length > 1) {
        throw new ParseError(m`複合代入の左辺は 1 つだけです`, op.line, op.col, op.file);
      }
      value = { kind: "binary", op: compound, left: first, right: value };
    }
    // 構造体の BY NAME 代入。名指しで断らないと「セミコロン が必要です」に
    // なり、綴り間違いと未実装の区別が付かない
    if (this.at("comma") && this.peek(1).kind === "word" && this.peek(1).upper === "BY") {
      const t = this.peek();
      throw new ParseError(m`BY NAME は未実装です（項目ごとに代入してください）`, t.line, t.col, t.file);
    }
    this.expect("semi", m`セミコロン`);
    return { kind: "assign", targets, value, line };
  }

  private parseProcedure(labelNames: string[], line: number): Stmt {
    // 一番左が主入口の名前（規定 p.147「the leftmost name is the primary
    // entry point」）。一番右を採ると、二次入口のために付けたラベルが
    // 主入口の名前を上書きしてしまう
    const label = labelNames[0];
    if (label === undefined) {
      const t = this.peek();
      throw new ParseError(m`手続きには名前（ラベル）が必要です`, t.line, t.col, t.file);
    }
    this.next(); // PROCEDURE / PROC

    const params: string[] = [];
    if (this.eat("lparen")) {
      if (!this.at("rparen")) {
        do {
          params.push(this.expect("word", m`引数名`).text);
        } while (this.eat("comma"));
      }
      this.expect("rparen", m`閉じ括弧`);
    }

    let isMain = false;
    let recursive = false;
    let returns: DataAttr | undefined;
    // OPTIONS(...) / RETURNS(...) / RECURSIVE は順不同
    for (;;) {
      if (this.atWord("OPTIONS")) {
        this.next();
        this.expect("lparen", m`開き括弧`);
        // PL/I の OPTIONS は空白区切り（カンマも許す）。
        // 例: options(main reentrant) / options(main, reentrant)
        while (this.at("word")) {
          const o = this.next();
          if (o.upper === "MAIN") isMain = true;
          this.eat("comma");
        }
        this.expect("rparen", m`閉じ括弧`);
        continue;
      }
      if (this.atWord("RETURNS")) {
        this.next();
        this.expect("lparen", m`開き括弧`);
        returns = this.parseAttributes(() => this.at("rparen"));
        this.expect("rparen", m`閉じ括弧`);
        continue;
      }
      if (this.eatWord("RECURSIVE")) {
        recursive = true;
        continue;
      }
      // 最適化の指定（規定 p.147）。意味を持たせずに受ける
      if (this.eatWord("ORDER", "REORDER")) continue;
      break;
    }
    this.expect("semi", m`セミコロン`);

    const body = this.parseBlockUntilEnd(labelNames);
    const stmt: Stmt = {
      kind: "procedure",
      name: label,
      params,
      isMain,
      recursive,
      body,
      line,
    };
    if (returns !== undefined) {
      return { ...stmt, returns } as Stmt;
    }
    return stmt;
  }

  /**
   * END までの文列を読む。
   *
   * `END` に名前が付いていれば、**その名前の開始までまとめて閉じる**
   * （多重閉じ。規定 p.275「the END statement closes the unclosed group or
   * block headed by the nearest preceding DO, SELECT, PACKAGE, BEGIN, or
   * PROCEDURE statement having that statement-label」）。
   * 自分の名前でなければ `pendingEnd` に載せて外側へ渡す。
   *
   * どの開始にも対応しない名前は `parseProgram` が断る。読み捨てると、
   * `END` に名前を書く目的（入れ子の崩れを機械に拾わせる）が果たせない。
   */
  private parseBlockUntilEnd(names: string[] = []): Stmt[] {
    const mine = names.map((n) => n.toUpperCase());
    const body: Stmt[] = [];
    for (;;) {
      // 内側が「自分のものでない END」で抜けてきた（多重閉じ）
      if (this.pendingEnd !== undefined) {
        if (mine.includes(this.pendingEnd.name)) this.pendingEnd = undefined;
        return body;
      }
      if (this.at("eof")) {
        const t = this.peek();
        throw new ParseError(m`END が必要です`, t.line, t.col, t.file);
      }
      // END にラベル接頭を付けられる（`fin: end;`）。規定 p.271 の例が
      // `End_ReadFile: end;` で、`iterate` の飛び先に使っている
      const save = this.pos;
      const labels = this.takeLabels();
      if (labels.length > 0) {
        if (this.atWord("END") && !this.looksLikeAssignment()) {
          for (const l of labels) {
            body.push({ kind: "label", name: l.name, line: l.line });
          }
        } else {
          this.pos = save;
        }
      }
      // END は文キーワードだが、'END = 1' のような代入でないことを確認する
      if (this.atWord("END") && !this.looksLikeAssignment()) {
        this.next();
        if (this.at("word")) {
          const endName = this.next();
          if (!mine.includes(endName.upper)) {
            // 自分の名前ではない。外側の同名の開始まで閉じる
            this.pendingEnd = {
              name: endName.upper,
              text: endName.text,
              line: endName.line,
              col: endName.col,
              ...(endName.file === undefined ? {} : { file: endName.file }),
            };
          }
        }
        this.expect("semi", m`セミコロン`);
        return body;
      }
      this.parseInto(body);
    }
  }

  private parseDeclare(): Stmt {
    const line = this.next().line; // DECLARE / DCL
    const items: DeclItem[] = [];
    /** 各項目の先頭の位置。構造体の次元を断るときの診断に使う。 */
    const where: { line: number; col: number; file?: string }[] = [];
    do {
      const t = this.peek(0);
      where.push({ line: t.line, col: t.col, ...(t.file === undefined ? {} : { file: t.file }) });
      items.push(this.parseDeclItem());
    } while (this.eat("comma"));
    this.expect("semi", m`セミコロン`);
    this.rejectGroupDimension(items, where);
    return { kind: "declare", items, line };
  }

  /**
   * 構造体そのものに付けた次元（構造体の配列）を断る。
   *
   *   dcl 1 tbl(3), 2 nm char(4);   ← これ
   *
   * 平坦化（`declare.ts`）が中間レベルの次元を葉へ渡さないので、
   * 受けてしまうと葉が次元を持たない 1 個の箱になり、
   * `tbl.nm(1)` から `tbl.nm(3)` までが全部同じ箱を指す。
   * **黙って嘘の値を返す**のが一番たちが悪いため、宣言の時点で断る。
   */
  private rejectGroupDimension(
    items: DeclItem[],
    where: { line: number; col: number; file?: string }[],
  ): void {
    for (const [i, item] of items.entries()) {
      if (item.level === undefined || item.dims === undefined) continue;
      const next = items[i + 1];
      // 次がより深いレベルなら、この項目は子を持つ（= 構造体そのもの）
      if (next?.level === undefined || next.level <= item.level) continue;
      const w = where[i] ?? { line: 0, col: 0 };
      throw new ParseError(
        m`構造体そのものに付けた次元は未実装です（構造体の配列）。${item.names[0] ?? ""} の次元を葉の項目へ移してください`,
        w.line,
        w.col,
        w.file,
      );
    }
  }

  private parseDeclItem(): DeclItem {
    // 構造体のレベル番号（dcl 1 rec, 2 name char(10); の 1 や 2）
    let level: number | undefined;
    // `2 nm char(4)` と `2 (a, b) char(4)` の両方。括弧付きの名前リストは
    // PL/I の普通の書き方で、受けないとレベル番号で素の構文誤りになる
    if (
      this.at("number") &&
      (this.peek(1).kind === "word" || this.peek(1).kind === "lparen")
    ) {
      level = Number(this.next().text);
    }
    const names: string[] = [];
    if (this.eat("lparen")) {
      do {
        names.push(this.expect("word", m`変数名`).text);
        // 入れ子の括り出し（`dcl (e dec(6,5), f char(10)) static;`。
        // 規定 p.203「Factoring can be nested」）
        if (!this.at("comma") && !this.at("rparen")) {
          const t = this.peek();
          throw new ParseError(
            m`入れ子の括り出し（名前ごとに属性を書く形）は未実装です`,
            t.line,
            t.col,
            t.file,
          );
        }
      } while (this.eat("comma"));
      this.expect("rparen", m`閉じ括弧`);
    } else {
      names.push(this.expect("word", m`変数名`).text);
    }

    // 名前の直後の括弧は配列の次元。属性語の後の括弧（精度・長さ）とは別物。
    //   dcl b(3,3) bin fixed;   -> 次元 (3,3)
    //   dcl a fixed bin(31);    -> 精度 (31)
    let dims: Bound[] | undefined;
    /** `(*)` と書かれた次元の数。境界は呼ぶ側から受け取る（規定 p.149）。 */
    let starDims: number | undefined;
    if (this.at("lparen")) {
      this.next();
      if (this.atOp("*")) {
        starDims = 0;
        do {
          this.expect("op", "*");
          starDims++;
        } while (this.eat("comma"));
      } else {
        dims = [];
        do {
          dims.push(this.parseBound());
        } while (this.eat("comma"));
      }
      this.expect("rparen", m`閉じ括弧`);
    }

    let init: Expr[] | undefined;
    let defined: Ref | undefined;
    let based: { pointer?: Ref } | undefined;
    let storage: "static" | "automatic" | undefined;
    const attr = this.parseAttributes(
      () => this.at("semi") || this.at("comma"),
      (values) => {
        init = values;
      },
      (base) => {
        defined = base;
      },
      (b) => {
        based = b;
      },
      (sc) => {
        storage = sc;
      },
      (bounds) => {
        dims = bounds;
      },
    );
    const item: DeclItem = { names, attr };
    if (based !== undefined) item.based = based;
    if (level !== undefined) item.level = level;
    if (dims !== undefined) item.dims = dims;
    if (starDims !== undefined) item.starDims = starDims;
    if (init !== undefined) item.init = init;
    if (defined !== undefined) item.defined = defined;
    if (storage !== undefined) item.storage = storage;
    return item;
  }

  /**
   * 配列の1次元の境界を読む。
   * PL/I は下限を明示できる: (10) は 1..10、(0:9) は 0..9。
   */
  private parseBound(): Bound {
    // `dcl a(n)` は未実装（記憶域の大きさを実行時に決める仕掛けが無い）。
    // 素の「数値が必要です」にすると綴り間違いと区別が付かない
    const t = this.peek();
    if (t.kind === "word") {
      throw new ParseError(
        m`可変の配列境界（${t.text} のような式で大きさを決める形）は未実装です（定数で書いてください）`,
        t.line,
        t.col,
        t.file,
      );
    }
    const first = this.parseSignedInt();
    if (this.eat("colon")) {
      return { lo: first, hi: this.parseSignedInt() };
    }
    return { lo: 1, hi: first };
  }

  private parseSignedInt(): number {
    let sign = 1;
    if (this.atOp("-")) {
      this.next();
      sign = -1;
    } else if (this.atOp("+")) {
      this.next();
    }
    return sign * Number(this.expect("number", m`次元の大きさ`).text);
  }

  /** 対応する閉じ括弧まで読み飛ばす。中身に意味を持たせない指定に使う。 */
  private skipBalancedParens(): void {
    this.expect("lparen", m`開き括弧`);
    let depth = 1;
    while (depth > 0 && !this.at("eof")) {
      const t = this.next();
      if (t.kind === "lparen") depth++;
      else if (t.kind === "rparen") depth--;
    }
  }

  /**
   * データ属性を読む。PL/I の属性は順不同なので語を集めてから解釈する。
   * 既定値は PL/I の規定に従う:
   *   FIXED の既定基数は DECIMAL、FIXED DEC の既定精度は (5,0)、
   *   FIXED BIN の既定精度は (15,0)、CHARACTER の既定長は 1。
   */
  private parseAttributes(
    stop: () => boolean,
    onInit?: (values: Expr[]) => void,
    onDefined?: (base: Ref) => void,
    onBased?: (based: { pointer?: Ref }) => void,
    onStorage?: (storage: "static" | "automatic") => void,
    onDims?: (dims: Bound[]) => void,
  ): DataAttr {
    let kind:
      | "fixed" | "float" | "char" | "bit" | "file" | "entry" | "picture" | "pointer"
      | undefined;
    let picture: string | undefined;
    let returns: DataAttr | undefined;
    let filePrint: boolean | undefined;
    let fileRecord: boolean | undefined;
    let fileMode: "input" | "output" | "update" | undefined;
    let fileRecordSize: number | undefined;
    let fileVariable: boolean | undefined;
    let base: "bin" | "dec" | undefined;
    let varying = false;
    let nums: number[] | undefined;
    /** `(*)` と書かれた位置。CHAR / BIT 以外で断るために持つ。 */
    let star: Token | undefined;

    while (!stop() && !this.at("eof")) {
      if (this.at("word")) {
        const w = this.next();
        switch (w.upper) {
          case "FIXED": kind = "fixed"; break;
          case "FLOAT": kind = "float"; break;
          case "CHAR":
          case "CHARACTER": kind = "char"; break;
          case "BIT": kind = "bit"; break;
          // ファイル宣言。OPEN の既定になるので属性を覚える。
          // 同梱サンプル numwrd.pli の `dcl sysprint print;` に必要。
          case "FILE": kind = "file"; break;
          case "PRINT": kind = "file"; filePrint = true; break;
          case "STREAM": kind = "file"; fileRecord = false; break;
          case "RECORD": kind = "file"; fileRecord = true; break;
          case "INPUT": kind = "file"; fileMode = "input"; break;
          case "OUTPUT": kind = "file"; fileMode = "output"; break;
          case "UPDATE": kind = "file"; fileMode = "update"; break;
          case "ENV":
          case "ENVIRONMENT": {
            // ENVIRONMENT(F RECSIZE(80)) / (V RECSIZE(120))
            kind = "file";
            this.expect("lparen", m`開き括弧`);
            while (!this.at("rparen") && !this.at("eof")) {
              if (this.at("word")) {
                const e = this.next();
                if (e.upper === "RECSIZE" || e.upper === "BLKSIZE") {
                  this.expect("lparen", m`開き括弧`);
                  const n = this.expect("number", m`数値`);
                  this.expect("rparen", m`閉じ括弧`);
                  if (e.upper === "RECSIZE") {
                    const size = Number(n.text);
                    // 0 以下だと `splitRecord` が 1 歩も進まず無限ループになる
                    if (!Number.isInteger(size) || size < 1) {
                      throw new ParseError(
                        m`RECSIZE は 1 以上の整数でなければなりません（${n.text}）`,
                        n.line,
                        n.col,
                        n.file,
                      );
                    }
                    fileRecordSize = size;
                  }
                } else if (e.upper === "V" || e.upper === "VB") {
                  fileVariable = true;
                } else if (e.upper === "F" || e.upper === "FB") {
                  fileVariable = false;
                }
                continue;
              }
              this.next();
            }
            this.expect("rparen", m`閉じ括弧`);
            break;
          }
          // 外部手続きの宣言。引数の記述は持たない（1ファイル完結のため）
          case "POINTER":
          case "PTR":
            kind = "pointer";
            break;
          case "BASED": {
            // based(p) / based（修飾は参照側で指定する）
            // 注意: onBased?.(f()) と書くと onBased が無いとき f() が
            // 評価されず、括弧の中が読まれないまま進んでしまう
            if (this.at("lparen")) {
              this.next();
              const ptr = this.parseRef();
              this.expect("rparen", m`閉じ括弧`);
              onBased?.({ pointer: ptr });
            } else {
              onBased?.({});
            }
            break;
          }
          case "PIC":
          case "PICTURE": {
            const t = this.expect("string", m`PICTURE の指定`);
            kind = "picture";
            picture = t.value ?? t.text;
            break;
          }
          case "ENTRY": {
            kind = "entry";
            if (this.at("lparen")) this.skipBalancedParens();
            break;
          }
          case "RETURNS": {
            this.expect("lparen", m`開き括弧`);
            returns = this.parseAttributes(() => this.at("rparen"));
            this.expect("rparen", m`閉じ括弧`);
            break;
          }
          case "OPTIONS": {
            // OPTIONS(ASM) など。呼び出し規約の指定は意味を持たせない
            if (this.at("lparen")) this.skipBalancedParens();
            break;
          }
          case "BIN":
          case "BINARY": base = "bin"; break;
          case "DEC":
          case "DECIMAL": base = "dec"; break;
          case "VAR":
          case "VARYING": varying = true; break;
          case "INIT":
          case "INITIAL": {
            const lp = this.expect("lparen", m`開き括弧`);
            const values: Expr[] = [];
            do {
              // 反復係数 `init((5) 0)` は未実装。素の構文誤りにすると
              // 綴り間違いと区別が付かないので名指しで断る
              if (this.at("lparen")) {
                throw new ParseError(
                  m`INITIAL の繰り返し係数（init((5) 0) の形）は未実装です（値を並べて書いてください）`,
                  lp.line,
                  lp.col,
                  lp.file,
                );
              }
              if (this.atOp("*")) {
                // 「`*` Specifies that the element is to be left
                // uninitialized」（規定 p.323）
                const t = this.peek();
                throw new ParseError(
                  m`INITIAL の * 項目（初期化しない要素）は未実装です`,
                  t.line,
                  t.col,
                  t.file,
                );
              }
              values.push(this.parseExpr());
            } while (this.eat("comma"));
            this.expect("rparen", m`閉じ括弧`);
            onInit?.(values);
            break;
          }
          case "DEF":
          case "DEFINED": {
            // DEFINED の基底参照。添字に iSUB を含められる。
            this.expect("lparen", m`開き括弧`);
            const base = this.parseRefWithISub();
            this.expect("rparen", m`閉じ括弧`);
            onDefined?.(base);
            break;
          }
          case "STATIC":
            // 手続きを抜けても値が残る。呼び出し回数を数える定型で使う
            onStorage?.("static");
            break;
          case "AUTOMATIC":
          case "AUTO":
            onStorage?.("automatic");
            break;
          case "EXTERNAL":
          case "INTERNAL":
            // 結合の範囲。1 ファイル完結なので意味を持たせない
            break;
          // 記憶域の配置。この処理系は配置を持たないので**定義上なにも
          // 変えられない**。変えられないものを理由に断ると、構造体や
          // レコード定義（ほぼ必ず付く）が通らなくなる
          case "ALIGNED":
          case "UNALIGNED":
          // 算術の既定（規定 p.77「The default for arithmetic variables
          // is REAL」）。複素数は別に名指しで断っている
          case "REAL":
          // すでに持っている情報の別の綴り
          case "NONVARYING":
          case "NONVAR":
            break;
          case "PRECISION":
          case "PREC":
            // `PREC(5,2)` の括弧は精度。次の括弧を読ませればよい
            break;
          case "DIMENSION":
          case "DIM": {
            // `dcl a dimension(2,3) fixed bin(15);`（規定 p.225）。
            // 名前の直後に書く形と同じ意味なので、次元として受け取る
            this.expect("lparen", m`開き括弧`);
            const bounds: Bound[] = [];
            do {
              bounds.push(this.parseBound());
            } while (this.eat("comma"));
            this.expect("rparen", m`閉じ括弧`);
            onDims?.(bounds);
            break;
          }
          default: {
            // PL/I の属性だが実装していないもの。
            // 「知らない語」と区別して、何が未実装か分かるようにする。
            const phase = UNIMPLEMENTED_ATTRS[w.upper];
            if (phase !== undefined) {
              throw new ParseError(
                m`${w.text.toUpperCase()} は未実装です（${tr(phase)}）`,
                w.line,

                w.col,

                w.file,
              );
            }
            throw new ParseError(
              m`属性として解釈できません: ${JSON.stringify(w.text)}`,
              w.line,

              w.col,

              w.file,
            );
          }
        }
        continue;
      }
      // 精度・長さの括弧
      if (this.at("lparen")) {
        const lp = this.next();
        // CHAR(*) — 長さを渡された引数から受け取る。
        // 文字列を扱う手続きの定型（`p: proc(s); dcl s char(*);`）で、
        // 呼ぶ側の長さに合わせるために要る
        if (this.atOp("*")) {
          this.next();
          this.expect("rparen", m`閉じ括弧`);
          star = lp;
          continue;
        }
        nums = [];
        do {
          const n = this.expect("number", m`数値`);
          nums.push(Number(n.text));
        } while (this.eat("comma"));
        this.expect("rparen", m`閉じ括弧`);
        continue;
      }
      const t = this.peek();
      throw new ParseError(
        m`属性として解釈できません: ${JSON.stringify(t.text)}`,
        t.line,

        t.col,

        t.file,
      );
    }

    // 型を 1 語も書いていない宣言（`dcl x;`）。
    // PL/I では未宣言と同じく**名前の先頭文字**で属性が決まる
    // （I〜N は FIXED BIN(15,0)、それ以外は FLOAT DEC(6)）。
    // FIXED DEC(5,0) を既定にすると `dcl x; x = 1/3;` が 0 になる。
    // `FIXED` や基数・精度を書いていれば下の switch で FIXED になる
    if (kind === undefined && base === undefined && nums === undefined && star === undefined) {
      return { type: "implicit" };
    }
    if (star !== undefined && kind !== "char" && kind !== "bit") {
      throw new ParseError(
        m`(*) は CHAR と BIT の宣言にだけ書けます`,
        star.line,
        star.col,
        star.file,
      );
    }

    switch (kind) {
      case "pointer":
        return { type: "pointer" };
      case "picture":
        return { type: "picture", picture: picture ?? "" };
      case "file":
        return {
          type: "file",
          ...(filePrint === undefined ? {} : { print: filePrint }),
          ...(fileRecord === undefined ? {} : { record: fileRecord }),
          ...(fileMode === undefined ? {} : { mode: fileMode }),
          ...(fileRecordSize === undefined ? {} : { recordSize: fileRecordSize }),
          ...(fileVariable === undefined ? {} : { variableRecords: fileVariable }),
        };
      case "entry":
        return returns === undefined ? { type: "entry" } : { type: "entry", returns };
      case "char":
        return {
          type: "char",
          length: nums?.[0] ?? 1,
          varying,
          ...(star === undefined ? {} : { starLength: true }),
        };
      case "bit":
        // BIT も VARYING を書ける（規定 p.83-84。禁じられているのは
        // VARYINGZ だけ）。落とすと宣言した属性が NONVARYING に化ける
        return {
          type: "bit",
          length: nums?.[0] ?? 1,
          ...(varying ? { varying } : {}),
          ...(star === undefined ? {} : { starLength: true }),
        };
      case "float": {
        // 既定精度は FLOAT DECIMAL(6) / FLOAT BINARY(21)（規定 p.220 の表）
        const b = base ?? "dec";
        return { type: "float", base: b, p: nums?.[0] ?? (b === "bin" ? 21 : 6) };
      }
      case "fixed":
      case undefined: {
        const b = base ?? "dec";
        const defaultP = b === "bin" ? 15 : 5;
        return {
          type: "fixed",
          base: b,
          p: nums?.[0] ?? defaultP,
          q: nums?.[1] ?? 0,
        };
      }
    }
  }

  private parsePut(): Stmt {
    const line = this.next().line; // PUT
    const options: PutOption[] = [];
    let file: string | undefined;
    let into: Ref | undefined;
    while (!this.at("semi")) {
      if (this.at("eof")) {
        const t = this.peek();
        throw new ParseError(m`セミコロン が必要です`, t.line, t.col, t.file);
      }
      const w = this.expect("word", m`PUT のオプション`);
      switch (w.upper) {
        case "SKIP": {
          if (this.eat("lparen")) {
            const count = this.parseExpr();
            this.expect("rparen", m`閉じ括弧`);
            options.push({ kind: "skip", count });
          } else {
            options.push({ kind: "skip" });
          }
          break;
        }
        case "PAGE":
          options.push({ kind: "page" });
          break;
        case "LINE": {
          this.expect("lparen", m`開き括弧`);
          const at = this.parseExpr();
          this.expect("rparen", m`閉じ括弧`);
          options.push({ kind: "line", at });
          break;
        }
        case "FILE": {
          this.expect("lparen", m`開き括弧`);
          file = this.expect("word", m`ファイル名`).text;
          this.expect("rparen", m`閉じ括弧`);
          break;
        }
        case "STRING": {
          // PUT STRING(s) — 書式の結果を文字変数へ受ける。
          // GET STRING と対になる形
          this.expect("lparen", m`開き括弧`);
          into = this.parseRef();
          this.expect("rparen", m`閉じ括弧`);
          break;
        }
        case "LIST": {
          options.push({ kind: "list", items: this.parseDataList() });
          break;
        }
        case "EDIT": {
          const items = this.parseDataList();
          this.expect("lparen", m`開き括弧（書式リスト）`);
          const format = this.parseFormatList();
          this.expect("rparen", m`閉じ括弧（書式リスト）`);
          options.push({ kind: "edit", items, format });
          break;
        }
        case "DATA":
          // データ指示入出力。名前と値を `A= 1` の形で出す。
          // 名指しで断らないと「未対応の PUT オプションです」になり、
          // 綴り間違いと未実装の区別が付かない
          throw new ParseError(
            m`PUT DATA は未実装です（PUT LIST / PUT EDIT を使ってください）`,
            w.line,
            w.col,
            w.file,
          );
        default:
          throw new ParseError(
            m`未対応の PUT オプションです: ${JSON.stringify(w.text)}`,
            w.line,

            w.col,

            w.file,
          );
      }
    }
    this.expect("semi", m`セミコロン`);
    if (into !== undefined) {
      if (file !== undefined) {
        throw new ParseError(m`PUT に STRING と FILE の両方は書けません`, line, 1);
      }
      // 文字変数には行の概念が無いので、制御項目は置けない
      const control = options.find(
        (o) => o.kind === "skip" || o.kind === "page" || o.kind === "line",
      );
      if (control !== undefined) {
        throw new ParseError(
          m`PUT STRING に ${control.kind.toUpperCase()} は書けません（文字変数に行の概念がありません）`,
          line,
          1,
        );
      }
      return { kind: "put", options, into, line };
    }
    return file === undefined
      ? { kind: "put", options, line }
      : { kind: "put", options, file, line };
  }

  /** 括弧で囲まれた式のリスト（データリスト）。 */
  private parseDataList(): Expr[] {
    this.expect("lparen", m`開き括弧`);
    const items: Expr[] = [];
    if (!this.at("rparen")) {
      do {
        items.push(this.parseDataItem());
      } while (this.eat("comma"));
    }
    this.expect("rparen", m`閉じ括弧`);
    return items;
  }

  /**
   * データリストの 1 項目。
   *
   * `(式 do 変数 = 指定)` の形（type-3 DO。規定 p.302/314）も取る。
   * 規定の例は `list ((Thickness(Distance) do Distance = 1 to 1000))`。
   * 配列の一部だけを出す・件数を読んでからその数だけ読む、という
   * PL/I で最も普通の入出力の書き方。
   */
  private parseDataItem(): Expr {
    if (!this.at("lparen")) return this.parseExpr();
    const save = this.pos;
    this.next(); // '('
    const inner: Expr[] = [];
    try {
      do {
        inner.push(this.parseExpr());
      } while (this.eat("comma"));
    } catch {
      this.pos = save;
      return this.parseExpr();
    }
    if (!this.atWord("DO")) {
      this.pos = save;
      return this.parseExpr();
    }
    this.next(); // DO
    const varName = this.expect("word", m`制御変数`).text;
    const eq = this.expect("op", "=");
    if ((eq.value ?? eq.text) !== "=") {
      throw new ParseError(m`= が必要です`, eq.line, eq.col, eq.file);
    }
    const specs: DoSpec[] = [];
    do {
      specs.push(this.parseDoSpec());
    } while (this.eat("comma"));
    this.expect("rparen", m`閉じ括弧`);
    return { kind: "iterList", items: inner, varName, specs };
  }

  /** 書式リスト（括弧の中身）。 */
  private parseFormatList(): FormatItem[] {
    const items: FormatItem[] = [];
    if (this.at("rparen")) return items;
    do {
      items.push(this.parseFormatItem());
    } while (this.eat("comma"));
    return items;
  }

  /**
   * 書式項目。
   * 先頭が '(' の場合は反復係数か入れ子のリストのどちらかで、
   * 閉じ括弧の次に書式項目が続くかどうかで区別する。
   *   (9)f(4)        -> 反復係数 9 の F(4)
   *   (f(4), x(1))   -> 入れ子のリスト
   */
  private parseFormatItem(): FormatItem {
    // 括弧を付けない反復係数（`3 F(8,4)`）。規定 p.310
    // 「n Specifies an iteration factor, which is either an expression
    // enclosed in parentheses or an integer. If it is the latter, a blank
    // must separate the integer and the following format item」。
    // 解説書の例（p.304 の `X(1), 3 F(10,4)`）がそのまま書ける必要がある
    if (this.at("number") && this.peek(1).kind === "word") {
      const n = this.next();
      return {
        kind: "repeat",
        count: { kind: "num", text: n.text },
        items: [this.parseFormatItem()],
      };
    }
    if (this.at("lparen")) {
      const save = this.pos;
      this.next();
      // 反復係数の可能性: 式を1つ読んで ')' の次が書式項目の始まりか見る
      let count: Expr | undefined;
      try {
        count = this.parseExpr();
      } catch {
        count = undefined;
      }
      if (count !== undefined && this.at("rparen")) {
        const afterParen = this.peek(1);
        if (afterParen.kind === "word" || afterParen.kind === "lparen") {
          this.next(); // ')'
          const items = this.at("lparen")
            ? (() => {
                this.next();
                const inner = this.parseFormatList();
                this.expect("rparen", m`閉じ括弧`);
                return inner;
              })()
            : [this.parseFormatItem()];
          return { kind: "repeat", count, items };
        }
      }
      // 反復係数ではなかったので入れ子のリストとして読み直す
      this.pos = save;
      this.next();
      const inner = this.parseFormatList();
      this.expect("rparen", m`閉じ括弧`);
      return { kind: "repeat", count: { kind: "num", text: "1" }, items: inner };
    }

    const w = this.expect("word", m`書式項目`);
    const nums = (): Expr[] => {
      if (!this.at("lparen")) return [];
      this.next();
      const list: Expr[] = [];
      do {
        list.push(this.parseExpr());
      } while (this.eat("comma"));
      this.expect("rparen", m`閉じ括弧`);
      return list;
    };

    switch (w.upper) {
      case "A": {
        const n = nums();
        return n[0] === undefined ? { kind: "a" } : { kind: "a", width: n[0] };
      }
      case "B": {
        const n = nums();
        return n[0] === undefined ? { kind: "b" } : { kind: "b", width: n[0] };
      }
      case "F":
      case "E": {
        const n = nums();
        if (n[0] === undefined) {
          throw new ParseError(m`${w.upper} には幅が必要です`, w.line, w.col, w.file);
        }
        // 第 3 引数（F は尺度、E は仮数の有効桁。規定 p.321/323）。
        // 読み捨てていたので、書いても書かなくても同じ結果になっていた
        if (n[2] !== undefined) {
          throw new ParseError(
            w.upper === "F"
              ? m`F 書式の尺度（第 3 引数）は未実装です`
              : m`E 書式の有効桁（第 3 引数）は未実装です`,
            w.line,
            w.col,
            w.file,
          );
        }
        const kind = w.upper === "F" ? ("f" as const) : ("e" as const);
        return n[1] === undefined
          ? { kind, width: n[0] }
          : { kind, width: n[0], decimals: n[1] };
      }
      case "X": {
        const n = nums();
        if (n[0] === undefined) {
          throw new ParseError(m`X には幅が必要です`, w.line, w.col, w.file);
        }
        return { kind: "x", width: n[0] };
      }
      case "COL":
      case "COLUMN": {
        const n = nums();
        if (n[0] === undefined) {
          throw new ParseError(m`COLUMN には位置が必要です`, w.line, w.col, w.file);
        }
        return { kind: "column", at: n[0] };
      }
      case "SKIP": {
        const n = nums();
        return n[0] === undefined ? { kind: "fskip" } : { kind: "fskip", count: n[0] };
      }
      case "PAGE":
        return { kind: "fpage" };
      default:
        throw new ParseError(
          m`未対応の書式項目です: ${JSON.stringify(w.text)}`,
          w.line,

          w.col,

          w.file,
        );
    }
  }

  /** GET STRING(src) EDIT(targets)(format) / GET STRING(src) LIST(targets) */
  private parseGet(): Stmt {
    const line = this.next().line; // GET
    // GET STRING(s) ... / GET FILE(f) ... / GET ...（SYSIN から）
    let source: IoTarget = { kind: "file", name: "SYSIN" };
    if (this.eatWord("STRING")) {
      this.expect("lparen", m`開き括弧`);
      source = { kind: "string", expr: this.parseExpr() };
      this.expect("rparen", m`閉じ括弧`);
    } else if (this.eatWord("FILE")) {
      this.expect("lparen", m`開き括弧`);
      source = { kind: "file", name: this.expect("word", m`ファイル名`).text };
      this.expect("rparen", m`閉じ括弧`);
    }

    // SKIP は読み始める前に行を送る
    let skip: Expr | null | undefined;
    if (this.atWord("SKIP")) {
      this.next();
      if (this.eat("lparen")) {
        skip = this.parseExpr();
        this.expect("rparen", m`閉じ括弧`);
      } else {
        skip = null; // 回数指定なし = 1 行
      }
    }

    let format: FormatItem[] | undefined;
    const targets: Ref[] = [];
    if (this.eatWord("EDIT")) {
      this.expect("lparen", m`開き括弧`);
      do {
        this.refuseIterList();
        targets.push(this.parseRef());
      } while (this.eat("comma"));
      this.expect("rparen", m`閉じ括弧`);
      this.expect("lparen", m`開き括弧（書式リスト）`);
      format = this.parseFormatList();
      this.expect("rparen", m`閉じ括弧（書式リスト）`);
    } else if (this.eatWord("LIST")) {
      this.expect("lparen", m`開き括弧`);
      do {
        this.refuseIterList();
        targets.push(this.parseRef());
      } while (this.eat("comma"));
      this.expect("rparen", m`閉じ括弧`);
    } else if (this.atWord("DATA")) {
      // データ指示入出力。PUT DATA と対で名指しで断る
      const t = this.next();
      throw new ParseError(
        m`GET DATA は未実装です（GET LIST / GET EDIT を使ってください）`,
        t.line,
        t.col,
        t.file,
      );
    } else if (skip === undefined) {
      const t = this.peek();
      throw new ParseError(m`EDIT または LIST が必要です`, t.line, t.col, t.file);
    }
    if (this.atWord("COPY")) {
      // 「The COPY option specifies that the source data stream is written
      // on the specified STREAM OUTPUT file without alteration」（規定 p.301）
      const t = this.next();
      throw new ParseError(
        m`GET の COPY 指定（読んだ内容をそのまま出す）は未実装です`,
        t.line,
        t.col,
        t.file,
      );
    }
    this.expect("semi", m`セミコロン`);
    const stmt = { kind: "get" as const, source, targets, line };
    return {
      ...stmt,
      ...(format === undefined ? {} : { format }),
      ...(skip === undefined ? {} : { skip }),
    };
  }

  /**
   * `GET` のデータリストに反復指定（type-3 DO）が来たら名指しで断る。
   *
   * 出力側は実装してあるが、入力側は代入先の並びを `Ref[]` で持つ
   * （反復を表せない）。素の「閉じ括弧が必要です」だと未実装と分からない。
   */
  private refuseIterList(): void {
    if (!this.at("lparen")) return;
    const save = this.pos;
    let depth = 0;
    for (let i = this.pos; i < this.toks.length; i++) {
      const t = this.toks[i]!;
      if (t.kind === "lparen") depth++;
      else if (t.kind === "rparen") {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1 && t.kind === "word" && t.upper === "DO") {
        throw new ParseError(
          m`GET のデータリストの反復指定（(x(i) do i = 1 to n) の形）は未実装です`,
          t.line,
          t.col,
          t.file,
        );
      } else if (t.kind === "eof") break;
    }
    this.pos = save;
  }

  private parseIf(): Stmt {
    const line = this.next().line; // IF
    const cond = this.parseExpr();
    this.expectWord("THEN");
    const then = this.parseStatement();
    // ELSE は最も内側の IF に結びつく（ここで貪欲に取ることで実現される）
    let elseStmt: Stmt | undefined;
    if (this.atWord("ELSE") && !this.looksLikeAssignment()) {
      this.next();
      elseStmt = this.parseStatement();
    }
    const stmt: Stmt = { kind: "if", cond, then, line };
    if (elseStmt !== undefined) {
      return { ...stmt, else: elseStmt } as Stmt;
    }
    return stmt;
  }

  private parseDo(labelNames: string[] = []): Stmt {
    const line = this.next().line; // DO
    // `LEAVE outer;` の宛先になるので、DO 自身にラベルを持たせる
    const labels = labelNames.length > 0 ? { labels: labelNames } : {};

    // DO;
    if (this.eat("semi")) {
      return { kind: "doGroup", body: this.parseBlockUntilEnd(labelNames), ...labels, line };
    }

    // DO LOOP; / DO FOREVER;（規定 p.271「LOOP Specifies infinite
    // iteration. FOREVER is a synonym of LOOP」）。
    // 次が `;` のときだけ。`do loop = 1 to 2;` は制御変数 LOOP の反復
    if (this.atWord("LOOP", "FOREVER") && this.peek(1).kind === "semi") {
      this.next();
      this.expect("semi", m`セミコロン`);
      return {
        kind: "doWhile",
        cond: { kind: "bit", value: "1" },
        body: this.parseBlockUntilEnd(labelNames),
        ...labels,
        line,
      };
    }

    // DO WHILE(...) / DO UNTIL(...)（両方を併記できる）
    if (this.atWord("WHILE", "UNTIL")) {
      let whileCond: Expr | undefined;
      let untilCond: Expr | undefined;
      while (this.atWord("WHILE", "UNTIL")) {
        const which = this.next().upper;
        const cond = this.parenExpr();
        if (which === "WHILE") whileCond = cond;
        else untilCond = cond;
      }
      this.expect("semi", m`セミコロン`);
      const body = this.parseBlockUntilEnd(labelNames);
      // WHILE が書かれていれば doWhile（本体の前に見る条件）。
      // UNTIL だけなら doUntil（本体の後に見る条件）
      if (whileCond !== undefined) {
        return {
          kind: "doWhile",
          cond: whileCond,
          ...(untilCond !== undefined ? { until: untilCond } : {}),
          body,
          ...labels,
          line,
        };
      }
      return { kind: "doUntil", cond: untilCond!, body, ...labels, line };
    }

    // DO var = <指定>[, <指定>...];
    // 指定は `from TO to [BY by]` / `from REPEAT next` / 単一値 に
    // それぞれ WHILE(...) / UNTIL(...) を付けられる。
    const varName = this.expect("word", m`制御変数`).text;
    const eq = this.expect("op", "=");
    if ((eq.value ?? eq.text) !== "=") {
      throw new ParseError(m`= が必要です`, eq.line, eq.col, eq.file);
    }
    const specs: DoSpec[] = [];
    do {
      specs.push(this.parseDoSpec());
    } while (this.eat("comma"));
    this.expect("semi", m`セミコロン`);
    const body = this.parseBlockUntilEnd(labelNames);
    return { kind: "doIter", varName, specs, body, ...labels, line };
  }

  /** 括弧で囲まれた式。条件の指定（WHILE / UNTIL）で使う。 */
  private parenExpr(): Expr {
    this.expect("lparen", m`開き括弧`);
    const e = this.parseExpr();
    this.expect("rparen", m`閉じ括弧`);
    return e;
  }

  /**
   * DO 反復の 1 指定。
   *
   * `TO` / `BY` / `REPEAT` / `WHILE` / `UNTIL` は順不同で、
   * 同じ語を 2 度書けば後のものが勝つ（PL/I の処理系と同じ）。
   * `TO`・`BY` と `REPEAT` はどちらも「次の値」を決めるので併記できない。
   */
  private parseDoSpec(): DoSpec {
    const from = this.parseExpr();
    let to: Expr | undefined;
    let by: Expr | undefined;
    let repeat: Expr | undefined;
    let whileCond: Expr | undefined;
    let untilCond: Expr | undefined;
    let thru = false;
    for (;;) {
      const t = this.peek();
      if (this.eatWord("TO")) {
        to = this.parseExpr();
        continue;
      }
      // UPTHRU / DOWNTHRU は TO と同じ上限だが**本体の後**に判定する
      // （規定 p.265。端から外れていても 1 回は実行する）
      if (this.atWord("UPTHRU", "DOWNTHRU")) {
        const dir = this.next().upper;
        to = this.parseExpr();
        thru = true;
        if (dir === "DOWNTHRU" && by === undefined) {
          by = { kind: "unary", op: "-", operand: { kind: "num", text: "1" } };
        }
        continue;
      }
      if (this.eatWord("BY")) {
        by = this.parseExpr();
        continue;
      }
      if (this.eatWord("REPEAT")) {
        repeat = this.parseExpr();
        continue;
      }
      if (this.eatWord("WHILE")) {
        whileCond = this.parenExpr();
        continue;
      }
      if (this.eatWord("UNTIL")) {
        untilCond = this.parenExpr();
        continue;
      }
      if (repeat !== undefined && (to !== undefined || by !== undefined)) {
        throw new ParseError(
          m`REPEAT と TO / BY は同じ指定に書けません`,
          t.line,
          t.col,
          t.file,
        );
      }
      break;
    }
    return {
      from,
      ...(to !== undefined ? { to } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
      ...(whileCond !== undefined ? { while: whileCond } : {}),
      ...(untilCond !== undefined ? { until: untilCond } : {}),
      ...(thru ? { thru } : {}),
    };
  }

  /** SELECT(expr) ... WHEN(...) ... OTHERWISE ... END */
  private parseSelect(): Stmt {
    const line = this.next().line; // SELECT
    let subject: Expr | undefined;
    if (this.eat("lparen")) {
      subject = this.parseExpr();
      this.expect("rparen", m`閉じ括弧`);
    }
    this.expect("semi", m`セミコロン`);

    const whens: WhenClause[] = [];
    let otherwise: Stmt | undefined;
    for (;;) {
      if (this.at("eof")) {
        const t = this.peek();
        throw new ParseError(m`SELECT に END が必要です`, t.line, t.col, t.file);
      }
      if (this.atWord("END") && !this.looksLikeAssignment()) {
        this.next();
        if (this.at("word")) this.next();
        this.expect("semi", m`セミコロン`);
        break;
      }
      if (this.atWord("WHEN") && !this.looksLikeAssignment()) {
        this.next();
        this.expect("lparen", m`開き括弧`);
        const values: Expr[] = [];
        do {
          values.push(this.parseExpr());
        } while (this.eat("comma"));
        this.expect("rparen", m`閉じ括弧`);
        whens.push({ values, body: this.parseStatement() });
        continue;
      }
      if (this.atWord("OTHERWISE", "OTHER") && !this.looksLikeAssignment()) {
        this.next();
        otherwise = this.parseStatement();
        continue;
      }
      const t = this.peek();
      throw new ParseError(
        m`SELECT の中には WHEN / OTHERWISE / END のみ置けます（${JSON.stringify(t.text)}）`,
        t.line,

        t.col,

        t.file,
      );
    }
    const stmt: Stmt = { kind: "select", whens, line };
    return {
      ...stmt,
      ...(subject !== undefined ? { subject } : {}),
      ...(otherwise !== undefined ? { otherwise } : {}),
    } as Stmt;
  }

  private parseBegin(blockLabels: string[] = []): Stmt {
    const line = this.next().line; // BEGIN
    // `BEGIN OPTIONS(...) RECURSIVE ORDER|REORDER;`（規定 p.164）。
    // どれも最適化と多重処理の指定なので、読み飛ばして受ける
    for (;;) {
      if (this.atWord("OPTIONS")) {
        this.next();
        this.skipBalancedParens();
        continue;
      }
      if (this.eatWord("RECURSIVE", "ORDER", "REORDER")) continue;
      break;
    }
    this.expect("semi", m`セミコロン`);
    return { kind: "beginBlock", body: this.parseBlockUntilEnd(blockLabels), line };
  }

  private parseGoto(): Stmt {
    const kw = this.next(); // GOTO / GO
    if (kw.upper === "GO") this.expectWord("TO");
    const label = this.expect("word", m`飛び先のラベル`).text;
    this.expect("semi", m`セミコロン`);
    return { kind: "goto", label, line: kw.line };
  }

  private parseOn(): Stmt {
    const line = this.next().line; // ON
    const cond = this.expect("word", m`条件名`);
    // ENDFILE(SYSIN) のようにファイルを取る条件
    const conditionFile = this.parseConditionFile();
    // SNAP は報告の指定なので読み飛ばす。
    // SYSTEM は「既定動作へ戻す」ので、本体を持たない ON 文にする
    let system = false;
    while (this.atWord("SNAP", "SYSTEM")) {
      if (this.peek().upper === "SYSTEM") system = true;
      this.next();
    }
    if (system) {
      this.expect("semi", m`セミコロン`);
      return conditionFile === undefined
        ? { kind: "on", condition: cond.upper, line }
        : { kind: "on", condition: cond.upper, conditionFile, line };
    }
    const body = this.parseStatement();
    return conditionFile === undefined
      ? { kind: "on", condition: cond.upper, body, line }
      : { kind: "on", condition: cond.upper, conditionFile, body, line };
  }

  /** 条件名のあとの `(ファイル名)`。入出力の条件にだけ付く。 */
  private parseConditionFile(): string | undefined {
    if (!this.at("lparen")) return undefined;
    this.next();
    const name = this.expect("word", m`ファイル名`).text;
    this.expect("rparen", m`閉じ括弧`);
    return name;
  }

  /**
   * OPEN FILE(f) 属性..., FILE(g) ...;
   *
   * 属性は宣言と同じ語（INPUT / OUTPUT / PRINT / STREAM / RECORD）に
   * LINESIZE / PAGESIZE / TITLE が加わる。
   */
  private parseOpen(): Stmt {
    const line = this.next().line; // OPEN
    const files: { name: string; attrs: OpenAttrs }[] = [];
    do {
      if (!this.eatWord("FILE")) {
        const t = this.peek();
        throw new ParseError(m`OPEN には FILE(名前) が必要です`, t.line, t.col, t.file);
      }
      this.expect("lparen", m`開き括弧`);
      const name = this.expect("word", m`ファイル名`).text;
      this.expect("rparen", m`閉じ括弧`);

      const attrs: OpenAttrs = {};
      while (this.at("word") && !this.atWord("FILE")) {
        const w = this.next();
        switch (w.upper) {
          case "INPUT": attrs.mode = "input"; break;
          case "OUTPUT": attrs.mode = "output"; break;
          case "UPDATE": attrs.mode = "update"; break;
          case "PRINT": attrs.print = true; break;
          case "STREAM": attrs.record = false; break;
          case "RECORD": attrs.record = true; break;
          case "LINESIZE": {
            this.expect("lparen", m`開き括弧`);
            attrs.lineSize = this.parseExpr();
            this.expect("rparen", m`閉じ括弧`);
            break;
          }
          case "PAGESIZE": {
            this.expect("lparen", m`開き括弧`);
            attrs.pageSize = this.parseExpr();
            this.expect("rparen", m`閉じ括弧`);
            break;
          }
          case "TITLE": {
            this.expect("lparen", m`開き括弧`);
            attrs.title = this.parseExpr();
            this.expect("rparen", m`閉じ括弧`);
            break;
          }
          default:
            throw new ParseError(
              m`OPEN の属性として解釈できません: ${JSON.stringify(w.text)}`,
              w.line,
              w.col,
              w.file,
            );
        }
      }
      files.push({ name, attrs });
    } while (this.eat("comma"));
    this.expect("semi", m`セミコロン`);
    return { kind: "open", files, line };
  }

  private parseClose(): Stmt {
    const line = this.next().line; // CLOSE
    const files: string[] = [];
    do {
      if (!this.eatWord("FILE")) {
        const t = this.peek();
        throw new ParseError(m`CLOSE には FILE(名前) が必要です`, t.line, t.col, t.file);
      }
      this.expect("lparen", m`開き括弧`);
      if (this.atOp("*")) {
        // 「CLOSE FILE(*) closes all open files」（規定 p.288）
        const t = this.peek();
        throw new ParseError(
          m`FILE(*)（開いている全ファイル）は未実装です。ファイル名を書いてください`,
          t.line,
          t.col,
          t.file,
        );
      }
      files.push(this.expect("word", m`ファイル名`).text);
      this.expect("rparen", m`閉じ括弧`);
    } while (this.eat("comma"));
    this.expect("semi", m`セミコロン`);
    return { kind: "close", files, line };
  }

  private parseCall(): Stmt {
    const line = this.next().line; // CALL
    const name = this.expect("word", m`手続き名`).text;
    const args: Expr[] = [];
    if (this.eat("lparen")) {
      if (!this.at("rparen")) {
        do {
          args.push(this.parseExpr());
        } while (this.eat("comma"));
      }
      this.expect("rparen", m`閉じ括弧`);
    }
    this.expect("semi", m`セミコロン`);
    return { kind: "call", name, args, line };
  }

  private parseReturn(): Stmt {
    const line = this.next().line; // RETURN
    let value: Expr | undefined;
    if (this.eat("lparen")) {
      value = this.parseExpr();
      this.expect("rparen", m`閉じ括弧`);
    }
    this.expect("semi", m`セミコロン`);
    const stmt: Stmt = { kind: "return", line };
    if (value !== undefined) {
      return { ...stmt, value } as Stmt;
    }
    return stmt;
  }

  // ---- 式 ----

  parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op") break;
      const op = t.value ?? t.text;
      const prec = BINARY_PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = this.parseExpr(nextMin);
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === "op") {
      const op = t.value ?? t.text;
      if (UNARY_OPS.has(op)) {
        this.next();
        // 単項演算子は ** と同じ強さ（右から左）
        const operand = this.parseExpr(BINARY_PRECEDENCE["**"]!);
        return { kind: "unary", op, operand };
      }
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case "number":
        this.next();
        return { kind: "num", text: t.text };
      case "string":
        this.next();
        return { kind: "str", value: t.value ?? "" };
      case "bitstr":
        this.next();
        return { kind: "bit", value: t.value ?? "" };
      case "hexstr": {
        this.next();
        // 16 進定数は 2 桁ずつ 1 文字へデコードする（`'4142'X` は `'AB'`）。
        // 以前は 16 進数字の並びをそのまま文字列にしていたので、
        // `'41'X` が `'41'` になっていた
        const body = (t.value ?? "").replace(/\s+/g, "");
        if (!/^[0-9A-Fa-f]*$/.test(body)) {
          throw new ParseError(
            m`16 進定数に使えない文字があります: ${JSON.stringify(t.value ?? "")}`,
            t.line,
            t.col,
          );
        }
        if (body.length % 2 !== 0) {
          throw new ParseError(
            m`16 進定数の桁数は偶数でなければなりません（1 文字 = 2 桁）`,
            t.line,
            t.col,
          );
        }
        let decoded = "";
        for (let k = 0; k < body.length; k += 2) {
          decoded += String.fromCharCode(parseInt(body.slice(k, k + 2), 16));
        }
        return { kind: "str", value: decoded };
      }
      case "lparen": {
        this.next();
        const e = this.parseExpr();
        this.expect("rparen", m`閉じ括弧`);
        // 括弧で包んだ参照には印を付ける。PL/I は括弧を書いた引数に
        // **ダミー引数を作る**（規定 p.162）ので、剥がしてしまうと
        // `call p((x));` の「書き換えさせない」が黙って無効になる
        return e.kind === "ref" ? { ...e, parens: true } : e;
      }
      case "word":
        return this.parseRef();
      default:
        throw new ParseError(
          m`式が必要です（${t.kind === "eof" ? m`入力の終わり` : JSON.stringify(t.text)} が現れました）`,
          t.line,

          t.col,

          t.file,
        );
    }
  }

  /**
   * DEFINED の基底参照。添字に iSUB（1sub, 2sub, ...）を書ける。
   * 字句解析では "1sub" が number + word になるので、ここで組み立てる。
   */
  private parseRefWithISub(): Ref {
    const name = this.expect("word", m`基底変数名`).text;
    const subscripts: Expr[] = [];
    if (this.eat("lparen")) {
      if (!this.at("rparen")) {
        do {
          subscripts.push(this.parseISubOrExpr());
        } while (this.eat("comma"));
      }
      this.expect("rparen", m`閉じ括弧`);
    }
    return { kind: "ref", name, subscripts };
  }

  private parseISubOrExpr(): Expr {
    // "1sub" は number の直後に word "SUB" が続く形で現れる
    const t = this.peek();
    const nxt = this.peek(1);
    if (t.kind === "number" && nxt.kind === "word" && nxt.upper === "SUB") {
      this.next();
      this.next();
      return { kind: "isub", dim: Number(t.text) };
    }
    return this.parseExpr();
  }

  /** 変数参照または関数呼び出し。構文上は区別できない。 */
  private parseRef(): Ref {
    // 構造体の修飾名 rec.addr.city は1つの名前として扱う。
    // 字句解析では '.' が演算子として出ないため、ここで数値の小数点と
    // 区別するために word の直後に '.' が続く形だけを拾う。
    let name = this.expect("word", m`変数名`).text;
    while (this.at("dot") && this.peek(1).kind === "word") {
      this.next();
      name += "." + this.next().text;
    }
    const subscripts: Expr[] = [];
    let called = false;
    if (this.at("lparen")) {
      this.next();
      called = true;
      if (!this.at("rparen")) {
        do {
          // `*` 添字（断面。規定 p.104 の `subscript-list` は `*` を取る）。
          // 配列の 1 行・1 列をまとめて扱う形で、素の「式が必要です」だと
          // 書き方を間違えたように見える
          if (this.atOp("*")) {
            const t = this.peek();
            throw new ParseError(
              m`* 添字（配列の断面）は未実装です`,
              t.line,
              t.col,
              t.file,
            );
          }
          subscripts.push(this.parseExpr());
        } while (this.eat("comma"));
      }
      this.expect("rparen", m`閉じ括弧`);
    }
    const ref: Ref = { kind: "ref", name, subscripts, ...(called ? { called } : {}) };

    // ポインタ修飾 p -> x。左が位置指定、右が BASED 変数。
    //
    // `q -> r -> w` は `((q -> r)) -> w`（規定 p.302「they are evaluated
    // from left to right」）。右結合で読んだ結果の**一番内側の locator**
    // に自分を付ける。上書きすると途中の段が落ちて `q -> w` と同じ意味に
    // なり、読みでは診断も出ないまま空の値が出力に混ざる
    if (this.atOp("->")) {
      this.next();
      return attachLocator(this.parseRef(), ref);
    }
    return ref;
  }

  /**
   * READ / WRITE / REWRITE。
   * 指定の順序は自由（`READ INTO(r) FILE(f);` も書ける）。
   */
  private parseRecordIo(op: "read" | "write" | "rewrite"): Stmt {
    const line = this.next().line;
    let file: string | undefined;
    let into: Ref | undefined;
    let from: Ref | undefined;
    let set: Ref | undefined;
    let ignore: Expr | undefined;

    while (!this.at("semi") && !this.at("eof")) {
      const w = this.expect("word", m`${op.toUpperCase()} の指定`);
      this.expect("lparen", m`開き括弧`);
      switch (w.upper) {
        case "FILE":
          file = this.expect("word", m`ファイル名`).text;
          break;
        case "INTO":
          into = this.parseRef();
          break;
        case "FROM":
          from = this.parseRef();
          break;
        case "SET":
          set = this.parseRef();
          break;
        case "IGNORE":
          // 「If n is greater than zero, n records are ignored」（規定 p.294）
          ignore = this.parseExpr();
          break;
        case "KEY":
        case "KEYFROM":
          throw new ParseError(
            m`索引ファイル（KEY 指定）は未実装です`,
            w.line,
            w.col,
            w.file,
          );
        default:
          throw new ParseError(
            m`${op.toUpperCase()} の指定として解釈できません: ${JSON.stringify(w.text)}`,
            w.line,
            w.col,
            w.file,
          );
      }
      this.expect("rparen", m`閉じ括弧`);
      this.eat("comma");
    }
    this.expect("semi", m`セミコロン`);

    if (file === undefined) {
      const t = this.peek();
      throw new ParseError(
        m`${op.toUpperCase()} には FILE(名前) が必要です`,
        t.line,
        t.col,
        t.file,
      );
    }
    return {
      kind: "record",
      op,
      file,
      line,
      ...(into === undefined ? {} : { into }),
      ...(from === undefined ? {} : { from }),
      ...(set === undefined ? {} : { set }),
      ...(ignore === undefined ? {} : { ignore }),
    };
  }

  /** ALLOCATE x SET(p); */
  private parseAllocate(): Stmt {
    const line = this.next().line; // ALLOCATE
    const name = this.expect("word", m`変数名`).text;
    let set: Ref | undefined;
    if (this.eatWord("SET")) {
      this.expect("lparen", m`開き括弧`);
      set = this.parseRef();
      this.expect("rparen", m`閉じ括弧`);
    }
    this.expect("semi", m`セミコロン`);
    return set === undefined
      ? { kind: "allocate", name, line }
      : { kind: "allocate", name, set, line };
  }

  /** FREE p -> x, q -> y; */
  private parseFree(): Stmt {
    const line = this.next().line; // FREE
    const refs: Ref[] = [];
    do {
      refs.push(this.parseRef());
    } while (this.eat("comma"));
    this.expect("semi", m`セミコロン`);
    return { kind: "free", refs, line };
  }
}

export interface ParseOptions {
  /** `%INCLUDE` の解決に使う。 */
  host?: PliHost;
}

export function parse(source: string, opts: ParseOptions = {}): Program {
  // %INCLUDE / %REPLACE をトークン列の段階で処理する
  const host = opts.host;
  return new Parser(preprocess(lex(source), host === undefined ? {} : { host })).parseProgram();
}
