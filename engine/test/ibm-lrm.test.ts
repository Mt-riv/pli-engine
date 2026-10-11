/**
 * IBM 公式言語解説書との突き合わせ。
 *
 * 出典は **Enterprise PL/I for z/OS 6.2 Language Reference**（SC27-8940）。
 * 各テストの先頭に規定のページを書く。ページは PDF の通し番号。
 *
 * `grammar.test.ts` が「形が通るか」を見るのに対し、ここは
 * **規定どおりの答えを返すか**を見る。2026-10-11 に解説書 758 ページを
 * 章ごとに突き合わせたとき、全テスト緑のまま 41 件の「黙って誤る」が残っていた。
 * 原因は 10 のかたまりに集まるので、describe もそのかたまりで並べる。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost, runProgram } from "../src/index.js";

const MAIN = (body: string) => `m: proc options(main);\n${body}\nend m;`;

/** 通ったときの標準出力（空白の並びは潰す）。 */
function out(body: string): string {
  const r = runProgram(MAIN(body), { maxSteps: 200_000 });
  if (!r.ok) {
    const why = r.diagnostics.map((d) => `${d.line}行: ${d.message}`).join(" / ");
    throw new Error(`通らなかった: ${why}`);
  }
  return r.stdout.replace(/\s+/g, " ").trim();
}

/** 空白を潰さない標準出力。桁の埋まり方を見るときに使う。 */
function raw(body: string): string {
  const r = runProgram(MAIN(body), { maxSteps: 200_000 });
  if (!r.ok) {
    const why = r.diagnostics.map((d) => `${d.line}行: ${d.message}`).join(" / ");
    throw new Error(`通らなかった: ${why}`);
  }
  return r.stdout;
}

/**
 * `put list('['||x||']')` の角括弧の中身を、空白をそのまま取り出す。
 * 桁の埋まり方を見るのに使う（`out` は空白の並びを潰すので使えない）。
 */
function bracketed(body: string): string {
  return (raw(body).match(/\[[^\]]*\]/g) ?? []).join(" ");
}

/** 断られたときの 1 つ目の診断。 */
function refused(body: string): string {
  const r = runProgram(MAIN(body), { maxSteps: 200_000 });
  expect(r.ok, `断られるはずが通った（出力: ${JSON.stringify(r.stdout)}）`).toBe(false);
  return r.diagnostics[0]?.message ?? "";
}

/**
 * 反復 DO の `BY` だけの指定（p.266）。
 *
 * 「If `TO exp2` is omitted from a specification, and if `BY exp3` is
 * specified, repetitive execution continues until it is terminated by
 * the WHILE or UNTIL option」。手順の記述（p.268）も
 * 「If the TO, BY, and REPEAT options are all absent, leave the do-group」。
 *
 * `REPEAT` を足したときに「TO も REPEAT も無ければ単一値」と書いたため、
 * `BY` だけの指定が単一値に落ちて**本体を 1 回実行して黙って終わっていた**。
 * 以前は構文誤りで止まっていたので、黙って誤る形に変えてしまっていた。
 */
describe("DO の BY だけの指定（p.266）", () => {
  it("BY と WHILE で続く", () => {
    expect(out("dcl i fixed bin(15); do i = 1 by 1 while(i < 4); put list(i); end;")).toBe(
      "1 2 3",
    );
  });

  it("BY と UNTIL で続く", () => {
    expect(out("dcl i fixed bin(15); do i = 1 by 2 until(i >= 5); put list(i); end;")).toBe(
      "1 3 5",
    );
  });

  it("BY だけなら LEAVE で抜けるまで続く", () => {
    expect(
      out("dcl i fixed bin(15); do i = 1 by 1; put list(i); if i = 3 then leave; end;"),
    ).toBe("1 2 3");
  });

  it("BY に負の刻みも書ける", () => {
    expect(out("dcl i fixed bin(15); do i = 5 by -2 while(i > 0); put list(i); end;")).toBe(
      "5 3 1",
    );
  });

  it("TO も BY も REPEAT も無ければ 1 回だけ（p.268）", () => {
    expect(out("dcl i fixed bin(15); do i = 1; put list(i); end;")).toBe("1");
    expect(out("dcl i fixed bin(15); do i = 1, 5, 9; put list(i); end;")).toBe("1 5 9");
  });
});

/**
 * 引数の束縛（p.161-162）。
 *
 * 「A reference to a parameter in a procedure is a reference to the
 * corresponding argument. Any change to the value of a parameter is
 * actually a change to the value of the corresponding argument」（p.161）。
 * ダミー引数（値渡し）になるのは**定数・演算子や括弧や関数参照を含む式・
 * 属性が違う場合**だけ（p.162）。添字付きの参照はどれにも当たらない。
 */
describe("引数は参照渡し（p.161）", () => {
  it("配列の要素を渡して入れ替えられる", () => {
    expect(
      out(`dcl a(2) fixed bin(15) init(1,2);
  call swap(a(1), a(2));
  put list(a(1), a(2));
  swap: proc(x,y); dcl (x,y) fixed bin(15); dcl t fixed bin(15);
    t = x; x = y; y = t; end swap;`),
    ).toBe("2 1");
  });

  it("配列の要素を出力引数にできる", () => {
    expect(
      out(`dcl a(3) fixed bin(15);
  call fill(a(2));
  put list(a(1), a(2), a(3));
  fill: proc(o); dcl o fixed bin(15); o = 7; end fill;`),
    ).toBe("0 7 0");
  });

  it("ポインタ先を渡しても書き戻る", () => {
    expect(
      out(`dcl q pointer; dcl cell fixed bin(15) based(q);
  allocate cell set(q); cell = 1;
  call fill(q -> cell);
  put list(q -> cell);
  fill: proc(o); dcl o fixed bin(15); o = 9; end fill;`),
    ).toBe("9");
  });

  it("文字列の要素でも書き戻る", () => {
    expect(
      out(`dcl a(2) char(3) init('abc','def');
  call fill(a(2));
  put list(a(1), a(2));
  fill: proc(o); dcl o char(3); o = 'XYZ'; end fill;`),
    ).toBe("abc XYZ");
  });

  it("構造体の葉とスカラは従来どおり書き戻る", () => {
    expect(
      out(`dcl 1 r, 2 f fixed bin(15) init(1);
  dcl s fixed bin(15) init(1);
  call fill(r.f); call fill(s);
  put list(r.f, s);
  fill: proc(o); dcl o fixed bin(15); o = 5; end fill;`),
    ).toBe("5 5");
  });

  /** 括弧は「書き換えさせない」と明示する唯一の記法（p.162）。 */
  it("括弧で包んだ引数はダミーになる", () => {
    expect(
      out(`dcl x fixed bin(15) init(1);
  call p((x));
  put list(x);
  p: proc(a); dcl a fixed bin(15); a = 9; end p;`),
    ).toBe("1");
    // 添字付きでも同じ
    expect(
      out(`dcl a(2) fixed bin(15) init(1,2);
  call p((a(1)));
  put list(a(1));
  p: proc(z); dcl z fixed bin(15); z = 9; end p;`),
    ).toBe("1");
  });

  it("定数と式はダミーのまま", () => {
    expect(
      out(`dcl x fixed bin(15) init(1);
  call p(x + 0);
  put list(x);
  p: proc(a); dcl a fixed bin(15); a = 9; end p;`),
    ).toBe("1");
  });
});

/**
 * 組込関数の配列引数（p.430）。
 *
 * 「Specifying an array argument is equivalent to placing the function
 * reference ... in a do-group」。`ADDR` と配列処理関数（`DIM` / `LBOUND` /
 * `HBOUND`）だけはスカラを返す。
 */
describe("組込関数の配列引数（p.430）", () => {
  it("要素ごとに適用する", () => {
    expect(
      out(`dcl a(3) fixed bin(31) init(-1,-2,-3);
  dcl b(3) fixed bin(31);
  b = abs(a);
  put list(b);`),
    ).toBe("1 2 3");
  });

  it("規定の例（SUBSTR に配列の引数）", () => {
    // dcl B(2) char(2) init('AB','CD'); dcl C(2) fixed bin init(1,2);
    // A = substr(B,1,C); は A(1)='A'、A(2)='CD'
    expect(
      out(`dcl a(2) char(2) varying;
  dcl b(2) char(2) init('AB','CD');
  dcl c(2) fixed bin(31) init(1,2);
  a = substr(b,1,c);
  put list('['||a(1)||']', '['||a(2)||']');`),
    ).toBe("[A] [CD]");
  });

  it("配列処理関数はスカラを返す", () => {
    expect(out("dcl a(4) fixed bin(15); put list(dim(a,1), lbound(a,1), hbound(a,1));")).toBe(
      "4 1 4",
    );
  });
});

/** ADDR（p.457）。「the returned value takes into account subscripting」。 */
describe("ADDR（p.457）", () => {
  it("添字を反映する", () => {
    expect(
      out(`dcl a(3) fixed bin(31) init(10,20,30);
  dcl p pointer; dcl r fixed bin(31) based(p);
  p = addr(a(2));
  put list(r);`),
    ).toBe("20");
  });

  it("添字越しの書き込みがその要素に届く", () => {
    expect(
      out(`dcl a(3) fixed bin(31) init(10,20,30);
  dcl p pointer; dcl r fixed bin(31) based(p);
  p = addr(a(2));
  r = 99;
  put list(a(1), a(2), a(3));`),
    ).toBe("10 99 30");
  });

  it("同じ変数を指すポインタは等しい", () => {
    expect(
      out(`dcl x fixed bin(31) init(5);
  dcl (p,q) pointer;
  p = addr(x); q = addr(x);
  if p = q then put list('eq'); else put list('ne');
  if addr(x) = addr(x) then put list('eq2'); else put list('ne2');`),
    ).toBe("eq eq2");
  });

  it("別の変数・別の要素を指すポインタは等しくない", () => {
    expect(
      out(`dcl (x,y) fixed bin(31);
  dcl a(2) fixed bin(31);
  if addr(x) = addr(y) then put list('same'); else put list('diff');
  if addr(a(1)) = addr(a(2)) then put list('same2'); else put list('diff2');
  if addr(a(1)) = addr(a(1)) then put list('eq3'); else put list('ne3');`),
    ).toBe("diff diff2 eq3");
  });
});

/**
 * ビット列（p.119-121, p.137-139）。
 *
 * 3 つの経路が規定とずれていた。ビット列**同士**の `&` `|` `¬`
 * （短い側を `'0'B` で埋める・結果長は長い方）は実機と突き合わせて
 * 正しかったので、抜けていたのは比較と変換の側だけ。
 */
describe("ビット列の比較は短い側を '0'B で埋める（p.119）", () => {
  it("長さが違っても値が同じなら等しい", () => {
    expect(out("dcl flags bit(8) init('1'b); put list(flags = '1'b);")).toBe("'1'B");
    expect(out("put list('10'b = '1000'b);")).toBe("'1'B");
    expect(out("put list('1'b < '10'b);")).toBe("'0'B");
  });

  it("値が違えば大小も照合順序で決まる", () => {
    expect(out("put list('0'b < '1'b, '11'b > '101'b);")).toBe("'1'B '1'B");
  });
});

describe("非 BIT のオペランドは BIT 列へ変換する（p.121）", () => {
  /**
   * 「All non-BIT data is converted to BIT」。算術からの中間ビット列は
   * FIXED DEC(1,0) なら CEIL(1*3.32)=4 桁なので、1 は `'0001'B`、
   * 2 は `'0010'B` になる。したがって `2 & 1` は `'0000'B`（偽）。
   */
  it("算術のオペランドはビットごとの演算になる", () => {
    expect(out("put list(2 & 1);")).toBe("'0000'B");
    expect(out("put list(1 | 2);")).toBe("'0011'B");
    expect(out("put list(¬ 1);")).toBe("'1110'B");
  });

  it("分岐も規定どおり（2 & 1 は偽）", () => {
    expect(out("if 2 & 1 then put list('TRUE'); else put list('FALSE');")).toBe("FALSE");
    expect(out("if 3 & 1 then put list('TRUE'); else put list('FALSE');")).toBe("TRUE");
  });

  it("BIT(1) 同士はブール演算と一致する（従来どおり）", () => {
    expect(out("put list('1'b & '0'b, '1'b | '0'b);")).toBe("'0'B '1'B");
  });

  it("比較の結果を論理演算に使える", () => {
    expect(out("dcl i fixed bin(15) init(5); if i > 0 & i < 9 then put list('in');")).toBe("in");
  });

  it("文字のオペランドも 0/1 なら変換する", () => {
    expect(out("dcl c char(2) init('10'); put list(c & '1011'b);")).toBe("'1000'B");
  });
});

describe("算術から BIT への代入は左詰め（p.137-139）", () => {
  /**
   * 規定の例（p.139）がそのまま載っている。
   *   A=1;   /* A has value '0'B     *\/   (A は BIT(1))
   *   D=1;   /* D has value '00010'B *\/   (D は BIT(5))
   * 「The branch is to X」（p.140。`if A=1` は偽）。
   * 中間ビット列を作って**文字列代入の規則**（右を切る・右を埋める、p.128）
   * で詰めるため。右詰めにすると PL/I で最も有名な落とし穴が逆になる。
   */
  it("規定の例と一致する", () => {
    expect(out("dcl a bit(1); a = 1; put list(a);")).toBe("'0'B");
    expect(out("dcl d bit(5); d = 1; put list(d);")).toBe("'00010'B");
    expect(out("dcl a bit(1); a = 1; if a = 1 then put list('Y'); else put list('X');")).toBe("X");
  });

  it("中間ビット列の長さは精度から決まる", () => {
    // 5 は FIXED DEC(1,0) なので 4 桁の '0101'B
    expect(out("dcl s bit(4); s = 5; put list(s);")).toBe("'0101'B");
    // FIXED BIN(15) の 3 は 15 桁なので、左の 4 桁は 0
    expect(out("dcl b bit(4); dcl i fixed bin(15) init(3); b = i; put list(b);")).toBe("'0000'B");
  });

  it("ビット列同士の代入は従来どおり右を埋める（p.128）", () => {
    expect(out("dcl c bit(6); c = '101'b; put list(c);")).toBe("'101000'B");
  });
});

describe("ビット列を返すもの", () => {
  it("SUBSTR はビット列からビット列を返す（p.613）", () => {
    expect(out("dcl a bit(6) init('010111'b); put list(substr(a,1,1), substr(a,2,3));")).toBe(
      "'0'B '101'B",
    );
  });

  it("ビット列同士の連結はビット列（p.120 Table 31）", () => {
    expect(out("put list('010111'b || '101'b);")).toBe("'010111101'B");
  });

  it("規定の例（Table 31 の SUBSTR と比較の論理和）", () => {
    // SUBSTR(A,1,1)|(D=5) は '1'B
    expect(
      out("dcl a bit(6) init('010111'b); dcl d fixed bin(15) init(5); put list(substr(a,1,1) | (d=5));"),
    ).toBe("'1'B");
  });
});

/**
 * `DEFINED`（p.317-321）。
 *
 * 「A change to the base variable's value is a corresponding change to the
 * value of the defined variable, and vice versa」「The defined variable does
 * not inherit any attributes from the base variable」（p.317）。
 *
 * 基底参照に添字を書かない形（規定の例そのもの）で、別名側の添字が
 * 捨てられて**基底の先頭要素**を指していた。読めば嘘を返し、
 * 書けば基底の別の要素を壊す形だった。
 */
describe("DEFINED の単純定義（p.318）", () => {
  it("別名側の添字が基底の同じ位置を指す", () => {
    expect(
      out(`dcl a(10) fixed bin(15) init(1,2,3,4,5,6,7,8,9,10);
  dcl b(5) fixed bin(15) defined(a);
  put list(b(1), b(5));`),
    ).toBe("1 5");
  });

  it("別名への書き込みが基底のその要素へ届く", () => {
    expect(
      out(`dcl a(10) fixed bin(15) init(1,2,3,4,5,6,7,8,9,10);
  dcl b(5) fixed bin(15) defined(a);
  b(2) = 99;
  put list(a(1), a(2), a(3));`),
    ).toBe("1 99 3");
  });

  it("スカラの別名も基底の先頭を指す", () => {
    expect(
      out(`dcl a(3) fixed bin(15) init(7,8,9);
  dcl s fixed bin(15) defined(a);
  put list(s);
  s = 1;
  put list(a(1));`),
    ).toBe("7 1");
  });

  it("多次元でも位置が対応する", () => {
    expect(
      out(`dcl a(2,3) fixed bin(15) init(1,2,3,4,5,6);
  dcl b(2,3) fixed bin(15) defined(a);
  put list(b(1,1), b(2,3));
  b(2,1) = 40;
  put list(a(2,1));`),
    ).toBe("1 6 40");
  });

  it("基底に定数の添字を書いた形は従来どおり", () => {
    expect(
      out(`dcl a(2,3) fixed bin(15) init(1,2,3,4,5,6);
  dcl x fixed bin(15) defined(a(2,3));
  put list(x);`),
    ).toBe("6");
  });

  it("iSUB 定義は従来どおり", () => {
    expect(
      out(`dcl b(3,3) fixed bin(15) init(1,2,3,4,5,6,7,8,9);
  dcl d(3) fixed bin(15) defined(b(1sub,1sub));
  put list(d(1), d(2), d(3));`),
    ).toBe("1 5 9");
  });

  /** 別名が基底より大きい形は規定の誤り（p.318）。 */
  it("基底の範囲を超える別名は断る", () => {
    expect(refused("dcl a(3) fixed bin(15); dcl b(5) fixed bin(15) defined(a); b(5) = 1;")).toMatch(
      /DEFINED/,
    );
  });

  /**
   * 文字列重ね合わせ定義（p.320）は**枡の一部**への別名なので、
   * 枡の単位で持つこの処理系の記憶域では表せない。
   * 黙って基底まるごとの別名にすると、読みでは余分な桁が混ざり、
   * 書きでは基底の他の桁を巻き込んで壊すので、名指しで断る。
   */
  it("文字列重ね合わせ定義は名指しで断る", () => {
    expect(
      refused("dcl c char(10) init('abcdefghij'); dcl y char(5) defined(c); put list(y);"),
    ).toMatch(/文字列重ね合わせ定義/);
    expect(
      refused("dcl c char(6) init('abcdef'); dcl d(6) char(1) defined(c); put list(d(1));"),
    ).toMatch(/文字列重ね合わせ定義/);
  });

  it("型の違う別名も断る", () => {
    expect(
      refused("dcl c char(10) init('abcdefghij'); dcl i fixed bin(31) defined(c); put list(i);"),
    ).toMatch(/DEFINED/);
  });
});

/**
 * ストリーム入力（p.303-323）。
 *
 * 3 つの経路が規定とずれていた。どれも**黙って別の値を変数に入れる**。
 */
describe("GET EDIT の F(w,d)（p.323）", () => {
  /**
   * 「If no scaling-factor is specified and no decimal point appears in
   * the field, the expression for fractional-digits specifies the number
   * of digits in the data value to the right of the assumed decimal point」。
   * 小数点を書かない固定桁の入力（金額・率）を読む定石。
   * `d` を無視すると黙って 10^d 倍になる。
   */
  it("小数点が無い欄は d 桁を小数とみなす", () => {
    expect(out("dcl x fixed dec(7,2); get string('12345') edit(x)(f(5,2)); put list(x);")).toBe(
      "123.45",
    );
    expect(out("dcl x fixed dec(7,2); get string('-12345') edit(x)(f(6,2)); put list(x);")).toBe(
      "-123.45",
    );
    expect(out("dcl x fixed dec(7,3); get string('5') edit(x)(f(1,3)); put list(x);")).toBe("0.005");
  });

  it("小数点が書いてあればそのまま読む", () => {
    expect(out("dcl x fixed dec(7,2); get string('1.50') edit(x)(f(4,2)); put list(x);")).toBe(
      "1.50",
    );
  });

  it("d を書かなければ整数として読む", () => {
    expect(out("dcl x fixed dec(7,2); get string('12345') edit(x)(f(5)); put list(x);")).toBe(
      "12345.00",
    );
  });
});

describe("GET EDIT は読んだ値をすぐ代入する（p.311）", () => {
  /**
   * 「A value read into a variable can be used in a format item that is
   * associated with another variable later in the data list」。
   * 規定の例は `get edit (M,String_A,…)(F(2),A(M),…)`。
   * 代入をデータリストの読み終わりまで遅らせると、`A(M)` が 0 を見て
   * 「幅省略の A」＝行の残り全部になる（自己記述レコードが壊れる）。
   */
  it("先に読んだ値を後の書式の幅に使える", () => {
    expect(
      out(`dcl n fixed bin(15);
  dcl sa char(10);
  get string('03abcdefg') edit(n,sa)(f(2),a(n));
  put list(n, '['||sa||']');`),
    ).toBe("3 [abc ]");
  });
});

describe("GET LIST の空フィールド（p.314）", () => {
  /**
   * 「A null field in the stream is indicated either by the first nonblank
   * character in the data stream being a comma, or by two commas separated
   * by an arbitrary number of blanks. A null field specifies that the value
   * of the associated data-list item remains unchanged」。
   * カンマを区切りとして食うと、値が 1 つずれて別の変数に入る。
   */
  it("先頭のカンマは空フィールド（値を変えない）", () => {
    expect(
      out("dcl (a,b) fixed bin(15) init(7,8); get string(',5') list(a,b); put list(a,b);"),
    ).toBe("7 5");
  });

  it("続いたカンマも空フィールド", () => {
    expect(
      // 括り出した宣言の INIT は各名前に同じ並びを適用するので、
      // 初期値を見分けたいときは 1 つずつ宣言する
      out(`dcl a fixed bin(15) init(7);
  dcl b fixed bin(15) init(8);
  dcl c fixed bin(15) init(9);
  get string('1,,3') list(a,b,c);
  put list(a,b,c);`),
    ).toBe("1 8 3");
  });

  it("ふつうの区切りは従来どおり", () => {
    expect(
      out("dcl (a,b) fixed bin(15); get string('1,2') list(a,b); put list(a,b);"),
    ).toBe("1 2");
    expect(
      out("dcl (a,b) fixed bin(15); get string('1 2') list(a,b); put list(a,b);"),
    ).toBe("1 2");
  });
});

describe("文字から算術への変換（p.132）", () => {
  /**
   * 「If the source is a null string or a string of one or more blanks,
   * the target will be assigned the value zero. The CONVERSION condition
   * will not be raised」。固定長レコードの未入力の数値欄を読む定石。
   */
  it("空白だけの文字列は 0（条件は上げない）", () => {
    expect(out("dcl c char(4) init('    '); dcl n fixed bin(15); n = c; put list(n);")).toBe("0");
    expect(
      out("dcl c char(4) varying init(''); dcl n fixed bin(15); n = c; put list(n);"),
    ).toBe("0");
  });

  /** 「The source string must represent a valid arithmetic constant」。 */
  it("指数付きの文字列も算術定数（GET と同じ扱い）", () => {
    expect(
      out("dcl c char(8) init('1.5E3'); dcl f float dec(6); f = c; put list(f);"),
    ).toBe("1.50000E+0003");
  });

  it("数値にならない文字列は CONVERSION", () => {
    expect(refused("dcl c char(4) init('ab'); dcl n fixed bin(15); n = c;")).toMatch(
      /変換できません/,
    );
  });
});

/**
 * 宣言の有効範囲（p.201）。
 *
 * 「The scope of an explicit declaration of a name is the block containing
 * the declaration. This includes all contained blocks」。
 * `DECLARE` は実行文ではないので、**名前を使う文より後ろに書いても効く**。
 *
 * 文として実行していたため、後ろに置いた宣言が記憶域を 0 で作り直し、
 * 先の代入が黙って消えていた。Linter はブロック単位で正しく見ていたので
 * 指摘が出ず、両方を走らせても気づけない形だった。
 */
describe("DECLARE は実行文ではない（p.201）", () => {
  it("使う文より後ろの宣言も効く", () => {
    expect(out("i = 5;\n  dcl i fixed dec(7,2);\n  put list(i);")).toBe("5.00");
  });

  it("後ろの宣言の INITIAL はブロックに入った時点で効く", () => {
    expect(
      out(`call sub;
  dcl n fixed bin(15) init(7);
  sub: proc; put list(n); end sub;`),
    ).toBe("7");
  });

  it("文字列の宣言が後ろにあっても型が決まっている", () => {
    expect(out("s = 'abcde';\n  dcl s char(5);\n  put list(s);")).toBe("abcde");
  });

  it("DO 群の中の宣言もブロック全体で効く", () => {
    expect(
      out(`dcl i fixed bin(15);
  do i = 1 to 2;
    dcl n fixed bin(15);
    n = n + 1;
  end;
  put list(n);`),
    ).toBe("2");
  });

  it("後ろへ飛ぶ GOTO で初期値に戻らない", () => {
    expect(
      out(`dcl i fixed bin(15) init(0);
  top: i = i + 1;
  dcl n fixed bin(15) init(10);
  n = n + 1;
  if i < 3 then goto top;
  put list(i, n);`),
    ).toBe("3 13");
  });

  it("入れ子のブロックの宣言は外へ漏れない", () => {
    expect(
      out(`dcl x fixed bin(15) init(1);
  begin;
    x = 2;
    dcl x fixed bin(15) init(9);
    put list(x);
  end;
  put list(x);`),
    ).toBe("2 1");
  });

  it("手続きの引数の属性宣言が後ろでも効く", () => {
    expect(
      out(`call p(5);
  p: proc(a);
    put list(a);
    dcl a fixed bin(15);
  end p;`),
    ).toBe("5");
  });
});

/**
 * 組込関数（第 18 章）。
 *
 * 9 つの関数が `asFixed` を共有していて、**FLOAT の引数を
 * FIXED の 15 桁の窓に押し込んで**いた。窓の外（1e-15 未満・1e15 超）で
 * 値が消えるか落ちる。規定は FLOAT を素通しで、CEIL / FLOOR / TRUNC /
 * ROUND は値だけ整数化して型は保つ（p.456/473/498/619）。
 */
describe("FLOAT の引数は素通し（p.456 など）", () => {
  it("SIGN は小さい値でも符号を返す（p.607）", () => {
    expect(out("dcl f float dec(6) init(1e-30); put list(sign(f));")).toBe("1");
    expect(out("dcl f float dec(6) init(-1e-30); put list(sign(f));")).toBe("-1");
  });

  it("ABS は型と値を保つ（p.456）", () => {
    expect(out("dcl f float dec(6) init(-1e-30); put list(abs(f));")).toBe("1.00000E-0030");
  });

  it("CEIL / FLOOR は値を整数化して型を保つ（p.473/498）", () => {
    expect(out("dcl f float dec(6) init(1e-30); put list(ceil(f));")).toBe("1.00000E+0000");
    expect(out("dcl f float dec(6) init(-1e-30); put list(floor(f));")).toBe("-1.00000E+0000");
    expect(out("dcl f float dec(6) init(2.5e0); put list(ceil(f), floor(f));")).toBe(
      "3.00000E+0000 2.00000E+0000",
    );
  });

  it("TRUNC / ROUND は大きい FLOAT でも落ちない（p.619/595）", () => {
    expect(out("dcl f float dec(6) init(1e18); put list(trunc(f) = 1e18);")).toBe("'1'B");
    expect(out("dcl f float dec(6) init(1e18); put list(round(f,0) = 1e18);")).toBe("'1'B");
    expect(out("dcl f float dec(6) init(-2.7e0); put list(trunc(f));")).toBe("-2.00000E+0000");
  });

  it("MAX / MIN も型と値を保つ（p.538）", () => {
    expect(out("dcl f float dec(6) init(1e-30); put list(max(f,0));")).toBe("1.00000E-0030");
    expect(out("dcl f float dec(6) init(1e30); put list(min(f,1e40));")).toBe("1.00000E+0030");
  });

  it("MOD も FLOAT で計算する（p.553）", () => {
    expect(out("dcl f float dec(6) init(7.5e0); put list(mod(f,2e0));")).toBe("1.50000E+0000");
  });

  it("FIXED の引数は従来どおり", () => {
    expect(out("put list(sign(-5), abs(-5), ceil(1.2), floor(-1.2), trunc(1.9));")).toBe(
      "-1 5 2 -2 1",
    );
  });
});

describe("INDEX と VERIFY の開始位置（p.513/635）", () => {
  /**
   * 「You can also specify the location within x where processing begins」。
   * 無視すると、規定が例として載せている走査ループ
   * （`pos = index(t,'man',pos+1)`）が同じ位置を返し続ける。
   */
  it("INDEX は第 3 引数から探す", () => {
    const t = "'Wovon man nicht sprechen kann, darueber muss man schweigen.'";
    expect(out(`dcl t char(59) init(${t}); put list(index(t,'man',1), index(t,'man',8));`)).toBe(
      "7 46",
    );
    expect(out(`dcl t char(59) init(${t}); put list(index(t,'man',47));`)).toBe("0");
  });

  it("VERIFY も第 3 引数から探す", () => {
    expect(
      out("dcl x char(6) init('  a  b'); put list(verify(x,' ',1), verify(x,' ',4), verify(x,' ',7));"),
    ).toBe("3 6 0");
  });

  it("長さ 0 の引数では 0 を返す（p.513）", () => {
    expect(out("put list(index('abc',''), index('','abc'));")).toBe("0 0");
  });
});

describe("MOD は非負の最小値（p.552）", () => {
  /**
   * 「MOD returns the **smallest nonnegative value**, R, such that
   * (x - R)/y = n」。規定の例（p.553）は
   * `mod(+10,+8)=2` / `mod(+10,-8)=2` / `mod(-10,+8)=6` / `mod(-10,-8)=6`。
   *
   * この処理系は「結果は第 2 引数と同じ符号」（他方言の定義）にしていた。
   * 突き合わせに使った実機の値（`mod(7,-3)=1`）の方が規定と一致していて、
   * 実機を誤りと判断した側が間違っていた。
   */
  it("規定の 4 つの例と一致する", () => {
    expect(out("put list(mod(10,8), mod(-10,8), mod(10,-8), mod(-10,-8));")).toBe("2 6 2 6");
  });

  it("割り切れる場合と 0 の扱い", () => {
    expect(out("put list(mod(10,5), mod(-10,5), mod(0,5));")).toBe("0 0 0");
  });

  it("小数でも非負", () => {
    expect(out("put list(mod(7,2.5), mod(-7,2.5));")).toBe("2.0 0.5");
  });
});

describe("CEIL / FLOOR / TRUNC の FIXED BIN の商（p.473/499/620）", () => {
  /**
   * 「If the expression x has the form (y/z) where y is an unscaled
   * FIXED BIN expression and z is an unscaled FIXED expression, then
   * CEIL(x) will be evaluated by computing the integral quotient and then
   * rounding it up by one if ... the remainder of (y/z) is not zero」。
   *
   * FIXED BIN の除算は整数なので、`/` の時点で剰余の情報が消える。
   * 規定がこの特例を置いているのはそのためで、無いと
   * 「切り上げ除算」`ceil(n/size)` が黙って切り捨てになる。
   */
  it("規定の例（x=10, y=8）", () => {
    expect(
      out(`dcl (x,y) fixed bin(31); x = 10; y = 8;
  put list(ceil(x/y), floor(x/y), trunc(x/y));`),
    ).toBe("2 1 1");
  });

  it("規定の例（x=-10, y=8）", () => {
    expect(
      out(`dcl (x,y) fixed bin(31); x = -10; y = 8;
  put list(ceil(x/y), floor(x/y), trunc(x/y));`),
    ).toBe("-1 -2 -1");
  });

  it("割り切れるときは動かない", () => {
    expect(
      out(`dcl (x,y) fixed bin(31); x = 16; y = 8;
  put list(ceil(x/y), floor(x/y), trunc(x/y));`),
    ).toBe("2 2 2");
  });

  it("10 進の除算は従来どおり（剰余が値に残る）", () => {
    expect(out("dcl (x,y) fixed dec(5); x = 10; y = 8; put list(ceil(x/y));")).toBe("2");
  });
});

describe("REPEAT / TRANSLATE の境界", () => {
  /** 「If y is zero or negative, the string x is returned」（p.592）。 */
  it("REPEAT の回数が 0 以下なら元の文字列", () => {
    expect(out("put list('['||repeat('ab',0)||']', '['||repeat('ab',-1)||']');")).toBe(
      "[ab] [ab]",
    );
  });

  /** 「If z is omitted, it defaults to collate()」（p.618）。 */
  it("TRANSLATE の第 3 引数の省略は名指しで断る", () => {
    expect(refused("put list(translate('abc','XYZ'));")).toMatch(/TRANSLATE/);
  });

  it("TRANSLATE の 3 引数形は従来どおり", () => {
    expect(out("put list(translate('abc','xyz','abc'));")).toBe("xyz");
  });
});

describe("組込関数の呼び方の検査", () => {
  it("引数が多ければ断る", () => {
    expect(refused("put list(abs(1,2));")).toMatch(/ABS/);
    expect(refused("put list(length('ab','cd'));")).toMatch(/LENGTH/);
  });

  /** 「y can be omitted only if the array is one-dimensional」（p.487）。 */
  it("多次元配列で次元を省略したら断る", () => {
    expect(refused("dcl b(3,4) fixed bin(15); put list(dim(b));")).toMatch(/次元/);
    expect(out("dcl a(3) fixed bin(15); put list(dim(a));")).toBe("3");
  });

  /** `DIMENSION` が正式名で `DIM` が略形（p.487）。 */
  it("DIMENSION は DIM と同じ", () => {
    expect(out("dcl a(5) fixed bin(15); put list(dimension(a,1), dimension(a));")).toBe("5 5");
  });

  /** 「if not omitted, it must be nonnegative」（p.487）。 */
  it("DIVIDE の尺度が負なら断る", () => {
    expect(refused("put list(divide(10,4,5,-1));")).toMatch(/尺度/);
  });
});

/**
 * PICTURE（第 14 章）。
 *
 * 尺度を決めるのは **`V` と `F` だけ**で、`.` `,` `/` `B` は
 * 挿入文字（p.332/334）。`V` の無いピクチャの `.` を小数点として
 * 扱っていたため、`ZZ9.99` に 12 を入れると 12.00 になっていた
 * （規定は 0.12）。日付の `99.9/99.9` のような使い方では SIZE で落ちていた。
 */
describe("PICTURE の小数点は V と F で決まる（p.332）", () => {
  it("V が無ければ右端に V があるものとして扱う", () => {
    expect(bracketed("dcl a pic'ZZ9.99'; dcl d fixed dec(5) init(12); a = d; put list('['||a||']');")).toBe("[  0.12]");
    expect(bracketed("dcl a pic'99.99'; a = 1234; put list('['||a||']');")).toBe("[12.34]");
  });

  it("小数と無関係な . も挿入文字として置ける（p.335）", () => {
    expect(bracketed("dcl a pic'99.9/99.9'; a = 123456; put list('['||a||']');")).toBe("[12.3/45.6]");
  });

  it("V を書いた形は従来どおり", () => {
    expect(bracketed("dcl a pic'9V99.99'; a = 7.62; put list('['||a||']');")).toBe("[762.00]");
    expect(out("dcl p pic'9v99'; p = 1.25; put list(p);")).toBe("125");
  });

  it("挿入文字を含めて桁があふれれば SIZE（従来どおり）", () => {
    expect(refused("dcl a pic'99.99'; a = 123456;")).toMatch(/SIZE|収まりません|桁/);
  });
});

describe("PICTURE の Y は無条件にゼロを空白化（p.340）", () => {
  /** 「specifies that a zero in the specified digit position is replaced **unconditionally** by the blank character」。 */
  it("規定の表の例と一致する", () => {
    expect(bracketed("dcl a pic'YYYYY'; a = 100; put list('['||a||']');")).toBe("[  1  ]");
    expect(bracketed("dcl b pic'9Y9Y9'; b = 10203; put list('['||b||']');")).toBe("[1 2 3]");
  });

  it("Z は従来どおり先頭のゼロだけ", () => {
    expect(bracketed("dcl a pic'ZZZ99'; a = 100; put list('['||a||']');")).toBe("[  100]");
  });
});

describe("PICTURE で値が 0 のときの抑制（p.335/338）", () => {
  /**
   * 「The blank is an unconditional insertion character, and always
   * specifies that a blank appears in the associated position」（p.334）。
   * 固定の通貨記号は抑制の対象、`B` は詰め文字に化けない。
   */
  it("固定の通貨記号も欄全体の抑制に含める", () => {
    expect(bracketed("dcl a pic'$ZZZV.ZZ'; a = 0; put list('['||a||']');")).toBe("[       ]");
  });

  it("B は詰め文字にならない", () => {
    expect(bracketed("dcl b pic'**B**B**'; b = 0; put list('['||b||']');")).toBe("[** ** **]");
  });

  it("9 が混ざれば先頭ゼロの抑制だけ（従来どおり）", () => {
    expect(bracketed("dcl a pic'ZZV.Z9'; a = 0; put list('['||a||']');")).toBe("[  .00]");
  });
});

/**
 * 多段のロケータ修飾（p.302）。
 *
 * 「P -> Q -> X ... When more than one locator qualifier is used, they are
 * evaluated from left to right」。`q -> r -> w` は `((q->r)) -> w`。
 *
 * 右結合で読んだ結果に外側のポインタを**上書き**していたため、途中の
 * 段が落ちて `q -> w` と同じ意味になり、読みでは診断も出ずに
 * 空の値が出力に混ざっていた。
 */
describe("多段のロケータ修飾（p.302）", () => {
  const chain = `dcl (p,q) pointer;
  dcl r pointer based(q);
  dcl w fixed bin(31) based(r);
  allocate r; allocate w; w = 42;`;

  it("2 段たどって読める", () => {
    expect(out(`${chain}\n  put list(w, r -> w, q -> r -> w);`)).toBe("42 42 42");
  });

  it("2 段たどって書ける", () => {
    expect(out(`${chain}\n  q -> r -> w = 7;\n  put list(w);`)).toBe("7");
  });

  it("式の中でも使える", () => {
    expect(out(`${chain}\n  put list(q -> r -> w + 1);`)).toBe("43");
  });
});

/**
 * 添字の変換（p.127）。
 *
 * 添字は FIXED BINARY へ変換される。整数でない値は精度変換（右側の切り捨て）
 * を受けるので、`a(2.5)` は `a(2)`。
 * 切り捨てていなかったため、**代入が黙って消え**、参照は
 * 「未初期化です」という事実に反する診断になっていた。
 */
describe("小数の添字は切り捨てる（p.127）", () => {
  it("代入が正しい要素へ届く", () => {
    expect(
      out(`dcl a(4) fixed dec(3) init(0,0,0,0);
  dcl i fixed dec(3,1) init(2.5);
  a(i) = 99;
  put list(a(1), a(2), a(3), a(4));`),
    ).toBe("0 99 0 0");
  });

  it("参照も正しい要素を返す", () => {
    expect(
      out(`dcl a(4) fixed dec(3) init(10,20,30,40);
  dcl lo fixed dec(3) init(1);
  dcl hi fixed dec(3) init(2);
  put list(a((lo+hi)/2));`),
    ).toBe("10");
  });

  it("範囲の判定は切り捨てた値で行う", () => {
    expect(out("dcl a(3) fixed bin(15) init(1,2,3); put list(a(3.9));")).toBe("3");
    expect(refused("dcl a(3) fixed bin(15); put list(a(4.1));")).toMatch(/添字/);
  });
});

/**
 * `BASED` の `INITIAL`（p.300/321）。
 *
 * 「The INITIAL attribute can be specified for a based variable. The initial
 * values are assigned only upon explicit allocation of the based variable
 * with an ALLOCATE or LOCATE statement」。規定自身の例が
 * `dcl X fixed bin based(P) init(0); allocate X;`（p.302）。
 *
 * AUTOMATIC と STATIC の `INIT` は効くので、**同じ `init(...)` が
 * 記憶域クラスによって効く / 効かない**になっていた。
 */
describe("BASED の INITIAL は ALLOCATE で効く（p.300）", () => {
  it("スカラ", () => {
    expect(out("dcl p ptr; dcl x fixed bin(31) based(p) init(7); allocate x; put list(x);")).toBe(
      "7",
    );
  });

  it("構造体の葉ごと", () => {
    expect(
      out(`dcl p ptr;
  dcl 1 node based(p), 2 val fixed bin(31) init(5), 2 next pointer init(null());
  allocate node;
  put list(p->node.val);
  if p->node.next = null() then put list('null');`),
    ).toBe("5 null");
  });

  it("確保するたびに初期値が入る", () => {
    expect(
      out(`dcl (p,q) ptr;
  dcl x fixed bin(31) based(p) init(3);
  allocate x set(p); p -> x = 9;
  allocate x set(q);
  put list(p -> x, q -> x);`),
    ).toBe("9 3");
  });

  it("配列の INIT も効く", () => {
    expect(
      out(`dcl p ptr;
  dcl a(3) fixed bin(31) based(p) init(1,2,3);
  allocate a;
  put list(a(1), a(2), a(3));`),
    ).toBe("1 2 3");
  });
});

/**
 * `BIT` の `VARYING`（p.83-84）。
 *
 * 構文に `NONVARYING | VARYING | VARYING4 | VARYINGZ` が並び、
 * 禁じられているのは `VARYINGZ` だけ。`VARYING` を黙って落としていたため、
 * 宣言した属性が `NONVARYING` に化けて `LENGTH` が宣言長を返し、
 * 連結や `SUBSTR` に余分な `0` が混ざっていた。
 */
describe("BIT VARYING（p.84）", () => {
  it("現在長を保つ", () => {
    expect(out("dcl b bit(8) varying; b = '101'b; put list(length(b), b);")).toBe("3 '101'B");
  });

  it("初期値でも現在長", () => {
    expect(out("dcl b bit(8) varying init('1'b); put list(length(b), b);")).toBe("1 '1'B");
  });

  it("宣言した最大長で切る", () => {
    expect(out("dcl b bit(4) varying; b = '111111'b; put list(length(b));")).toBe("4");
  });

  it("NONVARYING は従来どおり右を 0 で埋める", () => {
    expect(out("dcl b bit(8); b = '101'b; put list(length(b), b);")).toBe("8 '10100000'B");
  });
});

/**
 * `FLOAT BINARY(p)` の精度（p.80, p.136）。
 *
 * 「FLOAT BINARY (p1): The floating-point binary precision (p1) first
 * converts to the equivalent floating-point decimal precision (p), where
 * p=CEIL(p1/3.32)」。2 進桁を 10 進桁として扱っていたため、
 * `FLOAT BIN(21)` が 10 進 21 桁を出し、型が持てない桁まで見せていた。
 * 既定も 21（p.220 の表）。
 */
describe("FLOAT BINARY の精度（p.136）", () => {
  it("2 進桁を 10 進桁へ換算する", () => {
    // CEIL(21/3.32) = 7 桁 → 仮数 7 桁
    expect(out("dcl x float bin(21); x = 1; x = x / 3; put list(x);")).toBe("3.333333E-0001");
  });

  it("既定の精度は 21（短精度）", () => {
    expect(out("dcl x float bin; x = 1; x = x / 3; put list(x);")).toBe("3.333333E-0001");
  });

  it("倍精度は 16 桁", () => {
    // CEIL(53/3.32) = 16
    expect(out("dcl x float bin(53); x = 1; x = x / 3; put list(x);")).toBe(
      "3.333333333333333E-0001",
    );
  });

  it("FLOAT DECIMAL は従来どおり", () => {
    expect(out("dcl x float dec(6); x = 1; x = x / 3; put list(x);")).toBe("3.33333E-0001");
  });
});

/**
 * 配列の仮引数の `(*)`（p.149/226）。
 *
 * 「When the actual length, bounds, or size can be different for different
 * invocations, each can be specified in a DECLARE statement by an asterisk.
 * When an asterisk is used, the length, bounds, or size are taken from the
 * current generation of the associated argument」。
 * 大きさの違う配列を手続きへ渡す唯一の書き方で、`CHAR(*)` と対になる。
 */
describe("配列の仮引数の (*)（p.149）", () => {
  it("境界を呼ぶ側から受け取る", () => {
    expect(
      out(`dcl a(3) fixed bin(15) init(4,5,6);
  call p(a);
  p: proc(x); dcl x(*) fixed bin(15);
    put list(lbound(x,1), hbound(x,1), dim(x,1), x(2));
  end p;`),
    ).toBe("1 3 3 5");
  });

  it("下限が 1 でなくても受け取る", () => {
    expect(
      out(`dcl a(0:2) fixed bin(15) init(7,8,9);
  call p(a);
  p: proc(x); dcl x(*) fixed bin(15); put list(lbound(x,1), hbound(x,1), x(0)); end p;`),
    ).toBe("0 2 7");
  });

  it("書き換えが呼び元へ届く", () => {
    expect(
      out(`dcl a(3) fixed bin(15);
  call p(a);
  put list(a(1), a(2), a(3));
  p: proc(x); dcl x(*) fixed bin(15); dcl i fixed bin(15);
    do i = 1 to hbound(x,1); x(i) = i * 10; end;
  end p;`),
    ).toBe("10 20 30");
  });

  it("多次元でも受け取る", () => {
    expect(
      out(`dcl a(2,3) fixed bin(15) init(1,2,3,4,5,6);
  call p(a);
  p: proc(x); dcl x(*,*) fixed bin(15); put list(dim(x,1), dim(x,2), x(2,3)); end p;`),
    ).toBe("2 3 6");
  });

  it("引数でなければ断る", () => {
    expect(refused("dcl a(*) fixed bin(15); put list('x');")).toMatch(/引数/);
  });
});

/**
 * この処理系では意味を持たない属性（p.212 など）。
 *
 * 記憶域の配置を持たないので `ALIGNED` / `UNALIGNED` は定義上なにも
 * 変えられない。変えられないものを理由にプログラム全体を断ると、
 * 構造体やレコード定義（ほぼ必ず付く）が通らない。
 * `REAL` / `PRECISION` / `NONVARYING` / `DIMENSION` も、既定と同じ意味か
 * すでに持っている情報の別の綴りなので受け流す。
 */
describe("意味を持たない属性は受け流す", () => {
  it("ALIGNED / UNALIGNED", () => {
    expect(
      out("dcl 1 r unaligned, 2 a char(3), 2 b char(3); r.a = 'xyz'; put list(r.a);"),
    ).toBe("xyz");
    expect(out("dcl x fixed bin(31) aligned; x = 1; put list(x);")).toBe("1");
  });

  it("REAL（算術の既定）", () => {
    expect(out("dcl d real fixed dec(3,2); d = 1.25; put list(d);")).toBe("1.25");
    expect(out("dcl d decimal fixed real(3,2); d = 1.25; put list(d);")).toBe("1.25");
  });

  it("PRECISION / PREC", () => {
    expect(out("dcl x fixed dec prec(5,2); x = 1.25; put list(x);")).toBe("1.25");
  });

  it("NONVARYING", () => {
    expect(out("dcl s char(4) nonvarying init('abc'); put list(length(s));")).toBe("4");
  });

  it("DIMENSION キーワード（p.225）", () => {
    expect(out("dcl a dimension(2,3) fixed bin(15); a(2,3) = 9; put list(a(2,3), dim(a,2));")).toBe(
      "9 3",
    );
  });

  it("PROCEDURE / BEGIN の ORDER・REORDER（p.147/164）", () => {
    expect(out("call p; p: proc order; put list('a'); end p;")).toBe("a");
    expect(out("begin options(order); put list('b'); end;")).toBe("b");
  });
});

/** 比較演算子の別の綴り（p.117）。「`¬=` or `<>`」。 */
describe("演算子の別の綴り（p.116-117）", () => {
  it("<> は ¬= と同じ", () => {
    expect(out("put list(1 <> 2, 1 <> 1);")).toBe("'1'B '0'B");
  });

  /** Table 29 は中置の `¬` を排他的論理和として挙げている（p.116-117）。 */
  it("中置の ¬ は排他的論理和", () => {
    expect(out("put list('010111'b ¬ '111111'b);")).toBe("'101000'B");
    expect(out("put list('1'b ^ '1'b, '1'b ^ '0'b);")).toBe("'0'B '1'B");
  });
});

/**
 * 条件式の短絡評価（p.278-279）。
 *
 * 「The test of the IF expression is short-circuited … If the IF expression
 * consists of a logical OR of 2 expressions and the first of these
 * expressions is true, the second expression will not be evaluated」。
 * 規定の例そのものが `if P = sysnull() | P->BX = 0 then`。
 *
 * この処理系は「NULL をたどったら必ず止める」という設計なので、
 * 短絡しないと**正しいプログラムを殺す**側に働いていた。
 */
describe("条件式の短絡評価（p.278）", () => {
  const based = `dcl p pointer; dcl bx fixed bin(31) based(p);`;

  it("| の左が真なら右を評価しない（規定の例）", () => {
    expect(out(`${based}\n  p = null();\n  if p = null() | p->bx = 0 then put list('ok');`)).toBe(
      "ok",
    );
  });

  it("& の左が偽なら右を評価しない（番兵の定型）", () => {
    expect(
      out(`${based}\n  p = null();
  if p ¬= null() & p->bx = 0 then put list('deref'); else put list('safe');`),
    ).toBe("safe");
  });

  it("DO WHILE / UNTIL でも短絡する", () => {
    expect(
      out(`${based}\n  p = null();
  do while(p ¬= null() & p->bx = 0); put list('in'); end;
  put list('out');`),
    ).toBe("out");
  });

  it("短絡しても値は規定どおり", () => {
    expect(out("if 1=1 | 1=0 then put list('t');")).toBe("t");
    expect(out("if 1=0 & 1=1 then put list('t'); else put list('f');")).toBe("f");
    expect(out("if 1=1 & 1=1 then put list('t');")).toBe("t");
  });

  it("ビットごとの演算は短絡しない（条件でない式）", () => {
    // '1100'B と '1010'B の & は 2 ビット以上なのでビットごとの演算
    expect(out("put list('1100'b & '1010'b);")).toBe("'1000'B");
  });
});

/**
 * 他の条件から ERROR への連鎖（p.395/418/421）。
 *
 * 「The implicit action for many conditions is to raise the ERROR condition.
 * This provides a common condition that can be used to check for a number
 * of different conditions」。`ON ERROR` を共通の後始末に使うのは規定が
 * 明記した主要な使い方で、飛ばされると後始末が実行されない。
 */
describe("条件は ERROR へ連鎖する（p.395）", () => {
  it("SUBSCRIPTRANGE から ON ERROR へ", () => {
    const r = runProgram(
      MAIN(`dcl a(3) fixed bin(15);
  dcl i fixed bin(15) init(5);
  on error put skip list('ERROR-ON');
  a(i) = 1;`),
    );
    expect(r.ok).toBe(false);
    expect(r.stdout.trim()).toBe("ERROR-ON");
  });

  it("CONVERSION から ON ERROR へ", () => {
    const r = runProgram(
      MAIN(`dcl n fixed bin(15); dcl s char(3) init('ab');
  on error put skip list('ERROR-ON');
  n = s;`),
    );
    expect(r.ok).toBe(false);
    expect(r.stdout.trim()).toBe("ERROR-ON");
  });

  it("自分の ON 単位があればそれを通ってから ERROR へ", () => {
    const r = runProgram(
      MAIN(`dcl a(3) fixed bin(15);
  on subscriptrange put skip list('SR');
  on error put skip list('ERROR-ON');
  a(9) = 1;`),
    );
    expect(r.ok).toBe(false);
    expect(r.stdout.replace(/\s+/g, " ").trim()).toBe("SR ERROR-ON");
  });

  it("ON 単位が無ければ意味の分かる誤りのまま", () => {
    expect(refused("dcl a(3) fixed bin(15); a(9) = 1;")).toMatch(/添字が範囲外/);
  });
});

/**
 * `SIGNAL` からの復帰（p.403）。
 *
 * 「If a condition (except the ERROR condition) has been raised by the
 * SIGNAL statement, the normal return is always to the statement
 * immediately following SIGNAL」。
 *
 * Linter が「この処理系は X を起こしませんが、SIGNAL X で明示的に
 * 起こせます」と案内している逃げ道が、実際には ON 単位を 1 回走らせて
 * プログラムを殺すだけになっていた。
 */
describe("SIGNAL の次の文へ復帰する（p.403）", () => {
  it("ON 単位を実行してから続ける", () => {
    for (const cond of ["finish", "stringsize", "stringrange", "underflow", "overflow"]) {
      expect(
        out(`on ${cond} put skip list('ON-RAN');
  signal ${cond};
  put skip list('CONTINUED');`),
        cond,
      ).toBe("ON-RAN CONTINUED");
    }
  });

  it("入出力の条件も従来どおり復帰する", () => {
    expect(
      out("on endfile(sysin) put list('eof'); signal endfile(sysin); put list('after');"),
    ).toBe("eof after");
  });

  it("SIGNAL ERROR だけは終わる", () => {
    const r = runProgram(MAIN("on error put list('caught'); signal error; put list('after');"));
    expect(r.ok).toBe(false);
    expect(r.stdout.trim()).toBe("caught");
  });
});

/**
 * `END` の名前（p.275）。
 *
 * 「If a statement-label follows END, the END statement closes **the
 * unclosed group or block** headed by the nearest preceding DO, SELECT,
 * PACKAGE, BEGIN, or PROCEDURE statement having that statement-label」。
 * 間のブロックもまとめて閉じる（多重閉じ）。
 *
 * 手続きの `END` の名前は検査していたのに、DO / SELECT の `END` の名前は
 * 読み捨てていた。`END` に名前を書くのは入れ子の崩れを機械に拾わせる
 * ためなので、検査しないと目的を果たさない。
 */
describe("END の名前（p.275）", () => {
  it("多重閉じで間のループもまとめて閉じる", () => {
    expect(
      out(`dcl (i,j) fixed bin(15);
  lp: do i = 1 to 2;
    do j = 1 to 2;
      put list(i*10+j);
  end lp;
  put list('after');`),
    ).toBe("11 12 21 22 after");
  });

  it("自分のラベルなら従来どおり閉じる", () => {
    expect(out("dcl i fixed bin(15); lp: do i = 1 to 2; put list(i); end lp;")).toBe("1 2");
  });

  it("どの開始にも無い名前は断る", () => {
    expect(refused("dcl i fixed bin(15); lp: do i = 1 to 2; put list(i); end zz;")).toMatch(
      /END/,
    );
  });

  it("END にラベル接頭を付けられる（p.271）", () => {
    expect(
      out(`dcl i fixed bin(15);
  do i = 1 to 3;
    if i = 2 then goto fin;
    put list(i);
  fin: end;
  put list('done');`),
    ).toBe("1 3 done");
  });

  it("手続きの END の名前は従来どおり検査する", () => {
    expect(refused("call p; p: proc; put list('a'); end q;")).toMatch(/END/);
  });
});

/** 手続きに複数のラベルを付けたときの主入口（p.147）。 */
describe("PROCEDURE の複数ラベル（p.147）", () => {
  /** 「If multiple entry labels are specified, the leftmost name is the primary entry point」。 */
  it("一番左が主入口の名前", () => {
    expect(out("call a; a: b: proc; put list('hit'); end a;")).toBe("hit");
  });

  it("END にはどのラベルを書いてもよい", () => {
    expect(out("call a; a: b: proc; put list('hit'); end b;")).toBe("hit");
  });
});

/** ラベル付きの BEGIN へ GOTO できる（p.164）。 */
describe("ラベル付き BEGIN への GOTO（p.164）", () => {
  it("ブロックを再実行できる", () => {
    expect(
      out(`dcl k fixed bin(15) init(0);
  bb: begin; k = k + 1; put list(k); end;
  if k = 1 then goto bb;`),
    ).toBe("1 2");
  });
});

/**
 * `LEAVE` はブロックの境界を越えない（p.280）。
 * 「The LEAVE statement and the referenced or implied DO statement must
 * not be in different blocks」。手続きの境界は断っていたのに、
 * BEGIN ブロックは素通りだった。
 */
describe("LEAVE はブロックの境界を越えない（p.280）", () => {
  it("BEGIN ブロックからループを抜けられない", () => {
    expect(
      refused(`dcl i fixed bin(15);
  do i = 1 to 3; begin; if i = 2 then leave; end; put list(i); end;`),
    ).toMatch(/LEAVE/);
  });
});

/**
 * 単位に置けない文（p.278/287）。
 * 「All single statements are considered valid and executable **except
 * DECLARE**, DEFAULT, END, ENTRY FORMAT, PROCEDURE, or a %statement」。
 */
describe("IF / WHEN の単位に宣言は置けない（p.278）", () => {
  it("THEN に DECLARE は断る", () => {
    expect(refused("if 1 = 1 then dcl x fixed bin(15);")).toMatch(/単位に置けません/);
  });

  it("WHEN に DECLARE も断る", () => {
    expect(refused("select(1); when(1) dcl x fixed bin(15); end;")).toMatch(/単位に置けません/);
  });
});

/** RETURNS の無い手続きの `RETURN(式)`（p.176）。 */
describe("RETURN と RETURNS の対応（p.176）", () => {
  /**
   * 「A RETURN statement with an expression is not valid in a procedure
   * without the RETURNS option」。逆向き（RETURNS があるのに素の RETURN）は
   * 以前から断っていたが、こちらは黙って値を捨てていた。
   */
  it("RETURNS が無ければ値を返せない", () => {
    expect(refused("call p; p: proc; return(5); end p;")).toMatch(/RETURNS/);
  });

  it("RETURNS があれば従来どおり", () => {
    expect(out("put list(f()); f: proc returns(fixed bin(15)); return(5); end f;")).toBe("5");
  });
});

/**
 * ストリーム出力の行とページ（p.317/321/327/409）。
 */
describe("LINESIZE と COLUMN と ENDPAGE", () => {
  /**
   * 「An attempt to write a line greater than 110 characters places the
   * excess characters on the next line」（p.317）。
   * 項目ごと次行へ送っていたので、桁位置が静かにずれ、しかも行幅を
   * 超えた行がそのまま出ていた。
   */
  it("LINESIZE を超える分は次の行へ送る", () => {
    expect(
      raw(`open file(sysprint) output linesize(5);
  put edit('abcdefgh')(a);`),
    ).toBe("abcde\nfgh\n");
  });

  /**
   * 「if the specified character position lies beyond the rightmost
   * character position of the current line … the default character
   * position is one」（p.321）。
   */
  it("COLUMN が行幅を超えたら桁 1 として扱う", () => {
    const text = raw("put edit('ab','cd')(a,column(500),a);");
    // 行幅（既定 120）を超える行は作らない
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
  });

  /**
   * ENDPAGE の暗黙動作は「A new page is started」（p.409-410）。
   * 条件を起こさないこととは別に、**改ページそのもの**が落ちていた。
   */
  it("PAGESIZE を超えたら改ページする", () => {
    const text = raw(`dcl k fixed bin(15);
  open file(sysprint) output pagesize(4);
  do k = 1 to 10; put skip list(k); end;`);
    expect(text).toContain("\f");
  });

  it("PAGESIZE の中なら改ページしない", () => {
    const text = raw(`dcl k fixed bin(15);
  open file(sysprint) output pagesize(60);
  do k = 1 to 5; put skip list(k); end;`);
    expect(text).not.toContain("\f");
  });
});

/**
 * PRINT でないストリーム出力の LIST（p.315-316）。
 *
 * 「Arithmetic values are converted to character」「If the file does not
 * have the attribute PRINT, enclosing quotation marks are supplied」―
 * 引用符が付くのは**文字列**だけで、算術値には付かない。
 */
describe("PRINT でないファイルの PUT LIST（p.315）", () => {
  it("数値には引用符を付けない", () => {
    expect(
      out(`dcl s char(40) varying;
  put string(s) list(12, 'ab');
  put list('['||s||']');`),
    ).toBe("[ 12 'ab' ]");
  });
});

/**
 * 書式リストの反復係数（p.310）。
 *
 * 「n Specifies an iteration factor, which is either an expression enclosed
 * in parentheses or an integer. If it is the latter, a blank must separate
 * the integer and the following format item」。
 * 規定の例そのもの（p.304）が `edit (X,Y,Z)(X(1), 3 F(10,4))`。
 */
describe("括弧なしの反復係数（p.310）", () => {
  it("整数 + 空白 + 書式項目", () => {
    expect(out("put edit(1,2,3)(3 f(3));")).toBe("1 2 3");
  });

  it("括弧付きと混ぜられる", () => {
    expect(out("put edit('a',1,2)(a(1), 2 f(3));")).toBe("a 1 2");
  });

  it("GET でも使える", () => {
    expect(
      out(`dcl (x,y,z) fixed dec(5,2);
  get string('  1.0000  2.0000  3.0000') edit(x,y,z)(x(1), 3 f(8,4));
  put list(x,y,z);`),
    ).toBe("1.00 2.00 3.00");
  });
});

/**
 * データリストの反復指定（type-3 DO、p.302/314）。
 * 規定の例は `list ((Thickness(Distance) do Distance = 1 to 1000))`。
 */
describe("データリストの反復指定（p.314）", () => {
  it("配列の一部だけを出せる", () => {
    expect(
      out(`dcl x(5) fixed bin(15) init(1,2,3,4,5);
  dcl i fixed bin(15);
  put list((x(i) do i = 1 to 3));`),
    ).toBe("1 2 3");
  });

  it("EDIT でも使える", () => {
    expect(
      out(`dcl x(3) fixed bin(15) init(7,8,9);
  dcl i fixed bin(15);
  put edit((x(i) do i = 1 to 3))(3 f(3));`),
    ).toBe("7 8 9");
  });

  it("式も書ける", () => {
    expect(
      out(`dcl x(3) fixed bin(15) init(1,2,3);
  dcl i fixed bin(15);
  put list((x(i) * 10 do i = 1 to 3));`),
    ).toBe("10 20 30");
  });

  it("GET の側は名指しで断る", () => {
    expect(
      refused(`dcl x(3) fixed bin(15); dcl i fixed bin(15);
  get string('1 2 3') list((x(i) do i = 1 to 3));`),
    ).toMatch(/反復指定/);
  });
});

/** その他の入出力の規定。 */
describe("OPEN / READ / REWRITE の規定", () => {
  /** 「Opening a file that is already open does not affect the file」（p.338）。 */
  it("開いているファイルの OPEN は何もしない", () => {
    expect(
      out(`dcl s char(10) varying;
  open file(sysprint) output;
  open file(sysprint) output;
  put list('ok');`),
    ).toBe("ok");
  });

  /** 「For PRINT files, if n is less than or equal to zero, the positioning is to the start of the current line」（p.303）。 */
  it("PRINT ファイルの SKIP(0) は行頭へ戻る", () => {
    expect(raw("put edit('abcdef')(a); put skip(0) edit('XY')(a);")).toContain("XYcdef");
  });
});

/** レコード入出力の規定（p.292-294）。 */
describe("READ / REWRITE の形（p.292）", () => {
  /** 「A READ statement without an INTO, SET, or IGNORE option is equivalent to a READ with an IGNORE(1)」。 */
  it("READ IGNORE(n) と指定なしの READ でレコードを飛ばせる", () => {
    const host = new MemoryHost({ IN: "aaaa\nbbbb\ncccc\ndddd\n" });
    const r = runProgram(
      MAIN(`dcl f file record input env(f recsize(4));
  dcl rec char(4);
  open file(f) input title('IN');
  read file(f) ignore(2);
  read file(f) into(rec);
  put list(rec);
  read file(f);
  close file(f);`),
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout.trim()).toBe("cccc");
  });

  /** 「REWRITE without FROM … has no effect on the record」（p.293）。 */
  it("FROM の無い REWRITE は何もしない", () => {
    const host = new MemoryHost({ UP: "aaaa\nbbbb\n" });
    const r = runProgram(
      MAIN(`dcl f file record update env(f recsize(4));
  dcl rec char(4);
  open file(f) update title('UP');
  read file(f) into(rec);
  rewrite file(f);
  close file(f);
  put list('ok');`),
      { host },
    );
    expect(r.diagnostics).toEqual([]);
    expect(host.get("UP")).toContain("aaaa");
  });
});

/** `E` 書式の桁あふれ（p.323）。「If the field width is such that significant digits or the sign are lost, the SIZE condition is raised」。 */
describe("E 書式の桁あふれは SIZE（p.323）", () => {
  it("幅が足りなければ条件を起こす", () => {
    const r = runProgram(MAIN("on size put list('sz'); put edit(12345.678)(e(6,2));"));
    expect(r.stdout).toContain("sz");
  });

  it("足りていれば従来どおり", () => {
    expect(out("put edit(1.5)(e(14,4));")).toBe("1.5000E+0000");
  });
});

/** 「the data type might also be POINTER」（p.302）。 */
describe("PUT LIST にポインタを渡せる（p.302）", () => {
  it("黙って消えない", () => {
    expect(out("dcl p pointer; p = null(); put list(p);")).toBe("NULL");
  });
});

/** 反復 DO のその他の形（p.265/271）。 */
describe("DO の LOOP と UPTHRU（p.265/271）", () => {
  /** 「LOOP Specifies infinite iteration. FOREVER is a synonym of LOOP」。 */
  it("DO LOOP は LEAVE まで回る", () => {
    expect(
      out(`dcl i fixed bin(15) init(0);
  do loop; i = i + 1; put list(i); if i = 3 then leave; end;`),
    ).toBe("1 2 3");
    expect(
      out(`dcl i fixed bin(15) init(0);
  do forever; i = i + 1; if i = 2 then leave; end;
  put list(i);`),
    ).toBe("2");
  });

  it("LOOP という名前の変数と共存する（予約語が無い）", () => {
    expect(out("dcl loop fixed bin(15); do loop = 1 to 2; put list(loop); end;")).toBe("1 2");
  });

  /** 「UPTHRU exp2 … the reference is compared to exp2 after the statements in the loop are executed … The loop is executed at least once」（p.265）。 */
  it("UPTHRU は本体の後に判定する", () => {
    expect(out("dcl i fixed bin(15); do i = 1 upthru 3; put list(i); end;")).toBe("1 2 3");
    // 端から外れていても 1 回は実行する
    expect(out("dcl i fixed bin(15); do i = 5 upthru 3; put list(i); end;")).toBe("5");
  });

  it("DOWNTHRU は下向き", () => {
    expect(out("dcl i fixed bin(15); do i = 3 downthru 1; put list(i); end;")).toBe("3 2 1");
  });
});

/** 複合代入演算子（p.254-255）。 */
describe("複合代入演算子（p.255）", () => {
  it("算術", () => {
    expect(out("dcl n fixed bin(15) init(1); n += 4; put list(n);")).toBe("5");
    expect(out("dcl n fixed bin(15) init(10); n -= 4; n *= 2; n /= 3; put list(n);")).toBe("4");
  });

  it("連結とビット", () => {
    expect(out("dcl s char(6) varying init('ab'); s ||= 'cd'; put list(s);")).toBe("abcd");
    expect(out("dcl b bit(4) init('1100'b); b &= '1010'b; put list(b);")).toBe("'1000'B");
  });

  it("添字付きの左辺", () => {
    expect(out("dcl a(3) fixed bin(15) init(1,2,3); a(2) += 10; put list(a(2));")).toBe("12");
  });
});

/**
 * 名指しで断るもの（第 3 段）。
 *
 * この処理系の約束は「できないことは黙って動かさず、名指しで断る」。
 * 素の構文誤りに落ちると綴り間違いと未実装の区別が付かない。
 * 解説書にある形で、実装しないと決めたものをここに並べる。
 */
describe("規定にある形を名指しで断る", () => {
  it("文", () => {
    for (const [src, word] of [
      ["readin: proc; errt: entry; end readin;", "ENTRY"],
      ["assert true(1 = 1);", "ASSERT"],
      ["dcl n fixed bin(15); reinit n;", "REINIT"],
      ["on error resignal;", "RESIGNAL"],
      ["flush file(sysprint);", "FLUSH"],
    ] as const) {
      expect(refused(src), src).toMatch(new RegExp(`${word} は未実装`));
    }
  });

  it("PACKAGE（プログラム全体を包む形）", () => {
    const r = runProgram("p: package exports(*);\n m: proc options(main);\n end m;\nend p;\n");
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/PACKAGE は未実装/);
  });

  it("条件接頭辞（p.395）", () => {
    expect(refused("(subscriptrange): dcl a(3) fixed bin(15); a(9) = 1;")).toMatch(
      /条件接頭辞/,
    );
  });

  it("属性", () => {
    for (const [src, word] of [
      ["dcl b bit(8) varyingz; put list('x');", "VARYINGZ"],
      ["dcl n fixed bin(31) unsigned; put list('x');", "UNSIGNED"],
      ["dcl pi float bin value(3.14); put list('x');", "VALUE"],
      ["dcl f generic(g when(fixed)); put list('x');", "GENERIC"],
      ["dcl c char(6); dcl d char(3) def(c) position(4); put list('x');", "POSITION"],
      ["dcl x type tt; put list('x');", "TYPE"],
      ["dcl h handle(t); put list('x');", "HANDLE"],
      ["dcl d ordinal(a,b); put list('x');", "ORDINAL"],
      ["dcl account file variable; put list('x');", "VARIABLE"],
    ] as const) {
      expect(refused(src), src).toMatch(new RegExp(`${word} は未実装`));
    }
  });

  it("型定義の文", () => {
    for (const [src, word] of [
      ["define structure 1 t, 2 a fixed bin(15); put list('x');", "DEFINE"],
      ["xdeclare x fixed bin(15); put list('x');", "XDECLARE"],
      ["qualify; put list('x');", "QUALIFY"],
    ] as const) {
      expect(refused(src), src).toMatch(new RegExp(`${word} は未実装`));
    }
  });

  it("式と宣言の形", () => {
    expect(refused("dcl a(2,3) fixed bin(15); put list(a(*,2));")).toMatch(/断面|\(\*\)/);
    expect(
      refused("dcl 1 r, 2 a fixed dec(4,2) init(1); r = r * 2; put list(r.a);"),
    ).toMatch(/構造体式/);
    expect(refused("dcl a(3) fixed bin(15) init(1,*,3); put list(a(1));")).toMatch(
      /INITIAL/,
    );
    expect(refused("dcl (e dec(6,5), f char(10)) static; put list('x');")).toMatch(
      /括り出し/,
    );
  });

  it("入出力の形", () => {
    expect(refused("close file(*);")).toMatch(/FILE\(\*\)/);
    expect(refused("dcl n fixed bin(15); get list(n) copy;")).toMatch(/COPY/);
    expect(refused("put edit(1)(f(5,2,3));")).toMatch(/尺度/);
    expect(refused("put edit(1.5)(e(14,4,6));")).toMatch(/有効桁/);
  });

  it("組込サブルーチン（p.454）", () => {
    expect(refused("call pliretc(4);")).toMatch(/組込サブルーチン pliretc/);
    expect(refused("call plidump('T');")).toMatch(/組込サブルーチン plidump/);
  });

  it("解説書にあってどちらの表にも無い名前を減らす", () => {
    // `MOD` の対の `REM`、`ADD`/`MULTIPLY`/`DIVIDE` の対の `SUBTRACT` など
    for (const name of ["rem", "subtract", "indexr", "verifyr", "pointeradd", "present"]) {
      expect(refused(`put list(${name}(1));`), name).toMatch(/組込関数/);
    }
  });

  it("解説書に無い名前を「PL/I の組込関数」と言わない", () => {
    // ACOSD / ASIND / DECAT は 6.2 の解説書に無い
    for (const name of ["acosd", "asind", "decat"]) {
      expect(refused(`put list(${name}(1));`), name).toMatch(/未知の関数/);
    }
  });
});
