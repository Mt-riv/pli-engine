/**
 * 3270 の画面の器。
 *
 * 再現するのは**項目の単位**まで。本物のデータストリーム（`SBA` / `SF` /
 * `IC` の並び）は作らない。業務プログラムから見えるのはセグメントであって
 * データストリームではないし、突き合わせる実機が無いものを byte 単位で
 * 固めると、間違った値を固めても気づけない。
 *
 * 画面の位置は**線形の番地**で数える（行 × 桁ではなく）。実機の緩衝が
 * 線形で、項目が行をまたいで続くため。属性バイトは項目の 1 つ前の番地を
 * 食うので、1 桁目から始まる項目の属性バイトは**前の行の最後**に乗る。
 */

import {
  GAP_ATTR,
  MfsDefError,
  type Attr,
  type DeviceFormat,
  type Dpage,
  type Dsca,
  type Eattr,
} from "./blocks.js";

/** 画面上の 1 項目。 */
export interface ScreenField {
  /** `DFLD` のラベル。固定文字だけの項目と隙間の項目には無い。 */
  name?: string;
  line: number;
  col: number;
  length: number;
  attr: Attr;
  eattr?: Eattr;
  /** 中身。固定文字の項目は最初から入っている。 */
  text: string;
  /** 変更の印（MDT）。立っている項目だけが装置から返る。 */
  modified: boolean;
  /** 隙間を埋めるために MFS が作った項目。プログラムからは触れない。 */
  generated: boolean;
  /** 定義した行（診断に使う）。隙間の項目は 0。 */
  srcLine: number;
}

/** 1 画面。 */
export interface Screen {
  rows: number;
  cols: number;
  /** 書式の名前（どの DOF で作ったか）。 */
  format: string;
  fields: ScreenField[];
  cursor: { line: number; col: number };
  dsca: Dsca;
}

/** 行・桁（1 始まり）を線形の番地（0 始まり）にする。 */
export function addressOf(cols: number, line: number, col: number): number {
  return (line - 1) * cols + (col - 1);
}

/** 線形の番地を行・桁に戻す。 */
export function positionOf(cols: number, addr: number): { line: number; col: number } {
  return { line: Math.floor(addr / cols) + 1, col: (addr % cols) + 1 };
}

/**
 * 書式から項目を並べる。
 *
 * 位置の順に並べ替え、**重なりを断り**、2 桁以上あいた隙間には
 * MFS と同じ「定義されていない項目」（`NUM, PROT, NODISP`）を挟む。
 * 隙間の項目が無いと、打ち込める項目の後ろの空きに打ててしまう。
 */
export function layout(fmt: DeviceFormat, dpage: Dpage): ScreenField[] {
  const defined = dpage.dflds
    .map((d) => ({
      ...(d.name === undefined ? {} : { name: d.name }),
      line: d.line,
      col: d.col,
      length: d.length,
      attr: d.attr,
      ...(d.eattr === undefined ? {} : { eattr: d.eattr }),
      text: d.literal === undefined ? "" : d.literal.padEnd(d.length).slice(0, d.length),
      modified: d.attr.modified,
      generated: false,
      srcLine: d.srcLine,
    }))
    .sort(
      (a, b) =>
        addressOf(fmt.cols, a.line, a.col) - addressOf(fmt.cols, b.line, b.col),
    );

  const out: ScreenField[] = [];
  let prevEnd = -1; // 直前の項目の最後のデータ番地
  for (const f of defined) {
    const start = addressOf(fmt.cols, f.line, f.col);
    const attrAddr = start - 1;
    if (attrAddr <= prevEnd) {
      throw new MfsDefError(
        `${f.name ?? "固定文字"}（${f.line} 行 ${f.col} 桁）が前の項目と重なります` +
          "（属性バイトが 1 つ前の位置を食うため、項目の間は 1 桁以上あける）",
        fmt.file,
        f.srcLine,
      );
    }
    // 隙間が 2 桁以上あれば、隙間を表す項目を挟む（属性バイト + 中身）。
    // 作るのは**定義された項目に挟まれた隙間だけ**（実機の規定どおり）。
    // 先頭の項目より前と末尾の項目より後ろには作らない
    const gap = attrAddr - prevEnd - 1;
    if (prevEnd >= 0 && gap >= 2) {
      const gapStart = prevEnd + 2;
      const pos = positionOf(fmt.cols, gapStart);
      out.push({
        line: pos.line,
        col: pos.col,
        length: gap - 1,
        attr: GAP_ATTR,
        text: "",
        modified: false,
        generated: true,
        srcLine: 0,
      });
    }
    out.push(f);
    prevEnd = start + f.length - 1;
  }
  return out;
}

/** 書式の並びを検査する（重なりを読んだ時点で断るために使う）。 */
export function validateLayout(fmt: DeviceFormat): void {
  for (const dpage of fmt.dpages) layout(fmt, dpage);
}

/** 固定文字だけが入った、まだ何も書いていない画面。 */
export function blankScreen(fmt: DeviceFormat, dpage: Dpage): Screen {
  return {
    rows: fmt.rows,
    cols: fmt.cols,
    format: fmt.name,
    fields: layout(fmt, dpage),
    cursor: dpage.cursor ?? firstInputPosition(fmt, dpage),
    dsca: fmt.dsca,
  };
}

/** 打ち込める最初の項目の位置。無ければ 1 行 1 桁。 */
function firstInputPosition(fmt: DeviceFormat, dpage: Dpage): { line: number; col: number } {
  const fields = layout(fmt, dpage);
  const f = fields.find((x) => !x.attr.protect && !x.generated);
  return f === undefined ? { line: 1, col: 1 } : { line: f.line, col: f.col };
}

/** 名前で項目を探す。 */
export function fieldNamed(screen: Screen, name: string): ScreenField | undefined {
  return screen.fields.find((f) => f.name === name);
}

/** その位置を持っている項目を探す（属性バイトの位置は誰のものでもない）。 */
export function fieldAt(screen: Screen, line: number, col: number): ScreenField | undefined {
  const addr = addressOf(screen.cols, line, col);
  return screen.fields.find((f) => {
    const start = addressOf(screen.cols, f.line, f.col);
    return addr >= start && addr < start + f.length;
  });
}

/**
 * 画面を文字の面にする。
 *
 * 属性バイトの位置と `NODISP` の項目は空白になる（装置でも見えない）。
 */
export function cells(screen: Screen): string[][] {
  const grid: string[][] = Array.from({ length: screen.rows }, () =>
    Array.from({ length: screen.cols }, () => " "),
  );
  for (const f of screen.fields) {
    if (f.attr.display === "none") continue;
    const start = addressOf(screen.cols, f.line, f.col);
    const text = f.text.padEnd(f.length).slice(0, f.length);
    for (let i = 0; i < f.length; i++) {
      const addr = start + i;
      if (addr >= screen.rows * screen.cols) break;
      const pos = positionOf(screen.cols, addr);
      grid[pos.line - 1]![pos.col - 1] = text[i] ?? " ";
    }
  }
  return grid;
}

/** 画面の 1 行を文字列にする（右端の空白は落とす）。 */
export function rowText(screen: Screen, line: number): string {
  return (cells(screen)[line - 1] ?? []).join("").replace(/ +$/, "");
}
