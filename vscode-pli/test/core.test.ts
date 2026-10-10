import { describe, expect, it } from "vitest";
import {
  checkSyntax,
  looksLikeTestFile,
  runForEditor,
  runTestsForEditor,
  snippetCompletions,
  toEditorLint,
  toEditorDiagnostics,
} from "../src/core.js";
import { MemoryHost } from "../../engine/src/index.js";

const OK = `h: proc options(main);
  put list('HELLO');
end h;
`;

describe("checkSyntax", () => {
  it("正しいソースでは問題を出さない", () => {
    expect(checkSyntax(OK)).toEqual([]);
  });

  it("構文エラーを行・桁付きで返す", () => {
    const d = checkSyntax("h: proc options(main);\n  x = 1\nend h;\n");
    expect(d).toHaveLength(1);
    // VSCode は 0 始まりなので 3 行目は line=2
    expect(d[0]?.range.start.line).toBe(2);
    expect(d[0]?.severity).toBe("error");
    expect(d[0]?.source).toBe("pli");
  });

  it("字句エラーも拾う", () => {
    const d = checkSyntax("h: proc options(main);\n  x = 'abc\nend h;\n");
    expect(d).toHaveLength(1);
    expect(d[0]?.message).toContain("lex");
  });

  // 入力のたびに走らせるので、実行時エラーは検査の対象にしない。
  // （書きかけのコードで毎回エラーが出ると邪魔になる）
  it("実行時エラーは構文検査では報告しない", () => {
    const src = `h: proc options(main);
  dcl a fixed dec(3,0);
  a = 99999;
end h;
`;
    // FIXEDOVERFLOW は実行してはじめて分かるので構文検査では出ない。
    // Linter は別物なので、ここでは構文の指摘だけを見る
    const syntax = checkSyntax(src).filter((d) => d.source === "pli");
    expect(syntax).toEqual([]);
    expect(checkSyntax(src, { lint: false })).toEqual([]);
  });

  it("構文検査でプログラムを実行してしまわない", () => {
    // 無限ループを含んでも検査は即座に終わる
    const src = "h: proc options(main);\n do while('1'b);\n end;\nend h;\n";
    const t0 = Date.now();
    expect(checkSyntax(src)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("toEditorDiagnostics", () => {
  it("行・桁を 0 始まりに変換する", () => {
    const d = toEditorDiagnostics("a\nbb\nccc", [
      { severity: "error", phase: "parse", line: 2, col: 2, message: "だめ" },
    ]);
    expect(d[0]?.range.start).toEqual({ line: 1, character: 1 });
    expect(d[0]?.range.end).toEqual({ line: 1, character: 2 });
  });

  it("桁が無い場合は行の中身の範囲にする", () => {
    const d = toEditorDiagnostics("a\n   bbb\nc", [
      { severity: "error", phase: "runtime", line: 2, message: "だめ" },
    ]);
    // 行頭の空白を除いた位置から行末まで
    expect(d[0]?.range.start.character).toBe(3);
    expect(d[0]?.range.end.character).toBe(6);
  });

  it("空行でも幅を 1 以上にする", () => {
    const d = toEditorDiagnostics("a\n\nc", [
      { severity: "error", phase: "runtime", line: 2, message: "だめ" },
    ]);
    expect(d[0]?.range.end.character).toBeGreaterThan(d[0]!.range.start.character);
  });

  it("行番号が範囲外でも落ちない", () => {
    const d = toEditorDiagnostics("a", [
      { severity: "error", phase: "runtime", line: 999, message: "だめ" },
    ]);
    expect(d[0]?.range.start.line).toBe(0);
  });

  it("メッセージに段階を添える", () => {
    const d = toEditorDiagnostics("a", [
      { severity: "error", phase: "parse", line: 1, col: 1, message: "だめ" },
    ]);
    expect(d[0]?.message).toBe("だめ (parse)");
  });
});

describe("runForEditor", () => {
  it("出力とファイル名を含む本文を作る", () => {
    const o = runForEditor(OK, "/tmp/a.pli");
    expect(o.report).toContain("--- /tmp/a.pli ---");
    expect(o.report).toContain("HELLO");
    expect(o.report).toContain("成功");
    expect(o.diagnostics).toEqual([]);
  });

  it("出力が無い場合はその旨を示す", () => {
    const o = runForEditor("h: proc options(main); end h;", "a.pli");
    expect(o.report).toContain("(出力なし)");
  });

  it("実行時エラーを本文と診断の両方に出す", () => {
    const src = `h: proc options(main);
  put skip list('before');
  dcl a fixed dec(3,0);
  a = 99999;
end h;
`;
    const o = runForEditor(src, "a.pli");
    expect(o.report).toContain("before");
    expect(o.report).toContain("FIXEDOVERFLOW");
    expect(o.report).toContain("失敗");
    expect(o.diagnostics).toHaveLength(1);
    expect(o.diagnostics[0]?.range.start.line).toBe(3);
  });

  it("引数を渡せる", () => {
    const src = `m: proc(p) options(main);
  dcl p char(20) varying;
  put edit(p)(a);
end m;
`;
    expect(runForEditor(src, "a.pli", { args: ["abc"] }).report).toContain("abc");
  });

  it("無限ループは上限で止まる", () => {
    const o = runForEditor("h: proc options(main); do while('1'b); end; end h;", "a.pli", {
      maxSteps: 10_000,
    });
    expect(o.result.ok).toBe(false);
    expect(o.report).toMatch(/上限/);
  });

  it("出力上限を超えたら打ち切りを示す", () => {
    const src = `h: proc options(main);
  dcl i fixed bin(31);
  do i = 1 to 100000;
    put skip list('xxxxxxxxxxxxxxxxxxxxxx');
  end;
end h;
`;
    const o = runForEditor(src, "a.pli", { maxOutputBytes: 2048 });
    expect(o.report).toContain("出力打ち切り");
  });
});

const TESTS = `TEST_OK: proc;
  call ASSERT_EQUALS(4, 2 + 2, '足し算');
end TEST_OK;

TEST_NG: proc;
  put skip list('テストの中の出力');
  call ASSERT_EQUALS(5, 2 + 2, 'わざと間違える');
end TEST_NG;
`;

describe("looksLikeTestFile", () => {
  it("名前の規約で判定する", () => {
    expect(looksLikeTestFile("/w/math_test.pli", "")).toBe(true);
    expect(looksLikeTestFile("/w/test_math.pli", "")).toBe(true);
    expect(looksLikeTestFile("/w/math.test.pli", "")).toBe(true);
    expect(looksLikeTestFile("/w/math.pli", "")).toBe(false);
  });

  it("名前が規約外でも TEST_ 手続きだけならテストとみなす", () => {
    expect(looksLikeTestFile("/w/scratch.pli", TESTS)).toBe(true);
  });

  it("主手続きがあればテストとみなさない", () => {
    expect(looksLikeTestFile("/w/scratch.pli", OK)).toBe(false);
  });

  it("名前が規約に合えば主手続きの有無を見ない", () => {
    // 規約に合わせて置いた名前は利用者の意図とみなす
    expect(looksLikeTestFile("/w/a_test.pli", OK)).toBe(true);
  });
});

describe("runTestsForEditor", () => {
  it("成功と失敗を数えて報告にする", () => {
    const o = runTestsForEditor(TESTS, "a_test.pli");
    expect(o.report.total).toBe(2);
    expect(o.report.passed).toBe(1);
    expect(o.report.failures).toBe(1);
    expect(o.report.ok).toBe(false);
    expect(o.text).toContain("OK   TEST_OK");
    expect(o.text).toContain("FAIL TEST_NG");
    expect(o.text).toContain("わざと間違える");
  });

  it("失敗したテストの出力だけを添える", () => {
    const o = runTestsForEditor(TESTS, "a_test.pli");
    expect(o.text).toContain("TEST_NG の出力");
    expect(o.text).toContain("テストの中の出力");
    expect(o.text).not.toContain("TEST_OK の出力");
  });

  it("テストが無ければ注記を出す", () => {
    const o = runTestsForEditor(OK, "a.pli");
    expect(o.report.total).toBe(0);
    expect(o.text).toContain("テストが見つかりません");
  });

  it("報告に失敗した行を出す", () => {
    // TESTS の 7 行目が失敗する表明
    expect(runTestsForEditor(TESTS, "a_test.pli").text).toContain("失敗 (7 行)");
  });

  it("失敗した行に印を付ける", () => {
    const o = runTestsForEditor(TESTS, "a_test.pli");
    expect(o.diagnostics).toHaveLength(1);
    // VSCode は 0 始まりなので 7 行目は line=6
    expect(o.diagnostics[0]?.range.start.line).toBe(6);
    expect(o.diagnostics[0]?.source).toBe("pli-test");
    expect(o.diagnostics[0]?.message).toContain("TEST_NG");
    expect(o.diagnostics[0]?.message).toContain("わざと間違える");
  });

  it("成功だけなら印を付けない", () => {
    const o = runTestsForEditor(
      "TEST_OK: proc;\n  call ASSERT_EQUALS(4, 2 + 2, '足し算');\nend TEST_OK;\n",
      "a_test.pli",
    );
    expect(o.report.ok).toBe(true);
    expect(o.diagnostics).toEqual([]);
  });

  it("異常で終わったテストにも印を付ける", () => {
    const o = runTestsForEditor(
      "TEST_E: proc;\n  dcl a fixed dec(3,0);\n  a = 99999;\nend TEST_E;\n",
      "a_test.pli",
    );
    expect(o.report.errors).toBe(1);
    expect(o.diagnostics[0]?.range.start.line).toBe(2);
  });
});

describe("snippetCompletions", () => {
  it("Snippet と同数で、入力語を label にする", () => {
    const items = snippetCompletions();
    expect(items.length).toBeGreaterThanOrEqual(28);
    expect(items.map((i) => i.label)).toContain("main");
    expect(items.map((i) => i.label)).toContain("test");
  });

  it("本文は VSCode の Snippet 記法をそのまま渡す", () => {
    const main = snippetCompletions().find((i) => i.label === "main");
    expect(main?.body).toContain("${1:prog}");
    expect(main?.detail).toBe("主手続き");
  });

  it("label が重複しない（同じ語で複数展開されない）", () => {
    const labels = snippetCompletions().map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("checkSyntax と Linter", () => {
  const SLOPPY = `p: proc options(main);
  dcl unused char(10);
  i = 1;
  put list(i);
end p;
`;

  it("既定では Linter の指摘も返す", () => {
    const d = checkSyntax(SLOPPY);
    const rules = d.map((x) => x.code);
    expect(rules).toContain("unused-variable");
    expect(rules).toContain("implicit-declaration");
    expect(d.every((x) => x.severity === "warning")).toBe(true);
    expect(d.every((x) => x.source === "pli-lint")).toBe(true);
  });

  it("lint:false なら構文だけを見る", () => {
    expect(checkSyntax(SLOPPY, { lint: false })).toEqual([]);
  });

  it("規則ごとに切れる", () => {
    const d = checkSyntax(SLOPPY, {
      lintOptions: { rules: { "unused-variable": "off", "implicit-declaration": "off" } },
    });
    expect(d).toEqual([]);
  });

  it("構文が壊れている間は Linter を動かさない（指摘がちらつかない）", () => {
    const broken = `p: proc options(main);
  dcl unused char(10);
  put list('x'
end p;
`;
    const d = checkSyntax(broken);
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe("error");
    expect(d[0]?.source).toBe("pli");
  });

  it("toEditorLint は桁が分かる指摘をその位置から示す", () => {
    const src = "p: proc options(main);\n  if ^(1 > 0) then put list('x');\nend p;\n";
    const d = toEditorLint(src, [
      { rule: "not-operator", severity: "warning", message: "x", line: 2, col: 6 },
    ]);
    expect(d[0]?.range.start).toEqual({ line: 1, character: 5 });
  });
});

describe("DL/I の受け渡し", () => {
  const DBD = `         DBD  NAME=M,ACCESS=HDAM
         SEGM NAME=C,PARENT=0,BYTES=6
         FIELD NAME=(K,SEQ,U),BYTES=2,START=1,TYPE=C
         DBDGEN
         END
`;
  const PSB = `         PCB  TYPE=DB,DBDNAME=M,PROCOPT=A,KEYLEN=2
         SENSEG NAME=C,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=P
         END
`;
  const SRC = `p: proc options(main);
  dcl plitdli entry;
  dcl three fixed bin(31) init(3);
  dcl func char(4) init('GN  ');
  dcl seg_io char(6);
  dcl 1 pcb,
        2 dbname     char(8),
        2 seg_level  char(2),
        2 stat_code  char(2),
        2 proc_opt   char(4),
        2 reserved   fixed bin(31),
        2 seg_name   char(8),
        2 len_kfb    fixed bin(31),
        2 no_senseg  fixed bin(31),
        2 key_fb     char(2);
  call plitdli(three, func, pcb, seg_io);
  put skip edit(pcb.stat_code, seg_io)(a, a);
end p;`;

  const host = () =>
    new MemoryHost({ "M.dbd": DBD, "P.psb": PSB, "M.dat": "C       01ABCD\n" });

  it("psb を渡すと DL/I が動く", () => {
    const outcome = runForEditor(SRC, "t.pli", { host: host(), psb: "P" });
    expect(outcome.result.diagnostics).toEqual([]);
    expect(outcome.result.stdout).toContain("01ABCD");
  });

  it("psb が空なら DL/I は動かず、PSB が無いと言う", () => {
    const outcome = runForEditor(SRC, "t.pli", { host: host(), psb: "" });
    expect(outcome.result.diagnostics[0]?.message).toContain("PSB");
  });
});

/**
 * `%INCLUDE` 先の誤りの帰属。
 *
 * 取り込み先の行番号を本体にそのまま当てると、無関係な行に赤線が出る。
 * 「診断が嘘になる」のを防ぐために `%INCLUDE` の行へまとめる。
 */
describe("取り込み先の診断", () => {
  const source = [
    "m: proc options(main);",
    "  %include decls;",
    "  put list(x);",
    "end m;",
  ].join("\n");

  it("%INCLUDE の行に出し、ファイル名と元の行を添える", () => {
    const diags = toEditorDiagnostics(source, [
      {
        severity: "error",
        phase: "parse",
        line: 4,
        col: 5,
        file: "decls.inc",
        message: "セミコロン が必要です",
      },
    ]);
    expect(diags).toHaveLength(1);
    // 本体の 4 行目（end m;）ではなく 2 行目（%include）
    expect(diags[0]?.range.start.line).toBe(1);
    expect(diags[0]?.message).toContain("decls.inc 4行5桁");
  });

  it("本体の誤りはその行のまま", () => {
    const diags = toEditorDiagnostics(source, [
      { severity: "error", phase: "parse", line: 3, col: 3, message: "誤り" },
    ]);
    expect(diags[0]?.range.start.line).toBe(2);
    expect(diags[0]?.message).not.toContain("行");
  });
});
