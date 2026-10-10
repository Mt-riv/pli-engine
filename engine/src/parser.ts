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
  KEYED: "索引ファイル",
  REGIONAL: "直接編成ファイル",
  AREA: "AREA 記憶域",
  OFFSET: "AREA 記憶域",
  BUILTIN: "BUILTIN 宣言",
  LABEL: "LABEL 変数",
  REFER: "自己定義構造体",
  UNION: "記憶域の重ね合わせ",
  LIKE: "構造体の複製",
  EVENT: "多重処理",
  TASK: "多重処理",
  COMPLEX: "複素数",
  CPLX: "複素数",
  ALIGNED: "記憶域の境界合わせ。この処理系では意味を持たない",
  UNALIGNED: "記憶域の境界合わせ。この処理系では意味を持たない",
  CONTROLLED: "CONTROLLED 記憶域",
  CTL: "CONTROLLED 記憶域",
};

/**
 * PL/I の文だが実装していないもの。
 *
 * 文の先頭の語がここにあれば「未実装」と断る。
 * 無いと「解釈できない文です」になり、やはり綴り間違いと区別が付かない。
 */
const UNIMPLEMENTED_STATEMENTS: Readonly<Record<string, string>> = {
  WAIT: "多重処理",
  DISPLAY: "PUT を使ってください",
  DELAY: "時間待ち",
  REVERT: "ON 単位の解除は ON ... SYSTEM; を使ってください",
  LOCATE: "LOCATE 割り当て",
  UNLOCK: "レコードのロック",
  DELETE: "索引ファイルが必要",
  EXIT: "STOP を使ってください",
  DEFAULT: "DEFAULT 文",
  DFT: "DEFAULT 文",
};

class Parser {
  private pos = 0;

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
        `${what} が必要です（${t.kind === "eof" ? "入力の終わり" : JSON.stringify(t.text)} が現れました）`,
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
        `${word} が必要です（${t.kind === "eof" ? "入力の終わり" : JSON.stringify(t.text)} が現れました）`,
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

  /** 次が手続き・BEGIN か（ラベルが名前として使われる形）。 */
  private atBlockHead(): boolean {
    return (
      this.at("word") && ["PROCEDURE", "PROC", "BEGIN"].includes(this.peek().upper)
    );
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
   */
  private parseStatement(): Stmt {
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
          return this.parseProcedure(label, t.line);
        case "DECLARE":
        case "DCL":
          return this.parseDeclare();
        case "PUT":
          return this.parsePut();
        case "IF":
          return this.parseIf();
        case "DO":
          return this.parseDo();
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
          return this.parseBegin();
        case "LEAVE":
        case "ITERATE": {
          const kw = this.next();
          const label = this.at("word") ? this.next().text : undefined;
          this.expect("semi", "セミコロン");
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
          const cond = this.expect("word", "条件名");
          const condFile = this.parseConditionFile();
          this.expect("semi", "セミコロン");
          return condFile === undefined
            ? { kind: "signal", condition: cond.upper, line: kw.line }
            : { kind: "signal", condition: cond.upper, conditionFile: condFile, line: kw.line };
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
          `${t.text.toUpperCase()} は未実装です（${why}）`,
          t.line,
          t.col,
          t.file,
        );
      }
    }

    throw new ParseError(
      `解釈できない文です（${JSON.stringify(t.text)}）`,
      t.line,

      t.col,

      t.file,
    );
  }

  /**
   * 先頭が「語 + 省略可能な括弧（添字）」に続いて '=' か。
   * 括弧は入れ子を数えて飛ばす。'=' は比較にも使われるが、
   * 文の先頭位置に現れた場合は代入とみなす（PL/I の規則）。
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

    if (!skipRef()) return false;
    // ポインタ修飾 p -> x = ... も代入文
    while (this.toks[i]?.kind === "op" && (this.toks[i]!.value ?? "") === "->") {
      i++;
      if (this.toks[i]?.kind !== "word") return false;
      i++;
      if (!skipRef()) return false;
    }

    const t = this.toks[i];
    return t?.kind === "op" && (t.value ?? t.text) === "=";
  }

  private parseAssignment(): Stmt {
    const line = this.peek().line;
    const target = this.parseRef();
    const op = this.expect("op", "=");
    if ((op.value ?? op.text) !== "=") {
      throw new ParseError("= が必要です", op.line, op.col, op.file);
    }
    const value = this.parseExpr();
    this.expect("semi", "セミコロン");
    return { kind: "assign", target, value, line };
  }

  private parseProcedure(label: string | undefined, line: number): Stmt {
    if (label === undefined) {
      const t = this.peek();
      throw new ParseError("手続きには名前（ラベル）が必要です", t.line, t.col, t.file);
    }
    this.next(); // PROCEDURE / PROC

    const params: string[] = [];
    if (this.eat("lparen")) {
      if (!this.at("rparen")) {
        do {
          params.push(this.expect("word", "引数名").text);
        } while (this.eat("comma"));
      }
      this.expect("rparen", "閉じ括弧");
    }

    let isMain = false;
    let recursive = false;
    let returns: DataAttr | undefined;
    // OPTIONS(...) / RETURNS(...) / RECURSIVE は順不同
    for (;;) {
      if (this.atWord("OPTIONS")) {
        this.next();
        this.expect("lparen", "開き括弧");
        // PL/I の OPTIONS は空白区切り（カンマも許す）。
        // 例: options(main reentrant) / options(main, reentrant)
        while (this.at("word")) {
          const o = this.next();
          if (o.upper === "MAIN") isMain = true;
          this.eat("comma");
        }
        this.expect("rparen", "閉じ括弧");
        continue;
      }
      if (this.atWord("RETURNS")) {
        this.next();
        this.expect("lparen", "開き括弧");
        returns = this.parseAttributes(() => this.at("rparen"));
        this.expect("rparen", "閉じ括弧");
        continue;
      }
      if (this.eatWord("RECURSIVE")) {
        recursive = true;
        continue;
      }
      break;
    }
    this.expect("semi", "セミコロン");

    const body = this.parseBlockUntilEnd(label);
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
   * END に名前が付いている場合は開始ラベルと一致することを確認する。
   */
  private parseBlockUntilEnd(name?: string): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      if (this.at("eof")) {
        const t = this.peek();
        throw new ParseError("END が必要です", t.line, t.col, t.file);
      }
      // END は文キーワードだが、'END = 1' のような代入でないことを確認する
      if (this.atWord("END") && !this.looksLikeAssignment()) {
        this.next();
        if (this.at("word")) {
          const endName = this.next();
          if (name !== undefined && endName.upper !== name.toUpperCase()) {
            throw new ParseError(
              `END の名前 ${JSON.stringify(endName.text)} が開始の ${JSON.stringify(name)} と一致しません`,
              endName.line,

              endName.col,

              endName.file,
            );
          }
        }
        this.expect("semi", "セミコロン");
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
    this.expect("semi", "セミコロン");
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
        `構造体そのものに付けた次元は未実装です（構造体の配列）。` +
          `${item.names[0] ?? ""} の次元を葉の項目へ移してください`,
        w.line,
        w.col,
        w.file,
      );
    }
  }

  private parseDeclItem(): DeclItem {
    // 構造体のレベル番号（dcl 1 rec, 2 name char(10); の 1 や 2）
    let level: number | undefined;
    if (this.at("number") && this.peek(1).kind === "word") {
      level = Number(this.next().text);
    }
    const names: string[] = [];
    if (this.eat("lparen")) {
      do {
        names.push(this.expect("word", "変数名").text);
      } while (this.eat("comma"));
      this.expect("rparen", "閉じ括弧");
    } else {
      names.push(this.expect("word", "変数名").text);
    }

    // 名前の直後の括弧は配列の次元。属性語の後の括弧（精度・長さ）とは別物。
    //   dcl b(3,3) bin fixed;   -> 次元 (3,3)
    //   dcl a fixed bin(31);    -> 精度 (31)
    let dims: Bound[] | undefined;
    if (this.at("lparen")) {
      this.next();
      dims = [];
      do {
        dims.push(this.parseBound());
      } while (this.eat("comma"));
      this.expect("rparen", "閉じ括弧");
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
    );
    const item: DeclItem = { names, attr };
    if (based !== undefined) item.based = based;
    if (level !== undefined) item.level = level;
    if (dims !== undefined) item.dims = dims;
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
    return sign * Number(this.expect("number", "次元の大きさ").text);
  }

  /** 対応する閉じ括弧まで読み飛ばす。中身に意味を持たせない指定に使う。 */
  private skipBalancedParens(): void {
    this.expect("lparen", "開き括弧");
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
            this.expect("lparen", "開き括弧");
            while (!this.at("rparen") && !this.at("eof")) {
              if (this.at("word")) {
                const e = this.next();
                if (e.upper === "RECSIZE" || e.upper === "BLKSIZE") {
                  this.expect("lparen", "開き括弧");
                  const n = this.expect("number", "数値");
                  this.expect("rparen", "閉じ括弧");
                  if (e.upper === "RECSIZE") fileRecordSize = Number(n.text);
                } else if (e.upper === "V" || e.upper === "VB") {
                  fileVariable = true;
                } else if (e.upper === "F" || e.upper === "FB") {
                  fileVariable = false;
                }
                continue;
              }
              this.next();
            }
            this.expect("rparen", "閉じ括弧");
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
              this.expect("rparen", "閉じ括弧");
              onBased?.({ pointer: ptr });
            } else {
              onBased?.({});
            }
            break;
          }
          case "PIC":
          case "PICTURE": {
            const t = this.expect("string", "PICTURE の指定");
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
            this.expect("lparen", "開き括弧");
            returns = this.parseAttributes(() => this.at("rparen"));
            this.expect("rparen", "閉じ括弧");
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
            this.expect("lparen", "開き括弧");
            const values: Expr[] = [];
            do {
              values.push(this.parseExpr());
            } while (this.eat("comma"));
            this.expect("rparen", "閉じ括弧");
            onInit?.(values);
            break;
          }
          case "DEF":
          case "DEFINED": {
            // DEFINED の基底参照。添字に iSUB を含められる。
            this.expect("lparen", "開き括弧");
            const base = this.parseRefWithISub();
            this.expect("rparen", "閉じ括弧");
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
          default: {
            // PL/I の属性だが実装していないもの。
            // 「知らない語」と区別して、何が未実装か分かるようにする。
            const phase = UNIMPLEMENTED_ATTRS[w.upper];
            if (phase !== undefined) {
              throw new ParseError(
                `${w.text.toUpperCase()} は未実装です（${phase}）`,
                w.line,

                w.col,

                w.file,
              );
            }
            throw new ParseError(
              `属性として解釈できません: ${JSON.stringify(w.text)}`,
              w.line,

              w.col,

              w.file,
            );
          }
        }
        continue;
      }
      // 精度・長さの括弧
      if (this.eat("lparen")) {
        nums = [];
        do {
          const n = this.expect("number", "数値");
          nums.push(Number(n.text));
        } while (this.eat("comma"));
        this.expect("rparen", "閉じ括弧");
        continue;
      }
      const t = this.peek();
      throw new ParseError(
        `属性として解釈できません: ${JSON.stringify(t.text)}`,
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
    if (kind === undefined && base === undefined && nums === undefined) {
      return { type: "implicit" };
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
        return { type: "char", length: nums?.[0] ?? 1, varying };
      case "bit":
        return { type: "bit", length: nums?.[0] ?? 1 };
      case "float":
        return { type: "float", base: base ?? "dec", p: nums?.[0] ?? 6 };
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
    while (!this.at("semi")) {
      if (this.at("eof")) {
        const t = this.peek();
        throw new ParseError("セミコロン が必要です", t.line, t.col, t.file);
      }
      const w = this.expect("word", "PUT のオプション");
      switch (w.upper) {
        case "SKIP": {
          if (this.eat("lparen")) {
            const count = this.parseExpr();
            this.expect("rparen", "閉じ括弧");
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
          this.expect("lparen", "開き括弧");
          const at = this.parseExpr();
          this.expect("rparen", "閉じ括弧");
          options.push({ kind: "line", at });
          break;
        }
        case "FILE": {
          this.expect("lparen", "開き括弧");
          file = this.expect("word", "ファイル名").text;
          this.expect("rparen", "閉じ括弧");
          break;
        }
        case "LIST": {
          options.push({ kind: "list", items: this.parseDataList() });
          break;
        }
        case "EDIT": {
          const items = this.parseDataList();
          this.expect("lparen", "開き括弧（書式リスト）");
          const format = this.parseFormatList();
          this.expect("rparen", "閉じ括弧（書式リスト）");
          options.push({ kind: "edit", items, format });
          break;
        }
        default:
          throw new ParseError(
            `未対応の PUT オプションです: ${JSON.stringify(w.text)}`,
            w.line,

            w.col,

            w.file,
          );
      }
    }
    this.expect("semi", "セミコロン");
    return file === undefined
      ? { kind: "put", options, line }
      : { kind: "put", options, file, line };
  }

  /** 括弧で囲まれた式のリスト（データリスト）。 */
  private parseDataList(): Expr[] {
    this.expect("lparen", "開き括弧");
    const items: Expr[] = [];
    if (!this.at("rparen")) {
      do {
        items.push(this.parseExpr());
      } while (this.eat("comma"));
    }
    this.expect("rparen", "閉じ括弧");
    return items;
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
                this.expect("rparen", "閉じ括弧");
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
      this.expect("rparen", "閉じ括弧");
      return { kind: "repeat", count: { kind: "num", text: "1" }, items: inner };
    }

    const w = this.expect("word", "書式項目");
    const nums = (): Expr[] => {
      if (!this.at("lparen")) return [];
      this.next();
      const list: Expr[] = [];
      do {
        list.push(this.parseExpr());
      } while (this.eat("comma"));
      this.expect("rparen", "閉じ括弧");
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
          throw new ParseError(`${w.upper} には幅が必要です`, w.line, w.col, w.file);
        }
        const kind = w.upper === "F" ? ("f" as const) : ("e" as const);
        return n[1] === undefined
          ? { kind, width: n[0] }
          : { kind, width: n[0], decimals: n[1] };
      }
      case "X": {
        const n = nums();
        if (n[0] === undefined) {
          throw new ParseError("X には幅が必要です", w.line, w.col, w.file);
        }
        return { kind: "x", width: n[0] };
      }
      case "COL":
      case "COLUMN": {
        const n = nums();
        if (n[0] === undefined) {
          throw new ParseError("COLUMN には位置が必要です", w.line, w.col, w.file);
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
          `未対応の書式項目です: ${JSON.stringify(w.text)}`,
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
      this.expect("lparen", "開き括弧");
      source = { kind: "string", expr: this.parseExpr() };
      this.expect("rparen", "閉じ括弧");
    } else if (this.eatWord("FILE")) {
      this.expect("lparen", "開き括弧");
      source = { kind: "file", name: this.expect("word", "ファイル名").text };
      this.expect("rparen", "閉じ括弧");
    }

    // SKIP は読み始める前に行を送る
    let skip: Expr | null | undefined;
    if (this.atWord("SKIP")) {
      this.next();
      if (this.eat("lparen")) {
        skip = this.parseExpr();
        this.expect("rparen", "閉じ括弧");
      } else {
        skip = null; // 回数指定なし = 1 行
      }
    }

    let format: FormatItem[] | undefined;
    const targets: Ref[] = [];
    if (this.eatWord("EDIT")) {
      this.expect("lparen", "開き括弧");
      do {
        targets.push(this.parseRef());
      } while (this.eat("comma"));
      this.expect("rparen", "閉じ括弧");
      this.expect("lparen", "開き括弧（書式リスト）");
      format = this.parseFormatList();
      this.expect("rparen", "閉じ括弧（書式リスト）");
    } else if (this.eatWord("LIST")) {
      this.expect("lparen", "開き括弧");
      do {
        targets.push(this.parseRef());
      } while (this.eat("comma"));
      this.expect("rparen", "閉じ括弧");
    } else if (skip === undefined) {
      const t = this.peek();
      throw new ParseError("EDIT または LIST が必要です", t.line, t.col, t.file);
    }
    this.expect("semi", "セミコロン");
    const stmt = { kind: "get" as const, source, targets, line };
    return {
      ...stmt,
      ...(format === undefined ? {} : { format }),
      ...(skip === undefined ? {} : { skip }),
    };
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

  private parseDo(): Stmt {
    const line = this.next().line; // DO

    // DO;
    if (this.eat("semi")) {
      return { kind: "doGroup", body: this.parseBlockUntilEnd(), line };
    }

    // DO WHILE(...) / DO UNTIL(...)
    if (this.atWord("WHILE", "UNTIL")) {
      const which = this.next().upper;
      this.expect("lparen", "開き括弧");
      const cond = this.parseExpr();
      this.expect("rparen", "閉じ括弧");
      this.expect("semi", "セミコロン");
      const body = this.parseBlockUntilEnd();
      return which === "WHILE"
        ? { kind: "doWhile", cond, body, line }
        : { kind: "doUntil", cond, body, line };
    }

    // DO var = <指定>[, <指定>...];
    // 指定は `from TO to [BY by]` または単一値。
    const varName = this.expect("word", "制御変数").text;
    const eq = this.expect("op", "=");
    if ((eq.value ?? eq.text) !== "=") {
      throw new ParseError("= が必要です", eq.line, eq.col, eq.file);
    }
    const specs: DoSpec[] = [];
    do {
      const from = this.parseExpr();
      let to: Expr | undefined;
      let by: Expr | undefined;
      for (;;) {
        if (this.eatWord("TO")) {
          to = this.parseExpr();
          continue;
        }
        if (this.eatWord("BY")) {
          by = this.parseExpr();
          continue;
        }
        break;
      }
      specs.push({
        from,
        ...(to !== undefined ? { to } : {}),
        ...(by !== undefined ? { by } : {}),
      });
    } while (this.eat("comma"));
    this.expect("semi", "セミコロン");
    const body = this.parseBlockUntilEnd();
    return { kind: "doIter", varName, specs, body, line };
  }

  /** SELECT(expr) ... WHEN(...) ... OTHERWISE ... END */
  private parseSelect(): Stmt {
    const line = this.next().line; // SELECT
    let subject: Expr | undefined;
    if (this.eat("lparen")) {
      subject = this.parseExpr();
      this.expect("rparen", "閉じ括弧");
    }
    this.expect("semi", "セミコロン");

    const whens: WhenClause[] = [];
    let otherwise: Stmt | undefined;
    for (;;) {
      if (this.at("eof")) {
        const t = this.peek();
        throw new ParseError("SELECT に END が必要です", t.line, t.col, t.file);
      }
      if (this.atWord("END") && !this.looksLikeAssignment()) {
        this.next();
        if (this.at("word")) this.next();
        this.expect("semi", "セミコロン");
        break;
      }
      if (this.atWord("WHEN") && !this.looksLikeAssignment()) {
        this.next();
        this.expect("lparen", "開き括弧");
        const values: Expr[] = [];
        do {
          values.push(this.parseExpr());
        } while (this.eat("comma"));
        this.expect("rparen", "閉じ括弧");
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
        `SELECT の中には WHEN / OTHERWISE / END のみ置けます（${JSON.stringify(t.text)}）`,
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

  private parseBegin(): Stmt {
    const line = this.next().line; // BEGIN
    this.expect("semi", "セミコロン");
    return { kind: "beginBlock", body: this.parseBlockUntilEnd(), line };
  }

  private parseGoto(): Stmt {
    const kw = this.next(); // GOTO / GO
    if (kw.upper === "GO") this.expectWord("TO");
    const label = this.expect("word", "飛び先のラベル").text;
    this.expect("semi", "セミコロン");
    return { kind: "goto", label, line: kw.line };
  }

  private parseOn(): Stmt {
    const line = this.next().line; // ON
    const cond = this.expect("word", "条件名");
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
      this.expect("semi", "セミコロン");
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
    const name = this.expect("word", "ファイル名").text;
    this.expect("rparen", "閉じ括弧");
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
        throw new ParseError("OPEN には FILE(名前) が必要です", t.line, t.col, t.file);
      }
      this.expect("lparen", "開き括弧");
      const name = this.expect("word", "ファイル名").text;
      this.expect("rparen", "閉じ括弧");

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
            this.expect("lparen", "開き括弧");
            attrs.lineSize = this.parseExpr();
            this.expect("rparen", "閉じ括弧");
            break;
          }
          case "PAGESIZE": {
            this.expect("lparen", "開き括弧");
            attrs.pageSize = this.parseExpr();
            this.expect("rparen", "閉じ括弧");
            break;
          }
          case "TITLE": {
            this.expect("lparen", "開き括弧");
            attrs.title = this.parseExpr();
            this.expect("rparen", "閉じ括弧");
            break;
          }
          default:
            throw new ParseError(
              `OPEN の属性として解釈できません: ${JSON.stringify(w.text)}`,
              w.line,
              w.col,
              w.file,
            );
        }
      }
      files.push({ name, attrs });
    } while (this.eat("comma"));
    this.expect("semi", "セミコロン");
    return { kind: "open", files, line };
  }

  private parseClose(): Stmt {
    const line = this.next().line; // CLOSE
    const files: string[] = [];
    do {
      if (!this.eatWord("FILE")) {
        const t = this.peek();
        throw new ParseError("CLOSE には FILE(名前) が必要です", t.line, t.col, t.file);
      }
      this.expect("lparen", "開き括弧");
      files.push(this.expect("word", "ファイル名").text);
      this.expect("rparen", "閉じ括弧");
    } while (this.eat("comma"));
    this.expect("semi", "セミコロン");
    return { kind: "close", files, line };
  }

  private parseCall(): Stmt {
    const line = this.next().line; // CALL
    const name = this.expect("word", "手続き名").text;
    const args: Expr[] = [];
    if (this.eat("lparen")) {
      if (!this.at("rparen")) {
        do {
          args.push(this.parseExpr());
        } while (this.eat("comma"));
      }
      this.expect("rparen", "閉じ括弧");
    }
    this.expect("semi", "セミコロン");
    return { kind: "call", name, args, line };
  }

  private parseReturn(): Stmt {
    const line = this.next().line; // RETURN
    let value: Expr | undefined;
    if (this.eat("lparen")) {
      value = this.parseExpr();
      this.expect("rparen", "閉じ括弧");
    }
    this.expect("semi", "セミコロン");
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
            `16 進定数に使えない文字があります: ${JSON.stringify(t.value ?? "")}`,
            t.line,
            t.col,
          );
        }
        if (body.length % 2 !== 0) {
          throw new ParseError(
            "16 進定数の桁数は偶数でなければなりません（1 文字 = 2 桁）",
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
        this.expect("rparen", "閉じ括弧");
        return e;
      }
      case "word":
        return this.parseRef();
      default:
        throw new ParseError(
          `式が必要です（${t.kind === "eof" ? "入力の終わり" : JSON.stringify(t.text)} が現れました）`,
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
    const name = this.expect("word", "基底変数名").text;
    const subscripts: Expr[] = [];
    if (this.eat("lparen")) {
      if (!this.at("rparen")) {
        do {
          subscripts.push(this.parseISubOrExpr());
        } while (this.eat("comma"));
      }
      this.expect("rparen", "閉じ括弧");
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
    let name = this.expect("word", "変数名").text;
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
          subscripts.push(this.parseExpr());
        } while (this.eat("comma"));
      }
      this.expect("rparen", "閉じ括弧");
    }
    const ref: Ref = { kind: "ref", name, subscripts, ...(called ? { called } : {}) };

    // ポインタ修飾 p -> x。左が位置指定、右が BASED 変数
    if (this.atOp("->")) {
      this.next();
      const target = this.parseRef();
      return { ...target, locator: ref };
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

    while (!this.at("semi") && !this.at("eof")) {
      const w = this.expect("word", `${op.toUpperCase()} の指定`);
      this.expect("lparen", "開き括弧");
      switch (w.upper) {
        case "FILE":
          file = this.expect("word", "ファイル名").text;
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
        case "KEY":
        case "KEYFROM":
          throw new ParseError(
            "索引ファイル（KEY 指定）は未実装です",
            w.line,
            w.col,
            w.file,
          );
        default:
          throw new ParseError(
            `${op.toUpperCase()} の指定として解釈できません: ${JSON.stringify(w.text)}`,
            w.line,
            w.col,
            w.file,
          );
      }
      this.expect("rparen", "閉じ括弧");
      this.eat("comma");
    }
    this.expect("semi", "セミコロン");

    if (file === undefined) {
      const t = this.peek();
      throw new ParseError(
        `${op.toUpperCase()} には FILE(名前) が必要です`,
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
    };
  }

  /** ALLOCATE x SET(p); */
  private parseAllocate(): Stmt {
    const line = this.next().line; // ALLOCATE
    const name = this.expect("word", "変数名").text;
    let set: Ref | undefined;
    if (this.eatWord("SET")) {
      this.expect("lparen", "開き括弧");
      set = this.parseRef();
      this.expect("rparen", "閉じ括弧");
    }
    this.expect("semi", "セミコロン");
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
    this.expect("semi", "セミコロン");
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
