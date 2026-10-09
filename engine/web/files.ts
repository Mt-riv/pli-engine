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

/** テキストを「名前 → 中身」に分ける。区切りより前の文字は捨てる。 */
export function parseFiles(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let name: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (name === undefined) return;
    // 末尾の改行は 1 つに揃える（ファイルらしく見せるため）
    out[name] = buffer.join("\n").replace(/\n*$/, "\n");
  };

  for (const line of text.split("\n")) {
    const m = SEPARATOR.exec(line);
    if (m) {
      flush();
      name = m[1]!;
      buffer = [];
      continue;
    }
    if (name !== undefined) buffer.push(line);
  }
  flush();
  return out;
}

/** 「名前 → 中身」をテキストに戻す。 */
export function serializeFiles(files: Record<string, string>): string {
  const parts: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    parts.push(`::: ${name}`, contents.replace(/\n$/, ""));
  }
  return parts.length === 0 ? "" : parts.join("\n") + "\n";
}
