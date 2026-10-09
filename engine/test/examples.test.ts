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

const dir = join(import.meta.dirname, "../examples/tests");
const files = readdirSync(dir).filter((f) => f.endsWith(".pli")).sort();

describe("examples/tests", () => {
  it("テストファイルが存在する", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} は全件成功する`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      const d = discover(source);
      expect(d.error).toBeUndefined();
      expect(d.tests.length).toBeGreaterThan(0);

      const report = runTestSource(source);
      const bad = report.results.filter(
        (r) => r.status === "failed" || r.status === "error",
      );
      // 失敗したテストの名前と理由をそのまま見せる
      expect(bad.map((r) => `${r.name}: ${r.message}`)).toEqual([]);
      expect(report.ok).toBe(true);
    });
  }
});
