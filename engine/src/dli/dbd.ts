/**
 * DBD（データベース記述）を読む。
 *
 * この処理系が正とするのは**階層の形**だけで、物理の配置は再現しない。
 * `ACCESS=` は記録するが、HDAM でも HIDAM でも振る舞いは同じになる。
 * 業務プログラムから見える違い（階層順・順序キー・セグメント長）は
 * すべて論理層で決まるので、学習と検証の用には足りる。
 */

import { DliDefError, type DbdDef, type FieldDef, type SegmentDef } from "./types.js";
import { listOf, numberOf, readMacros, required, type MacroStmt } from "./macro.js";

/** 受け付ける `TYPE=`。実際に扱うのは C だけ。 */
function fieldType(text: string, s: MacroStmt, file: string): "C" | "P" | "X" {
  const t = text.toUpperCase();
  if (t === "C" || t === "P" || t === "X") return t;
  throw new DliDefError(`FIELD の TYPE=${text} は扱えません（C / P / X）`, file, s.line);
}

/** `PARENT=0` / `PARENT=STUDENT` / `PARENT=((STUDENT,SNGL))` を名前に直す。 */
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
  if (stmts.length === 0) throw new DliDefError("DBD の記述が空です", file, 1);

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
          throw new DliDefError("DBD 文が 2 つあります", file, s.line);
        }
        name = required(s, "NAME", file).toUpperCase();
        const a = s.operands.get("ACCESS");
        if (a !== undefined) access = (listOf(a)[0] ?? access).toUpperCase();
        break;
      }
      case "DATASET":
      case "AREA":
        // 物理の配置は再現しないので、受け取るだけで使わない
        if (name === undefined) {
          throw new DliDefError(`${s.op} 文の前に DBD 文が必要です`, file, s.line);
        }
        break;
      case "SEGM": {
        if (name === undefined) {
          throw new DliDefError("SEGM 文の前に DBD 文が必要です", file, s.line);
        }
        const segName = required(s, "NAME", file).toUpperCase();
        if (segments.has(segName)) {
          throw new DliDefError(`セグメント ${segName} が 2 回定義されています`, file, s.line);
        }
        const parent = parentOf(s.operands.get("PARENT"));
        if (parent === undefined) {
          if (root !== undefined) {
            throw new DliDefError(
              `ルートセグメントは 1 つだけです（${root} と ${segName}）`,
              file,
              s.line,
            );
          }
          root = segName;
        } else {
          const up = segments.get(parent);
          if (up === undefined) {
            throw new DliDefError(
              `親セグメント ${parent} が定義されていません（SEGM NAME=${segName}）`,
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
          throw new DliDefError("FIELD 文の前に SEGM 文が必要です", file, s.line);
        }
        const parts = listOf(required(s, "NAME", file));
        const fieldName = (parts[0] ?? "").toUpperCase();
        if (fieldName === "") {
          throw new DliDefError("FIELD の NAME= が空です", file, s.line);
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
            `項目 ${fieldName} がセグメント ${current.name}（BYTES=${current.bytes}）に収まりません`,
            file,
            s.line,
          );
        }
        current.fields.push(field);
        if (rest.includes("SEQ")) {
          if (current.sequence !== undefined) {
            throw new DliDefError(
              `セグメント ${current.name} に順序キーが 2 つあります`,
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
          "LCHILD（二次索引・論理関係）は未実装です。物理の階層だけで書いてください",
          file,
          s.line,
        );
      case "XDFLD":
        throw new DliDefError(
          "XDFLD（二次索引）は未実装です。物理の階層だけで書いてください",
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
        throw new DliDefError(`${s.op} は DBD の文ではありません`, file, s.line);
    }
  }

  if (name === undefined) {
    throw new DliDefError("DBD 文で始まっていません", file, stmts[0]!.line);
  }
  if (root === undefined) {
    throw new DliDefError("ルートセグメント（PARENT=0）がありません", file, stmts[0]!.line);
  }
  if (!genSeen) {
    throw new DliDefError("DBDGEN 文がありません", file, stmts[stmts.length - 1]!.line);
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
