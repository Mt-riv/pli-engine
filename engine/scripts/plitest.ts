/**
 * テストファイルを走らせる CLI。
 *
 *   npm run plitest -- examples/tests
 *   npm run plitest -- a_test.pli b_test.pli --xml out/
 *
 * 失敗・異常が 1 件でもあれば終了コード 1（CI に載せるため）。
 *
 * PSB（IMS/DB）は、指定が無ければテストファイルの隣の `*.psb` を見る。
 * ちょうど 1 つあればそれを使う。これが無いと
 * `plitest examples/tests` が DL/I のテストだけ全部異常になる
 * （PSB は実機では JCL が決めるもので、ソースには書けない）。
 */
import { m, msg, tr } from "../src/i18n/index.js";
import { writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join, basename, extname, relative, resolve } from "node:path";
import {
  isTestFileName,
  isTestSource,
  runTestSource,
  formatReport,
  toXmlReport,
  type TestReport,
} from "../src/index.js";
import { hostForFile, psbBeside } from "./node-host.js";
import {
  applyLangOption,
  fail,
  main,
  positiveInt,
  readText,
  usage,
  value,
} from "./cli-util.js";

const USAGE = msg(`使い方: plitest <ファイル/ディレクトリ...> [オプション]

  --xml <出力先>       テストファイルごとに <出力先>/<名前>.xml を書く
  --max-steps N        実行する文の数の上限
  --psb <PSB 名>       IMS/DB（DL/I）で使う PSB。省略すると隣の *.psb を探す
  --write              テストの書き出しを実ファイルへ反映する
  --all                名前が規約に合わないファイルも中身で判定する
  --quiet, -q          失敗したファイルだけ表示する
  --lang ja|en         メッセージの言語（既定 ja。環境変数 PLI_LANG でも指定できる）
  -h, --help           この使い方を表示する`);

/**
 * ディレクトリを辿ってテストファイルを集める。
 * シンボリックリンクは辿らない（`sub/back -> .` で無限に降りる）。
 */
function collect(target: string, all: boolean, seen = new Set<string>()): string[] {
  let st;
  try {
    st = statSync(target);
  } catch {
    fail(m`読めません: ${target}`);
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
      const est = lstatSync(full);
      if (est.isSymbolicLink()) return [];
      if (est.isDirectory()) return collect(full, all, seen);
      if (!est.isFile()) return [];
      if (isTestFileName(entry)) return [full];
      // `--all` なら名前の規約に合わないファイルも中身で判定する。
      // 既定で中身まで見ないのは、ふつうのプログラムを
      // テストとして走らせてしまわないため
      if (!all || !/\.(pli|pl1)$/i.test(entry)) return [];
      try {
        return isTestSource(readText(full, m`ソース`)) ? [full] : [];
      } catch {
        return [];
      }
    });
}

main(() => {
  const targets: string[] = [];
  let xmlDir: string | undefined;
  let maxSteps: number | undefined;
  let psb: string | undefined;
  let write = false;
  let quiet = false;
  let all = false;

  const argv = applyLangOption(process.argv.slice(2));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") usage(tr(USAGE));
    else if (a === "--xml") xmlDir = value(argv, ++i, a);
    else if (a === "--max-steps") maxSteps = positiveInt(value(argv, ++i, a), a);
    else if (a === "--psb") psb = value(argv, ++i, a);
    else if (a === "--write") write = true;
    else if (a === "--all") all = true;
    else if (a === "--quiet" || a === "-q") quiet = true;
    else if (a.startsWith("-")) fail(m`不明なオプション: ${a}\n\n${tr(USAGE)}`);
    else targets.push(a);
  }
  if (targets.length === 0) usage(tr(USAGE), 2);

  const files = targets.flatMap((t) => collect(resolve(t), all));
  if (files.length === 0) {
    fail(m`テストファイルが見つかりません（*_test.pli / test_*.pli / *.test.pli）`);
  }

  if (xmlDir !== undefined) mkdirSync(xmlDir, { recursive: true });

  const reports: { file: string; report: TestReport }[] = [];
  let loadErrors = 0;
  for (const file of files) {
    const source = readText(file, m`ソース`);
    // %INCLUDE とファイル入出力は、そのテストファイルのあるディレクトリを基準にする。
    //
    // 書き出しは既定で実ファイルへ反映しない。テストを走らせるたびに
    // 元データが変わると、2 回目から結果が変わってしまう
    // （DL/I の DLET を試すテストで実際に起きた）。
    const usePsb = psb ?? psbBeside(file);
    const report = runTestSource(source, {
      host: hostForFile(file, undefined, !write),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(usePsb === undefined ? {} : { psb: usePsb }),
    });
    reports.push({ file, report });
    if (report.note !== undefined && report.results.length === 0) loadErrors++;

    const name = basename(file);
    if (!quiet || !report.ok) {
      console.log(formatReport(report, name, { failedOutput: true }));
    }
    if (xmlDir !== undefined) {
      const suite = basename(name, extname(name));
      // ファイルの位置も入れる。CI の注釈は file と line の両方が要る。
      // 作業ディレクトリの外にあるファイルは絶対パスのまま載せる
      // （`../../..` と並ぶ道より読みやすく、CI も辿れない）
      const rel = relative(process.cwd(), file);
      const xmlFile = rel !== "" && !rel.startsWith("..") ? rel : file;
      writeFileSync(
        join(xmlDir, `${suite}.xml`),
        toXmlReport(report, suite, { file: xmlFile }),
      );
    }
    if (!quiet) console.log("");
  }

  const sum = (pick: (r: TestReport) => number) =>
    reports.reduce((acc, { report }) => acc + pick(report), 0);
  const ok = reports.every(({ report }) => report.ok);

  console.log(
    m`=== ファイル ${files.length} / テスト ${sum((r) => r.total)} / 成功 ${sum((r) => r.passed)} / 失敗 ${sum((r) => r.failures)} / 異常 ${sum((r) => r.errors)} / 省略 ${sum((r) => r.skipped)} / 読み込み不能 ${loadErrors} ===`,
  );
  process.exitCode = ok ? 0 : 1;
});
