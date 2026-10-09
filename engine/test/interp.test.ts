import { describe, expect, it } from "vitest";
import { run } from "../src/interp.js";

const out = (src: string) => {
  const r = run(src);
  if (r.error) throw new Error(r.error);
  return r.stdout;
};

/** エラーで終わる場合も結果をそのまま受け取る。 */
const runRaw = (src: string) => run(src);

describe("基本", () => {
  it("Hello World（末尾は改行で終端される）", () => {
    expect(out("h: proc options(main);\n put list('HELLO');\nend h;")).toBe("HELLO \n");
  });

  it("予約語が無いコードが動く", () => {
    // 予約語が無いことを示す例
    const src = `kw: proc options(main);
  dcl (if, then, else) fixed bin(31);
  if = 1; then = 2; else = 3;
  if if = then then then = else;
  put skip list(if, then, else);
end kw;`;
    expect(out(src)).toContain("1");
  });
});

describe("引数の宣言", () => {
  /**
   * PL/I では proc(n) の本体にある `dcl n fixed bin(31);` は
   * **引数の属性宣言**であり、新しい変数の宣言ではない。
   * 新変数として 0 で初期化してしまうと引数が失われる。
   * 入れ子手続きと再帰がこれに依存する。
   */
  it("引数名の DECLARE は値を保持する", () => {
    const src = `m: proc options(main);
  call show(7);
  show: proc(v);
    dcl v fixed bin(31);
    put skip list(v);
  end show;
end m;`;
    expect(out(src)).toContain("7");
  });

  it("文字引数も保持する", () => {
    const src = `m: proc options(main);
  call g('start');
  g: proc(msg);
    dcl msg char(20) varying;
    put skip list(msg);
  end g;
end m;`;
    expect(out(src)).toBe("\nstart \n");
  });

  it("再帰手続きが動く", () => {
    const src = `m: proc options(main);
  put skip list(fib(10));
  fib: proc(n) returns(fixed bin(31)) recursive;
    dcl n fixed bin(31);
    if n < 2 then return(n);
    return(fib(n-1) + fib(n-2));
  end fib;
end m;`;
    expect(out(src)).toContain("55");
  });
});

describe("組込関数の戻り値型", () => {
  /**
   * 出力幅から戻り値型が分かる。
   * LENGTH / INDEX は幅9（= FIXED BIN(15,0)）で出力される。
   */
  it("LENGTH は FIXED BIN(15,0)（幅9）", () => {
    expect(out("m: proc options(main); put list(length('abcde')); end m;")).toBe(
      "        5 \n",
    );
  });

  it("INDEX は FIXED BIN(15,0)（幅9）", () => {
    expect(out("m: proc options(main); put list(index('abcdef','cd')); end m;")).toBe(
      "        3 \n",
    );
  });

  it("MOD は整数剰余を返す", () => {
    // 除算の精度規則を使うと 0 になってしまうので整数で計算する
    expect(out("m: proc options(main); put list(mod(17,5)); end m;")).toBe("   2 \n");
  });

  it("MOD は負数でも PL/I の定義に従う", () => {
    // MOD(a,b) は b と同じ符号の結果を返す
    expect(out("m: proc options(main); put list(mod(-17,5)); end m;")).toContain("3");
  });

  it("ABS", () =>
    expect(out("m: proc options(main); put list(abs(-42)); end m;")).toContain("42"));

  it("SUBSTR", () =>
    expect(out("m: proc options(main); put list(substr('abcdef',3,2)); end m;")).toBe(
      "cd \n",
    ));

  it("TRUNC", () =>
    expect(out("m: proc options(main); put list(trunc(7.9)); end m;")).toContain("7"));
});

describe("暗黙宣言", () => {
  /**
   * I〜N で始まる名前は FIXED BINARY、それ以外は FLOAT DECIMAL になる。
   * PL/I の規定。
   */
  it("I〜N は FIXED BINARY として扱われる", () => {
    const r = out("m: proc options(main); i = 7; n = 2; put skip list(i / n); end m;");
    expect(r).toContain("3.5");
  });
});

describe("FLOAT", () => {
  /**
   * PL/I では FLOAT が FIXED より優位で、混ざると結果は FLOAT になる。
   * 暗黙宣言された x,y（FLOAT DEC(6)）の
   * x/y が " 3.50000E+0000" と指数表記で、フィールド幅14で出力される。
   */
  it("FLOAT の除算は指数表記になる", () => {
    expect(out("m: proc options(main); x = 7; y = 2; put skip list(x / y); end m;")).toBe(
      "\n 3.50000E+0000 \n",
    );
  });

  it("FIXED と混ざると FLOAT になる", () => {
    const r = out("m: proc options(main); x = 7; put skip list(x * 2); end m;");
    expect(r).toContain("E+");
  });

  it("FLOAT DEC(6) のフィールド幅は14", () => {
    const r = out("m: proc options(main); x = 7; y = 2; put skip list(x / y); end m;");
    expect(r.split("\n")[1]).toHaveLength(15); // 幅14 + 空白1
  });
});

describe("制御構造", () => {
  it("DO 反復", () =>
    expect(out("m: proc options(main); dcl i fixed bin(31); do i=1 to 3; put skip list(i); end; end m;"))
      .toMatch(/1[\s\S]*2[\s\S]*3/));

  it("DO WHILE", () =>
    expect(out("m: proc options(main); dcl i fixed bin(31); i=0; do while(i<2); i=i+1; put skip list(i); end; end m;"))
      .toMatch(/1[\s\S]*2/));

  it("BY で刻み幅を変える", () =>
    expect(out("m: proc options(main); dcl i fixed bin(31); do i=1 to 5 by 2; put skip list(i); end; end m;"))
      .toMatch(/1[\s\S]*3[\s\S]*5/));

  it("IF/ELSE", () =>
    expect(out("m: proc options(main); if 1=1 then put list('T'); else put list('F'); end m;"))
      .toBe("T \n"));
});

describe("エラー", () => {
  it("FIXEDOVERFLOW は error として返る", () => {
    const r = run("m: proc options(main); dcl a fixed dec(3,0); a = 99999; end m;");
    expect(r.error).toContain("FIXEDOVERFLOW");
  });

  it("0 除算", () => {
    const r = run("m: proc options(main); dcl (a,b) fixed bin(31); a=1; b=0; put list(a/b); end m;");
    expect(r.error).toContain("ZERODIVIDE");
  });

  it("エラー時もそれまでの出力は返る", () => {
    const r = run("m: proc options(main); dcl a fixed dec(3,0); put skip list('before'); a = 99999; end m;");
    expect(r.stdout).toContain("before");
    expect(r.error).toBeDefined();
  });
});

describe("PUT EDIT", () => {
  it("A と F(w)", () => {
    expect(out("m: proc options(main); dcl i fixed bin(31); i=1; put edit('b: ', i)(a, f(4)); end m;"))
      .toBe("b:    1\n");
  });

  it("書式リストは不足すると先頭から巡回する", () => {
    // PL/I はデータが残っていれば書式リストを繰り返し使う
    expect(out("m: proc options(main); put edit(1, 2, 3)(f(3)); end m;")).toBe(
      "  1  2  3\n",
    );
  });

  it("データが尽きたら書式の残りは使われない", () => {
    // isub.pli の (5)f(4) に対しデータ3個のケース
    expect(out("m: proc options(main); put edit(1, 2)(f(4), f(4), f(4)); end m;")).toBe(
      "   1   2\n",
    );
  });

  it("反復係数", () => {
    expect(out("m: proc options(main); put edit(1, 2, 3)((3)f(4)); end m;")).toBe(
      "   1   2   3\n",
    );
  });

  it("X と COLUMN は制御項目なのでデータを消費しない", () => {
    expect(out("m: proc options(main); put edit(1, 2)(f(3), x(2), f(3)); end m;")).toBe(
      "  1    2\n",
    );
  });
});

describe("データリスト中の配列", () => {
  /**
   * PL/I では配列を入出力のデータリストに書くと全要素に展開される。
   * isub.pli の `put skip edit('b: ',b)(a,(9)f(4))` がこれに依存している。
   */
  it("1次元配列は全要素に展開される", () => {
    const src = `m: proc options(main);
  dcl a(3) fixed bin(31) init(1,2,3);
  put edit(a)((3)f(4));
end m;`;
    expect(out(src)).toBe("   1   2   3\n");
  });

  it("2次元配列は行優先で展開される", () => {
    const src = `m: proc options(main);
  dcl b(2,2) fixed bin(31) init(1,2,3,4);
  put edit(b)((4)f(3));
end m;`;
    expect(out(src)).toBe("  1  2  3  4\n");
  });

  it("PUT LIST でも展開される", () => {
    const src = `m: proc options(main);
  dcl a(3) fixed bin(31) init(1,2,3);
  put list(a);
end m;`;
    expect(out(src)).toContain("1");
  });

  it("添字を付けた参照は1要素のまま", () => {
    const src = `m: proc options(main);
  dcl a(3) fixed bin(31) init(1,2,3);
  put edit(a(2))(f(3));
end m;`;
    expect(out(src)).toBe("  2\n");
  });
});

describe("GET STRING", () => {
  it("EDIT で文字列から数値を読む", () => {
    // isub.pli: get string(t) edit(d)(f(5)); t='   -1   -2   -3'
    const src = `m: proc options(main);
  dcl t char(80) varying init('   -1   -2   -3');
  dcl d(3) fixed bin(31);
  get string(t) edit(d)(f(5));
  put edit(d)((3)f(4));
end m;`;
    expect(out(src)).toBe("  -1  -2  -3\n");
  });

  it("LIST で空白区切りの値を読む", () => {
    const src = `m: proc options(main);
  dcl t char(20) varying init('7 8');
  dcl (a, b) fixed bin(31);
  get string(t) list(a, b);
  put edit(a, b)(f(3), f(3));
end m;`;
    expect(out(src)).toBe("  7  8\n");
  });
});

describe("配列", () => {
  it("INIT で初期化して添字で読み書きできる", () => {
    const src = `m: proc options(main);
  dcl a(3) fixed bin(31) init(10,20,30);
  a(2) = 99;
  put edit(a(1), a(2), a(3))((3)f(4));
end m;`;
    expect(out(src)).toBe("  10  99  30\n");
  });

  it("下限付きの配列", () => {
    const src = `m: proc options(main);
  dcl a(0:2) fixed bin(31) init(5,6,7);
  put edit(a(0), a(2))((2)f(3));
end m;`;
    expect(out(src)).toBe("  5  7\n");
  });

  it("2次元配列の添字", () => {
    const src = `m: proc options(main);
  dcl b(2,3) fixed bin(31) init(1,2,3,4,5,6);
  put edit(b(2,1), b(1,3))((2)f(3));
end m;`;
    expect(out(src)).toBe("  4  3\n");
  });

  it("範囲外の添字はエラー", () => {
    const r = run("m: proc options(main); dcl a(3) fixed bin(31); a(5)=1; end m;");
    expect(r.error).toContain("範囲外");
  });
});

describe("主手続きの引数", () => {
  /**
   * numwrd.pli は `NUMWRD: proc(parm) options(main)` でコマンドライン引数を
   * 受け取る。ここでは args に "123" を渡す。
   */
  it("args を主手続きの引数として渡せる", () => {
    const src = `m: proc(parm) options(main);
  dcl parm char(100) varying;
  put edit(parm)(a);
end m;`;
    const r = run(src, { args: ["123"] });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toBe("123\n");
  });

  it("引数が無ければ空文字列", () => {
    const src = `m: proc(parm) options(main);
  dcl parm char(100) varying;
  put edit('[', parm, ']')(a, a, a);
end m;`;
    expect(out(src)).toBe("[]\n");
  });
});

describe("ファイル宣言", () => {
  /**
   * numwrd.pli は `dcl sysprint print;` と標準出力ファイルを宣言する。
   * SYSPRINT は標準出力として受け付け、宣言そのものは記憶域を持たない。
   */
  it("dcl sysprint print; を受け付ける", () => {
    const src = `m: proc options(main);
  dcl sysprint print;
  put edit('ok')(a);
end m;`;
    expect(out(src)).toBe("ok\n");
  });
});

describe("DEFINED（別名定義）", () => {
  /**
   * DEFINED で宣言した変数は独自の記憶域を持たず、基底変数の要素への別名になる。
   * isub.pli は b(3,3) の対角成分を d(3) として参照する。
   *   dcl d(3) bin fixed def (b(1sub,1sub));
   * d(i) は b(i,i) と同じ記憶域を指すので、読み書きが相互に反映される。
   */
  it("読み取りが基底変数に転送される", () => {
    const src = `m: proc options(main);
  dcl b(3,3) bin fixed init(1,2,3, 4,5,6, 7,8,9);
  dcl d(3) bin fixed def (b(1sub,1sub));
  put edit(d)((3)f(4));
end m;`;
    // 対角成分は 1, 5, 9
    expect(out(src)).toBe("   1   5   9\n");
  });

  it("書き込みが基底変数に反映される", () => {
    const src = `m: proc options(main);
  dcl b(3,3) bin fixed init(1,2,3, 4,5,6, 7,8,9);
  dcl d(3) bin fixed def (b(1sub,1sub));
  d(2) = 99;
  put edit(b)((9)f(4));
end m;`;
    expect(out(src)).toBe("   1   2   3   4  99   6   7   8   9\n");
  });

  it("定数添字の DEFINED はスカラの別名になる", () => {
    const src = `m: proc options(main);
  dcl b(3) fixed bin init(10,20,30);
  dcl x fixed bin def (b(2));
  put edit(x)(f(4));
  x = 77;
  put skip edit(b)((3)f(4));
end m;`;
    expect(out(src)).toBe("  20\n  10  77  30\n");
  });

  it("GET で DEFINED 側に書くと基底に反映される", () => {
    // isub.pli の核心部分: get string(t) edit(d)(f(5)) で対角成分を書き換える
    const src = `m: proc options(main);
  dcl b(3,3) bin fixed init(1,2,3, 4,5,6, 7,8,9);
  dcl d(3) bin fixed def (b(1sub,1sub));
  dcl t char(80) varying init('   -1   -2   -3');
  get string(t) edit(d)(f(5));
  put edit(b)((9)f(4));
end m;`;
    expect(out(src)).toBe("  -1   2   3   4  -2   6   7   8  -3\n");
  });
});

describe("文字比較は文字コード順", () => {
  /**
   * PL/I は文字を照合順序（ASCII のバイト順）で比べる。
   * JS の localeCompare はロケール依存で 'Z' > 'a' になることがあり誤る。
   * 'Z' < 'a' が '1'B（真）になる（'Z'=0x5A < 'a'=0x61）。
   */
  it("大文字は小文字より小さい", () => {
    expect(out("m: proc options(main); put list('Z' < 'a'); end m;")).toBe("'1'B \n");
  });

  it("数字は英字より小さい", () => {
    expect(out("m: proc options(main); put list('9' < 'A'); end m;")).toBe("'1'B \n");
  });

  it("短い側は空白で埋めて比べる", () => {
    const src = `m: proc options(main);
  dcl a char(5);
  dcl b char(3);
  a = 'ab'; b = 'ab';
  put list(a = b);
end m;`;
    expect(out(src)).toBe("'1'B \n");
  });
});

describe("CEIL / FLOOR の結果精度", () => {
  /**
   * PL/I: 結果は FIXED(min(N, max(p-q,1)+1), 0)。
   * ceil(2.1) のフィールド幅は 5（= p+3 で p=2）。
   * 内部で 1 を足して実装すると加算の精度規則で p が 3 になり幅が合わない。
   */
  it("ceil(2.1) は幅5（DEC(2,0)）", () => {
    expect(out("m: proc options(main); put list(ceil(2.1)); end m;")).toBe("    3 \n");
  });

  it("floor(2.9) も幅5", () => {
    expect(out("m: proc options(main); put list(floor(2.9)); end m;")).toBe("    2 \n");
  });

  it("負数の CEIL / FLOOR", () => {
    expect(out("m: proc options(main); put list(ceil(-2.1)); end m;")).toContain("-2");
    expect(out("m: proc options(main); put list(floor(-2.1)); end m;")).toContain("-3");
  });
});

describe("計算条件が ON 単位を通ること", () => {
  /**
   * PL/I では FIXEDOVERFLOW などの計算条件も条件機構を通る。
   * ON 単位が無ければ暗黙動作として ERROR を起こす。
   * この規則により
   *   FIXEDOVERFLOW condition raised ... / ERROR condition raised
   * と連鎖していることが確認できる。
   */
  it("FIXEDOVERFLOW が ON ERROR で捕まる", () => {
    const src = `t: proc options(main);
  on error begin; put skip list('CAUGHT'); end;
  begin;
    dcl a fixed dec(3,0);
    a = 99999;
  end;
end t;`;
    const r = run(src);
    expect(r.stdout).toContain("CAUGHT");
  });

  it("FIXEDOVERFLOW 専用の ON 単位が優先される", () => {
    const src = `t: proc options(main);
  on fixedoverflow begin; put skip list('FO'); end;
  on error begin; put skip list('ERR'); end;
  begin;
    dcl a fixed dec(3,0);
    a = 99999;
  end;
end t;`;
    const r = run(src);
    expect(r.stdout).toContain("FO");
  });

  it("ZERODIVIDE も ON 単位を通る", () => {
    const src = `t: proc options(main);
  on zerodivide begin; put skip list('ZD'); end;
  begin;
    dcl (a,b) fixed bin(31);
    a = 1; b = 0;
    put list(a / b);
  end;
end t;`;
    expect(run(src).stdout).toContain("ZD");
  });

  /**
   * 計算条件の ON 単位から正常復帰しても実行を再開しない。
   * PL/I の規定は演算を再試行して無限ループになるが、
   * それを再現する意味は無いので、ここでは ERROR へ進めて終了する。
   */
  it("ON 単位から戻っても再開せず終了する（無限ループにしない）", () => {
    const src = `t: proc options(main);
  on zerodivide begin; put skip list('ZD'); end;
  begin;
    dcl (a,b) fixed bin(31);
    a = 1; b = 0;
    put list(a / b);
  end;
  put skip list('AFTER');
end t;`;
    const r = runRaw(src);
    expect(r.stdout).toContain("ZD");
    expect(r.stdout).not.toContain("AFTER");
    expect(r.error).toBeDefined();
  });

  it("ON 単位が無ければ元の条件名で報告する", () => {
    const r = runRaw("t: proc options(main); dcl a fixed dec(3,0); a = 99999; end t;");
    expect(r.error).toContain("FIXEDOVERFLOW");
  });

  it("ON 単位の中でさらに異常が起きても無限に再入しない", () => {
    const src = `t: proc options(main);
  on error
    begin;
      put skip list('IN');
      begin;
        dcl b fixed dec(2,0);
        b = 999;
      end;
    end;
  begin;
    dcl a fixed dec(3,0);
    a = 99999;
  end;
end t;`;
    const r = runRaw(src);
    expect(r.stdout).toContain("IN");
    expect(r.error).toBeDefined();
  });
});
