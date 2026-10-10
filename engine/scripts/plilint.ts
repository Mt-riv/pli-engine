/**
 * Linter の CLI。
 *
 *   npm run plilint -- examples/tests
 *   npm run plilint -- src.pli --rule goto-outside-on-unit=off --strict
 *
 * 既定では error が 1 件でもあれば終了コード 1。
 * `--strict` を付けると warning も失敗として扱う。
 *
 * **構文の検査を先に行う。** `lint()` は構文が通らないソースに対して
 * 何も返さないので、これを飛ばすと壊れたファイルが
 * 「指摘はありません・終了コード 0」で CI のゲートを通ってしまう。
 * ブラウザ版と VSCode Extension は先に構文を見ているので、
 * 揃えるという意味でもここで見る。
 */
import { readdirSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  lint,
  formatLint,
  isFragmentFileName,
  runProgram,
  RULES,
  type Diagnostic,
  type LintMessage,
  type RuleSetting,
} from "../src/index.js";
import { hostForFile } from "./node-host.js";
import { fail, main, readText, usage, value } from "./cli-util.js";

const SETTINGS = new Set(["off", "info", "warning", "error"]);

const USAGE = `使い方: plilint <ファイル/ディレクトリ...> [オプション]

  --strict                        warning も失敗として扱う
  --rule <id>=<off|info|warning|error>
                                  規則ごとの重大度を上書きする
  --quiet, -q                     指摘のあるファイルだけ表示する
  --list-rules                    規則の一覧を表示する
  -h, --help                      この使い方を表示する`;

/**
 * ディレクトリを辿って PL/I のソースを集める。
 *
 * シンボリックリンクは辿らない。辿ると `sub/back -> .` のような
 * 置き方で無限に降りていき、`ENAMETOOLONG` の未捕捉例外で落ちる。
 */
function collect(target: string, seen = new Set<string>()): string[] {
  let st;
  try {
    st = statSync(target);
  } catch {
    fail(`読めません: ${target}`);
  }
  if (st.isFile()) return [target];
  if (!st.isDirectory()) return [];
  const real = realpathSync.native(target);
  if (seen.has(real)) return [];
  seen.add(real);
  return readdirSync(target)
    .sort()
    .flatMap((entry) => {
      const full = join(target, entry);
      // lstat なのでリンクはリンクとして見える
      const est = lstatSync(full);
      if (est.isSymbolicLink()) return [];
      if (est.isDirectory()) return collect(full, seen);
      if (!est.isFile()) return [];
      return /\.(pli|pl1|inc|cpy|plinc)$/i.test(entry) ? [full] : [];
    });
}

function listRules(): never {
  const lines: string[] = [];
  for (const category of ["correctness", "style"] as const) {
    lines.push(`[${category}]`);
    for (const r of RULES.filter((x) => x.category === category)) {
      lines.push(`  ${r.id}  (既定: ${r.default})`);
      lines.push(`      ${r.summary}`);
      lines.push(`      ${r.rationale}`);
    }
  }
  lines.push(`合計 ${RULES.length} 規則`);
  usage(lines.join("\n"));
}

main(() => {
  const targets: string[] = [];
  const rules: Record<string, RuleSetting> = {};
  let strict = false;
  let quiet = false;

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") usage(USAGE);
    else if (a === "--strict") strict = true;
    else if (a === "--quiet" || a === "-q") quiet = true;
    else if (a === "--list-rules") listRules();
    else if (a === "--rule") {
      const spec = value(argv, ++i, a);
      const [id, setting] = spec.split("=");
      if (!id || !setting || !SETTINGS.has(setting)) {
        fail(`--rule の指定が不正です: ${JSON.stringify(spec)}`);
      }
      if (!RULES.some((r) => r.id === id)) {
        fail(`そのような規則はありません: ${id}（--list-rules で一覧）`);
      }
      rules[id] = setting as RuleSetting;
    } else if (a.startsWith("-")) {
      fail(`不明なオプション: ${a}\n\n${USAGE}`);
    } else targets.push(a);
  }
  if (targets.length === 0) usage(USAGE, 2);

  const files = targets.flatMap((t) => collect(resolve(t)));
  if (files.length === 0) fail("PL/I のファイルが見つかりません");

  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let flaggedFiles = 0;
  let syntaxErrors = 0;

  for (const file of files) {
    const source = readText(file, "ソース");
    const host = hostForFile(file);
    // 文を 1 つも実行させずに構文だけ見る
    const syntax: Diagnostic[] = runProgram(source, {
      maxSteps: 0,
      host,
    }).diagnostics.filter((d) => d.phase !== "runtime");
    if (syntax.length > 0) {
      syntaxErrors++;
      flaggedFiles++;
      console.log(`--- ${basename(file)} ---`);
      for (const d of syntax) {
        const where = d.file === undefined ? "" : `${d.file} `;
        const col = d.col === undefined ? "" : `${d.col}桁`;
        console.log(`  ERR  ${where}${d.line}行${col}: ${d.message} [構文]`);
      }
      console.log("");
      // 構文が通らないソースに Linter をかけても何も返らない。
      // 「指摘なし」と出すと誤解を生むので、ここで次のファイルへ
      continue;
    }

    const messages: LintMessage[] = lint(source, {
      rules,
      host,
      // コピーブック（.inc / .cpy / .plinc）は宣言だけの断片なので、
      // missing-main と「使われていない」は当たらない
      ...(isFragmentFileName(file) ? { fragment: true } : {}),
    });
    for (const m of messages) {
      if (m.severity === "error") errors++;
      else if (m.severity === "warning") warnings++;
      else infos++;
    }
    if (messages.length > 0) flaggedFiles++;
    if (messages.length > 0 || !quiet) {
      console.log(formatLint(messages, basename(file)));
      console.log("");
    }
  }

  console.log(
    `=== ファイル ${files.length} / 指摘のあるファイル ${flaggedFiles} / ` +
      `構文の誤り ${syntaxErrors} / 誤り ${errors} / 警告 ${warnings} / 情報 ${infos} ===`,
  );
  process.exitCode =
    syntaxErrors > 0 || errors > 0 || (strict && warnings > 0) ? 1 : 0;
});
