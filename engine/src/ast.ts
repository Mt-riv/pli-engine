/** PL/I サブセットの抽象構文木。 */

/** 配列の1次元の境界。 */
export interface Bound {
  lo: number;
  hi: number;
}

/** データ属性（宣言で指定される型）。 */
export type DataAttr =
  | { type: "fixed"; base: "bin" | "dec"; p: number; q: number }
  | { type: "float"; base: "bin" | "dec"; p: number }
  | { type: "char"; length: number; varying: boolean }
  | { type: "bit"; length: number }
  /**
   * ポインタ。確保した記憶域への参照を持つ。
   * **アドレス値ではない**ので、ポインタ算術はできない（設計上の判断）。
   */
  | { type: "pointer" }
  /**
   * 型を書いていない宣言（`dcl x;`）。
   * 属性は名前の先頭文字で決まる（暗黙宣言と同じ規則）ので、
   * 名前が分かる時点まで決定を遅らせる。
   */
  | { type: "implicit" }
  /**
   * PICTURE 属性。数値編集の指定を原文のまま持つ。
   * 解析は `picture.ts` が行う（構文解析の段では文字列として扱う）。
   */
  | { type: "picture"; picture: string }
  /**
   * ファイル宣言（`dcl sysprint print;`、`dcl in file stream input;`）。
   * 宣言で分かる属性は OPEN の既定値になる。
   */
  | {
      type: "file";
      record?: boolean;
      print?: boolean;
      mode?: "input" | "output" | "update";
      /** ENVIRONMENT(F RECSIZE(80)) の内容。レコード入出力で使う。 */
      recordSize?: number;
      variableRecords?: boolean;
    }
  /**
   * 外部手続きの宣言（`DCL F ENTRY;`）。
   * この処理系は 1 ファイル完結なので実体は持てないが、
   * `%INCLUDE` で宣言群を取り込む書き方が普通なので、
   * 名前が存在することだけは覚える。
   */
  | { type: "entry"; returns?: DataAttr };

/**
 * 変数参照または関数呼び出し。
 * PL/I では `a(1)` が配列要素か関数呼び出しか構文だけでは決まらないため、
 * 構文解析では区別せず評価器が解決する。
 */
export interface Ref {
  kind: "ref";
  name: string;
  subscripts: Expr[];
  /**
   * 括弧が書かれていたか（`date()` と `date` の区別）。
   *
   * 引数が無い関数呼び出しは `subscripts` が空になるので、
   * これが無いと「未宣言のスカラ」と見分けが付かない。
   * 見分けが付かないと `date()` が暗黙宣言の 0 になり、
   * 「未知の関数です」と断れない。
   */
  called?: boolean;
  /**
   * ポインタ修飾（`p -> x` の `p`）。
   * BASED 変数をどの記憶域で見るかを指定する。
   */
  locator?: Ref;
}

export type Expr =
  | { kind: "num"; text: string }
  /**
   * iSUB。DEFINED の基底参照の中だけに現れる仮変数で、
   * 「別名側の第 dim 次元の添字」を表す。
   * isub.pli の `def (b(1sub,1sub))` は b の対角成分を指す。
   */
  | { kind: "isub"; dim: number }
  | { kind: "str"; value: string }
  | { kind: "bit"; value: string }
  | Ref
  | { kind: "unary"; op: string; operand: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr };

export interface DeclItem {
  /**
   * BASED の指定。この変数は独自の記憶域を持たず、
   * ALLOCATE で確保した記憶域をポインタ越しに見る。
   * `pointer` は既定のポインタ（`based(p)` の `p`）。
   */
  based?: { pointer?: Ref };
  /**
   * 構造体の階層レベル。`dcl 1 rec, 2 name char(10);` の 1 や 2。
   * 省略時はスカラ（レベル1相当）。
   */
  level?: number;
  names: string[];
  /**
   * 配列の次元。名前の直後の括弧で指定される（精度の括弧とは別）。
   * PL/I は下限を明示できる: (10) は 1..10、(0:9) は 0..9。
   */
  dims?: Bound[];
  attr: DataAttr;
  /** INITIAL の値。PL/I では配列初期化のためリストを取る。 */
  init?: Expr[];
  /**
   * DEFINED の基底参照。この変数は独自の記憶域を持たず、
   * 基底変数の要素への別名になる。添字に iSUB を含められる。
   */
  defined?: Ref;
  /**
   * 記憶域クラス。`"static"` なら手続きを抜けても値が残る。
   *
   * 持たせないと `dcl cnt fixed bin(15) static init(0);` が
   * 呼ぶたびに 0 へ戻り、呼び出し回数を数える定型が黙って壊れる。
   */
  storage?: "static" | "automatic";
}

/**
 * EDIT の書式項目。
 *   A      文字（幅省略時はデータ自身の長さ）
 *   F(w,d) 固定小数点、幅 w に右詰め
 *   E(w,d) 浮動小数点
 *   B(w)   ビット
 *   X(w)   空白 w 個
 *   COLUMN(n) / SKIP(n) / PAGE  制御項目
 *   (n)item 反復係数
 */
export type FormatItem =
  | { kind: "a"; width?: Expr }
  | { kind: "f"; width: Expr; decimals?: Expr }
  | { kind: "e"; width: Expr; decimals?: Expr }
  | { kind: "b"; width?: Expr }
  | { kind: "x"; width: Expr }
  | { kind: "column"; at: Expr }
  | { kind: "fskip"; count?: Expr }
  | { kind: "fpage" }
  | { kind: "repeat"; count: Expr; items: FormatItem[] };

export type PutOption =
  | { kind: "skip"; count?: Expr }
  | { kind: "list"; items: Expr[] }
  | { kind: "edit"; items: Expr[]; format: FormatItem[] }
  | { kind: "page" }
  | { kind: "line"; at: Expr };

/** GET / PUT の対象。STRING は文字列、FILE は名前付きファイル。 */
export type IoTarget =
  | { kind: "string"; expr: Expr }
  | { kind: "file"; name: string };

/** DO 反復の1指定。`do i = 1 to 3, 7 to 9;` は2つ持つ。 */
export interface DoSpec {
  from: Expr;
  to?: Expr;
  by?: Expr;
  /** 単一値の指定（`do i = 1, 5, 10;`）では to/by を持たない。 */
}

/** SELECT の WHEN 節。 */
export interface WhenClause {
  /** 比較する値（SELECT(expr) 形式）または条件（SELECT; 形式）。 */
  values: Expr[];
  body: Stmt;
}

export type Stmt =
  | {
      kind: "procedure";
      name: string;
      params: string[];
      isMain: boolean;
      recursive: boolean;
      returns?: DataAttr;
      body: Stmt[];
      line: number;
    }
  | { kind: "declare"; items: DeclItem[]; line: number }
  | { kind: "assign"; target: Ref; value: Expr; line: number }
  | { kind: "put"; options: PutOption[]; file?: string; line: number }
  | { kind: "if"; cond: Expr; then: Stmt; else?: Stmt; line: number }
  | { kind: "doGroup"; body: Stmt[]; labels?: string[]; line: number }
  | { kind: "doWhile"; cond: Expr; body: Stmt[]; labels?: string[]; line: number }
  | { kind: "doUntil"; cond: Expr; body: Stmt[]; labels?: string[]; line: number }
  | {
      kind: "doIter";
      varName: string;
      /** 複数指定（`do i = 1 to 3, 7 to 9;`）に対応するため配列で持つ。 */
      specs: DoSpec[];
      body: Stmt[];
      /**
       * この DO に付いた文ラベル（大文字）。`LEAVE outer;` が
       * どのループを抜けるかの判定に要る。持たせないと、ラベルを
       * 書いても必ず内側のループが受け止めてしまう。
       */
      labels?: string[];
      line: number;
    }
  | { kind: "beginBlock"; body: Stmt[]; line: number }
  | {
      /** SELECT(expr) ... WHEN(v,...) ... OTHERWISE ... END */
      kind: "select";
      subject?: Expr;
      whens: WhenClause[];
      otherwise?: Stmt;
      line: number;
    }
  | { kind: "leave"; label?: string; line: number }
  | { kind: "iterate"; label?: string; line: number }
  | { kind: "goto"; label: string; line: number }
  | {
      /** ON <条件> <文> — 条件発生時に実行する単位を設定する。 */
      kind: "on";
      condition: string;
      /** ENDFILE(SYSIN) のようにファイルを取る条件での対象ファイル。 */
      conditionFile?: string;
      /**
       * ON 単位。`ON ... SYSTEM;` は本体を持たず、既定動作へ戻す
       * （それまでに置いた ON 単位の解除）。空の本体を置くと
       * 「何もしない ON 単位」になり、復帰して実行を続けてしまう。
       */
      body?: Stmt;
      line: number;
    }
  | { kind: "signal"; condition: string; conditionFile?: string; line: number }
  /** OPEN FILE(f) <属性>, FILE(g) ...; */
  | { kind: "open"; files: { name: string; attrs: OpenAttrs }[]; line: number }
  | { kind: "close"; files: string[]; line: number }
  /**
   * レコード入出力。
   *   READ FILE(f) INTO(rec);      1 レコード読んで変数へ
   *   READ FILE(f) SET(p);         読んで BASED 変数の記憶域に置く
   *   WRITE FILE(f) FROM(rec);     1 レコード書く
   *   REWRITE FILE(f) FROM(rec);   直前に読んだレコードを置き換える
   */
  | {
      kind: "record";
      op: "read" | "write" | "rewrite";
      file: string;
      into?: Ref;
      from?: Ref;
      set?: Ref;
      line: number;
    }
  /** ALLOCATE x SET(p); — BASED 変数の記憶域を確保する。 */
  | { kind: "allocate"; name: string; set?: Ref; line: number }
  /** FREE p -> x; — 確保した記憶域を解放する。 */
  | { kind: "free"; refs: Ref[]; line: number }
  /** 文ラベル。GOTO の飛び先になる。 */
  | { kind: "label"; name: string; line: number }
  | {
      /**
       * GET STRING(src) EDIT(targets)(format) / GET FILE(f) LIST(targets)
       * `source` 省略時は SYSIN から読む。
       */
      kind: "get";
      source: IoTarget;
      targets: Ref[];
      format?: FormatItem[];
      /** GET の SKIP 指定（読み始める前に行を送る）。 */
      skip?: Expr | null;
      line: number;
    }
  | { kind: "call"; name: string; args: Expr[]; line: number }
  | { kind: "return"; value?: Expr; line: number }
  | { kind: "null"; line: number };

/** OPEN で指定できる属性。宣言より優先される。 */
export interface OpenAttrs {
  record?: boolean;
  print?: boolean;
  mode?: "input" | "output" | "update";
  lineSize?: Expr;
  pageSize?: Expr;
  title?: Expr;
}

export interface Program {
  kind: "program";
  body: Stmt[];
}
