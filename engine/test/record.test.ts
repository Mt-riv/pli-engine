/**
 * レコード入出力。
 *
 * 仮想ファイルは文字列なので、文字として表現できる項目だけを扱う。
 * 本来のレコードは記憶域そのもの（packed decimal など）が入るので、
 * そこは再現しない。扱えない項目は誤りとして知らせる。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost, runProgram } from "../src/index.js";

describe("READ / WRITE", () => {
  it("固定長レコードを読む", () => {
    const host = new MemoryHost({ "IN.TXT": "ALICE     030\nBOB       025\n" });
    const src = `p: proc options(main);
  dcl inp file record input env(f recsize(13));
  dcl 1 rec,
        2 name char(10),
        2 age  pic'999';
  dcl done bit(1);
  done = '0'b;
  on endfile(inp) done = '1'b;
  open file(inp) input title('IN.TXT');
  do while('1'b);
    read file(inp) into(rec);
    if done then leave;
    put skip list(rec.name, rec.age);
  end;
  close file(inp);
end p;
`;
    const r = runProgram(src, { host });
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toContain("ALICE");
    expect(r.stdout).toContain("030");
    expect(r.stdout).toContain("BOB");
  });

  it("レコードを書き出す", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl out file record output env(f recsize(13));
  dcl 1 rec,
        2 name char(10),
        2 age  pic'999';
  open file(out) output title('OUT.TXT');
  rec.name = 'CAROL';
  rec.age = 41;
  write file(out) from(rec);
  rec.name = 'DAVE';
  rec.age = 7;
  write file(out) from(rec);
  close file(out);
  put list('done');
end p;
`;
    const r = runProgram(src, { host });
    expect(r.diagnostics).toEqual([]);
    expect(host.get("OUT.TXT")).toBe("CAROL     041\nDAVE      007\n");
  });

  it("読んだものをそのまま書き写せる", () => {
    const host = new MemoryHost({ "A.TXT": "one  \ntwo  \n" });
    const src = `p: proc options(main);
  dcl inp file record input env(f recsize(5));
  dcl outp file record output env(f recsize(5));
  dcl line char(5);
  dcl done bit(1);
  done = '0'b;
  on endfile(inp) done = '1'b;
  open file(inp) input title('A.TXT'), file(outp) output title('B.TXT');
  do while('1'b);
    read file(inp) into(line);
    if done then leave;
    write file(outp) from(line);
  end;
  close file(inp), file(outp);
end p;
`;
    const r = runProgram(src, { host });
    expect(r.diagnostics).toEqual([]);
    expect(host.get("B.TXT")).toBe("one  \ntwo  \n");
  });

  it("短いレコードは固定長に合わせて空白で埋める", () => {
    const host = new MemoryHost({ "S.TXT": "ab\ncdef\n" });
    const src = `p: proc options(main);
  dcl inp file record input env(f recsize(4));
  dcl line char(4);
  dcl done bit(1);
  done = '0'b;
  on endfile(inp) done = '1'b;
  open file(inp) input title('S.TXT');
  read file(inp) into(line);
  put list('[' || line || ']');
  close file(inp);
end p;
`;
    expect(runProgram(src, { host }).stdout.trim()).toBe("[ab  ]");
  });

  it("終わりまで読むと ENDFILE", () => {
    const host = new MemoryHost({ "E.TXT": "x\n" });
    const src = `p: proc options(main);
  dcl inp file record input env(f recsize(1));
  dcl line char(1);
  on endfile(inp) put list('終わり');
  open file(inp) input title('E.TXT');
  read file(inp) into(line);
  read file(inp) into(line);
end p;
`;
    expect(runProgram(src, { host }).stdout).toContain("終わり");
  });
});

describe("REWRITE", () => {
  it("直前に読んだレコードを置き換える", () => {
    const host = new MemoryHost({ "U.TXT": "aaa\nbbb\n" });
    const src = `p: proc options(main);
  dcl f file record update env(f recsize(3));
  dcl line char(3);
  open file(f) update title('U.TXT');
  read file(f) into(line);
  line = 'xxx';
  rewrite file(f) from(line);
  close file(f);
end p;
`;
    const r = runProgram(src, { host });
    expect(r.diagnostics).toEqual([]);
    expect(host.get("U.TXT")).toBe("xxx\nbbb\n");
  });

  it("READ の前の REWRITE は誤り", () => {
    const host = new MemoryHost({ "U.TXT": "aaa\n" });
    const src = `p: proc options(main);
  dcl f file record update env(f recsize(3));
  dcl line char(3);
  open file(f) update title('U.TXT');
  line = 'xxx';
  rewrite file(f) from(line);
end p;
`;
    expect(runProgram(src, { host }).diagnostics[0]?.message).toContain("READ が必要");
  });
});

describe("READ SET", () => {
  it("読んだレコードをポインタ越しに見る", () => {
    const host = new MemoryHost({ "R.TXT": "hello\n" });
    const src = `p: proc options(main);
  dcl f file record input env(f recsize(5));
  dcl q pointer;
  dcl buf char(5) based(q);
  on endfile(f) ;
  open file(f) input title('R.TXT');
  read file(f) set(q);
  put list(q -> buf);
  close file(f);
end p;
`;
    expect(runProgram(src, { host }).stdout.trim()).toBe("hello");
  });
});

describe("扱えないものは誤りとして知らせる", () => {
  it("数値項目のレコードは断る（文字か PICTURE にする）", () => {
    const host = new MemoryHost({ "N.TXT": "12345\n" });
    const src = `p: proc options(main);
  dcl f file record input env(f recsize(5));
  dcl 1 rec,
        2 n fixed bin(31),
        2 s char(1);
  on endfile(f) ;
  open file(f) input title('N.TXT');
  read file(f) into(rec);
end p;
`;
    const r = runProgram(src, { host });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("PICTURE");
  });

  it("STREAM のファイルに READ は使えない", () => {
    const host = new MemoryHost({ "T.TXT": "x\n" });
    const src = `p: proc options(main);
  dcl f file stream input;
  dcl line char(1);
  open file(f) input title('T.TXT');
  read file(f) into(line);
end p;
`;
    const r = runProgram(src, { host });
    expect(r.diagnostics[0]?.message).toContain("STREAM");
  });

  it("索引ファイルの KEY 指定は未実装と知らせる", () => {
    const r = runProgram(`p: proc options(main);
  dcl f file record input;
  dcl line char(1);
  read file(f) into(line) key('a');
end p;
`);
    expect(r.diagnostics[0]?.message).toContain("未実装");
  });
});

/**
 * レコードの切り方。**実機（Iron Spring PL/I 1.4.1）で確かめた。**
 *
 * 実機は改行を区切りと見ない。`F RECSIZE(n)` のファイルを n バイトずつ切り、
 * 改行もデータの 1 バイトになる:
 *
 *   "abcdefgh"   RECSIZE(4) → "abcd" / "efgh"
 *   "ab\ncdef\n" RECSIZE(4) → "ab\nc" / "def\n"
 *   "abcd\nefgh\n" RECSIZE(5) → "abcd\n" / "efgh\n"
 *
 * この処理系は**行指向のテキスト**として扱う方を選んでいる（理由は
 * engine/README の「レコード入出力」。ブラウザのテキスト欄で打ち込んで
 * 編集するものなので、改行をデータにすると利用者の意図と食い違う）。
 *
 * ただし **RECSIZE より長い行は切り捨てず、RECSIZE ごとに切る**。
 * 切り捨てると残りが黙って消える。改行の無いファイルではこれで実機と一致する。
 */
describe("長い行とレコードの切り方", () => {
  const read3 = (contents: string, size: number): string => {
    const host = new MemoryHost({ "R.DAT": contents });
    const src = `p: proc options(main);
  dcl inp file record input env(f recsize(${size}));
  dcl line char(${size});
  dcl i fixed bin(15);
  on endfile(inp) put skip list('終わり');
  open file(inp) input title('R.DAT');
  do i = 1 to 3;
    read file(inp) into(line);
    put skip list('[' || line || ']');
  end;
end p;
`;
    return runProgram(src, { host }).stdout;
  };

  it("改行が無ければ RECSIZE ごとに切る（実機と一致）", () => {
    const out = read3("abcdefgh", 4);
    expect(out).toContain("[abcd]");
    expect(out).toContain("[efgh]");
    expect(out).toContain("終わり");
  });

  it("RECSIZE より長い行の残りは次のレコードになる（黙って捨てない）", () => {
    const out = read3("abcdefg\n", 4);
    expect(out).toContain("[abcd]");
    // 残り 3 文字は空白で埋める
    expect(out).toContain("[efg ]");
  });

  it("改行があればそれが区切り（行指向。ここは実機と違う）", () => {
    const out = read3("ab\ncdef\n", 4);
    // 実機は "ab\nc" を 1 件目にする。この処理系は行を 1 レコードと見る
    expect(out).toContain("[ab  ]");
    expect(out).toContain("[cdef]");
  });
});
