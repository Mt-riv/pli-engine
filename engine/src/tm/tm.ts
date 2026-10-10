import { m, msg, tr } from "../i18n/index.js";
import { dayOfYear } from "../datetime.js";
/**
 * IMS TM（メッセージキュー）の層。
 *
 * 入出力 PCB への `GU` / `GN` / `ISRT` / `PURG` の意味論だけを持つ。
 * 画面の整形（MFS）も PL/I の記憶域も見ない。見るのは
 * **セグメントの並びと順序、そしてステータスコード**。
 *
 * セグメントは `LL ZZ` を**付けない中身**で持つ。4 バイトの前置きを
 * 付け外しするのは PL/I 側との境目（`interp.ts`）の仕事。
 *
 * 1 回の実行で処理するのは「キューに積まれた分」だけ。実機の MPP も
 * 同じで、`GU` がキューの次を取り、空になれば `QC` で終わる。
 * 画面と画面の間でプログラムは生きていない（会話の状態は SPA が持つ）。
 */

/** キューに積む入力メッセージ。 */
export interface InputMessage {
  /** 整形に使った MID の名前。記録のために持つ。 */
  mid?: string;
  /** セグメント（`LL ZZ` なし）。 */
  segments: string[];
  /** この入力に続く出力の既定の書式（MID の `NXT=`）。 */
  modName?: string;
}

/** プログラムが `ISRT` で出した出力メッセージ。 */
export interface OutputMessage {
  /** セグメント（`LL ZZ` なし）。 */
  segments: string[];
  /** `ISRT` の第 4 引数で指定された書式。 */
  modName?: string;
}

/** 入出力 PCB の中身。 */
export interface IoPcbState {
  lterm: string;
  status: string;
  /** ユリウス日 `yyddd`。 */
  date: number;
  /** `hhmmss.t`。 */
  time: number;
  seq: number;
  modName: string;
  userid: string;
}

export interface TmOptions {
  lterm?: string;
  userid?: string;
  /** 入出力 PCB の日付・時刻に使う。外から渡さないと固定できない。 */
  now?: Date;
  queue?: InputMessage[];
}

/**
 * 引き受けない、しかし名前は知っている呼び出し。
 *
 * 黙って `AD`（機能コードが正しくない）を返すと「書き間違い」と
 * 区別が付かない。会話型の MPP は入出力 PCB に対して `CHKP` を出すのが
 * 定石なので、実務の形をそのまま持ってきたときに「書き間違い」と
 * 言われないよう、`dli/dli.ts` の表と同じ語をそろえる。
 */
const KNOWN_UNSUPPORTED = new Map<string, string>([
  ["CHKP", msg("チェックポイント（同期点）")],
  ["XRST", msg("再起動")],
  ["ROLB", msg("ロールバック")],
  ["ROLL", msg("ロールバック")],
  ["ROLS", msg("ロールバック")],
  ["SETS", msg("セーブポイント")],
  ["LOG", msg("ログ書き出し")],
  ["STAT", msg("統計取得")],
  ["SNAP", msg("スナップ出力")],
  ["GSCD", msg("システム領域の取得")],
  ["APSB", msg("PSB の割り当て")],
  ["DPSB", msg("PSB の解放")],
  ["CHNG", msg("送り先の変更（代替 PCB）")],
  ["SETO", msg("出力オプション")],
  ["CMD", msg("IMS コマンド")],
  ["GCMD", msg("IMS コマンドの応答")],
  ["AUTH", msg("権限の確認")],
  ["INIT", msg("状態の初期化")],
]);

const OK = "  ";

export interface TmCallResult {
  status: string;
  /** 取れたセグメント（`LL ZZ` なし）。検索が成功したときだけ入る。 */
  segment?: string;
}

/** この層が引き受けない呼び出し。処理系を止める。 */
export class TmUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmUnsupported";
  }
}

export class TmRuntime {
  readonly state: IoPcbState;
  private readonly now: Date;
  private readonly queue: InputMessage[];
  /** 読んでいる途中の入力メッセージ。 */
  private current: { msg: InputMessage; read: number } | undefined;
  private readonly done: OutputMessage[] = [];
  /** `ISRT` で組み立てている途中の出力メッセージ。 */
  private pending: OutputMessage | undefined;

  constructor(opts: TmOptions = {}) {
    this.now = opts.now ?? new Date(0);
    this.queue = [...(opts.queue ?? [])];
    this.state = {
      lterm: opts.lterm ?? "",
      status: OK,
      date: 0,
      time: 0,
      seq: 0,
      modName: "",
      userid: opts.userid ?? "",
    };
  }

  /** まだ取られていない入力が残っているか。 */
  get hasInput(): boolean {
    return this.queue.length > 0;
  }

  /** 出来上がった出力メッセージ。 */
  get outputs(): readonly OutputMessage[] {
    return this.done;
  }

  /** 組み立て中の出力を出来上がりにする（同期点と実行の終わり）。 */
  finish(): void {
    if (this.pending === undefined) return;
    this.done.push(this.pending);
    this.pending = undefined;
  }

  /** 入出力 PCB への呼び出し。 */
  call(func: string, segment: string | undefined, modName: string | undefined): TmCallResult {
    const code = func.trim().toUpperCase();
    const unsupported = KNOWN_UNSUPPORTED.get(code);
    if (unsupported !== undefined) {
      throw new TmUnsupported(m`${code}（${tr(unsupported)}）は未実装です`);
    }
    switch (code) {
      case "GU":
        return this.get(true);
      case "GN":
        return this.get(false);
      case "GHU":
      case "GHN":
        // ホールド付きの検索はデータベース PCB だけの機能。
        // 入出力 PCB に出せば AD（機能コードが正しくない）
        return this.status("AD");
      case "ISRT":
        return this.insert(segment ?? "", modName);
      case "PURG":
        // 組み立て中のものを送り出す。次の ISRT は新しいメッセージになる。
        // I/O 領域を渡す形（次のメッセージの第 1 セグメントにする）は未実装
        if (segment !== undefined) {
          throw new TmUnsupported(
            m`PURG に I/O 領域を渡す形（次のメッセージの第 1 セグメントにする）は未実装です`,
          );
        }
        this.finish();
        return this.status(OK);
      default:
        // AD — 機能コードが正しくない
        return this.status("AD");
    }
  }

  private status(code: string): TmCallResult {
    this.state.status = code;
    return { status: code };
  }

  /** `GU` / `GN`。 */
  private get(unique: boolean): TmCallResult {
    if (unique) {
      // GU は同期点。ここまでに ISRT したものを送り出す
      this.finish();
      const msg = this.queue.shift();
      if (msg === undefined) {
        this.current = undefined;
        // QC — キューにメッセージが無い（プログラムの終わり）
        return this.status("QC");
      }
      this.current = { msg, read: 0 };
      this.state.seq += 1;
      this.state.modName = (msg.modName ?? "").padEnd(8).slice(0, 8);
      this.state.date = julianDate(this.now);
      this.state.time = timeOfDay(this.now);
    } else if (this.current === undefined) {
      // QE — GU より先に GN を出した
      return this.status("QE");
    }
    const cur = this.current!;
    const segment = cur.msg.segments[cur.read];
    if (segment === undefined) {
      // QD — このメッセージにこれ以上セグメントが無い
      return this.status("QD");
    }
    cur.read += 1;
    this.state.status = OK;
    return { status: OK, segment };
  }

  /** `ISRT`。 */
  private insert(segment: string, modName: string | undefined): TmCallResult {
    const name = modName?.trim();
    if (this.pending === undefined) {
      this.pending = {
        segments: [],
        ...(name === undefined || name === "" ? {} : { modName: name.toUpperCase() }),
      };
    } else if (name !== undefined && name !== "" && this.pending.modName === undefined) {
      this.pending.modName = name.toUpperCase();
    }
    this.pending.segments.push(segment);
    return this.status(OK);
  }
}

/** `yyddd`。入出力 PCB の日付の形。 */
export function julianDate(d: Date): number {
  return (d.getFullYear() % 100) * 1000 + dayOfYear(d);
}

/** `hhmmss.t`。入出力 PCB の時刻の形。 */
export function timeOfDay(d: Date): number {
  const v =
    d.getHours() * 10000 + d.getMinutes() * 100 + d.getSeconds() + Math.floor(d.getMilliseconds() / 100) / 10;
  return Math.round(v * 10) / 10;
}
