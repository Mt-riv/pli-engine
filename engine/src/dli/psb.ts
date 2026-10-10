/**
 * PSB（プログラム仕様ブロック）を読む。
 *
 * PSB はプログラムが「どのデータベースの、どのセグメントを、
 * 何をするために」見るかの宣言。PCB の並びがそのまま
 * 主手続きの引数の並びになる。
 */

import {
  DliDefError,
  type DbdDef,
  type PcbDef,
  type PsbDef,
  type SensegDef,
} from "./types.js";
import { concatenatedKeyLength } from "./dbd.js";
import { listOf, readMacros, required, requiredName } from "../macro.js";

/** DBD の名前から定義を引く。読めなければ undefined。 */
export type DbdResolver = (name: string) => DbdDef | undefined;

/** 受け付ける処理オプション。 */
const PROCOPT_LETTERS = new Set(["G", "I", "R", "D", "A", "L", "O", "P", "E", "S"]);

function checkProcopt(text: string, line: number, file: string): string {
  const opt = text.toUpperCase();
  for (const c of opt) {
    if (!PROCOPT_LETTERS.has(c)) {
      throw new DliDefError(`PROCOPT=${text} の ${c} は扱えません`, file, line);
    }
  }
  return opt;
}

export function parsePsb(text: string, file: string, resolveDbd: DbdResolver): PsbDef {
  const stmts = readMacros(text, file);
  if (stmts.length === 0) throw new DliDefError("PSB の記述が空です", file, 1);

  const pcbs: PcbDef[] = [];
  let current: PcbDef | undefined;
  let name: string | undefined;
  let lang = "PLI";
  let cmpat = false;

  for (const s of stmts) {
    switch (s.op) {
      case "PCB": {
        const type = (s.operands.get("TYPE") ?? "DB").toUpperCase();
        if (type === "TP") {
          current = { kind: "io", procopt: "A", keylen: 0, senseg: new Map() };
          pcbs.push(current);
          break;
        }
        if (type !== "DB") {
          throw new DliDefError(`PCB の TYPE=${type} は扱えません（DB / TP）`, file, s.line);
        }
        const dbdName = requiredName(s, "DBDNAME", file);
        const dbd = resolveDbd(dbdName);
        if (dbd === undefined) {
          throw new DliDefError(
            `DBD ${dbdName} が読めません（${dbdName}.dbd を置いてください）`,
            file,
            s.line,
          );
        }
        const keylen = s.operands.get("KEYLEN");
        current = {
          kind: "db",
          dbdName,
          dbd,
          procopt: checkProcopt(s.operands.get("PROCOPT") ?? "A", s.line, file),
          keylen: keylen === undefined ? 0 : Number(keylen),
          senseg: new Map(),
        };
        if (keylen !== undefined && !Number.isInteger(current.keylen)) {
          throw new DliDefError(`PCB の KEYLEN=${keylen} が数値ではありません`, file, s.line);
        }
        pcbs.push(current);
        break;
      }
      case "SENSEG": {
        if (current === undefined || current.kind !== "db") {
          throw new DliDefError("SENSEG 文の前に PCB TYPE=DB が必要です", file, s.line);
        }
        const segName = requiredName(s, "NAME", file);
        const seg = current.dbd!.segments.get(segName);
        if (seg === undefined) {
          throw new DliDefError(
            `セグメント ${segName} は DBD ${current.dbdName} にありません`,
            file,
            s.line,
          );
        }
        const parentText = s.operands.get("PARENT");
        if (parentText !== undefined) {
          const parent = (listOf(parentText)[0] ?? "").toUpperCase();
          const expected = seg.parent ?? "0";
          if (parent !== expected) {
            throw new DliDefError(
              `SENSEG ${segName} の PARENT=${parent} は DBD の親（${expected}）と違います`,
              file,
              s.line,
            );
          }
        }
        const def: SensegDef = {
          name: segName,
          ...(seg.parent === undefined ? {} : { parent: seg.parent }),
        };
        const procopt = s.operands.get("PROCOPT");
        if (procopt !== undefined) def.procopt = checkProcopt(procopt, s.line, file);
        current.senseg.set(segName, def);
        break;
      }
      case "SENFLD":
        // 項目単位の感知。項目の隠蔽は再現しないので受け取るだけ
        if (current === undefined || current.kind !== "db") {
          throw new DliDefError("SENFLD 文の前に PCB TYPE=DB が必要です", file, s.line);
        }
        break;
      case "PSBGEN":
        name = required(s, "PSBNAME", file).toUpperCase();
        lang = (s.operands.get("LANG") ?? "PLI").toUpperCase();
        cmpat = (s.operands.get("CMPAT") ?? "NO").toUpperCase() === "YES";
        break;
      case "END":
        break;
      default:
        throw new DliDefError(`${s.op} は PSB の文ではありません`, file, s.line);
    }
  }

  if (name === undefined) {
    throw new DliDefError("PSBGEN 文がありません", file, stmts[stmts.length - 1]!.line);
  }
  if (pcbs.length === 0) {
    throw new DliDefError("PCB 文がありません", file, stmts[0]!.line);
  }

  // 感知セグメントを書かなかった PCB は、DBD の全セグメントに感知する。
  // 実機では必須だが、手で書く題材では省きたくなるので補う。
  for (const pcb of pcbs) {
    if (pcb.kind !== "db") continue;
    if (pcb.senseg.size === 0) {
      for (const seg of pcb.dbd!.segments.values()) {
        pcb.senseg.set(seg.name, {
          name: seg.name,
          ...(seg.parent === undefined ? {} : { parent: seg.parent }),
        });
      }
    }
    if (pcb.keylen === 0) {
      pcb.keylen = Math.max(
        1,
        ...[...pcb.senseg.keys()].map((n) => concatenatedKeyLength(pcb.dbd!, n)),
      );
    }
  }

  // CMPAT=YES は入出力 PCB を先頭に足す（バッチでも会話型と同じ並びになる）
  if (cmpat && pcbs[0]!.kind !== "io") {
    pcbs.unshift({ kind: "io", procopt: "A", keylen: 0, senseg: new Map() });
  }
  return { name, lang, pcbs };
}
