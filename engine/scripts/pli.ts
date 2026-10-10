/**
 * プログラムを 1 本走らせる CLI。
 *
 *   npm run pli -- hello.pli
 *   npm run pli -- stuprt.pli --psb STUPSB
 *   npm run pli -- numwrd.pli -- 123
 *   npm run pli -- invq.pli --psb INVPSB --keys invq.keys
 *
 * `--psb` を付けると DL/I（IMS/DB）が使える。DBD・PSB・データは
 * ソースと同じディレクトリから `<名前>.dbd` / `<名前>.psb` /
 * `<DBD 名>.dat` として読み、更新はそこへ書き戻す。
 *
 * `--keys` を付けると画面入出力（MFS）になる。書式定義は同じ
 * ディレクトリの `*.mfs` を全部読む。台本の書き方は `src/tm/keys.ts`。
 *
 * 誤りが 1 件でもあれば終了コード 1。
 */
import { m, msg, tr } from "../src/i18n/index.js";
import { readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { checkMfs, formatWarning, loadMfs, runProgram } from "../src/index.js";
import { parseKeys, playKeys, transcript } from "../src/tm/keys.js";
import { hostForFile } from "./node-host.js";
import {
  applyLangOption,
  fail,
  main,
  positiveInt,
  readText,
  usage,
  value,
} from "./cli-util.js";

const USAGE = msg(`使い方: pli <ソース.pli> [オプション] [-- 主手続きの引数...]

  --psb <PSB 名>         IMS/DB（DL/I）を使う
  --keys <ファイル>       端末の操作の台本を流して画面を出す（MFS）
  --mfs <ファイル>        書式定義を名指しで読む（既定は同じ場所の *.mfs）
  --stdin <ファイル>      SYSIN に流し込む
  --max-steps N          実行する文の数の上限（既定 5000000）
  --max-output N         出力の上限（文字数。既定 1000000）
  -I <ディレクトリ>       %INCLUDE とファイルの追加の探索先（繰り返せる）
  --allow-outside        ソースのディレクトリの外も読み書きできるようにする
  --lang ja|en           メッセージの言語（既定 ja。環境変数 PLI_LANG でも指定できる）
  -h, --help             この使い方を表示する`);

interface Args {
  file?: string;
  psb?: string;
  keys?: string;
  mfs: string[];
  stdin?: string;
  maxSteps: number;
  maxOutput: number;
  includeDirs: string[];
  allowOutside: boolean;
  /** 主手続きへ渡すコマンドライン引数（`--` の後ろ）。 */
  programArgs: string[];
}

function parseArgs(argv: string[]): Args {
  const programArgs: string[] = [];
  const includeDirs: string[] = [];
  const mfs: string[] = [];
  let file: string | undefined;
  let psb: string | undefined;
  let keys: string | undefined;
  let stdin: string | undefined;
  let maxSteps = 5_000_000;
  let maxOutput = 1_000_000;
  let allowOutside = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      programArgs.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") usage(tr(USAGE));
    else if (a === "--psb") psb = value(argv, ++i, a);
    else if (a === "--keys") keys = value(argv, ++i, a);
    else if (a === "--mfs") mfs.push(value(argv, ++i, a));
    else if (a === "--stdin") stdin = readText(value(argv, ++i, a), m`標準入力のファイル`);
    else if (a === "--max-steps") maxSteps = positiveInt(value(argv, ++i, a), a);
    else if (a === "--max-output") maxOutput = positiveInt(value(argv, ++i, a), a);
    else if (a === "-I") includeDirs.push(value(argv, ++i, a));
    else if (a === "--allow-outside") allowOutside = true;
    else if (a.startsWith("-")) fail(m`不明なオプション: ${a}\n\n${tr(USAGE)}`);
    else if (file === undefined) file = a;
    else fail(m`ソースは 1 本だけ指定してください: ${a}`);
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(psb === undefined ? {} : { psb }),
    ...(keys === undefined ? {} : { keys }),
    mfs,
    ...(stdin === undefined ? {} : { stdin }),
    maxSteps,
    maxOutput,
    includeDirs,
    allowOutside,
    programArgs,
  };
}

/** 書式定義を集める。名指しが無ければソースの隣の `*.mfs` を全部。 */
function mfsFiles(args: Args & { file: string }): Record<string, string> {
  const named = args.mfs;
  const paths =
    named.length > 0
      ? named.map((p) => resolve(p))
      : readdirSync(dirname(resolve(args.file)))
          .filter((f) => f.endsWith(".mfs"))
          .map((f) => join(dirname(resolve(args.file)), f));
  const out: Record<string, string> = {};
  for (const p of paths) out[basename(p)] = readText(p, m`書式定義`);
  if (Object.keys(out).length === 0) {
    fail(m`書式定義（*.mfs）が見つかりません: ${dirname(resolve(args.file))}`);
  }
  return out;
}

/** 画面入出力（MFS）。台本どおりに動かして画面を出す。 */
function runWithScreen(args: Args & { file: string; keys: string }): void {
  if (args.psb === undefined) {
    fail(m`--keys を使うには --psb も必要です（入出力 PCB を含む PSB）`);
  }
  const library = loadMfs(mfsFiles(args));
  // 止めるほどではないが、たぶん間違いというもの
  for (const w of checkMfs(library)) console.error(formatWarning(w));
  const { steps } = playKeys({
    source: readText(args.file, m`ソースファイル`),
    library,
    host: hostForFile(args.file, args.stdin, undefined, {
      ...(args.includeDirs.length === 0 ? {} : { includeDirs: args.includeDirs }),
      ...(args.allowOutside ? { allowOutside: true } : {}),
    }),
    psb: args.psb,
    script: parseKeys(readText(args.keys, m`台本`), basename(args.keys)),
    limits: { maxSteps: args.maxSteps, maxOutputBytes: args.maxOutput },
  });
  process.stdout.write(transcript(steps));
  const notices = steps.filter((s) => s.step.notice !== undefined).length;
  if (notices > 0) console.error(m`(IMS からの通知が ${notices} 件ありました)`);
  process.exitCode = steps.some((s) => s.step.diagnostics.length > 0) ? 1 : 0;
}

main(() => {
  const args = parseArgs(applyLangOption(process.argv.slice(2)));
  if (args.file === undefined) usage(tr(USAGE), 2);
  if (args.keys !== undefined) {
    runWithScreen({ ...args, file: args.file, keys: args.keys });
    return;
  }

  const source = readText(args.file, m`ソースファイル`);
  const result = runProgram(source, {
    host: hostForFile(args.file, args.stdin, undefined, {
      ...(args.includeDirs.length === 0 ? {} : { includeDirs: args.includeDirs }),
      ...(args.allowOutside ? { allowOutside: true } : {}),
    }),
    maxSteps: args.maxSteps,
    maxOutputBytes: args.maxOutput,
    ...(args.psb === undefined ? {} : { psb: args.psb }),
    ...(args.programArgs.length === 0 ? {} : { args: args.programArgs }),
  });

  process.stdout.write(result.stdout);
  if (result.truncated) {
    console.error(m`(出力が上限に達したので打ち切りました)`);
  }
  for (const d of result.diagnostics) {
    const where = d.file === undefined ? basename(args.file) : d.file;
    const col = d.col === undefined ? "" : `:${d.col}`;
    console.error(`${where}:${d.line}${col}: ${d.message}`);
  }
  // process.exit は使わない。パイプへの書き込みが非同期なので、
  // 未送出分が捨てられて出力が 65536 バイトで切れる
  process.exitCode = result.ok ? 0 : 1;
});
