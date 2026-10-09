/**
 * テストファイルを走らせる CLI。
 *
 *   npm run plitest -- examples/tests
 *   npm run plitest -- a_test.pli b_test.pli --xml out/
 *
 * 失敗・異常が 1 件でもあれば終了コード 1（CI に載せるため）。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { runTestSource, formatReport, toXmlReport, type TestReport } from "../src/index.js";
import { hostForFile } from "./node-host.js";

/** テストファイルとみなす名前。`*_test.pli` / `test_*.pli` / `*.test.pli`。 */
function isTestFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (!/\.(pli|pl1)$/.test(lower)) return false;
  const stem = basename(lower, extname(lower));
  return stem.endsWith("_test") || stem.startsWith("test_") || stem.endsWith(".test");
}

function collect(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target)
    .sort()
    .flatMap((entry) => {
      const full = join(target, entry);
      if (statSync(full).isDirectory()) return collect(full);
      return isTestFile(entry) ? [full] : [];
    });
}

interface Args {
  targets: string[];
  xmlDir?: string;
  maxSteps?: number;
  /** DL/I を使うテストで読む PSB の名前。 */
  psb?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const targets: string[] = [];
  let xmlDir: string | undefined;
  let maxSteps: number | undefined;
  let psb: string | undefined;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--xml") xmlDir = argv[++i];
    else if (a === "--max-steps") maxSteps = Number(argv[++i]);
    else if (a === "--psb") psb = argv[++i];
    else if (a === "--quiet" || a === "-q") quiet = true;
    else if (a.startsWith("-")) {
      console.error(`不明なオプション: ${a}`);
      process.exit(2);
    } else targets.push(a);
  }
  if (targets.length === 0) {
    console.error(
      "使い方: plitest <ファイルまたはディレクトリ...> [--xml <出力先>] " +
        "[--max-steps N] [--psb <PSB 名>] [--quiet]",
    );
    process.exit(2);
  }
  return { targets, xmlDir, maxSteps, psb, quiet };
}

const args = parseArgs(process.argv.slice(2));
const files = args.targets.flatMap((t) => collect(resolve(t)));

if (files.length === 0) {
  console.error("テストファイルが見つかりません（*_test.pli / test_*.pli / *.test.pli）");
  process.exit(2);
}

if (args.xmlDir) mkdirSync(args.xmlDir, { recursive: true });

const reports: { file: string; report: TestReport }[] = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  // %INCLUDE とファイル入出力は、そのテストファイルのあるディレクトリを基準にする
  const report = runTestSource(source, {
    host: hostForFile(file),
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    ...(args.psb === undefined ? {} : { psb: args.psb }),
  });
  reports.push({ file, report });

  const name = basename(file);
  if (!args.quiet || !report.ok) {
    console.log(formatReport(report, name, { failedOutput: true }));
  }
  if (args.xmlDir) {
    const suite = basename(name, extname(name));
    writeFileSync(join(args.xmlDir, `${suite}.xml`), toXmlReport(report, suite));
  }
  if (!args.quiet) console.log("");
}

const sum = (pick: (r: TestReport) => number) =>
  reports.reduce((acc, { report }) => acc + pick(report), 0);
const total = sum((r) => r.total);
const failures = sum((r) => r.failures);
const errors = sum((r) => r.errors);
const ok = reports.every(({ report }) => report.ok);

console.log(
  `=== ファイル ${files.length} / テスト ${total} / 成功 ${sum((r) => r.passed)} / ` +
    `失敗 ${failures} / 異常 ${errors} / 省略 ${sum((r) => r.skipped)} ===`,
);
process.exit(ok ? 0 : 1);
