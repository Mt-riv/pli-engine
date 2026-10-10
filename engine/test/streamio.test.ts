/**
 * ストリーム入出力。
 *
 * 入力（SYSIN と名前付きファイル）、出力（SYSPRINT と名前付きファイル）、
 * OPEN / CLOSE、ENDFILE 条件を見る。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost, runProgram } from "../src/index.js";
import { InputCursor } from "../src/streamio.js";

/**
 * 標準出力を取り出す。
 * PUT LIST は数値を右詰めするので、前後の空白は落として比べる。
 */
function out(source: string, opts: Parameters<typeof runProgram>[1] = {}): string {
  const r = runProgram(source, opts);
  if (r.diagnostics.length > 0) {
    throw new Error(`診断: ${r.diagnostics.map((d) => d.message).join(" / ")}`);
  }
  return r.stdout.trim();
}

describe("InputCursor", () => {
  it("空白とカンマで項目を切る", () => {
    const c = new InputCursor("1 2,3  4\n5");
    expect([c.nextItem(), c.nextItem(), c.nextItem(), c.nextItem(), c.nextItem()]).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(c.nextItem()).toBeUndefined();
  });

  it("引用符の中は 1 項目。'' は ' 1 個になる", () => {
    const c = new InputCursor("'a b' 'it''s'");
    expect(c.nextItem()).toBe("a b");
    expect(c.nextItem()).toBe("it's");
  });

  it("空白だけなら終わり", () => {
    const c = new InputCursor("   \n  ");
    expect(c.nextItem()).toBeUndefined();
    expect(c.atEnd()).toBe(true);
  });

  it("桁で切り出す。足りなければ空白で埋める", () => {
    const c = new InputCursor("abcde");
    expect(c.take(3)).toBe("abc");
    expect(c.take(5)).toBe("de   ");
  });

  it("行を送る", () => {
    const c = new InputCursor("one\ntwo\nthree");
    c.skipLine();
    expect(c.restOfLine()).toBe("two");
    c.skipLine();
    expect(c.restOfLine()).toBe("three");
  });

  it("桁位置へ送る", () => {
    const c = new InputCursor("abcdefgh");
    c.columnTo(4);
    expect(c.take(2)).toBe("de");
  });
});

describe("SYSIN からの入力", () => {
  it("GET LIST でまとめて読む", () => {
    // 最後の項目を読んだ GET で ENDFILE が上がるので
    // ON 単位を置く。置かないと ERROR へ連鎖して終わる
    const src = `p: proc options(main);
  dcl (a, b, c) fixed bin(31);
  on endfile(sysin) ;
  get list(a, b, c);
  put list(a + b + c);
end p;
`;
    expect(out(src, { stdin: "10 20 30\n" })).toBe("60");
  });

  it("最後の項目を読んだ GET で ENDFILE が上がる（代入は済んでいる）", () => {
    // PL/I の規定の挙動
    const src = `p: proc options(main);
  dcl (v, n) fixed bin(31);
  dcl done bit(1);
  n = 0;
  done = '0'b;
  on endfile(sysin) done = '1'b;
  do while(^done);
    get list(v);
    if ^done then n = n + 1;
  end;
  put list(n);
end p;
`;
    // 1 2 3 4 の 4 件目は ENDFILE と同時なので数えられない
    expect(out(src, { stdin: "1 2 3 4\n" })).toBe("3");
    // 末尾に空行があれば 4 件とも数えられる
    expect(out(src, { stdin: "1 2 3 4\n\n" })).toBe("4");
  });

  it("GET（LIST 省略なし）でファイル指定を省くと SYSIN", () => {
    const src = `p: proc options(main);
  dcl name char(10) varying;
  on endfile(sysin) ;
  get list(name);
  put list('hello ' || name);
end p;
`;
    expect(out(src, { stdin: "'world'\n" })).toBe("hello world");
  });

  it("行をまたいで読む", () => {
    const src = `p: proc options(main);
  dcl (a, b) fixed bin(31);
  on endfile(sysin) ;
  get list(a);
  get list(b);
  put list(a * b);
end p;
`;
    expect(out(src, { stdin: "6\n7\n" })).toBe("42");
  });

  it("GET SKIP で行を送る", () => {
    const src = `p: proc options(main);
  dcl v fixed bin(31);
  on endfile(sysin) ;
  get skip list(v);
  put list(v);
end p;
`;
    expect(out(src, { stdin: "999\n123\n" })).toBe("123");
  });

  it("GET EDIT は桁で切り出す", () => {
    const src = `p: proc options(main);
  dcl (a, b) fixed bin(31);
  on endfile(sysin) ;
  get edit(a, b)(f(3), f(3));
  put list(a, b);
end p;
`;
    expect(out(src, { stdin: "123456" }).split(/\s+/).filter(Boolean)).toEqual(["123", "456"]);
  });

  it("ホストの stdin も使える", () => {
    const src =
      "p: proc options(main);\n  dcl v fixed bin(31);\n  on endfile(sysin) ;\n" +
      "  get list(v);\n  put list(v);\nend p;\n";
    expect(out(src, { host: new MemoryHost({}, "7\n") })).toBe("7");
  });
});

describe("ENDFILE 条件", () => {
  it("ON ENDFILE で読み終わりを扱える", () => {
    const src = `p: proc options(main);
  dcl v fixed bin(31);
  dcl total fixed bin(31);
  dcl done bit(1);
  total = 0;
  done = '0'b;
  on endfile(sysin) done = '1'b;
  do while(^done);
    get list(v);
    if ^done then total = total + v;
  end;
  put list(total);
end p;
`;
    // 4 件目は ENDFILE と同時に読まれるので足されない（6 になる）。
    // 末尾に空行を置けば 4 件とも足される
    expect(out(src, { stdin: "1 2 3 4\n" })).toBe("6");
    expect(out(src, { stdin: "1 2 3 4\n\n" })).toBe("10");
  });

  it("ON ENDFILE が無ければ ERROR へ連鎖して終わる", () => {
    const src = `p: proc options(main);
  dcl v fixed bin(31);
  put list('start');
  get list(v);
  put list('ここには来ない');
end p;
`;
    const r = runProgram(src, { stdin: "" });
    expect(r.ok).toBe(false);
    expect(r.stdout).toContain("start");
    expect(r.stdout).not.toContain("ここには来ない");
    expect(r.diagnostics[0]?.message).toContain("ENDFILE");
  });

  it("ファイルごとに ON ENDFILE を分けられる", () => {
    const host = new MemoryHost({ "A.TXT": "1\n", "B.TXT": "2\n" });
    const src = `p: proc options(main);
  dcl (x, y) fixed bin(31);
  dcl which char(10) varying;
  dcl inа file stream input;
  on endfile(a) which = 'a';
  on endfile(b) which = 'b';
  get file(a) list(x);
  get file(b) list(y);
  put list(x + y);
end p;
`.replace("inа", "ina"); // 全角混入よけ
    const r = runProgram(src, { host });
    expect(r.diagnostics).toEqual([]);
  });
});

describe("名前付きファイル", () => {
  it("ファイルから読む", () => {
    const host = new MemoryHost({ "DATA.TXT": "5 6 7\n" });
    const src = `p: proc options(main);
  dcl (a, b, c) fixed bin(31);
  dcl data file stream input;
  on endfile(data) ;
  get file(data) list(a, b, c);
  put list(a + b + c);
end p;
`;
    expect(out(src, { host })).toBe("18");
  });

  it("TITLE で実際の名前を指定できる", () => {
    const host = new MemoryHost({ "REAL.TXT": "42\n" });
    const src = `p: proc options(main);
  dcl v fixed bin(31);
  dcl f file stream input;
  on endfile(f) ;
  open file(f) input title('REAL.TXT');
  get file(f) list(v);
  put list(v);
end p;
`;
    expect(out(src, { host })).toBe("42");
  });

  it("ファイルへ書き出し、閉じるとホストに残る", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl rep file stream output;
  open file(rep) output;
  put file(rep) list('line one');
  put file(rep) skip list('line two');
  close file(rep);
  put list('done');
end p;
`;
    expect(out(src, { host })).toBe("done");
    expect(host.get("rep")).toContain("'line one'");
    expect(host.get("rep")).toContain("'line two'");
  });

  it("閉じ忘れてもプログラム終了時に書き戻す", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl rep file stream output;
  put file(rep) list('forgot to close');
end p;
`;
    runProgram(src, { host });
    expect(host.get("rep")).toContain("'forgot to close'");
  });

  it("PRINT でない出力は 24 桁のタブストップを使わない", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl f file stream output;
  put file(f) list('a', 'b', 'c');
end p;
`;
    runProgram(src, { host });
    // 非 PRINT の LIST 出力は各項目を引用符で囲む
    expect(host.get("f")?.trimEnd()).toBe("'a'  'b'  'c'");
  });

  it("PRINT を指定するとタブストップで桁が揃う", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl f file stream output print;
  put file(f) list('a', 'b');
end p;
`;
    runProgram(src, { host });
    // 2 項目目は 25 桁目から
    expect(host.get("f")?.indexOf("b")).toBe(24);
  });

  it("無いファイルを読もうとすると UNDEFINEDFILE", () => {
    const src = `p: proc options(main);
  dcl v fixed bin(31);
  dcl nope file stream input;
  get file(nope) list(v);
end p;
`;
    const r = runProgram(src, { host: new MemoryHost() });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain("UNDEFINEDFILE");
  });

  it("ON UNDEFINEDFILE で受け止められる", () => {
    const src = `p: proc options(main);
  dcl v fixed bin(31);
  dcl nope file stream input;
  on undefinedfile(nope)
    begin;
      put list('開けません');
      go to fin;
    end;
  get file(nope) list(v);
  put list('ここには来ない');
fin:
  put skip list('終わり');
end p;
`;
    const r = runProgram(src, { host: new MemoryHost() });
    expect(r.stdout).toContain("開けません");
    expect(r.stdout).not.toContain("ここには来ない");
    expect(r.stdout).toContain("終わり");
  });

  it("二重 OPEN は誤りにする", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl f file stream output;
  open file(f) output;
  open file(f) output;
end p;
`;
    const r = runProgram(src, { host });
    expect(r.diagnostics[0]?.message).toContain("既に開かれています");
  });

  /**
   * 宣言した用途と食い違う使い方。
   *
   * 暗黙 OPEN が渡すのは「今の使い方」（PUT なら output）なので、
   * それを宣言より強く効かせると `INPUT` と宣言したファイルへの `PUT` が
   * 「出力で開く」になり、**中身を黙って破壊する**。
   * PL/I では属性の食い違いは UNDEFINEDFILE。
   */
  describe("宣言した用途と食い違えば UNDEFINEDFILE", () => {
    it("INPUT のファイルへ PUT すると断り、中身を壊さない", () => {
      const host = new MemoryHost({ INP: "important data\n" });
      const src = `p: proc options(main);
  dcl inp file stream input;
  put file(inp) list('CLOBBER');
end p;
`;
      const r = runProgram(src, { host });
      expect(r.ok).toBe(false);
      expect(r.diagnostics[0]?.message).toContain("UNDEFINEDFILE");
      expect(r.diagnostics[0]?.message).toContain(
        "INPUT と宣言したファイルを OUTPUT として使っています",
      );
      expect(host.get("INP")).toBe("important data\n");
    });

    it("明示 OPEN でも断る", () => {
      const host = new MemoryHost({ INP: "important data\n" });
      const src = `p: proc options(main);
  dcl inp file stream input;
  open file(inp) output;
end p;
`;
      const r = runProgram(src, { host });
      expect(r.ok).toBe(false);
      expect(r.diagnostics[0]?.message).toContain("UNDEFINEDFILE");
      expect(host.get("INP")).toBe("important data\n");
    });

    it("ON UNDEFINEDFILE を置けばそこへ回る", () => {
      const host = new MemoryHost({ INP: "x\n" });
      const src = `p: proc options(main);
  dcl inp file stream input;
  on undefinedfile(inp) put list('CAUGHT');
  put file(inp) list('CLOBBER');
end p;
`;
      const r = runProgram(src, { host });
      expect(r.stdout).toContain("CAUGHT");
      expect(host.get("INP")).toBe("x\n");
    });

    it("UPDATE と宣言したファイルは読みにも書きにも使える", () => {
      // RECORD UPDATE は READ（input）と REWRITE（update）の両方を通る。
      // どちらも食い違いにしてはいけない
      const host = new MemoryHost({ "U.TXT": "aaa\nbbb\n" });
      const src = `p: proc options(main);
  dcl f file record update env(f recsize(3));
  dcl rec char(3);
  open file(f) update title('U.TXT');
  read file(f) into(rec);
  rec = 'xxx';
  rewrite file(f) from(rec);
  close file(f);
end p;
`;
      const r = runProgram(src, { host });
      expect(r.diagnostics).toEqual([]);
      expect(host.get("U.TXT")).toBe("xxx\nbbb\n");
    });

    it("用途を宣言していなければ、使い方で決まる（従来どおり）", () => {
      const host = new MemoryHost();
      const src = `p: proc options(main);
  dcl f file stream;
  put file(f) list('OK');
  close file(f);
end p;
`;
      const r = runProgram(src, { host });
      expect(r.ok).toBe(true);
      expect(host.get("F")).toContain("OK");
    });

    it("存在しないファイルのときは TITLE を確かめる案内のまま", () => {
      const src = `p: proc options(main);
  dcl r file stream input;
  dcl c char(8);
  get file(r) list(c);
end p;
`;
      const r = runProgram(src, { host: new MemoryHost() });
      expect(r.diagnostics[0]?.message).toContain("ファイル名と TITLE");
    });
  });
});

describe("LINESIZE / PAGE / LINE", () => {
  it("LINESIZE で折り返しが変わる", () => {
    const host = new MemoryHost();
    const src = `p: proc options(main);
  dcl f file stream output print;
  open file(f) output linesize(30);
  put file(f) list('aaaa', 'bbbb', 'cccc');
end p;
`;
    runProgram(src, { host });
    const lines = (host.get("f") ?? "").split("\n");
    // 24 桁タブストップで 3 項目は 30 桁に収まらないので折り返す
    expect(lines.length).toBeGreaterThan(1);
  });

  it("PUT PAGE は改ページ文字を書く", () => {
    const src = `p: proc options(main);
  put list('one');
  put page list('two');
end p;
`;
    expect(runProgram(src).stdout).toContain("\f");
  });

  it("PUT LINE(n) はその行まで送る", () => {
    const src = `p: proc options(main);
  put list('one');
  put line(4) list('four');
end p;
`;
    const lines = runProgram(src).stdout.split("\n");
    expect(lines[3]?.trim()).toBe("four");
  });
});
