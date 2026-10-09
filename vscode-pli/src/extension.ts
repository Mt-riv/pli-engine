/**
 * PL/I 拡張の入口。
 *
 * 処理系（pli-engine）を同梱しているので、外部のコンパイラを必要としない。
 * VSCode に依存しない処理は core.ts に分けてテストしている。
 */

import * as vscode from "vscode";
import {
  checkSyntax,
  runForEditor,
  runTestsForEditor,
  looksLikeTestFile,
  snippetCompletions,
  type EditorDiagnostic,
} from "./core.js";
import type { FileMode, PliFile, PliHost, RuleSetting } from "../../engine/src/index.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * 扱う言語 ID。
 *
 * `pli` はこの拡張が登録するもの。`pl1` は PL/I を扱う別の拡張が
 * 同じ拡張子に対して登録することがある ID で、両方入っていると
 * ファイルがどちらに解決されるか決まらない。
 * 実行とテストはどちらでも使えるようにする。
 */
const LANGUAGE_IDS = new Set(["pli", "pl1"]);

/**
 * 入力中の構文検査を行う言語 ID。
 *
 * `pl1` は別の拡張が扱う方言向けの ID で、この処理系が解さない書き方が
 * 普通に出てくる。そこへ診断を出すと誤りでない箇所を赤くしてしまうので、
 * 自前の言語 ID に限る。実行とテストは利用者が明示的に起こすので制限しない。
 */
const DIAGNOSTIC_LANGUAGE_ID = "pli";

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
} as const;

function toVsDiagnostic(d: EditorDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(
    d.range.start.line,
    d.range.start.character,
    d.range.end.line,
    d.range.end.character,
  );
  const diag = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
  diag.source = d.source;
  // 規則 id を出しておくと、問題タブから設定で切る判断ができる
  if (d.code !== undefined) diag.code = d.code;
  return diag;
}

/** `%INCLUDE a;` で試す名前。 */
const INCLUDE_EXTENSIONS = ["", ".inc", ".pli", ".pl1", ".cpy", ".plinc"];
/** ファイル入出力で試す拡張子。PL/I のファイル名は `.` を含められない。 */
const DATA_EXTENSIONS = ["", ".txt", ".dat", ".csv"];

/**
 * 開いているファイルの隣とワークスペース直下から取り込みを解決するホスト。
 *
 * 拡張は Node の上で動くので `node:fs` を使ってよい。
 * エンジン側（`engine/src/`）には持ち込まない。
 */
function hostFor(doc: vscode.TextDocument): PliHost {
  const dirs: string[] = [];
  if (!doc.isUntitled) dirs.push(dirname(doc.fileName));
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    dirs.push(folder.uri.fsPath);
  }
  return {
    readInclude(name: string): string | undefined {
      // 開いていて未保存のファイルを優先する（保存前でも取り込める）
      for (const open of vscode.workspace.textDocuments) {
        if (open.isUntitled) continue;
        const base = open.fileName.slice(open.fileName.lastIndexOf("/") + 1);
        if (base.toLowerCase() === name.toLowerCase()) return open.getText();
      }
      const candidates = isAbsolute(name)
        ? [name]
        : dirs.flatMap((d) => INCLUDE_EXTENSIONS.map((e) => join(d, name + e)));
      for (const p of candidates) {
        try {
          if (existsSync(p)) return readFileSync(p, "utf8");
        } catch {
          // 読めないものは「無い」と同じ扱いにする
        }
      }
      return undefined;
    },

    /**
     * ファイル入出力と、DL/I の DBD・PSB・データの読み書き。
     *
     * 名前に拡張子が付いていれば（`STUDENT.dbd` など）そのまま探す。
     * 書き出しは閉じるときに 1 回だけ来るので、そこで実ファイルへ落とす。
     */
    openFile(name: string, mode: FileMode): PliFile | undefined {
      const candidates = isAbsolute(name)
        ? [name]
        : dirs.flatMap((d) => DATA_EXTENSIONS.map((e) => join(d, name + e)));
      let found: string | undefined;
      for (const p of candidates) {
        try {
          if (existsSync(p)) {
            found = p;
            break;
          }
        } catch {
          // 読めないものは「無い」と同じ扱いにする
        }
      }
      if (mode === "input" && found === undefined) return undefined;
      const path = found ?? candidates[0];
      if (path === undefined) return undefined;
      let buffer = "";
      if (mode !== "output" && found !== undefined) {
        try {
          buffer = readFileSync(found, "utf8");
        } catch {
          buffer = "";
        }
      }
      return {
        read: () => buffer,
        write: (contents: string) => {
          buffer = contents;
          try {
            writeFileSync(path, contents);
          } catch {
            // 書けない場所なら黙って諦める。実行そのものは続ける
          }
        },
      };
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_LANGUAGE_ID);
  const output = vscode.window.createOutputChannel("PL/I");
  context.subscriptions.push(diagnostics, output);

  const config = () => vscode.workspace.getConfiguration("pli");

  /** 入力のたびに構文を検査して問題を表示する。 */
  const refresh = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== DIAGNOSTIC_LANGUAGE_ID) return;
    if (!config().get<boolean>("diagnostics.enabled", true)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const c = config();
    diagnostics.set(
      doc.uri,
      checkSyntax(doc.getText(), {
        host: hostFor(doc),
        lint: c.get<boolean>("lint.enabled", true),
        lintOptions: {
          rules: c.get<Record<string, RuleSetting>>("lint.rules", {}),
        },
      }).map(toVsDiagnostic),
    );
  };

  // 入力中は少し待ってから検査する（打鍵のたびに走らせない）
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = (doc: vscode.TextDocument): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => refresh(doc), 250);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refreshSoon(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    // 設定を変えたら開いている全部を貼り直す（再読み込みを求めない）
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("pli")) return;
      for (const doc of vscode.workspace.textDocuments) refresh(doc);
    }),
  );
  for (const doc of vscode.workspace.textDocuments) refresh(doc);

  /** 実行対象のエディタを取る。PL/I 以外なら警告して undefined を返す。 */
  const activeDocument = (): vscode.TextDocument | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !LANGUAGE_IDS.has(editor.document.languageId)) {
      // 言語 ID を添える。他の拡張が .pli を奪っている場合に
      // 「開いているのに使えない」理由がここで分かる
      const id = editor?.document.languageId;
      void vscode.window.showWarningMessage(
        id === undefined
          ? "PL/I のファイルを開いてから実行してください。"
          : `このファイルは言語「${id}」として開かれています。` +
              "PL/I として扱うには files.associations で pli を指定してください。",
      );
      return undefined;
    }
    return editor.document;
  };

  const limits = (doc: vscode.TextDocument) => ({
    maxSteps: config().get<number>("run.maxSteps", 5_000_000),
    maxOutputBytes: config().get<number>("run.maxOutputBytes", 1_000_000),
    host: hostFor(doc),
    // DL/I を使うときだけ設定する。空なら CALL PLITDLI は
    // 「PSB が指定されていません」と言って止まる
    psb: config().get<string>("dli.psb", ""),
  });

  const runTests = (): void => {
    const doc = activeDocument();
    if (!doc) return;
    const name = doc.isUntitled ? "untitled" : doc.fileName;
    const outcome = runTestsForEditor(doc.getText(), name, limits(doc));

    output.clear();
    output.appendLine(outcome.text);
    output.show(true);
  };

  const execute = async (args: string[]): Promise<void> => {
    const doc = activeDocument();
    if (!doc) return;
    const name = doc.isUntitled ? "untitled" : doc.fileName;
    const source = doc.getText();

    // テストファイルをそのまま実行しても「主手続きが無い」で終わるだけなので、
    // テストとして走らせる。引数指定つきの実行では利用者の意図が
    // はっきりしているので、この振り替えはしない。
    if (args.length === 0 && looksLikeTestFile(name, source)) {
      runTests();
      return;
    }

    const outcome = runForEditor(source, name, { ...limits(doc), args });

    output.clear();
    output.appendLine(outcome.report);
    output.show(true);
    diagnostics.set(doc.uri, outcome.diagnostics.map(toVsDiagnostic));
  };

  // `pli` の Snippet は package.json の宣言で載せている。
  // `pl1` はこちらが宣言していない言語なので、宣言的に寄与すると
  // 「Unknown language」の警告になる。補完として出す。
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider("pl1", {
      provideCompletionItems() {
        return snippetCompletions().map((s) => {
          const item = new vscode.CompletionItem(
            s.label,
            vscode.CompletionItemKind.Snippet,
          );
          item.insertText = new vscode.SnippetString(s.body);
          item.detail = s.detail;
          item.documentation = s.documentation;
          return item;
        });
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pli.run", () => execute([])),
    vscode.commands.registerCommand("pli.runTests", () => runTests()),
    vscode.commands.registerCommand("pli.runWithArgs", async () => {
      const input = await vscode.window.showInputBox({
        title: "PL/I: 引数",
        prompt: "主手続きに渡す引数を空白区切りで入力します",
        placeHolder: "123",
      });
      if (input === undefined) return;
      const args = input.trim() === "" ? [] : input.trim().split(/\s+/);
      await execute(args);
    }),
  );
}

export function deactivate(): void {
  // 後始末は context.subscriptions に任せている
}
