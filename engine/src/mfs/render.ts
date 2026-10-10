/**
 * 画面をテキストに起こす。
 *
 * 目で読める形と、テストで byte 一致を見る形を兼ねる。差分が
 * そのまま原因を指すように、画面像のほかにカーソル・警報・
 * 項目の一覧まで同じ 1 本のテキストに入れる。
 *
 * **全角文字は 1 桁として数える。** DBCS は再現しないので、
 * 画面像の桁は定義した桁数と一致するが、等幅で表示すると見た目はずれる。
 */

import { m } from "../i18n/index.js";
import type { Attr } from "./blocks.js";
import { cells, type Screen, type ScreenField } from "./device.js";

/** 桁を数えるための定規。`----+----1----+----2` の形。 */
export function ruler(cols: number): string {
  let out = "";
  for (let c = 1; c <= cols; c++) {
    if (c % 10 === 0) out += String((c / 10) % 10);
    else if (c % 5 === 0) out += "+";
    else out += "-";
  }
  return out;
}

/** 属性を読める形にする。 */
export function attrText(attr: Attr): string {
  const words = [
    attr.numeric ? "NUM" : "ALPHA",
    attr.protect ? "PROT" : "NOPROT",
    attr.display === "hi" ? "HI" : attr.display === "none" ? "NODISP" : "NORM",
  ];
  if (attr.modified) words.push("MOD");
  return words.join(" ");
}

export interface RenderOptions {
  /** 何も書かれていない行も出す。既定は出さない。 */
  blankLines?: boolean;
  /** 項目の一覧を出す。既定は出す。 */
  fields?: boolean;
}

/** 画面の全行（空白行も含む）。ブラウザの表示に使う。 */
export function allRows(screen: Screen): string[] {
  return cells(screen).map((row) => row.join(""));
}

/**
 * 表示の幅をそろえる。全角を 2 桁として数える。
 * 画面像の桁は 1 文字 = 1 桁で数えるが、こちらは**人が読む一覧**なので
 * 見た目の幅に合わせる。
 */
function padDisplay(text: string, width: number): string {
  const shown = [...text].reduce((n, c) => n + (/[^\x00-\xff\uff61-\uffdc\uffe8-\uffee]/.test(c) ? 2 : 1), 0);
  return text + " ".repeat(Math.max(0, width - shown));
}

function fieldLine(f: ScreenField): string {
  const name = padDisplay(f.name ?? m`(固定)`, 8);
  const pos = `(${f.line},${f.col})`.padEnd(9);
  return (
    m`  ${name} ${pos} ${String(f.length).padStart(3)} 桁  ${attrText(f.attr)}${f.modified ? ` ${m`変更`}` : ""}  "${f.text.replace(/ +$/, "")}"`
  );
}

/** 画面をテキストにする。 */
export function renderScreen(screen: Screen, opts: RenderOptions = {}): string {
  const width = String(screen.rows).length;
  const out: string[] = [
    m`書式 ${screen.format}（${screen.rows} 行 × ${screen.cols} 桁）`,
    `${" ".repeat(width)} |${ruler(screen.cols)}`,
  ];
  for (const [i, row] of allRows(screen).entries()) {
    const text = row.replace(/ +$/, "");
    if (text === "" && opts.blankLines !== true) continue;
    out.push(`${String(i + 1).padStart(width)} |${text}`);
  }
  out.push(m`カーソル (${screen.cursor.line},${screen.cursor.col})`);
  out.push(m`警報 ${screen.dsca.alarm ? m`鳴らす` : m`なし`}`);
  out.push(
    m`消去 ${
      screen.dsca.eraseAll
        ? m`画面全部`
        : screen.dsca.eraseUnprotected
          ? m`打ち込める項目`
          : m`なし`
    }`,
  );
  if (opts.fields !== false) {
    out.push(m`項目`);
    for (const f of screen.fields) {
      if (f.generated) continue; // 隙間の項目は MFS が作ったもの
      out.push(fieldLine(f));
    }
  }
  return out.join("\n") + "\n";
}
