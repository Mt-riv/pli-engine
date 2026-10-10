/**
 * 出力の経路。プログラムが書いたセグメントを画面にする。
 *
 *   ISRT → セグメント → [MOD] 項目に切り分け → [DOF] 位置へ置く → 画面
 *
 * 受け取るセグメントは **`LL ZZ` を外した中身**。`LL` / `ZZ` は
 * メッセージキューの話なので `tm/` 側で外す。
 *
 * 時刻は引数で受け取る。`DATE2` や `TIME` を内部で `new Date()` から
 * 取ると、同じ入力でも出力が変わってテストで固定できない
 * （`DATE` / `TIME` 組込関数を未実装にしてあるのと同じ理由）。
 */

import {
  FILL_BLANK,
  MfsBlockError,
  type Fill,
  type MessageDesc,
  type Mfld,
  type MfsLibrary,
  type SystemLiteral,
} from "./blocks.js";
import { blankScreen, fieldNamed, type Screen, type ScreenField } from "./device.js";

export interface OutputOptions {
  /** システム定数が使う時刻。 */
  now: Date;
  /** `LTNAME` に入れる論理端末名。 */
  lterm: string;
}

/** `ATTR=YES` の 2 バイトから読み取った指示。 */
interface AttrOverride {
  /** 属性の指定が入っているか（2 バイト目の先頭ビット）。 */
  present: boolean;
  /** この項目の先頭へカーソルを置く。 */
  cursor: boolean;
  /** DOF の属性を置き換える（false なら論理和）。 */
  replace: boolean;
  protect: boolean;
  numeric: boolean;
  high: boolean;
}

/**
 * `ATTR=YES` の 2 バイトを読む。
 *
 * 1 バイト目 — 先頭 2 ビットが `11` なら、この項目にカーソルを置く。
 * 2 バイト目 — 先頭ビットが `1` のときだけ属性の指定として扱い、
 * 次のビットが置き換え（`1`）か論理和（`0`）、以下
 * 保護 / 数字 / 強調。プログラムが何も入れなければ（空白や 0）
 * 指定なしになる。
 */
function readAttrBytes(two: string): AttrOverride {
  const b0 = two.charCodeAt(0) || 0;
  const b1 = two.charCodeAt(1) || 0;
  return {
    present: (b1 & 0x80) !== 0,
    cursor: (b0 & 0xc0) === 0xc0,
    replace: (b1 & 0x40) !== 0,
    protect: (b1 & 0x20) !== 0,
    numeric: (b1 & 0x10) !== 0,
    high: (b1 & 0x08) !== 0,
  };
}

/** システム定数の中身を作る。 */
export function systemLiteral(which: SystemLiteral, opts: OutputOptions): string {
  const d = opts.now;
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  switch (which) {
    case "DATE1": {
      const start = new Date(d.getFullYear(), 0, 1);
      const day = Math.floor((d.getTime() - start.getTime()) / 86400000) + 1;
      return `${yy}.${String(day).padStart(3, "0")}`;
    }
    case "DATE2":
      return `${mm}/${dd}/${yy}`;
    case "DATE3":
      return `${dd}/${mm}/${yy}`;
    case "DATE4":
      return `${yy}/${mm}/${dd}`;
    case "TIME": {
      const hh = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${hh}:${mi}:${ss}`;
    }
    case "LTNAME":
      return opts.lterm.padEnd(8).slice(0, 8);
  }
}

/** 項目へ中身を置く。長ければ切り、短ければ埋める。 */
function place(field: ScreenField, data: string, mfld: Mfld, fill: Fill): void {
  const len = field.length;
  if (data.length >= len) {
    // JUST=R は左を切る（右端をそろえる）
    field.text = mfld.just === "R" ? data.slice(data.length - len) : data.slice(0, len);
    return;
  }
  // 出力の FILL=NULL は「埋めない」。画面は空白のままになる
  const pad = fill.kind === "null" ? " " : fill.c;
  field.text = mfld.just === "R" ? data.padStart(len, pad) : data.padEnd(len, pad);
}

/**
 * MOD と DOF でセグメントを画面にする。
 *
 * `segments` は `ISRT` された順。`LL ZZ` は外してあること。
 *
 * `base` に**いま装置に出ている画面**を渡すと、同じ書式が入っている
 * 場合は書き換えを MOD が触る項目だけにする（実機でいう
 * メッセージ書き出し）。渡さない場合と、`DSCA` で強制書き出しが
 * 指定されている場合は、固定文字から組み直す（書式書き出し）。
 * **打ち込んだまま返ってきた値が消えないのはこのため。**
 */
export function formatOutput(
  lib: MfsLibrary,
  modName: string,
  segments: string[],
  opts: OutputOptions,
  base?: Screen,
): Screen {
  const mod = lib.mod(modName);
  const dof = lib.dof(mod.sor);
  const lpage = mod.lpages[0];
  const dpage = dof.dpages[0];
  if (lpage === undefined || dpage === undefined) {
    throw new MfsBlockError(`${mod.name} / ${dof.name} に項目の定義がありません`);
  }
  const screen = blankScreen(dof, dpage);
  if (base !== undefined && base.format === dof.name && !dof.dsca.eraseAll) {
    for (const f of screen.fields) {
      const prev = base.fields.find((p) => p.line === f.line && p.col === f.col);
      if (prev === undefined) continue;
      f.text = prev.text;
      f.attr = prev.attr;
      // 書き出しのたびに変更の印は落ちる。打ち直さなければ
      // 次の入力では返らない（実機の 3270 と同じ）
      f.modified = false;
    }
  }
  if (dof.dsca.eraseUnprotected) {
    for (const f of screen.fields) if (!f.attr.protect) f.text = "";
  }
  if (segments.length > lpage.segs.length) {
    throw new MfsBlockError(
      `${mod.name} のセグメントは ${lpage.segs.length} 個ですが、` +
        `${segments.length} 個 ISRT されました`,
    );
  }
  let cursorField: ScreenField | undefined;

  for (const [i, data] of segments.entries()) {
    const segDef = lpage.segs[i]!;
    let pos = 0;
    for (const mfld of segDef.mflds) {
      const chunk = data.slice(pos, pos + mfld.length);
      pos += mfld.length;
      if (mfld.source.kind === "filler") continue;

      let body = chunk;
      let override: AttrOverride | undefined;
      if (mfld.attrBytes) {
        override = readAttrBytes(chunk.padEnd(2));
        body = chunk.slice(2);
      }
      const target =
        mfld.source.kind === "dfld" || mfld.source.kind === "dfld-literal"
          ? mfld.source.name
          : mfld.source.kind === "system"
            ? mfld.source.name
            : undefined;
      if (target === undefined) continue;
      const field = fieldNamed(screen, target);
      if (field === undefined) {
        // 読んだ時点で照合しているので、ここに来るのは隙間の項目を
        // 指したときだけ
        throw new MfsBlockError(`${dof.name} に項目 ${target} がありません`);
      }
      const text =
        mfld.source.kind === "system" ? systemLiteral(mfld.source.which, opts) : body;
      // 埋め文字は DPAGE FILL → MSG FILL → 空白 の順で決まる
      place(field, text, mfld, dpage.fill ?? mod.fill ?? FILL_BLANK);
      if (override !== undefined) {
        if (override.present) {
          field.attr = override.replace
            ? {
                numeric: override.numeric,
                protect: override.protect,
                display: override.high ? "hi" : "norm",
                modified: false,
              }
            : {
                numeric: field.attr.numeric || override.numeric,
                protect: field.attr.protect || override.protect,
                display: override.high ? "hi" : field.attr.display,
                modified: field.attr.modified,
              };
        }
        if (override.cursor) cursorField = field;
      }
    }
  }
  if (cursorField !== undefined) {
    screen.cursor = { line: cursorField.line, col: cursorField.col };
  }
  return screen;
}

/** 出力に使う MOD の名前を決める。`ISRT` の指定が無ければ MID の `NXT=`。 */
export function modNameFor(isrtName: string | undefined, mid: MessageDesc | undefined): string {
  const given = isrtName?.trim();
  if (given !== undefined && given !== "") return given.toUpperCase();
  const next = mid?.next;
  if (next === undefined) {
    throw new MfsBlockError(
      "出力の書式が決まりません（ISRT に MOD 名を渡すか、MID に NXT= を書いてください）",
    );
  }
  return next;
}
