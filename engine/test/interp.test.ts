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

  /**
   * FLOAT を FIXED に直すときに文字列を経由してはいけない。
   *
   * JS は `|x| < 1e-6` と `|x| >= 1e21` を指数表記で文字列化するので、
   * `fixedFromLiteral(String(v))` を通すと桁がまるごと消えて 0 になる。
   * 表示（`render`）は `v.v` を直に見るため、**表示は正しいのに
   * 比較と代入では 0** という食い違いになっていた。
   */
  describe("小さすぎる FLOAT が 0 に落ちない", () => {
    it("表示と比較が食い違わない", () => {
      const src = `m: proc options(main);
  dcl a float dec(6);
  a = 0.001;
  put skip list(a*a*a);
  if a*a*a > 0 then put skip list('POSITIVE');
  if a*a*a = 0 then put skip list('ZERO');
end m;`;
      const r = out(src);
      expect(r).toContain("1.00000E-0009");
      expect(r).toContain("POSITIVE");
      expect(r).not.toContain("ZERO");
    });

    it("代入しても桁が消えない", () => {
      const src = `m: proc options(main);
  dcl (a, b) float dec(6);
  a = 0.001;
  b = a*a;
  b = b*a;
  put skip list(b);
end m;`;
      expect(out(src)).toContain("1.00000E-0009");
    });
  });

  /**
   * 指数付き定数は PL/I の規定では**浮動小数点定数**。
   * FIXED として読むと小数が消え（`2.5e-8` が 0）、
   * 表現できない大きさでは `BigInt` の生の例外が漏れていた。
   */
  describe("指数付き定数", () => {
    it("FLOAT DEC(6) として読む", () => {
      expect(out("m: proc options(main); put skip list(1.5e3); end m;")).toContain(
        " 1.50000E+0003",
      );
      expect(out("m: proc options(main); put skip list(2.5e-8); end m;")).toContain(
        " 2.50000E-0008",
      );
    });

    it("大きすぎる定数は名指しで断る（生の JS 例外にしない）", () => {
      const r = runRaw("m: proc options(main); put list(1e400); end m;");
      expect(r.error).toContain("浮動小数点定数が大きすぎます");
    });

    it("FIXED へ代入すれば丸められる", () => {
      const src = `m: proc options(main);
  dcl n fixed dec(7,2);
  n = 1.5e3;
  put skip list(n);
end m;`;
      expect(out(src).replace(/\s+/g, "")).toBe("1500.00");
    });
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

  /**
   * ラベル付きの `LEAVE` / `ITERATE`。
   *
   * ループが自分のラベルを知らないと、一番内側が必ず受け止めてしまう。
   * 誤りも出ないので、**書いたとおりに動かないのに気づけない**。
   */
  describe("ラベル付きの LEAVE / ITERATE", () => {
    it("LEAVE はラベルの付いたループを抜ける", () => {
      const src = `m: proc options(main);
  dcl (i,j) fixed bin(15);
  outer: do i = 1 to 3;
    do j = 1 to 3;
      if j = 2 then leave outer;
      put skip list(i, j);
    end;
  end;
  put skip list('done');
end m;`;
      const r = out(src);
      // 外側まで抜けるので 1 回だけ出る
      expect(r.match(/\n/g)).toHaveLength(3); // 先頭の改行 + 2 行
      expect(r).toContain("done");
      expect(r.replace(/\s+/g, " ")).toBe(" 1 1 done ");
    });

    it("ITERATE はラベルの付いたループを次へ進める", () => {
      const src = `m: proc options(main);
  dcl (i,j) fixed bin(15);
  outer: do i = 1 to 3;
    do j = 1 to 3;
      if j = 2 then iterate outer;
      put skip list('body', i, j);
    end;
    put skip list('never', i);
  end;
end m;`;
      const r = out(src);
      expect(r).toContain("body");
      // 内側を抜けた後の文は実行されない
      expect(r).not.toContain("never");
      expect(r.match(/body/g)).toHaveLength(3);
    });

    it("ラベルを書かなければ一番内側のループ（従来どおり）", () => {
      const src = `m: proc options(main);
  dcl (i,j) fixed bin(15);
  outer: do i = 1 to 2;
    do j = 1 to 3;
      if j = 2 then leave;
      put skip list(i, j);
    end;
  end;
end m;`;
      expect(out(src).replace(/\s+/g, " ")).toBe(" 1 1 2 1 ");
    });

    it("ラベル付きの DO 群も抜けられる", () => {
      const src = `m: proc options(main);
  blk: do;
    put skip list('in');
    leave blk;
    put skip list('never');
  end;
  put skip list('out');
end m;`;
      const r = out(src);
      expect(r).toContain("in");
      expect(r).toContain("out");
      expect(r).not.toContain("never");
    });

    it("対応するループが無いラベルは誤りにする", () => {
      const r = runRaw(
        "m: proc options(main); dcl i fixed bin(15); do i=1 to 3; leave nosuch; end; end m;",
      );
      expect(r.error).toContain("LEAVE nosuch に対応するループがありません");
    });
  });

  /**
   * 制御変数が別名（`DEFINED` / `BASED`）のとき。
   *
   * 書き込みは `assign`（別名を解決する）で、読み戻しは別名を解決しない
   * 経路だったため、書いた先と読む先が食い違って**終了判定が永久に
   * 成立しなかった**（`DEFINED`）か、変数が見つからず落ちた（`BASED`）。
   */
  describe("別名の制御変数でもループが終わる", () => {
    it("DEFINED の制御変数", () => {
      const src = `m: proc options(main);
  dcl b(3) fixed bin(15);
  dcl i fixed bin(15) def (b(1));
  do i = 1 to 3;
    put skip list(i);
  end;
  put skip list('after');
end m;`;
      const r = out(src);
      expect(r).toContain("after");
      expect(r.replace(/\s+/g, " ")).toBe(" 1 2 3 after ");
    });

    it("BASED の制御変数", () => {
      const src = `m: proc options(main);
  dcl p pointer;
  dcl i fixed bin(15) based(p);
  allocate i set(p);
  do i = 1 to 3;
    put skip list(i);
  end;
  put skip list('after');
end m;`;
      expect(out(src).replace(/\s+/g, " ")).toBe(" 1 2 3 after ");
    });
  });
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

  /**
   * データを使い切った後の後処理は、書式リストの**残り**だけを見る。
   *
   * `fi % fmt.length` から始めると、最後のデータ項目が書式リストの
   * 末尾だったときに 0 へ巻き戻り、先頭の制御項目を二重に適用する。
   * `(skip, a)` で余分な改行が入っていた。
   */
  it("データを使い切った後、書式の先頭へ巻き戻らない", () => {
    const src = `m: proc options(main);
  put edit('A')(skip, a(1));
  put edit('B')(skip, a(1));
  put edit('C')(a(1), skip);
  put edit('D')(a(1));
end m;`;
    // SKIP が行を送るので 1 行目は空。C は B と同じ行の続きに置かれる
    // （PL/I のストリーム出力は PUT をまたいで位置が続く）
    expect(out(src)).toBe("\nA\nBC\nD\n");
  });

  it("後処理で COLUMN が二重に効かない", () => {
    const src = `m: proc options(main);
  put edit('A')(column(5), a(1));
  put edit('B')(a(1));
end m;`;
    expect(out(src)).toBe("    AB\n");
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

  /**
   * 配列でないものへの添字。
   *
   * 黙って添字を捨てると `x(7)` と `x(99)` が同じ 1 個の箱を指し、
   * 書いた値がそのまま読めてしまう（= 嘘の値を返す）。
   * 読み・書き・暗黙宣言の 3 経路すべてで断る。
   */
  describe("配列でないものへの添字は断る", () => {
    it("代入でも断る", () => {
      const r = run("m: proc options(main); dcl x fixed bin(31); x(7)=42; end m;");
      expect(r.error).toContain("x は配列ではありません");
    });

    it("参照でも断る", () => {
      const r = run(
        "m: proc options(main); dcl x fixed bin(31); x=1; put list(x(1)); end m;",
      );
      expect(r.error).toContain("x は配列ではありません");
    });

    it("宣言していない名前でも断る（暗黙宣言はスカラ）", () => {
      const r = run("m: proc options(main); q(3)=9; end m;");
      expect(r.error).toContain("q は配列ではありません");
    });

    it("構造体の葉に付けた次元は配列として通る", () => {
      const src = `m: proc options(main);
  dcl 1 rec, 2 nm char(4), 2 a(3) fixed bin(15);
  rec.a(1) = 11;
  rec.a(3) = 33;
  put edit(rec.a(1), rec.a(3))((2)f(4));
end m;`;
      expect(out(src)).toBe("  11  33\n");
    });
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

/**
 * 記憶域クラスと、以前は黙って間違っていた箇所。
 *
 * どれも「テストが 1 例しか無かったために気づけなかった」もの。
 * 直した挙動と、間違っていた側の挙動を対で書き残す。
 */
describe("STATIC", () => {
  it("手続きを抜けても値が残る", () => {
    const src = `m: proc options(main);
  call c; call c; call c;
  c: proc;
    dcl cnt fixed bin(15) static init(0);
    cnt = cnt + 1;
    put skip list(cnt);
  end c;
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("1 2 3");
  });

  it("STATIC が無ければ呼ぶたびに初期化される", () => {
    const src = `m: proc options(main);
  call c; call c;
  c: proc;
    dcl cnt fixed bin(15) init(0);
    cnt = cnt + 1;
    put skip list(cnt);
  end c;
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("1 1");
  });

  it("別の手続きの同名 STATIC は混ざらない", () => {
    const src = `m: proc options(main);
  call a; call b; call a; call b;
  a: proc;
    dcl n fixed bin(15) static init(0);
    n = n + 1;
    put skip list('a', n);
  end a;
  b: proc;
    dcl n fixed bin(15) static init(100);
    n = n + 1;
    put skip list('b', n);
  end b;
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("a 1 b 101 a 2 b 102");
  });
});

describe("ラベルと GOTO", () => {
  it("2 つ目以降のラベルへも飛べる", () => {
    const src = `m: proc options(main);
a: put skip list('A');
   goto b;
b: put skip list('B');
   goto c;
c: put skip list('C');
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("A B C");
  });

  it("1 つの文に複数のラベルを付けられる", () => {
    const src = `m: proc options(main);
  dcl i fixed bin(15) init(0);
l1: l2: i = i + 1;
  if i < 3 then goto l2;
  put list(i);
end m;`;
    expect(out(src).trim()).toBe("3");
  });

  it("見つからないラベルは意味の分かる誤りにする", () => {
    const r = runRaw(`m: proc options(main);
  put skip list('before');
  goto nowhere;
end m;`);
    // 以前は Error ではない内部例外が漏れて `[object Object]` になり、
    // 行番号も 1 固定だった
    expect(r.error).toMatch(/ラベル NOWHERE が見つかりません/);
    expect(r.error).toMatch(/^3行:/);
  });
});

describe("ビット列の演算", () => {
  it("& と | はビットごと", () => {
    expect(out("m: proc options(main);\n  put list('1100'b & '1010'b);\nend m;").trim())
      .toBe("'1000'B");
    expect(out("m: proc options(main);\n  put list('1100'b | '1010'b);\nend m;").trim())
      .toBe("'1110'B");
  });

  it("短い側は '0'B で埋める", () => {
    expect(out("m: proc options(main);\n  put list('11'b | '1010'b);\nend m;").trim())
      .toBe("'1110'B");
  });

  it("BIT(1) 同士はブール演算と一致する", () => {
    expect(out("m: proc options(main);\n  put list('1'b & '0'b);\nend m;").trim())
      .toBe("'0'B");
  });

  it("数値から BIT への代入は 2 進表現になる", () => {
    const src = `m: proc options(main);
  dcl b bit(1);
  dcl s bit(4);
  b = 1;
  s = 5;
  put list(b, s);
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("'1'B '0101'B");
  });
});

describe("16 進定数", () => {
  it("2 桁ずつ 1 文字へデコードする", () => {
    expect(out("m: proc options(main);\n  put list('4142'x);\nend m;").trim())
      .toBe("AB");
  });

  it("桁数が奇数なら誤りにする", () => {
    const r = runRaw("m: proc options(main);\n  put list('414'x);\nend m;");
    expect(r.error).toMatch(/偶数/);
  });
});

describe("PICTURE の小数点", () => {
  it("V が無ければ . が小数点の位置になる", () => {
    const src = `m: proc options(main);
  dcl a pic'ZZ9.99';
  a = 12.34;
  put list('[' || a || ']');
end m;`;
    expect(out(src).trim()).toBe("[ 12.34]");
  });

  it("V を併記した形も同じ結果になる", () => {
    const src = `m: proc options(main);
  dcl a pic'ZZ9V.99';
  a = 12.34;
  put list('[' || a || ']');
end m;`;
    expect(out(src).trim()).toBe("[ 12.34]");
  });
});

describe("CHAR VARYING と基数混在", () => {
  it("基数を混ぜても小数部が消えない", () => {
    const src = `m: proc options(main);
  dcl i fixed bin(15) init(10);
  if i < 10.5 then put skip list('lt');
  if i = 10.5 then put skip list('eq'); else put skip list('ne');
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("lt ne");
  });
});

/**
 * 名前解決はレキシカル、ON 単位は動的。
 *
 * PL/I の規定どおりの組み合わせ。以前は呼んだ位置を親にしていたため
 * 動的スコープになり、呼び先の未宣言の名前が呼び元の変数に化けていた
 * （兄弟の手続きが呼び元のループ変数を壊す、という形で現れる）。
 */
describe("スコープ", () => {
  it("入れ子の手続きは定義された位置から名前を解決する", () => {
    const src = `m: proc options(main);
  dcl x fixed dec(3) init(1);
  call q;
  q: proc;
    dcl x fixed dec(3) init(2);
    call p;
  end q;
  p: proc;
    put skip list(x);
  end p;
end m;`;
    // p は m の中で定義されているので m の x（1）を見る。
    // 呼んだ位置（q）から解決すると 2 になる
    expect(out(src).trim()).toBe("1");
  });

  it("兄弟の手続きは呼び元の変数を壊さない", () => {
    const src = `m: proc options(main);
  dcl i fixed bin(15);
  do i = 1 to 2;
    call b;
    put skip list('i=', i);
  end;
end m;
b: proc;
  do i = 1 to 3; end;
end b;`;
    // b の i は暗黙宣言のローカル。m のループは 2 回まわる
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("i= 1 i= 2");
  });

  it("ON 単位は呼び先でも効く（こちらは動的）", () => {
    const src = `m: proc options(main);
  dcl done bit(1) init('0'b);
  on endfile(sysin) done = '1'b;
  call rd;
  rd: proc;
    dcl v fixed bin(31);
    do while(^done);
      get list(v);
    end;
    put skip list('ok');
  end rd;
end m;`;
    expect(run(src, { stdin: "1 2 3\n" }).stdout.trim()).toBe("ok");
  });
});

/**
 * 引数の渡し方。
 *
 * PL/I は変数を**参照で渡す**。呼び先が引数を書き換えると呼び元に戻る。
 * 値渡しにすると、出力引数を使うふつうのサブルーチンが黙って嘘の答えを返す。
 * ただし宣言した属性が渡された値と違う場合、実機は一時変数
 * （ダミー引数）を作るので、そこは値渡しになる。
 */
describe("引数の参照渡し", () => {
  const prelude = `m: proc options(main);
  dcl (a, b) fixed bin(15);
  dcl arr(3) fixed bin(15);
  dcl i fixed bin(15);
`;

  it("呼び先の書き換えが呼び元に戻る", () => {
    const src = `${prelude}  a = 1; b = 2;
  call swap(a, b);
  put list(a, b);
  swap: proc(x, y);
    dcl (x, y) fixed bin(15);
    dcl tmp fixed bin(15);
    tmp = x; x = y; y = tmp;
  end swap;
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("2 1");
  });

  it("配列を渡すと要素を書き換えられる", () => {
    const src = `${prelude}  do i = 1 to 3; arr(i) = i; end;
  call doubleall(arr);
  put list(arr(1), arr(2), arr(3));
  doubleall: proc(v);
    dcl v(3) fixed bin(15);
    dcl k fixed bin(15);
    do k = 1 to 3; v(k) = v(k) * 2; end;
  end doubleall;
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("2 4 6");
  });

  it("宣言した型が違えばダミー引数になる（呼び元は変わらない）", () => {
    const src = `${prelude}  a = 5;
  call conv(a);
  put list(a);
  conv: proc(n);
    dcl n fixed dec(7,2);
    n = n + 10;
  end conv;
end m;`;
    expect(out(src).trim()).toBe("5");
  });

  it("式や定数は一時値として渡す", () => {
    const src = `${prelude}  put list(addone(3));
  addone: proc(n) returns(fixed bin(15));
    dcl n fixed bin(15);
    return (n + 1);
  end addone;
end m;`;
    expect(out(src).trim()).toBe("4");
  });

  it("関数としての呼び出しでも参照渡し", () => {
    const src = `${prelude}  a = 1;
  put list(bump(a), a);
  bump: proc(n) returns(fixed bin(15));
    dcl n fixed bin(15);
    n = n + 1;
    return (n);
  end bump;
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("2 2");
  });
});

describe("配列式", () => {
  it("部分式も要素ごとに評価する", () => {
    const src = `m: proc options(main);
  dcl (a, b, c)(3) fixed bin(15);
  dcl i fixed bin(15);
  do i = 1 to 3; a(i) = i * 10; b(i) = i; end;
  c = a + b * 2;
  put list(c(1), c(2), c(3));
end m;`;
    // 以前は b * 2 が b(1) * 2 に潰れて 12 22 32 になっていた
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("12 24 36");
  });

  it("単項演算も要素ごと", () => {
    const src = `m: proc options(main);
  dcl (a, c)(3) fixed bin(15);
  dcl i fixed bin(15);
  do i = 1 to 3; a(i) = i; end;
  c = -a;
  put list(c(1), c(2), c(3));
end m;`;
    expect(out(src).replace(/\s+/g, " ").trim()).toBe("-1 -2 -3");
  });

  it("要素数が合わなければ断る（黙って切らない）", () => {
    const r = runRaw(`m: proc options(main);
  dcl a(3) fixed bin(15);
  dcl b(5) fixed bin(15);
  a = b + 1;
end m;`);
    expect(r.error).toMatch(/要素数/);
  });
});

/**
 * 条件・組込関数・宣言の既定値。
 *
 * どれも「黙って間違った値を返す」か「条件が発火しない」ものだった。
 */
describe("ROUND", () => {
  it("BINARY でも丸まる（基数混在で half が 0 になっていた）", () => {
    const src = `m: proc options(main);
  dcl n fixed bin(15) init(7);
  put list(round(n/2, 0));
end m;`;
    expect(out(src).trim()).toBe("4");
  });

  it("桁数が小数部より大きくても溢れず、尺度が n に揃う", () => {
    // 実機（Iron Spring PL/I 1.4.1）で確認: round(12.5, 3) は 12.500。
    // 以前はここを "12.5" と固定していた（元の尺度を保つ実装だった）。
    // 桁あふれで止まっていた時期もあるので、両方をここで押さえる
    expect(
      out("m: proc options(main);\n  put list(round(12.5, 3));\nend m;").trim(),
    ).toBe("12.500");
  });

  it("n を小さくすると尺度もそこへ落ちる", () => {
    // 実機で確認: dcl x fixed dec(5,1); x = 12.5; のとき
    // round(x,1) は 12.5、round(x,0) は 13
    const src = (n: string) =>
      `m: proc options(main);\n  dcl x fixed dec(5,1);\n  x = 12.5;\n  put list(round(x, ${n}));\nend m;`;
    expect(out(src("1")).trim()).toBe("12.5");
    expect(out(src("0")).trim()).toBe("13");
  });

  it("0 から遠い側へ丸める", () => {
    const cases: [string, string][] = [
      ["round(2.675, 2)", "2.68"],
      ["round(2.4, 0)", "2"],
      ["round(-2.5, 0)", "-3"],
      ["round(1234.5, 0)", "1235"],
    ];
    for (const [expr, want] of cases) {
      expect(
        out(`m: proc options(main);\n  put list(${expr});\nend m;`).trim(),
        expr,
      ).toBe(want);
    }
  });

  /**
   * n が負のとき（整数位へ丸める）。
   *
   * この値モデルは尺度が 0 以上である前提で、`render` も `q <= 0` を
   * 「整数」として扱う（`radix^(-q)` を掛け戻さない）。負の尺度の
   * FixedVal を作ると桁が消え、`round(15,-1)` が 2 になっていた。
   */
  it("n が負なら整数位へ丸める（負の尺度を作らない）", () => {
    const cases: [string, string][] = [
      ["round(15, -1)", "20"],
      ["round(14, -1)", "10"],
      ["round(151, -2)", "200"],
      ["round(149, -2)", "100"],
      ["round(-15, -1)", "-20"],
    ];
    for (const [expr, want] of cases) {
      expect(
        out(`m: proc options(main);\n  put list(${expr});\nend m;`).trim(),
        expr,
      ).toBe(want);
    }
  });
});

/**
 * `MOD` と `DIVIDE`。
 *
 * どちらも `value.ts` の演算を通さない独自実装になっていて、
 * 他の演算（`add` / `sub` / `mul` / `div` / `compare`）とだけ食い違っていた。
 */
describe("MOD と DIVIDE", () => {
  it("MOD は基数を揃える", () => {
    // 以前は DECIMAL の辺を 2 進へ直さず、尺度だけ 2 進として扱っていた
    const src = `m: proc options(main);
  dcl i fixed bin(15) init(1);
  dcl j fixed bin(31) init(7);
  put skip list(mod(i, 0.5));
  put skip list(mod(j, 2.5));
  put skip list(mod(7, 2.5));
end m;`;
    const got = out(src).trim().split("\n").map((l) => l.trim());
    expect(got).toEqual(["0.00", "2.00", "2.0"]);
  });

  it("MOD は第 2 引数と同じ符号（負でも非負を返す）", () => {
    const src = "m: proc options(main); put list(mod(-7, 3)); end m;";
    expect(out(src).trim()).toBe("2");
  });

  it("MOD(17,5) の出力幅は変わらない（golden が固定している）", () => {
    expect(out("m: proc options(main); put list(mod(17, 5)); end m;")).toBe("   2 \n");
  });

  it("DIVIDE は指定した精度で商を作る", () => {
    // 既定の除算精度を先に通すと、被除数の p が広いとき q=0 の
    // 整数除算になり、あとで桁を広げても情報は戻らない
    const src = `m: proc options(main);
  dcl a fixed dec(15,0) init(2);
  dcl b fixed dec(15,0) init(4);
  put skip list(divide(a, b, 5, 4));
  put skip list(divide(7, 2, 3, 0));
end m;`;
    const got = out(src).trim().split("\n").map((l) => l.trim());
    expect(got).toEqual(["0.5000", "3"]);
  });

  it("DIVIDE の尺度が精度を超えたら断る", () => {
    const r = runRaw("m: proc options(main); put list(divide(1, 2, 2, 5)); end m;");
    expect(r.error).toContain("DIVIDE の尺度");
  });
});

/**
 * `¬<` / `¬>`（`^<` / `^>`）。
 *
 * 字句解析（`lexer.ts`）と構文解析（`BINARY_PRECEDENCE`）は受けていたのに
 * 評価器の比較演算子の一覧に無く、**構文は通るのに実行時に落ちていた**。
 * 綴り間違いと未実装の区別が付かない一番悪い形。
 */
describe("¬< と ¬>", () => {
  it("否定付きの比較が動く", () => {
    const src = `m: proc options(main);
  dcl a fixed bin(15) init(3);
  if a ^< 2 then put skip list('NL2');
  if a ^> 5 then put skip list('NG5');
  if a ^< 4 then put skip list('BAD'); else put skip list('LT4');
end m;`;
    const r = out(src);
    expect(r).toContain("NL2");
    expect(r).toContain("NG5");
    expect(r).toContain("LT4");
    expect(r).not.toContain("BAD");
  });
});

/**
 * `SIGNAL` で起こした入出力条件。
 *
 * 入出力条件は ON 単位から**復帰して続行する**のが PL/I の規定。
 * 計算条件用の経路を使っていたため、`GET` で起きた ENDFILE は復帰するのに
 * `SIGNAL ENDFILE(f)` だけが終了していた。
 */
describe("SIGNAL で起こす入出力条件", () => {
  it("ON 単位から復帰して続行する", () => {
    const src = `m: proc options(main);
  on endfile(sysin) put skip list('RAN');
  signal endfile(sysin);
  put skip list('RESUMED');
end m;`;
    const r = out(src);
    expect(r).toContain("RAN");
    expect(r).toContain("RESUMED");
  });

  it("ON 単位が無ければ従来どおり終わる", () => {
    const r = runRaw("m: proc options(main); signal endfile(sysin); end m;");
    expect(r.error).toContain("ENDFILE");
  });

  it("計算条件は復帰しない（ERROR へ進めて終える）", () => {
    const r = runRaw(`m: proc options(main);
  on zerodivide put skip list('RAN');
  signal zerodivide;
  put skip list('NEVER');
end m;`);
    expect(r.stdout).toContain("RAN");
    expect(r.stdout).not.toContain("NEVER");
  });
});

describe("べき乗", () => {
  it("整数の指数は FIXED のまま", () => {
    expect(out("m: proc options(main);\n  put list(4**2);\nend m;").trim()).toBe("16");
    expect(out("m: proc options(main);\n  put list(2**0);\nend m;").trim()).toBe("1");
  });

  it("小数の指数は FLOAT で計算する（以前は指数を切り捨てていた）", () => {
    const got = out("m: proc options(main);\n  put list(4**1.5);\nend m;").trim();
    expect(Number(got.replace("E+0000", ""))).toBeCloseTo(8, 6);
  });

  it("負の指数も FLOAT（以前は FIXEDOVERFLOW だった）", () => {
    const got = out("m: proc options(main);\n  put list(2**-1);\nend m;").trim();
    expect(got).toMatch(/5\.0*E-0001/);
  });
});

describe("条件の発火", () => {
  it("FLOAT の 0 除算も ZERODIVIDE になる", () => {
    // 条件を受けたあとは ERROR へ進んで終わるので runRaw で見る
    const src = `m: proc options(main);
  dcl f float dec(6) init(0);
  on zerodivide put skip list('caught');
  put skip list(1.0 / f);
end m;`;
    expect(runRaw(src).stdout).toMatch(/caught/);
  });

  it("MOD の 0 除算も ZERODIVIDE になる", () => {
    const src = `m: proc options(main);
  on zerodivide put skip list('caught');
  put skip list(mod(17, 0));
end m;`;
    expect(runRaw(src).stdout).toMatch(/caught/);
  });

  it("SELECT でどれにも合わなければ ERROR", () => {
    const src = `m: proc options(main);
  on error put skip list('caught');
  select (3);
    when (1) put skip list('one');
  end;
  put skip list('ここには来ない');
end m;`;
    const r = runRaw(src);
    expect(r.stdout).toMatch(/caught/);
    expect(r.stdout).not.toMatch(/ここには来ない/);
  });

  it("OTHERWISE があれば ERROR にしない", () => {
    const src = `m: proc options(main);
  select (3);
    when (1) put list('one');
    otherwise put list('other');
  end;
end m;`;
    expect(out(src).trim()).toBe("other");
  });

  it("ON ... SYSTEM は既定動作へ戻す（空の ON 単位にしない）", () => {
    const src = `m: proc options(main);
  dcl v fixed bin(31);
  on endfile(sysin) put skip list('caught');
  get list(v);
  on endfile(sysin) system;
  get list(v);
  put skip list('ここには来ない');
end m;`;
    const r = run(src, { stdin: "1\n" });
    expect(r.stdout).toMatch(/caught/);
    expect(r.stdout).not.toMatch(/ここには来ない/);
    expect(r.error).toMatch(/ENDFILE/);
  });

  it("SUBSCRIPTRANGE を受けられる", () => {
    const src = `m: proc options(main);
  dcl a(5) fixed bin(15);
  on subscriptrange put skip list('caught');
  a(7) = 1;
end m;`;
    expect(runRaw(src).stdout).toMatch(/caught/);
  });

  it("ON 単位が無ければ従来のメッセージで止まる", () => {
    const src = `m: proc options(main);
  dcl a(5) fixed bin(15);
  a(7) = 1;
end m;`;
    expect(runRaw(src).error).toMatch(/添字が範囲外です/);
  });
});

describe("型を書いていない宣言", () => {
  it("名前の先頭文字で属性が決まる（FIXED DEC(5,0) にしない）", () => {
    // X は FLOAT DEC(6) なので 1/3 が 0 にならない
    const src = `m: proc options(main);
  dcl x;
  x = 1/3;
  put list(x);
end m;`;
    expect(out(src).trim()).toMatch(/3\.33333E-0001/);
  });

  it("I〜N は FIXED BIN(15,0)", () => {
    const src = `m: proc options(main);
  dcl i;
  i = 7;
  put list(i);
end m;`;
    // 出力幅 9 が FIXED BIN(15,0) の証拠
    expect(out(src)).toBe("        7 \n");
  });

  it("FIXED を書けば従来どおり DEC(5,0)", () => {
    const src = `m: proc options(main);
  dcl a fixed;
  a = 1/3;
  put list(a);
end m;`;
    expect(out(src).trim()).toBe("0");
  });
});

describe("RETURNS", () => {
  it("宣言した型へ合わせて返す", () => {
    const src = `m: proc options(main);
  put list(avg(7));
  avg: proc(n) returns(fixed dec(7,2));
    dcl n fixed dec(5);
    return (n / 3);
  end avg;
end m;`;
    expect(out(src).trim()).toBe("2.33");
  });

  it("桁を広く宣言すればそのまま返る", () => {
    const src = `m: proc options(main);
  put list(raw(7));
  raw: proc(n) returns(fixed dec(15,10));
    dcl n fixed dec(5);
    return (n / 3);
  end raw;
end m;`;
    expect(out(src).trim()).toBe("2.3333333333");
  });
});

describe("構造体の BASED", () => {
  it("グループ名で FREE できる", () => {
    const src = `m: proc options(main);
  dcl p pointer;
  dcl 1 node based(p),
        2 val fixed bin(31),
        2 next pointer;
  allocate node set(p);
  p -> node.val = 5;
  put list(p -> node.val);
  free p -> node;
end m;`;
    expect(out(src).trim()).toBe("5");
  });
});

describe("GET LIST の数値", () => {
  it("指数表記を読める", () => {
    // 最後の項目を読んだ GET で ENDFILE が上がるので ON 単位を置く
    const src = `m: proc options(main);
  dcl f float dec(6);
  on endfile(sysin);
  get list(f);
  put list(f);
end m;`;
    expect(run(src, { stdin: "1.5E3\n" }).stdout.trim()).toMatch(/1\.50000E\+0003/);
  });

  it("末尾の小数点を読める", () => {
    const src = `m: proc options(main);
  dcl f float dec(6);
  on endfile(sysin);
  get list(f);
  put list(f);
end m;`;
    expect(run(src, { stdin: "5.\n" }).stdout.trim()).toMatch(/5\.00000E\+0000/);
  });
});
