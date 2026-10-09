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
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { runProgram } from "../src/index.js";
import { hostForFile } from "./node-host.js";

interface Args {
  file?: string;
  psb?: string;
  stdin?: string;
  maxSteps?: number;
  /** 主手続きへ渡すコマンドライン引数（`--` の後ろ）。 */
  programArgs: string[];
}

function parseArgs(argv: string[]): Args {
  const programArgs: string[] = [];
  let file: string | undefined;
  let psb: string | undefined;
  let stdin: string | undefined;
  let maxSteps: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      programArgs.push(...argv.slice(i + 1));
      break;
    }
    if (a === "--psb") psb = argv[++i];
    else if (a === "--stdin") stdin = readFileSync(argv[++i]!, "utf8");
    else if (a === "--max-steps") maxSteps = Number(argv[++i]);
    else if (a.startsWith("-")) {
      console.error(`不明なオプション: ${a}`);
      process.exit(2);
    } else if (file === undefined) file = a;
    else {
      console.error(`ソースは 1 本だけ指定してください: ${a}`);
      process.exit(2);
    }
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(psb === undefined ? {} : { psb }),
    ...(stdin === undefined ? {} : { stdin }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    programArgs,
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.file === undefined) {
  console.error(
    "使い方: pli <ソース.pli> [--psb <PSB 名>] [--stdin <ファイル>] " +
      "[--max-steps N] [-- 主手続きの引数...]",
  );
  process.exit(2);
}

const source = readFileSync(args.file, "utf8");
const result = runProgram(source, {
  host: hostForFile(args.file, args.stdin),
  maxSteps: args.maxSteps ?? 5_000_000,
  maxOutputBytes: 1_000_000,
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
process.exit(result.ok ? 0 : 1);
