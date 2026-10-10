/**
 * Linter の検証。
 *
 * 規則ごとに「出ること」と「出てはいけないこと」を対で置く。
 * 誤検出は Linter を切られる最大の理由なので、
 * 既に正しいと分かっているコード（ブラウザ版のサンプルと examples/tests）に
 * 指摘が出ないことも固定する。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lint, formatLint, RULES, type LintMessage } from "../src/index.js";
import { BUILTIN_NAMES } from "../src/interp.js";
import { SAMPLES } from "../web/samples.js";

/** その規則の指摘だけを取り出す。 */
function only(messages: LintMessage[], rule: string): LintMessage[] {
  return messages.filter((m) => m.rule === rule);
}

const MAIN = (body: string) => `p: proc options(main);\n${body}\nend p;\n`;

describe("BUILTIN_NAMES", () => {
  /**
   * Linter は「組込関数かどうか」をこの集合で判断する。
   * 評価器の case と食い違うと、使える組込関数を「未宣言」と報告するか、
   * 存在しない名前を見逃すかのどちらかになる。
   */
  it("評価器が実際に扱う名前と一致する", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/interp.ts"), "utf8");
    const start = src.indexOf("  private builtin(");
    expect(start).toBeGreaterThan(0);
    const rest = src.slice(start + 10);
    const next = /\n  (private|public|protected)/.exec(rest);
    const body = rest.slice(0, next ? next.index : undefined);
    const cases = new Set([...body.matchAll(/case "([A-Z0-9_]+)":/g)].map((m) => m[1]!));
    expect([...cases].sort()).toEqual([...BUILTIN_NAMES].sort());
  });
});

describe("規則の定義", () => {
  it("id が重複しない", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("すべての規則に理由が書いてある", () => {
    for (const r of RULES) {
      expect(r.summary.length, r.id).toBeGreaterThan(0);
      expect(r.rationale.length, r.id).toBeGreaterThan(10);
    }
  });
});

describe("implicit-declaration", () => {
  it("宣言の無い名前を指摘し、暗黙の型を示す", () => {
    const m = only(lint(MAIN("  i = 1;\n  x = 2;")), "implicit-declaration");
    expect(m).toHaveLength(2);
    expect(m[0]?.message).toContain("FIXED BIN(15,0)");
    expect(m[1]?.message).toContain("FLOAT DEC(6)");
  });

  it("宣言済みなら出ない", () => {
    const src = MAIN("  dcl i fixed bin(31);\n  i = 1;\n  put list(i);");
    expect(only(lint(src), "implicit-declaration")).toEqual([]);
  });

  it("組込関数は未宣言ではない", () => {
    const src = MAIN("  dcl s char(5);\n  s = 'abcde';\n  put list(length(s), substr(s, 2, 2));");
    expect(only(lint(src), "implicit-declaration")).toEqual([]);
  });

  it("構造体は修飾名でも構造体そのものでも未宣言にしない", () => {
    const src = MAIN(
      "  dcl 1 rec,\n" +
        "        2 name char(5),\n" +
        "        2 age fixed bin(15);\n" +
        "  rec.name = 'abc';\n" +
        "  rec.age = 3;\n" +
        "  put list(rec.name, rec.age);",
    );
    expect(only(lint(src), "implicit-declaration")).toEqual([]);
  });

  it("テストファイルではフレームワークの手続きを未宣言にしない", () => {
    const src = `TEST_X: proc;\n  call ASSERT_EQUALS(4, 2 + 2, '足し算');\nend TEST_X;\n`;
    expect(only(lint(src), "implicit-declaration")).toEqual([]);
    expect(only(lint(src), "undefined-procedure")).toEqual([]);
  });
});

describe("未使用・未代入", () => {
  it("使っていない変数を指摘する", () => {
    const m = only(lint(MAIN("  dcl unused char(10);\n  put list('x');")), "unused-variable");
    expect(m).toHaveLength(1);
    expect(m[0]?.message).toContain("unused");
  });

  it("代入しているが読んでいない変数を指摘する", () => {
    const src = MAIN("  dcl a fixed bin(31);\n  a = 1;\n  put list('x');");
    expect(only(lint(src), "assigned-but-never-read")).toHaveLength(1);
  });

  it("値を入れずに読んでいる変数を指摘する", () => {
    const src = MAIN("  dcl a fixed bin(31);\n  put list(a);");
    expect(only(lint(src), "never-assigned")).toHaveLength(1);
  });

  it("INITIAL があれば未代入としない", () => {
    const src = MAIN("  dcl a fixed bin(31) init(5);\n  put list(a);");
    expect(only(lint(src), "never-assigned")).toEqual([]);
  });

  it("LBOUND などの形の問い合わせは値を読んだ扱いにしない", () => {
    const src = MAIN("  dcl a(5) fixed bin(31);\n  put list(lbound(a,1), hbound(a,1), dim(a,1));");
    expect(only(lint(src), "never-assigned")).toEqual([]);
    expect(only(lint(src), "unused-variable")).toEqual([]);
  });

  it("引数は未使用の対象にしない", () => {
    const src =
      "p: proc options(main);\n  call f(1);\n  f: proc(v);\n    dcl v fixed bin(31);\n  end f;\nend p;\n";
    expect(only(lint(src), "unused-variable")).toEqual([]);
  });

  it("呼ばれていない手続きを指摘する", () => {
    const src = "p: proc options(main);\n  put list('x');\n  f: proc;\n  end f;\nend p;\n";
    expect(only(lint(src), "unused-procedure")).toHaveLength(1);
  });

  it("主手続きとテストの手続きは呼ばれていなくてよい", () => {
    expect(only(lint(MAIN("  put list('x');")), "unused-procedure")).toEqual([]);
    const test = `SETUP: proc;\nend SETUP;\nTEST_X: proc;\n  call ASSERT_TRUE('1'b, 'ok');\nend TEST_X;\n`;
    expect(only(lint(test), "unused-procedure")).toEqual([]);
  });
});

describe("undefined-procedure", () => {
  it("定義の無い手続きの呼び出しを誤りとして出す", () => {
    const m = only(lint(MAIN("  call nowhere;")), "undefined-procedure");
    expect(m).toHaveLength(1);
    expect(m[0]?.severity).toBe("error");
  });

  it("定義があれば出ない", () => {
    const src =
      "p: proc options(main);\n  call f;\n  f: proc;\n    put list('x');\n  end f;\nend p;\n";
    expect(only(lint(src), "undefined-procedure")).toEqual([]);
  });
});

describe("shadows-builtin", () => {
  it("組込関数と同じ名前の宣言を指摘する", () => {
    const src = MAIN("  dcl substr fixed bin(15);\n  substr = 1;\n  put list(substr);");
    expect(only(lint(src), "shadows-builtin")).toHaveLength(1);
  });
});

describe("missing-main", () => {
  it("主手続きが無ければ指摘する", () => {
    const src = "f: proc;\n  put list('x');\nend f;\n";
    expect(only(lint(src), "missing-main")).toHaveLength(1);
  });

  it("テストファイルは対象にしない", () => {
    const src = `TEST_X: proc;\n  call ASSERT_TRUE('1'b, 'ok');\nend TEST_X;\n`;
    expect(only(lint(src), "missing-main")).toEqual([]);
  });
});

describe("mixed-base-arithmetic", () => {
  it("FIXED DEC と FIXED BIN の混在を指摘する", () => {
    const src = MAIN(
      "  dcl d fixed dec(7,2);\n  dcl b fixed bin(31);\n  dcl r fixed dec(9,2);\n" +
        "  d = 1.5;\n  b = 2;\n  r = d * b;\n  put list(r);",
    );
    expect(only(lint(src), "mixed-base-arithmetic")).toHaveLength(1);
  });

  it("基数が揃っていれば出ない", () => {
    const src = MAIN(
      "  dcl d fixed dec(7,2);\n  dcl e fixed dec(7,2);\n  dcl r fixed dec(9,2);\n" +
        "  d = 1.5;\n  e = 2;\n  r = d * e;\n  put list(r);",
    );
    expect(only(lint(src), "mixed-base-arithmetic")).toEqual([]);
  });
});

describe("free-then-use", () => {
  it("FREE したポインタでの参照を指摘する", () => {
    const src = MAIN(`  dcl q pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell set(q);
  q -> cell = 1;
  free q -> cell;
  put list(q -> cell);`);
    expect(only(lint(src), "free-then-use")).toHaveLength(1);
  });

  it("FREE していなければ出ない", () => {
    const src = MAIN(`  dcl q pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell set(q);
  q -> cell = 1;
  put list(q -> cell);`);
    expect(only(lint(src), "free-then-use")).toEqual([]);
  });
});

describe("規則ごとの上書き", () => {
  const src = MAIN("  i = 1;\n  put list(i);");

  it("off にすると出なくなる", () => {
    expect(lint(src, { rules: { "implicit-declaration": "off" } })).toEqual([]);
  });

  it("重さを変えられる", () => {
    const m = lint(src, { rules: { "implicit-declaration": "error" } });
    expect(m[0]?.severity).toBe("error");
  });
});

describe("構文が壊れている場合", () => {
  it("何も返さない（構文の誤りは実行時の診断が出す）", () => {
    expect(lint("p: proc options(main);\n  put list('x'\nend p;\n")).toEqual([]);
  });
});

describe("誤検出が無いこと", () => {
  it("ブラウザ版のサンプルには指摘が出ない", () => {
    for (const s of SAMPLES) {
      expect(lint(s.source).map((m) => `${s.name}: ${m.rule}`)).toEqual([]);
    }
  });

  it("examples/tests には指摘が出ない", () => {
    const dir = join(import.meta.dirname, "../examples/tests");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".pli"))) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(lint(src).map((m) => `${f}: ${m.rule} ${m.message}`)).toEqual([]);
    }
  });
});

describe("formatLint", () => {
  it("指摘が無ければそう言う", () => {
    expect(formatLint([], "x")).toContain("指摘はありません");
  });

  it("重さと規則 id を添える", () => {
    const text = formatLint(lint(MAIN("  call nowhere;")), "x");
    expect(text).toContain("ERR ");
    expect(text).toContain("[undefined-procedure]");
    expect(text).toContain("誤り 1");
  });
});

describe("dli-status-unchecked", () => {
  const PCB = `  dcl 1 pcb,
        2 dbname     char(8),
        2 seg_level  char(2),
        2 stat_code  char(2),
        2 proc_opt   char(4),
        2 reserved   fixed bin(31),
        2 seg_name   char(8),
        2 len_kfb    fixed bin(31),
        2 no_senseg  fixed bin(31),
        2 key_fb     char(9);`;
  const prog = (tail: string) => `p: proc options(main);
  dcl plitdli entry;
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl seg_io char(13);
${PCB}
  call plitdli(three, func, pcb, seg_io);
${tail}
end p;`;

  it("ステータスコードを一度も読まなければ指摘する", () => {
    const found = lint(prog("  put skip list(seg_io);")).filter(
      (m) => m.rule === "dli-status-unchecked",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("pcb.stat_code");
  });

  it("読んでいれば指摘しない", () => {
    const found = lint(
      prog("  if pcb.stat_code = '  ' then put skip list(seg_io);"),
    ).filter((m) => m.rule === "dli-status-unchecked");
    expect(found).toEqual([]);
  });

  it("PCB マスクの読まない項目を「代入したが読んでいない」とは言わない", () => {
    const found = lint(
      prog("  if pcb.stat_code = '  ' then put skip list(seg_io);"),
    ).filter((m) => m.rule === "assigned-but-never-read");
    expect(found).toEqual([]);
  });

  it("DL/I を呼んでいなければ何も言わない", () => {
    const src = `p: proc options(main);
${PCB}
  pcb.stat_code = '  ';
  put skip list(pcb.stat_code);
end p;`;
    const found = lint(src).filter((m) => m.rule === "dli-status-unchecked");
    expect(found).toEqual([]);
  });
});

/**
 * 誤検知の修正。
 *
 * Linter の誤検知は「切られる」ことに直結するので、
 * 直したものは出なくなったことと、本物は出続けることを対で固定する。
 */
describe("誤検知", () => {
  it("BASED の locator ポインタを「代入したが読んでいない」とは言わない", () => {
    const src = MAIN(`  dcl p pointer;
  dcl cell fixed bin(31) based(p);
  allocate cell set(p);
  cell = 5;
  put list(cell);`);
    expect(only(lint(src), "assigned-but-never-read")).toEqual([]);
    expect(only(lint(src), "unused-variable")).toEqual([]);
  });

  it("SET 無しの ALLOCATE でも宣言の based(p) を使ったとみなす", () => {
    const src = MAIN(`  dcl p pointer;
  dcl cell fixed bin(31) based(p);
  allocate cell;
  cell = 5;
  put list(cell);`);
    expect(only(lint(src), "assigned-but-never-read")).toEqual([]);
  });

  it("再 ALLOCATE したら free-then-use を出さない", () => {
    const src = MAIN(`  dcl p pointer;
  dcl cell fixed bin(31) based(p);
  allocate cell set(p);
  cell = 1;
  free p -> cell;
  allocate cell set(p);
  p -> cell = 2;
  put list(p -> cell);`);
    expect(only(lint(src), "free-then-use")).toEqual([]);
  });

  it("FREE したまま使えば free-then-use は出る", () => {
    const src = MAIN(`  dcl p pointer;
  dcl cell fixed bin(31) based(p);
  allocate cell set(p);
  cell = 1;
  free p -> cell;
  put list(p -> cell);`);
    expect(only(lint(src), "free-then-use")).toHaveLength(1);
  });

  it("endfile-without-on は OPEN では出さず、読む文で 1 回だけ出す", () => {
    const src = MAIN(`  dcl f file stream input;
  dcl x fixed bin(31);
  open file(f) input title('X');
  get file(f) list(x);
  put list(x);
  close file(f);`);
    const found = only(lint(src), "endfile-without-on");
    expect(found).toHaveLength(1);
    // OPEN は 3 行目、GET は 4 行目
    expect(found[0]?.line).toBe(5);
  });
});

describe("自己呼び出しだけの手続き", () => {
  it("呼ばれていないものとして報告する", () => {
    const src = MAIN(`  put list('hi');
  dead: proc;
    call dead;
  end dead;`);
    const found = only(lint(src), "unused-procedure");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/自分自身からしか/);
  });

  it("外から呼ばれていれば報告しない（再帰は正しい書き方）", () => {
    const src = MAIN(`  call rec(3);
  rec: proc(n);
    dcl n fixed bin(31);
    if n > 0 then call rec(n - 1);
  end rec;`);
    expect(only(lint(src), "unused-procedure")).toEqual([]);
  });
});

describe("未宣言の名前に括弧を付けて読んだとき", () => {
  it("知っている組込関数なら「未実装」と言う（「暗黙に宣言されます」では嘘になる）", () => {
    const found = only(lint(MAIN("  put list(sqrt(16));")), "implicit-declaration");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/未実装/);
  });

  it("知らない名前なら「未知の関数」と言う（綴り間違いと区別する）", () => {
    const found = only(
      lint(MAIN("  put list(nosuchname(16));")),
      "implicit-declaration",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/未知の関数/);
  });

  it("添字付きの代入は暗黙宣言のまま（実行時も動く）", () => {
    const found = only(lint(MAIN("  a(1) = 2;\n  put list(a(1));")), "implicit-declaration");
    expect(found[0]?.message).toMatch(/暗黙に/);
  });
});
