/**
 * プログラムを 1 本走らせる CLI。
 *
 *   npm run pli -- hello.pli
 *   npm run pli -- stuprt.pli --psb STUPSB
 *   npm run pli -- numwrd.pli -- 123
 *
 * `--psb` を付けると DL/I（IMS/DB）が使える。DBD・PSB・データは
 * ソースと同じディレクトリから `<名前>.dbd` / `<名前>.psb` /
 * `<DBD 名>.dat` として読み、更新はそこへ書き戻す。
 *
 * 誤りが 1 件でもあれば終了コード 1。
 */
import { basename } from "node:path";
import { runProgram } from "../src/index.js";
import { hostForFile } from "./node-host.js";
import { fail, main, positiveInt, readText, usage, value } from "./cli-util.js";

const USAGE = `使い方: pli <ソース.pli> [オプション] [-- 主手続きの引数...]

  --psb <PSB 名>         IMS/DB（DL/I）を使う
  --stdin <ファイル>      SYSIN に流し込む
  --max-steps N          実行する文の数の上限（既定 5000000）
  --max-output N         出力の上限（文字数。既定 1000000）
  -I <ディレクトリ>       %INCLUDE とファイルの追加の探索先（繰り返せる）
  --allow-outside        ソースのディレクトリの外も読み書きできるようにする
  -h, --help             この使い方を表示する`;

interface Args {
  file?: string;
  psb?: string;
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
  let file: string | undefined;
  let psb: string | undefined;
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
    if (a === "-h" || a === "--help") usage(USAGE);
    else if (a === "--psb") psb = value(argv, ++i, a);
    else if (a === "--stdin") stdin = readText(value(argv, ++i, a), "標準入力のファイル");
    else if (a === "--max-steps") maxSteps = positiveInt(value(argv, ++i, a), a);
    else if (a === "--max-output") maxOutput = positiveInt(value(argv, ++i, a), a);
    else if (a === "-I") includeDirs.push(value(argv, ++i, a));
    else if (a === "--allow-outside") allowOutside = true;
    else if (a.startsWith("-")) fail(`不明なオプション: ${a}\n\n${USAGE}`);
    else if (file === undefined) file = a;
    else fail(`ソースは 1 本だけ指定してください: ${a}`);
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(psb === undefined ? {} : { psb }),
    ...(stdin === undefined ? {} : { stdin }),
    maxSteps,
    maxOutput,
    includeDirs,
    allowOutside,
    programArgs,
  };
}

main(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.file === undefined) usage(USAGE, 2);

  const source = readText(args.file, "ソース");
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
    console.error("(出力が上限に達したので打ち切りました)");
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
