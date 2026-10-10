/**
 * 書式定義の「止めるほどではないが、たぶん間違い」を拾う。
 *
 * 画面が組めない誤り（項目の重なり、参照先が無い、画面の外など）は
 * 読んだ時点で断っている（`source.ts`）。ここで見るのは、
 * 定義としては通るが動かしてみて初めて困るもの。
 *
 * `lint.ts` は PL/I のソースを見る層なので、そちらには入れない。
 */

import { layout } from "./device.js";
import type { MfsLibrary } from "./blocks.js";

export interface MfsWarning {
  file: string;
  line: number;
  message: string;
}

/** 人が読める 1 行にする。 */
export function formatWarning(w: MfsWarning): string {
  return `${w.file} ${w.line} 行: ${w.message}`;
}

export function checkMfs(lib: MfsLibrary): MfsWarning[] {
  const out: MfsWarning[] = [];
  /** どの DFLD が MFLD から指されているか。 */
  const used = new Set<string>();
  /** 入力（MID）に使われている書式。 */
  const asInput = new Set<string>();

  for (const m of lib.messages.values()) {
    if (m.type === "INPUT") asInput.add(m.sor);
    for (const seg of m.lpages.flatMap((l) => l.segs)) {
      for (const f of seg.mflds) {
        if (f.source.kind === "dfld" || f.source.kind === "dfld-literal") {
          used.add(`${m.sor}.${f.source.name}`);
        } else if (f.source.kind === "system") {
          used.add(`${m.sor}.${f.source.name}`);
        }
      }
    }
  }

  for (const fmt of lib.formats.values()) {
    for (const dpage of fmt.dpages) {
      const fields = layout(fmt, dpage).filter((f) => !f.generated);
      const typable = fields.filter((f) => !f.attr.protect && f.name !== undefined);

      if (asInput.has(fmt.name) && typable.length === 0) {
        out.push({
          file: fmt.file,
          line: fmt.srcLine,
          message:
            `書式 ${fmt.name} は入力に使われていますが、打ち込める項目が 1 つもありません` +
            "（すべて PROT です）",
        });
      }

      const cursor = dpage.cursor;
      if (cursor !== undefined) {
        const at = fields.find((f) => f.line === cursor.line && f.col === cursor.col);
        if (at === undefined) {
          out.push({
            file: fmt.file,
            line: fmt.srcLine,
            message:
              `DPAGE CURSOR=((${cursor.line},${cursor.col})) の位置に項目がありません` +
              "（項目の先頭を指してください）",
          });
        } else if (at.attr.protect) {
          out.push({
            file: fmt.file,
            line: at.srcLine,
            message: `DPAGE CURSOR= が保護された項目 ${at.name ?? "（固定文字）"} を指しています`,
          });
        }
      }

      for (const f of fields) {
        // 拡張属性（色・下線など）は読むが、この処理系の画面像は
        // 位置・長さ・基本属性しか持たないので絵に出ない。
        // 黙って無視すると「書いたのに効かない」ので知らせる
        if (f.eattr !== undefined) {
          out.push({
            file: fmt.file,
            line: f.srcLine,
            message:
              `項目 ${f.name ?? "（固定文字）"} の EATTR= は画面像に出ません` +
              "（色・下線などの拡張属性は再現しません）",
          });
        }
        if (f.name === undefined) continue;
        if (fmt.sysmsg !== undefined && f.name === fmt.sysmsg) continue;
        if (used.has(`${fmt.name}.${f.name}`)) continue;
        out.push({
          file: fmt.file,
          line: f.srcLine,
          message:
            `項目 ${f.name} はどの MFLD からも指されていません` +
            "（名前の綴り違いか、要らない項目です）",
        });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
