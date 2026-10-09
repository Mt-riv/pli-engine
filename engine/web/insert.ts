/**
 * エディタへの挿入（DOM に依存しない部分）。
 *
 * Snippet は行頭の位置に合わせて字下げを揃える。
 * 貼った直後に手で整える手間を無くすため。
 */

export interface Insertion {
  /** 挿入後の全文。 */
  text: string;
  /** 挿入後のカーソル位置。 */
  cursor: number;
}

/** 選択範囲を置き換える形で Snippet を挿入する。 */
export function insertSnippet(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  snippet: string,
): Insertion {
  const before = source.slice(0, selectionStart);
  const after = source.slice(selectionEnd);

  // 挿入位置の行の字下げ（カーソルより前が空白だけなら、その幅に合わせる）
  const lineStart = before.lastIndexOf("\n") + 1;
  const head = before.slice(lineStart);
  const indent = /^\s*$/.test(head) ? head : "";

  const lines = snippet.replace(/\n$/, "").split("\n");
  // 1 行目は既にある字下げの上に置くので、2 行目以降だけ字下げする
  const body = lines
    .map((l, i) => (i === 0 || l === "" ? l : indent + l))
    .join("\n");

  // 文の途中に差し込んだ場合は、読みやすさのため改行で区切る
  const needsBreakBefore = indent === "" && head !== "";
  const prefix = needsBreakBefore ? "\n" + " ".repeat(head.length - head.trimStart().length) : "";

  const text = before + prefix + body + after;
  return { text, cursor: before.length + prefix.length + body.length };
}
