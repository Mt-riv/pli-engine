/**
 * 画面との往復を回す層。
 *
 * **1 回の入力 = 1 回のプログラム実行。** 実機の MPP も同じで、
 * `GU` でキューの次を取り、処理し、`ISRT` で返し、キューが空になれば
 * `QC` で終わる。画面と画面の間でプログラムは生きていない。
 * だからこの処理系の同期的な実行器をそのまま使える
 * （実行器を止めて人の入力を待つ必要がない）。
 *
 * 引き継がれるもの:
 *   データベース   … ホストが持つ（実行の終わりに書き戻る）
 *   会話の状態     … SPA。持ち主はプログラムではなくこちら側
 *   次に読む書式   … 直前に送った MOD の `NXT=`
 */

import type { PliHost } from "../host.js";
import { runProgram, type Diagnostic, type ProgramOptions, type ProgramResult } from "../run.js";
import { MfsBlockError, type MfsLibrary } from "../mfs/blocks.js";
import type { Screen } from "../mfs/device.js";
import { formatInput, type DeviceInput } from "../mfs/input.js";
import { formatOutput, type OutputOptions } from "../mfs/output.js";
import { TmRuntime, type InputMessage, type OutputMessage } from "./tm.js";

export interface SessionOptions {
  /** PL/I のソース。1 回の入力ごとに、これを頭から実行する。 */
  source: string;
  /** MFS の書式定義の表。 */
  library: MfsLibrary;
  /** `%INCLUDE` とファイル入出力。実行をまたいで同じものを使う。 */
  host: PliHost;
  /** PSB の名前。入出力 PCB を含む PSB でなければ動かない。 */
  psb: string;
  /** 最初に出す画面（端末で `/FORMAT` と打つ代わり）。 */
  mod?: string;
  lterm?: string;
  userid?: string;
  /**
   * 時刻。**テストでは必ず渡す**（渡さないと実行のたびに変わる）。
   */
  now?: () => Date;
  /**
   * 会話型トランザクションの SPA の長さ（`LL` を含めた全体）。
   *
   * 実機では IMS のシステム定義（`TRANSACT SPA=`）が決めるもので、
   * プログラムにもメッセージにも書かれていない。この処理系には
   * システム定義が無いので、ここで与える。
   */
  spa?: number;
  /** 実行の上限など。 */
  limits?: ProgramOptions;
}

/** 1 回の往復の結果。 */
export interface SessionStep {
  /** 出す画面。変わらなければ直前のまま。 */
  screen?: Screen;
  /** プログラムの `PUT` 出力。 */
  stdout: string;
  diagnostics: Diagnostic[];
  ok: boolean;
  /** IMS 側からの通知（画面に出せない事情）。 */
  notice?: string;
  /** まだ出していない出力メッセージの数。 */
  queued: number;
}

/** SPA の前置き。`LL`(2) + `ZZZZ`(4) + トランザクションコード(8)。 */
const SPA_PREFIX = 14;
/** セグメントは `LL ZZ` の 4 バイトを外して持つので、残る前置き。 */
const SPA_HEAD = SPA_PREFIX - 4;

/**
 * 先頭の語（トランザクションコードやコマンド）。
 *
 * 区切りは空白・カンマ・ピリオド。ピリオドを区切りに入れるのは、
 * 項目の中身がセグメントの中で隣とくっつくため。MFS の定石でも
 * `PFK=(FLD,1='/FOR MENU.')` のように**ピリオドで終わり**を示す。
 */
export function firstWord(segment: string): string {
  return segment.trim().split(/[ ,.]/)[0] ?? "";
}

export class Session {
  private readonly opts: SessionOptions;
  /** 次の入力を整形する MID。 */
  private mid: string | undefined;
  /** 会話の途中の SPA（`LL ZZ` を外した中身）。 */
  private spa: string | undefined;
  /** まだ出していない出力メッセージ。 */
  private pending: OutputMessage[] = [];
  private current: Screen | undefined;

  constructor(opts: SessionOptions) {
    this.opts = opts;
  }

  /** いま出ている画面。 */
  get screen(): Screen | undefined {
    return this.current;
  }

  /** 次の入力を整形する MID の名前。 */
  get inputFormat(): string | undefined {
    return this.mid;
  }

  /** 会話の途中かどうか。 */
  get inConversation(): boolean {
    return this.spa !== undefined;
  }

  private outputOptions(): OutputOptions {
    return { now: (this.opts.now ?? (() => new Date()))(), lterm: this.opts.lterm ?? "" };
  }

  /** 最初の画面を出す。 */
  start(): SessionStep {
    const mod = this.opts.mod;
    if (mod === undefined) {
      return this.step({ notice: "最初に出す書式が指定されていません（MOD の名前を与えてください）" });
    }
    return this.show(mod, []);
  }

  /** 画面に打ち込んで送る。 */
  send(input: DeviceInput): SessionStep {
    if (this.mid === undefined) {
      return this.step({
        notice: "入力の書式が決まっていません（画面を出してから打ち込んでください）",
      });
    }
    let segments: string[];
    try {
      segments = formatInput(this.opts.library, this.mid, input);
    } catch (e) {
      if (e instanceof MfsBlockError) return this.step({ notice: e.message });
      throw e;
    }
    const first = segments[0] ?? "";
    const word = firstWord(first);
    if (word.startsWith("/")) return this.command(word, first);
    if (word === "") {
      return this.step({ notice: "トランザクションコードがありません" });
    }
    return this.runTransaction(word, segments);
  }

  /** 溜まっている次の出力メッセージを出す。 */
  next(): SessionStep {
    const msg = this.pending.shift();
    if (msg === undefined) return this.step({ notice: "次のメッセージはありません" });
    return this.display(msg);
  }

  /** IMS のコマンド。 */
  private command(word: string, segment: string): SessionStep {
    const upper = word.toUpperCase();
    if (upper === "/FORMAT" || upper === "/FOR") {
      const name = firstWord(segment.slice(segment.indexOf(word) + word.length))
        .replace(/\.$/, "")
        .toUpperCase();
      if (name === "") return this.step({ notice: "/FORMAT に書式の名前がありません" });
      return this.show(name, []);
    }
    return this.step({ notice: `コマンド ${upper} は未実装です（/FORMAT だけを扱う）` });
  }

  /** トランザクションを 1 回動かす。 */
  private runTransaction(trancode: string, segments: string[]): SessionStep {
    const queueSegments = [...segments];
    if (this.opts.spa !== undefined) {
      queueSegments.unshift(this.spa ?? newSpa(trancode, this.opts.spa));
    }
    const message: InputMessage = {
      ...(this.mid === undefined ? {} : { mid: this.mid }),
      segments: queueSegments,
      ...(this.nextMod() === undefined ? {} : { modName: this.nextMod()! }),
    };
    const tm = new TmRuntime({
      lterm: this.opts.lterm ?? "",
      userid: this.opts.userid ?? "",
      now: this.outputOptions().now,
      queue: [message],
    });
    const result: ProgramResult = runProgram(this.opts.source, {
      ...this.opts.limits,
      host: this.opts.host,
      psb: this.opts.psb,
      tm,
    });
    tm.finish();

    const messages = [...tm.outputs];
    if (this.opts.spa !== undefined) {
      // 会話型では最初の ISRT が SPA。トランザクションコードを
      // 空白にして返すと会話が終わる（実機と同じ約束）
      const head = messages[0];
      const spa = head?.segments.shift();
      if (spa !== undefined) {
        // トランザクションコードは前置きの末尾 8 桁
        this.spa = firstWord(spa.slice(SPA_HEAD - 8, SPA_HEAD)) === "" ? undefined : spa;
      }
      if (head !== undefined && head.segments.length === 0) messages.shift();
    }
    this.pending = messages.slice(1);
    const head = messages[0];
    const shown =
      head === undefined
        ? this.step(result.ok ? { notice: "プログラムは画面を返しませんでした" } : {})
        : this.display(head);
    return {
      ...shown,
      stdout: result.stdout,
      diagnostics: result.diagnostics,
      // 画面が出せたかどうかより、プログラムが通ったかどうかを優先する
      ok: result.ok && shown.notice === undefined,
      queued: this.pending.length,
    };
  }

  /** 出力メッセージを画面にする。 */
  private display(msg: OutputMessage): SessionStep {
    const name = msg.modName ?? this.nextMod();
    if (name === undefined) {
      return this.step({ notice: "出力の書式が決まりません（ISRT に MOD 名を渡してください）" });
    }
    return this.show(name, msg.segments);
  }

  /** MOD で画面を組み、次に読む MID を決める。 */
  private show(modName: string, segments: string[]): SessionStep {
    try {
      const screen = formatOutput(this.opts.library, modName, segments, this.outputOptions());
      this.current = screen;
      this.mid = this.opts.library.mod(modName).next;
      return this.step({ screen });
    } catch (e) {
      if (e instanceof MfsBlockError) return this.step({ notice: e.message });
      throw e;
    }
  }

  /** いまの MID が指す出力の書式。 */
  private nextMod(): string | undefined {
    if (this.mid === undefined) return undefined;
    try {
      return this.opts.library.mid(this.mid).next;
    } catch {
      return undefined;
    }
  }

  private step(part: Partial<SessionStep>): SessionStep {
    return {
      ...(this.current === undefined ? {} : { screen: this.current }),
      stdout: "",
      diagnostics: [],
      ok: part.notice === undefined,
      queued: this.pending.length,
      ...part,
    };
  }
}

/** 会話の始まりの SPA（`LL ZZ` を外した中身）。 */
function newSpa(trancode: string, size: number): string {
  const head = "  " + trancode.toUpperCase().padEnd(8).slice(0, 8);
  return head.padEnd(Math.max(head.length, size - 4));
}
