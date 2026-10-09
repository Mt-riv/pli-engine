/**
 * examples/tests のテストファイルが全件成功することを確かめる。
 *
 * 手引きに載せる例が壊れたままにならないようにするため、
 * 例そのものを常用のテストに載せている。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runTestSource, discover } from "../src/index.js";
import { NodeHost } from "../scripts/node-host.js";

const dir = join(import.meta.dirname, "../examples/tests");
const entries = readdirSync(dir);
const files = entries.filter((f) => f.endsWith(".pli")).sort();

/** 例に PSB が置いてあれば DL/I を有効にする。 */
const psb = entries
  .filter((f) => /\.psb$/i.test(f))
  .map((f) => f.replace(/\.psb$/i, ""))[0];

/**
 * 例と同じディレクトリを基準にするホスト。
 * 書き出しは実ファイルへ反映しない（例のデータが変わるとテストが
 * 2 回目から別の結果になる）。
 */
const hostForExamples = () => new NodeHost({ baseDir: dir, dryRun: true });

describe("examples/tests", () => {
  it("テストファイルが存在する", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} は全件成功する`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      const d = discover(source, hostForExamples());
      expect(d.error).toBeUndefined();
      expect(d.tests.length).toBeGreaterThan(0);

      const report = runTestSource(source, {
        host: hostForExamples(),
        ...(psb === undefined ? {} : { psb }),
      });
      const bad = report.results.filter(
        (r) => r.status === "failed" || r.status === "error",
      );
      // 失敗したテストの名前と理由をそのまま見せる
      expect(bad.map((r) => `${r.name}: ${r.message}`)).toEqual([]);
      expect(report.ok).toBe(true);
    });
  }
});
