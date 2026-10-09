/**
 * PL/I サブセットの評価器。
 *
 * 対応範囲: PROCEDURE（入れ子・引数・再帰）/ DECLARE / 代入 / 式 /
 * PUT LIST・SKIP / IF / DO の3形態 / CALL / RETURN / 組込関数。
 */

import type {
  Bound,
  DataAttr,
  DeclItem,
  Expr,
  FormatItem,
  Program,
  Ref,
  Stmt,
} from "./ast.js";
import { qualifyDeclareItems } from "./declare.js";
import type { PliHost } from "./host.js";
import { makePointer, type PointerVal, type Storage } from "./value.js";
import {
  editPicture,
  parsePicture,
  uneditPicture,
  PictureSizeError,
  type PictureSpec,
} from "./picture.js";
import { ListWriter, fixedBinWidth, fixedDecWidth } from "./format.js";
import {
  FileTable,
  SYSIN,
  UndefinedFileError,
  InputCursor,
  type FileAttributes,
  type StreamFile,
} from "./streamio.js";
import { parse } from "./parser.js";
import {
  FixedOverflow,
  MAX_BIN,
  MAX_DEC,
  ZeroDivide,
  add,
  assignTo,
  binDigitsToDec,
  compare,
  div,
  fixedFromLiteral,
  makeBit,
  makeChar,
  makeFixed,
  mul,
  neg,
  pow,
  render,
  sub,
  toCharString,
  type Base,
  type FixedVal,
  type Value,
} from "./value.js";

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `${line}行: ${message}`);
    this.name = "RuntimeError";
  }
}

export class Unsupported extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `${line}行: ${message}（未実装）`);
    this.name = "Unsupported";
  }
}

/** RETURN を実装するための内部例外。 */
class ReturnSignal {
  constructor(readonly value?: Value) {}
}

/** LEAVE を実装するための内部例外。 */
class LeaveSignal {
  constructor(readonly label?: string) {}
}

/** ITERATE を実装するための内部例外。 */
class IterateSignal {
  constructor(readonly label?: string) {}
}

/** GOTO を実装するための内部例外。飛び先のラベルを運ぶ。 */
class GotoSignal {
  constructor(readonly label: string) {}
}

/**
 * PL/I の条件。ON 単位の設定対象になる。
 * ERROR は再開可能でないため、ON 単位から正常復帰するとプログラムが終了する
 * （バナーを stderr に出して終了する処理系もある）。
 */
const RESUMABLE = new Set(["ZERODIVIDE", "FIXEDOVERFLOW", "OVERFLOW", "UNDERFLOW", "CONVERSION"]);

/**
 * 条件により実行を終える内部例外。
 * 元の条件名を保つので、FIXEDOVERFLOW が ERROR へ連鎖しても
 * 報告は元の名前のままになる。
 */
export class FinishSignal extends Error {
  constructor(
    readonly condition: string,
    readonly line?: number,
    /** 入出力の条件なら対象のファイル名。診断に添えて原因を分かりやすくする。 */
    readonly file?: string,
  ) {
    super(
      file === undefined
        ? condition
        : `${condition}（ファイル ${file}）。ON ${condition}(${file}) を置くか、` +
            "ファイル名と TITLE を確認してください",
    );
    this.name = "FinishSignal";
  }
}

interface Variable {
  attr: DataAttr;
  dims?: Bound[];
  /** 配列なら要素の並び、スカラなら長さ1。 */
  cells: Value[];
  /**
   * DEFINED の基底参照。設定されていると独自の記憶域を持たず、
   * 読み書きが基底変数の要素へ転送される。
   */
  defined?: Ref;
  /**
   * 引数として束縛された変数か。
   * PL/I では proc(n) の本体にある `dcl n fixed bin(31);` は
   * 引数の属性宣言であり、新しい変数の宣言ではない。
   * 新変数として初期化すると引数の値が失われる。
   */
  isParam?: boolean;
  /**
   * BASED 宣言。独自の記憶域を持たず、ポインタの先を見る。
   * `pointer` は既定のポインタ（`based(p)` の `p`）。
   * `group` は確保の単位（構造体なら親の名前）。
   */
  based?: { pointer?: Ref; group: string };
}

interface ProcDef {
  stmt: Extract<Stmt, { kind: "procedure" }>;
}

class Scope {
  readonly vars = new Map<string, Variable>();
  readonly procs = new Map<string, ProcDef>();
  /** ON 単位。条件名から実行する文への対応。 */
  readonly onUnits = new Map<string, Stmt>();
  constructor(readonly parent?: Scope) {}

  lookupOn(condition: string): Stmt | undefined {
    return this.onUnits.get(condition) ?? this.parent?.lookupOn(condition);
  }

  lookupVar(name: string): Variable | undefined {
    return this.vars.get(name) ?? this.parent?.lookupVar(name);
  }

  lookupProc(name: string): ProcDef | undefined {
    return this.procs.get(name) ?? this.parent?.lookupProc(name);
  }
}

/**
 * 既定のデータ属性（暗黙宣言）。
 * PL/I では未宣言の識別子に、先頭文字で決まる既定属性が付く。
 * I〜N で始まれば FIXED BINARY(15,0)、それ以外は FLOAT DECIMAL(6)。
 * この規則は PL/I の規定。
 */
function implicitAttr(name: string): DataAttr {
  const c = name[0]?.toUpperCase() ?? "X";
  if (c >= "I" && c <= "N") return { type: "fixed", base: "bin", p: 15, q: 0 };
  return { type: "float", base: "dec", p: 6 };
}

function zeroOf(attr: DataAttr): Value {
  switch (attr.type) {
    case "pointer":
      return makePointer();
    case "picture": {
      const spec = parsePicture(attr.picture);
      return { t: "fixed", base: "dec", p: spec.p, q: spec.q, v: 0n, pic: spec };
    }
    // どちらも記憶域を持たない宣言。ここへ来るのは呼び出し側の誤り
    case "file":
    case "entry":
      return makeChar("", 0, true);
    case "fixed":
      return makeFixed(attr.base, attr.p, attr.q, 0n);
    case "float":
      return { t: "float", base: attr.base, p: attr.p, v: 0 };
    case "char":
      return makeChar("", attr.length, attr.varying);
    case "bit":
      return makeBit("", attr.length);
  }
}

function elementCount(dims?: Bound[]): number {
  if (!dims) return 1;
  return dims.reduce((n, d) => n * (d.hi - d.lo + 1), 1);
}

export interface RunResult {
  stdout: string;
  /** 異常終了した場合の説明。 */
  error?: string;
}

export interface RunOptions {
  /** 主手続きの引数（コマンドライン引数相当）。 */
  args?: string[];
  /**
   * 外界への差し込み口。`%INCLUDE` とファイル入出力に使う。
   * 渡さなければ取り込みもファイル入出力も「できない」として扱う。
   */
  host?: PliHost;
  /** 標準入力（SYSIN）。`host.stdin` より優先する。 */
  stdin?: string;
  /**
   * 標準出力の上限（バイト数相当の文字数）。
   * 超えたら実行を打ち切る。ブラウザを固めないために必要。
   */
  maxOutputBytes?: number;
  /**
   * 実行する文の数の上限。
   * 無限ループを止めるために必要（ブラウザには別プロセスが無い）。
   */
  maxSteps?: number;
}

/** 出力上限に達したことを表す内部例外。 */
export class OutputLimitExceeded extends Error {
  constructor() {
    super("出力が上限に達しました");
    this.name = "OutputLimitExceeded";
  }
}

/** 文数の上限に達したことを表す内部例外。 */
export class StepLimitExceeded extends Error {
  constructor(limit: number) {
    super(`実行した文の数が上限(${limit})に達しました。無限ループの可能性があります`);
    this.name = "StepLimitExceeded";
  }
}

/** データを消費する書式項目。 */
type DataFormat = Extract<FormatItem, { kind: "a" | "f" | "e" | "b" }>;

/** 反復係数を展開した後の書式項目。 */
type FlatFormat = Exclude<FormatItem, { kind: "repeat" }>;

export class Interpreter {
  /**
   * ファイル表。SYSPRINT（標準出力）もここに入る。
   * 出力先がファイルごとに分かれるので、行・桁の状態も
   * ファイル単位で持つ必要がある。
   */
  private readonly files: FileTable;

  private steps = 0;
  /** 条件の処理中か。ON 単位からの再入を防ぐ。 */
  private inCondition = false;
  /** ENTRY で宣言された外部手続きの名前。呼ばれたときの説明に使う。 */
  private readonly externalEntries = new Set<string>();
  /**
   * BASED 宣言の雛形。確保の単位（構造体なら親の名前）ごとに
   * 葉の並びを覚えておき、ALLOCATE のときに記憶域を作る。
   */
  private readonly basedTemplates = new Map<
    string,
    { name: string; attr: DataAttr; dims?: Bound[] }[]
  >();
  /**
   * いま実行中のスコープ。
   * ON 単位は実行時に設定されるので、条件を起こすときは
   * 宣言上の位置ではなく実行中のスコープから探す必要がある。
   */
  private currentScope: Scope = new Scope();
  private readonly maxSteps: number | undefined;
  private readonly maxOutputBytes: number | undefined;

  constructor(private readonly opts: RunOptions = {}) {
    this.files = new FileTable(opts.host, opts.stdin ?? opts.host?.stdin ?? "");
    this.maxSteps = opts.maxSteps;
    this.maxOutputBytes = opts.maxOutputBytes;
  }

  /**
   * 実行した文（またはループの周回）を1つ数える。
   * 本体が空のループ（do while('1'b); end;）では exec が呼ばれないため、
   * ループ側でも数えないと無限ループを止められない。
   */
  private step(): void {
    if (this.maxSteps !== undefined && ++this.steps > this.maxSteps) {
      throw new StepLimitExceeded(this.maxSteps);
    }
  }

  /** 標準出力（SYSPRINT）の書き出し口。 */
  private get out(): ListWriter {
    return this.files.sysprint().writer!;
  }

  /** 出力が上限を超えていないか確かめる。全ファイルの合計で見る。 */
  private checkOutput(): void {
    if (this.maxOutputBytes !== undefined && this.files.totalWritten() > this.maxOutputBytes) {
      throw new OutputLimitExceeded();
    }
  }

  /** ソースを解析して実行する。例外は呼び出し側で分類する。 */
  runSource(source: string): void {
    const host = this.opts.host;
    this.run(parse(source, host === undefined ? {} : { host }));
  }

  run(program: Program): void {
    const global = new Scope();
    // まず全ての手続きを登録する（前方参照を許すため）
    for (const s of program.body) {
      if (s.kind === "procedure") global.procs.set(s.name.toUpperCase(), { stmt: s });
    }
    const main =
      program.body.find((s) => s.kind === "procedure" && s.isMain) ??
      program.body.find((s) => s.kind === "procedure");
    if (!main || main.kind !== "procedure") {
      throw new RuntimeError("OPTIONS(MAIN) を持つ手続きがありません");
    }
    // 主手続きが引数を取る場合はコマンドライン引数を渡す。
    // numwrd.pli の `NUMWRD: proc(parm) options(main)` がこれに依存する。
    const args: Value[] = main.params.map((_, i) =>
      makeChar(this.opts.args?.[i] ?? "", undefined, true),
    );
    this.callProcedure({ stmt: main }, args, global);
  }

  text(): string {
    this.out.finish();
    return this.out.text();
  }

  /** 実行の後始末。開いたままのファイルを閉じてホストへ書き戻す。 */
  finishFiles(): void {
    this.files.closeAll();
  }

  // ---- 手続き ----

  private callProcedure(def: ProcDef, args: Value[], outer: Scope): Value | undefined {
    const scope = new Scope(outer);
    // 入れ子の手続きを登録
    for (const s of def.stmt.body) {
      if (s.kind === "procedure") scope.procs.set(s.name.toUpperCase(), { stmt: s });
    }
    // 引数を束縛する（値渡し）
    def.stmt.params.forEach((p, i) => {
      const v = args[i];
      if (v === undefined) {
        throw new RuntimeError(`引数 ${p} が渡されていません`, def.stmt.line);
      }
      scope.vars.set(p.toUpperCase(), {
        attr: attrOfValue(v),
        cells: [v],
        isParam: true,
      });
    });

    try {
      this.execBlock(def.stmt.body, scope);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    return undefined;
  }

  /**
   * 文列を実行する。GOTO が発生したら同じ列の中のラベルを探して飛ぶ。
   * 見つからなければ上位へ伝播させる（非局所 GOTO）。
   */
  private execBlock(stmts: Stmt[], scope: Scope): void {
    let i = 0;
    while (i < stmts.length) {
      try {
        this.exec(stmts[i]!, scope);
        i++;
      } catch (e) {
        if (e instanceof GotoSignal) {
          const at = stmts.findIndex(
            (x) => x.kind === "label" && x.name.toUpperCase() === e.label,
          );
          if (at < 0) throw e;
          i = at + 1;
          continue;
        }
        throw e;
      }
    }
  }

  private execBlockScoped(stmts: Stmt[], scope: Scope): void {
    for (const s of stmts) {
      if (s.kind === "procedure") scope.procs.set(s.name.toUpperCase(), { stmt: s });
    }
    this.execBlock(stmts, scope);
  }

  /** SELECT の実行。 */
  private select(s: Extract<Stmt, { kind: "select" }>, scope: Scope): void {
    if (s.subject !== undefined) {
      const subject = this.eval(s.subject, scope, s.line);
      for (const w of s.whens) {
        for (const v of w.values) {
          if (this.compareValues(subject, this.eval(v, scope, s.line), s.line) === 0) {
            this.exec(w.body, scope);
            return;
          }
        }
      }
    } else {
      // SELECT; 形式は WHEN の式を条件として評価する
      for (const w of s.whens) {
        for (const v of w.values) {
          if (this.truth(this.eval(v, scope, s.line), s.line)) {
            this.exec(w.body, scope);
            return;
          }
        }
      }
    }
    if (s.otherwise) this.exec(s.otherwise, scope);
  }

  /**
   * 入出力の条件（ENDFILE / UNDEFINEDFILE / ENDPAGE）を起こす。
   *
   * 計算条件と違い、**ON 単位から正常に復帰したら実行を続ける**のが
   * PL/I の規定。`on endfile(sysin) done = '1'b;` と書いてループの
   * 判定に使う書き方がこれに依存する。
   * ON 単位が無ければ ERROR へ連鎖して終わる。
   */
  private raiseIo(condition: string, scope: Scope, line: number, file: string): void {
    const unit =
      scope.lookupOn(`${condition}(${file.toUpperCase()})`) ?? scope.lookupOn(condition);
    if (unit === undefined) this.raise(condition, scope, line, file);
    const prev = this.inCondition;
    this.inCondition = true;
    try {
      this.exec(unit, scope);
    } finally {
      this.inCondition = prev;
    }
  }

  /**
   * 条件を発生させる。
   *
   * PL/I の規則に従い、まずその条件の ON 単位を探して実行し、
   * 無ければ（あるいは実行後に）暗黙動作として ERROR へ連鎖させる。
   * FIXEDOVERFLOW は ERROR へ連鎖する。
   *
   * 計算条件の ON 単位から正常復帰しても**実行は再開しない**。
   * 規定どおりに演算を再試行すると、条件を直さない限り無限ループになる。
   * 止まらないプログラムを作るより、ERROR へ進めて終える方が役に立つ。
   */
  private raise(
    condition: string,
    scope: Scope,
    line: number,
    file?: string,
  ): never {
    // ON 単位の中でさらに条件が起きたときに再入しないようにする
    if (this.inCondition) throw new FinishSignal(condition, line, file);
    this.inCondition = true;
    try {
      const chain = condition === "ERROR" ? ["ERROR"] : [condition, "ERROR"];
      for (const c of chain) {
        // ファイルを取る条件は、そのファイル用の ON 単位を先に探す
        const unit =
          (file !== undefined ? scope.lookupOn(`${c}(${file.toUpperCase()})`) : undefined) ??
          scope.lookupOn(c);
        if (!unit) continue;
        try {
          this.exec(unit, scope);
        } catch (e) {
          // ON 単位の中で終了が起きた場合は、元の条件名で終える
          if (e instanceof FinishSignal) break;
          throw e;
        }
        break;
      }
    } finally {
      this.inCondition = false;
    }
    throw new FinishSignal(condition, line, file);
  }

  // ---- 文 ----

  private exec(s: Stmt, scope: Scope): void {
    // 無限ループ対策。ブラウザには別プロセスが無いので
    // 実行した文の数で打ち切る。
    this.step();
    this.currentScope = scope;
    switch (s.kind) {
      case "procedure":
        // 定義のみ。呼ばれたときに実行する
        return;
      case "null":
        return;
      case "declare":
        this.declareAll(s.items, scope, s.line);
        return;
      case "assign": {
        // 配列全体への代入（c = a + b など）は要素ごとに行う
        const lhs = scope.lookupVar(s.target.name.toUpperCase());
        if (lhs?.dims && s.target.subscripts.length === 0) {
          const values =
            s.value.kind === "binary"
              ? this.tryArrayExpr(s.value, scope, s.line)
              : undefined;
          if (values) {
            values.forEach((v, i) => {
              if (i < lhs.cells.length) {
                lhs.cells[i] = this.coerce(v, lhs.attr, s.line);
              }
            });
            return;
          }
          // スカラを配列全体へ配る
          const scalar = this.eval(s.value, scope, s.line);
          lhs.cells = lhs.cells.map(() => this.coerce(scalar, lhs.attr, s.line));
          return;
        }
        this.assign(s.target, this.eval(s.value, scope, s.line), scope, s.line);
        return;
      }
      case "put":
        this.put(s, scope);
        this.checkOutput();
        return;
      case "if": {
        if (this.truth(this.eval(s.cond, scope, s.line), s.line)) this.exec(s.then, scope);
        else if (s.else) this.exec(s.else, scope);
        return;
      }
      case "doGroup":
        this.execBlock(s.body, scope);
        return;
      case "doWhile":
        while (this.truth(this.eval(s.cond, scope, s.line), s.line)) {
          this.step();
          try {
            this.execBlock(s.body, scope);
          } catch (e) {
            if (e instanceof LeaveSignal) break;
            if (!(e instanceof IterateSignal)) throw e;
          }
        }
        return;
      case "doUntil":
        do {
          this.step();
          try {
            this.execBlock(s.body, scope);
          } catch (e) {
            if (e instanceof LeaveSignal) break;
            if (!(e instanceof IterateSignal)) throw e;
          }
        } while (!this.truth(this.eval(s.cond, scope, s.line), s.line));
        return;
      case "doIter":
        this.doIter(s, scope);
        return;
      case "get":
        this.get(s, scope);
        return;
      case "call": {
        const def = scope.lookupProc(s.name.toUpperCase());
        if (!def) throw new RuntimeError(`手続き ${s.name} が見つかりません`, s.line);
        const args = s.args.map((a) => this.eval(a, scope, s.line));
        this.callProcedure(def, args, scope);
        return;
      }
      case "beginBlock": {
        // BEGIN ブロックは独自の名前の有効範囲を持つ
        this.execBlockScoped(s.body, new Scope(scope));
        return;
      }
      case "select":
        this.select(s, scope);
        return;
      case "leave":
        throw new LeaveSignal(s.label);
      case "iterate":
        throw new IterateSignal(s.label);
      case "goto":
        throw new GotoSignal(s.label.toUpperCase());
      case "label":
        // ラベルそのものは何もしない（GOTO の飛び先として使われる）
        return;
      case "on":
        // ファイルを取る条件は「条件(ファイル名)」を鍵にする
        scope.onUnits.set(
          s.conditionFile === undefined
            ? s.condition
            : `${s.condition}(${s.conditionFile.toUpperCase()})`,
          s.body,
        );
        return;
      case "open": {
        for (const f of s.files) {
          const attrs: FileAttributes = {};
          const num = (e: Expr) =>
            Number(render(asFixed(this.eval(e, scope, s.line), s.line)));
          if (f.attrs.mode !== undefined) attrs.mode = f.attrs.mode;
          if (f.attrs.print !== undefined) attrs.print = f.attrs.print;
          if (f.attrs.record !== undefined) attrs.record = f.attrs.record;
          if (f.attrs.lineSize !== undefined) attrs.lineSize = num(f.attrs.lineSize);
          if (f.attrs.pageSize !== undefined) attrs.pageSize = num(f.attrs.pageSize);
          if (f.attrs.title !== undefined) {
            attrs.title = this.asText(this.eval(f.attrs.title, scope, s.line)).trim();
          }
          if (this.files.isOpen(f.name)) {
            throw new RuntimeError(`${f.name} は既に開かれています`, s.line);
          }
          this.openForUse(f.name, attrs, s.line);
        }
        return;
      }
      case "record":
        this.recordIo(s, scope);
        return;
      case "allocate": {
        const group = s.name.toUpperCase();
        const tmpl = this.basedTemplates.get(group);
        if (tmpl === undefined) {
          throw new RuntimeError(`${s.name} は BASED で宣言されていません`, s.line);
        }
        const storage: Storage = { cells: new Map(), freed: false, group };
        for (const leaf of tmpl) {
          const n = elementCount(leaf.dims);
          const cells: Value[] = [];
          for (let k = 0; k < n; k++) cells.push(zeroOf(leaf.attr));
          storage.cells.set(leaf.name, cells);
        }
        // SET(p) が無ければ宣言の based(p) に入れる
        const target =
          s.set ?? scope.lookupVar(tmpl[0]!.name)?.based?.pointer;
        if (target === undefined) {
          throw new RuntimeError(
            `ALLOCATE ${s.name} には SET(ポインタ) が必要です（宣言に based(p) がありません）`,
            s.line,
          );
        }
        this.assign(target, makePointer(storage), scope, s.line);
        return;
      }
      case "free": {
        for (const ref of s.refs) {
          const v = scope.lookupVar(ref.name.toUpperCase());
          if (!v?.based) {
            throw new RuntimeError(`${ref.name} は BASED で宣言されていません`, s.line);
          }
          const locator = ref.locator ?? v.based.pointer;
          if (locator === undefined) {
            throw new RuntimeError(`FREE にはポインタの指定が必要です`, s.line);
          }
          const pv = this.eval(locator, scope, s.line);
          if (pv.t !== "pointer" || pv.target === undefined) {
            throw new RuntimeError("NULL のポインタは解放できません", s.line);
          }
          if (pv.target.freed) {
            throw new RuntimeError("解放済みの記憶域をもう一度解放しています", s.line);
          }
          // 解放の印だけ付ける。これで解放後の参照を必ず検出できる
          pv.target.freed = true;
          this.assign(locator, makePointer(), scope, s.line);
        }
        return;
      }
      case "close":
        for (const name of s.files) {
          if (!this.files.close(name)) {
            // 開いていないファイルを閉じても何もしない
          }
        }
        return;
      case "signal":
        this.raise(
          s.condition,
          scope,
          s.line,
          ...(s.conditionFile === undefined ? [] : [s.conditionFile]),
        );
      case "return":
        throw new ReturnSignal(
          s.value === undefined ? undefined : this.eval(s.value, scope, s.line),
        );
    }
  }

  /**
   * 宣言の並びを処理する。
   * レベル番号が付いていれば構造体として扱い、葉の要素を
   * 修飾名（REC.ADDR.CITY）で登録する。
   * 中間レベル（名前だけで型を持たない）は記憶域を持たない。
   */
  private declareAll(items: DeclItem[], scope: Scope, line: number): void {
    for (const item of qualifyDeclareItems(items)) this.declare(item, scope, line);
  }

  private declare(item: DeclItem, scope: Scope, line: number): void {
    // ファイル宣言。OPEN の既定になるので表に覚えさせる
    if (item.attr.type === "file") {
      const a = item.attr;
      for (const name of item.names) {
        this.files.declare(name, {
          ...(a.print === undefined ? {} : { print: a.print }),
          ...(a.record === undefined ? {} : { record: a.record }),
          ...(a.mode === undefined ? {} : { mode: a.mode }),
          ...(a.recordSize === undefined ? {} : { recordSize: a.recordSize }),
          ...(a.variableRecords === undefined
            ? {}
            : { variableRecords: a.variableRecords }),
        });
      }
      return;
    }
    // 外部手続きの宣言。実体は別ファイルにあるので呼べないが、
    // 呼ばれたときに「外部手続き」と言えるように名前だけ覚える。
    if (item.attr.type === "entry") {
      for (const name of item.names) this.externalEntries.add(name.toUpperCase());
      return;
    }
    const n = elementCount(item.dims);
    for (const name of item.names) {
      const key = name.toUpperCase();
      // 引数名の DECLARE は属性の宣言であって新変数ではない。
      // 渡された値を宣言された型へ変換して保持する。
      const existing = scope.vars.get(key);
      if (existing?.isParam) {
        existing.attr = item.attr;
        existing.cells = existing.cells.map((c) => this.coerce(c, item.attr, line));
        if (item.dims) existing.dims = item.dims;
        continue;
      }
      // BASED は記憶域を持たない。ALLOCATE で確保してポインタ越しに見る
      if (item.based) {
        const group = key.split(".")[0]!;
        const v: Variable = {
          attr: item.attr,
          cells: [],
          based: {
            group,
            ...(item.based.pointer === undefined ? {} : { pointer: item.based.pointer }),
          },
        };
        if (item.dims) v.dims = item.dims;
        scope.vars.set(key, v);
        const tmpl = this.basedTemplates.get(group) ?? [];
        tmpl.push({ name: key, attr: item.attr, ...(item.dims ? { dims: item.dims } : {}) });
        this.basedTemplates.set(group, tmpl);
        continue;
      }
      const cells: Value[] = [];
      for (let k = 0; k < n; k++) cells.push(zeroOf(item.attr));
      if (item.init) {
        item.init.forEach((e, i) => {
          if (i < cells.length) {
            cells[i] = this.coerce(this.eval(e, scope, line), item.attr, line);
          }
        });
      }
      const v: Variable = { attr: item.attr, cells };
      if (item.dims) v.dims = item.dims;
      // DEFINED は基底変数への別名。独自の記憶域は使わない。
      if (item.defined) v.defined = item.defined;
      scope.vars.set(key, v);
    }
  }

  /**
   * DO 反復。複数指定（`do i = 1 to 3, 7 to 9;`）に対応する。
   * LEAVE / ITERATE は内部例外で制御する。
   */
  private doIter(s: Extract<Stmt, { kind: "doIter" }>, scope: Scope): void {
    const key = s.varName.toUpperCase();
    const target: Ref = { kind: "ref", name: s.varName, subscripts: [] };

    outer: for (const spec of s.specs) {
      let cur = this.eval(spec.from, scope, s.line);
      // TO が無い指定は単一値（`do i = 1, 5, 10;`）なので1回だけ実行する
      if (spec.to === undefined) {
        this.assign(target, cur, scope, s.line);
        try {
          this.execBlock(s.body, scope);
        } catch (e) {
          if (e instanceof LeaveSignal) break outer;
          if (e instanceof IterateSignal) continue;
          throw e;
        }
        continue;
      }

      const limit = this.eval(spec.to, scope, s.line);
      const step =
        spec.by === undefined
          ? fixedFromLiteral("1")
          : asFixed(this.eval(spec.by, scope, s.line), s.line);
      const down = step.v < 0n;

      for (;;) {
        this.step();
        this.assign(target, cur, scope, s.line);
        const c = compare(
          asFixed(this.readVar(key, scope, s.line), s.line),
          asFixed(limit, s.line),
        );
        if (down ? c < 0 : c > 0) break;
        try {
          this.execBlock(s.body, scope);
        } catch (e) {
          if (e instanceof LeaveSignal) break outer;
          if (!(e instanceof IterateSignal)) throw e;
        }
        cur = add(asFixed(this.readVar(key, scope, s.line), s.line), step);
      }
    }
  }

  private readVar(key: string, scope: Scope, line: number): Value {
    const v = scope.lookupVar(key);
    if (!v || v.cells[0] === undefined) {
      throw new RuntimeError(`変数 ${key} が見つかりません`, line);
    }
    return v.cells[0];
  }

  private put(s: Extract<Stmt, { kind: "put" }>, scope: Scope): void {
    const w = this.writerFor(s.file, s.line);
    for (const opt of s.options) {
      switch (opt.kind) {
        case "skip": {
          const n = opt.count === undefined
            ? 1
            : Number(render(asFixed(this.eval(opt.count, scope, s.line), s.line)));
          w.skip(n);
          break;
        }
        case "page":
          w.page();
          break;
        case "line": {
          // LINE(n): その行まで送る。既に過ぎていれば改ページする
          const at = Number(render(asFixed(this.eval(opt.at, scope, s.line), s.line)));
          if (w.lineNumber() > at) w.page();
          while (w.lineNumber() < at) w.skip();
          break;
        }
        case "list":
          for (const v of this.dataList(opt.items, scope, s.line)) this.emit(v, w);
          break;
        case "edit":
          this.putEdit(
            this.dataList(opt.items, scope, s.line),
            opt.format,
            scope,
            s.line,
            w,
          );
          break;
      }
    }
  }

  /**
   * データリストを値の並びにする。
   * PL/I では添字なしの配列参照は**全要素に展開**される。
   * isub.pli の `put skip edit('b: ',b)(a,(9)f(4))` がこれに依存する。
   */
  private dataList(items: Expr[], scope: Scope, line: number): Value[] {
    const out: Value[] = [];
    for (const e of items) {
      if (e.kind === "ref" && e.subscripts.length === 0) {
        const v = scope.lookupVar(e.name.toUpperCase());
        if (v?.dims) {
          // DEFINED の別名なら各要素を基底から読む
          if (v.defined) {
            for (const sub of enumerateSubscripts(v.dims)) {
              const alias = this.resolveDefined(
                v,
                { kind: "ref", name: e.name, subscripts: sub.map(numExpr) },
                scope,
                line,
              );
              if (!alias) break;
              const cell = alias.target.cells[alias.index];
              if (cell !== undefined) out.push(cell);
            }
            continue;
          }
          out.push(...v.cells);
          continue;
        }
      }
      out.push(this.eval(e, scope, line));
    }
    return out;
  }

  /**
   * 書式項目を反復係数を展開して平坦にする。
   * データが尽きるまで巡回させるので、必要な個数だけ取り出せるようにする。
   */
  private flattenFormat(
    items: FormatItem[],
    scope: Scope,
    line: number,
  ): FlatFormat[] {
    const out: FlatFormat[] = [];
    for (const f of items) {
      if (f.kind === "repeat") {
        const n = Number(render(asFixed(this.eval(f.count, scope, line), line)));
        for (let k = 0; k < n; k++) {
          out.push(...this.flattenFormat(f.items, scope, line));
        }
        continue;
      }
      out.push(f);
    }
    return out;
  }

  /** データを1つ消費する書式項目（制御項目は消費しない）。 */
  private static consumesData(f: FormatItem): f is DataFormat {
    return f.kind === "a" || f.kind === "f" || f.kind === "e" || f.kind === "b";
  }

  /**
   * PUT EDIT。データリストと書式リストを対応させる。
   * 書式が尽きたら先頭から巡回し、データが尽きたらそこで止める。
   */
  private putEdit(
    values: Value[],
    format: FormatItem[],
    scope: Scope,
    line: number,
    w: ListWriter,
  ): void {
    const fmt = this.flattenFormat(format, scope, line);
    if (fmt.length === 0) return;
    const num = (e: Expr) => Number(render(asFixed(this.eval(e, scope, line), line)));

    let vi = 0;
    let fi = 0;
    // データを配り終えるまで書式リストを巡回する。
    // ただし巡回しても消費が進まない（制御項目だけ）場合は止める。
    while (vi < values.length) {
      const f = fmt[fi % fmt.length]!;
      fi++;
      if (Interpreter.consumesData(f)) {
        const v = values[vi++]!;
        this.emitEdit(v, f, scope, line, w);
      } else {
        this.applyControl(f, num, w);
      }
      if (fi > fmt.length * (values.length + 1) + fmt.length) break;
    }
    // データを使い切った後も、残りの書式のうち制御項目だけは適用する
    // （PL/I は次のデータ項目を要求する書式に当たった時点で止める）
    for (let k = fi % fmt.length; k < fmt.length; k++) {
      const f = fmt[k]!;
      if (Interpreter.consumesData(f)) break;
      this.applyControl(f, num, w);
    }
  }

  private applyControl(
    f: Exclude<FlatFormat, DataFormat>,
    num: (e: Expr) => number,
    w: ListWriter,
  ): void {
    switch (f.kind) {
      case "x":
        w.editX(num(f.width));
        return;
      case "column":
        w.column(num(f.at));
        return;
      case "fskip":
        w.skip(f.count === undefined ? 1 : num(f.count));
        return;
      case "fpage":
        w.page();
        return;
    }
  }

  private emitEdit(
    v: Value,
    f: DataFormat,
    scope: Scope,
    line: number,
    w: ListWriter,
  ): void {
    const num = (e: Expr) => Number(render(asFixed(this.eval(e, scope, line), line)));
    switch (f.kind) {
      case "a":
        // 文字データはそのまま出す。'b: ' の末尾空白も意味を持つため削らない。
        w.editChar(
          this.asText(v),
          f.width === undefined ? undefined : num(f.width),
        );
        return;
      case "b":
        w.editBit(
          v.t === "bit" ? v.v : this.asText(v),
          f.width === undefined ? undefined : num(f.width),
        );
        return;
      case "f": {
        const width = num(f.width);
        const d = f.decimals === undefined ? undefined : num(f.decimals);
        const fx = asFixed(v, line);
        const scaled = d === undefined ? fx : assignTo(fx, fx.base, fx.p, d);
        w.editNumber(render(scaled), width);
        return;
      }
      case "e": {
        const width = num(f.width);
        const p = f.decimals === undefined ? 6 : num(f.decimals) + 1;
        const n = Number(render(asFixed(v, line)));
        w.editNumber(render({ t: "float", base: "dec", p, v: n }), width);
        return;
      }
    }
  }

  /**
   * 書き出し口を得る。ファイル指定が無ければ SYSPRINT。
   * 開いていないファイルへの出力は暗黙 OPEN（PL/I の規定どおり）。
   */
  private writerFor(name: string | undefined, line: number): ListWriter {
    if (name === undefined) return this.out;
    const f = this.openForUse(name, { mode: "output" }, line);
    if (!f.writer) {
      throw new RuntimeError(`${name} は入力用に開かれています`, line);
    }
    return f.writer;
  }

  /** 読み取り口を得る。開いていなければ暗黙 OPEN。 */
  private cursorFor(name: string, line: number): InputCursor {
    const f = this.openForUse(name, { mode: "input" }, line);
    if (!f.cursor) {
      throw new RuntimeError(`${name} は出力用に開かれています`, line);
    }
    return f.cursor;
  }

  /**
   * 使うために開く。UNDEFINEDFILE は条件として上げる。
   * PL/I は宣言の無いファイル名に既定属性を割り当てて続行するので、
   * こちらも宣言が無くても開ける。
   */
  private openForUse(name: string, want: FileAttributes, line: number): StreamFile {
    const existing = this.files.get(name);
    if (existing) return existing;
    try {
      return this.files.openFile(name, want);
    } catch (e) {
      if (e instanceof UndefinedFileError) {
        this.raiseIo("UNDEFINEDFILE", this.currentScope, line, name);
        // ON 単位から戻っても開けていないので、ここで止めるしかない
        throw new RuntimeError(`ファイル ${name} を開けません`, line);
      }
      throw e;
    }
  }

  /**
   * GET。ファイルまたは文字列から値を読み取って変数へ代入する。
   * EDIT 指定なら書式の幅で切り出し、LIST 指定なら空白区切りで読む。
   */
  private get(s: Extract<Stmt, { kind: "get" }>, scope: Scope): void {
    // 読み取り元。STRING はその場限りのカーソル、FILE は開いたままのカーソル
    const cursor =
      s.source.kind === "string"
        ? new InputCursor(this.asText(this.eval(s.source.expr, scope, s.line)))
        : this.cursorFor(s.source.name, s.line);
    const fileName = s.source.kind === "file" ? s.source.name : undefined;

    if (s.skip !== undefined) {
      const n =
        s.skip === null
          ? 1
          : Number(render(asFixed(this.eval(s.skip, scope, s.line), s.line)));
      cursor.skipLine(n);
    }

    // 代入先を展開する（添字なしの配列は全要素）
    const slots: { ref: Ref; index: number }[] = [];
    for (const ref of s.targets) {
      const v = scope.lookupVar(ref.name.toUpperCase());
      if (v?.dims && ref.subscripts.length === 0) {
        // 添字なしの配列は全要素が対象。DEFINED なら添字付き参照に展開して
        // 代入時に基底変数へ転送させる。
        if (v.defined) {
          for (const sub of enumerateSubscripts(v.dims)) {
            slots.push({
              ref: { kind: "ref", name: ref.name, subscripts: sub.map(numExpr) },
              index: -1,
            });
          }
        } else {
          v.cells.forEach((_, i) => slots.push({ ref, index: i }));
        }
      } else {
        slots.push({ ref, index: -1 });
      }
    }
    if (slots.length === 0) return;

    const texts: string[] = [];
    /** 代入を済ませたあとに ENDFILE を上げるか。 */
    let endfileAfter = false;
    if (s.format) {
      const fmt = this.flattenFormat(s.format, scope, s.line);
      const num = (e: Expr) =>
        Number(render(asFixed(this.eval(e, scope, s.line), s.line)));
      let fi = 0;
      while (texts.length < slots.length && fi < fmt.length * (slots.length + 1)) {
        const f = fmt[fi % fmt.length]!;
        fi++;
        if (!Interpreter.consumesData(f)) {
          // 制御項目。入力でも位置を動かす
          if (f.kind === "x") cursor.advance(num(f.width));
          else if (f.kind === "column") cursor.columnTo(num(f.at));
          else if (f.kind === "fskip") cursor.skipLine(f.count === undefined ? 1 : num(f.count));
          continue;
        }
        if (cursor.atEnd() && fileName !== undefined) {
          this.raiseIo("ENDFILE", scope, s.line, fileName);
          return; // ON 単位から戻ったら、この GET は読まずに終わる
        }
        let width: number;
        if (f.kind === "a" || f.kind === "b") {
          // 幅を省略した A はこの処理系では 1 行ぶんとして扱う
          width = f.width === undefined ? 0 : num(f.width);
          if (width === 0) {
            texts.push(cursor.restOfLine());
            continue;
          }
        } else {
          width = num(f.width);
        }
        texts.push(cursor.take(width));
      }
    } else {
      for (let i = 0; i < slots.length; i++) {
        const item = cursor.nextItem();
        if (item === undefined) {
          // ファイルの終わり。ON 単位があれば実行して、この GET は打ち切る
          if (fileName !== undefined) {
            this.raiseIo("ENDFILE", scope, s.line, fileName);
            return;
          }
          break;
        }
        texts.push(item);
        // 「最後の項目を読んだ GET」で ENDFILE を上げる。
        // 代入は済ませてから上げるので、ここで印を付けておく
        if (fileName !== undefined && cursor.atLastItem()) {
          endfileAfter = true;
        }
      }
    }

    slots.forEach((slot, i) => {
      const text = texts[i];
      if (text === undefined) return;
      const v = scope.lookupVar(slot.ref.name.toUpperCase());
      if (!v) throw new RuntimeError(`変数 ${slot.ref.name} が見つかりません`, s.line);
      const parsed = this.parseInput(text, v.attr, s.line);
      if (slot.index >= 0) v.cells[slot.index] = parsed;
      else this.assign(slot.ref, parsed, scope, s.line);
    });

    if (endfileAfter && fileName !== undefined) {
      this.raiseIo("ENDFILE", scope, s.line, fileName);
    }
  }

  /** 入力テキストを宣言された型の値にする。 */
  private parseInput(text: string, attr: DataAttr, line: number): Value {
    if (attr.type === "picture") {
      const spec = parsePicture(attr.picture);
      return this.coerce(fixedFromLiteral(uneditPicture(text, spec)), attr, line);
    }
    if (attr.type === "char" || attr.type === "bit") {
      return this.coerce(makeChar(text, undefined, true), attr, line);
    }
    const t = text.trim();
    if (t === "") return zeroOf(attr);
    if (!/^[+-]?\d*\.?\d+$/.test(t)) {
      throw new RuntimeError(`数値として読めません: ${JSON.stringify(text)}`, line);
    }
    return this.coerce(fixedFromLiteral(t), attr, line);
  }

  private emit(v: Value, w: ListWriter): void {
    switch (v.t) {
      case "char":
        w.putChar(v.v);
        return;
      case "bit":
        w.putBit(v.v);
        return;
      case "float":
        // FLOAT DEC(6) は ' 3.50000E+0000' でフィールド幅14。
        // 仮数(1 + 1 + (p-1)) + 指数(E±dddd = 6) + 符号1 = p + 8。
        w.putNumber(render(v), floatWidth(v.p));
        return;
      case "fixed":
        if (v.pic) {
          // PICTURE の値は文字データとして出る（幅はピクチャの文字数）
          w.putChar(editPicture(v.pic as PictureSpec, v));
          return;
        }
        w.putNumber(
          render(v),
          v.base === "bin" ? fixedBinWidth(v.p) : fixedDecWidth(v.p),
        );
        return;
    }
  }

  // ---- 代入 ----

  /**
   * レコード入出力。
   *
   * 仮想ファイルは文字列なので、**文字として表現できる項目**だけを扱う。
   * 本来のレコードは記憶域そのもの（packed decimal など）が入るが、
   * それを再現するには記憶域のバイト表現が要る。
   * 扱えない項目は黙って壊さず、誤りとして知らせる。
   */
  private recordIo(s: Extract<Stmt, { kind: "record" }>, scope: Scope): void {
    const mode = s.op === "read" ? "input" : s.op === "write" ? "output" : "update";
    const file = this.openForUse(s.file, { record: true, mode }, s.line);
    if (!file.attrs.record) {
      throw new RuntimeError(
        `${s.file} は STREAM です。READ / WRITE には RECORD の宣言が要ります`,
        s.line,
      );
    }

    if (s.op === "read") {
      const rec = file.readRecord();
      if (rec === undefined) {
        this.raiseIo("ENDFILE", scope, s.line, s.file);
        return;
      }
      if (s.set) {
        // SET(p): 読んだレコードを指す記憶域を作る。
        // どの BASED 宣言で見るかは利用者が決めるので、1 つだけ持たせる
        const storage: Storage = {
          cells: new Map([["", [makeChar(rec, rec.length, true)]]]),
          freed: false,
          group: `${s.file} のレコード`,
        };
        this.assign(s.set, makePointer(storage), scope, s.line);
        return;
      }
      if (!s.into) {
        throw new RuntimeError("READ には INTO か SET が必要です", s.line);
      }
      this.scatterRecord(rec, s.into, scope, s.line);
      return;
    }

    if (!s.from) {
      throw new RuntimeError(`${s.op.toUpperCase()} には FROM が必要です`, s.line);
    }
    const text = this.gatherRecord(s.from, scope, s.line);
    if (s.op === "write") {
      file.writeRecord(text);
      return;
    }
    if (!file.rewriteRecord(text)) {
      throw new RuntimeError("REWRITE の前に READ が必要です", s.line);
    }
  }

  /** 構造体の葉を宣言順に取り出す。レコードの項目の並びになる。 */
  private leavesOf(name: string, scope: Scope): { key: string; v: Variable }[] {
    const prefix = `${name.toUpperCase()}.`;
    const out: { key: string; v: Variable }[] = [];
    for (let sc: Scope | undefined = scope; sc; sc = sc.parent) {
      for (const [key, v] of sc.vars) {
        if (key.startsWith(prefix)) out.push({ key, v });
      }
      if (out.length > 0) break;
    }
    return out;
  }

  /** 項目が占める文字数。文字として表現できない型は誤りにする。 */
  private recordWidth(v: Variable, key: string, line: number): number {
    const attr = v.attr;
    if (attr.type === "char") return attr.length;
    if (attr.type === "picture") return parsePicture(attr.picture).width;
    throw new RuntimeError(
      `${key} は RECORD 入出力で扱えません（文字か PICTURE の項目にしてください）`,
      line,
    );
  }

  /** レコードの内容を変数（または構造体の葉）へ配る。 */
  private scatterRecord(rec: string, target: Ref, scope: Scope, line: number): void {
    const leaves = this.leavesOf(target.name, scope);
    if (leaves.length === 0) {
      // スカラ（ふつうは char）へそのまま入れる
      this.assign(target, makeChar(rec, rec.length, true), scope, line);
      return;
    }
    let pos = 0;
    for (const { key, v } of leaves) {
      const w = this.recordWidth(v, key, line);
      const piece = rec.slice(pos, pos + w).padEnd(w);
      pos += w;
      v.cells[0] = this.coerce(makeChar(piece, piece.length, true), v.attr, line);
    }
  }

  /** 変数（または構造体の葉）からレコードの内容を組み立てる。 */
  private gatherRecord(source: Ref, scope: Scope, line: number): string {
    const leaves = this.leavesOf(source.name, scope);
    if (leaves.length === 0) {
      return this.asText(this.evalRef(source, scope, line));
    }
    let text = "";
    for (const { key, v } of leaves) {
      const w = this.recordWidth(v, key, line);
      const cell = v.cells[0];
      text += (cell === undefined ? "" : this.asText(cell)).padEnd(w).slice(0, w);
    }
    return text;
  }

  /**
   * BASED 変数が見るべきセルの並びを返す。
   *
   * ポインタは `p -> x` の修飾か、宣言の `based(p)` から取る。
   * 解放済みや NULL のポインタをたどったら**必ず止める**。
   * PL/I の規定では未定義動作（落ちるとも限らない）だが、
   * 黙って嘘の値を返すより誤りとして知らせる方がよい。
   */
  private basedCells(
    v: Variable,
    ref: Ref,
    scope: Scope,
    line: number,
  ): Value[] | undefined {
    if (!v.based) return undefined;
    const locator = ref.locator ?? v.based.pointer;
    if (locator === undefined) {
      throw new RuntimeError(
        `${ref.name} は BASED です。p -> ${ref.name} の形か、宣言で based(p) を指定してください`,
        line,
      );
    }
    const pv = this.eval(locator, scope, line);
    if (pv.t !== "pointer") {
      throw new RuntimeError(`${locator.name} はポインタではありません`, line);
    }
    const storage = pv.target;
    if (storage === undefined) {
      throw new RuntimeError(`NULL のポインタをたどりました（${ref.name}）`, line);
    }
    if (storage.freed) {
      throw new RuntimeError(`解放済みの記憶域をたどりました（${ref.name}）`, line);
    }
    const key = ref.name.toUpperCase();
    const cells = storage.cells.get(key);
    if (cells) return cells;
    // ADDR で取ったポインタを別の BASED 宣言で見る場合。
    // 記憶域が 1 つしか持っていなければ、それを指しているとみなす
    if (storage.cells.size === 1) return [...storage.cells.values()][0]!;
    throw new RuntimeError(
      `${ref.name} はこの記憶域にありません（確保したのは ${storage.group}）`,
      line,
    );
  }

  private assign(target: Ref, value: Value, scope: Scope, line: number): void {
    // SUBSTR 疑似変数: substr(s, i, n) = '...' は s の一部を置き換える
    if (target.name.toUpperCase() === "SUBSTR" && target.subscripts.length >= 2) {
      this.assignSubstr(target, value, scope, line);
      return;
    }
    const key = target.name.toUpperCase();
    let v = scope.lookupVar(key);
    if (!v) {
      // 暗黙宣言
      const attr = implicitAttr(target.name);
      v = { attr, cells: [zeroOf(attr)] };
      scope.vars.set(key, v);
    }
    const alias = this.resolveDefined(v, target, scope, line);
    if (alias) {
      alias.target.cells[alias.index] = this.coerce(value, alias.target.attr, line);
      return;
    }
    const based = this.basedCells(v, target, scope, line);
    if (based) {
      based[this.indexOf(v, target, scope, line)] = this.coerce(value, v.attr, line);
      return;
    }
    const idx = this.indexOf(v, target, scope, line);
    v.cells[idx] = this.coerce(value, v.attr, line);
  }

  /**
   * DEFINED の別名を基底変数の実体へ解決する。
   * 基底参照の添字に含まれる iSUB は、別名側の添字で置き換える。
   *   dcl d(3) def (b(1sub,1sub));  のとき d(2) は b(2,2) を指す。
   * 別名でなければ undefined を返す。
   */
  private resolveDefined(
    v: Variable,
    ref: Ref,
    scope: Scope,
    line: number,
  ): { target: Variable; index: number } | undefined {
    if (!v.defined) return undefined;

    // 別名側の添字を求める（スカラなら空）
    const aliasSubs = ref.subscripts.map((e) =>
      Number(render(asFixed(this.eval(e, scope, line), line))),
    );

    const base = scope.lookupVar(v.defined.name.toUpperCase());
    if (!base) {
      throw new RuntimeError(
        `DEFINED の基底変数 ${v.defined.name} が見つかりません`,
        line,
      );
    }

    // 基底参照の添字を評価する。iSUB は別名側の添字に置き換える。
    const baseSubs = v.defined.subscripts.map((e) => {
      if (e.kind === "isub") {
        const idx = aliasSubs[e.dim - 1];
        if (idx === undefined) {
          throw new RuntimeError(
            `iSUB ${e.dim} に対応する添字がありません`,
            line,
          );
        }
        return idx;
      }
      return Number(render(asFixed(this.eval(e, scope, line), line)));
    });

    return {
      target: base,
      index: this.flatIndex(base, baseSubs, line),
    };
  }

  /** 添字の並びを記憶域の位置に変換する。 */
  private flatIndex(v: Variable, subs: number[], line: number): number {
    if (!v.dims || subs.length === 0) return 0;
    let idx = 0;
    v.dims.forEach((d, i) => {
      const n = subs[i];
      if (n === undefined) throw new RuntimeError("添字の数が合いません", line);
      if (n < d.lo || n > d.hi) {
        throw new RuntimeError(`添字が範囲外です: ${n}`, line);
      }
      idx = idx * (d.hi - d.lo + 1) + (n - d.lo);
    });
    return idx;
  }

  /** SUBSTR 疑似変数への代入。対象の一部を置き換える。 */
  private assignSubstr(
    target: Ref,
    value: Value,
    scope: Scope,
    line: number,
  ): void {
    const dest = target.subscripts[0];
    if (dest === undefined || dest.kind !== "ref") {
      throw new RuntimeError("SUBSTR 疑似変数の第1引数は変数でなければなりません", line);
    }
    const num = (e: Expr) => Number(render(asFixed(this.eval(e, scope, line), line)));
    const start = num(target.subscripts[1]!);
    const cur = this.asText(this.evalRef(dest, scope, line));
    const len =
      target.subscripts[2] === undefined
        ? cur.length - start + 1
        : num(target.subscripts[2]);
    const repl = this.asText(value).padEnd(len).slice(0, len);
    const next = cur.slice(0, start - 1) + repl + cur.slice(start - 1 + len);
    this.assign(dest, makeChar(next, undefined, true), scope, line);
  }

  private indexOf(v: Variable, ref: Ref, scope: Scope, line: number): number {
    if (!v.dims || ref.subscripts.length === 0) return 0;
    return this.flatIndex(
      v,
      ref.subscripts.map((e) =>
        Number(render(asFixed(this.eval(e, scope, line), line))),
      ),
      line,
    );
  }

  /** 宣言された型へ合わせる。 */
  private coerce(value: Value, attr: DataAttr, line: number): Value {
    try {
      switch (attr.type) {
        case "pointer": {
          if (value.t !== "pointer") {
            throw new RuntimeError("ポインタにはポインタしか代入できません", line);
          }
          return value;
        }
        case "picture": {
          // 内部では 10 進固定小数点。表示のときだけ編集する
          const spec = parsePicture(attr.picture);
          let f;
          try {
            f = assignTo(this.toFixed(value, line), "dec", spec.p, spec.q);
          } catch (e) {
            // ピクチャの桁に入らない代入は FIXEDOVERFLOW ではなく SIZE
            if (e instanceof FixedOverflow) throw new PictureSizeError(spec.source);
            throw e;
          }
          return { ...f, pic: spec };
        }
        case "fixed": {
          const f = this.toFixed(value, line);
          return assignTo(f, attr.base, attr.p, attr.q);
        }
        case "float": {
          const n = Number(render(this.toFixed(value, line)));
          return { t: "float", base: attr.base, p: attr.p, v: n };
        }
        case "char": {
          // PICTURE の値を文字にすると編集した形になる（PL/I の規定）
          const s = value.t === "char" ? value.v
            : value.t === "bit" ? value.v
            : value.t === "fixed"
              ? value.pic
                ? editPicture(value.pic as PictureSpec, value)
                : toCharString(value)
            : render(value);
          return makeChar(s, attr.length, attr.varying);
        }
        case "bit": {
          const s = value.t === "bit" ? value.v : value.t === "char" ? value.v : "";
          return makeBit(s, attr.length);
        }
        case "file":
        case "entry":
          // どちらも値を持たない。到達しないが網羅のために置く。
          return makeChar("", 0, true);
      }
    } catch (e) {
      if (e instanceof FixedOverflow) this.raise("FIXEDOVERFLOW", this.currentScope, line);
      // ピクチャの桁に収まらない代入は SIZE 条件
      if (e instanceof PictureSizeError) this.raise("SIZE", this.currentScope, line);
      throw e;
    }
  }

  private toFixed(v: Value, line: number): FixedVal {
    if (v.t === "pointer") {
      throw new RuntimeError("ポインタは数値として扱えません", line);
    }
    if (v.t === "fixed") return v;
    if (v.t === "float") return fixedFromLiteral(String(v.v));
    if (v.t === "bit") return makeFixed("bin", Math.max(1, v.v.length), 0, BigInt(parseInt(v.v || "0", 2)));
    const s = v.v.trim();
    if (!/^[+-]?\d*\.?\d+$/.test(s)) {
      throw new RuntimeError(`数値に変換できません: ${JSON.stringify(v.v)}`, line);
    }
    return fixedFromLiteral(s);
  }

  // ---- 式 ----

  private eval(e: Expr, scope: Scope, line: number): Value {
    switch (e.kind) {
      case "num":
        return fixedFromLiteral(e.text);
      case "isub":
        // iSUB は DEFINED の解決時に実際の添字へ置き換えられる。
        // 通常の式評価で現れたら使い方が誤っている。
        throw new RuntimeError(
          "iSUB は DEFINED の基底参照の中でのみ使えます",
          line,
        );
      case "str":
        return makeChar(e.value, e.value.length, true);
      case "bit":
        return makeBit(e.value);
      case "ref":
        return this.evalRef(e, scope, line);
      case "unary": {
        const v = this.eval(e.operand, scope, line);
        if (e.op === "-") return neg(asFixed(v, line));
        if (e.op === "+") return v;
        // NOT: ビット反転
        const b = v.t === "bit" ? v.v : this.truth(v, line) ? "1" : "0";
        return makeBit(
          [...b].map((c) => (c === "0" ? "1" : "0")).join(""),
          b.length,
        );
      }
      case "binary":
        return this.evalBinary(e, scope, line);
    }
  }

  /**
   * 配列式。A+S / S+A / A+A を要素ごとに計算する（1.4.0 以降の機能）。
   * 配列が絡む場合だけ特別扱いし、結果を値の並びで返す。
   */
  private tryArrayExpr(
    e: Extract<Expr, { kind: "binary" }>,
    scope: Scope,
    line: number,
  ): Value[] | undefined {
    const arrayOf = (x: Expr): Value[] | undefined => {
      if (x.kind !== "ref" || x.subscripts.length > 0) return undefined;
      const v = scope.lookupVar(x.name.toUpperCase());
      if (!v?.dims) return undefined;
      return this.dataList([x], scope, line);
    };
    const la = arrayOf(e.left);
    const ra = arrayOf(e.right);
    if (!la && !ra) return undefined;
    const n = la?.length ?? ra!.length;
    if (la && ra && la.length !== ra.length) {
      throw new RuntimeError("配列式の要素数が一致しません", line);
    }
    const out: Value[] = [];
    for (let i = 0; i < n; i++) {
      const l = la ? la[i]! : this.eval(e.left, scope, line);
      const r = ra ? ra[i]! : this.eval(e.right, scope, line);
      out.push(this.applyBinary(e.op, l, r, line));
    }
    return out;
  }

  private evalBinary(
    e: Extract<Expr, { kind: "binary" }>,
    scope: Scope,
    line: number,
  ): Value {
    const arr = this.tryArrayExpr(e, scope, line);
    if (arr) {
      // 単独の値として使われた場合は先頭要素を返す。
      // 代入文では assign 側が配列として扱う。
      const first = arr[0];
      if (first === undefined) throw new RuntimeError("空の配列式です", line);
      return first;
    }
    const a = this.eval(e.left, scope, line);
    const b = this.eval(e.right, scope, line);
    return this.applyBinary(e.op, a, b, line);
  }

  private applyBinary(op: string, a: Value, b: Value, line: number): Value {
    const e = { op } as { op: string };
    void e;

    // 連結は文字列として扱う（数値は暗黙変換される）
    if (op === "||") {
      return makeChar(this.asText(a) + this.asText(b), undefined, true);
    }

    // 論理演算
    if (op === "&" || op === "|") {
      const x = this.truth(a, line);
      const y = this.truth(b, line);
      return makeBit((op === "&" ? x && y : x || y) ? "1" : "0", 1);
    }

    // 比較
    if (["=", "¬=", "<", "<=", ">", ">="].includes(op)) {
      const c = this.compareValues(a, b, line);
      const r =
        op === "=" ? c === 0
        : op === "¬=" ? c !== 0
        : op === "<" ? c < 0
        : op === "<=" ? c <= 0
        : op === ">" ? c > 0
        : c >= 0;
      return makeBit(r ? "1" : "0", 1);
    }

    // PL/I では FLOAT が FIXED より優位。どちらかが FLOAT なら結果も FLOAT。
    if (a.t === "float" || b.t === "float") {
      return floatArith(op, a, b, line);
    }

    const x = asFixed(a, line);
    const y = asFixed(b, line);
    try {
      switch (op) {
        case "+": return add(x, y);
        case "-": return sub(x, y);
        case "*": return mul(x, y);
        case "/": return div(x, y);
        case "**": return pow(x, y);
        default:
          throw new Unsupported(`演算子 ${op}`, line);
      }
    } catch (err) {
      if (err instanceof FixedOverflow) this.raise("FIXEDOVERFLOW", this.currentScope, line);
      if (err instanceof ZeroDivide) this.raise("ZERODIVIDE", this.currentScope, line);
      throw err;
    }
  }

  private compareValues(a: Value, b: Value, line: number): number {
    if (a.t === "char" || b.t === "char") {
      const x = this.asText(a);
      const y = this.asText(b);
      // PL/I は短い方を空白で埋め、照合順序（文字コード順）で比べる。
      // localeCompare はロケール依存で 'Z' > 'a' になりうるので使えない。
      const n = Math.max(x.length, y.length);
      const px = x.padEnd(n);
      const py = y.padEnd(n);
      for (let i = 0; i < n; i++) {
        const cx = px.charCodeAt(i);
        const cy = py.charCodeAt(i);
        if (cx !== cy) return cx < cy ? -1 : 1;
      }
      return 0;
    }
    if (a.t === "pointer" || b.t === "pointer") {
      // ポインタは等しいかどうかだけを見る（順序は無い）
      if (a.t !== "pointer" || b.t !== "pointer") {
        throw new RuntimeError("ポインタと他の型は比較できません", line);
      }
      return a.target === b.target ? 0 : 1;
    }
    if (a.t === "bit" && b.t === "bit") {
      return a.v === b.v ? 0 : a.v < b.v ? -1 : 1;
    }
    return compare(asFixed(a, line), asFixed(b, line));
  }

  private asText(v: Value): string {
    switch (v.t) {
      case "pointer": return v.target === undefined ? "NULL" : "POINTER";
      case "char": return v.v;
      case "bit": return v.v;
      case "fixed":
        // PICTURE 付きの値は編集した形が文字表現になる
        return v.pic ? editPicture(v.pic as PictureSpec, v) : toCharString(v);
      case "float": return render(v);
    }
  }

  private truth(v: Value, line: number): boolean {
    if (v.t === "bit") return v.v.includes("1");
    if (v.t === "fixed") return v.v !== 0n;
    if (v.t === "float") return v.v !== 0;
    throw new RuntimeError("条件として評価できません", line);
  }

  /** 変数参照・配列要素・組込関数・ユーザー手続きの呼び出し。 */
  private evalRef(ref: Ref, scope: Scope, line: number): Value {
    const key = ref.name.toUpperCase();

    const v = scope.lookupVar(key);
    if (v) {
      const alias = this.resolveDefined(v, ref, scope, line);
      if (alias) {
        const cell = alias.target.cells[alias.index];
        if (cell === undefined) {
          throw new RuntimeError(`${ref.name} は未初期化です`, line);
        }
        return cell;
      }
      const based = this.basedCells(v, ref, scope, line);
      const cells = based ?? v.cells;
      const idx = this.indexOf(v, ref, scope, line);
      const cell = cells[idx];
      if (cell === undefined) throw new RuntimeError(`${ref.name} は未初期化です`, line);
      return cell;
    }

    const args = ref.subscripts.map((a) => this.eval(a, scope, line));

    const proc = scope.lookupProc(key);
    if (proc) {
      const r = this.callProcedure(proc, args, scope);
      if (r === undefined) {
        throw new RuntimeError(`手続き ${ref.name} は値を返しません`, line);
      }
      return r;
    }

    const builtin = this.builtin(key, args, line, scope, ref.subscripts);
    if (builtin !== undefined) return builtin;

    if (ref.subscripts.length > 0) {
      if (this.externalEntries.has(ref.name.toUpperCase())) {
        throw new RuntimeError(
          `${ref.name} は ENTRY で宣言された外部手続きです。` +
            "この処理系は 1 ファイル完結なので呼び出せません",
          line,
        );
      }
      throw new RuntimeError(`${ref.name} は未知の関数です`, line);
    }
    // 未宣言のスカラ参照は暗黙宣言の初期値
    return zeroOf(implicitAttr(ref.name));
  }

  /** 組込関数。 */
  private builtin(
    name: string,
    args: Value[],
    line: number,
    scope: Scope,
    argRefs?: Expr[],
  ): Value | undefined {
    const fx = (i: number) => asFixed(args[i] ?? missing(name, i, line), line);
    const tx = (i: number) => this.asText(args[i] ?? missing(name, i, line));
    const int = (i: number) => Number(render(fx(i)));

    switch (name) {
      case "NULL":
        return makePointer();
      case "ADDR": {
        // 変数の記憶域を指すポインタ。セルの並びを共有するので、
        // ポインタ越しの書き込みが元の変数に反映される
        const ref = argRefs?.[0];
        if (ref === undefined || ref.kind !== "ref") {
          throw new RuntimeError("ADDR の引数は変数でなければなりません", line);
        }
        const v = scope.lookupVar(ref.name.toUpperCase());
        if (!v) throw new RuntimeError(`変数 ${ref.name} が見つかりません`, line);
        const based = this.basedCells(v, ref, scope, line);
        const cells = based ?? v.cells;
        return makePointer({
          cells: new Map([[ref.name.toUpperCase(), cells]]),
          freed: false,
          group: ref.name.toUpperCase(),
        });
      }
      case "MOD": {
        // 除算の精度規則（結果が FIXED(N, N-...) になる）を使うと
        // MOD(17,5) が 0 になってしまう。整数剰余として直接計算する。
        // PL/I の MOD は第2引数と同じ符号の結果を返す。
        const a = fx(0);
        const b = fx(1);
        if (b.v === 0n) throw new RuntimeError("ZERODIVIDE", line);
        return modFixed(a, b);
      }
      case "ABS": {
        const a = fx(0);
        return a.v < 0n ? neg(a) : a;
      }
      case "MAX":
      case "MIN": {
        let best = fx(0);
        for (let i = 1; i < args.length; i++) {
          const c = compare(fx(i), best);
          if (name === "MAX" ? c > 0 : c < 0) best = fx(i);
        }
        return best;
      }
      case "LENGTH":
        // 出力幅 9 なので FIXED BIN(15,0)
        return makeFixed("bin", 15, 0, BigInt(tx(0).length));
      case "SUBSTR": {
        const s = tx(0);
        const start = int(1);
        const len = args.length > 2 ? int(2) : s.length - start + 1;
        return makeChar(s.slice(start - 1, start - 1 + len), undefined, true);
      }
      case "INDEX": {
        const hay = tx(0);
        const needle = tx(1);
        // LENGTH と同じく FIXED BIN(15,0)
        return makeFixed("bin", 15, 0, BigInt(hay.indexOf(needle) + 1));
      }
      case "TRUNC": {
        const a = fx(0);
        return assignTo(a, a.base, a.p, 0);
      }
      case "CEIL":
      case "FLOOR": {
        // PL/I: 結果は FIXED(min(N, max(p-q,1)+1), 0)。
        // 1 を足し引きして実装すると加算の精度規則で p が広がり、
        // 出力幅（ceil(2.1) で 5）と合わなくなる。
        const a = fx(0);
        const N = a.base === "bin" ? MAX_BIN : MAX_DEC;
        const p = Math.min(N, Math.max(a.p - a.q, 1) + 1);
        const truncated = assignTo(a, a.base, a.p, 0);
        let v = truncated.v;
        const isUp = name === "CEIL";
        if (compare(truncated, a) !== 0) {
          // 0 方向へ切り捨てられているので、方向に応じて 1 だけ動かす
          if (isUp && a.v > 0n) v += 1n;
          if (!isUp && a.v < 0n) v -= 1n;
        }
        return makeFixed(a.base, p, 0, v);
      }
      case "ROUND": {
        // ROUND(x, n) は小数第 n 位に丸める
        const a = fx(0);
        const n = int(1);
        const half = fixedFromLiteral(
          `0.${"0".repeat(Math.max(0, n))}5`,
        );
        const shifted = a.v < 0n ? sub(a, half) : add(a, half);
        return assignTo(shifted, a.base, a.p, n);
      }
      case "SIGN": {
        // 出力幅 9 なので FIXED BIN(15,0)
        const a = fx(0);
        const r = a.v > 0n ? 1n : a.v < 0n ? -1n : 0n;
        return makeFixed("bin", 15, 0, r);
      }
      case "DIVIDE": {
        // DIVIDE(a, b, p, q) は結果の精度を明示する除算
        const a = fx(0);
        const b = fx(1);
        if (b.v === 0n) throw new RuntimeError("ZERODIVIDE", line);
        const p = int(2);
        const q = args.length > 3 ? int(3) : 0;
        const quotient = div(a, b);
        return assignTo(quotient, "dec", p, q);
      }
      case "TRANSLATE": {
        // TRANSLATE(s, to, from) は from の各文字を to の対応文字に置き換える
        const src = tx(0);
        const to = tx(1);
        const from = args.length > 2 ? tx(2) : "";
        const mapped = [...src]
          .map((c) => {
            const i = from.indexOf(c);
            return i >= 0 ? (to[i] ?? " ") : c;
          })
          .join("");
        return makeChar(mapped, undefined, true);
      }
      case "VERIFY": {
        // VERIFY(s, set) は set に含まれない最初の文字の位置（全て含まれれば 0）
        const src = tx(0);
        const set = tx(1);
        for (let i = 0; i < src.length; i++) {
          if (!set.includes(src[i]!)) return makeFixed("bin", 15, 0, BigInt(i + 1));
        }
        return makeFixed("bin", 15, 0, 0n);
      }
      case "LBOUND":
      case "HBOUND":
      case "DIM": {
        // 出力幅 14 なので FIXED BIN(31,0)
        const target = argRefs?.[0];
        if (target?.kind !== "ref") {
          throw new RuntimeError(`${name} の第1引数は配列でなければなりません`, line);
        }
        const v = scope.lookupVar(target.name.toUpperCase());
        if (!v?.dims) {
          throw new RuntimeError(`${target.name} は配列ではありません`, line);
        }
        const dim = args.length > 1 ? int(1) : 1;
        const b = v.dims[dim - 1];
        if (!b) throw new RuntimeError(`次元 ${dim} がありません`, line);
        const r =
          name === "LBOUND" ? b.lo : name === "HBOUND" ? b.hi : b.hi - b.lo + 1;
        return makeFixed("bin", 31, 0, BigInt(r));
      }
      case "REPEAT": {
        const s = tx(0);
        return makeChar(s.repeat(int(1) + 1), undefined, true);
      }
      default:
        return undefined;
    }
  }
}

/**
 * PL/I の MOD。第2引数と同じ符号の剰余を返す。
 * 両辺の尺度を揃えて BigInt の剰余で計算する。
 *
 * 結果の精度は PL/I の規定どおり第2引数に基づく
 *   p = min(N, p2 - q2 + max(q1,q2)), q = max(q1,q2)
 * （剰余は必ず第2引数より小さいため）。
 * mod(17,5) はフィールド幅 4（= p+3 で p=1）で出力され、
 * 第2引数 5 の精度 DEC(1,0) に由来することが確認できる。
 */
function modFixed(a: FixedVal, b: FixedVal): FixedVal {
  const base = a.base === b.base ? a.base : "bin";
  const q = Math.max(a.q, b.q);
  const N = base === "bin" ? MAX_BIN : MAX_DEC;
  const p = Math.min(N, Math.max(1, b.p - b.q + q));
  const r = base === "bin" ? 2n : 10n;
  const scale = (x: FixedVal): bigint => {
    if (x.q === q) return x.v;
    let m = 1n;
    for (let k = 0; k < q - x.q; k++) m *= r;
    return x.v * m;
  };
  const va = scale(a);
  const vb = scale(b);
  let rem = va % vb;
  if (rem !== 0n && (rem < 0n) !== (vb < 0n)) rem += vb;
  return makeFixed(base, p, q, rem);
}

/**
 * FLOAT の出力フィールド幅。
 * FLOAT DEC(6) は ' 3.50000E+0000'（幅14）で出力されるので
 *   仮数(1 + '.' + (p-1)桁) + 指数('E±dddd' = 6) + 符号(1) = p + 8
 */
export function floatWidth(p: number): number {
  return p + 8;
}

/** FLOAT を含む演算。JS の number で計算する。 */
function floatArith(op: string, a: Value, b: Value, line: number): Value {
  const num = (v: Value): number => {
    if (v.t === "float") return v.v;
    if (v.t === "fixed") return Number(render(v));
    throw new RuntimeError("数値として扱えません", line);
  };
  const p = Math.max(
    a.t === "float" ? a.p : 0,
    b.t === "float" ? b.p : 0,
    1,
  );
  const base: Base = a.t === "float" ? a.base : b.t === "float" ? b.base : "dec";
  const x = num(a);
  const y = num(b);
  let v: number;
  switch (op) {
    case "+": v = x + y; break;
    case "-": v = x - y; break;
    case "*": v = x * y; break;
    case "/":
      if (y === 0) throw new RuntimeError("ZERODIVIDE", line);
      v = x / y;
      break;
    case "**": v = x ** y; break;
    default:
      throw new Unsupported(`FLOAT に対する演算子 ${op}`, line);
  }
  return { t: "float", base, p, v };
}

/** 配列の全添字の組を行優先で列挙する。 */
function* enumerateSubscripts(dims: Bound[]): Generator<number[]> {
  const cur = dims.map((d) => d.lo);
  for (;;) {
    yield [...cur];
    let i = dims.length - 1;
    for (; i >= 0; i--) {
      cur[i] = (cur[i] ?? 0) + 1;
      if (cur[i]! <= dims[i]!.hi) break;
      cur[i] = dims[i]!.lo;
    }
    if (i < 0) return;
  }
}

const numExpr = (n: number): Expr => ({ kind: "num", text: String(n) });

function missing(name: string, i: number, line: number): never {
  throw new RuntimeError(`${name} の第${i + 1}引数がありません`, line);
}

function attrOfValue(v: Value): DataAttr {
  switch (v.t) {
    case "pointer": return { type: "pointer" };
    case "fixed": return { type: "fixed", base: v.base, p: v.p, q: v.q };
    case "float": return { type: "float", base: v.base, p: v.p };
    case "char": return { type: "char", length: v.length, varying: v.varying };
    case "bit": return { type: "bit", length: v.length };
  }
}

function asFixed(v: Value, line: number): FixedVal {
  if (v.t === "pointer") {
    throw new RuntimeError("ポインタは数値として扱えません", line);
  }
  if (v.t === "fixed") return v;
  if (v.t === "float") return fixedFromLiteral(String(v.v));
  if (v.t === "bit") {
    return makeFixed("bin", Math.max(1, v.v.length), 0, BigInt(parseInt(v.v || "0", 2)));
  }
  const s = v.v.trim();
  if (!/^[+-]?\d*\.?\d+$/.test(s)) {
    throw new RuntimeError(`数値として扱えません: ${JSON.stringify(v.v)}`, line);
  }
  return fixedFromLiteral(s);
}

/** ソースを実行して標準出力を返す。 */
export function run(source: string, opts: RunOptions = {}): RunResult {
  const interp = new Interpreter(opts);
  try {
    interp.run(parse(source));
    return { stdout: interp.text() };
  } catch (e) {
    // ERROR などの再開不能な条件で終了した場合。
    // stderr にバナーを出して終了する扱いにする。
    if (e instanceof FinishSignal) {
      return {
        stdout: interp.text(),
        error: `${e.condition} condition raised`,
      };
    }
    return { stdout: interp.text(), error: (e as Error).message };
  }
}

export type { Base, Value };

/**
 * 組込関数の名前。
 *
 * Linter が「宣言されていない識別子」と取り違えないために公開する。
 * `builtin()` の case と食い違わないことをテストで固定している。
 */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "ABS",
  "ADDR",
  "CEIL",
  "DIM",
  "DIVIDE",
  "FLOOR",
  "HBOUND",
  "INDEX",
  "LBOUND",
  "LENGTH",
  "MAX",
  "MIN",
  "MOD",
  "NULL",
  "REPEAT",
  "ROUND",
  "SIGN",
  "SUBSTR",
  "TRANSLATE",
  "TRUNC",
  "VERIFY",
]);
