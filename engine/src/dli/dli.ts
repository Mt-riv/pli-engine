/**
 * DL/I エンジン本体。
 *
 * 再現するのは**論理層**だけ。階層順・順序キー・位置づけ・ステータス
 * コードは実機どおりに扱い、物理層（HDAM の RAP、ポインタ、OSAM の
 * データセット）は再現しない。業務プログラムから見える違いはすべて
 * 論理層で決まるので、学習と検証の用には足りる。
 *
 * ステータスコードの根拠は IBM IMS の仕様。実機と突き合わせる手段が
 * 無い（IMS は z/OS 専用で、手元のリファレンス実装に DL/I は無い）ため、
 * 各コードの意味は仕様の記述をテストに引用して担保している。
 */

import { Database, type Occurrence } from "./store.js";
import { parseSsa, type Ssa, type SsaCondition } from "./ssa.js";
import type { DbdDef, PcbDef, PsbDef, SegmentDef } from "./types.js";

/** 正常終了。ステータスコードは空白 2 つ。 */
const OK = "  ";

/** この処理系が引き受けない DL/I 呼び出し。処理系を止める。 */
export class DliUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DliUnsupported";
  }
}

/** 検索系の機能コード。`H` が付くとホールド（更新の前提）になる。 */
const GET_FUNCTIONS = new Set(["GU", "GHU", "GN", "GHN", "GNP", "GHNP"]);
/** 更新系の機能コード。 */
const UPDATE_FUNCTIONS = new Set(["ISRT", "DLET", "REPL"]);
/**
 * 名前は知っているが引き受けない機能コード。
 * 黙って AD を返すと「書き間違い」と区別が付かないので、名指しで断る。
 */
const KNOWN_UNSUPPORTED = new Map<string, string>([
  ["CHKP", "チェックポイント"],
  ["XRST", "再起動"],
  ["ROLB", "ロールバック"],
  ["ROLL", "ロールバック"],
  ["ROLS", "ロールバック"],
  ["SETS", "セーブポイント"],
  ["LOG", "ログ書き出し"],
  ["STAT", "統計取得"],
  ["CHNG", "メッセージ送信先の変更"],
  ["PURG", "メッセージの送出"],
  ["SETO", "出力オプション"],
  ["CMD", "IMS コマンド"],
  ["GCMD", "IMS コマンド応答"],
  ["INIT", "状態の初期化"],
  ["SNAP", "スナップ出力"],
  ["GSCD", "システム領域の取得"],
  ["APSB", "PSB の割り当て"],
  ["DPSB", "PSB の解放"],
]);

/** 引き受けるコマンドコード。 */
const SUPPORTED_COMMANDS = new Set(["C", "D", "F", "L", "P", "U", "V"]);

/** PCB ごとの状態。位置づけは PCB 単位で、データベースは共有する。 */
export interface PcbState {
  readonly def: PcbDef;
  status: string;
  segName: string;
  level: number;
  keyFeedback: string;
  /** 現在位置。階層順で「最後に取れたセグメント」。 */
  position?: Occurrence | undefined;
  /** 確立した親。GNP の走査範囲になる。 */
  parentage?: Occurrence | undefined;
  /** GHx で保持したセグメント。REPL / DLET の前提。 */
  hold?: Occurrence | undefined;
}

export interface DliCallResult {
  status: string;
  /** 取れたセグメントの内容。検索が成功したときだけ入る。 */
  ioArea?: string;
}

/** SSA を解析した 1 レベル分。 */
interface Level {
  ssa: Ssa;
  seg: SegmentDef;
}

export class DliRuntime {
  private readonly states: PcbState[];

  constructor(
    readonly psb: PsbDef,
    private readonly databases: Map<string, Database>,
  ) {
    this.states = psb.pcbs.map((def) => ({
      def,
      status: OK,
      segName: "",
      level: 0,
      keyFeedback: "",
    }));
  }

  get pcbCount(): number {
    return this.states.length;
  }

  pcb(index: number): PcbState {
    const s = this.states[index];
    if (s === undefined) throw new DliUnsupported(`PCB ${index + 1} は PSB にありません`);
    return s;
  }

  database(name: string): Database {
    const db = this.databases.get(name.toUpperCase());
    if (db === undefined) throw new DliUnsupported(`データベース ${name} が読めません`);
    return db;
  }

  /** 更新があったデータベースの名前。書き戻しに使う。 */
  readonly changed = new Set<string>();

  // ---- 呼び出し ----

  call(pcbIndex: number, func: string, ioArea: string, ssaTexts: string[]): DliCallResult {
    const pcb = this.pcb(pcbIndex);
    const code = func.trim().toUpperCase();

    if (pcb.def.kind === "io") {
      throw new DliUnsupported(
        "入出力 PCB への呼び出しは未実装です（IMS TM のメッセージ処理は対象外）",
      );
    }
    const unsupported = KNOWN_UNSUPPORTED.get(code);
    if (unsupported !== undefined) {
      throw new DliUnsupported(`${code}（${unsupported}）は未実装です`);
    }
    if (!GET_FUNCTIONS.has(code) && !UPDATE_FUNCTIONS.has(code)) {
      // AD — 機能コードが正しくない
      return this.done(pcb, "AD");
    }

    const dbd = pcb.def.dbd!;
    const db = this.database(pcb.def.dbdName!);

    // SSA を解析する。書式の誤りは AJ
    const levels: Level[] = [];
    /**
     * SSA に書いたセグメントの `SENSEG PROCOPT=`。
     * PCB 単位の `PROCOPT` に加えて、これも満たさなければならない。
     */
    const sensegOpts: string[] = [];
    for (const text of ssaTexts) {
      if (text.trim() === "") continue;
      const parsed = parseSsa(text, dbd);
      if (!parsed.ok) return this.done(pcb, parsed.status);
      for (const c of parsed.ssa.commands) {
        if (!SUPPORTED_COMMANDS.has(c)) {
          throw new DliUnsupported(`コマンドコード ${c} は未実装です`);
        }
      }
      const senseg = pcb.def.senseg.get(parsed.ssa.segment);
      if (senseg === undefined) {
        // AM — PROCOPT / 感知の範囲外
        return this.done(pcb, "AM");
      }
      // SENSEG ごとに PROCOPT を上書きできる。読むだけで効かせないと、
      // 「読み取り専用にしたつもりのセグメントが書ける」ことになる
      if (senseg.procopt !== undefined) sensegOpts.push(senseg.procopt);
      levels.push({ ssa: parsed.ssa, seg: dbd.segments.get(parsed.ssa.segment)! });
    }
    if (!hierarchic(dbd, levels)) return this.done(pcb, "AC");

    /** PCB の PROCOPT と、SSA に書いた SENSEG の PROCOPT の両方を満たすか。 */
    const permitted = (what: "get" | "insert" | "replace" | "delete"): boolean =>
      allows(pcb.def.procopt, what) && sensegOpts.every((o) => allows(o, what));

    if (GET_FUNCTIONS.has(code)) {
      if (!permitted("get")) return this.done(pcb, "AM");
      return this.get(pcb, db, dbd, code, levels);
    }
    switch (code) {
      case "ISRT":
        if (!permitted("insert")) return this.done(pcb, "AM");
        return this.insert(pcb, db, dbd, ioArea, levels);
      case "REPL":
        if (!permitted("replace")) return this.done(pcb, "AM");
        return this.replace(pcb, db, dbd, ioArea);
      default:
        if (!permitted("delete")) return this.done(pcb, "AM");
        return this.remove(pcb, db, dbd);
    }
  }

  // ---- 検索 ----

  private get(
    pcb: PcbState,
    db: Database,
    dbd: DbdDef,
    code: string,
    levels: Level[],
  ): DliCallResult {
    const hold = code.startsWith("GH");
    const unique = code === "GU" || code === "GHU";
    const inParent = code === "GNP" || code === "GHNP";

    // **ホールドは 1 回の呼び出しで使い切る。**
    // 取り出しの入口で必ず落とし、GH 系が成功したときだけ付け直す。
    // 落とさないと「GHU → 失敗した GU → REPL」が DJ にならず、
    // 別のセグメントを置き換えてしまう
    pcb.hold = undefined;

    let found: Occurrence | undefined;
    let warning = OK;

    if (unique) {
      found = this.locate(db, dbd, levels, pcb.position);
      if (found === undefined) {
        // 位置づけに失敗したら親の確立も解ける（GNP は GP になる）
        pcb.parentage = undefined;
        return this.done(pcb, "GE");
      }
    } else if (inParent) {
      const parent = pcb.parentage;
      // GP — 親が確立していない
      if (parent === undefined) return this.done(pcb, "GP");
      found = this.scan(pcb, db, dbd, levels, pcb.position, parent);
      // GNP の失敗では親の確立を解かない（配下を走査し終えただけ）
      if (found === undefined) return this.done(pcb, "GE");
    } else {
      found = this.scan(pcb, db, dbd, levels, pcb.position, undefined);
      // GB — データベースの終端に達した
      if (found === undefined) {
        pcb.parentage = undefined;
        return this.done(pcb, "GB");
      }
      if (levels.length === 0 && pcb.position !== undefined) {
        warning = sequentialWarning(dbd, pcb.position, found);
      }
    }

    // パス呼び出し（D コマンドコード）は、その階層以下をまとめて返す
    const ioArea = this.pathArea(levels, found);
    pcb.position = found;
    // 親の確立は GU / GN が行う。GNP は確立した親を動かさない
    // （動かすと配下の走査が 1 段ずつ潜っていってしまう）
    if (!inParent) pcb.parentage = this.parentageFor(levels, found);
    pcb.hold = hold ? found : undefined;
    this.report(pcb, dbd, found);
    pcb.status = warning;
    return { status: warning, ioArea };
  }

  /**
   * SSA の並びをたどって 1 件に絞る（GU）。
   *
   * 各レベルの候補を順に試し、**下のレベルで行き止まったら次の候補へ戻る**
   * （深さ優先の探索）。IMS は全 SSA を満たす最初の経路まで階層順に探すので、
   * 上のレベルを 1 つ選んだだけで打ち切ってはいけない。
   *
   * 以前は各レベルで先頭の候補に固定していたため、
   * `GU STUDENT, COURSE(COURSEID =C003)` のように上位が無修飾で
   * 下位が 2 人目の学生の配下にあるとき、`GE` を返していた。
   *
   * `L` コマンドコードはそのレベルの候補を後ろから試す。
   */
  private locate(
    db: Database,
    dbd: DbdDef,
    levels: Level[],
    position: Occurrence | undefined,
  ): Occurrence | undefined {
    if (levels.length === 0) return db.first();
    const search = (i: number, parent: Occurrence | undefined): Occurrence | undefined => {
      const lv = levels[i]!;
      const cands = this.candidates(db, dbd, lv, parent, position);
      const order = lv.ssa.commands.includes("L") ? [...cands].reverse() : cands;
      for (const c of order) {
        if (i === levels.length - 1) return c;
        const deeper = search(i + 1, c);
        if (deeper !== undefined) return deeper;
      }
      return undefined;
    };
    return search(0, undefined);
  }

  /**
   * 階層順に前へ進めて、SSA に合う次の 1 件を探す（GN / GNP）。
   * `within` を渡すとその配下だけを見る。
   */
  private scan(
    pcb: PcbState,
    db: Database,
    dbd: DbdDef,
    levels: Level[],
    position: Occurrence | undefined,
    within: Occurrence | undefined,
  ): Occurrence | undefined {
    const inRange = (o: Occurrence): boolean =>
      within === undefined || ancestors(o).includes(within);
    // F コマンドコードは「親の下の最初の出現に戻る」
    const restart = levels.some((l) => l.ssa.commands.includes("F"));
    let at =
      restart || position === undefined
        ? within === undefined
          ? db.first()
          : within.children[0]
        : db.next(position);
    if (!restart && position !== undefined && within !== undefined && !inRange(position)) {
      at = within.children[0];
    }
    for (; at !== undefined; at = db.next(at)) {
      if (within !== undefined && !inRange(at)) return undefined;
      // **感知していないセグメントは見えない。**
      // 実機の PCB は SENSEG だけが見える階層なので、
      // 無修飾の GN でも感知外の型は返してはいけない
      if (!pcb.def.senseg.has(at.type)) continue;
      if (levels.length === 0) return at;
      const last = levels[levels.length - 1]!;
      if (at.type !== last.ssa.segment) continue;
      if (this.satisfies(dbd, levels, at, position)) return at;
    }
    return undefined;
  }

  /** ある出現が SSA の並びを満たすか。下のレベルから祖先をたどって見る。 */
  private satisfies(
    dbd: DbdDef,
    levels: Level[],
    occ: Occurrence,
    position: Occurrence | undefined,
  ): boolean {
    let at: Occurrence | undefined = occ;
    for (let i = levels.length - 1; i >= 0; i--) {
      const lv = levels[i]!;
      while (at !== undefined && at.type !== lv.ssa.segment) at = at.parent;
      if (at === undefined) return false;
      if (!this.matches(dbd, lv, at, position)) return false;
      at = at.parent;
    }
    return true;
  }

  /** そのレベルの候補。親の配下にある、その型の出現で、修飾に合うもの。 */
  private candidates(
    db: Database,
    dbd: DbdDef,
    lv: Level,
    parent: Occurrence | undefined,
    position: Occurrence | undefined,
  ): Occurrence[] {
    const pool =
      parent === undefined
        ? db.hierarchy().filter((o) => o.type === lv.ssa.segment)
        : descendantsOf(parent).filter((o) => o.type === lv.ssa.segment);
    return pool.filter((o) => this.matches(dbd, lv, o, position));
    // 型は SSA で指定されているので、感知の検査は呼び出しの入口
    // （`call` の SENSEG 検査）で済んでいる
  }

  /** 修飾に合うか。 */
  private matches(
    dbd: DbdDef,
    lv: Level,
    occ: Occurrence,
    position: Occurrence | undefined,
  ): boolean {
    if (lv.ssa.concatenatedKey !== undefined) {
      const key = Database.concatenatedKey(dbd, occ);
      return key === lv.ssa.concatenatedKey.padEnd(key.length).slice(0, key.length);
    }
    // U / V は現在位置そのものを修飾として使う。
    // そのレベルで「いま居る出現」以外は候補から外れる。
    // 位置が無ければ、そのレベルで絞るものが無いので誰も合わない。
    if (lv.ssa.commands.includes("V") || lv.ssa.commands.includes("U")) {
      const at = position === undefined
        ? undefined
        : ancestors(position).concat(position).find((o) => o.type === lv.ssa.segment);
      if (at !== occ) return false;
    }
    if (lv.ssa.conditions.length === 0) return true;
    // AND は OR より強く結び付く。OR で区切った組のどれかが成り立てばよい
    let group = true;
    let any = false;
    for (const c of lv.ssa.conditions) {
      if (c.join === "OR") {
        any = any || group;
        group = true;
      }
      group = group && this.condition(dbd, c, occ);
    }
    return any || group;
  }

  private condition(dbd: DbdDef, c: SsaCondition, occ: Occurrence): boolean {
    const actual = Database.fieldValue(dbd, occ, c.field);
    if (actual === undefined) return false;
    const want = c.value.padEnd(actual.length).slice(0, actual.length);
    switch (c.op) {
      case "EQ":
        return actual === want;
      case "NE":
        return actual !== want;
      case "GT":
        return actual > want;
      case "LT":
        return actual < want;
      case "GE":
        return actual >= want;
      case "LE":
        return actual <= want;
    }
  }

  /** `D` コマンドコードがあれば、その階層から下までを連結して返す。 */
  private pathArea(levels: Level[], found: Occurrence): string {
    const at = levels.findIndex((l) => l.ssa.commands.includes("D"));
    if (at < 0) return found.data;
    const chain = ancestors(found).concat(found);
    const names = levels.slice(at).map((l) => l.ssa.segment);
    return chain
      .filter((o) => names.includes(o.type))
      .map((o) => o.data)
      .join("");
  }

  /** `P` コマンドコードがあればそのレベル、無ければ最下位に親を確立する。 */
  private parentageFor(levels: Level[], found: Occurrence): Occurrence {
    const at = levels.findIndex((l) => l.ssa.commands.includes("P"));
    if (at < 0) return found;
    const name = levels[at]!.ssa.segment;
    return ancestors(found).concat(found).find((o) => o.type === name) ?? found;
  }

  // ---- 更新 ----

  private insert(
    pcb: PcbState,
    db: Database,
    dbd: DbdDef,
    ioArea: string,
    levels: Level[],
  ): DliCallResult {
    if (levels.length === 0) return this.done(pcb, "AD");
    const target = levels[levels.length - 1]!;
    const path = levels.slice(0, -1);

    // 挿入する側の SSA（最下位）に修飾を付けてはいけない。
    // 付けても条件は使われないので、黙って通すと「条件に合うものを
    // 挿入した」と誤解される
    if (target.ssa.qualified) return this.done(pcb, "AJ");

    let parent: Occurrence | undefined;
    if (path.length > 0) {
      parent = this.locate(db, dbd, path, pcb.position);
      if (parent === undefined) return this.done(pcb, "GE");
    } else if (target.seg.parent !== undefined) {
      // **親の SSA を省いたら現在位置から親を決める。**
      // 「GU / GN で親を取る → 子を無修飾 SSA 1 つで ISRT」は
      // IMS で最もよく書かれる挿入の形。ロードモードの
      // 「親 ISRT → 子 ISRT」も同じ形になる。
      parent = this.parentFromPosition(pcb, target.seg.parent);
      if (parent === undefined) {
        // 位置が無い、または位置の祖先に親の型が無い。
        // ロードモードなら「親が無い」の LD、ふつうは GE
        return this.done(pcb, pcb.def.procopt.includes("L") ? "LD" : "GE");
      }
    }
    // 挿入先は、絞り込んだ親の直接の子でなければならない
    const expected = parent === undefined ? undefined : parent.type;
    if (target.seg.parent !== expected) return this.done(pcb, "AC");

    // 改行などの制御文字を入れると、unload が行を分割して
    // データファイルが壊れる（次回の読み込みで「DBD にありません」になる）
    if (/[\r\n\t\0]/.test(ioArea.slice(0, target.seg.bytes))) {
      return this.done(pcb, "AJ");
    }
    const data = ioArea.padEnd(target.seg.bytes).slice(0, target.seg.bytes);
    const siblings = parent === undefined ? db.roots : parent.children;
    const key = keyOf(target.seg, data);

    if (pcb.def.procopt.includes("L")) {
      const load = this.loadCheck(dbd, target.seg, parent, siblings, key);
      if (load !== OK) return this.done(pcb, load);
    } else if (target.seg.sequence?.unique === true) {
      const dup = siblings.some(
        (s) => s.type === target.seg.name && Database.keyValue(dbd, s) === key,
      );
      // II — 挿入しようとしたセグメントが既にある
      if (dup) return this.done(pcb, "II");
    }

    const occ = db.insert(parent, target.seg.name, data);
    this.changed.add(dbd.name);
    pcb.position = occ;
    pcb.parentage = occ;
    pcb.hold = undefined;
    this.report(pcb, dbd, occ);
    pcb.status = OK;
    return { status: OK };
  }

  /**
   * 現在位置から、指定した型の親を探す。
   *
   * 位置そのものがその型ならそれを使い、違えば祖先をたどる。
   * 直前の `GU` / `GN` が確立した位置が親になる、という
   * 実機の挙動に合わせるため。
   */
  private parentFromPosition(
    pcb: PcbState,
    parentType: string,
  ): Occurrence | undefined {
    const at = pcb.position;
    if (at === undefined) return undefined;
    if (at.type === parentType) return at;
    for (let o = at.parent; o !== undefined; o = o.parent) {
      if (o.type === parentType) return o;
    }
    return undefined;
  }

  /** ロードモード（PROCOPT=L）の順序の検査。 */
  private loadCheck(
    dbd: DbdDef,
    seg: SegmentDef,
    parent: Occurrence | undefined,
    siblings: Occurrence[],
    key: string,
  ): string {
    if (seg.parent !== undefined && parent === undefined) {
      // LD — 親セグメントが無い
      return "LD";
    }
    const order = parent === undefined ? 0 : dbd.segments.get(parent.type)!.children.indexOf(seg.name);
    for (const s of siblings) {
      if (s.type === seg.name) continue;
      const other =
        parent === undefined ? 0 : dbd.segments.get(parent.type)!.children.indexOf(s.type);
      // LE — 兄弟セグメントの順序が DBD の並びと合っていない
      if (other > order) return "LE";
    }
    const last = [...siblings].reverse().find((s) => s.type === seg.name);
    if (last === undefined || seg.sequence === undefined) return OK;
    const prev = Database.keyValue(dbd, last);
    // LB — 同じキーのセグメントが既にある。
    // **一意キー（`U`）のときだけ。** 非一意キー（`M`）は重複を許すので、
    // 同じキーを 2 回ロードしても誤りではない
    if (key === prev && seg.sequence.unique) return "LB";
    // LC — キーの順序が崩れた
    if (key < prev) return "LC";
    return OK;
  }

  private replace(pcb: PcbState, db: Database, dbd: DbdDef, ioArea: string): DliCallResult {
    const held = pcb.hold;
    // DJ — 直前に GHU / GHN / GHNP が無い
    if (held === undefined) return this.done(pcb, "DJ");
    const seg = dbd.segments.get(held.type)!;
    // ISRT と同じく、制御文字はデータファイルを壊すので断る
    if (/[\r\n\t\0]/.test(ioArea.slice(0, seg.bytes))) {
      return this.done(pcb, "AJ");
    }
    const data = ioArea.padEnd(seg.bytes).slice(0, seg.bytes);
    // DA — キー項目を変更した
    if (seg.sequence !== undefined && keyOf(seg, data) !== Database.keyValue(dbd, held)) {
      pcb.hold = undefined;
      return this.done(pcb, "DA");
    }
    db.replace(held, data);
    this.changed.add(dbd.name);
    pcb.hold = undefined;
    this.report(pcb, dbd, held);
    pcb.status = OK;
    return { status: OK };
  }

  private remove(pcb: PcbState, db: Database, dbd: DbdDef): DliCallResult {
    const held = pcb.hold;
    if (held === undefined) return this.done(pcb, "DJ");
    // 消した後に GN が続けられるよう、位置は 1 つ前に戻す
    const all = db.hierarchy();
    const prev = all[all.indexOf(held) - 1];
    db.remove(held);
    this.changed.add(dbd.name);
    pcb.hold = undefined;
    pcb.position = prev;
    pcb.parentage = undefined;
    this.report(pcb, dbd, held);
    pcb.status = OK;
    return { status: OK };
  }

  // ---- PCB への反映 ----

  /** セグメント名・レベル・キーフィードバックを PCB の状態へ写す。 */
  private report(pcb: PcbState, dbd: DbdDef, occ: Occurrence): void {
    pcb.segName = occ.type;
    pcb.level = dbd.segments.get(occ.type)!.level;
    const key = Database.concatenatedKey(dbd, occ);
    pcb.keyFeedback = pcb.def.keylen > 0 ? key.slice(0, pcb.def.keylen) : key;
  }

  /** 失敗を記録して返す。セグメント名とレベルはそのまま残す（実機と同じ）。 */
  private done(pcb: PcbState, status: string): DliCallResult {
    pcb.status = status;
    return { status };
  }

}

/**
 * SSA の並びが階層になっているか。
 * 各段は前の段の配下でなければならない（途中のレベルは省けるが、
 * 並びが階層順から外れていたら AC）。
 */
function hierarchic(dbd: DbdDef, levels: Level[]): boolean {
  for (let i = 1; i < levels.length; i++) {
    const want = levels[i - 1]!.seg.name;
    let up = levels[i]!.seg.parent;
    let ok = false;
    while (up !== undefined) {
      if (up === want) {
        ok = true;
        break;
      }
      up = dbd.segments.get(up)?.parent;
    }
    if (!ok) return false;
  }
  return true;
}

/** 処理オプションが呼び出しを許すか。 */
function allows(
  procopt: string,
  what: "get" | "insert" | "replace" | "delete",
): boolean {
  // L（ロード）は挿入だけ。取り出しも更新もできない
  if (procopt.includes("L")) return what === "insert";
  if (procopt.includes("A")) return true;
  switch (what) {
    case "get":
      // R（置換）と D（削除）は取り出しを含む
      return /[GROD]/.test(procopt);
    case "insert":
      return procopt.includes("I");
    case "replace":
      return procopt.includes("R");
    case "delete":
      return procopt.includes("D");
  }
}

/** セグメントデータから順序キーを切り出す。 */
function keyOf(seg: SegmentDef, data: string): string {
  const seq = seg.sequence;
  if (seq === undefined) return "";
  return data.slice(seq.start - 1, seq.start - 1 + seq.bytes);
}

/** 祖先をルートから順に並べる。 */
function ancestors(occ: Occurrence): Occurrence[] {
  const out: Occurrence[] = [];
  for (let o = occ.parent; o !== undefined; o = o.parent) out.unshift(o);
  return out;
}

/** 配下の全出現を階層順に並べる（自分は含めない）。 */
function descendantsOf(occ: Occurrence): Occurrence[] {
  const out: Occurrence[] = [];
  const walk = (list: Occurrence[]): void => {
    for (const o of list) {
      out.push(o);
      walk(o.children);
    }
  };
  walk(occ.children);
  return out;
}

/**
 * 無修飾の順次処理（SSA 無しの GN）で返る警告。
 *
 * GA — より上位のレベルへ移った
 * GK — 同じレベルの別のセグメント型へ移った
 */
function sequentialWarning(dbd: DbdDef, from: Occurrence, to: Occurrence): string {
  const a = dbd.segments.get(from.type)!.level;
  const b = dbd.segments.get(to.type)!.level;
  if (b < a) return "GA";
  if (b === a && from.type !== to.type) return "GK";
  return OK;
}
