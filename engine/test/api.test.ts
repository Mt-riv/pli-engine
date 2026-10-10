import { describe, expect, it } from "vitest";
import { runProgram, VERSION } from "../src/index.js";

/**
 * 公開 API。ブラウザ版と VSCode Extension の両方がこれを使う。
 * どちらも「何行目で何が起きたか」を構造化された形で必要とする。
 */
describe("runProgram", () => {
  it("正常実行", () => {
    const r = runProgram("h: proc options(main); put list('HI'); end h;");
    expect(r.stdout).toBe("HI \n");
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("字句エラーは行と桁を持つ", () => {
    const r = runProgram("h: proc options(main);\n x = 'unterminated;\nend h;");
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: "error", phase: "lex", line: 2 });
    expect(r.diagnostics[0]?.col).toBeGreaterThan(0);
  });

  it("構文エラーは行と桁を持つ", () => {
    const r = runProgram("h: proc options(main);\n x = 1\nend h;");
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ phase: "parse" });
    expect(r.diagnostics[0]?.line).toBeGreaterThan(1);
  });

  it("プリプロセッサのエラー", () => {
    const r = runProgram("%declare x character;\nh: proc options(main); end h;");
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.phase).toBe("preprocess");
  });

  it("実行時エラーは行を持つ", () => {
    const r = runProgram(
      "h: proc options(main);\n dcl a fixed dec(3,0);\n a = 99999;\nend h;",
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ phase: "runtime" });
    expect(r.diagnostics[0]?.message).toContain("FIXEDOVERFLOW");
    expect(r.diagnostics[0]?.line).toBe(3);
  });

  it("実行時エラーでもそれまでの出力は残る", () => {
    const r = runProgram(
      "h: proc options(main);\n put skip list('before');\n dcl a fixed dec(3,0);\n a = 99999;\nend h;",
    );
    expect(r.stdout).toContain("before");
    expect(r.ok).toBe(false);
  });

  it("メッセージから行番号の接頭辞は取り除かれる", () => {
    const r = runProgram("h: proc options(main);\n x = 1\nend h;");
    // "2:7: ..." のような接頭辞は line/col に分離済みなので本文には含めない
    expect(r.diagnostics[0]?.message).not.toMatch(/^\d+:\d+:/);
  });

  it("引数を渡せる", () => {
    const r = runProgram(
      "m: proc(p) options(main); dcl p char(20) varying; put edit(p)(a); end m;",
      { args: ["abc"] },
    );
    expect(r.stdout).toBe("abc\n");
  });

  it("実行時間を返す", () => {
    const r = runProgram("h: proc options(main); put list('x'); end h;");
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("出力が大きい場合は打ち切る", () => {
    const src = `h: proc options(main);
  dcl i fixed bin(31);
  do i = 1 to 100000;
    put skip list('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  end;
end h;`;
    const r = runProgram(src, { maxOutputBytes: 4096 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(4096);
  });

  it("無限ループは文数の上限で止まる", () => {
    const r = runProgram("h: proc options(main); do while('1'b); end; end h;", {
      maxSteps: 10000,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/上限|step/i);
  });
});

/**
 * 誤りが手続きの中で起きたときの呼び出しの鎖。
 *
 * 誤りの行だけでは足りない場合がある。処理系が前置きを差し込む作り
 * （テストフレームワーク）では、誤りの行が利用者のソースのどこでもない
 * 場所を指すことがあり、そのときは呼び出し元から辿る必要がある。
 */
describe("呼び出し元の行", () => {
  it("手続きの中で起きた誤りは呼んだ側の行を持つ", () => {
    const r = runProgram(`m: proc options(main);
  call sub;
end m;
sub: proc;
  dcl a fixed dec(3,0);
  a = 99999;
end sub;
`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.line).toBe(6);
    expect(r.diagnostics[0]?.callerLines).toEqual([2]);
  });

  it("入れ子なら外側から内側の順に並ぶ", () => {
    const r = runProgram(`m: proc options(main);
  call a;
end m;
a: proc;
  call b;
end a;
b: proc;
  dcl n fixed dec(3,0);
  n = 99999;
end b;
`);
    expect(r.diagnostics[0]?.callerLines).toEqual([2, 5]);
  });

  it("主手続きの中で起きた誤りには入らない（呼んだ側が無い）", () => {
    const r = runProgram(
      "m: proc options(main);\n dcl a fixed dec(3,0);\n a = 99999;\nend m;",
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.callerLines).toBeUndefined();
  });

  it("文数の上限で止まったときも鎖を持つ", () => {
    const r = runProgram(
      "m: proc options(main);\n call loop;\nend m;\nloop: proc;\n do while('1'b); end;\nend loop;",
      { maxSteps: 10000 },
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.callerLines).toEqual([2]);
  });

  it("正常終了したプログラムには付かない", () => {
    const r = runProgram(
      "m: proc options(main);\n call sub;\nend m;\nsub: proc;\n put list('HI');\nend sub;",
    );
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });
});

describe("VERSION", () => {
  it("バージョン文字列を公開する", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
