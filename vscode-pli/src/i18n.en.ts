/**
 * VSCode 拡張の中で定義した文字列の英訳。
 *
 * **このファイルは engine の `npm run gen:i18n` が並べ替える。**
 * 活性化のときに `addCatalog("en", EXT_EN)` で足す。
 * コマンド名と設定の説明は VSCode の仕掛けなので
 * `package.nls.json` / `package.nls.en.json` 側。
 */
export const EXT_EN: Record<string, string> = {
  // ---- vscode-pli/src/core.ts
  "{0}桁": ", col {0}",
  "{0} {1}行{2}: {3} ({4})": "{0} line {1}{2}: {3} ({4})",
  "{0}: {1}": "{0}: {1}",
  "表明が失敗しました": "an assertion failed",
  "異常終了しました": "it ended abnormally",
  "(出力なし)": "(no output)",
  "{0}行": "line {0}",
  "{0}行{1}桁": "line {0}, col {1}",
  "成功": "ok",
  "失敗": "failed",
  "出力打ち切り": "output truncated",
  "{0}\n画面入出力には PSB が要ります（ソースの隣に入出力 PCB を含む *.psb を 1 つ置くか、設定 pli.dli.psb に名前を書いてください）": "{0}\nScreen I/O needs a PSB (put exactly one *.psb with an I/O PCB beside the source, or name one in the pli.dli.psb setting)",
  "[書式] {0}": "[format] {0}",
  "往復 {0} 回": "{0} round trips",
  "通知 {0} 件": "{0} notices",
  "設定 pli.dli.psb の値「{0}」は IMS の名前として使えません（1〜8 桁の英数字と $ # @ だけ）。DL/I は無効にします。": "The pli.dli.psb setting \"{0}\" is not a valid IMS name (1 to 8 characters of A-Z, 0-9, $, # and @ only). DL/I is turned off.",
  // ---- vscode-pli/src/extension.ts
  "知らない規則 id: {0}": "Unknown rule id: {0}",
  "値は off / info / warning / error のどれかです: {0}": "The value must be one of off / info / warning / error: {0}",
  "設定 pli.lint.rules を無視しました。{0}": "The pli.lint.rules setting was ignored. {0}",
  "ファイル {0} へは書き込めません": "Cannot write to file {0}",
  "PL/I のファイルを開いてから実行してください。": "Open a PL/I file first.",
  "このファイルは言語「{0}」として開かれています。PL/I として扱うには files.associations で pli を指定してください。": "This file is open as language \"{0}\". To treat it as PL/I, map it to pli in files.associations.",
  "設定 pli.{0} の値 {1} は 1 以上の整数ではないので、{2} を使います。": "The pli.{0} setting {1} is not an integer of 1 or more, so {2} is used.",
  "DL/I の PSB: {0}（ソースの隣から）": "DL/I PSB: {0} (found beside the source)",
  "画面入出力には保存したファイルが要ります（書式定義と台本を同じ場所から読みます）": "Screen I/O needs a saved file (the format definitions and the script are read from the same place)",
  "書式定義（*.mfs）が {0} にありません": "There are no format definitions (*.mfs) in {0}",
  "端末の台本（*.keys）が {0} にありません": "There is no terminal script (*.keys) in {0}",
  "PL/I: 端末の台本": "PL/I: terminal script",
  "PL/I: 引数": "PL/I: arguments",
  "主手続きに渡す引数を空白区切りで入力します": "Arguments to pass to the main procedure, separated by spaces",
};
