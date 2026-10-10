/**
 * 宣言の並びの平坦化。
 *
 * 評価器（`interp.ts`）と Linter （`lint.ts`）の両方が
 * 「この宣言はどの名前を作るのか」を同じ規則で知る必要があるため、
 * ここに 1 つだけ置く。
 */

import type { DeclItem, Ref } from "./ast.js";

/**
 * 宣言の並びを葉の項目へ平坦化する。
 *
 * レベル番号が付いていれば構造体として扱い、葉を修飾名
 * （`REC.ADDR.CITY`）にする。中間レベル（名前だけで型を持たない）は
 * 記憶域を持たないので返さない。
 */
export function qualifyDeclareItems(items: DeclItem[]): DeclItem[] {
  const out: DeclItem[] = [];
  const path: string[] = [];
  const levels: number[] = [];
  /**
   * 構造体そのものに付いた BASED。葉に引き継ぐ。
   * `dcl 1 node based(p), 2 value ...;` の BASED は構造体全体に効く。
   */
  const basedStack: ({ pointer?: Ref } | undefined)[] = [];

  for (const [idx, item] of items.entries()) {
    if (item.level === undefined) {
      out.push(item);
      continue;
    }
    // 自分より深い/同じレベルを畳む
    while (levels.length > 0 && levels[levels.length - 1]! >= item.level) {
      levels.pop();
      path.pop();
      basedStack.pop();
    }
    const name = item.names[0] ?? "";
    const next = items[idx + 1];
    // 次の項目がより深いレベルなら中間ノード（記憶域なし）
    if (next?.level !== undefined && next.level > item.level) {
      levels.push(item.level);
      path.push(name);
      basedStack.push(item.based);
      continue;
    }
    // 自分に BASED が無ければ、外側の構造体のものを引き継ぐ
    const inherited = [...basedStack].reverse().find((b) => b !== undefined);
    const based = item.based ?? inherited;
    // 括弧付きの名前リスト（`2 (a, b) char(4)`）は葉を名前の数だけ作る。
    // `names[0]` だけを見ていると 2 つめ以降が黙って消える
    for (const one of item.names.length > 0 ? item.names : [name]) {
      out.push({
        ...item,
        names: [[...path, one].join(".")],
        ...(based === undefined ? {} : { based }),
      });
    }
  }
  return out;
}

/**
 * 中間レベル（構造体そのもの）の修飾名。
 *
 * 記憶域は持たないが `PUT LIST(REC)` のように名前としては書けるので、
 * Linter が「宣言されていない」と誤って報告しないために要る。
 */
export function groupNames(items: DeclItem[]): string[] {
  const out: string[] = [];
  const path: string[] = [];
  const levels: number[] = [];
  for (const [idx, item] of items.entries()) {
    if (item.level === undefined) continue;
    while (levels.length > 0 && levels[levels.length - 1]! >= item.level) {
      levels.pop();
      path.pop();
    }
    const name = item.names[0] ?? "";
    const next = items[idx + 1];
    if (next?.level !== undefined && next.level > item.level) {
      levels.push(item.level);
      path.push(name);
      out.push([...path].join("."));
    }
  }
  return out;
}
