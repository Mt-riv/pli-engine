/**
 * 訳の表（`src/i18n/en.ts` と `../vscode-pli/src/i18n.en.ts`）を作り直す。
 *
 *   npm run gen:i18n
 *
 * 鍵はソースから集める（`i18n-keys.ts`）。既にある訳はそのまま残し、
 * 新しい鍵は空（`""`）で並べる。使われなくなった鍵は落とす。
 * 空のまま残っているものは `test/i18n.test.ts` が落とす。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanTree, type FoundKey } from "./i18n-keys.js";
import { EN } from "../src/i18n/en.js";
import { EXT_EN } from "../../vscode-pli/src/i18n.en.js";

interface Target {
  out: string;
  roots: string[];
  base: string;
  name: string;
  existing: Record<string, string>;
  header: string;
}

const targets: Target[] = [
  {
    out: "src/i18n/en.ts",
    roots: ["src", "scripts", "web"],
    base: ".",
    name: "EN",
    existing: EN,
    header: `/**
 * 英語の訳。鍵は日本語の文そのもの（\`index.ts\` を見よ）。
 *
 * **このファイルは \`npm run gen:i18n\` が並べ替える。** 鍵を手で足さない。
 * 日本語を書き換えたら生成し直すこと（鍵が変わるため）。
 * 訳が無い鍵は日本語のまま出るので、空にしておけば画面は壊れないが、
 * \`test/i18n.test.ts\` が「訳し忘れ」として落とす。
 *
 * \`{0}\` は差し込みの場所。鍵と同じ数だけ使う（順番は変えてよい）。
 */`,
  },
  {
    out: "../vscode-pli/src/i18n.en.ts",
    roots: ["../vscode-pli/src"],
    base: "..",
    name: "EXT_EN",
    existing: EXT_EN,
    header: `/**
 * VSCode 拡張の中で定義した文字列の英訳。
 *
 * **このファイルは engine の \`npm run gen:i18n\` が並べ替える。**
 * 活性化のときに \`addCatalog("en", EXT_EN)\` で足す。
 * コマンド名と設定の説明は VSCode の仕掛けなので
 * \`package.nls.json\` / \`package.nls.en.json\` 側。
 */`,
  },
];

for (const t of targets) {
  const { keys } = scanTree(t.roots, t.base);
  // 最初に現れた場所の順。同じ鍵が複数の場所にあれば最初のものでまとめる
  const order = new Map<string, FoundKey>();
  for (const k of keys) if (!order.has(k.key)) order.set(k.key, k);

  const lines: string[] = [t.header, `export const ${t.name}: Record<string, string> = {`];
  let file = "";
  let missing = 0;
  for (const [key, where] of order) {
    if (where.file !== file) {
      file = where.file;
      lines.push(`  // ---- ${file}`);
    }
    const value = t.existing[key] ?? "";
    if (value === "") missing++;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push("};", "");
  writeFileSync(resolve(t.out), lines.join("\n"));
  const stale = Object.keys(t.existing).filter((k) => !order.has(k)).length;
  console.log(
    `${t.out}: ${order.size} 件（未訳 ${missing} / 落とした古い鍵 ${stale}）`,
  );
}
