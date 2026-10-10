/**
 * 画面のゴールデンテスト — 画面像をバイト単位で固定する。
 *
 * **出どころは `test/golden/` とは違う。** あちらは実在の PL/I 処理系の
 * 出力（実機）だが、MFS と DL/I には突き合わせる実機が無い（IMS は
 * z/OS 専用）。ここの期待値は **IBM の仕様文書を正として組んだもの**で、
 * どの規則を示しているかを `<名前>.why` に書く。
 *
 * 置き方
 *   `<名前>.pli`    プログラム
 *   `<名前>.mfs`    書式定義（FMT / MSG）
 *   `<名前>.files`  付随ファイル（PSB・DBD・データ。`::: 名前` 区切り）
 *   `<名前>.keys`   端末の操作の台本
 *   `<名前>.screen` 期待する画面像（バイト一致で比べる）
 *   `<名前>.why`    何を固定しているか（**無いと失敗する**）
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryHost, loadMfs } from "../src/index.js";
import { parseKeys, playKeys, transcript } from "../src/tm/keys.js";
import { parseFiles, psbNames } from "../web/files.js";

const DIR = join(import.meta.dirname, "screen");

function cases(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".pli"))
    .map((f) => f.replace(/\.pli$/, ""))
    .filter((name) => existsSync(join(DIR, `${name}.screen`)))
    .sort();
}

const names = cases();

/** 1 件分を動かして、画面像のテキストを返す。 */
export function playCase(name: string): string {
  const read = (ext: string): string => readFileSync(join(DIR, `${name}.${ext}`), "utf8");
  const files = parseFiles(read("files"));
  const psb = psbNames(files)[0];
  if (psb === undefined) throw new Error(`${name}.files に PSB がありません`);
  const library = loadMfs({ [`${name}.mfs`]: read("mfs") });
  const { steps } = playKeys({
    source: read("pli"),
    library,
    host: new MemoryHost(files),
    psb,
    script: parseKeys(read("keys"), `${name}.keys`),
    limits: { maxSteps: 1_000_000, maxOutputBytes: 100_000 },
  });
  return transcript(steps);
}

describe("画面のゴールデン", () => {
  it("1 件以上ある（基盤が死んでいないことの確認）", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it("どの期待値にも出処が書かれている", () => {
    const missing = names.filter((n) => !existsSync(join(DIR, `${n}.why`)));
    expect(missing, `出処（.why）が無い: ${missing.join(", ")}`).toEqual([]);
  });

  it("出処は『実機の出力ではない』ことを明示している", () => {
    // `test/golden/` の .why は「実機: Iron Spring PL/I …」で始まる。
    // 混ざると出どころを誤認するので、ここは逆を明示させる
    const bad = names.filter(
      (n) => !readFileSync(join(DIR, `${n}.why`), "utf8").startsWith("IBM 仕様に基づく"),
    );
    expect(bad, `1 行目が「IBM 仕様に基づく」で始まっていない: ${bad.join(", ")}`).toEqual([]);
  });

  for (const name of names) {
    it(name, () => {
      expect(playCase(name)).toBe(readFileSync(join(DIR, `${name}.screen`), "utf8"));
    });
  }
});
