/**
 * 付随ファイルの記法。
 *
 * ブラウザ版は 1 枚の HTML なので、本物のファイルを持てない。
 * `%INCLUDE` の取り込み元や入出力の相手を書けるように、
 * 1 つのテキスト欄に複数のファイルを並べる記法を用意する。
 *
 *   ::: DECLS.inc
 *   dcl total fixed dec(7,2);
 *   ::: data.txt
 *   1 2 3
 *
 * 行頭の `::: 名前` が区切り。PL/I のコメントや文字列と衝突しない形を選んだ
 * （`/*` や `--` は PL/I の中に出てくる）。
 */

const SEPARATOR = /^:::[ \t]*(.+?)[ \t]*$/;

/**
 * テキストを「区切りより前の文章」と「名前 → 中身」に分ける。
 *
 * 区切りより前は**捨てない**。実行後に欄を組み立て直すとき、
 * 利用者が書いたメモや、区切り無しで貼ったテキストが消えてしまう。
 */
export function splitAux(text: string): {
  preamble: string;
  files: Record<string, string>;
} {
  const files: Record<string, string> = {};
  const preambleLines: string[] = [];
  let name: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (name === undefined) return;
    const body = buffer.join("\n");
    // 中身が空なら空のまま。`"\n"` にすると「空行 1 つのファイル」に変わる
    files[name] = /^\n*$/.test(body) ? "" : body.replace(/\n*$/, "\n");
  };

  for (const line of text.split("\n")) {
    const m = SEPARATOR.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      buffer = [];
      continue;
    }
    if (name === undefined) preambleLines.push(line);
    else buffer.push(line);
  }
  flush();
  return { preamble: preambleLines.join("\n"), files };
}

/** テキストを「名前 → 中身」に分ける。区切りより前の文章は見ない。 */
export function parseFiles(text: string): Record<string, string> {
  return splitAux(text).files;
}

/**
 * 「名前 → 中身」をテキストに戻す。
 *
 * `preamble` を渡すと先頭に戻す（`splitAux` と対で使う）。
 */
export function serializeFiles(
  files: Record<string, string>,
  preamble = "",
): string {
  const parts: string[] = [];
  const head = preamble.replace(/\n*$/, "");
  if (head !== "") parts.push(head);
  for (const [name, contents] of Object.entries(files)) {
    parts.push(`::: ${name}`);
    // 中身が空なら行を足さない。足すと空行 1 つのファイルに変わる
    const body = contents.replace(/\n$/, "");
    if (body !== "") parts.push(body);
  }
  return parts.length === 0 ? "" : parts.join("\n") + "\n";
}

/**
 * 付随ファイルにある PSB の名前を並べる。
 *
 * DL/I を使うかどうかは、`<名前>.psb` を置いたかどうかで決める。
 * 実機では JCL が PSB を指定するが、ブラウザには JCL が無い。
 * 設定欄を増やすより、置いたファイルから決める方が迷いが少ない。
 */
export function psbNames(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter((name) => /\.psb$/i.test(name))
    .map((name) => name.replace(/\.psb$/i, ""))
    .sort();
}
