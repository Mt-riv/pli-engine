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
import { isFragmentFileName, RULES } from "../../engine/src/index.js";
import type { FileMode, PliFile, PliHost, RuleSetting } from "../../engine/src/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  contain,
  isPlainName,
  isSafeWriteTarget,
  resolveName,
} from "../../engine/scripts/safe-path.js";

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

const RULE_SETTINGS = new Set(["off", "info", "warning", "error"]);

/**
 * `pli.lint.rules` を検証する。
 *
 * ワークスペースの設定から来る値なので、綴り違いの規則 id や
 * `"warn"` のような値が混ざる。そのまま渡すと重大度の対応表が
 * undefined を返し、「off にしたつもりが赤線」になる。
 * CLI の `--rule` は弾いているので、揃えておく。
 */
function validRules(raw: Record<string, RuleSetting>): Record<string, RuleSetting> {
  const known = new Set(RULES.map((r) => r.id));
  const out: Record<string, RuleSetting> = {};
  const badIds: string[] = [];
  const badValues: string[] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!known.has(id)) {
      badIds.push(id);
      continue;
    }
    if (!RULE_SETTINGS.has(value)) {
      badValues.push(`${id}=${String(value)}`);
      continue;
    }
    out[id] = value;
  }
  if (badIds.length > 0 || badValues.length > 0) {
    const parts: string[] = [];
    if (badIds.length > 0) parts.push(`知らない規則 id: ${badIds.join(", ")}`);
    if (badValues.length > 0) {
      parts.push(
        `値は off / info / warning / error のどれかです: ${badValues.join(", ")}`,
      );
    }
    void vscode.window.showWarningMessage(`設定 pli.lint.rules を無視しました。${parts.join(" / ")}`);
  }
  return out;
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
function hostFor(doc: vscode.TextDocument, opts: { dryRun?: boolean } = {}): PliHost {
  const dirs: string[] = [];
  if (!doc.isUntitled) dirs.push(dirname(doc.fileName));
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    dirs.push(folder.uri.fsPath);
  }

  /**
   * PL/I 側から来た名前を、許可したディレクトリの中へ封じ込める。
   *
   * 拡張は利用者の権限で動くので、ここが抜けると
   * `%INCLUDE '/どこか';` を書いた `.pli` を**開いただけ**で
   * （入力中の構文検査はプリプロセスを走らせる）ワークスペース外が読まれる。
   * シンボリックリンクも辿るので、文字列の検査だけでは守れない。
   */
  const resolveIn = (
    name: string,
    extensions: readonly string[],
    existsOnly: boolean,
  ): string | undefined =>
    resolveName(name, extensions, dirs, { roots: dirs, existsOnly });

  /** 開いているドキュメントの未保存の内容。候補パスと突き合わせる。 */
  const unsaved = (path: string): string | undefined => {
    for (const open of vscode.workspace.textDocuments) {
      if (open.isUntitled) continue;
      if (open.uri.fsPath === path) return open.getText();
    }
    return undefined;
  };

  return {
    readInclude(name: string): string | undefined {
      const path = resolveIn(name, INCLUDE_EXTENSIONS, true);
      if (path === undefined) return undefined;
      // 保存前の内容を優先する。
      // 以前は「開いているファイルの basename と %INCLUDE の名前が
      // そのまま一致するとき」だけ見ていたので、拡張子を補う
      // ふつうの `%INCLUDE decls;` では効いていなかった
      const draft = unsaved(path);
      if (draft !== undefined) return draft;
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    /**
     * ファイル入出力と、DL/I の DBD・PSB・データの読み書き。
     *
     * 名前に拡張子が付いていれば（`STUDENT.dbd` など）そのまま探す。
     * 書き出しは閉じるときに 1 回だけ来るので、そこで実ファイルへ落とす。
     */
    openFile(name: string, mode: FileMode): PliFile | undefined {
      const found = resolveIn(name, DATA_EXTENSIONS, true);
      if (mode === "input") {
        if (found === undefined) return undefined;
        const draft = unsaved(found);
        if (draft !== undefined) return { read: () => draft, write: () => {} };
        try {
          const text = readFileSync(found, "utf8");
          return { read: () => text, write: () => {} };
        } catch {
          return undefined;
        }
      }
      const path = found ?? newPathIn(name, dirs[0]);
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
          if (opts.dryRun === true) return;
          if (!isSafeWriteTarget(path)) {
            // 既存のシンボリックリンクやディレクトリへは書かない
            throw new Error(`ファイル ${name} へは書き込めません`);
          }
          writeFileSync(path, contents);
        },
      };
    },
  };
}

/** まだ無いファイルを作る先。基準ディレクトリの直下だけを許す。 */
function newPathIn(name: string, baseDir: string | undefined): string | undefined {
  if (baseDir === undefined) return undefined;
  if (!isPlainName(name)) return undefined;
  return contain(join(baseDir, name), { roots: [baseDir] });
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_LANGUAGE_ID);
  const output = vscode.window.createOutputChannel("PL/I");
  context.subscriptions.push(diagnostics, output);

  const config = () => vscode.workspace.getConfiguration("pli");

  /**
   * 構文と Linter の診断（実行しない分）。
   *
   * 実行後に貼り直すときもこれを足す。足さないと、
   * 実行のたびに Linter の指摘が消える。
   */
  const staticDiagnostics = (doc: vscode.TextDocument): vscode.Diagnostic[] => {
    const c = config();
    if (!c.get<boolean>("diagnostics.enabled", true)) return [];
    return checkSyntax(doc.getText(), {
      host: hostFor(doc, { dryRun: true }),
      lint: c.get<boolean>("lint.enabled", true),
      lintOptions: {
        rules: validRules(c.get<Record<string, RuleSetting>>("lint.rules", {})),
        // コピーブックは宣言だけの断片。missing-main と
        // 「使われていない」を出すと、開いただけで警告が並ぶ
        ...(isFragmentFileName(doc.fileName) ? { fragment: true } : {}),
      },
    }).map(toVsDiagnostic);
  };

  /** 入力のたびに構文を検査して問題を表示する。 */
  const refresh = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== DIAGNOSTIC_LANGUAGE_ID) return;
    if (!config().get<boolean>("diagnostics.enabled", true)) {
      diagnostics.delete(doc.uri);
      return;
    }
    diagnostics.set(doc.uri, staticDiagnostics(doc));
  };

  // 入力中は少し待ってから検査する（打鍵のたびに走らせない）。
  //
  // タイマーはドキュメントごとに持つ。1 本で共有すると、
  // 出力パネルなど無関係なドキュメントの変更で
  // 入力中の .pli の保留中の検査が消える
  // （onDidChangeTextDocument は言語を問わず発火する）。
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const refreshSoon = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== DIAGNOSTIC_LANGUAGE_ID) return;
    const key = doc.uri.toString();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        refresh(doc);
      }, 250),
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refreshSoon(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // 閉じた直後に保留中の検査が走ると、閉じたファイルの診断が残る
      const key = doc.uri.toString();
      const t = timers.get(key);
      if (t) clearTimeout(t);
      timers.delete(key);
      diagnostics.delete(doc.uri);
    }),
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

  /** 1 以上の整数の設定を読む。不正な値は既定に戻して知らせる。 */
  const positive = (key: string, fallback: number): number => {
    const raw = config().get<number>(key, fallback);
    if (Number.isInteger(raw) && raw >= 1) return raw;
    void vscode.window.showWarningMessage(
      `設定 pli.${key} の値 ${String(raw)} は 1 以上の整数ではないので、` +
        `${fallback} を使います。`,
    );
    return fallback;
  };

  /**
   * PSB の名前を読む。
   *
   * ワークスペースの `.vscode/settings.json` から来る値がそのまま
   * ファイル名になるので、IMS の名前の形だけを通す。
   */
  const psbSetting = (): string => {
    const raw = config().get<string>("dli.psb", "").trim();
    if (raw === "" || /^[A-Za-z0-9$#@]{1,8}$/.test(raw)) return raw;
    void vscode.window.showWarningMessage(
      `設定 pli.dli.psb の値「${raw}」は IMS の名前として使えません` +
        "（1〜8 桁の英数字と $ # @ だけ）。DL/I は無効にします。",
    );
    return "";
  };

  const limits = (doc: vscode.TextDocument, dryRun = false) => ({
    maxSteps: positive("run.maxSteps", 5_000_000),
    maxOutputBytes: positive("run.maxOutputBytes", 1_000_000),
    host: hostFor(doc, { dryRun }),
    // DL/I を使うときだけ設定する。空なら CALL PLITDLI は
    // 「PSB が指定されていません」と言って止まる
    psb: psbSetting(),
  });

  const runTests = (): void => {
    const doc = activeDocument();
    if (!doc) return;
    const name = doc.isUntitled ? "untitled" : doc.fileName;
    // テストは既定で実ファイルへ書き戻さない。CLI の plitest と同じ約束。
    // 書き戻すと、テストが書いたファイルで次回の結果が変わる
    // （DL/I の DLET を試すテストで実際に起きた）
    const outcome = runTestsForEditor(doc.getText(), name, limits(doc, true));

    output.clear();
    output.appendLine(outcome.text);
    output.show(true);
    // 失敗・異常の行に印を付ける。静的な診断に**足して**貼る
    // （置き換えると Linter の指摘が消える）
    diagnostics.set(doc.uri, [
      ...staticDiagnostics(doc),
      ...outcome.diagnostics.map(toVsDiagnostic),
    ]);
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
    // 実行時の診断を**静的な診断に足して**貼る。
    // 置き換えると、成功したときに Linter の指摘が消える
    // （実行するたびに黄線が消えて、また入力すると戻る、という挙動になる）
    diagnostics.set(doc.uri, [
      ...staticDiagnostics(doc),
      ...outcome.diagnostics.map(toVsDiagnostic),
    ]);
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
