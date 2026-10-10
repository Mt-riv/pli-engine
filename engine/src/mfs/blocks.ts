/**
 * MFS（Message Format Service）の制御ブロック。
 *
 * 実機の MFS は書式定義を 4 種類の制御ブロックに落とし、組（format set）で使う。
 *
 *   MID — Message Input Descriptor。装置から来たものをプログラムが見る形に組む
 *   MOD — Message Output Descriptor。プログラムが書いたものを装置向けに配る
 *   DIF — Device Input Format。装置から来るデータの形（位置と項目）
 *   DOF — Device Output Format。装置へ送る画面の形（位置・属性・固定文字）
 *
 * `MSG TYPE=INPUT` が MID、`TYPE=OUTPUT` が MOD になり、`FMT` は
 * `DIV TYPE=` の向きに応じて DIF・DOF・その両方になる。
 * この階層は**文字列と値だけを扱う**（`dli/` と同じ掟）。画面の組み立ては
 * `output.ts`、装置からの取り込みは `input.ts`、器は `device.ts`。
 */

import { m } from "../i18n/index.js";
import { DefError } from "../macro.js";

/** MFS の記述の誤り。どのファイルの何行目かを必ず持つ。 */
export class MfsDefError extends DefError {
  constructor(message: string, file: string, line: number) {
    super(message, file, line, "MfsDefError");
  }
}

/**
 * 求めた制御ブロックが無い・向きが違う。
 *
 * 実機でいう DFS057I「要求されたブロックが使えない」にあたる。
 * 定義の書き間違いとは出どころが違う（実行してみて初めて分かる）ので
 * 別の型にしてある。
 */
export class MfsBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfsBlockError";
  }
}

// ---- 装置側（DIF / DOF） ----

/** 3270 の項目属性。既定値は IBM の規定どおり（下の `DEFAULT_ATTR`）。 */
export interface Attr {
  /** `NUM` なら数字キーボード。既定は `ALPHA`。 */
  numeric: boolean;
  /** `PROT` なら打ち込めない。既定は `NOPROT`。 */
  protect: boolean;
  /** `NORM` / `NODISP`（出さない）/ `HI`（強調）。 */
  display: "norm" | "none" | "hi";
  /** `MOD` なら最初から「変更済み」の印が立つ。既定は `NOMOD`。 */
  modified: boolean;
}

/** ATTR= を省いたときの属性。ALPHA, NOPROT, NORM, NOMOD。 */
export const DEFAULT_ATTR: Attr = {
  numeric: false,
  protect: false,
  display: "norm",
  modified: false,
};

/**
 * 定義された項目に挟まれた隙間に MFS が作る項目。
 *
 * 2 桁以上あいていると、実機の MFS は隙間を表す項目を作る。
 * その属性は `NUM, PROT, NODISP` と規定されている
 * （打ち込めず、何も見えない）。
 */
export const GAP_ATTR: Attr = {
  numeric: true,
  protect: true,
  display: "none",
  modified: false,
};

/** 拡張属性。色と強調だけ扱う。 */
export interface Eattr {
  color?: string;
  highlight?: string;
}

/** 装置上の 1 項目（`DFLD`）。 */
export interface Dfld {
  /** ラベル。固定文字だけの項目には無い。 */
  name?: string;
  /** `POS=` の行（1 始まり）。 */
  line: number;
  /** `POS=` の桁（1 始まり）。**属性バイトは 1 つ前の位置を食う。** */
  col: number;
  /** 項目の長さ。固定文字だけなら文字の長さ。 */
  length: number;
  /** 固定文字（出力に出るだけで、プログラムには渡らない）。 */
  literal?: string;
  attr: Attr;
  eattr?: Eattr;
  /** 定義した行（診断に使う）。 */
  srcLine: number;
}

/** 項目を埋める文字の決め方。 */
export type Fill = { kind: "char"; c: string } | { kind: "null" };

/** 空白で埋める（既定）。 */
export const FILL_BLANK: Fill = { kind: "char", c: " " };

/** 装置の 1 画面分（`DPAGE`）。 */
export interface Dpage {
  /** `CURSOR=((ll,cc))`。無ければ最初の打ち込める項目へ置く。 */
  cursor?: { line: number; col: number };
  /** 出力で項目の残りを埋める文字。書かれていなければ MSG の `FILL=`。 */
  fill?: Fill;
  dflds: Dfld[];
}

/** PF キー 1 つの割り当て。 */
export interface Pfk {
  /** 入れる先の項目。`DEV PFK=(項目名,…)` の項目名。 */
  dfld?: string;
  literal: string;
}

/** `DSCA=` のうち、この処理系が見る印。 */
export interface Dsca {
  /** 装置の緩衝を消してから書く（X'0040'）。 */
  eraseAll: boolean;
  /** 打ち込める項目を消してから書く（X'0020'）。 */
  eraseUnprotected: boolean;
  /** 警報を鳴らす（X'0010'）。 */
  alarm: boolean;
}

export const NO_DSCA: Dsca = { eraseAll: false, eraseUnprotected: false, alarm: false };

/**
 * 書式定義 1 つ（`FMT` … `FMTEND`）。
 *
 * `div` が `INOUT` なら DIF と DOF の両方として使える。
 * `INPUT` なら DIF だけ、`OUTPUT` なら DOF だけ。
 */
export interface DeviceFormat {
  name: string;
  /** `DEV TYPE=` に書かれたまま。 */
  deviceType: string;
  rows: number;
  cols: number;
  div: "INPUT" | "OUTPUT" | "INOUT";
  /** PF キーの割り当て。キーは 1〜24。 */
  pfk: Map<number, Pfk>;
  dsca: Dsca;
  /** IMS からの通知を出す項目（`SYSMSG=`）。 */
  sysmsg?: string;
  dpages: Dpage[];
  file: string;
  srcLine: number;
}

// ---- メッセージ側（MID / MOD） ----

/** 出力に使える、MFS が作る定数。 */
export type SystemLiteral = "DATE1" | "DATE2" | "DATE3" | "DATE4" | "TIME" | "LTNAME";

/** `MFLD` が何から取るか。 */
export type MfldSource =
  | { kind: "dfld"; name: string }
  /** `MFLD (項目,'固定文字')`。装置から何も来なければ固定文字を使う。 */
  | { kind: "dfld-literal"; name: string; text: string }
  | { kind: "literal"; text: string }
  /** `MFLD (項目,DATE2)`。MFS が作る定数を項目へ入れる。 */
  | { kind: "system"; name: string; which: SystemLiteral }
  /** 場所取りだけ（出力は埋め草、入力は読み飛ばし）。 */
  | { kind: "filler" };

/** メッセージの 1 項目（`MFLD`）。 */
export interface Mfld {
  source: MfldSource;
  length: number;
  just: "L" | "R";
  fill: Fill;
  /** `ATTR=YES`。先頭 2 バイトが属性になる（長さに含む）。 */
  attrBytes: boolean;
  srcLine: number;
}

/** メッセージの 1 セグメント（`SEG`）。 */
export interface MsgSeg {
  mflds: Mfld[];
}

/** 論理ページ（`LPAGE`）。 */
export interface Lpage {
  segs: MsgSeg[];
}

/** メッセージ記述 1 つ（`MSG` … `MSGEND`）。MID か MOD。 */
export interface MessageDesc {
  name: string;
  type: "INPUT" | "OUTPUT";
  /** `SOR=` が指す書式定義の名前。 */
  sor: string;
  /** `SOR=(…,IGNORE)`。 */
  sorIgnore: boolean;
  /** `NXT=`。次に使う記述。入力なら MOD、出力なら MID を指す。 */
  next?: string;
  /** 出力で項目の残りを埋める文字（`DPAGE FILL=` が無いときに使う）。 */
  fill?: Fill;
  lpages: Lpage[];
  file: string;
  srcLine: number;
}

/** セグメントの長さ（`LL ZZ` の 4 バイトを含む）。 */
export function segmentLength(seg: MsgSeg): number {
  return 4 + seg.mflds.reduce((n, f) => n + f.length, 0);
}

/**
 * 書式定義とメッセージ記述の表。
 *
 * 実機の `IMS.FORMAT` ライブラリにあたる。名前はライブラリ全体で一意。
 */
export class MfsLibrary {
  constructor(
    readonly formats: Map<string, DeviceFormat>,
    readonly messages: Map<string, MessageDesc>,
  ) {}

  get empty(): boolean {
    return this.formats.size === 0 && this.messages.size === 0;
  }

  /** MID を取る（入力用のメッセージ記述）。 */
  mid(name: string): MessageDesc {
    const desc = this.message(name);
    if (desc.type !== "INPUT") {
      throw new MfsBlockError(
        m`${name} は MSG TYPE=OUTPUT（MOD）なので入力の整形には使えません`,
      );
    }
    return desc;
  }

  /** MOD を取る（出力用のメッセージ記述）。 */
  mod(name: string): MessageDesc {
    const desc = this.message(name);
    if (desc.type !== "OUTPUT") {
      throw new MfsBlockError(
        m`${name} は MSG TYPE=INPUT（MID）なので出力の整形には使えません`,
      );
    }
    return desc;
  }

  /** DIF を取る（装置から来るものの形）。 */
  dif(name: string): DeviceFormat {
    const f = this.format(name);
    if (f.div === "OUTPUT") {
      throw new MfsBlockError(
        m`${name} は DIV TYPE=OUTPUT なので入力には使えません（DIF がありません）`,
      );
    }
    return f;
  }

  /** DOF を取る（装置へ送る画面の形）。 */
  dof(name: string): DeviceFormat {
    const f = this.format(name);
    if (f.div === "INPUT") {
      throw new MfsBlockError(
        m`${name} は DIV TYPE=INPUT なので出力には使えません（DOF がありません）`,
      );
    }
    return f;
  }

  private message(name: string): MessageDesc {
    const found = this.messages.get(name.trim().toUpperCase());
    if (found === undefined) {
      throw new MfsBlockError(m`メッセージ記述 ${name.trim()} がありません`);
    }
    return found;
  }

  private format(name: string): DeviceFormat {
    const f = this.formats.get(name.trim().toUpperCase());
    if (f === undefined) {
      throw new MfsBlockError(m`書式定義 ${name.trim()} がありません`);
    }
    return f;
  }
}

/** 空の表。MFS を使わない実行で使う。 */
export const EMPTY_LIBRARY = new MfsLibrary(new Map(), new Map());
