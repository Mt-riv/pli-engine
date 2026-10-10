/**
 * 拡張の多言語化の検査。
 *
 * 見るのは 3 つ。
 *
 *   1. `src/` の中の日本語が全部表に入っていて、訳が空でないこと
 *   2. `package.json` の `%鍵%` が ja / en の両方の nls に揃っていること
 *      （欠けると VSCode は `%鍵%` をそのまま画面に出す）
 *   3. どの言語を使うかの決め方（`chooseLocale`）
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chooseLocale } from "../src/core.js";
import { EXT_EN } from "../src/i18n.en.js";
import { EN } from "../../engine/src/i18n/en.js";
import { scanTree } from "../../engine/scripts/i18n-keys.js";

const ROOT = resolve(import.meta.dirname, "..");
const scan = scanTree([join(ROOT, "src")], ROOT);

const read = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(join(ROOT, name), "utf8")) as Record<string, string>;

describe("拡張の中の文字列", () => {
  const keys = new Set(scan.keys.map((k) => k.key));

  it("m で包み忘れた日本語が無い", () => {
    expect(scan.leftovers.map((l) => `${l.file}:${l.line} ${l.text.slice(0, 40)}`)).toEqual(
      [],
    );
  });

  it("すべての鍵に英訳がある", () => {
    const missing = [...keys].filter((k) => (EXT_EN[k] ?? "") === "");
    expect(missing, "engine で npm run gen:i18n のあと訳を書く").toEqual([]);
  });

  it("使われていない鍵が残っていない", () => {
    expect(Object.keys(EXT_EN).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("差し込みの数が鍵と訳で一致する", () => {
    const holes = (s: string): number => new Set(s.match(/\{\d+\}/g) ?? []).size;
    expect(
      Object.entries(EXT_EN)
        .filter(([k, v]) => holes(k) !== holes(v))
        .map(([k]) => k),
    ).toEqual([]);
  });

  it("訳に日本語が残っていない", () => {
    expect(
      Object.entries(EXT_EN)
        .filter(([, v]) => /[ぁ-んァ-ヶー一-龠々〆〇]/.test(v))
        .map(([k]) => k),
    ).toEqual([]);
  });

  /**
   * 拡張の表はエンジンの表へ**上書き**で足す（`addCatalog`）。
   * 同じ鍵に違う訳を書くと、拡張を入れた VSCode の中だけ
   * エンジンのメッセージが変わる。気づきにくいので固定する。
   */
  it("エンジンの表と同じ鍵には同じ訳を書く", () => {
    const clash = Object.entries(EXT_EN)
      .filter(([k, v]) => EN[k] !== undefined && EN[k] !== v)
      .map(([k, v]) => `${k}: ${v} / engine: ${EN[k]}`);
    expect(clash).toEqual([]);
  });
});

describe("package.json の nls", () => {
  const manifest = readFileSync(join(ROOT, "package.json"), "utf8");
  const used = new Set(
    [...manifest.matchAll(/"%([^%"]+)%"/g)].map((hit) => hit[1] as string),
  );
  const ja = read("package.nls.json");
  const en = read("package.nls.en.json");

  it("%鍵% を使っている（コマンド名と設定の説明を外に出している）", () => {
    expect(used.size).toBeGreaterThanOrEqual(14);
  });

  it("使っている鍵がすべて ja の nls にある", () => {
    expect([...used].filter((k) => ja[k] === undefined)).toEqual([]);
  });

  it("ja と en の鍵が一致する", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("nls に余った鍵が無い", () => {
    expect(Object.keys(ja).filter((k) => !used.has(k))).toEqual([]);
  });

  it("en の nls に日本語が残っていない", () => {
    expect(
      Object.entries(en)
        .filter(([, v]) => /[ぁ-んァ-ヶー一-龠々〆〇]/.test(v))
        .map(([k]) => k),
    ).toEqual([]);
  });

  it("言語の設定は auto / ja / en の 3 つで、既定は auto", () => {
    const d = JSON.parse(manifest) as {
      contributes: {
        configuration: {
          properties: Record<string, { enum?: string[]; default?: unknown }>;
        };
      };
    };
    const prop = d.contributes.configuration.properties["pli.language"]!;
    expect(prop.enum).toEqual(["auto", "ja", "en"]);
    expect(prop.default).toBe("auto");
  });
});

describe("chooseLocale", () => {
  it("設定が明示されていればそれを使う", () => {
    expect(chooseLocale("ja", "en-US")).toBe("ja");
    expect(chooseLocale("en", "ja")).toBe("en");
  });

  it("auto は VSCode の表示言語に合わせる", () => {
    expect(chooseLocale("auto", "en")).toBe("en");
    expect(chooseLocale("auto", "en-US")).toBe("en");
    expect(chooseLocale("auto", "ja")).toBe("ja");
  });

  it("日本語でも英語でもない表示言語は日本語（既定の言語）にする", () => {
    // 中途半端に英語へ寄せるより原文の方が確か。
    // コマンド名も package.nls.json（日本語）に落ちるので揃う
    expect(chooseLocale("auto", "fr")).toBe("ja");
    expect(chooseLocale("auto", "zh-cn")).toBe("ja");
  });

  it("設定が壊れていても落ちない", () => {
    expect(chooseLocale("", "en")).toBe("en");
    expect(chooseLocale("klingon", "fr")).toBe("ja");
  });
});
