/**
 * ゴールデンテスト — 突き合わせた出力をバイト単位で固定する。
 *
 * この処理系の出力書式と精度規則は、実在の PL/I 処理系の出力から導いている。
 * その「正解」をここに置き、**バイト一致**を要求する。
 *
 * 置き方は `test/golden/<名前>.pli` と `test/golden/<名前>.expected`。
 * 標準入力が要るなら `<名前>.in`、主手続きの引数が要るなら
 * `<名前>.args`（1 行 1 引数）を添える。
 *
 * **推測で `.expected` を書いてはいけない。** 手で書いたものは
 * 「この処理系の今の出力」にすぎず、固定する意味が無くなる。
 *
 * 作り直す道具は**別のリポジトリ**（`pli-oracle`）にある。
 * 突き合わせ用の処理系は 32 bit x86 のバイナリで、動かす環境の用意も要るので、
 * 「ブラウザ 1 枚で動く」というこのリポジトリの前提に持ち込まない。
 * ここに要るのは固定された `.expected` だけで、取り直す手段は
 * 手元に無くてよい（だからこのテストはオラクル無しで動く）。
 * 手順は `test/golden/README.md`。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryHost, runProgram } from "../src/index.js";

const DIR = join(import.meta.dirname, "golden");

/** `<名前>.pli` と `<名前>.expected` が揃っているものを集める。 */
function cases(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".pli"))
    .map((f) => f.replace(/\.pli$/, ""))
    .filter((name) => existsSync(join(DIR, `${name}.expected`)))
    .sort();
}

const names = cases();

describe("ゴールデン", () => {
  it("1 件以上ある（基盤が死んでいないことの確認）", () => {
    // 0 件だと、以下のテストが 1 つも走らないまま緑になる
    expect(names.length).toBeGreaterThan(0);
  });

  it("どの期待値にも出処が書かれている", () => {
    // `.why` が無い期待値は「この処理系の今の出力」にすぎない。
    // 固定する意味が無いので、出処を書く規約を機械で守らせる
    const missing = names.filter((n) => !existsSync(join(DIR, `${n}.why`)));
    expect(missing, `出処（.why）が無い: ${missing.join(", ")}`).toEqual([]);
  });

  for (const name of names) {
    it(name, () => {
      const source = readFileSync(join(DIR, `${name}.pli`), "utf8");
      const expected = readFileSync(join(DIR, `${name}.expected`), "utf8");
      const inPath = join(DIR, `${name}.in`);
      const argsPath = join(DIR, `${name}.args`);
      const r = runProgram(source, {
        host: new MemoryHost(),
        ...(existsSync(inPath) ? { stdin: readFileSync(inPath, "utf8") } : {}),
        ...(existsSync(argsPath)
          ? {
              args: readFileSync(argsPath, "utf8")
                .split("\n")
                .filter((l) => l !== ""),
            }
          : {}),
        maxSteps: 5_000_000,
        maxOutputBytes: 1_000_000,
      });
      if (!r.ok) {
        throw new Error(
          `実行に失敗した: ${r.diagnostics.map((d) => `${d.line}行: ${d.message}`).join(" / ")}`,
        );
      }
      // バイト一致。空白 1 つの違いも見逃さない
      expect(r.stdout).toBe(expected);
    });
  }
});
