/**
 * Linter の CLI。
 *
 *   npm run plilint -- examples/tests
 *   npm run plilint -- src.pli --rule goto-outside-on-unit=off --strict
 *
 * 既定では error が 1 件でもあれば終了コード 1。
 * `--strict` を付けると warning も失敗として扱う。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  lint,
  formatLint,
  RULES,
  type LintMessage,
  type RuleSetting,
} from "../src/index.js";
import { hostForFile } from "./node-host.js";

const SETTINGS = new Set(["off", "info", "warning", "error"]);

function collect(target: string): string[] {
  const st = statSync(target);
  if (st.isFile()) return [target];
  return readdirSync(target)
    .sort()
    .flatMap((entry) => {
      const full = join(target, entry);
      if (statSync(full).isDirectory()) return collect(full);
      return /\.(pli|pl1)$/i.test(entry) ? [full] : [];
    });
}

function usage(): never {
  console.error(
    "使い方: plilint <ファイル/ディレクトリ...> [--strict] " +
      "[--rule <id>=<off|info|warning|error>] [--quiet] [--list-rules]",
  );
  process.exit(2);
}

function listRules(): never {
  for (const category of ["correctness", "style"] as const) {
    console.log(`[${category}]`);
    for (const r of RULES.filter((x) => x.category === category)) {
      console.log(`  ${r.id}  (既定: ${r.default})`);
      console.log(`      ${r.summary}`);
      console.log(`      ${r.rationale}`);
    }
  }
  process.exit(0);
}

const targets: string[] = [];
const rules: Record<string, RuleSetting> = {};
let strict = false;
let quiet = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--strict") strict = true;
  else if (a === "--quiet" || a === "-q") quiet = true;
  else if (a === "--list-rules") listRules();
  else if (a === "--rule") {
    const spec = argv[++i] ?? "";
    const [id, value] = spec.split("=");
    if (!id || !value || !SETTINGS.has(value)) {
      console.error(`--rule の指定が不正です: ${JSON.stringify(spec)}`);
      process.exit(2);
    }
    if (!RULES.some((r) => r.id === id)) {
      console.error(`そのような規則はありません: ${id}（--list-rules で一覧）`);
      process.exit(2);
    }
    rules[id] = value as RuleSetting;
  } else if (a.startsWith("-")) {
    console.error(`不明なオプション: ${a}`);
    usage();
  } else targets.push(a);
}
if (targets.length === 0) usage();

const files = targets.flatMap((t) => collect(resolve(t)));
if (files.length === 0) {
  console.error("PL/I のファイルが見つかりません");
  process.exit(2);
}

let errors = 0;
let warnings = 0;
let infos = 0;
let flaggedFiles = 0;

for (const file of files) {
  const messages: LintMessage[] = lint(readFileSync(file, "utf8"), {
    rules,
    host: hostForFile(file),
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
    `誤り ${errors} / 警告 ${warnings} / 情報 ${infos} ===`,
);
process.exit(errors > 0 || (strict && warnings > 0) ? 1 : 0);
