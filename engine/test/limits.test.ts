/**
 * 実行を止めるための上限と、上限に達したときの報告。
 *
 * ブラウザには別プロセスが無いので、ここが唯一の守りになる。
 * 「上限に達したのに成功と報告する」のが一番たちが悪いため、
 * 止まったことが `ok: false` と診断に出ることまで固定する。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost, runProgram } from "../src/index.js";

const MAIN = (body: string) => `m: proc options(main);\n${body}\nend m;`;

describe("出力の上限", () => {
  it("PUT で打ち切ったら成功ではない", () => {
    const r = runProgram(
      MAIN(`  dcl i fixed bin(31);
  do i = 1 to 100000;
    put skip list('0123456789');
  end;`),
      { maxOutputBytes: 1000 },
    );
    expect(r.truncated).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => d.message)).toContain(
      "出力が上限に達したため中断しました",
    );
  });

  it("WRITE も上限で止まる（PUT だけ数えると際限なく伸ばせる）", () => {
    const host = new MemoryHost();
    const r = runProgram(
      MAIN(`  dcl f file record output env(f recsize(100));
  dcl rec char(100);
  dcl i fixed bin(31);
  rec = repeat('X', 99);
  open file(f) output title('BIG');
  do i = 1 to 100000;
    write file(f) from(rec);
  end;
  close file(f);`),
      { maxOutputBytes: 1000, host },
    );
    expect(r.ok).toBe(false);
    // 上限の 1000 文字をいくらか超えたところで止まる。
    // 100000 件（1010000 文字）までは伸びない
    expect((host.get("BIG") ?? "").length).toBeLessThan(5000);
  });

  it("打ち切りの診断は止まった行を指す", () => {
    const r = runProgram(
      MAIN(`  dcl i fixed bin(31);
  do i = 1 to 100000;
    put skip list('0123456789');
  end;`),
      { maxOutputBytes: 100 },
    );
    expect(r.diagnostics[0]?.line).toBe(4);
  });
});

describe("文数の上限", () => {
  it("止まった行を指す（1 行目を指すと無限ループの場所が分からない）", () => {
    const r = runProgram(
      MAIN(`  dcl i fixed bin(31);
  i = 0;
  do while('1'b); i = i + 1; end;`),
      { maxSteps: 1000 },
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.line).toBe(4);
  });
});

describe("記憶域の上限", () => {
  it("大きすぎる配列の宣言は 1 文で止める（maxSteps では止まらない）", () => {
    const r = runProgram(MAIN("  dcl a(200000000) fixed bin(31);"), {
      maxSteps: 1_000_000,
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/要素数/);
  });

  it("上限は指定できる", () => {
    expect(runProgram(MAIN("  dcl a(500) fixed bin(31);"), {
      maxStorageCells: 1000,
    }).ok).toBe(true);
    expect(runProgram(MAIN("  dcl a(2000) fixed bin(31);"), {
      maxStorageCells: 1000,
    }).ok).toBe(false);
  });

  it("REPEAT の結果長も上限で止める", () => {
    const r = runProgram(
      MAIN(`  dcl s char(100) varying;
  s = repeat('A', 100000000);`),
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/文字列の長さ/);
  });

  it("ALLOCATE の回数も上限で止める", () => {
    const r = runProgram(
      MAIN(`  dcl p pointer;
  dcl cell fixed bin(31) based(p);
  dcl i fixed bin(31);
  do i = 1 to 100000;
    allocate cell set(p);
  end;`),
      { maxAllocations: 100 },
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/ALLOCATE の回数/);
  });
});

describe("CHAR VARYING の最大長", () => {
  it("宣言の最大長で切る", () => {
    const r = runProgram(
      MAIN(`  dcl t char(5) varying;
  t = 'abcdefgh';
  put list(length(t), '[' || t || ']');`),
    );
    expect(r.ok).toBe(true);
    expect(r.stdout.replace(/\s+/g, "")).toBe("5[abcde]");
  });

  it("連結の結果も最大長で切る", () => {
    const r = runProgram(
      MAIN(`  dcl t char(4) varying;
  t = 'ab';
  t = t || 'cdef';
  put list(length(t));`),
    );
    expect(r.stdout.replace(/\s+/g, "")).toBe("4");
  });
});

describe("長い値を診断に載せるとき", () => {
  it("メッセージを切る（全文を載せるとログが埋まる）", () => {
    const r = runProgram(
      MAIN(`  dcl s char(100010) varying;
  dcl n fixed dec(15);
  s = repeat('9', 100000) || 'x';
  n = s;`),
    );
    expect(r.ok).toBe(false);
    const msg = r.diagnostics[0]?.message ?? "";
    expect(msg.length).toBeLessThan(200);
    expect(msg).toMatch(/100002 文字/);
  });
});
