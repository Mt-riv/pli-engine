/**
 * ソースから翻訳の鍵を集める。
 *
 * 鍵は日本語の文そのもの（`src/i18n/index.ts` を見よ）。どこに
 * どんな鍵があるかは構文木から機械的に分かるので、人が一覧を
 * 保守しない。使うのは 2 つ:
 *
 *   - `scripts/gen-i18n.ts`  訳の表（`src/i18n/en.ts`）の雛形を更新する
 *   - `test/i18n.test.ts`    訳し忘れと包み忘れを落とす
 *
 * **包み忘れ**（`leftovers`）を見るのが肝心。`m` で包み忘れた
 * 日本語は、鍵の一覧に現れないので「訳が全部ある」検査では
 * 捕まらない。日本語のままそこに残り続ける。
 */
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 日本語が含まれるか。記号だけのものは文ではないので数えない。 */
const CJK = /[ぁ-んァ-ヶー一-龠々〆〇]/;

export interface FoundKey {
  key: string;
  file: string;
  line: number;
}

export interface Leftover {
  text: string;
  file: string;
  line: number;
}

/** タグ付きテンプレートの固定部分から鍵を作る（`i18n/index.ts` の `keyOf` と同じ）。 */
function keyOfTemplate(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  let key = node.head.text;
  node.templateSpans.forEach((span, i) => {
    key += `{${i}}${span.literal.text}`;
  });
  return key;
}

/** `m` で包んだテンプレートか。 */
function isMessageTag(node: ts.Node): node is ts.TaggedTemplateExpression {
  return ts.isTaggedTemplateExpression(node) && node.tag.getText() === "m";
}

/** `msg(...)` / `tr(...)` の呼び出しか。 */
function markerCall(node: ts.Node): ts.CallExpression | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const name = node.expression.getText();
  return name === "msg" || name === "tr" ? node : undefined;
}

/**
 * その文字列が訳の仕掛けに包まれているか。
 *
 * `${...}` の中を通って外側の `m` に届いた場合は**包まれていない**。
 * `m`...${cond ? "あり" : "なし"}`` の「あり」は、外側の鍵には
 * 入らないので日本語のまま出る。
 */
function isCovered(node: ts.Node): boolean {
  let prev = node;
  let viaInterpolation = false;
  for (let p = node.parent; p !== undefined; prev = p, p = p.parent) {
    if (ts.isTemplateSpan(p) && p.expression === prev) viaInterpolation = true;
    if (viaInterpolation) continue;
    if (isMessageTag(p) && p.template === prev) return true;
    const call = markerCall(p);
    if (call !== undefined && call.arguments[0] === prev) return true;
  }
  return false;
}

/** 訳す対象にならない置き場所（import の文、型、属性の名前）。 */
function isExcluded(node: ts.Node): boolean {
  const p = node.parent;
  if (p === undefined) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isPropertySignature(p) && p.name === node) return true;
  return false;
}

export function scanSource(
  file: string,
  text: string,
): { keys: FoundKey[]; leftovers: Leftover[] } {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const keys: FoundKey[] = [];
  const leftovers: Leftover[] = [];
  const at = (node: ts.Node): number =>
    src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

  const visit = (node: ts.Node): void => {
    if (isMessageTag(node)) {
      keys.push({ key: keyOfTemplate(node.template), file, line: at(node) });
    }
    const call = markerCall(node);
    if (call !== undefined) {
      const arg = call.arguments[0];
      if (
        arg !== undefined &&
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
      ) {
        keys.push({ key: arg.text, file, line: at(node) });
      }
    }
    // 包み忘れ。テンプレートは固定部分だけを見る（`${}` の中は別に辿る）
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CJK.test(node.text) && !isCovered(node) && !isExcluded(node)) {
        leftovers.push({ text: node.text, file, line: at(node) });
      }
    } else if (ts.isTemplateExpression(node)) {
      const fixed =
        node.head.text + node.templateSpans.map((s) => s.literal.text).join("");
      if (CJK.test(fixed) && !isCovered(node) && !isExcluded(node)) {
        leftovers.push({ text: fixed, file, line: at(node) });
      }
    }
    node.forEachChild(visit);
  };
  src.forEachChild(visit);
  return { keys, leftovers };
}

/**
 * HTML から鍵を集める。
 *
 * `data-i18n` が付いた要素の中身（`data-i18n-attr` が付いていれば
 * その属性の値）が鍵。日本語を HTML に書いたまま残せるので、
 * 既定の表示が壊れない。
 */
export function scanHtml(file: string, text: string): FoundKey[] {
  const keys: FoundKey[] = [];
  const tag = /<([a-zA-Z][\w-]*)\b([^>]*\bdata-i18n\b[^>]*)>([^<]*)/g;
  for (let hit = tag.exec(text); hit !== null; hit = tag.exec(text)) {
    const attrs = hit[2] ?? "";
    const line = text.slice(0, hit.index).split("\n").length;
    const which = /\bdata-i18n-attr="([^"]+)"/.exec(attrs);
    if (which === null) {
      const inner = (hit[3] ?? "").trim();
      if (inner !== "") keys.push({ key: inner, file, line });
      continue;
    }
    const value = new RegExp(`\\b${which[1]}="([^"]*)"`).exec(attrs);
    if (value !== null) keys.push({ key: value[1] ?? "", file, line });
  }
  return keys;
}

/** ディレクトリを辿って `.ts` と `.html` を集める。 */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|html)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
    }
  };
  const st = statSync(root);
  if (st.isDirectory()) walk(root);
  else out.push(root);
  return out;
};

/**
 * 複数の根を走査する。`base` からの相対パスで報告する
 * （どの機械でも同じ結果になるように）。
 */
export function scanTree(
  roots: readonly string[],
  base: string,
): { keys: FoundKey[]; leftovers: Leftover[] } {
  const keys: FoundKey[] = [];
  const leftovers: Leftover[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const name = relative(base, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      if (file.endsWith(".html")) {
        keys.push(...scanHtml(name, text));
        continue;
      }
      // 表そのもの（訳文）は走査しない
      if (/\/i18n\/(en|index)\.ts$/.test(name) || /i18n\.en\.ts$/.test(name)) continue;
      const found = scanSource(name, text);
      keys.push(...found.keys);
      leftovers.push(...found.leftovers);
    }
  }
  return { keys, leftovers };
}
