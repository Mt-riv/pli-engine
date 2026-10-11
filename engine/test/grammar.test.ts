/**
 * 文法の棚卸し。
 *
 * このファイルだけは**機能ごとではなく構文ごと**に並べてある。
 * 「PL/I を書く人が当然使う形」を一通り並べ、通ることと、
 * 通らないものが名指しで断られることを固定する。
 *
 * 他のテストは機能の中身（精度・書式・DL/I など）を見るので、
 * 形の網羅はどこにも無かった。実際にここを書き起こしたときに
 * 次の 7 つが見つかっている。
 *
 *   - `DO i = 1 TO 10 WHILE(…)` / `UNTIL(…)` / `REPEAT` が構文エラー
 *   - `STOP` が未実装（なのに `EXIT` の診断が「STOP を使ってください」）
 *   - 左辺を並べた代入（`a, b = 0;`）が構文エラー
 *   - 文字列から BIT への変換が 0/1 を検査せず `'abc00000'B` を作る
 *   - `PUT STRING` が無い（`GET STRING` はある）
 *   - 引数を多く渡した呼び出しが黙って通る
 *   - `LEAVE` が手続きの境界を越えて呼び元のループを抜ける
 *
 * 空白の並びは潰して比べる。桁揃えは `format.test.ts` の受け持ち。
 */
import { describe, expect, it } from "vitest";
import { runProgram } from "../src/index.js";

/** 主手続きで包む。形だけを見たいので器は毎回同じにする。 */
const MAIN = (body: string) => `m: proc options(main);\n${body}\nend m;`;

/** 通ったときの標準出力。 */
function out(body: string): string {
  const r = runProgram(MAIN(body), { maxSteps: 200_000 });
  if (!r.ok) {
    const why = r.diagnostics.map((d) => `${d.line}行: ${d.message}`).join(" / ");
    throw new Error(`通らなかった: ${why}`);
  }
  return r.stdout.replace(/\s+/g, " ").trim();
}

/** 空白を潰さない標準出力。桁の埋まり方そのものを見るときに使う。 */
function raw(body: string): string {
  const r = runProgram(MAIN(body), { maxSteps: 200_000 });
  if (!r.ok) {
    const why = r.diagnostics.map((d) => `${d.line}行: ${d.message}`).join(" / ");
    throw new Error(`通らなかった: ${why}`);
  }
  return r.stdout;
}

/** 断られたときの 1 つ目の診断。通ってしまったらテストを落とす。 */
function refused(body: string): string {
  const r = runProgram(MAIN(body), { maxSteps: 200_000 });
  expect(r.ok, `断られるはずが通った（出力: ${JSON.stringify(r.stdout)}）`).toBe(false);
  return r.diagnostics[0]?.message ?? "";
}

describe("IF / THEN / ELSE", () => {
  it("THEN 節と ELSE 節", () => {
    expect(out("if 1=1 then put list('t'); else put list('f');")).toBe("t");
    expect(out("if 1=0 then put list('t'); else put list('f');")).toBe("f");
  });

  it("ELSE は最も内側の IF に付く（ぶら下がり ELSE）", () => {
    // 外側が偽なら何も出ない。ELSE が外側に付いていれば 'b' が出てしまう
    expect(out("if 1=0 then if 1=1 then put list('a'); else put list('b');")).toBe("");
  });

  it("THEN に空文を置ける", () => {
    expect(out("if 1=1 then ; else put list('x');")).toBe("");
  });

  it("THEN / ELSE に DO 群を置ける", () => {
    expect(out("if 1=1 then do; put list('a'); put list('b'); end;")).toBe("a b");
  });

  it("ELSE IF の連鎖", () => {
    const body = (n: number) => `dcl n fixed bin(15); n=${n};
  if n=1 then put list('one'); else if n=2 then put list('two'); else put list('many');`;
    expect(out(body(1))).toBe("one");
    expect(out(body(2))).toBe("two");
    expect(out(body(9))).toBe("many");
  });

  it("条件はビット式でもよい", () => {
    expect(out("if '1'b then put list('y');")).toBe("y");
    expect(out("if ¬('1'b) then put list('y'); else put list('n');")).toBe("n");
  });

  it("IF / THEN / ELSE という名前の変数と共存する（予約語が無い）", () => {
    expect(
      out(`dcl (if, then, else) fixed bin(15);
  if = 1; then = 1; else = 9;
  if if = then then then = else;
  put list(then);`),
    ).toBe("9");
  });
});

describe("DO（反復の形）", () => {
  it("TO", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 3; put list(i); end;")).toBe("1 2 3");
  });

  it("BY（負の刻みも）", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 10 by 3; put list(i); end;")).toBe("1 4 7 10");
    expect(out("dcl i fixed bin(15); do i=3 to 1 by -1; put list(i); end;")).toBe("3 2 1");
  });

  it("端から外れていれば 1 度も実行しない", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 0; put list('in'); end; put list('out');")).toBe("out");
  });

  it("小数の刻み", () => {
    expect(out("dcl x fixed dec(3,1); do x=1 to 2 by 0.5; put list(x); end;")).toBe("1.0 1.5 2.0");
  });

  it("単一値の列（TO を書かない指定）", () => {
    expect(out("dcl i fixed bin(15); do i=1,3,5; put list(i); end;")).toBe("1 3 5");
  });

  it("複数指定", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 2, 7 to 8; put list(i); end;")).toBe("1 2 7 8");
  });

  it("上限の式は指定に入った時点で 1 度だけ評価する", () => {
    expect(
      out("dcl (i,n) fixed bin(15); n=3; do i=1 to n; n=99; put list(i); end;"),
    ).toBe("1 2 3");
  });

  it("本体で制御変数を書き換えれば次の値に影響する", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 5; put list(i); i=i+1; end;")).toBe("1 3 5");
  });

  it("DO 群（反復しない）", () => {
    expect(out("do; put list('a'); put list('b'); end;")).toBe("a b");
  });

  it("END にラベルを書ける", () => {
    expect(out("dcl i fixed bin(15); lp: do i=1 to 2; put list(i); end lp;")).toBe("1 2");
  });
});

describe("DO WHILE / UNTIL / REPEAT", () => {
  it("WHILE は本体の前に見る", () => {
    expect(out("dcl i fixed bin(15); i=0; do while(i<3); i=i+1; put list(i); end;")).toBe("1 2 3");
    expect(out("do while('0'b); put list('in'); end; put list('out');")).toBe("out");
  });

  it("UNTIL は本体の後に見るので必ず 1 回は実行する", () => {
    expect(out("dcl i fixed bin(15); i=9; do until(i>0); put list('once'); end;")).toBe("once");
  });

  /**
   * 反復の指定に付ける WHILE / UNTIL。
   * 「配列を端まで、ただし空欄に当たったら打ち切る」のような、
   * 上限と打ち切り条件の両方がある形で使う。
   */
  it("TO と WHILE を併記できる", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 10 while(i<4); put list(i); end;")).toBe("1 2 3");
  });

  it("TO と UNTIL を併記できる（UNTIL は本体の後）", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 10 until(i>=3); put list(i); end;")).toBe("1 2 3");
  });

  it("TO / BY / WHILE をまとめて書ける", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 20 by 3 while(i<10); put list(i); end;")).toBe("1 4 7");
  });

  it("WHILE と UNTIL を併記できる（順序は問わない）", () => {
    const b = (head: string) => `dcl i fixed bin(15); i=0; do ${head}; i=i+1; put list(i); end;`;
    expect(out(b("while(i<9) until(i>=3)"))).toBe("1 2 3");
    expect(out(b("until(i>=3) while(i<9)"))).toBe("1 2 3");
  });

  it("複数指定のそれぞれに WHILE を付けられる", () => {
    expect(
      out("dcl i fixed bin(15); do i=1 to 3 while(i<3), 7 to 9 while(i<8); put list(i); end;"),
    ).toBe("1 2 7");
  });

  it("REPEAT は次の値を式で作る", () => {
    expect(out("dcl i fixed bin(15); do i=1 repeat i*2 while(i<20); put list(i); end;")).toBe("1 2 4 8 16");
  });

  /**
   * `REPEAT` の本来の用途。連鎖をたどる定型で、
   * これが無いと `DO WHILE` と手書きの付け替えに崩す必要がある。
   */
  it("REPEAT でポインタの連鎖をたどれる", () => {
    expect(
      out(`dcl (p,q,head) pointer;
  dcl 1 node based(p), 2 val fixed bin(15), 2 next pointer;
  dcl i fixed bin(15);
  head = null();
  do i=3 to 1 by -1;
    allocate node set(p);
    p->node.val = i;
    p->node.next = head;
    head = p;
  end;
  do q=head repeat q->node.next while(q ¬= null());
    put list(q->node.val);
  end;`),
    ).toBe("1 2 3");
  });

  it("REPEAT と TO / BY の併記は断る（どちらも次の値を決める）", () => {
    expect(refused("dcl i fixed bin(15); do i=1 to 3 repeat i*2; end;")).toMatch(
      /REPEAT と TO \/ BY/,
    );
  });
});

describe("LEAVE / ITERATE", () => {
  it("LEAVE はループを抜ける", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 9; if i=3 then leave; put list(i); end;")).toBe("1 2");
  });

  it("ITERATE は次の回へ進む", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 4; if i=2 then iterate; put list(i); end;")).toBe("1 3 4");
  });

  it("DO WHILE / DO UNTIL / DO 群でも使える", () => {
    expect(out("do while('1'b); put list('a'); leave; end;")).toBe("a");
    expect(
      out("dcl i fixed bin(15); i=0; do until(i>=3); i=i+1; if i=2 then iterate; put list(i); end;"),
    ).toBe("1 3");
    expect(out("lp: do; put list('a'); leave lp; put list('b'); end;")).toBe("a");
  });

  it("ラベルを書けば外側のループを抜ける", () => {
    expect(
      out(`dcl (i,j) fixed bin(15);
  outer: do i=1 to 3; do j=1 to 3; if j=2 then leave outer; put list(i*10+j); end; end;`),
    ).toBe("11");
  });

  it("ラベル付きの ITERATE は外側のループの次の回へ進む", () => {
    expect(
      out(`dcl (i,j) fixed bin(15);
  outer: do i=1 to 2; do j=1 to 3; if j=2 then iterate outer; put list(i*10+j); end; end;`),
    ).toBe("11 21");
  });

  it("SELECT の中から外側のループを抜けられる", () => {
    expect(
      out(`dcl i fixed bin(15);
  do i=1 to 3; select(i); when(2) leave; otherwise put list(i); end; end;`),
    ).toBe("1");
  });

  it("ループの外では断る", () => {
    expect(refused("put list('a'); leave;")).toMatch(/LEAVE はループの中/);
    expect(refused("put list('a'); iterate;")).toMatch(/ITERATE はループの中/);
  });

  /**
   * 手続きの境界は越えない。越えさせると、呼ばれた側の `leave;` が
   * 呼び元のループを誤りも出さずに抜ける（呼び元を読んでも分からない）。
   */
  it("手続きの境界は越えない", () => {
    expect(
      refused(`dcl i fixed bin(15);
  do i=1 to 3; call p; end;
  p: proc; leave; end p;`),
    ).toMatch(/LEAVE はループの中/);
  });
});

describe("SELECT / WHEN / OTHERWISE", () => {
  it("SELECT(式) は値で選ぶ", () => {
    const b = (n: number) => `dcl n fixed bin(15); n=${n};
  select(n); when(1) put list('a'); when(2,3) put list('b'); otherwise put list('c'); end;`;
    expect(out(b(1))).toBe("a");
    expect(out(b(3))).toBe("b");
    expect(out(b(9))).toBe("c");
  });

  it("SELECT; は WHEN の式を条件として見る", () => {
    expect(
      out(`dcl n fixed bin(15); n=5;
  select; when(n<3) put list('小'); when(n<9) put list('中'); otherwise put list('大'); end;`),
    ).toBe("中");
  });

  it("入れ子にできる", () => {
    expect(
      out(`dcl (a,b) fixed bin(15); a=1; b=2;
  select(a);
    when(1) select(b); when(2) put list('x'); otherwise put list('y'); end;
    otherwise put list('z');
  end;`),
    ).toBe("x");
  });

  it("WHEN / OTHERWISE に DO 群を置ける", () => {
    expect(
      out("dcl n fixed bin(15); n=1; select(n); when(1) do; put list('a'); put list('b'); end; end;"),
    ).toBe("a b");
  });

  it("OTHER と書いてもよい", () => {
    expect(out("dcl n fixed bin(15); n=7; select(n); when(1) put list('a'); other put list('o'); end;")).toBe("o");
  });

  it("END に名前を書ける", () => {
    expect(out("dcl n fixed bin(15); n=1; select(n); when(1) put list('a'); end select;")).toBe("a");
  });

  it("どれにも合わず OTHERWISE も無ければ ERROR", () => {
    expect(refused("dcl n fixed bin(15); n=7; select(n); when(1) put list('a'); end;")).toMatch(/ERROR/);
  });

  it("中に WHEN / OTHERWISE / END 以外は置けない", () => {
    expect(refused("select(1); put list('a'); end;")).toMatch(/WHEN \/ OTHERWISE \/ END/);
  });
});

describe("GOTO と文ラベル", () => {
  it("前方へ飛ぶ", () => {
    expect(out("goto skip; put list('no'); skip: put list('yes');")).toBe("yes");
  });

  it("GO TO の 2 語でも書ける", () => {
    expect(out("go to skip; put list('no'); skip: put list('yes');")).toBe("yes");
  });

  it("後方へ飛べば繰り返しになる", () => {
    expect(
      out("dcl i fixed bin(15); i=0; top: i=i+1; put list(i); if i<3 then goto top;"),
    ).toBe("1 2 3");
  });

  it("ループの外へ飛べる", () => {
    expect(
      out("dcl i fixed bin(15); do i=1 to 9; if i=3 then goto fin; put list(i); end; fin: put list('x');"),
    ).toBe("1 2 x");
  });

  it("1 つの文に複数のラベルを付けられる", () => {
    expect(out("goto b; a: put list('a'); b: put list('b');")).toBe("b");
  });

  it("手続きの中から呼び元のラベルへ飛べる（非局所 GOTO）", () => {
    expect(
      out(`dcl i fixed bin(15);
  do i=1 to 3; call p; end; fin: put list('fin');
  p: proc; goto fin; end p;`),
    ).toBe("fin");
  });

  it("飛び先が無ければ断る", () => {
    expect(refused("goto nowhere;")).toMatch(/見つかりません/);
  });
});

describe("BEGIN ブロック", () => {
  it("独自の名前の有効範囲を持つ", () => {
    expect(
      out("dcl x fixed bin(15); x=1; begin; dcl x fixed bin(15); x=2; put list(x); end; put list(x);"),
    ).toBe("2 1");
  });

  it("外側の名前は見える", () => {
    expect(out("dcl x fixed bin(15); x=5; begin; put list(x); end;")).toBe("5");
  });
});

describe("手続き（PROCEDURE / CALL / RETURN）", () => {
  it("CALL と RETURN", () => {
    expect(out("call sub; put list('back'); sub: proc; put list('in'); return; end sub;")).toBe("in back");
  });

  it("RETURNS で値を返す", () => {
    expect(
      out("put list(f(3)); f: proc(n) returns(fixed bin(15)); dcl n fixed bin(15); return(n*2); end f;"),
    ).toBe("6");
  });

  it("RECURSIVE", () => {
    expect(
      out(`put list(fact(5));
  fact: proc(n) recursive returns(fixed bin(31)); dcl n fixed bin(31);
  if n<=1 then return(1); return(n*fact(n-1)); end fact;`),
    ).toBe("120");
  });

  it("引数は参照渡し", () => {
    expect(
      out("dcl x fixed bin(15); x=1; call p(x); put list(x); p: proc(a); dcl a fixed bin(15); a=9; end p;"),
    ).toBe("9");
  });

  it("引数無しの関数呼び出しは括弧で見分ける", () => {
    expect(out("put list(g()); g: proc returns(fixed bin(15)); return(42); end g;")).toBe("42");
  });

  it("入れ子の手続き", () => {
    expect(out("call outer; outer: proc; call inner; inner: proc; put list('in'); end inner; end outer;")).toBe("in");
  });

  it("CHAR(*) の引数は長さを呼ぶ側から受け取る", () => {
    expect(
      out("dcl s char(5); s='hi'; call p(s); p: proc(t); dcl t char(*); put list(length(t)); end p;"),
    ).toBe("5");
  });

  it("CHAR(*) は VARYING とも併せられる", () => {
    expect(
      out(`dcl s char(8) varying; s='hello'; call p(s);
  p: proc(t); dcl t char(*) varying; put list(length(t)); end p;`),
    ).toBe("5");
  });

  it("BIT(*) も同じ", () => {
    expect(
      out("dcl b bit(4) init('1010'b); call p(b); p: proc(t); dcl t bit(*); put list(length(t)); end p;"),
    ).toBe("4");
  });

  it("引数が足りなければ断る", () => {
    expect(refused("call p; p: proc(a); dcl a fixed bin(15); put list(a); end p;")).toMatch(
      /引数 a が渡されていません/,
    );
  });

  /** 多い分を黙って捨てると、並びを 1 つずらした呼び出しが通ってしまう。 */
  it("引数が多ければ断る", () => {
    expect(refused("call p(1,2); p: proc(a); dcl a fixed bin(15); end p;")).toMatch(
      /引数を 1 個取りますが 2 個/,
    );
  });

  it("STATIC は呼び出しをまたいで残る", () => {
    expect(
      out(`dcl i fixed bin(15); do i=1 to 3; call c; end;
  c: proc; dcl n fixed bin(15) static init(0); n=n+1; put list(n); end c;`),
    ).toBe("1 2 3");
  });
});

describe("STOP", () => {
  it("そこで終わる（誤りではない）", () => {
    expect(out("put list('a'); stop; put list('b');")).toBe("a");
  });

  it("手続きの中からでも全体を終える", () => {
    expect(out("call p; put list('after'); p: proc; put list('in'); stop; end p;")).toBe("in");
  });

  it("ループの中からでも終える", () => {
    expect(out("dcl i fixed bin(15); do i=1 to 9; put list(i); if i=2 then stop; end;")).toBe("1 2");
  });

  it("STOP という名前の変数と共存する（予約語が無い）", () => {
    expect(out("dcl stop fixed bin(15); stop=3; put list(stop);")).toBe("3");
  });

  it("EXIT は STOP を案内して断る", () => {
    expect(refused("exit;")).toMatch(/STOP/);
  });
});

describe("代入文", () => {
  it("左辺を並べて書ける", () => {
    expect(out("dcl (a,b,c) fixed bin(15); a,b,c = 1+1; put list(a,b,c);")).toBe("2 2 2");
  });

  it("並べた左辺に添字や修飾名も書ける", () => {
    expect(out("dcl x(3) fixed bin(15); x(1),x(3) = 5; put list(x(1),x(2),x(3));")).toBe("5 0 5");
    expect(
      out("dcl 1 r, 2 a fixed bin(15), 2 b fixed bin(15); r.a,r.b = 4; put list(r.a,r.b);"),
    ).toBe("4 4");
  });

  /** 左辺ごとに評価し直すと、関数の副作用が左辺の数だけ起きる。 */
  it("右辺は 1 度だけ評価する", () => {
    expect(
      out(`dcl (a,b) fixed bin(15); a,b = f(); put list(a,b);
  f: proc returns(fixed bin(15)); dcl n fixed bin(15) static init(0); n=n+1; return(n); end f;`),
    ).toBe("1 1");
  });

  it("配列へのスカラ代入は全要素へ配る", () => {
    expect(out("dcl a(3) fixed bin(15); a=7; put list(a);")).toBe("7 7 7");
  });

  it("配列式は要素ごとに計算する", () => {
    expect(
      out(`dcl a(3) fixed bin(15); dcl b(3) fixed bin(15); dcl c(3) fixed bin(15);
  a=1; b=2; c=a+b; put list(c);`),
    ).toBe("3 3 3");
  });

  it("構造体まるごとの代入は葉を宣言順に突き合わせる", () => {
    expect(
      out(`dcl 1 r, 2 a fixed bin(15), 2 b char(2);
  dcl 1 s, 2 a fixed bin(15), 2 b char(2);
  r.a=1; r.b='xy'; s=r; put list(s.a,s.b);`),
    ).toBe("1 xy");
  });

  it("SUBSTR は擬似変数として左辺に書ける", () => {
    expect(out("dcl s char(5); s='abcde'; substr(s,2,3)='XYZ'; put list(s);")).toBe("aXYZe");
  });

  it("ポインタ修飾も左辺に書ける", () => {
    expect(
      out(`dcl (p,q) pointer; dcl cell fixed bin(15) based(p);
  allocate cell set(p); allocate cell set(q);
  p->cell, q->cell = 9; put list(p->cell, q->cell);`),
    ).toBe("9 9");
  });
});

describe("DECLARE の形", () => {
  it("括り出した宣言", () => {
    expect(out("dcl (a,b) fixed bin(15); a=1; b=2; put list(a,b);")).toBe("1 2");
    expect(out("dcl (a,b)(3) fixed bin(15); a(1)=1; b(3)=2; put list(a(1),b(3));")).toBe("1 2");
  });

  it("属性の順序は問わない", () => {
    expect(out("dcl n bin fixed(15); n=3; put list(n);")).toBe("3");
    expect(out("dcl n fixed binary(31); n=3; put list(n);")).toBe("3");
  });

  it("配列の下限を明示できる", () => {
    expect(out("dcl a(0:9) fixed bin(15); a(0)=5; put list(a(0),lbound(a,1),hbound(a,1));")).toBe("5 0 9");
    expect(out("dcl a(-2:2) fixed bin(15); a(-2)=1; put list(a(-2),dim(a,1));")).toBe("1 5");
  });

  it("多次元配列", () => {
    expect(out("dcl a(2,3) fixed bin(15); a(2,3)=9; put list(a(2,3));")).toBe("9");
  });

  it("INITIAL（綴りは INIT でも、値は式でもよい）", () => {
    expect(out("dcl a(3) fixed bin(15) init(1,2,3); put list(a);")).toBe("1 2 3");
    expect(out("dcl n fixed bin(15) initial(3+4); put list(n);")).toBe("7");
  });

  it("CHAR VARYING / BIT / POINTER / PICTURE", () => {
    expect(out("dcl s char(5) varying; s='ab'; put list(length(s));")).toBe("2");
    expect(out("dcl b bit(4) init('1010'b); put list(b);")).toBe("'1010'B");
    expect(out("dcl p pointer init(null()); if p=null() then put list('null');")).toBe("null");
    expect(out("dcl p pic'999'; p=42; put list(p);")).toBe("042");
  });

  it("構造体は階層を重ねられる", () => {
    expect(out("dcl 1 r, 2 x, 3 y fixed bin(15); r.x.y=3; put list(r.x.y);")).toBe("3");
  });

  it("型を 1 語も書かない宣言は暗黙宣言と同じ規則", () => {
    // I〜N で始まれば FIXED BIN(15)、それ以外は FLOAT DEC(6)
    expect(out("dcl i; i=5; put list(i);")).toBe("5");
    expect(out("dcl x; x=5; put list(x);")).toBe("5.00000E+0000");
  });

  it("CHAR(*) は引数でなければ断る", () => {
    expect(refused("dcl s char(*); put list('x');")).toMatch(/引数ではないので/);
  });

  it("(*) は CHAR と BIT にだけ書ける", () => {
    expect(refused("dcl n fixed(*); put list('x');")).toMatch(/CHAR と BIT/);
  });
});

describe("式と演算子", () => {
  it("優先順位は ** > 単項 > * / > + - > || > 比較 > & > |", () => {
    expect(out("put list(2+3*4);")).toBe("14");
    expect(out("put list((2+3)*4);")).toBe("20");
    expect(out("put list(-2**2);")).toBe("-4");
    expect(out("if 1=1 | 1=0 & 1=0 then put list('y'); else put list('n');")).toBe("y");
  });

  it("** は右結合", () => {
    // 2**(3**2) = 512。精度の規定を超えるので FLOAT になる（engine/README.md）
    expect(out("put list(2**3**2);")).toBe("5.12E+0002");
    expect(out("put list((2**3)**2);")).toBe("64");
  });

  it("比較演算子（否定付きを含む）", () => {
    expect(out("if 1 ¬= 2 then put list('a');")).toBe("a");
    expect(out("if 1 ^= 2 then put list('a');")).toBe("a");
    expect(out("if 1 ¬< 1 then put list('b');")).toBe("b");
    expect(out("if 1 ¬> 1 then put list('c');")).toBe("c");
  });

  it("連結と文字の比較", () => {
    expect(out("put list('n=' || 5);")).toBe("n= 5");
    expect(out("if 'A' < 'a' then put list('y');")).toBe("y");
  });

  it("ビット列の論理演算", () => {
    expect(out("put list('1100'b & '1010'b, '1100'b | '1010'b, ¬'1100'b);")).toBe(
      "'1000'B '1110'B '0011'B",
    );
  });

  it("16 進定数は文字定数（X 接尾辞）", () => {
    expect(out("dcl s char(2); s='4142'x; put list(s);")).toBe("AB");
  });

  it("引用符は 2 つ重ねて書く", () => {
    expect(out("put list('it''s');")).toBe("it's");
  });

  /**
   * 文字列から BIT への変換は 0/1 しか受けない。
   * 検査しないと `'abc00000'B` という「ビットでないビット列」ができ、
   * `&` や `|` が黙って誤った答えを返す。
   */
  it("0 と 1 以外の文字は BIT にできない", () => {
    expect(out("dcl b bit(4); dcl s char(4); s='1010'; b=s; put list(b);")).toBe("'1010'B");
    expect(refused("dcl b bit(8); dcl s char(3); s='abc'; b=s;")).toMatch(/ビット列にできません/);
    // 宣言の長さに合わせて空白が入るので、短く書いた場合も断られる
    expect(refused("dcl b bit(8); dcl s char(8); s='1010'; b=s;")).toMatch(/ビット列にできません/);
  });

  it("ポインタは等値比較だけ", () => {
    expect(
      out("dcl (p,q) pointer; dcl c fixed bin(15) based(p); allocate c set(p); q=p; if p=q then put list('same');"),
    ).toBe("same");
    expect(refused("dcl p pointer; if p=0 then put list('x');")).toMatch(/ポインタ/);
  });
});

describe("ストリーム入出力", () => {
  it("PUT の制御オプション", () => {
    expect(out("put skip(2) list('a');")).toBe("a");
    expect(out("put page list('a');")).toBe("a");
    expect(out("put line(3) list('a');")).toBe("a");
    expect(out("put file(sysprint) list('a');")).toBe("a");
    expect(out("put list('a') skip list('b');")).toBe("a b");
  });

  it("PUT EDIT の書式項目", () => {
    expect(out("put edit(1,'ab')(f(3),a(2));")).toBe("1ab");
    expect(out("put edit(1,2,3)((3)f(2));")).toBe("1 2 3");
    expect(out("put edit('a','b')(a(1),x(2),a(1));")).toBe("a b");
  });

  /** `GET STRING` と対になる形。書式の結果を変数へ受ける。 */
  it("PUT STRING は文字変数へ書く", () => {
    // F(3) の 3 桁を書いた残りは、宣言の長さまで空白で埋まる
    expect(raw("dcl s char(10); put string(s) edit(7)(f(3)); put list('['||s||']');")).toBe(
      "[  7       ] \n",
    );
    // 非 PRINT の並びなので、文字データは引用符付きになる（GET LIST で読み戻せる形）
    expect(out("dcl s char(10); put string(s) list('ab'); put list('['||s||']');")).toBe("['ab' ]");
    // VARYING なら書いた分だけの長さになる
    expect(out("dcl s char(20) varying; put string(s) edit('x')(a); put list(length(s));")).toBe("1");
  });

  it("PUT STRING に行の制御は書けない", () => {
    expect(refused("dcl s char(10); put string(s) skip list('a');")).toMatch(/行の概念/);
    expect(refused("dcl s char(10); put string(s) file(sysprint) list('a');")).toMatch(
      /STRING と FILE/,
    );
  });

  it("PUT STRING の結果が収まらなければ断る", () => {
    expect(refused("dcl s char(3); put string(s) edit(12345)(f(5));")).toMatch(/収まりません/);
  });

  it("GET STRING は文字列から読む", () => {
    expect(out("dcl (a,b) fixed bin(15); get string('3 4') list(a,b); put list(a+b);")).toBe("7");
    expect(out("dcl s char(3); get string('abc') edit(s)(a(3)); put list(s);")).toBe("abc");
  });

  it("入力が尽きれば ENDFILE", () => {
    expect(refused("dcl n fixed bin(15); get list(n);")).toMatch(/ENDFILE/);
  });
});

describe("ON 条件と SIGNAL", () => {
  it("ON 単位を置いて SIGNAL で起こす", () => {
    const r = runProgram(MAIN("on error put list('caught'); signal error;"));
    expect(r.stdout.trim()).toBe("caught");
  });

  it("ON 単位に BEGIN ブロックを置ける", () => {
    const r = runProgram(MAIN("on error begin; put list('a'); put list('b'); end; signal error;"));
    expect(r.stdout.replace(/\s+/g, " ").trim()).toBe("a b");
  });

  it("入出力の条件は ON 単位から復帰して続行する", () => {
    expect(out("on endfile(sysin) put list('eof'); signal endfile(sysin); put list('after');")).toBe(
      "eof after",
    );
  });

  it("ON ... SYSTEM は ON 単位を解除する", () => {
    const r = runProgram(MAIN("on error put list('c'); on error system; signal error;"));
    expect(r.stdout.trim()).toBe("");
  });

  it("計算の条件は ON 単位を通ってから終える", () => {
    for (const [body, cond] of [
      ["dcl (a,b) fixed bin(15); on zerodivide put list('zd'); a=1; b=0; a=a/b;", "zd"],
      ["dcl n fixed bin(15); on fixedoverflow put list('fo'); n=40000;", "fo"],
      ["dcl p pic'99'; on size put list('sz'); p=1234;", "sz"],
      ["dcl a(3) fixed bin(15); on subscriptrange put list('sr'); a(9)=1;", "sr"],
      ["dcl n fixed bin(15); dcl s char(3); on conversion put list('cv'); s='ab'; n=s;", "cv"],
    ] as const) {
      const r = runProgram(MAIN(body));
      expect(r.ok, body).toBe(false);
      expect(r.stdout.trim(), body).toBe(cond);
    }
  });

  it("ON 単位が無ければ意味の分かる誤りで止める", () => {
    expect(refused("dcl a(3) fixed bin(15); put list(a(9));")).toMatch(/添字が範囲外/);
    expect(refused("dcl n fixed bin(15); dcl s char(3); s='ab'; n=s;")).toMatch(/変換できません/);
  });
});

/**
 * 未実装の棚卸し。
 *
 * この処理系の約束は「できないことは黙って動かさず、名指しで断る」。
 * 素の「解釈できません」に落ちると綴り間違いと未実装の区別が付かないので、
 * 使われる形については名前が出ることを固定する。
 */
describe("名指しで断るもの", () => {
  it("構造体の BY NAME 代入", () => {
    expect(
      refused("dcl 1 r, 2 a fixed bin(15); dcl 1 t, 2 a fixed bin(15); t = r, by name;"),
    ).toMatch(/BY NAME は未実装/);
  });

  it("PUT DATA / GET DATA（データ指示入出力）", () => {
    expect(refused("dcl n fixed bin(15); put data(n);")).toMatch(/PUT DATA は未実装/);
    expect(refused("dcl n fixed bin(15); get data(n);")).toMatch(/GET DATA は未実装/);
  });

  it("INITIAL の繰り返し係数", () => {
    expect(refused("dcl a(3) fixed bin(15) init((3)0);")).toMatch(/繰り返し係数/);
  });

  it("構造体の配列", () => {
    expect(refused("dcl 1 r(2), 2 a fixed bin(15); put list('x');")).toMatch(/構造体の配列/);
  });

  it("未実装の文", () => {
    for (const [src, word] of [
      ["display('x');", "DISPLAY"],
      ["delay(1);", "DELAY"],
      ["revert error;", "REVERT"],
      ["wait(e);", "WAIT"],
      ["default range(*) fixed;", "DEFAULT"],
    ] as const) {
      expect(refused(src), src).toMatch(new RegExp(`${word} は未実装`));
    }
  });

  it("未実装の属性", () => {
    for (const [src, word] of [
      ["dcl f file keyed; put list('x');", "KEYED"],
      ["dcl a area; put list('x');", "AREA"],
      ["dcl 1 r like s; put list('x');", "LIKE"],
      ["dcl 1 u union, 2 a fixed bin(15); put list('x');", "UNION"],
      ["dcl x controlled; put list('x');", "CONTROLLED"],
      ["dcl l label; put list('x');", "LABEL"],
    ] as const) {
      expect(refused(src), src).toMatch(new RegExp(`${word} は未実装`));
    }
  });

  it("未実装の組込関数と、知らない関数", () => {
    expect(refused("put list(sqrt(4));")).toMatch(/組込関数 sqrt/);
    expect(refused("put list(date());")).toMatch(/組込関数 date/);
    expect(refused("put list(frobnicate(4));")).toMatch(/未知の関数/);
  });
});
