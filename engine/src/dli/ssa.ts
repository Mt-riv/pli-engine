/**
 * SSA（セグメント検索引数）の構文解析。
 *
 * 書式は桁で決まっている。
 *
 *   1〜8 桁    セグメント名（足りない分は空白で埋める）
 *   9 桁目〜   空白なら無修飾、`*` ならコマンドコード、`(` なら修飾
 *   修飾の中   項目名 8 桁 + 関係演算子 2 桁 + 値
 *
 * 値の長さは本来 DBD の項目長と同じでなければならない。ここでは
 * **項目長を上限として、閉じ括弧か論理記号まで**を値とする。
 * 手で書くときに `(STUDNO   =S1)` のような短い値を許したいため。
 * 長すぎる値は誤りとして断る（桁がずれているのを見逃さない）。
 *
 * 誤りは例外ではなく値で返す。DL/I では SSA の誤りはステータスコード
 * `AJ` としてプログラムに返るもので、処理系が止まる種類の誤りではない。
 */

import type { DbdDef, FieldDef } from "./types.js";

export type RelOp = "EQ" | "NE" | "GT" | "LT" | "GE" | "LE";

/** 修飾の 1 条件。`join` は前の条件との結び方。 */
export interface SsaCondition {
  field: string;
  op: RelOp;
  value: string;
  join?: "AND" | "OR" | "IAND";
}

export interface Ssa {
  segment: string;
  /** `*` の後のコマンドコード。`-`（null）は含めない。 */
  commands: string[];
  conditions: SsaCondition[];
  /** 修飾されているか（コマンドコードだけなら false）。 */
  qualified: boolean;
  /** `C` コマンドコードで渡された連結キー。 */
  concatenatedKey?: string;
  /** 元の文字列。診断に使う。 */
  source: string;
}

export type SsaParse =
  | { ok: true; ssa: Ssa }
  | { ok: false; status: "AJ"; reason: string };

/** セグメント名の欄の幅。 */
const NAME_WIDTH = 8;
/** 項目名の欄の幅。 */
const FIELD_WIDTH = 8;
/** 関係演算子の欄の幅。 */
const OP_WIDTH = 2;

/** IMS のコマンドコード。この処理系が実際に効かせるものは dli.ts が選ぶ。 */
const COMMAND_CODES = new Set(["A", "C", "D", "F", "G", "L", "M", "N", "P", "Q", "U", "V"]);

const JOINS: Record<string, "AND" | "OR" | "IAND"> = {
  "*": "AND",
  "&": "AND",
  "|": "OR",
  "#": "IAND",
};

/** 関係演算子の 2 桁を正規化する。 */
function relOp(text: string): RelOp | undefined {
  const t = text.trim().toUpperCase();
  switch (t) {
    case "=":
    case "EQ":
      return "EQ";
    case ">":
    case "GT":
      return "GT";
    case "<":
    case "LT":
      return "LT";
    case ">=":
    case "=>":
    case "GE":
      return "GE";
    case "<=":
    case "=<":
    case "LE":
      return "LE";
    case "!=":
    case "=!":
    case "NE":
    case "^=":
    case "=^":
    case "¬=":
      return "NE";
    default:
      return undefined;
  }
}

function fail(reason: string): SsaParse {
  return { ok: false, status: "AJ", reason };
}

export function parseSsa(text: string, dbd: DbdDef): SsaParse {
  const segment = text.slice(0, NAME_WIDTH).trim().toUpperCase();
  if (segment === "") return fail("SSA にセグメント名がありません");
  const seg = dbd.segments.get(segment);
  if (seg === undefined) {
    return fail(`セグメント ${segment} は DBD ${dbd.name} にありません`);
  }

  let pos = NAME_WIDTH;
  const commands: string[] = [];
  if (text[pos] === "*") {
    pos++;
    for (; pos < text.length; pos++) {
      const c = text[pos]!.toUpperCase();
      if (c === "(" || c === " ") break;
      if (c === "-") continue; // null コマンドコード
      if (!COMMAND_CODES.has(c)) return fail(`${text[pos]} はコマンドコードではありません`);
      commands.push(c);
    }
  }

  const rest = text.slice(pos);
  if (rest.trim() === "") {
    return { ok: true, ssa: { segment, commands, conditions: [], qualified: false, source: text } };
  }
  if (!rest.startsWith("(")) {
    return fail(`SSA の ${pos + 1} 桁目に ( か空白が要ります（${text.trim()}）`);
  }
  const close = rest.lastIndexOf(")");
  if (close < 0) return fail(`SSA の括弧が閉じていません（${text.trim()}）`);
  const inner = rest.slice(1, close);

  // C コマンドコードは項目ではなく連結キーで修飾する
  if (commands.includes("C")) {
    return {
      ok: true,
      ssa: {
        segment,
        commands,
        conditions: [],
        qualified: true,
        concatenatedKey: inner,
        source: text,
      },
    };
  }

  const conditions: SsaCondition[] = [];
  let i = 0;
  let join: "AND" | "OR" | "IAND" | undefined;
  while (i < inner.length) {
    if (i + FIELD_WIDTH + OP_WIDTH > inner.length) {
      return fail(`修飾が短すぎます（${text.trim()}）`);
    }
    const fieldName = inner.slice(i, i + FIELD_WIDTH).trim().toUpperCase();
    const field: FieldDef | undefined = seg.fields.find((f) => f.name === fieldName);
    if (field === undefined) {
      return fail(`項目 ${fieldName} はセグメント ${segment} にありません`);
    }
    i += FIELD_WIDTH;
    const op = relOp(inner.slice(i, i + OP_WIDTH));
    if (op === undefined) {
      return fail(`${inner.slice(i, i + OP_WIDTH)} は関係演算子ではありません（${text.trim()}）`);
    }
    i += OP_WIDTH;
    // 値の終わりは「論理記号まで」と「項目長」の短い方
    let end = inner.length;
    for (let k = i; k < inner.length; k++) {
      if (JOINS[inner[k]!] !== undefined) {
        end = k;
        break;
      }
    }
    const limit = i + field.bytes;
    if (limit < end) {
      return fail(
        `項目 ${fieldName} の値が ${field.bytes} 桁に収まっていません（${text.trim()}）`,
      );
    }
    const value = inner.slice(i, end);
    conditions.push({ field: fieldName, op, value, ...(join === undefined ? {} : { join }) });
    i = end;
    if (i < inner.length) {
      join = JOINS[inner[i]!];
      i++;
      if (i >= inner.length) return fail(`論理記号の後に条件がありません（${text.trim()}）`);
    }
  }
  if (conditions.length === 0) return fail(`修飾が空です（${text.trim()}）`);
  return { ok: true, ssa: { segment, commands, conditions, qualified: true, source: text } };
}
