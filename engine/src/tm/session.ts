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

import { m } from "../i18n/index.js";
import type { PliHost } from "../host.js";
import { runProgram, type Diagnostic, type ProgramOptions, type ProgramResult } from "../run.js";
import { MfsBlockError, type MessageDesc, type MfsLibrary } from "../mfs/blocks.js";
import { cloneScreen, fieldNamed, type Screen } from "../mfs/device.js";
import { formatInput, type Aid, type DeviceInput } from "../mfs/input.js";
import { formatOutput, modNameFor, type OutputOptions } from "../mfs/output.js";
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

  /** いま出ている画面。**生のもの**（打ち込むと書き換わる）。 */
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
      return this.step({ notice: m`最初に出す書式が指定されていません（MOD の名前を与えてください）` });
    }
    return this.show(mod, []);
  }

  /** 画面に打ち込んで送る。 */
  send(input: DeviceInput): SessionStep {
    if (this.mid === undefined) {
      return this.step({
        notice: m`入力の書式が決まっていません（画面を出してから打ち込んでください）`,
      });
    }
    // PA キーは IMS が物理ページングに使う。`docs/mfs.md` で
    // 「再現しない」と名指ししている機能なので、ENTER と同じに
    // 扱って黙って別のことをするより断る
    if (input.aid.kind === "pa") {
      return this.step({
        notice: m`PA${input.aid.n}（物理ページング）は未実装です`,
      });
    }
    // CLEAR は装置の緩衝を消して、**データを伴わない AID だけ**を送る。
    // どの項目も返らないので、打ち込んだ値は届かない（3270 の規則）
    if (input.aid.kind === "clear") {
      return this.clear(input.aid);
    }
    const typed = this.type(input);
    if (typed !== undefined) return typed;
    let segments: string[];
    try {
      segments = formatInput(this.opts.library, this.mid, this.readModified(input.aid));
    } catch (e) {
      if (e instanceof MfsBlockError) return this.step({ notice: e.message });
      throw e;
    }
    const first = segments[0] ?? "";
    const word = firstWord(first);
    if (word.startsWith("/")) return this.command(word, first);
    if (word === "") {
      return this.step({ notice: m`トランザクションコードがありません` });
    }
    return this.runTransaction(word, segments);
  }

  /**
   * CLEAR キー。
   *
   * 装置の緩衝が消え、データを伴わない AID だけが送られる。
   * 打ち込んだ値も、書式が書いた固定文字も残らないので、
   * 画面は空にして**項目を 1 つも返さずに**メッセージを組む
   * （`FILL=` と MFLD の固定文字だけが効く）。
   */
  private clear(aid: Aid): SessionStep {
    const screen = this.current;
    if (screen !== undefined) {
      for (const f of screen.fields) {
        f.text = " ".repeat(f.length);
        f.modified = false;
      }
    }
    let segments: string[];
    try {
      segments = formatInput(this.opts.library, this.mid!, { aid, fields: new Map() });
    } catch (e) {
      if (e instanceof MfsBlockError) return this.step({ notice: e.message });
      throw e;
    }
    const word = firstWord(segments[0] ?? "");
    if (word.startsWith("/")) return this.command(word, segments[0] ?? "");
    if (word === "") {
      return this.step({ notice: m`CLEAR で画面を消しました（送るものがありません）` });
    }
    return this.runTransaction(word, segments);
  }

  /**
   * 打ち込んだ値を画面に入れる（装置の緩衝に書くのと同じ）。
   * 打ち込めない項目を指していれば通知を返す。
   */
  private type(input: DeviceInput): SessionStep | undefined {
    const screen = this.current;
    if (screen === undefined) return undefined;
    for (const [name, text] of input.fields) {
      const f = fieldNamed(screen, name);
      if (f === undefined) {
        return this.step({ notice: m`項目 ${name} は画面にありません` });
      }
      if (f.attr.protect) {
        return this.step({ notice: m`項目 ${name} は打ち込めません（PROT）` });
      }
      f.text = text.padEnd(f.length).slice(0, f.length);
      f.modified = true;
    }
    return undefined;
  }

  /**
   * 変更の印が立っている項目だけを読む（実機の read modified）。
   *
   * 末尾の空白は落とす。実機の装置は打ち込んでいない桁を空値（X'00'）
   * として持ち、空白とは区別するが、この処理系は文字の面しか持たない。
   * 落とさないと `JUST=R` と `FILL=` が効かなくなる
   * （6 桁の項目に 42 と打ったら `000042` で届くのが実機の形）。
   */
  private readModified(aid: Aid): DeviceInput {
    const fields = new Map<string, string>();
    for (const f of this.current?.fields ?? []) {
      if (f.name === undefined || !f.modified) continue;
      fields.set(f.name, f.text.replace(/ +$/, ""));
    }
    return { aid, fields };
  }

  /** 溜まっている次の出力メッセージを出す。 */
  next(): SessionStep {
    const msg = this.pending.shift();
    if (msg === undefined) return this.step({ notice: m`次のメッセージはありません` });
    return this.display(msg);
  }

  /** IMS のコマンド。 */
  private command(word: string, segment: string): SessionStep {
    const upper = word.toUpperCase();
    if (upper === "/FORMAT" || upper === "/FOR") {
      const name = firstWord(segment.slice(segment.indexOf(word) + word.length))
        .replace(/\.$/, "")
        .toUpperCase();
      if (name === "") return this.step({ notice: m`/FORMAT に書式の名前がありません` });
      // `/FORMAT` は**書式書き出し**。同じ書式を指定しても、固定文字から
      // 組み直して打ち込んだ値が消える。base を渡すとメッセージ書き出しに
      // なり、同じ書式のときに画面が 1 ビットも変わらなかった
      return this.show(name, [], { formatWrite: true });
    }
    return this.step({ notice: m`コマンド ${upper} は未実装です（/FORMAT だけを扱う）` });
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

    // プログラムが異常終了したら出力メッセージを捨てる。
    // 実機の MPP が落ちると IMS は直前の同期点まで戻して端末には
    // DFS555I を出す。画面を更新すると「IMS なら決して送らない画面」
    // を見せることになる（データベースの更新はファイルと同じ約束で
    // 残る。MPP の同期点は再現しない。`docs/mfs.md` に明記）
    if (!result.ok) {
      return {
        ...this.step({ notice: m`プログラムが異常終了したので出力を捨てました` }),
        stdout: result.stdout,
        diagnostics: result.diagnostics,
        ok: false,
      };
    }

    const messages = [...tm.outputs];
    if (this.opts.spa !== undefined) {
      // 会話型では最初の ISRT が SPA。トランザクションコードを
      // 空白にして返すと会話が終わる（実機と同じ約束）
      const head = messages[0];
      const spa = head?.segments[0];
      const expected = this.opts.spa - 4;
      if (spa === undefined || spa.length !== expected) {
        // 形が違うものを SPA と見なすと、画面用のセグメントが SPA に
        // 化けて次の入力として戻る。実機は会話を異常終了させる
        return {
          ...this.step({
            notice:
              m`会話型なのに SPA が ISRT されていません（最初の ISRT は ${expected} 桁の SPA。${spa === undefined ? m`1 つも ISRT されていません` : m`${spa.length} 桁でした`}）`,
          }),
          stdout: result.stdout,
          diagnostics: result.diagnostics,
          ok: false,
        };
      }
      head!.segments.shift();
      // トランザクションコードは前置きの末尾 8 桁
      this.spa = firstWord(spa.slice(SPA_HEAD - 8, SPA_HEAD)) === "" ? undefined : spa;
      if (head!.segments.length === 0) messages.shift();
    }
    this.pending = messages.slice(1);
    const head = messages[0];
    const shown =
      head === undefined
        ? this.step(result.ok ? { notice: m`プログラムは画面を返しませんでした` } : {})
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

  /**
   * 出力メッセージを画面にする。
   *
   * MOD 名の決め方（`ISRT` の指定、無ければ MID の `NXT=`）は
   * `mfs/output.ts` の `modNameFor` に 1 つだけ置く。ここに同じ判断を
   * 書くと、大小変換や文面がいずれ食い違う。
   */
  private display(msg: OutputMessage): SessionStep {
    let name: string;
    try {
      name = modNameFor(msg.modName, this.currentMid());
    } catch (e) {
      if (e instanceof MfsBlockError) return this.step({ notice: e.message });
      throw e;
    }
    return this.show(name, msg.segments);
  }

  /** いまの MID の記述。無ければ undefined。 */
  private currentMid(): MessageDesc | undefined {
    if (this.mid === undefined) return undefined;
    try {
      return this.opts.library.mid(this.mid);
    } catch {
      return undefined;
    }
  }

  /**
   * MOD で画面を組み、次に読む MID を決める。
   *
   * `formatWrite` を立てると、装置に同じ書式が入っていても固定文字から
   * 組み直す（実機の書式書き出し）。立てなければメッセージ書き出しで、
   * MOD が触る項目だけを書き換える。
   */
  private show(
    modName: string,
    segments: string[],
    opts: { formatWrite?: boolean } = {},
  ): SessionStep {
    try {
      const screen = formatOutput(
        this.opts.library,
        modName,
        segments,
        this.outputOptions(),
        opts.formatWrite === true ? undefined : this.current,
      );
      this.current = screen;
      // 前の通知を残さない。新しい MOD を送ったら系のメッセージ欄は消える
      this.writeSysmsg("");
      this.mid = this.opts.library.mod(modName).next;
      // 画面は step() が写しにして渡す（ここで screen を渡すと生のまま出る）
      return this.step({});
    } catch (e) {
      if (e instanceof MfsBlockError) return this.step({ notice: e.message });
      throw e;
    }
  }

  /** いまの MID が指す出力の書式。 */
  private nextMod(): string | undefined {
    return this.currentMid()?.next;
  }

  /**
   * `DEV SYSMSG=` で指した項目へ通知を書く。
   *
   * 実機ではここに IMS からの DFS メッセージが出る。指定が無ければ
   * 何もしない（通知は `SessionStep.notice` だけで伝わる）。
   */
  private writeSysmsg(text: string): void {
    const screen = this.current;
    if (screen === undefined) return;
    const fmt = this.opts.library.formats.get(screen.format);
    if (fmt?.sysmsg === undefined) return;
    const f = fieldNamed(screen, fmt.sysmsg);
    if (f === undefined) return;
    f.text = text.padEnd(f.length).slice(0, f.length);
  }

  private step(part: Partial<SessionStep>): SessionStep {
    // 通知は画面の系メッセージ欄にも出す（指定があれば）
    if (part.notice !== undefined) this.writeSysmsg(part.notice);
    return {
      // 写しを渡す。参照のままだと、後の打ち込みが前の画面を書き換える
      ...(this.current === undefined ? {} : { screen: cloneScreen(this.current) }),
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
