/**
 * DBD（データベース記述）を読む。
 *
 * この処理系が正とするのは**階層の形**だけで、物理の配置は再現しない。
 * `ACCESS=` は記録するが、HDAM でも HIDAM でも振る舞いは同じになる。
 * 業務プログラムから見える違い（階層順・順序キー・セグメント長）は
 * すべて論理層で決まるので、学習と検証の用には足りる。
 */

import { m } from "../i18n/index.js";
import { DliDefError, type DbdDef, type FieldDef, type SegmentDef } from "./types.js";
import { listOf, numberOf, readMacros, required, requiredName, type MacroStmt } from "../macro.js";

/**
 * `TYPE=` を読む。
 *
 * **扱えるのは `C`（文字）だけ。** データファイルがテキストなので、
 * `P`（パック 10 進）と `X`（16 進）は表現できない。
 * 受理して文字列として比較すると `'100' > '99'` が偽になり、
 * 「書いたとおりに動いていない」ことに気づけないので名指しで断る。
 */
function fieldType(text: string, s: MacroStmt, file: string): "C" {
  const t = text.toUpperCase();
  if (t === "C") return t;
  if (t === "P" || t === "X") {
    throw new DliDefError(
      m`FIELD の TYPE=${t} は未実装です（データファイルがテキストなので 文字として表せる TYPE=C だけを扱う）`,
      file,
      s.line,
    );
  }
  throw new DliDefError(m`FIELD の TYPE=${text} は扱えません（C のみ）`, file, s.line);
}

/** `PARENT=0` / `PARENT=STUDENT` / `PARENT=((STUDENT,SNGL))` を名前に直す。 */
/** この処理系が扱うアクセス方式。論理層が同じものだけ。 */
const SUPPORTED_ACCESS = new Set(["HDAM", "HIDAM", "HISAM", "HSAM"]);

/** 論理関係に使うポインタ。物理の親子だけを再現するので扱えない。 */
const LOGICAL_POINTERS = new Set(["LTWIN", "LTWINBWD", "LPARNT", "LCHILD", "SNGL", "DBLE"]);

/**
 * `SEGM` 文のうち、論理関係に関わる書き方を断る。
 *
 * 再現するのは**物理の親子関係だけ**。論理関係（1 つのセグメントが
 * 2 つの親を持つ形）は、黙って最初の親だけを採ると
 * 「書いたとおりに動いていない」ことに気づけない。
 */
function checkUnsupportedSegm(s: MacroStmt, file: string): void {
  if (s.operands.has("SOURCE")) {
    throw new DliDefError(
      m`SOURCE= は未実装です（論理セグメントは再現しない）`,
      file,
      s.line,
    );
  }
  const parentText = s.operands.get("PARENT");
  if (parentText !== undefined) {
    const items = listOf(parentText);
    // `PARENT=((A,SNGL),(Z,PHYS,DB))` のように 2 段で 2 つ以上あれば二重親
    if (items.length > 1 && items.every((x) => x.startsWith("("))) {
      throw new DliDefError(
        m`PARENT= に親を 2 つ以上書くこと（論理関係）は未実装です`,
        file,
        s.line,
      );
    }
    for (const item of items) {
      for (const word of listOf(item.replace(/^\(|\)$/g, ""))) {
        if (LOGICAL_POINTERS.has(word.toUpperCase())) {
          throw new DliDefError(
            m`PARENT= の ${word.toUpperCase()} は未実装です（論理関係のポインタ）`,
            file,
            s.line,
          );
        }
      }
    }
  }
  const ptr = s.operands.get("POINTER");
  if (ptr !== undefined) {
    for (const word of listOf(ptr)) {
      if (LOGICAL_POINTERS.has(word.toUpperCase())) {
        throw new DliDefError(
          m`POINTER=${word.toUpperCase()} は未実装です（論理関係のポインタ）`,
          file,
          s.line,
        );
      }
    }
  }
}

function parentOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let first = listOf(text)[0] ?? "";
  // `((STUDENT,SNGL))` は 2 段になる
  while (first.startsWith("(")) first = listOf(first)[0] ?? "";
  if (first === "0" || first === "") return undefined;
  return first.toUpperCase();
}

export function parseDbd(text: string, file: string): DbdDef {
  const stmts = readMacros(text, file);
  if (stmts.length === 0) throw new DliDefError(m`DBD の記述が空です`, file, 1);

  let name: string | undefined;
  let access = "HDAM";
  const segments = new Map<string, SegmentDef>();
  let current: SegmentDef | undefined;
  let root: string | undefined;
  let genSeen = false;

  for (const s of stmts) {
    switch (s.op) {
      case "DBD": {
        if (name !== undefined) {
          throw new DliDefError(m`DBD 文が 2 つあります`, file, s.line);
        }
        name = requiredName(s, "NAME", file);
        const a = s.operands.get("ACCESS");
        if (a !== undefined) {
          const want = (listOf(a)[0] ?? access).toUpperCase();
          // 論理層だけを再現するので HDAM / HIDAM / HISAM / HSAM は同じ扱い。
          // DEDB（高速機能）と GSAM は構造からして違うので名指しで断る
          if (!SUPPORTED_ACCESS.has(want)) {
            throw new DliDefError(
              m`ACCESS=${want} は未実装です（HDAM / HIDAM / HISAM / HSAM のみ。これらは論理層が同じなので同じに扱う）`,
              file,
              s.line,
            );
          }
          access = want;
        }
        break;
      }
      case "DATASET":
      case "AREA":
        // 物理の配置は再現しないので、受け取るだけで使わない
        if (name === undefined) {
          throw new DliDefError(m`${s.op} 文の前に DBD 文が必要です`, file, s.line);
        }
        break;
      case "SEGM": {
        if (name === undefined) {
          throw new DliDefError(m`SEGM 文の前に DBD 文が必要です`, file, s.line);
        }
        const segName = requiredName(s, "NAME", file);
        if (segments.has(segName)) {
          throw new DliDefError(m`セグメント ${segName} が 2 回定義されています`, file, s.line);
        }
        checkUnsupportedSegm(s, file);
        const parent = parentOf(s.operands.get("PARENT"));
        if (parent === undefined) {
          if (root !== undefined) {
            throw new DliDefError(
              m`ルートセグメントは 1 つだけです（${root} と ${segName}）`,
              file,
              s.line,
            );
          }
          root = segName;
        } else {
          const up = segments.get(parent);
          if (up === undefined) {
            throw new DliDefError(
              m`親セグメント ${parent} が定義されていません（SEGM NAME=${segName}）`,
              file,
              s.line,
            );
          }
          up.children.push(segName);
        }
        const seg: SegmentDef = {
          name: segName,
          ...(parent === undefined ? {} : { parent }),
          bytes: numberOf(s, "BYTES", file),
          level: parent === undefined ? 1 : segments.get(parent)!.level + 1,
          fields: [],
          children: [],
        };
        segments.set(segName, seg);
        current = seg;
        break;
      }
      case "FIELD": {
        if (current === undefined) {
          throw new DliDefError(m`FIELD 文の前に SEGM 文が必要です`, file, s.line);
        }
        const parts = listOf(required(s, "NAME", file));
        const fieldName = (parts[0] ?? "").toUpperCase();
        if (fieldName === "") {
          throw new DliDefError(m`FIELD の NAME= が空です`, file, s.line);
        }
        const rest = parts.slice(1).map((p) => p.toUpperCase());
        const field: FieldDef = {
          name: fieldName,
          start: numberOf(s, "START", file),
          bytes: numberOf(s, "BYTES", file),
          type: fieldType(s.operands.get("TYPE") ?? "C", s, file),
        };
        if (field.start + field.bytes - 1 > current.bytes) {
          throw new DliDefError(
            m`項目 ${fieldName} がセグメント ${current.name}（BYTES=${current.bytes}）に収まりません`,
            file,
            s.line,
          );
        }
        current.fields.push(field);
        if (rest.includes("SEQ")) {
          if (current.sequence !== undefined) {
            throw new DliDefError(
              m`セグメント ${current.name} に順序キーが 2 つあります`,
              file,
              s.line,
            );
          }
          current.sequence = { ...field, unique: !rest.includes("M") };
        }
        break;
      }
      case "LCHILD":
        throw new DliDefError(
          m`LCHILD（二次索引・論理関係）は未実装です。物理の階層だけで書いてください`,
          file,
          s.line,
        );
      case "XDFLD":
        throw new DliDefError(
          m`XDFLD（二次索引）は未実装です。物理の階層だけで書いてください`,
          file,
          s.line,
        );
      case "DBDGEN":
        genSeen = true;
        break;
      case "FINISH":
      case "END":
        break;
      default:
        throw new DliDefError(m`${s.op} は DBD の文ではありません`, file, s.line);
    }
  }

  if (name === undefined) {
    throw new DliDefError(m`DBD 文で始まっていません`, file, stmts[0]!.line);
  }
  if (root === undefined) {
    throw new DliDefError(m`ルートセグメント（PARENT=0）がありません`, file, stmts[0]!.line);
  }
  if (!genSeen) {
    throw new DliDefError(m`DBDGEN 文がありません`, file, stmts[stmts.length - 1]!.line);
  }
  return { name, access, segments, root };
}

/**
 * ルートから各セグメントまでの連結キーの長さ。
 * キーフィードバック領域の既定長を決めるのに使う。
 */
export function concatenatedKeyLength(dbd: DbdDef, segment: string): number {
  let total = 0;
  for (let name: string | undefined = segment; name !== undefined; ) {
    const seg = dbd.segments.get(name);
    if (seg === undefined) break;
    total += seg.sequence?.bytes ?? 0;
    name = seg.parent;
  }
  return total;
}
