/**
 * `examples/` の例が壊れたままにならないようにする。
 *
 * 手引きに載せる例そのものを常用のテストに載せている。
 *
 * **3 つのディレクトリを全部ここで走らせる。** 以前は
 * `examples/tests` しか走っていなかったため、`examples/dli/stuprt.pli` は
 * lint されるだけで**一度も実行されておらず**、PSB を指定せずに走らせると
 * 「ポインタにはポインタしか代入できません」とだけ言う状態が
 * 見つからなかった。`examples/screen` も同じ理由で後から足している。
 *
 * PSB の発見は `psbBeside` を使う。ここで自前に数え直すと、
 * テストが**自分の実装を検証してしまい**、製品側が壊れても緑のままになる
 * （実際にそうなっていて、VSCode 拡張に隣から拾う段が無いことを
 * 取りこぼした）。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discover,
  loadMfs,
  MemoryHost,
  parseKeys,
  playKeys,
  runProgram,
  runTestSource,
  transcript,
} from "../src/index.js";
import { NodeHost, psbBeside } from "../scripts/node-host.js";

const EXAMPLES = join(import.meta.dirname, "../examples");

/**
 * 例と同じディレクトリを基準にするホスト。
 * 書き出しは実ファイルへ反映しない（例のデータが変わるとテストが
 * 2 回目から別の結果になる）。
 */
const hostFor = (dir: string) => new NodeHost({ baseDir: dir, dryRun: true });

describe("examples/tests", () => {
  const dir = join(EXAMPLES, "tests");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".pli"))
    .sort();
  const psb = psbBeside(join(dir, "x.pli"));

  it("テストファイルが存在する", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} は全件成功する`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      const d = discover(source, hostFor(dir));
      expect(d.error).toBeUndefined();
      expect(d.tests.length).toBeGreaterThan(0);

      const report = runTestSource(source, {
        host: hostFor(dir),
        ...(psb === undefined ? {} : { psb }),
      });
      const bad = report.results.filter(
        (r) => r.status === "failed" || r.status === "error",
      );
      // 失敗したテストの名前と理由をそのまま見せる
      expect(bad.map((r) => `${r.name}: ${r.message}`)).toEqual([]);
      expect(report.ok).toBe(true);
    });
  }
});

describe("examples/dli", () => {
  const dir = join(EXAMPLES, "dli");
  const file = join(dir, "stuprt.pli");

  it("隣の PSB が 1 つだけ置いてある", () => {
    expect(psbBeside(file)).toBe("STUPSB");
  });

  it("階層順に全件並べて終わる", () => {
    const r = runProgram(readFileSync(file, "utf8"), {
      host: hostFor(dir),
      psb: psbBeside(file)!,
    });
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
    expect(r.ok).toBe(true);
    // 親の下に子が続く（階層順）ことと、終端まで読んだことを見る
    expect(r.stdout).toContain("01 STUDENT S0001");
    expect(r.stdout).toContain("02 COURSE  S0001C001");
    expect(r.stdout).toMatch(/合計\s+5 件 \/ STATUS=GB/);
  });

  /**
   * PSB が無いときの断り方。
   *
   * 走らせ方を知らずに `PL/I: 実行` を押すと必ずここへ来るので、
   * 文面が「何を足せばよいか」を言っていることまで固定する。
   */
  it("PSB を与えずに走らせると、何が足りないかを名指しで言う", () => {
    const r = runProgram(readFileSync(file, "utf8"), { host: hostFor(dir) });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("PSB");
    expect(r.diagnostics[0]?.message).not.toContain("ポインタにはポインタしか");
  });
});

describe("examples/screen", () => {
  const dir = join(EXAMPLES, "screen");
  const read = (name: string): string => readFileSync(join(dir, name), "utf8");

  it("隣の PSB が 1 つだけ置いてある", () => {
    expect(psbBeside(join(dir, "dbinq.pli"))).toBe("INVPSB");
  });

  it("書式と台本がソースと同じ名前で揃っている（拡張はこの対応で探す）", () => {
    const names = readdirSync(dir);
    expect(names).toContain("dbinq.mfs");
    expect(names).toContain("dbinq.keys");
  });

  it("品番を引いて、見つかる場合と見つからない場合を画面に出す", () => {
    const files: Record<string, string> = {};
    for (const f of readdirSync(dir)) {
      if (/\.(dbd|psb|dat|inc)$/i.test(f)) files[f] = read(f);
    }
    const { steps } = playKeys({
      source: read("dbinq.pli"),
      library: loadMfs({ "dbinq.mfs": read("dbinq.mfs") }),
      host: new MemoryHost(files),
      psb: psbBeside(join(dir, "dbinq.pli"))!,
      script: parseKeys(read("dbinq.keys"), "dbinq.keys"),
      limits: { maxSteps: 1_000_000, maxOutputBytes: 100_000 },
    });
    const text = transcript(steps);
    // 入力は MID の JUST=R / FILL=C'0' で 6 桁にそろうので、
    // `42` がそのまま順序キーの SSA に使える
    expect(text).toContain("BOLT M6 X 20");
    expect(text).toContain("FOUND");
    // 無い品番は DL/I が GE を返し、画面にその旨が出る
    expect(text).toContain("NOT FOUND (STATUS GE)");
  });
});
