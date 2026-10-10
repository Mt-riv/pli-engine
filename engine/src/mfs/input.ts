/**
 * 入力の経路。装置から返ってきたものをセグメントにする。
 *
 *   端末 → [DIF] どの項目か → [MID] セグメントに並べる → GU / GN
 *
 * 返すセグメントは **`LL ZZ` を付けない中身**。`LL` / `ZZ` を付けるのは
 * メッセージキューの仕事（`tm/`）。
 *
 * **変更されていない項目は装置から返ってこない**（MDT）。だから
 * 「何も来なかった項目」が普通に起こり、そのときに `FILL=` と
 * `MFLD` の固定文字が効く。`FILL=NULL` の項目は**セグメントから消える**
 * （実機の OPT=1 の規定）。
 */

import { m } from "../i18n/index.js";
import {
  MfsBlockError,
  type Fill,
  type Mfld,
  type MfsLibrary,
} from "./blocks.js";

/** 押したキー。 */
export type Aid =
  | { kind: "enter" }
  | { kind: "pf"; n: number }
  | { kind: "pa"; n: number }
  | { kind: "clear" };

/** 装置から返ってきたもの。 */
export interface DeviceInput {
  aid: Aid;
  /**
   * 変更された項目（項目名 → 中身）。
   * 変更の印が立っていない項目は**入れない**（実機でも返ってこない）。
   */
  fields: Map<string, string>;
}

/** キーの名前。診断に使う。 */
export function aidName(aid: Aid): string {
  switch (aid.kind) {
    case "enter": return "ENTER";
    case "pf": return `PF${aid.n}`;
    case "pa": return `PA${aid.n}`;
    case "clear": return "CLEAR";
  }
}

/**
 * 項目の中身を長さにそろえる。
 *
 * `FILL=NULL` のとき、**何も返らなかった項目**はセグメントから消えるが
 * （呼び側で落とす）、**短いデータが返った項目**はここで空白まで伸ばす。
 * セグメントの桁割りが固定なので、途中の項目だけ詰めると後ろの項目の
 * 位置がずれてプログラムの宣言と合わなくなる。実機の圧縮の規則までは
 * 確かめようが無いので、この扱いに決めて書き残しておく。
 */
function fit(data: string, mfld: Mfld, fill: Fill): string {
  const len = mfld.length;
  if (data.length >= len) {
    return mfld.just === "R" ? data.slice(data.length - len) : data.slice(0, len);
  }
  const pad = fill.kind === "null" ? " " : fill.c;
  return mfld.just === "R" ? data.padStart(len, pad) : data.padEnd(len, pad);
}

/**
 * MID と DIF でセグメントを組む。
 *
 * `PF` キーに `DEV PFK=` の割り当てがあれば、その固定文字を
 * 割り当て先の項目の中身として扱う（トランザクションコードを
 * この手で入れるのが定石）。
 */
export function formatInput(
  lib: MfsLibrary,
  midName: string,
  input: DeviceInput,
): string[] {
  const mid = lib.mid(midName);
  const dif = lib.dif(mid.sor);
  const lpage = mid.lpages[0];
  if (lpage === undefined) {
    throw new MfsBlockError(m`${mid.name} に項目の定義がありません`);
  }
  const data = new Map(input.fields);
  if (input.aid.kind === "pf") {
    const pfk = dif.pfk.get(input.aid.n);
    if (pfk?.dfld !== undefined) data.set(pfk.dfld, pfk.literal);
  }

  const segments: string[] = [];
  for (const seg of lpage.segs) {
    let text = "";
    for (const mfld of seg.mflds) {
      const fill = mfld.fill;
      switch (mfld.source.kind) {
        case "literal":
          text += fit(mfld.source.text, mfld, fill);
          break;
        case "filler":
          text += " ".repeat(mfld.length);
          break;
        case "system":
          // 読んだ時点で断っている
          throw new MfsBlockError(m`${mid.name} の MFLD に出力専用の定数があります`);
        case "dfld":
        case "dfld-literal": {
          const got = data.get(mfld.source.name);
          if (got !== undefined) {
            text += fit(got, mfld, fill);
            break;
          }
          if (mfld.source.kind === "dfld-literal") {
            // 装置から何も来なければ固定文字を使う（ENTER のときの定石）
            text += fit(mfld.source.text, mfld, fill);
            break;
          }
          // FILL=NULL の項目は、入力が無ければセグメントから消える
          if (fill.kind === "null") break;
          text += fill.c.repeat(mfld.length);
          break;
        }
      }
    }
    segments.push(text);
  }
  return segments;
}

