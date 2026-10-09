/**
 * BASED 記憶域とポインタ。
 *
 * 設計の前提: **アドレス値は持たない。** ポインタは確保した記憶域への
 * 参照であり、算術も型の違う再解釈もできない。その代わり、
 * NULL や解放済みをたどったら必ず止める（PL/I の規定では未定義動作）。
 */
import { describe, expect, it } from "vitest";
import { runProgram } from "../src/index.js";

const run = (body: string) => runProgram(`p: proc options(main);\n${body}\nend p;\n`);

/** 出力を前後の空白を落として取り出す。 */
function out(body: string): string {
  const r = run(body);
  if (r.diagnostics.length > 0) {
    throw new Error(r.diagnostics.map((d) => `${d.line}行: ${d.message}`).join(" / "));
  }
  return r.stdout.trim();
}

describe("ポインタの基本", () => {
  it("NULL() で初期化して比較できる", () => {
    expect(
      out(`  dcl q pointer;
  q = null();
  if q = null() then put list('null');`),
    ).toBe("null");
  });

  it("ADDR で取ったポインタ越しに書き込める", () => {
    expect(
      out(`  dcl n fixed bin(31);
  dcl q pointer;
  dcl alias fixed bin(31) based(q);
  n = 10;
  q = addr(n);
  alias = 42;
  put list(n);`),
    ).toBe("42");
  });

  it("ポインタはポインタとしか比較できない", () => {
    const r = run(`  dcl q pointer;
  q = null();
  if q = 0 then put list('x');`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("比較できません");
  });

  it("ポインタを数値として扱えない", () => {
    const r = run(`  dcl q pointer;
  dcl n fixed bin(31);
  q = null();
  n = q + 1;`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("ポインタ");
  });
});

describe("ALLOCATE と FREE", () => {
  it("確保して値を入れ、読み出せる", () => {
    expect(
      out(`  dcl q pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell set(q);
  cell = 7;
  put list(cell);`),
    ).toBe("7");
  });

  it("宣言の based(p) を使えば SET を省ける", () => {
    expect(
      out(`  dcl q pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell;
  cell = 3;
  put list(q -> cell);`),
    ).toBe("3");
  });

  it("構造体ごと確保できる", () => {
    expect(
      out(`  dcl q pointer;
  dcl 1 node based(q),
        2 value fixed bin(31),
        2 tag char(4);
  allocate node set(q);
  q -> node.value = 5;
  q -> node.tag = 'abcd';
  put list(q -> node.value, q -> node.tag);`).replace(/\s+/g, " "),
    ).toBe("5 abcd");
  });

  it("確保するたびに別の記憶域になる", () => {
    expect(
      out(`  dcl (p1, p2) pointer;
  dcl cell fixed bin(31) based(p1);
  allocate cell set(p1);
  cell = 1;
  allocate cell set(p2);
  p2 -> cell = 2;
  put list(p1 -> cell, p2 -> cell);`).replace(/\s+/g, " "),
    ).toBe("1 2");
  });

  it("FREE するとポインタは NULL になる", () => {
    expect(
      out(`  dcl q pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell set(q);
  cell = 1;
  free q -> cell;
  if q = null() then put list('解放済み');`),
    ).toBe("解放済み");
  });
});

describe("誤りを必ず検出する（PL/I の規定では未定義動作）", () => {
  it("NULL のポインタをたどったら止める", () => {
    const r = run(`  dcl q pointer;
  dcl cell fixed bin(31) based(q);
  q = null();
  put list(cell);`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("NULL");
  });

  it("解放済みの記憶域をたどったら止める", () => {
    const r = run(`  dcl (q, keep) pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell set(q);
  keep = q;
  free q -> cell;
  put list(keep -> cell);`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("解放済み");
  });

  it("二重の解放を止める", () => {
    const r = run(`  dcl (q, keep) pointer;
  dcl cell fixed bin(31) based(q);
  allocate cell set(q);
  keep = q;
  free q -> cell;
  free keep -> cell;`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("解放済み");
  });

  it("ポインタ指定のない BASED 参照は誤り", () => {
    const r = run(`  dcl cell fixed bin(31) based;
  cell = 1;`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("BASED");
  });

  it("BASED でないものは ALLOCATE できない", () => {
    const r = run(`  dcl n fixed bin(31);
  allocate n;`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("BASED");
  });
});

describe("連結リスト", () => {
  it("作って走査して合計する", () => {
    // 教材の定番。ポインタが実用になるかの試金石
    const src = `  dcl (head, cur, prev) pointer;
  dcl 1 node based(cur),
        2 value fixed bin(31),
        2 next pointer;
  dcl (i, total) fixed bin(31);

  head = null();
  prev = null();
  do i = 1 to 5;
    allocate node set(cur);
    cur -> node.value = i * 10;
    cur -> node.next = null();
    if head = null() then head = cur;
    else prev -> node.next = cur;
    prev = cur;
  end;

  total = 0;
  cur = head;
  do while(cur ^= null());
    total = total + cur -> node.value;
    cur = cur -> node.next;
  end;
  put list(total);`;
    expect(out(src)).toBe("150");
  });

  it("逆順に並べ替えられる", () => {
    const src = `  dcl (head, cur, nxt, prev) pointer;
  dcl 1 node based(cur),
        2 value fixed bin(31),
        2 next pointer;
  dcl i fixed bin(31);
  dcl line char(30) varying;

  head = null();
  do i = 1 to 3;
    allocate node set(cur);
    cur -> node.value = i;
    cur -> node.next = head;
    head = cur;
  end;

  line = '';
  cur = head;
  do while(cur ^= null());
    line = line || cur -> node.value;
    cur = cur -> node.next;
  end;
  put list(line);`;
    // 先頭に挿していくので 3,2,1 の順。FIXED BIN(31) の文字表現は幅 11
    expect(out(src).replace(/\s+/g, "")).toBe("321");
  });
});
