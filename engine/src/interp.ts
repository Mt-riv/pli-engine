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
import { groupNames, qualifyDeclareItems } from "./declare.js";
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
import { parseDbd } from "./dli/dbd.js";
import { parsePsb } from "./dli/psb.js";
import { Database } from "./dli/store.js";
import { DliRuntime, DliUnsupported, type PcbState } from "./dli/dli.js";
import { DliDefError, type DbdDef } from "./dli/types.js";
import { DefError, IMS_NAME } from "./macro.js";
import { TmRuntime, TmUnsupported, type IoPcbState } from "./tm/tm.js";
import {
  FixedOverflow,
  MAX_BIN,
  MAX_DEC,
  ipow,
  powNeedsFloat,
  powFitsFixed,
  ZeroDivide,
  add,
  assignTo,
  roundForFormat,
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

/**
 * 診断に載せる値を短く切る。
 * 切らないと、長い文字列を数値に変換しようとしたときに
 * その全文がメッセージになり、UI と CI のログを埋める。
 */
function clip(v: string, max = 60): string {
  const t = JSON.stringify(v);
  return t.length <= max ? t : `${t.slice(0, max)}…(${v.length} 文字)`;
}

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
   * 呼び元の記憶域を共有している引数か（参照渡し）。
   *
   * PL/I は変数を参照で渡すので、呼び先が書き換えると呼び元に戻る。
   * ただし宣言した属性が渡された値と違う場合、実機は一時変数
   * （ダミー引数）を作って値渡しにする。その判定のために印を持つ。
   */
  sharedParam?: boolean;
  /**
   * BASED 宣言。独自の記憶域を持たず、ポインタの先を見る。
   * `pointer` は既定のポインタ（`based(p)` の `p`）。
   * `group` は確保の単位（構造体なら親の名前）。
   */
  based?: { pointer?: Ref; group: string };
}

/**
 * 実引数の束縛。
 *
 * `shared` が真なら呼び元の記憶域そのものを指す（参照渡し）。
 * 偽なら一時値（ダミー引数）。
 */
interface ArgBinding {
  attr: DataAttr;
  cells: Value[];
  dims?: Bound[];
  shared: boolean;
}

function isArgBinding(x: Value | ArgBinding): x is ArgBinding {
  return typeof x === "object" && x !== null && "cells" in x && "shared" in x;
}

interface ProcDef {
  stmt: Extract<Stmt, { kind: "procedure" }>;
  /**
   * 手続きが定義された位置のスコープ。
   *
   * 名前解決は**定義された位置**から外へたどる（レキシカルスコープ）。
   * 呼んだ位置からたどると、呼び先の未宣言の名前が呼び元の変数に化ける。
   * 登録の時点ではまだスコープが無い場合があるので、
   * `callProcedure` で補う。
   */
  defScope?: Scope;
}

class Scope {
  readonly vars = new Map<string, Variable>();
  readonly procs = new Map<string, ProcDef>();
  /** ON 単位。条件名から実行する文への対応。 */
  readonly onUnits = new Map<string, Stmt>();
  /**
   * 構造体のグループ名から、その配下の葉の修飾名（宣言順）への対応。
   *
   * `declare.ts` が構造体を葉の修飾名に潰すので、`vars` にはグループ名が
   * 入らない。これを持たないと `b = a;` や `PUT LIST(r);` が
   * 「未宣言のスカラ」として扱われ、暗黙宣言の 0 に落ちる
   * （無言で間違った結果になる、この処理系で最も悪い壊れ方）。
   */
  readonly groups = new Map<string, string[]>();
  /**
   * 呼び出し元のスコープ（動的な連鎖）。
   *
   * 名前解決は `parent`（レキシカル）をたどるが、**ON 単位は動的**に
   * 探すのが PL/I の規定なので、そちらはこの連鎖をたどる。
   */
  caller?: Scope;
  /** この手続きの `RETURNS` 属性。`RETURN` 文が合わせる型。 */
  returns?: DataAttr;
  /** 手続きの入口で作られたスコープか（`RETURNS` を探す範囲の境界）。 */
  isProcScope?: boolean;

  constructor(readonly parent?: Scope) {}

  /**
   * ON 単位を探す。
   *
   * まずレキシカルに外へ、見つからなければ呼び出し元へたどる。
   * PL/I の ON 単位は動的に有効になるので、呼び元が置いた
   * `ON ENDFILE` が呼び先でも効く必要がある。
   */
  lookupOn(condition: string): Stmt | undefined {
    const own = this.onUnits.get(condition);
    if (own !== undefined) return own;
    return this.parent?.lookupOn(condition) ?? this.caller?.lookupOn(condition);
  }

  lookupVar(name: string): Variable | undefined {
    return this.vars.get(name) ?? this.parent?.lookupVar(name);
  }

  lookupProc(name: string): ProcDef | undefined {
    return this.procs.get(name) ?? this.parent?.lookupProc(name);
  }

  /** 構造体のグループなら、配下の葉の修飾名を宣言順で返す。 */
  lookupGroup(name: string): string[] | undefined {
    return this.groups.get(name) ?? this.parent?.lookupGroup(name);
  }
}

/**
 * 整数を BIT の 2 進列にする。
 *
 * 長さを指定されたら、その幅に右詰めで収める（PL/I の規定）。
 */
function toBits(n: number, length?: number): string {
  const bits = Math.abs(n).toString(2);
  if (length === undefined) return bits;
  return bits.length >= length
    ? bits.slice(bits.length - length)
    : bits.padStart(length, "0");
}

/** FIXED を BIT の 2 進列にする。小数部は捨てる（BIT は整数のビット列）。 */
function fixedToBits(x: FixedVal, length?: number): string {
  const intVal = assignTo(x, x.base, Math.max(1, x.p - x.q), 0);
  return toBits(Number(render(intVal).trim()), length);
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
    case "implicit":
      // declare で名前から解決してから渡す。ここには来ない
      return zeroOf(implicitAttr("X"));
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
  /**
   * DL/I（IMS/DB）で使う PSB の名前。
   *
   * 実機では JCL や領域パラメータが決めるもので、プログラムには書かない。
   * 指定すると `<名前>.psb` をホストから読み、主手続きの引数が
   * コマンドライン引数ではなく PCB のポインタになる。
   */
  psb?: string;
  /**
   * 1 つの宣言・1 回の ALLOCATE で確保できる要素の数の上限。
   *
   * `maxSteps` では止められない。`dcl a(200000000) fixed bin(31);` の
   * **1 文**でメモリを使い切れるので、文の数とは別に要素数で止める。
   */
  maxStorageCells?: number;
  /**
   * 文字列の長さの上限。
   *
   * `CHAR(n) VARYING` は宣言の n を超えて伸びるので、
   * `repeat('A', 100000000)` が 1 億文字の値を作れる。
   */
  maxStringLength?: number;
  /** ALLOCATE の回数の上限。 */
  maxAllocations?: number;
  /**
   * IMS TM（メッセージキュー）。
   *
   * 渡すと入出力 PCB への `GU` / `GN` / `ISRT` / `PURG` が使えるようになる。
   * **キューと出来上がった出力を持つのは呼ぶ側**（画面との往復は
   * 1 入力 = 1 回の実行で、実行の外側が回す）。
   */
  tm?: TmRuntime;
}

/** 記憶域の上限の既定値。ブラウザのタブを守れる程度に取る。 */
export const DEFAULT_MAX_STORAGE_CELLS = 1_000_000;
export const DEFAULT_MAX_STRING_LENGTH = 10_000_000;
export const DEFAULT_MAX_ALLOCATIONS = 100_000;

/** 記憶域の上限に達したことを表す内部例外。 */
export class StorageLimitExceeded extends Error {
  constructor(message: string, readonly line = 1) {
    super(message);
    this.name = "StorageLimitExceeded";
  }
}

/** 出力上限に達したことを表す内部例外。 */
export class OutputLimitExceeded extends Error {
  constructor(readonly line = 1) {
    super("出力が上限に達しました");
    this.name = "OutputLimitExceeded";
  }
}

/** 文数の上限に達したことを表す内部例外。 */
export class StepLimitExceeded extends Error {
  constructor(limit: number, readonly line = 1) {
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
  /**
   * 実行中の文の行番号。上限に達したときの報告に使う。
   * これが無いと「無限ループで止まった」の診断が常に 1 行目を指す。
   */
  private currentLine = 1;
  /**
   * 手続きを呼んだ側の行番号の積み。外側から内側の順。
   *
   * 誤りが手続きの中で起きたときに「どこから呼んだか」を報告するために持つ。
   * これが無いと、テストフレームワークのように**処理系が前置きを差し込む**
   * 作りでは、報告の行番号が利用者のソースのどこでもない場所を指す。
   */
  private callerLines: number[] = [];
  /**
   * 誤りで終わったときの `callerLines` の写し。
   *
   * 積みは例外が抜けるときに巻き戻るので、投げる時点で控えておく。
   */
  private failureCallerLines?: number[];
  /** ALLOCATE した回数。上限の判定に使う。 */
  private allocations = 0;
  /**
   * STATIC な変数の記憶域。宣言のノードごとに持つ。
   *
   * 手続きを抜けても残る必要があるので、スコープではなく
   * 処理系に持たせる。宣言のノードで引くので、別の手続きに
   * 同じ名前の STATIC があっても取り違えない。
   */
  private readonly staticVars = new Map<DeclItem, Map<string, Variable>>();
  /** 条件の処理中か。ON 単位からの再入を防ぐ。 */
  private inCondition = false;
  /** ENTRY で宣言された外部手続きの名前。呼ばれたときの説明に使う。 */
  private readonly externalEntries = new Set<string>();
  /** DL/I ランタイム。PSB が指定されたときだけ作る。 */
  private dli: DliRuntime | undefined;
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
      throw new StepLimitExceeded(this.maxSteps, this.currentLine);
    }
  }

  /** 標準出力（SYSPRINT）の書き出し口。 */
  private get out(): ListWriter {
    return this.files.sysprint().writer!;
  }

  /** 出力が上限を超えていないか確かめる。全ファイルの合計で見る。 */
  private checkOutput(): void {
    if (this.maxOutputBytes !== undefined && this.files.totalWritten() > this.maxOutputBytes) {
      throw new OutputLimitExceeded(this.currentLine);
    }
  }

  /**
   * 確保しようとしている要素の数を確かめる。
   * 1 文で記憶域を使い切られるのを防ぐ（`maxSteps` では止まらない）。
   */
  private checkCells(n: number, what: string, line: number): void {
    const limit = this.opts.maxStorageCells ?? DEFAULT_MAX_STORAGE_CELLS;
    if (n > limit) {
      throw new StorageLimitExceeded(
        `${what}の要素数 ${n} が上限(${limit})を超えています`,
        line,
      );
    }
  }

  /** 文字列の長さを確かめる。VARYING は宣言の長さを超えて伸びるため。 */
  private checkLength(n: number, line: number): void {
    const limit = this.opts.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    if (n > limit) {
      throw new StorageLimitExceeded(
        `文字列の長さ ${n} が上限(${limit})を超えています`,
        line,
      );
    }
  }

  /** ソースを解析して実行する。例外は呼び出し側で分類する。 */
  runSource(source: string): void {
    const host = this.opts.host;
    this.run(parse(source, host === undefined ? {} : { host }));
  }

  run(program: Program): void {
    try {
      this.runUnguarded(program);
    } catch (e) {
      // 内部で使っている制御用の例外が外へ漏れたら、意味の分かる誤りに直す。
      // Error ではないので、そのまま漏らすと診断が `[object Object]` になり、
      // 行番号も 1 固定になる
      if (e instanceof GotoSignal) {
        throw new RuntimeError(
          `ラベル ${e.label} が見つかりません（GOTO の飛び先は同じ並びの中に要ります）`,
          this.currentLine,
        );
      }
      if (e instanceof LeaveSignal) {
        throw new RuntimeError(
          e.label === undefined
            ? "LEAVE はループの中でしか使えません"
            : `LEAVE ${e.label} に対応するループがありません`,
          this.currentLine,
        );
      }
      if (e instanceof IterateSignal) {
        throw new RuntimeError(
          e.label === undefined
            ? "ITERATE はループの中でしか使えません"
            : `ITERATE ${e.label} に対応するループがありません`,
          this.currentLine,
        );
      }
      if (e instanceof RangeError && /call stack/i.test(e.message)) {
        // 再帰が深すぎて JS のスタックを使い切った。
        // そのまま出すと行番号の無い英語のメッセージになる
        throw new RuntimeError(
          "再帰が深すぎます（この処理系は JavaScript のスタックを使うので、" +
            "数百段で尽きます）",
          this.currentLine,
        );
      }
      throw e;
    }
  }

  private runUnguarded(program: Program): void {
    const global = new Scope();
    // まず全ての手続きを登録する（前方参照を許すため）。
    // 外側の手続きの定義位置はこの global
    for (const s of program.body) {
      if (s.kind === "procedure") {
        global.procs.set(s.name.toUpperCase(), { stmt: s, defScope: global });
      }
    }
    const main =
      program.body.find((s) => s.kind === "procedure" && s.isMain) ??
      program.body.find((s) => s.kind === "procedure");
    if (!main || main.kind !== "procedure") {
      throw new RuntimeError("OPTIONS(MAIN) を持つ手続きがありません");
    }
    // 主手続きが引数を取る場合はコマンドライン引数を渡す。
    // numwrd.pli の `NUMWRD: proc(parm) options(main)` がこれに依存する。
    //
    // PSB が指定されているときは PCB のポインタになる。実機の IMS でも
    // 主手続きは PCB のポインタの並びしか受け取らないので、混ぜない。
    const args: Value[] =
      this.opts.psb === undefined
        ? main.params.map((_, i) => makeChar(this.opts.args?.[i] ?? "", undefined, true))
        : this.pcbPointers(main.params.length, main.line);
    this.callProcedure({ stmt: main, defScope: global }, args, global);
  }

  text(): string {
    this.out.finish();
    return this.out.text();
  }

  /**
   * 実行の後始末。開いたままのファイルを閉じてホストへ書き戻す。
   *
   * DL/I の書き戻しが失敗しても、通常のファイルは必ず閉じる。
   * 順に並べると、DBD 名の食い違いなどで `finishDli` が投げた時点で
   * `closeAll` に到達せず、そのプログラムが書いた**全ファイルが
   * 黙って消える**（終了コードは 0）。
   */
  finishFiles(): void {
    try {
      this.finishDli();
    } finally {
      this.files.closeAll();
    }
  }

  /**
   * 更新したデータベースをホストへ書き戻す。
   * 異常終了でも呼ばれるので、そこまでの更新は残る（ファイルと同じ約束）。
   */
  private finishDli(): void {
    const dli = this.dli;
    if (dli === undefined) return;
    for (const name of dli.changed) {
      const file = this.opts.host?.openFile?.(`${name}.dat`, "update");
      file?.write?.(dli.database(name).unload());
    }
    dli.changed.clear();
  }

  // ---- 手続き ----

  /**
   * いま実行中の手続きの `RETURNS` 属性。
   *
   * `RETURN` 文は手続きのスコープの中から呼ばれるので、
   * 手続きの境界まで外へたどる。
   */
  private returnsOf(scope: Scope): DataAttr | undefined {
    for (let sc: Scope | undefined = scope; sc; sc = sc.parent) {
      if (sc.returns !== undefined) return sc.returns;
      if (sc.isProcScope === true) return undefined;
    }
    return undefined;
  }

  /**
   * 実引数を束縛の形にする。
   *
   * **PL/I は変数を参照で渡す。** 呼び先が引数を書き換えると呼び元に戻る
   * （`CALL SWAP(A, B)` が成り立つのはこのため）。値渡しにすると
   * 出力引数を使うふつうの PL/I サブルーチンが黙って嘘の答えを返す。
   *
   * 参照にするのは「添字の無い変数そのもの」だけ。式・定数・配列要素は
   * 一時値（ダミー引数）として渡す。`DEFINED` と `BASED` は
   * 別の記憶域への窓なので、共有せず値で渡す。
   */
  private bindArgs(args: Expr[], scope: Scope, line: number): ArgBinding[] {
    return args.map((a) => {
      if (a.kind === "ref" && a.subscripts.length === 0 && a.locator === undefined) {
        const v = scope.lookupVar(a.name.toUpperCase());
        if (v !== undefined && v.defined === undefined && v.based === undefined) {
          return {
            attr: v.attr,
            cells: v.cells,
            ...(v.dims === undefined ? {} : { dims: v.dims }),
            shared: true,
          };
        }
      }
      const value = this.eval(a, scope, line);
      return { attr: attrOfValue(value), cells: [value], shared: false };
    });
  }

  /**
   * 手続きを呼ぶ。
   *
   * 新しいスコープの親は**定義された位置**（`def.defScope`）にする。
   * 呼んだ位置を親にすると動的スコープになり、呼び先の未宣言の名前が
   * 呼び元の変数に化ける（兄弟の手続きが呼び元のループ変数を壊す、など）。
   * ON 単位だけは動的に探す必要があるので、呼び出し元を `caller` に残す。
   */
  private callProcedure(
    def: ProcDef,
    args: (Value | ArgBinding)[],
    caller: Scope,
  ): Value | undefined {
    const scope = new Scope(def.defScope ?? caller);
    scope.caller = caller;
    scope.isProcScope = true;
    if (def.stmt.returns !== undefined) scope.returns = def.stmt.returns;
    // 入れ子の手続きを登録。その手続きの定義位置はこのスコープ
    for (const s of def.stmt.body) {
      if (s.kind === "procedure") {
        scope.procs.set(s.name.toUpperCase(), { stmt: s, defScope: scope });
      }
    }
    // 引数を束縛する。変数は参照、式は一時値（ダミー引数）
    def.stmt.params.forEach((p, i) => {
      const a = args[i];
      if (a === undefined) {
        throw new RuntimeError(`引数 ${p} が渡されていません`, def.stmt.line);
      }
      const b: ArgBinding =
        isArgBinding(a) ? a : { attr: attrOfValue(a), cells: [a], shared: false };
      scope.vars.set(p.toUpperCase(), {
        attr: b.attr,
        // 共有する場合は配列そのものを渡す（書き戻しが呼び元へ届く）
        cells: b.shared ? b.cells : [...b.cells],
        ...(b.dims === undefined ? {} : { dims: b.dims }),
        isParam: true,
        ...(b.shared ? { sharedParam: true } : {}),
      });
    });

    // 呼び出した位置を控える。誤りの報告で「どこから呼んだか」を出すため
    this.callerLines.push(this.currentLine);
    try {
      this.execBlock(def.stmt.body, scope);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      // 積みが巻き戻る前に控える。
      // 最初に抜けた時点（一番深いところ）のものを残す。
      // GOTO / LEAVE / ITERATE は誤りではないので控えない
      const flow =
        e instanceof GotoSignal || e instanceof LeaveSignal || e instanceof IterateSignal;
      if (!flow && this.failureCallerLines === undefined) {
        this.failureCallerLines = [...this.callerLines];
      }
      throw e;
    } finally {
      this.callerLines.pop();
    }
    return undefined;
  }

  /**
   * 誤りで終わったときの、手続きを呼んだ側の行番号（外側から内側）。
   *
   * 誤りが起きた行そのものは診断の `line` に入る。これはその外側の鎖。
   */
  callTrace(): number[] | undefined {
    if (this.failureCallerLines === undefined) return undefined;
    // 先頭は主手続きの呼び出し。処理系が呼ぶので呼び出し元の行が無い
    const lines = this.failureCallerLines.slice(1);
    return lines.length === 0 ? undefined : lines;
  }

  // ---- 処理系が受け持つサブルーチン ----

  /**
   * 処理系が受け持つサブルーチン。受け持ったら true を返す。
   *
   * ユーザー定義手続きと違い、**引数の式をそのまま受け取る**。
   * DL/I はステータスコードとセグメント I/O 領域を呼び先が書くので、
   * 値渡しでは成立しない。書き戻しの要る引数だけ参照として扱い、
   * ユーザー定義手続きの値渡しには手を付けない。
   */
  private callBuiltinSub(s: Extract<Stmt, { kind: "call" }>, scope: Scope): boolean {
    const key = s.name.toUpperCase();
    if (!BUILTIN_SUBROUTINE_NAMES.has(key)) return false;
    switch (key) {
      case "PLITDLI":
        this.plitdli(s, scope);
        return true;
      case "CBLTDLI":
      case "ASMTDLI":
        throw new RuntimeError(
          `${s.name} は COBOL / アセンブラ向けの入口です。PL/I では PLITDLI を使います`,
          s.line,
        );
      case "AIBTDLI":
        throw new RuntimeError(
          "AIB インタフェース（AIBTDLI）は未実装です。PLITDLI を使ってください",
          s.line,
        );
      default:
        return false;
    }
  }

  // ---- DL/I（IMS/DB） ----

  /**
   * `CALL PLITDLI(引数個数, 機能コード, PCB, I/O 領域, SSA...)`。
   *
   * 引数は**値ではなく式のまま**受け取る。DL/I はステータスコードと
   * セグメント I/O 領域を呼び先が書くので、値渡しでは成立しない。
   * ユーザー定義手続きの値渡しには触らない（別経路）。
   */
  private plitdli(s: Extract<Stmt, { kind: "call" }>, scope: Scope): void {
    const dli = this.requireDli(s.line);
    const args = s.args;
    if (args.length < 3) {
      throw new RuntimeError(
        "CALL PLITDLI には 引数個数・機能コード・PCB の 3 つが最低限必要です",
        s.line,
      );
    }
    // 第 1 引数は「後続の引数の個数」。実機では合っていなくても
    // 落ちるだけなので、ここで食い違いを指摘する（よくある誤り）
    const declared = Number(render(asFixed(this.eval(args[0]!, scope, s.line), s.line)));
    if (declared !== args.length - 1) {
      throw new RuntimeError(
        `CALL PLITDLI の第 1 引数は ${declared} ですが、後ろに渡した引数は ${args.length - 1} 個です`,
        s.line,
      );
    }
    const func = this.asText(this.eval(args[1]!, scope, s.line));
    const pcbRef = args[2]!;
    if (pcbRef.kind !== "ref") {
      throw new RuntimeError("PLITDLI の第 3 引数は PCB マスクの変数です", s.line);
    }
    const index = this.pcbIndexFor(dli, pcbRef, scope, s.line);
    const ioRef = args[3];
    if (dli.pcb(index).def.kind === "io") {
      this.messageCall(s, scope, func, pcbRef, dli.pcb(index), ioRef, args[4]);
      return;
    }
    const ioArea =
      ioRef === undefined || ioRef.kind !== "ref"
        ? ""
        : this.readIoArea(ioRef, scope, s.line);
    // SSA は構造体で組み立てるのが PL/I の IMS プログラムの典型形
    // （SSA_NAME / '(' / FIELD / OP / VALUE / ')' を並べた構造体）。
    // 値として評価すると構造体はスカラにならないので、
    // I/O 領域と同じく**葉を宣言順に連結**する。
    const ssas = args.slice(4).map((a) =>
      a.kind === "ref" && a.subscripts.length === 0
        ? this.readIoArea(a, scope, s.line)
        : this.asText(this.eval(a, scope, s.line)),
    );

    let result;
    try {
      result = dli.call(index, func, ioArea, ssas);
    } catch (e) {
      if (e instanceof DliUnsupported) throw new RuntimeError(e.message, s.line);
      throw e;
    }
    if (result.ioArea !== undefined && ioRef !== undefined && ioRef.kind === "ref") {
      this.writeIoArea(ioRef, result.ioArea, scope, s.line);
    }
    this.writePcb(pcbRef, scope, dli.pcb(index), s.line);
  }

  /**
   * 入出力 PCB への呼び出し（IMS TM）。
   *
   * データベースの呼び出しと違い、I/O 領域の先頭 4 バイトが
   * `LL ZZ`（長さと予約）になる。`LL` はプログラムが入れる数値なので、
   * 文字として扱う `readIoArea` では読めない。
   */
  private messageCall(
    s: Extract<Stmt, { kind: "call" }>,
    scope: Scope,
    func: string,
    pcbRef: Ref,
    pcb: PcbState,
    ioRef: Expr | undefined,
    modRef: Expr | undefined,
  ): void {
    const tm = this.opts.tm;
    if (tm === undefined) {
      throw new RuntimeError(
        "入出力 PCB への呼び出しにはメッセージキューが必要です" +
          "（実行するときに MFS の書式と入力を与えてください）",
        s.line,
      );
    }
    const code = func.trim().toUpperCase();
    const isInsert = code === "ISRT";
    const area = ioRef !== undefined && ioRef.kind === "ref" ? ioRef : undefined;
    let segment: string | undefined;
    if (isInsert) {
      if (area === undefined) {
        throw new RuntimeError("ISRT には I/O 領域が必要です", s.line);
      }
      segment = this.readMessageArea(area, scope, s.line);
    }
    const modName =
      modRef === undefined
        ? undefined
        : modRef.kind === "ref"
          ? this.asText(this.evalRef(modRef, scope, s.line))
          : this.asText(this.eval(modRef, scope, s.line));

    let result;
    try {
      result = tm.call(code, segment, modName);
    } catch (e) {
      if (e instanceof TmUnsupported) throw new RuntimeError(e.message, s.line);
      throw e;
    }
    if (result.segment !== undefined && area !== undefined) {
      this.writeMessageArea(area, result.segment, scope, s.line);
    }
    pcb.status = result.status;
    this.writePcb(pcbRef, scope, pcb, s.line);
  }

  /**
   * メッセージ I/O 領域を読む（`ISRT`）。
   *
   * 先頭 2 項目は `LL`（このセグメントの長さ。`LL ZZ` を含む）と `ZZ`。
   * **`LL` の分だけを送る**（実機も `LL` を見る）。
   */
  private readMessageArea(ref: Ref, scope: Scope, line: number): string {
    const leaves = this.leafCells(ref, scope, line);
    const ll = this.messageLength(leaves, ref, line);
    let text = "";
    for (const l of leaves.slice(2)) {
      const w = this.widthOfAttr(l.attr, l.key, line);
      const cell = l.cells[l.index];
      text += (cell === undefined ? "" : this.asText(cell)).padEnd(w).slice(0, w);
    }
    if (ll <= 4) {
      throw new RuntimeError(
        `ISRT のセグメント長 LL が ${ll} です。LL には LL ZZ の 4 バイトを含めた長さを入れてください`,
        line,
      );
    }
    return text.padEnd(ll - 4).slice(0, ll - 4);
  }

  /** メッセージ I/O 領域へ書く（`GU` / `GN`）。 */
  private writeMessageArea(ref: Ref, segment: string, scope: Scope, line: number): void {
    const leaves = this.leafCells(ref, scope, line);
    this.messageLength(leaves, ref, line); // 形の確認
    const ll = leaves[0]!;
    const zz = leaves[1]!;
    ll.cells[ll.index] = this.coerce(makeFixed("bin", MAX_BIN, 0, BigInt(segment.length + 4)), ll.attr, line);
    zz.cells[zz.index] = this.coerce(makeFixed("bin", MAX_BIN, 0, 0n), zz.attr, line);
    let pos = 0;
    for (const l of leaves.slice(2)) {
      const w = this.widthOfAttr(l.attr, l.key, line);
      const piece = segment.slice(pos, pos + w).padEnd(w);
      pos += w;
      l.cells[l.index] = this.coerce(makeChar(piece, piece.length, true), l.attr, line);
    }
  }

  /** `LL` を読む。あわせてメッセージ I/O 領域の形を確かめる。 */
  private messageLength(
    leaves: { key: string; attr: DataAttr; cells: Value[]; index: number }[],
    ref: Ref,
    line: number,
  ): number {
    const shape =
      `${ref.name} はメッセージ I/O 領域として使えません。` +
      "DCL 1 名前, 2 LL FIXED BIN(15), 2 ZZ FIXED BIN(15), 2 … の形で宣言してください";
    if (leaves.length < 3) throw new RuntimeError(shape, line);
    const ll = leaves[0]!;
    const zz = leaves[1]!;
    if (ll.attr.type !== "fixed" || zz.attr.type !== "fixed") throw new RuntimeError(shape, line);
    const cell = ll.cells[ll.index];
    return cell === undefined ? 0 : Number(render(asFixed(cell, line)));
  }

  /** DL/I ランタイム。最初に使うときに PSB とデータベースを読む。 */
  private requireDli(line: number): DliRuntime {
    if (this.dli !== undefined) return this.dli;
    if (this.opts.psb === undefined) {
      throw new RuntimeError(
        "PSB が指定されていません。DL/I を使うには実行するときに PSB の名前を与えてください",
        line,
      );
    }
    const read = this.opts.host?.openFile;
    if (read === undefined) {
      throw new RuntimeError(
        "DL/I を使うには、DBD・PSB・データを読めるホストが必要です",
        line,
      );
    }
    try {
      this.dli = this.loadDli(this.opts.psb);
    } catch (e) {
      if (e instanceof DefError) throw new RuntimeError(e.message, line);
      throw e;
    }
    return this.dli;
  }

  /** PSB を読み、そこから DBD とデータを読む。 */
  private loadDli(psbName: string): DliRuntime {
    // PSB 名は CLI の `--psb` と VSCode の設定 `pli.dli.psb` から来る。
    // そのままファイル名になるので、IMS の名前の形を強制する
    if (!IMS_NAME.test(psbName.toUpperCase())) {
      throw new DliDefError(
        `PSB 名 ${psbName} は IMS の名前として使えません（1〜8 桁の英数字と $ # @ だけ）`,
        "(PSB の指定)",
        1,
      );
    }
    const text = (name: string): string | undefined =>
      this.opts.host?.openFile?.(name, "input")?.read?.();
    const psbFile = `${psbName}.psb`;
    const psbText = text(psbFile) ?? text(psbName);
    if (psbText === undefined) {
      throw new DliDefError("PSB が見つかりません", psbFile, 1);
    }
    const dbds = new Map<string, DbdDef>();
    const resolve = (name: string): DbdDef | undefined => {
      const found = dbds.get(name);
      if (found !== undefined) return found;
      const source = text(`${name}.dbd`);
      if (source === undefined) return undefined;
      const dbd = parseDbd(source, `${name}.dbd`);
      dbds.set(name, dbd);
      return dbd;
    };
    const psb = parsePsb(psbText, psbFile, resolve);
    const databases = new Map<string, Database>();
    for (const pcb of psb.pcbs) {
      if (pcb.kind !== "db" || databases.has(pcb.dbdName!)) continue;
      const name = pcb.dbdName!;
      databases.set(name, Database.load(pcb.dbd!, text(`${name}.dat`) ?? "", `${name}.dat`));
    }
    return new DliRuntime(psb, databases);
  }

  /**
   * 主手続きへ渡す PCB のポインタ。
   *
   * 記憶域は処理系が作り、`pcbIndex` の印を付ける。
   * 葉の形はプログラムの `DCL 1 … BASED(ptr)` が決める（位置で結び付く）。
   */
  private pcbPointers(count: number, line: number): Value[] {
    // 引数を取らない主手続きは PCB を受け取れない。
    // この時点で PSB を読む理由が無いので、読まずに返す
    // （PL/I で書くテストの入口は引数を取らない）
    if (count === 0) return [];
    const dli = this.requireDli(line);
    if (count > dli.pcbCount) {
      throw new RuntimeError(
        `PSB ${dli.psb.name} の PCB は ${dli.pcbCount} 個ですが、主手続きは ${count} 個受け取っています`,
        line,
      );
    }
    const out: Value[] = [];
    for (let i = 0; i < count; i++) {
      const pcb = dli.pcb(i);
      const cells = new Map<string, Value[]>();
      for (const slot of pcbLayout(pcb, this.opts.tm?.state)) {
        cells.set(slot.name, [slot.value()]);
      }
      out.push(
        makePointer({
          cells,
          freed: false,
          group: `PCB ${i + 1}`,
          pcbIndex: i,
        }),
      );
    }
    return out;
  }

  /** PCB マスクの変数から、どの PCB を指しているかを決める。 */
  private pcbIndexFor(dli: DliRuntime, ref: Ref, scope: Scope, line: number): number {
    const name = ref.name.toUpperCase();
    const v = scope.lookupVar(name) ?? this.leavesOf(name, scope)[0]?.v;
    const locator = ref.locator ?? v?.based?.pointer;
    if (locator !== undefined) {
      const pv = this.eval(locator, scope, line);
      if (pv.t === "pointer" && pv.target?.pcbIndex !== undefined) return pv.target.pcbIndex;
    }
    // BASED ではない構造体をそのまま渡した場合。
    // DB の PCB が 1 つだけなら迷いようが無いので受け付ける
    const dbPcbs = dli.psb.pcbs
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.kind === "db");
    if (dbPcbs.length === 1) return dbPcbs[0]!.i;
    throw new RuntimeError(
      `${ref.name} がどの PCB かを決められません。主手続きの引数で受けたポインタに BASED で宣言してください`,
      line,
    );
  }

  /** 構造体の葉を、書き戻せる形で宣言順に取り出す。 */
  private leafCells(
    group: Ref,
    scope: Scope,
    line: number,
  ): { key: string; attr: DataAttr; cells: Value[]; index: number }[] {
    return this.leavesOf(group.name, scope).map(({ key, v }) => {
      const ref: Ref = {
        kind: "ref",
        name: key,
        subscripts: [],
        ...(group.locator === undefined ? {} : { locator: group.locator }),
      };
      const based = this.basedCells(v, ref, scope, line);
      return { key, attr: v.attr, cells: based ?? v.cells, index: 0 };
    });
  }

  /**
   * セグメント I/O 領域を読む。
   * 項目の幅の規則はレコード入出力と同じ（文字と PICTURE だけ）。
   */
  private readIoArea(ref: Ref, scope: Scope, line: number): string {
    const leaves = this.leafCells(ref, scope, line);
    if (leaves.length === 0) return this.asText(this.evalRef(ref, scope, line));
    let text = "";
    for (const l of leaves) {
      const w = this.widthOfAttr(l.attr, l.key, line);
      const cell = l.cells[l.index];
      text += (cell === undefined ? "" : this.asText(cell)).padEnd(w).slice(0, w);
    }
    return text;
  }

  /** セグメント I/O 領域へ書く。 */
  private writeIoArea(ref: Ref, record: string, scope: Scope, line: number): void {
    const leaves = this.leafCells(ref, scope, line);
    if (leaves.length === 0) {
      this.assign(ref, makeChar(record, record.length, true), scope, line);
      return;
    }
    let pos = 0;
    for (const l of leaves) {
      const w = this.widthOfAttr(l.attr, l.key, line);
      const piece = record.slice(pos, pos + w).padEnd(w);
      pos += w;
      l.cells[l.index] = this.coerce(makeChar(piece, piece.length, true), l.attr, line);
    }
  }

  /** DL/I の応答を PCB マスクへ写す。宣言された型に合わせて入れる。 */
  private writePcb(ref: Ref, scope: Scope, pcb: PcbState, line: number): void {
    const leaves = this.leafCells(ref, scope, line);
    if (leaves.length === 0) {
      throw new RuntimeError(
        `${ref.name} は PCB マスクとして使えません。` +
          "DCL 1 名前, 2 DBNAME CHAR(8), 2 SEG_LEVEL CHAR(2), … の形の構造体で宣言してください",
        line,
      );
    }
    const slots = pcbLayout(pcb, this.opts.tm?.state);
    if (leaves.length < slots.length) {
      throw new RuntimeError(
        `PCB マスクの項目が ${leaves.length} 個しかありません（${slots.length} 個必要です）`,
        line,
      );
    }
    slots.forEach((slot, i) => {
      const leaf = leaves[i]!;
      leaf.cells[leaf.index] = this.coerce(slot.value(), leaf.attr, line);
    });
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
      if (s.kind === "procedure") {
        scope.procs.set(s.name.toUpperCase(), { stmt: s, defScope: scope });
      }
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
    if (s.otherwise !== undefined) {
      this.exec(s.otherwise, scope);
      return;
    }
    // どの WHEN にも合わず OTHERWISE も無い場合は ERROR 条件。
    // 黙って通すと「どれかに合ったつもり」で先へ進んでしまう
    this.raise("ERROR", scope, s.line);
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

  /**
   * 検査条件を上げる。
   *
   * `ON` 単位が置かれていればそこへ回し、無ければふつうの実行時誤りにする。
   * 置かれていないときに条件の名前だけを出すと、何が起きたのか分からない。
   */
  private raiseChecked(condition: string, message: string, line: number): never {
    const scope = this.currentScope;
    if (scope.lookupOn(condition) !== undefined) {
      this.raise(condition, scope, line);
    }
    throw new RuntimeError(message, line);
  }

  // ---- 文 ----

  private exec(s: Stmt, scope: Scope): void {
    // 無限ループ対策。ブラウザには別プロセスが無いので
    // 実行した文の数で打ち切る。
    this.step();
    this.currentScope = scope;
    if (s.line > 0) this.currentLine = s.line;
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
        // 構造体全体の代入（b = a）は葉を宣言順に突き合わせる
        if (this.assignGroup(s.target, s.value, scope, s.line)) return;
        // 配列全体への代入（c = a + b など）は要素ごとに行う
        const lhs = scope.lookupVar(s.target.name.toUpperCase());
        if (lhs?.dims && s.target.subscripts.length === 0) {
          // 右辺が配列になるなら要素ごとに代入する。
          // `binary` だけを見ると `c = -a` が先頭要素の配り直しになる
          const values = this.evalArray(s.value, scope, s.line);
          if (values) {
            // 要素数が合わなければ断る。黙って切ると
            // 「後ろの要素が更新されていない」ことに気づけない
            if (values.length !== lhs.cells.length) {
              throw new RuntimeError(
                `配列式の要素数が合いません（${s.target.name} は ` +
                  `${lhs.cells.length} 要素、右辺は ${values.length} 要素）`,
                s.line,
              );
            }
            values.forEach((v, i) => {
              lhs.cells[i] = this.coerce(v, lhs.attr, s.line);
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
        if (def) {
          this.callProcedure(def, this.bindArgs(s.args, scope, s.line), scope);
          return;
        }
        // 処理系が受け持つサブルーチン（DL/I の PLITDLI など）。
        // 利用者が同じ名前の手続きを書いたらそちらが勝つので、
        // 探すのはユーザー定義の解決が空振りした後。
        if (this.callBuiltinSub(s, scope)) return;
        throw new RuntimeError(`手続き ${s.name} が見つかりません`, s.line);
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
      case "on": {
        // ファイルを取る条件は「条件(ファイル名)」を鍵にする
        const key =
          s.conditionFile === undefined
            ? s.condition
            : `${s.condition}(${s.conditionFile.toUpperCase()})`;
        if (s.body === undefined) {
          // `ON ... SYSTEM;` は既定動作へ戻す（ON 単位の解除）。
          // 空の ON 単位を置くと「何もせず復帰して続行」になってしまう
          scope.onUnits.delete(key);
          return;
        }
        scope.onUnits.set(key, s.body);
        return;
      }
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
        const allocLimit = this.opts.maxAllocations ?? DEFAULT_MAX_ALLOCATIONS;
        if (++this.allocations > allocLimit) {
          throw new StorageLimitExceeded(
            `ALLOCATE の回数が上限(${allocLimit})を超えています`,
            s.line,
          );
        }
        const storage: Storage = { cells: new Map(), freed: false, group };
        for (const leaf of tmpl) {
          const n = elementCount(leaf.dims);
          this.checkCells(n, `${leaf.name} の ALLOCATE`, s.line);
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
          const key = ref.name.toUpperCase();
          let v = scope.lookupVar(key);
          // 構造体の BASED はグループ名で `FREE p -> node;` と書く。
          // グループ名は `vars` に無いので葉から引き直す。
          // 引き直さないと「node は BASED で宣言されていません」という
          // 事実と逆のメッセージになる
          if (v?.based === undefined) {
            const group = scope.lookupGroup(key);
            const leaf = group
              ?.map((k) => scope.lookupVar(k))
              .find((x) => x?.based !== undefined);
            if (leaf !== undefined) v = leaf;
          }
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
      case "return": {
        if (s.value === undefined) throw new ReturnSignal();
        // 宣言した RETURNS の型へ合わせる。合わせないと
        // `returns(fixed dec(7,2))` と書いても式の精度のまま返り、
        // 表示幅も宣言とずれる
        const value = this.eval(s.value, scope, s.line);
        const want = this.returnsOf(scope);
        throw new ReturnSignal(
          want === undefined ? value : this.coerce(value, want, s.line),
        );
      }
    }
  }

  /**
   * 宣言の並びを処理する。
   * レベル番号が付いていれば構造体として扱い、葉の要素を
   * 修飾名（REC.ADDR.CITY）で登録する。
   * 中間レベル（名前だけで型を持たない）は記憶域を持たない。
   */
  private declareAll(items: DeclItem[], scope: Scope, line: number): void {
    const qualified = qualifyDeclareItems(items);
    for (const item of qualified) this.declare(item, scope, line);
    // 構造体のグループ名を覚える。葉は宣言順に並べる
    // （構造体同士の代入とデータリストの展開がこの順で決まる）
    for (const group of groupNames(items)) {
      const upper = group.toUpperCase();
      const prefix = `${upper}.`;
      const leaves: string[] = [];
      for (const item of qualified) {
        for (const name of item.names) {
          const key = name.toUpperCase();
          if (key === upper || key.startsWith(prefix)) {
            // さらに下にグループがあれば葉ではない。vars にあるものだけ採る
            if (scope.vars.has(key)) leaves.push(key);
          }
        }
      }
      scope.groups.set(upper, leaves);
    }
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
    this.checkCells(n, `${item.names[0] ?? "配列"} の宣言`, line);
    // 型を書いていない宣言（`dcl x;`）は、名前の先頭文字で属性が決まる。
    // 名前ごとに違う属性になりうるので、ここで解決する
    if (item.attr.type === "implicit") {
      for (const name of item.names) {
        this.declare(
          { ...item, names: [name], attr: implicitAttr(name.split(".").pop() ?? name) },
          scope,
          line,
        );
      }
      return;
    }
    if (item.attr.type === "char" && item.attr.length !== undefined) {
      this.checkLength(item.attr.length, line);
    }
    for (const name of item.names) {
      const key = name.toUpperCase();
      // 引数名の DECLARE は属性の宣言であって新変数ではない。
      // 渡された値を宣言された型へ変換して保持する。
      const existing = scope.vars.get(key);
      if (existing?.isParam) {
        // 宣言した属性が渡された値と同じなら、記憶域の共有を保つ
        // （参照渡し。呼び先の書き換えが呼び元へ戻る）。
        // 違うなら実機と同じく一時変数（ダミー引数）にして、
        // 呼び元の変数の型を書き換えないようにする。
        const needsConversion = existing.cells.some(
          (c) => !sameAttr(item.attr, attrOfValue(c)),
        );
        if (existing.sharedParam === true && needsConversion) {
          existing.cells = existing.cells.map((c) => this.coerce(c, item.attr, line));
          existing.sharedParam = false;
        } else {
          // 配列そのものを差し替えないこと。差し替えると共有が切れる
          for (let i = 0; i < existing.cells.length; i++) {
            existing.cells[i] = this.coerce(existing.cells[i]!, item.attr, line);
          }
        }
        existing.attr = item.attr;
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
      // STATIC は手続きを抜けても値が残る。
      // 宣言ごとに 1 つの記憶域を持ち、2 回目以降はそれを使い回す
      // （初期化も最初の 1 回だけ）。宣言のノードで引くので、
      // 同じ名前の STATIC が別の手続きにあっても混ざらない。
      if (item.storage === "static") {
        const slot = this.staticVars.get(item);
        const kept = slot?.get(key);
        if (kept !== undefined) {
          scope.vars.set(key, kept);
          continue;
        }
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
      if (item.storage === "static") {
        const slot = this.staticVars.get(item) ?? new Map<string, Variable>();
        slot.set(key, v);
        this.staticVars.set(item, slot);
      }
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
        // 構造体はその葉を宣言順に展開する（PL/I の規定）。
        // 展開しないとグループ名が「未宣言のスカラ」になり 0 が出る
        const group = scope.lookupGroup(e.name.toUpperCase());
        if (group !== undefined) {
          for (const key of group) {
            const leaf = scope.lookupVar(key);
            if (leaf === undefined) continue;
            if (leaf.dims) out.push(...leaf.cells);
            else if (leaf.cells[0] !== undefined) out.push(leaf.cells[0]);
          }
          continue;
        }
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
        // F(w) は小数部 0 桁。実機は丸めて整数にする（1.99 → 2、1.49 → 1）。
        // 以前は小数部の指定が無いと値をそのまま出していた（1.99 → 1.99）
        const d = f.decimals === undefined ? 0 : num(f.decimals);
        // 丸めは**書式の性質**なので代入（assignTo）とは別の関数を使う。
        // 代入は切り捨て、F 書式は 0 から遠い側へ丸める（実機で確認）
        w.editNumber(render(roundForFormat(asFixed(v, line), d)), width);
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
    /**
     * 代入を済ませたあとに ENDFILE を上げる回数。
     *
     * 実機（Iron Spring PL/I 1.4.1）で確かめた。`get list(a, b);` に対し:
     *   "12 34 56" … 0 回（末尾に届いていない）
     *   "12 34"    … 1 回。a=12 / b=34（末尾に届いた読み取りで上がる）
     *   "12"       … 2 回。**a=12 / b=0**（a は読めているので代入される。
     *                 b はデータが無いのでもう 1 回上がる）
     * ON 単位から戻ったら GET は次の項目へ進む（打ち切らない）。
     *
     * 以前は 1 回だけ上げ、**読めた分も捨てていた**（"12" で a=0）。
     */
    let endfileAfter = 0;
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
          // 読めた分は代入してから上げる（LIST と同じ扱い。
          // EDIT については実機で確かめていないが、読めた値を捨てる理由が無い）
          endfileAfter++;
          break;
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
          // データが尽きた。**読めた分は捨てない**（代入してから上げる）
          if (fileName !== undefined) endfileAfter++;
          break;
        }
        texts.push(item);
        // 末尾に届いた読み取りでも上げる。
        // 代入は済ませてから上げるので、ここでは数えるだけ
        if (fileName !== undefined && cursor.atLastItem()) {
          endfileAfter++;
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

    for (let i = 0; i < endfileAfter && fileName !== undefined; i++) {
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
    // 指数表記（`1.5E3`）と末尾の小数点（`5.`）も受ける。
    // FLOAT 変数へ読むのは PL/I でふつうの書き方なので、
    // 受け付けないと「数値として読めません」で止まる
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
      this.raiseChecked("CONVERSION", `数値として読めません: ${clip(text)}`, line);
    }
    if (/[eE]/.test(t)) {
      // 指数表記は FLOAT として受ける。FIXED へ代入するなら coerce が丸める
      const n = Number(t);
      if (!Number.isFinite(n)) {
        this.raiseChecked("CONVERSION", `数値として読めません: ${clip(text)}`, line);
      }
      return this.coerce(
        { t: "float", base: "dec", p: 6, v: n },
        attr,
        line,
      );
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
      // レコード出力も出力上限で打ち切る。ブラウザには別プロセスが
      // 無いので、PUT だけ数えていると WRITE で際限なく伸ばせる
      this.checkOutput();
      return;
    }
    if (!file.rewriteRecord(text)) {
      throw new RuntimeError("REWRITE の前に READ が必要です", s.line);
    }
    this.checkOutput();
  }

  /**
   * 構造体全体の代入。扱ったら true。
   *
   * `b = a;` は葉を**宣言順**に突き合わせる（PL/I の規定）。
   * 名前ではなく順で結び付けるのは、項目名が違っていても
   * 形が同じなら代入できるため。形が違えば誤りとして止める。
   *
   * これが無いと、グループ名が `vars` に無いので
   * 「未宣言のスカラ」として暗黙宣言の 0 に落ち、**無言で何も起きない**。
   */
  private assignGroup(target: Ref, value: Expr, scope: Scope, line: number): boolean {
    const dest = scope.lookupGroup(target.name.toUpperCase());
    if (dest === undefined) return false;
    if (target.subscripts.length > 0) {
      throw new Unsupported("構造体配列の要素への代入", line);
    }
    if (value.kind !== "ref" || value.subscripts.length > 0) {
      throw new RuntimeError(
        `${target.name} は構造体です。構造体に代入できるのは同じ形の構造体だけです`,
        line,
      );
    }
    const srcKey = value.name.toUpperCase();
    const src = scope.lookupGroup(srcKey);
    if (src === undefined) {
      throw new RuntimeError(
        `${value.name} は構造体ではありません（${target.name} は構造体です）`,
        line,
      );
    }
    if (src.length !== dest.length) {
      throw new RuntimeError(
        `構造体の形が違います: ${target.name} は項目 ${dest.length} 個、` +
          `${value.name} は ${src.length} 個`,
        line,
      );
    }
    for (const [i, destKey] of dest.entries()) {
      const to = scope.lookupVar(destKey);
      const from = scope.lookupVar(src[i]!);
      if (to === undefined || from === undefined) {
        throw new RuntimeError(`構造体の項目 ${destKey} が見つかりません`, line);
      }
      // 配列の葉は要素ごとに写す
      to.cells = from.cells.map((c) => this.coerce(c, to.attr, line));
    }
    return true;
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
    return this.widthOfAttr(v.attr, key, line);
  }

  /**
   * 属性から項目の幅を出す。
   * レコード入出力と DL/I のセグメント I/O 領域が同じ規則を使う。
   */
  private widthOfAttr(attr: DataAttr, key: string, line: number): number {
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
    // DL/I の PCB は、葉の名前ではなく宣言順で結び付ける。
    // 名前はプログラムが自由に付けるので、名前では引けない
    if (storage.pcbIndex !== undefined) {
      const slots = [...storage.cells.values()];
      const at = this.leavesOf(v.based.group, scope).findIndex((l) => l.key === key);
      const slot = at < 0 ? undefined : slots[at];
      if (slot !== undefined) return slot;
      throw new RuntimeError(
        `${ref.name} は PCB マスクの ${slots.length} 項目に収まりません`,
        line,
      );
    }
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
        // SUBSCRIPTRANGE 条件。ON 単位が置かれていればそこへ回る。
        // 上げないと `ON SUBSCRIPTRANGE` を書いても実行されない
        // （PL/I の既定は無検査だが、この処理系は常に検査する方を採る）
        this.raiseChecked("SUBSCRIPTRANGE", `添字が範囲外です: ${n}`, line);
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
        case "implicit":
          // declare で名前から解決してから渡す。ここには来ない
          return this.coerce(value, implicitAttr("X"), line);
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
          if (value.t === "pointer") {
            throw new RuntimeError("ポインタは BIT に変換できません", line);
          }
          // 数値から BIT への変換は 2 進表現にする。
          // 以前は空文字に落としていたので `b = 1;` が '0'B になっていた
          const s =
            value.t === "bit" ? value.v
            : value.t === "char" ? value.v
            : value.t === "fixed" ? fixedToBits(value, attr.length)
            : toBits(Math.trunc(value.v), attr.length);
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
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) {
      this.raiseChecked("CONVERSION", `数値に変換できません: ${clip(v.v)}`, line);
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
        const arr = this.evalArray(e, scope, line);
        if (arr !== undefined) {
          const first = arr[0];
          if (first === undefined) throw new RuntimeError("空の配列式です", line);
          return first;
        }
        return this.applyUnary(e.op, this.eval(e.operand, scope, line), line);
      }
      case "binary":
        return this.evalBinary(e, scope, line);
    }
  }

  /**
   * 配列式。A+S / S+A / A+A を要素ごとに計算する（1.4.0 以降の機能）。
   * 配列が絡む場合だけ特別扱いし、結果を値の並びで返す。
   */
  /** 単項演算。配列式からも使うので 1 箇所にまとめる。 */
  private applyUnary(op: string, v: Value, line: number): Value {
    if (op === "-") return neg(asFixed(v, line));
    if (op === "+") return v;
    // NOT: ビット反転
    const b = v.t === "bit" ? v.v : this.truth(v, line) ? "1" : "0";
    return makeBit([...b].map((c) => (c === "0" ? "1" : "0")).join(""), b.length);
  }

  /**
   * 式を配列として評価する。配列にならなければ undefined。
   *
   * **部分式も再帰的に見る。** 最上位の二項演算だけを配列として扱うと、
   * `c = a + b * 2` の `b * 2` が `eval` 側へ回って先頭要素に潰れ、
   * `c(i) = a(i) + b(1)*2` になってしまう。
   */
  private evalArray(e: Expr, scope: Scope, line: number): Value[] | undefined {
    if (e.kind === "ref" && e.subscripts.length === 0) {
      const v = scope.lookupVar(e.name.toUpperCase());
      if (!v?.dims) return undefined;
      return this.dataList([e], scope, line);
    }
    if (e.kind === "binary") return this.tryArrayExpr(e, scope, line);
    if (e.kind === "unary") {
      const inner = this.evalArray(e.operand, scope, line);
      if (inner === undefined) return undefined;
      return inner.map((v) => this.applyUnary(e.op, v, line));
    }
    return undefined;
  }

  private tryArrayExpr(
    e: Extract<Expr, { kind: "binary" }>,
    scope: Scope,
    line: number,
  ): Value[] | undefined {
    const la = this.evalArray(e.left, scope, line);
    const ra = this.evalArray(e.right, scope, line);
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

    // 論理演算。
    //
    // PL/I の `&` と `|` は**ビットごと**の演算で、ビット列の長さが
    // 2 以上なら結果も同じ長さのビット列になる。短い側は '0'B で埋める。
    // 以前は常に 1 ビットへ潰していたため、`'1100'B & '1010'B` が
    // '1'B になっていた（BIT(1) のときだけブール演算と一致するので、
    // 比較結果しか試していないテストでは気づけなかった）。
    if (op === "&" || op === "|") {
      if (a.t === "bit" && b.t === "bit" && (a.v.length > 1 || b.v.length > 1)) {
        const n = Math.max(a.v.length, b.v.length);
        const x = a.v.padEnd(n, "0");
        const y = b.v.padEnd(n, "0");
        let out = "";
        for (let i = 0; i < n; i++) {
          const bitA = x[i] === "1";
          const bitB = y[i] === "1";
          out += (op === "&" ? bitA && bitB : bitA || bitB) ? "1" : "0";
        }
        return makeBit(out, n);
      }
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
      try {
        return floatArith(op, a, b, line);
      } catch (err) {
        // FLOAT の 0 除算も ZERODIVIDE 条件にする。
        // FIXED 側だけ条件にしていると ON 単位が片方でしか効かない
        if (err instanceof ZeroDivide) this.raise("ZERODIVIDE", this.currentScope, line);
        throw err;
      }
    }

    const x = asFixed(a, line);
    const y = asFixed(b, line);
    try {
      switch (op) {
        case "+": return add(x, y);
        case "-": return sub(x, y);
        case "*": return mul(x, y);
        case "/": return div(x, y);
        case "**":
          // 指数が整数でない、または負なら FLOAT で計算する（PL/I の規定）。
          // `4 ** 1.5` は 8、`2 ** -1` は 0.5
          if (powNeedsFloat(y)) return floatArith("**", a, b, line);
          // 整数の指数でも、規定の精度 p = (p1+1)*y - 1 が最大精度を
          // 超えるなら FLOAT。実機で境目を確かめた（`2**10` が FLOAT）
          if (!powFitsFixed(x, y)) return floatArith("**", a, b, line);
          return pow(x, y);
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

    // 構造体をスカラの位置で使った。0 を返すと無言で間違うので断る
    const group = scope.lookupGroup(key);
    if (group !== undefined) {
      throw new RuntimeError(
        `${ref.name} は構造体です。値として使うには項目を指定してください` +
          `（例: ${ref.name}.${(group[0] ?? "").split(".").pop() ?? "項目"}）`,
        line,
      );
    }

    const proc = scope.lookupProc(key);
    if (proc) {
      // 関数としての呼び出しも引数は参照渡し（PL/I の規定）
      const r = this.callProcedure(proc, this.bindArgs(ref.subscripts, scope, line), scope);
      if (r === undefined) {
        throw new RuntimeError(`手続き ${ref.name} は値を返しません`, line);
      }
      return r;
    }

    const args = ref.subscripts.map((a) => this.eval(a, scope, line));
    const builtin = this.builtin(key, args, line, scope, ref.subscripts);
    if (builtin !== undefined) return builtin;

    // 括弧を書いた参照は関数呼び出し。`date()` のように引数が無くても同じ。
    // ここを `subscripts.length > 0` だけで見ると、引数ゼロの呼び出しが
    // 「未宣言のスカラ」に落ちて暗黙宣言の 0 になる
    if (ref.subscripts.length > 0 || ref.called === true) {
      // 知っている組込関数なら「未実装」と言う。
      // 「未知の関数」だと綴り間違いと区別が付かない
      if (UNIMPLEMENTED_BUILTINS.has(key)) {
        throw new Unsupported(`組込関数 ${ref.name}`, line);
      }
      if (this.externalEntries.has(ref.name.toUpperCase())) {
        throw new RuntimeError(
          `${ref.name} は ENTRY で宣言された外部手続きです。` +
            "この処理系は 1 ファイル完結なので呼び出せません",
          line,
        );
      }
      throw new RuntimeError(`${ref.name} は未知の関数です`, line);
    }
    // 知っている組込関数で未実装のものは名指しで断る。
    // 暗黙宣言に落とすと 0 を返して無言で間違う
    if (UNIMPLEMENTED_BUILTINS.has(key)) {
      throw new Unsupported(`組込関数 ${ref.name}`, line);
    }
    // 未宣言のスカラ参照は暗黙宣言の初期値（PL/I の規定）
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
        if (b.v === 0n) this.raise("ZERODIVIDE", scope, line);
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
        /*
         * ROUND(x, n) は小数第 n 位に丸める。
         *
         * BigInt で直接計算する。以前は `0.05` のような 10 進の値を足して
         * `assignTo` で桁を落としていたが、2 つの問題があった。
         *   - BINARY の値に DECIMAL の `half` を足すので基数混在になる
         *   - `n > q` のとき `assignTo(.., a.p, n)` が整数桁を縮めて
         *     誤って FIXEDOVERFLOW になる（`ROUND(12.5, 3)`）
         * 結果の精度は「整数桁 + n」で、桁が減ることはない。
         */
        const a = fx(0);
        const n = int(1);
        if (n >= a.q) {
          // 落とす桁が無い。精度を広げ、**尺度も n に合わせる**。
          // 実機で確認: `dcl x fixed dec(5,1); x = 12.5;` のとき
          // round(x,3) が 12.500（尺度 3）、round(x,1) が 12.5、round(x,0) が 13。
          // 以前は元の尺度を保っていたので round(x,3) が 12.5 になっていた
          return assignTo(a, a.base, roundPrecision(a, n), Math.max(0, n));
        }
        const r = a.base === "bin" ? 2n : 10n;
        const drop = a.q - n;
        const scale = ipow(r, drop);
        const neg = a.v < 0n;
        const abs = neg ? -a.v : a.v;
        // 0 から遠い側へ丸める（half away from zero）
        const rounded = (abs * 2n + scale) / (scale * 2n);
        return makeFixed(a.base, roundPrecision(a, n), n, neg ? -rounded : rounded);
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
        if (b.v === 0n) this.raise("ZERODIVIDE", scope, line);
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
        const times = int(1) + 1;
        // 結果長を先に確かめる。作ってから確かめると、
        // 1 回の呼び出しでメモリを使い切れる
        this.checkLength(s.length * Math.max(0, times), line);
        return makeChar(s.repeat(Math.max(0, times)), undefined, true);
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
/**
 * `ROUND(x, n)` の結果の精度。
 *
 * 整数桁 + n に **1 桁足す**。丸めが桁上がりすることがあるため
 * （`round(9.9, 0)` は 10 で、整数桁 1 のままでは入らない）。
 * 実機（Iron Spring PL/I 1.4.1）の出力幅と一致する:
 *   dcl x fixed dec(5,1) に round(x,3) → 幅 11（p=8, q=3）
 *   round(1.005, 2) → 幅 7（p=4, q=2）
 */
function roundPrecision(a: FixedVal, n: number): number {
  return Math.min(
    a.base === "bin" ? MAX_BIN : MAX_DEC,
    Math.max(1, a.p - a.q) + Math.max(0, n) + 1,
  );
}

function floatArith(op: string, a: Value, b: Value, line: number): Value {
  const num = (v: Value): number => {
    if (v.t === "float") return v.v;
    if (v.t === "fixed") return Number(render(v));
    throw new RuntimeError("数値として扱えません", line);
  };
  // 結果の精度は両辺の精度の大きい方。**FIXED の辺も数に入れる**
  // （FIXED(p,q) は FLOAT(p) に変換されてから演算されるため）。
  // 実機で確認: 4**1.5 / 9**0.5 / 2**10 はどれも FLOAT DEC(2) で
  // 出力幅 10（" 8.0E+0000"）。以前は FLOAT の辺だけ見ていたので幅 9 だった
  const p = Math.max(
    a.t === "float" || a.t === "fixed" ? a.p : 0,
    b.t === "float" || b.t === "fixed" ? b.p : 0,
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
      // ZeroDivide を投げる。applyBinary の catch が ZERODIVIDE 条件に変える。
      // RuntimeError のままだと ON 単位へ届かない
      if (y === 0) throw new ZeroDivide();
      v = x / y;
      break;
    case "**": v = x ** y; break;
    default:
      throw new Unsupported(`FLOAT に対する演算子 ${op}`, line);
  }
  // Infinity / NaN をそのまま返すと `render` が "Infinity" を出す。
  // 数でないものを数として扱わない
  if (!Number.isFinite(v)) {
    throw new RuntimeError(
      Number.isNaN(v) ? "計算結果が数になりません" : "浮動小数点の桁あふれです",
      line,
    );
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

/** 2 つのデータ属性が同じか。参照渡しにできるかの判定に使う。 */
function sameAttr(a: DataAttr, b: DataAttr): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "fixed":
      return b.type === "fixed" && a.base === b.base && a.p === b.p && a.q === b.q;
    case "float":
      return b.type === "float" && a.base === b.base && a.p === b.p;
    case "char":
      return b.type === "char" && a.length === b.length && a.varying === b.varying;
    case "bit":
      return b.type === "bit" && a.length === b.length;
    case "picture":
      return b.type === "picture" && a.picture === b.picture;
    default:
      return true;
  }
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
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) {
    throw new RuntimeError(`数値として扱えません: ${clip(v.v)}`, line);
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
/**
 * 処理系が受け持つサブルーチン。CALL でしか呼べず、値は返さない。
 *
 * 組込関数（`BUILTIN_NAMES`）とは別に持つ。`builtin()` の中の case を
 * 数えて組込関数の一覧と突き合わせるテストがあるので、そこへ混ぜない。
 * Linter が「定義されていない手続き」と取り違えないためにも公開する。
 */
export const BUILTIN_SUBROUTINE_NAMES: ReadonlySet<string> = new Set([
  "PLITDLI", // PL/I から DL/I を呼ぶ入口
  "CBLTDLI", // COBOL 向け。名指しで断るために載せる
  "ASMTDLI", // アセンブラ向け。同上
  "AIBTDLI", // AIB インタフェース。未実装として断る
]);

/** PCB マスクの規定の並び。葉の名前ではなく、この順で結び付ける。 */
function pcbLayout(
  pcb: PcbState,
  io?: IoPcbState,
): { name: string; attr: DataAttr; value: () => Value }[] {
  const chars = (v: string, n: number): Value => makeChar(v, n, false);
  const num = (n: number): Value => makeFixed("bin", MAX_BIN, 0, BigInt(n));
  const keylen = Math.max(1, pcb.def.keylen);
  const char = (length: number): DataAttr => ({ type: "char", length, varying: false });
  const binary: DataAttr = { type: "fixed", base: "bin", p: MAX_BIN, q: 0 };
  if (pcb.def.kind === "io") {
    // 入出力 PCB。DB の PCB とは並びも項目も違う
    const dec = (p: number, q: number): DataAttr => ({ type: "fixed", base: "dec", p, q });
    const packed = (v: number, q: number): Value => makeFixed("dec", 7, q, BigInt(Math.round(v * 10 ** q)));
    const state: IoPcbState = io ?? {
      lterm: "",
      status: pcb.status,
      date: 0,
      time: 0,
      seq: 0,
      modName: "",
      userid: "",
    };
    return [
      { name: "LTERM_NAME", attr: char(8), value: () => chars(state.lterm, 8) },
      { name: "RESERVED1", attr: char(2), value: () => chars("", 2) },
      { name: "STAT_CODE", attr: char(2), value: () => chars(pcb.status, 2) },
      { name: "DATE", attr: dec(7, 0), value: () => packed(state.date, 0) },
      { name: "TIME", attr: dec(7, 1), value: () => packed(state.time, 1) },
      { name: "MSG_SEQ", attr: binary, value: () => num(state.seq) },
      { name: "MOD_NAME", attr: char(8), value: () => chars(state.modName, 8) },
      { name: "USER_ID", attr: char(8), value: () => chars(state.userid, 8) },
    ];
  }
  return [
    { name: "DBNAME", attr: char(8), value: () => chars(pcb.def.dbdName ?? "", 8) },
    {
      name: "SEG_LEVEL",
      attr: char(2),
      value: () => chars(pcb.level === 0 ? "" : String(pcb.level).padStart(2, "0"), 2),
    },
    { name: "STAT_CODE", attr: char(2), value: () => chars(pcb.status, 2) },
    { name: "PROC_OPT", attr: char(4), value: () => chars(pcb.def.procopt, 4) },
    { name: "RESERVED", attr: binary, value: () => num(0) },
    { name: "SEG_NAME", attr: char(8), value: () => chars(pcb.segName, 8) },
    { name: "LEN_KFB", attr: binary, value: () => num(pcb.keyFeedback.length) },
    { name: "NO_SENSEG", attr: binary, value: () => num(pcb.def.senseg.size) },
    { name: "KEY_FB", attr: char(keylen), value: () => chars(pcb.keyFeedback, keylen) },
  ];
}

/**
 * PL/I の組込関数のうち、この処理系が実装していないもの。
 *
 * **名指しで断るために持つ。** これが無いと、宣言の無い名前として
 * 暗黙宣言の規則に落ち、`ONCODE` も `DATE` も `SQRT` も黙って 0 を返す。
 * 「できないことは黙って動かさず、何が未実装かを名指しで断る」という
 * この処理系の約束は、名前を知っていないと守れない。
 *
 * 利用者が同じ名前で変数や手続きを宣言した場合は、宣言が優先される
 * （`lookupVar` / `lookupProc` を先に見るため）。
 *
 * 構文強調の `support.function.unimplemented.pli` と同じ集合で、
 * `vscode-pli/test/grammar.test.ts` が食い違いを拾う。
 */
export const UNIMPLEMENTED_BUILTINS: ReadonlySet<string> = new Set([
  "ACOS",
  "ADD",
  "ALLOCATION",
  "ASIN",
  "ATAN",
  "ATAND",
  "ATANH",
  "BINARYVALUE",
  "BIT",
  "BOOL",
  "BYTE",
  "CHARACTER",
  "CHARVAL",
  "COLLATE",
  "COMPLEX",
  "CONJG",
  "COPY",
  "COS",
  "COSD",
  "COSH",
  "COUNT",
  "CURRENTSTORAGE",
  "DATE",
  "DATETIME",
  "DAYS",
  "DAYSTODATE",
  "DECAT",
  "DECIMAL",
  "DIMENSION",
  "EMPTY",
  "ERF",
  "ERFC",
  "EXP",
  "FIXED",
  "FLOAT",
  "HEX",
  "HEXIMAGE",
  "HIGH",
  "IMAG",
  "LINENO",
  "LOG",
  "LOG10",
  "LOG2",
  "LOW",
  "MAXLENGTH",
  "MULTIPLY",
  "OFFSET",
  "OMITTED",
  "ONCHAR",
  "ONCODE",
  "ONCONDID",
  "ONFILE",
  "ONKEY",
  "ONLOC",
  "ONSOURCE",
  "PAGENO",
  "POINTER",
  "PREC",
  "PRECISION",
  "RANDOM",
  "RANK",
  "REAL",
  "REVERSE",
  "SIN",
  "SIND",
  "SINH",
  "SQRT",
  "STORAGE",
  "STRING",
  "SUM",
  "TAN",
  "TAND",
  "TANH",
  "TIME",
  "TRIM",
  "UNSPEC",
  "VALID",
]);

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
