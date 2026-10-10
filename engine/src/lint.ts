/**
 * PL/I の Linter。
 *
 * 構文解析が通ったうえで、**動くけれども怪しい**書き方を指摘する。
 * 構文の誤りは `run.ts` の診断が出すので、ここでは扱わない。
 *
 * 規則は 3 つに分かれる。
 *   correctness — 誤りか、誤りの元になるもの
 *   style       — 読みやすさの問題
 *
 * 位置の精度について。式の節点は行を持たないため、指摘は**文の行**を指す。
 */

import type { DataAttr, DeclItem, Expr, FormatItem, Program, Ref, Stmt } from "./ast.js";
import { groupNames, qualifyDeclareItems } from "./declare.js";
import {
  BUILTIN_NAMES,
  BUILTIN_SUBROUTINE_NAMES,
  UNIMPLEMENTED_BUILTINS,
} from "./interp.js";
import { parse } from "./parser.js";
import type { PliHost } from "./host.js";
import { ASSERT_PROCEDURES, isTestSource } from "./testing.js";

export type LintSeverity = "error" | "warning" | "info";
export type RuleSetting = LintSeverity | "off";
export type LintCategory = "correctness" | "style";

export interface LintRule {
  id: string;
  category: LintCategory;
  /** 既定の扱い。 */
  default: RuleSetting;
  summary: string;
  /** なぜ指摘するのか。説明できない規則は置かない。 */
  rationale: string;
}

/** 規則の一覧。 */
export const RULES: readonly LintRule[] = [
  {
    id: "implicit-declaration",
    category: "correctness",
    default: "warning",
    summary: "宣言していない名前を使っている",
    rationale:
      "PL/I は宣言の無い名前を暗黙に宣言する（I〜N は FIXED BIN(15,0)、" +
      "それ以外は FLOAT DEC(6)）。綴り間違いが黙って別の変数になるため、" +
      "気付けないまま誤った値で動き続ける。",
  },
  {
    id: "undefined-procedure",
    category: "correctness",
    default: "error",
    summary: "定義されていない手続きを呼んでいる",
    rationale: "この処理系は 1 ファイル完結なので、実行時に必ず失敗する。",
  },
  {
    id: "unused-variable",
    category: "correctness",
    default: "warning",
    summary: "宣言したが一度も使っていない変数",
    rationale: "消し忘れか、別の名前を使うつもりだった綴り間違いのどちらか。",
  },
  {
    id: "assigned-but-never-read",
    category: "correctness",
    default: "warning",
    summary: "代入しているが一度も読んでいない変数",
    rationale:
      "計算した結果を捨てている。出力し忘れか、読む側で別の名前を書いている。",
  },
  {
    id: "never-assigned",
    category: "correctness",
    default: "warning",
    summary: "値を入れずに読んでいる変数",
    rationale:
      "INITIAL も代入も無い変数を読むと、この処理系では 0 や空白になる。" +
      "処理系によっては記憶域の内容に依存し、結果が環境で変わる。",
  },
  {
    id: "unused-procedure",
    category: "correctness",
    default: "warning",
    summary: "定義したが呼ばれていない手続き",
    rationale:
      "呼び忘れか、呼ぶ側の綴り間違い。テスト手続き（TEST_）と SETUP / TEARDOWN は" +
      "フレームワークが呼ぶので対象にしない。",
  },
  {
    id: "shadows-builtin",
    category: "correctness",
    default: "warning",
    summary: "組込関数と同じ名前を宣言している",
    rationale:
      "PL/I には予約語が無いため宣言できてしまうが、そのブロックでは" +
      "組込関数を呼べなくなる。SUBSTR や LENGTH で起きると原因が分かりにくい。",
  },
  {
    id: "missing-main",
    category: "correctness",
    default: "warning",
    summary: "OPTIONS(MAIN) を持つ手続きが無い",
    rationale:
      "実行の入口が無いので動かせない。テストファイル（TEST_ 手続きを持つもの）は" +
      "主手続きを書かない決まりなので対象にしない。",
  },
  {
    id: "mixed-base-arithmetic",
    category: "correctness",
    default: "warning",
    summary: "FIXED DECIMAL と FIXED BINARY を混ぜて計算している",
    rationale:
      "PL/I は基数が混ざると BINARY に変換して計算する。10 進で持っていた桁が" +
      "2 進の精度に落ちる。13 の階乗のような計算は FIXEDOVERFLOW になる。" +
      "どちらかに揃えるか、DIVIDE / 明示の宣言で意図を書く。",
  },
  {
    id: "file-not-declared",
    category: "correctness",
    default: "warning",
    summary: "宣言していないファイルを使っている",
    rationale:
      "PL/I は宣言の無いファイル名に既定属性を割り当てて続行する。" +
      "綴り間違いでも通ってしまい、別のファイルを開いたことに気付けない。" +
      "SYSIN と SYSPRINT は既定で使えるので対象にしない。",
  },
  {
    id: "dli-status-unchecked",
    category: "correctness",
    default: "warning",
    summary: "DL/I を呼んだのにステータスコードを見ていない",
    rationale:
      "DL/I は失敗しても例外を出さず、PCB のステータスコードで知らせる。" +
      "見ないと「取れなかったセグメント」を取れたものとして処理してしまう。" +
      "IMS のプログラムで最も多い誤りなので、一度も読んでいなければ指摘する。",
  },
  {
    id: "endfile-without-on",
    category: "correctness",
    default: "warning",
    summary: "ON ENDFILE を置かずにファイルから読んでいる",
    rationale:
      "入力が尽きた時点で ENDFILE 条件が起き、ON 単位が無ければ ERROR へ連鎖して" +
      "プログラムが終わる。読み終わりを自分で扱うなら ON ENDFILE が要る。",
  },
  {
    id: "free-then-use",
    category: "correctness",
    default: "warning",
    summary: "FREE したポインタをそのまま使っている",
    rationale:
      "解放した記憶域を指すポインタをたどると、この処理系は誤りとして止める。" +
      "PL/I の規定では未定義動作で、たまたま動くこともあるぶん質が悪い。" +
      "FREE のあとは NULL を入れ直すか、別のポインタを使う。",
  },
  {
    id: "goto-outside-on-unit",
    category: "style",
    default: "info",
    summary: "ON 単位の外で GOTO を使っている",
    rationale:
      "ON 単位からの脱出には GOTO が要るが、それ以外の場所では" +
      "DO 群・LEAVE・ITERATE・SELECT で書ける。",
  },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** 入れ子を含めて全ての文に関数を当てる。 */
function forEachStmt(body: readonly Stmt[], fn: (s: Stmt) => void): void {
  for (const s of body) {
    fn(s);
    switch (s.kind) {
      case "procedure":
      case "doGroup":
      case "doWhile":
      case "doUntil":
      case "doIter":
      case "beginBlock":
        forEachStmt(s.body, fn);
        break;
      case "if":
        forEachStmt(s.else === undefined ? [s.then] : [s.then, s.else], fn);
        break;
      case "select":
        forEachStmt(
          [...s.whens.map((w) => w.body), ...(s.otherwise ? [s.otherwise] : [])],
          fn,
        );
        break;
      case "on":
        // `ON ... SYSTEM;` は本体を持たない（既定動作へ戻すだけ）
        if (s.body !== undefined) forEachStmt([s.body], fn);
        break;
      default:
        break;
    }
  }
}

export interface LintMessage {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** 1 始まりの行番号。 */
  line: number;
  /** 1 始まりの桁。字句から拾えた場合のみ。 */
  col?: number;
}

export interface LintOptions {
  /** 規則ごとの上書き。`"off"` で無効にする。 */
  rules?: Record<string, RuleSetting>;
  /** `%INCLUDE` の解決に使う。渡さないと取り込みのあるソースは検査できない。 */
  host?: PliHost;
  /**
   * このソースは単独のプログラムではなく、`%INCLUDE` される断片か。
   *
   * コピーブック（`.inc` / `.cpy` / `.plinc`）は宣言だけを並べた
   * 断片なので、`missing-main` と「使われていない変数」は当たらない。
   * これを渡さないと、開いただけで宣言の数だけ警告が並ぶ。
   */
  fragment?: boolean;
}

/**
 * 配列の形だけを問い合わせる組込関数。
 * 第1引数は名前を指すだけで**値を読まない**ので、
 * 「値を入れる前に読んでいる」の判定から外す。
 */
const SHAPE_BUILTINS = new Set(["LBOUND", "HBOUND", "DIM"]);

/** フレームワークが呼ぶので「呼ばれていない」と言ってはいけない手続き。 */
function calledByFramework(name: string): boolean {
  const u = name.toUpperCase();
  return u.startsWith("TEST_") || u.startsWith("DISABLED_TEST_") || u === "SETUP" || u === "TEARDOWN";
}

interface VarInfo {
  name: string;
  line: number;
  attr: DataAttr;
  isParam: boolean;
  hasInit: boolean;
  /** DEFINED による別名。基底側で値が入るので未代入の判定から外す。 */
  isAlias: boolean;
  reads: number;
  writes: number;
  /** 値は読まないが名前としては使われた回数（LBOUND など）。 */
  mentions: number;
  /**
   * BASED 宣言。ポインタ越しに別の記憶域を見るための窓なので、
   * 「代入したが読んでいない」などの判定から外す。
   */
  isBased?: boolean;
  /**
   * `based(p)` に書いた locator ポインタの名前（大文字）。
   * `ALLOCATE` に `SET` が無いときの暗黙の対象になる。
   */
  basedPointer?: string;
  /**
   * DL/I の PCB マスクの項目。中身は DL/I が埋めるもので、
   * プログラムは必要な項目だけ読む。読まない項目があって当然なので
   * 「代入したが読んでいない」の判定から外す。
   */
  isDliPcb?: boolean;
}

interface ProcInfo {
  name: string;
  line: number;
  calls: number;
  /** 主手続きは入口なので、呼ばれていなくても正しい。 */
  isMain: boolean;
  /**
   * ENTRY で宣言された外部手続き。実体はこのファイルに無い。
   * %INCLUDE で宣言群をまとめて取り込む書き方が普通なので、
   * 呼ばれていなくても指摘しない。
   */
  isExternal?: boolean;
  /**
   * 自分自身からの呼び出しの回数。
   * 再帰だけでは外から入る道が無いので、`unused-procedure` の判定で引く。
   */
  selfCalls?: number;
}

class LintScope {
  readonly vars = new Map<string, VarInfo>();
  readonly procs = new Map<string, ProcInfo>();
  /** 構造体そのものの名前。記憶域は持たないが参照はできる。 */
  readonly groups = new Set<string>();

  constructor(readonly parent?: LintScope) {}

  lookupVar(name: string): VarInfo | undefined {
    return this.vars.get(name) ?? this.parent?.lookupVar(name);
  }

  lookupProc(name: string): ProcInfo | undefined {
    return this.procs.get(name) ?? this.parent?.lookupProc(name);
  }

  hasName(name: string): boolean {
    if (this.vars.has(name) || this.procs.has(name) || this.groups.has(name)) return true;
    return this.parent?.hasName(name) ?? false;
  }
}

/** 基数（FIXED の 10 進 / 2 進）。混在の判定に使う。 */
function fixedBase(attr: DataAttr | undefined): "dec" | "bin" | undefined {
  // PICTURE は 10 進。FIXED BIN と混ぜると同じ落とし穴になる
  if (attr?.type === "picture") return "dec";
  return attr?.type === "fixed" ? attr.base : undefined;
}

/** 宣言しなくても使えるファイル。 */
const BUILTIN_FILES = new Set(["SYSIN", "SYSPRINT"]);

class Linter {
  private readonly messages: LintMessage[] = [];
  /** 宣言されたファイル名。 */
  private readonly declaredFiles = new Set<string>();
  /** OPEN されたファイル名（いまは報告に使っていないが、規則を足す足場）。 */
  private readonly openedFiles = new Set<string>();
  /** ON ENDFILE が置かれているファイル名。空文字はファイル指定なし。 */
  private readonly endfileCovered = new Set<string>();
  /** 既に file-not-declared を出した名前（1 ファイルにつき 1 回）。 */
  private readonly reportedFiles = new Set<string>();
  /**
   * FREE に使われたポインタの名前。
   * そのあと同じ名前で参照していたら指摘する（単純な直線の流れのみ）。
   */
  private readonly freedPointers = new Set<string>();
  /** テストファイルならフレームワークが入れる手続きを既知として扱う。 */
  private readonly injected: ReadonlySet<string>;

  constructor(
    private readonly source: string,
    private readonly severity: (id: string) => LintSeverity | undefined,
    isTest: boolean,
    private readonly fragment = false,
  ) {
    this.injected = isTest ? ASSERT_PROCEDURES : new Set<string>();
  }

  report(rule: string, line: number, message: string, col?: number): void {
    const sev = this.severity(rule);
    if (sev === undefined) return;
    this.messages.push({ rule, severity: sev, message, line, ...(col === undefined ? {} : { col }) });
  }

  enabled(rule: string): boolean {
    return this.severity(rule) !== undefined;
  }

  run(program: Program): LintMessage[] {
    // ON ENDFILE は GET より後ろに書かれていても実行時には先に効くので、
    // 走査の前に全体から集めておく
    forEachStmt(program.body, (st) => {
      if (st.kind === "on" && st.condition.toUpperCase() === "ENDFILE") {
        this.endfileCovered.add((st.conditionFile ?? "").toUpperCase());
      }
      if (st.kind === "declare") {
        for (const item of qualifyDeclareItems(st.items)) {
          if (item.attr.type === "file") {
            for (const n of item.names) this.declaredFiles.add(n.toUpperCase());
          }
        }
      }
    });

    const global = new LintScope();
    this.collect(program.body, global);
    this.walkBody(program.body, global, { inOnUnit: false });
    this.reportUnused(global);

    if (this.enabled("missing-main") && !this.injected.size && !this.fragment) {
      const hasMain = program.body.some((s) => s.kind === "procedure" && s.isMain);
      if (!hasMain) {
        const first = program.body[0];
        this.report(
          "missing-main",
          first && "line" in first ? first.line : 1,
          "OPTIONS(MAIN) を持つ手続きがありません。このままでは実行できません。",
        );
      }
    }

    this.messages.sort((a, b) => a.line - b.line || (a.col ?? 0) - (b.col ?? 0) || a.rule.localeCompare(b.rule));
    return this.messages;
  }


  // ---- 宣言の収集 ----

  /**
   * ブロック内の宣言を集める。
   *
   * PL/I で新しい有効範囲を作るのは PROCEDURE と BEGIN だけなので、
   * DO 群や IF の中の宣言は同じブロックに属する。
   */
  private collect(body: Stmt[], scope: LintScope): void {
    for (const s of body) {
      switch (s.kind) {
        case "declare":
          this.declare(s.items, s.line, scope);
          break;
        case "procedure":
          scope.procs.set(s.name.toUpperCase(), {
            name: s.name,
            line: s.line,
            calls: 0,
            isMain: s.isMain,
          });
          break;
        case "doGroup":
        case "doWhile":
        case "doUntil":
        case "doIter":
          this.collect(s.body, scope);
          break;
        case "if":
          this.collect([s.then], scope);
          if (s.else) this.collect([s.else], scope);
          break;
        case "select":
          for (const w of s.whens) this.collect([w.body], scope);
          if (s.otherwise) this.collect([s.otherwise], scope);
          break;
        case "on":
          if (s.body !== undefined) this.collect([s.body], scope);
          break;
        default:
          break;
      }
    }
  }

  private declare(items: DeclItem[], line: number, scope: LintScope): void {
    for (const name of groupNames(items)) scope.groups.add(name.toUpperCase());

    for (const item of qualifyDeclareItems(items)) {
      // ファイル宣言は記憶域を持たない。名前だけ覚える
      if (item.attr.type === "file") {
        for (const name of item.names) this.declaredFiles.add(name.toUpperCase());
        continue;
      }
      // 外部手続きの宣言。手続きとして登録する
      if (item.attr.type === "entry") {
        for (const name of item.names) {
          scope.procs.set(name.toUpperCase(), {
            name,
            line,
            calls: 0,
            isMain: false,
            isExternal: true,
          });
        }
        continue;
      }
      for (const name of item.names) {
        const key = name.toUpperCase();
        if (this.enabled("shadows-builtin") && BUILTIN_NAMES.has(key)) {
          this.report(
            "shadows-builtin",
            line,
            `${name} は組込関数と同じ名前です。このブロックでは組込関数として呼べなくなります。`,
          );
        }
        const existing = scope.vars.get(key);
        if (existing?.isParam) {
          // 引数名の DECLARE は属性の宣言であって新しい変数ではない
          existing.attr = item.attr;
          continue;
        }
        scope.vars.set(key, {
          name,
          line,
          attr: item.attr,
          isParam: false,
          hasInit: item.init !== undefined,
          isAlias: item.defined !== undefined,
          reads: 0,
          writes: 0,
          mentions: 0,
          ...(item.based === undefined ? {} : { isBased: true }),
          ...(item.based?.pointer === undefined
            ? {}
            : { basedPointer: item.based.pointer.name.toUpperCase() }),
        });
        // DEFINED の基底は参照されたとみなす
        if (item.defined) this.read(item.defined, scope, line);

      }
    }
  }

  // ---- 参照の記録 ----

  /** ポインタに新しい値が入ったら「解放済み」ではなくなる。 */
  private clearFreed(ref: Ref): void {
    this.freedPointers.delete(ref.name.toUpperCase());
  }

  /**
   * BASED 変数を修飾なしで参照したときの locator の扱い。
   *
   * `dcl cell fixed bin based(p); cell = 5;` は、処理系が `p` を
   * たどって記憶域を見る。数えないと `p` が
   * 「代入したが一度も読んでいない」に見える（BASED の典型形で必ず出る）。
   */
  private readBasedLocator(v: VarInfo | undefined, scope: LintScope): void {
    if (v?.basedPointer === undefined) return;
    const ptr = scope.lookupVar(v.basedPointer);
    if (ptr) ptr.reads++;
  }

  private read(ref: Ref, scope: LintScope, line: number, asMention = false): void {
    const key = ref.name.toUpperCase();
    // FREE したポインタでの修飾は、解放済みの記憶域をたどることになる
    if (ref.locator && this.freedPointers.has(ref.locator.name.toUpperCase())) {
      this.report(
        "free-then-use",
        line,
        `${ref.locator.name} は FREE 済みです。この参照は解放済みの記憶域をたどります。`,
      );
    }
    const v = scope.lookupVar(key);
    if (v) {
      if (asMention) v.mentions++;
      else v.reads++;
      if (ref.locator === undefined) this.readBasedLocator(v, scope);
    } else if (scope.lookupProc(key)) {
      // 関数としての呼び出し
      scope.lookupProc(key)!.calls++;
    } else if (!BUILTIN_NAMES.has(key) && !this.injected.has(key) && !scope.hasName(key)) {
      this.implicit(ref.name, line, ref.subscripts.length > 0);
    }
    if (ref.locator) this.read(ref.locator, scope, line);
    if (SHAPE_BUILTINS.has(key) && !scope.lookupVar(key)) {
      // LBOUND(a, 1) の a は値を読まない
      const [first, ...rest] = ref.subscripts;
      if (first?.kind === "ref") this.read(first, scope, line, true);
      else if (first) this.expr(first, scope, line);
      for (const e of rest) this.expr(e, scope, line);
      return;
    }
    for (const sub of ref.subscripts) this.expr(sub, scope, line);
  }

  private write(ref: Ref, scope: LintScope, line: number): void {
    // SUBSTR 疑似変数への代入は、第1引数の変数への書き込み
    if (ref.name.toUpperCase() === "SUBSTR" && ref.subscripts.length >= 2) {
      const [target, ...rest] = ref.subscripts;
      if (target && target.kind === "ref") this.write(target, scope, line);
      else if (target) this.expr(target, scope, line);
      for (const e of rest) this.expr(e, scope, line);
      return;
    }
    const key = ref.name.toUpperCase();
    if (ref.locator) this.read(ref.locator, scope, line);
    const v = scope.lookupVar(key);
    if (v) {
      v.writes++;
      if (ref.locator === undefined) this.readBasedLocator(v, scope);
    } else if (!scope.hasName(key) && !this.injected.has(key)) {
      this.implicit(ref.name, line);
    }
    for (const sub of ref.subscripts) this.expr(sub, scope, line);
  }

  /**
   * 宣言の無い名前を報告する。
   *
   * `asCall` は「括弧を付けて値として読んだ」場合。
   * この処理系はそれを配列の添字ではなく関数呼び出しと見て
   * 「未知の関数です」で止めるので、暗黙宣言とは違う言い方にする。
   * 揃えないと、Linter が「暗黙に宣言されます」と言ったものが
   * 実行時に止まることになる。
   */
  private implicit(name: string, line: number, asCall = false): void {
    const upperName = name.toUpperCase();
    // 知っている組込関数で未実装のものは、そう言う。
    // 「暗黙に宣言されます」と言うと、実行すると止まるので嘘になる
    if (UNIMPLEMENTED_BUILTINS.has(upperName)) {
      this.report(
        "implicit-declaration",
        line,
        `${name} は PL/I の組込関数ですが、この処理系では未実装です。` +
          "使うと実行時に止まります。",
      );
      return;
    }
    if (asCall) {
      this.report(
        "implicit-declaration",
        line,
        `${name} は宣言されていません。関数として呼ぶと実行時に「未知の関数です」で止まります。`,
      );
      return;
    }
    const upper = name.toUpperCase();
    const first = upper[0] ?? "";
    const kind =
      first >= "I" && first <= "N" ? "FIXED BIN(15,0)" : "FLOAT DEC(6)";
    this.report(
      "implicit-declaration",
      line,
      `${name} は宣言されていません。暗黙に ${kind} として宣言されます。`,
    );
  }

  private expr(e: Expr, scope: LintScope, line: number): void {
    switch (e.kind) {
      case "ref":
        this.read(e, scope, line);
        return;
      case "unary":
        this.expr(e.operand, scope, line);
        return;
      case "binary":
        this.expr(e.left, scope, line);
        this.expr(e.right, scope, line);
        this.checkMixedBase(e.op, e.left, e.right, scope, line);
        return;
      default:
        return;
    }
  }

  /** FIXED DEC と FIXED BIN の混在。基数が混ざると BINARY に変換される。 */
  private checkMixedBase(
    op: string,
    left: Expr,
    right: Expr,
    scope: LintScope,
    line: number,
  ): void {
    if (!this.enabled("mixed-base-arithmetic")) return;
    if (!"+-*/".includes(op) || op.length !== 1) return;
    const base = (e: Expr): "dec" | "bin" | undefined =>
      e.kind === "ref" && e.subscripts.length === 0
        ? fixedBase(scope.lookupVar(e.name.toUpperCase())?.attr)
        : undefined;
    const l = base(left);
    const r = base(right);
    if (l && r && l !== r) {
      this.report(
        "mixed-base-arithmetic",
        line,
        "FIXED DECIMAL と FIXED BINARY を混ぜて計算しています。" +
          "結果は BINARY に変換され、10 進の桁が失われます。",
      );
    }
  }

  private format(items: FormatItem[], scope: LintScope, line: number): void {
    for (const f of items) {
      switch (f.kind) {
        case "a":
        case "b":
          if (f.width) this.expr(f.width, scope, line);
          break;
        case "f":
        case "e":
          this.expr(f.width, scope, line);
          if (f.decimals) this.expr(f.decimals, scope, line);
          break;
        case "x":
          this.expr(f.width, scope, line);
          break;
        case "column":
          this.expr(f.at, scope, line);
          break;
        case "fskip":
          if (f.count) this.expr(f.count, scope, line);
          break;
        case "repeat":
          this.expr(f.count, scope, line);
          this.format(f.items, scope, line);
          break;
        default:
          break;
      }
    }
  }

  // ---- 文の走査 ----

  private walkBody(body: Stmt[], scope: LintScope, ctx: WalkCtx): void {
    for (const s of body) this.walk(s, scope, ctx);
  }

  private walk(s: Stmt, scope: LintScope, ctx: WalkCtx): void {
    switch (s.kind) {
      case "procedure": {
        const inner = new LintScope(scope);
        for (const p of s.params) {
          inner.vars.set(p.toUpperCase(), {
            name: p,
            line: s.line,
            attr: { type: "float", base: "dec", p: 6 },
            isParam: true,
            hasInit: false,
            isAlias: false,
            reads: 0,
            writes: 0,
            mentions: 0,
          });
        }
        this.collect(s.body, inner);
        this.walkBody(s.body, inner, { ...ctx, proc: s.name.toUpperCase() });
        this.reportUnused(inner);
        return;
      }
      case "declare":
        // 宣言は collect 済み。INITIAL の式だけ見る
        for (const item of qualifyDeclareItems(s.items)) {
          for (const e of item.init ?? []) this.expr(e, scope, s.line);
        }
        return;
      case "assign":
        this.expr(s.value, scope, s.line);
        this.write(s.target, scope, s.line);
        return;
      case "put":
        if (s.file !== undefined) this.useFile(s.file, s.line, "output");
        for (const o of s.options) {
          if (o.kind === "line") this.expr(o.at, scope, s.line);
          if (o.kind === "skip" && o.count) this.expr(o.count, scope, s.line);
          if (o.kind === "list") for (const e of o.items) this.expr(e, scope, s.line);
          if (o.kind === "edit") {
            for (const e of o.items) this.expr(e, scope, s.line);
            this.format(o.format, scope, s.line);
          }
        }
        return;
      case "get":
        if (s.source.kind === "string") this.expr(s.source.expr, scope, s.line);
        else this.useFile(s.source.name, s.line, "input");
        if (s.skip) this.expr(s.skip, scope, s.line);
        for (const t of s.targets) this.write(t, scope, s.line);
        if (s.format) this.format(s.format, scope, s.line);
        return;
      case "open":
        for (const f of s.files) {
          this.useFile(f.name, s.line, f.attrs.mode ?? "output", false);
          this.openedFiles.add(f.name.toUpperCase());
          for (const e of [f.attrs.lineSize, f.attrs.pageSize, f.attrs.title]) {
            if (e) this.expr(e, scope, s.line);
          }
        }
        return;
      case "close":
        for (const name of s.files) this.useFile(name, s.line, "output", false);
        return;
      case "record": {
        this.useFile(s.file, s.line, s.op === "read" ? "input" : "output");
        // INTO は書き込み、FROM は読み出し。構造体なら葉も同じ扱い
        if (s.into) this.writeWhole(s.into, scope, s.line);
        if (s.from) this.readWhole(s.from, scope, s.line);
        if (s.set) this.write(s.set, scope, s.line);
        return;
      }
      case "allocate": {
        const v = scope.lookupVar(s.name.toUpperCase());
        if (v) v.writes++;
        if (s.set) {
          this.write(s.set, scope, s.line);
          // 再確保したので「解放済み」ではなくなる
          this.freedPointers.delete(s.set.name.toUpperCase());
        } else if (v?.basedPointer !== undefined) {
          // SET が無ければ宣言の based(p) が対象。
          // その p は「書かれた」ので assigned-but-never-read に出さない
          const ptr = scope.lookupVar(v.basedPointer);
          if (ptr) ptr.writes++;
          this.freedPointers.delete(v.basedPointer);
        }
        return;
      }
      case "free":
        for (const ref of s.refs) {
          if (ref.locator) {
            this.read(ref.locator, scope, s.line);
            this.freedPointers.add(ref.locator.name.toUpperCase());
          }
        }
        return;
      case "if":
        this.expr(s.cond, scope, s.line);
        this.walk(s.then, scope, ctx);
        if (s.else) this.walk(s.else, scope, ctx);
        return;
      case "doGroup":
        this.walkBody(s.body, scope, ctx);
        return;
      case "doWhile":
      case "doUntil":
        this.expr(s.cond, scope, s.line);
        this.walkBody(s.body, scope, ctx);
        return;
      case "doIter": {
        const ref: Ref = { kind: "ref", name: s.varName, subscripts: [] };
        this.write(ref, scope, s.line);
        // 制御変数は条件判定で読まれる
        this.read(ref, scope, s.line);
        for (const spec of s.specs) {
          this.expr(spec.from, scope, s.line);
          if (spec.to) this.expr(spec.to, scope, s.line);
          if (spec.by) this.expr(spec.by, scope, s.line);
        }
        this.walkBody(s.body, scope, ctx);
        return;
      }
      case "beginBlock": {
        const inner = new LintScope(scope);
        this.collect(s.body, inner);
        this.walkBody(s.body, inner, ctx);
        this.reportUnused(inner);
        return;
      }
      case "select":
        if (s.subject) this.expr(s.subject, scope, s.line);
        for (const w of s.whens) {
          for (const v of w.values) this.expr(v, scope, s.line);
          this.walk(w.body, scope, ctx);
        }
        if (s.otherwise) this.walk(s.otherwise, scope, ctx);
        return;
      case "on":
        if (s.body !== undefined) this.walk(s.body, scope, { ...ctx, inOnUnit: true });
        return;
      case "call": {
        const key = s.name.toUpperCase();
        const proc = scope.lookupProc(key);
        if (proc) {
          proc.calls++;
          if (ctx.proc === key) proc.selfCalls = (proc.selfCalls ?? 0) + 1;
        }
        else if (
          !BUILTIN_SUBROUTINE_NAMES.has(key) &&
          !this.injected.has(key) &&
          !scope.hasName(key)
        ) {
          this.report(
            "undefined-procedure",
            s.line,
            `${s.name} という手続きは定義されていません。`,
          );
        }
        // `DCL PLITDLI ENTRY;` は外部手続きの宣言なので proc は立つ。
        // 自分で PLITDLI という手続きを書いた場合だけ、ふつうの CALL に戻す
        if (BUILTIN_SUBROUTINE_NAMES.has(key) && (!proc || proc.isExternal)) {
          // PCB は第 3 引数。ステータスコードを見ているかの検査に使う
          const pcbArg = s.args[2];
          if (key === "PLITDLI" && pcbArg?.kind === "ref") {
            const pcbKey = pcbArg.name.toUpperCase();
            if (!this.dliPcbs.has(pcbKey)) this.dliPcbs.set(pcbKey, s.line);
          }
          // DL/I の引数は向きが決まっている。向きに合わせて数えないと
          // 「代入していない」「代入したが読んでいない」を誤検出する。
          //
          //   個数・機能コード・SSA  入力（読むだけ）
          //   PCB                    出力（DL/I が書く）
          //   セグメント I/O 領域    入出力（GET では書き、ISRT では読む）
          s.args.forEach((a, i) => {
            const isPcb = key === "PLITDLI" && i === 2;
            const isIoArea = key !== "PLITDLI" || i === 3;
            if (a.kind === "ref" && (isPcb || isIoArea)) {
              this.writeWhole(a, scope, s.line);
            }
            if (a.kind === "ref" && isIoArea) this.readWhole(a, scope, s.line);
            else if (!isPcb) this.expr(a, scope, s.line);
          });
          return;
        }
        for (const a of s.args) this.expr(a, scope, s.line);
        return;
      }
      case "return":
        if (s.value) this.expr(s.value, scope, s.line);
        return;
      case "goto":
        if (!ctx.inOnUnit) {
          this.report(
            "goto-outside-on-unit",
            s.line,
            "ON 単位の外の GOTO です。DO 群・LEAVE・ITERATE・SELECT で書けないか検討してください。",
          );
        }
        return;
      default:
        return;
    }
  }

  /** 構造体なら葉も含めて書き込み扱いにする（READ INTO(rec) など）。 */
  private writeWhole(ref: Ref, scope: LintScope, line: number): void {
    this.write(ref, scope, line);
    this.eachLeaf(ref.name, scope, (v) => v.writes++);
  }

  /** 構造体なら葉も含めて読み出し扱いにする（WRITE FROM(rec) など）。 */
  private readWhole(ref: Ref, scope: LintScope, line: number): void {
    this.read(ref, scope, line);
    this.eachLeaf(ref.name, scope, (v) => v.reads++);
  }

  /** 修飾名が `name.` で始まる変数に関数を当てる。 */
  private eachLeaf(name: string, scope: LintScope, fn: (v: VarInfo) => void): void {
    const prefix = `${name.toUpperCase()}.`;
    for (let sc: LintScope | undefined = scope; sc; sc = sc.parent) {
      for (const [key, v] of sc.vars) if (key.startsWith(prefix)) fn(v);
    }
  }

  /**
   * ファイルを使ったことを記録し、宣言の有無と ENDFILE の備えを見る。
   */
  /**
   * ファイル名の使用を記録する。
   *
   * `checkEndfile` が偽なら `endfile-without-on` を見ない。
   * `OPEN` と `CLOSE` は**読む文ではない**ので、ここで見ると
   * 実際に読む `GET` / `READ` の行と二重に出る。
   */
  private useFile(
    name: string,
    line: number,
    mode: "input" | "output" | "update",
    checkEndfile = true,
  ): void {
    const key = name.toUpperCase();
    if (
      !BUILTIN_FILES.has(key) &&
      !this.declaredFiles.has(key) &&
      !this.reportedFiles.has(key)
    ) {
      this.reportedFiles.add(key);
      this.report(
        "file-not-declared",
        line,
        `ファイル ${name} は宣言されていません。既定属性が割り当てられ、そのまま動いてしまいます。`,
      );
    }
    if (
      checkEndfile &&
      mode === "input" &&
      !this.endfileCovered.has(key) &&
      !this.endfileCovered.has("")
    ) {
      this.report(
        "endfile-without-on",
        line,
        `${name} を読んでいますが ON ENDFILE(${name}) がありません。` +
          "入力が尽きるとプログラムが終わります。",
      );
    }
  }



  // ---- 使われていないものの報告 ----

  /** `CALL PLITDLI` に渡された PCB の名前と、最初に呼んだ行。 */
  private readonly dliPcbs = new Map<string, number>();

  /**
   * DL/I を呼んだのにステータスコードを一度も読んでいない PCB を指摘する。
   *
   * ステータスコードは PCB マスクの 3 番目の項目。名前は自由に付けられる
   * ので、名前ではなく位置で見る（処理系が結び付けるのと同じ規則）。
   */
  private reportDliStatus(scope: LintScope): void {
    for (const [name, line] of this.dliPcbs) {
      const leaves: VarInfo[] = [];
      const prefix = `${name}.`;
      for (const [key, v] of scope.vars) {
        if (key.startsWith(prefix)) leaves.push(v);
      }
      if (leaves.length === 0) continue;
      this.dliPcbs.delete(name);
      for (const v of leaves) v.isDliPcb = true;
      const status = leaves[2];
      if (status === undefined || status.reads > 0) continue;
      this.report(
        "dli-status-unchecked",
        line,
        `${status.name} を一度も読んでいません。DL/I の失敗はステータスコードでしか分かりません。`,
      );
    }
  }

  private reportUnused(scope: LintScope): void {
    this.reportDliStatus(scope);
    // 断片（コピーブック）は、宣言を取り込んだ側が使う。
    // ここだけ見て「使われていない」とは言えない
    if (this.fragment) return;
    for (const v of scope.vars.values()) {
      if (v.isParam) continue; // 引数は呼ぶ側の都合なので対象にしない
      if (v.isBased) continue; // BASED は別の記憶域を見るための窓
      if (v.isDliPcb) continue; // PCB マスクは DL/I が埋める
      if (v.reads === 0 && v.writes === 0 && v.mentions === 0 && !v.hasInit) {
        this.report("unused-variable", v.line, `${v.name} は宣言されていますが使われていません。`);
      } else if (v.reads === 0 && (v.writes > 0 || v.hasInit)) {
        this.report(
          "assigned-but-never-read",
          v.line,
          `${v.name} に値を入れていますが、一度も読んでいません。`,
        );
      } else if (v.writes === 0 && v.reads > 0 && !v.hasInit && !v.isAlias) {
        this.report(
          "never-assigned",
          v.line,
          `${v.name} は値を入れる前に読まれています。INITIAL か代入が要ります。`,
        );
      }
    }
    for (const p of scope.procs.values()) {
      // 自己呼び出しだけでは「呼ばれている」ことにならない。
      // 外から入口が無いので、その手続きは一度も実行されない
      const fromOutside = p.calls - (p.selfCalls ?? 0);
      if (fromOutside <= 0 && !p.isMain && !p.isExternal && !calledByFramework(p.name)) {
        const why =
          (p.selfCalls ?? 0) > 0
            ? `手続き ${p.name} は自分自身からしか呼ばれていません。`
            : `手続き ${p.name} は呼ばれていません。`;
        this.report("unused-procedure", p.line, why);
      }
    }
  }
}

/**
 * ソースを検査する。
 *
 * 構文が壊れている場合は**何も返さない**。構文の誤りは
 * `runProgram()` の診断が出すので、二重に見せない。
 */
export function lint(source: string, opts: LintOptions = {}): LintMessage[] {
  const setting = (id: string): RuleSetting => {
    const rule = RULE_BY_ID.get(id);
    const base = rule === undefined ? "off" : rule.default;
    return opts.rules?.[id] ?? base;
  };
  const severity = (id: string): LintSeverity | undefined => {
    const s = setting(id);
    return s === "off" ? undefined : s;
  };

  let program: Program;
  try {
    program = parse(source, opts.host === undefined ? {} : { host: opts.host });
  } catch {
    return [];
  }

  // テストファイルかどうかで、フレームワークが入れる手続きの扱いが変わる
  let isTest = false;
  try {
    isTest = isTestSource(source, opts.host);
  } catch {
    isTest = false;
  }

  return new Linter(source, severity, isTest, opts.fragment === true).run(program);
}

/** 走査中の文脈。 */
interface WalkCtx {
  /** ON 単位の中か（GOTO の扱いが変わる）。 */
  inOnUnit: boolean;
  /** いま走査している手続きの名前（大文字）。自己呼び出しの判定に使う。 */
  proc?: string;
}

/**
 * `%INCLUDE` される断片（コピーブック）として扱う名前か。
 *
 * 3 つの入口で同じ判定を使うために、ここに置く。
 * 拡張子で見るのは実機の慣習（`.inc` / `.cpy`）に合わせたもの。
 */
export function isFragmentFileName(fileName: string): boolean {
  return /\.(inc|cpy|plinc)$/i.test(fileName);
}

/** 人が読む形にまとめる。CLI 用。 */
export function formatLint(messages: readonly LintMessage[], title: string): string {
  if (messages.length === 0) return `--- ${title} ---\n  指摘はありません`;
  const lines = [`--- ${title} ---`];
  for (const m of messages) {
    const where = m.col === undefined ? `${m.line}行` : `${m.line}行${m.col}桁`;
    const mark = m.severity === "error" ? "ERR " : m.severity === "warning" ? "WARN" : "INFO";
    lines.push(`  ${mark} ${where}: ${m.message} [${m.rule}]`);
  }
  const count = (s: LintSeverity) => messages.filter((m) => m.severity === s).length;
  lines.push(
    "",
    `指摘 ${messages.length} / 誤り ${count("error")} / 警告 ${count("warning")} / 情報 ${count("info")}`,
  );
  return lines.join("\n");
}
