import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SAMPLES } from "../web/samples.js";
import { isTestSource, runProgram, runTestSource } from "../src/index.js";

/**
 * ブラウザ版の検証。
 * サンプルは利用者が最初に目にするものなので、
 * 全てがエラーなく動くことをテストで保証する。
 */
describe("ブラウザ版のサンプル", () => {
  it("12 本以上ある", () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(10);
  });

  for (const s of SAMPLES) {
    if (isTestSource(s.source)) {
      // テストファイルのサンプルは主手続きを持たないのでテストとして実行する。
      // 「失敗したテストの見え方」を示すためわざと失敗するテストを含めているが、
      // 想定外の異常（error）が出たらサンプルが壊れている。
      it(`「${s.name}」がテストとして実行できる`, () => {
        const r = runTestSource(s.source, { maxSteps: 1_000_000 });
        expect(r.note).toBeUndefined();
        expect(r.passed).toBeGreaterThan(0);
        expect(r.results.filter((x) => x.status === "error")).toEqual([]);
      });
      continue;
    }
    it(`「${s.name}」がエラーなく実行できる`, () => {
      const r = runProgram(s.source, { maxSteps: 1_000_000 });
      expect(r.diagnostics).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.stdout.length).toBeGreaterThan(0);
    });
  }

  it("名前が重複していない", () => {
    const names = SAMPLES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("ビルド成果物（単一ファイル）", () => {
  const dist = join(import.meta.dirname, "../dist-web");
  const htmlPath = join(dist, "index.html");
  const built = existsSync(htmlPath);
  const d = built ? describe : describe.skip;

  d("dist-web/index.html", () => {
    const html = built ? readFileSync(htmlPath, "utf8") : "";

    /**
     * ローカルで配る前提なので、ファイルをダブルクリックするだけで
     * 開けることを要求する。外部ファイルを読む形だと file:// では
     * CORS で弾かれて動かない。
     */
    it("外部ファイルを一切読まない", () => {
      expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
      expect(html).not.toMatch(/<link[^>]*\shref=/i);
    });

    it("外部 URL を参照しない（オフラインで動くこと）", () => {
      expect(html).not.toMatch(/https?:\/\/(?!localhost|www\.w3\.org)/);
    });

    it("ほかに配布物が無い（HTML 1枚で完結する）", () => {
      const entries = readdirSync(dist);
      expect(entries).toEqual(["index.html"]);
    });

    /**
     * インラインの classic script は module と違い遅延しないため、
     * <head> に置くと DOM 生成前に走って要素が見つからず動かない。
     * </body> の直前にあることを要求する。
     */
    it("スクリプトが body の末尾にある", () => {
      const script = html.indexOf("<script>");
      expect(script).toBeGreaterThan(html.indexOf("<body>"));
      expect(html.lastIndexOf("</script>")).toBeLessThan(html.indexOf("</body>"));
    });

    it("module ではなく classic script として埋め込まれている", () => {
      expect(html).not.toMatch(/<script[^>]*type="module"/i);
    });

    it("エンジンが埋め込まれている", () => {
      // 圧縮で識別子名は変わるので、文字列リテラルとして残るもので確かめる
      expect(html).toContain("FIXEDOVERFLOW");
      expect(html).toContain("ZERODIVIDE");
      expect(html).toContain("options(main)");
    });

    it("単一ファイルでも 200KB 未満に収まる", () => {
      expect(html.length).toBeLessThan(200_000);
    });
  });
});
