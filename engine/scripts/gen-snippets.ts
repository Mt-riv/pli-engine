/**
 * src/snippets.ts から VSCode 用の Snippet ファイルを生成する。
 * 定義を一箇所に保ち、ブラウザ版と VSCode 拡張で食い違わないようにする。
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toVscodeSnippets, SNIPPETS } from "../src/snippets.js";

const out = join(import.meta.dirname, "../../vscode-pli/snippets/pli.json");
const json = JSON.stringify(toVscodeSnippets(), null, 2) + "\n";
writeFileSync(out, json);
console.log(`${SNIPPETS.length} 件の Snippet を書き出しました: ${out}`);
