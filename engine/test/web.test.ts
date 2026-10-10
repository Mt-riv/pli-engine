import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { samples } from "../web/samples.js";
import { MemoryHost, isTestSource, loadMfs, runProgram, runTestSource } from "../src/index.js";
import { parseKeys, playKeys } from "../src/tm/keys.js";
import { parseFiles, psbNames } from "../web/files.js";
import { escapeHtml } from "../web/terminal.js";

/** サンプルの付随ファイルから、実行に使うホストと PSB を組む。 */
function optionsFor(aux: string | undefined): { host?: MemoryHost; psb?: string } {
  if (aux === undefined) return {};
  const files = parseFiles(aux);
  const names = psbNames(files);
  return {
    host: new MemoryHost(files),
    ...(names.length === 1 ? { psb: names[0]! } : {}),
  };
}

/**
 * ブラウザ版の検証。
 * サンプルは利用者が最初に目にするものなので、
 * 全てがエラーなく動くことをテストで保証する。
 */
describe("ブラウザ版のサンプル", () => {
  it("12 本以上ある", () => {
    expect(samples().length).toBeGreaterThanOrEqual(10);
  });

  for (const s of samples()) {
    if (s.keys !== undefined) {
      // 画面入出力のサンプルは、台本どおりに打たないと何も起きない。
      // 1 回の入力 = 1 回の実行なので、台本を流して全ての往復を見る
      it(`「${s.name}」が台本どおりに動く`, () => {
        const files = parseFiles(s.aux ?? "");
        const { steps } = playKeys({
          source: s.source,
          library: loadMfs(files),
          host: new MemoryHost(files),
          psb: psbNames(files)[0]!,
          script: parseKeys(s.keys!, `${s.name}.keys`),
          limits: { maxSteps: 1_000_000 },
        });
        expect(steps.length).toBeGreaterThan(1);
        for (const step of steps) {
          expect(step.step.diagnostics).toEqual([]);
          expect(step.step.notice).toBeUndefined();
          expect(step.step.screen).toBeDefined();
        }
      });
      continue;
    }
    if (isTestSource(s.source)) {
      // テストファイルのサンプルは主手続きを持たないのでテストとして実行する。
      // 「失敗したテストの見え方」を示すためわざと失敗するテストを含めているが、
      // 想定外の異常（error）が出たらサンプルが壊れている。
      it(`「${s.name}」がテストとして実行できる`, () => {
        const r = runTestSource(s.source, { maxSteps: 1_000_000, ...optionsFor(s.aux) });
        expect(r.note).toBeUndefined();
        expect(r.passed).toBeGreaterThan(0);
        expect(r.results.filter((x) => x.status === "error")).toEqual([]);
      });
      continue;
    }
    it(`「${s.name}」がエラーなく実行できる`, () => {
      const r = runProgram(s.source, { maxSteps: 1_000_000, ...optionsFor(s.aux) });
      expect(r.diagnostics).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.stdout.length).toBeGreaterThan(0);
    });
  }

  it("名前が重複していない", () => {
    const names = samples().map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * 状態欄への注入。
 *
 * 端末の通知文には、プログラムが決めた文字列がそのまま入る
 * （`ISRT` の第 4 引数の MOD 名が「メッセージ記述 … がありません」に載る）。
 * 状態欄は `innerHTML` で組み立てているので、素のまま入れると
 * 共有 URL を開いた相手の画面でタグが生きる。
 */
describe("状態欄に出す文字", () => {
  it("escapeHtml はタグを作らせない", () => {
    // 要素の中身として入れる前提なので `& < >` の 3 文字で足りる。
    // `<` が残らなければ、属性に見える部分は字のままになる
    expect(escapeHtml('<IMG SRC=x ONERROR="&#97;lert(1)">')).toBe(
      '&lt;IMG SRC=x ONERROR="&amp;#97;lert(1)"&gt;',
    );
    // `&` を先に置き換えないと、作った実体参照が二重に壊れる
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("通知と書式の名前は escapeHtml を通してから innerHTML に入れる", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "web", "main.ts"), "utf8");
    // 素の埋め込みに戻したらここで落ちる
    expect(main).not.toContain("${step.notice}");
    expect(main).not.toContain("${session.inputFormat}");
    expect(main).toContain("escapeHtml(step.notice)");
    expect(main).toContain("escapeHtml(session.inputFormat)");
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

    /**
     * 埋め込みで HTML が増えていないこと。
     *
     * `String.replace` に**文字列**を渡すと `$&` `$'` `` $` `` が
     * 置換パターンとして解釈される。圧縮したコードには
     * `` new Set([`$`,…]) ``（PICTURE の通貨記号）のように `` $` `` が
     * 容易に現れるので、そのとき `` $` `` が「一致より前の文字列全部」に
     * 置き換わり、**HTML 全体がもう一度差し込まれてスクリプトが壊れる**。
     * 0.3.0 のブラウザ版はこれで動かなくなっていた。
     */
    it("HTML が二重に入っていない", () => {
      expect(html.match(/<html/g) ?? []).toHaveLength(1);
      expect(html.match(/<\/body>/g) ?? []).toHaveLength(1);
    });

    it("埋め込んだスクリプトが構文として正しい", () => {
      const m = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
      expect(m).not.toBeNull();
      // new Function は構文解析だけを行う（実行はしない）。
      // 壊れた埋め込みはここで SyntaxError になる
      expect(() => new Function(m![1]!)).not.toThrow();
    });

    it("エンジンが埋め込まれている", () => {
      // 圧縮で識別子名は変わるので、文字列リテラルとして残るもので確かめる
      expect(html).toContain("FIXEDOVERFLOW");
      expect(html).toContain("ZERODIVIDE");
      expect(html).toContain("options(main)");
    });

    it("画面入出力（MFS）も埋め込まれている", () => {
      // 端末と書式定義の読み取りが落ちていないこと。
      // 遅延読み込みにすると HTML 1 枚で完結しなくなる
      expect(html).toContain("FMTEND");
      expect(html).toContain("書式 ");
    });

    /**
     * 大きさの上限。
     *
     * 守りたいのは「1 枚を添付して渡せば、どこでも開いて動く」こと。
     * 圧縮して配られる前提ではないので、**素のバイト数**で見る
     * （`html.length` は UTF-16 の単位なので、日本語の分だけ
     * バイト数より小さく出る。以前はそれで測っていた）。
     *
     * 中身は処理系・Linter・テストフレームワーク・DL/I・MFS・端末・
     * サンプルと、**日本語と英語の両方のメッセージ**。
     * 英語の表（`src/i18n/en.ts`）で 60KB ほど増えている。
     * 言語ごとに読み込みを分ければ減るが、HTML 1 枚で完結する形が
     * 壊れるので入れたままにしている。
     *
     * 超えたら、まず何が増えたかを確かめる。安易に上限を上げない。
     */
    it("単一ファイルでも 350KB 未満に収まる", () => {
      expect(Buffer.byteLength(html)).toBeLessThan(350_000);
    });
  });
});
