import { describe, expect, it } from "vitest";
import { parse, ParseError } from "../src/parser.js";
import type { Stmt, Expr } from "../src/ast.js";

const body = (src: string): Stmt[] => parse(src).body;
/** 先頭の手続きの本体を取り出す。 */
const procBody = (src: string): Stmt[] => {
  const p = body(src)[0];
  if (p?.kind !== "procedure") throw new Error("手続きではない");
  return p.body;
};

describe("予約語が無いことへの対応（構文解析の核）", () => {
  /**
   * 文の種別は文脈でしか決まらない。
   *   THEN = ELSE;   -> THEN という変数への代入
   *   IF x = 1 THEN  -> IF 文
   * 判定規則: 先頭が「参照（語 + 省略可能な添字）」に続いて '=' なら代入文、
   * そうでなければ先頭語を文キーワードとして解釈する。
   */
  it("IF IF = THEN THEN THEN = ELSE; を正しく解釈する", () => {
    const [s] = procBody("p: proc; IF IF = THEN THEN THEN = ELSE; end p;");
    expect(s?.kind).toBe("if");
    if (s?.kind !== "if") return;
    // 条件は IF = THEN という比較
    expect(s.cond).toEqual<Expr>({
      kind: "binary", op: "=",
      left: { kind: "ref", name: "IF", subscripts: [] },
      right: { kind: "ref", name: "THEN", subscripts: [] },
    });
    // THEN 節は THEN = ELSE という代入
    expect(s.then.kind).toBe("assign");
    if (s.then.kind !== "assign") return;
    expect(s.then.target.name).toBe("THEN");
    expect(s.then.value).toEqual<Expr>({ kind: "ref", name: "ELSE", subscripts: [] });
  });

  it("文キーワードと同じ綴りの変数へ代入できる", () => {
    for (const name of ["if", "do", "put", "end", "declare", "call", "return", "then", "else"]) {
      const [s] = procBody(`p: proc; ${name} = 1; end p;`);
      expect(s?.kind, `${name} = 1 は代入文`).toBe("assign");
      if (s?.kind === "assign") expect(s.target.name).toBe(name);
    }
  });

  it("キーワード語を DECLARE の対象にできる", () => {
    const [s] = procBody("p: proc; dcl (if, then, else) fixed bin(31); end p;");
    expect(s?.kind).toBe("declare");
    if (s?.kind !== "declare") return;
    expect(s.items[0]?.names).toEqual(["if", "then", "else"]);
  });

  it("添字付きの代入も代入として判定する", () => {
    const [s] = procBody("p: proc; a(2,3) = 7; end p;");
    expect(s?.kind).toBe("assign");
    if (s?.kind !== "assign") return;
    expect(s.target.name).toBe("a");
    expect(s.target.subscripts).toHaveLength(2);
  });

  it("括弧で始まっても '=' が無ければ代入にしない", () => {
    const [s] = procBody("p: proc; put list(1); end p;");
    expect(s?.kind).toBe("put");
  });
});

describe("PROCEDURE", () => {
  it("options(main) 付きの主手続き", () => {
    const [p] = body("hello: proc options(main);\n put list('x');\nend hello;");
    expect(p?.kind).toBe("procedure");
    if (p?.kind !== "procedure") return;
    expect(p.name).toBe("hello");
    expect(p.isMain).toBe(true);
    expect(p.body).toHaveLength(1);
  });

  // PL/I の OPTIONS はカンマではなく空白で区切る。
  // 同梱サンプル numwrd.pli は options(main reentrant) と書いている。
  it("OPTIONS の項目は空白区切り", () => {
    const [p] = body("a: proc options(main reentrant); end a;");
    if (p?.kind !== "procedure") throw new Error("手続きではない");
    expect(p.isMain).toBe(true);
  });

  it("OPTIONS にカンマ区切りも許す", () => {
    const [p] = body("a: proc options(main, reentrant); end a;");
    if (p?.kind !== "procedure") throw new Error("手続きではない");
    expect(p.isMain).toBe(true);
  });

  it("procedure と proc の両方を受け付ける", () => {
    expect(body("a: procedure; end a;")[0]?.kind).toBe("procedure");
    expect(body("a: proc; end a;")[0]?.kind).toBe("procedure");
  });

  it("入れ子の手続き", () => {
    const outer = body("o: proc options(main); inner: proc; end inner; end o;")[0];
    if (outer?.kind !== "procedure") throw new Error("手続きではない");
    expect(outer.body[0]?.kind).toBe("procedure");
  });

  it("引数・RECURSIVE・RETURNS", () => {
    const [p] = body("f: proc(n) returns(fixed bin(31)) recursive; end f;");
    if (p?.kind !== "procedure") throw new Error("手続きではない");
    expect(p.params).toEqual(["n"]);
    expect(p.recursive).toBe(true);
    expect(p.returns).toEqual({ type: "fixed", base: "bin", p: 31, q: 0 });
  });

  it("END に名前を付けなくてもよい", () => {
    expect(body("a: proc; end;")[0]?.kind).toBe("procedure");
  });

  it("END の名前が一致しなければエラー", () => {
    expect(() => body("a: proc; end b;")).toThrow(ParseError);
  });
});

describe("DECLARE", () => {
  const attrOf = (src: string) => {
    const s = procBody(`p: proc; ${src} end p;`)[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    return s.items[0]?.attr;
  };

  it("FIXED BIN(31)", () =>
    expect(attrOf("dcl a fixed bin(31);")).toEqual({ type: "fixed", base: "bin", p: 31, q: 0 }));

  it("FIXED DEC(5,2)", () =>
    expect(attrOf("dcl a fixed dec(5,2);")).toEqual({ type: "fixed", base: "dec", p: 5, q: 2 }));

  it("属性の順序は自由", () =>
    expect(attrOf("dcl a bin fixed(31);")).toEqual({ type: "fixed", base: "bin", p: 31, q: 0 }));

  it("綴りの長短どちらも受け付ける", () => {
    expect(attrOf("dcl a fixed binary(31);")).toEqual({ type: "fixed", base: "bin", p: 31, q: 0 });
    expect(attrOf("dcl a fixed decimal(5,2);")).toEqual({ type: "fixed", base: "dec", p: 5, q: 2 });
  });

  it("CHAR(10)", () =>
    expect(attrOf("dcl s char(10);")).toEqual({ type: "char", length: 10, varying: false }));

  it("CHAR(20) VARYING", () =>
    expect(attrOf("dcl s char(20) varying;")).toEqual({ type: "char", length: 20, varying: true }));

  it("BIT(1)", () =>
    expect(attrOf("dcl b bit(1);")).toEqual({ type: "bit", length: 1 }));

  it("精度を省略すると PL/I の既定値になる", () => {
    // FIXED の既定基数は DECIMAL、既定精度は (5,0)
    expect(attrOf("dcl a fixed;")).toEqual({ type: "fixed", base: "dec", p: 5, q: 0 });
    // FIXED BINARY の既定精度は (15,0)
    expect(attrOf("dcl a fixed bin;")).toEqual({ type: "fixed", base: "bin", p: 15, q: 0 });
    // CHARACTER の既定長は 1
    expect(attrOf("dcl s char;")).toEqual({ type: "char", length: 1, varying: false });
  });

  it("まとめ宣言", () => {
    const s = procBody("p: proc; dcl (i, j) fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.names).toEqual(["i", "j"]);
  });

  it("1文で複数項目", () => {
    const s = procBody("p: proc; dcl a fixed bin(31), s char(5); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items).toHaveLength(2);
    expect(s.items[1]?.attr).toEqual({ type: "char", length: 5, varying: false });
  });

  // INIT は値のリストを取る（PL/I では配列の初期化に使う）ため配列で保持する
  it("INITIAL（単一値）", () => {
    const s = procBody("p: proc; dcl a fixed bin(31) init(7); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.init).toEqual([{ kind: "num", text: "7" }]);
  });

  it("INITIAL（複数値）", () => {
    const s = procBody("p: proc; dcl a(3) fixed bin(31) init(1,2,3); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.init).toHaveLength(3);
  });

  // 同梱サンプル isub.pli の `dcl b(3,3) bin fixed init(...)` を通すために必要。
  // 次元は名前の直後の括弧、精度は属性語の後の括弧として区別する。
  it("配列の次元（1次元）", () => {
    const s = procBody("p: proc; dcl a(10) fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toEqual([{ lo: 1, hi: 10 }]);
    expect(s.items[0]?.attr).toEqual({ type: "fixed", base: "bin", p: 31, q: 0 });
  });

  it("配列の次元（2次元）", () => {
    const s = procBody("p: proc; dcl b(3,3) bin fixed; end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toEqual([{ lo: 1, hi: 3 }, { lo: 1, hi: 3 }]);
  });

  it("次元が無ければ dims は undefined", () => {
    const s = procBody("p: proc; dcl a fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toBeUndefined();
  });

  // PL/I の配列は下限を明示できる。同梱サンプル numwrd.pli は
  //   dcl ones (0:9) char(8) varying static init(...)
  // のように 0 始まりの配列を使う。
  it("配列の境界（下限:上限）", () => {
    const s = procBody("p: proc; dcl ones(0:9) char(8); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toEqual([{ lo: 0, hi: 9 }]);
  });

  it("下限を省略すると 1 になる", () => {
    const s = procBody("p: proc; dcl a(10) fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toEqual([{ lo: 1, hi: 10 }]);
  });

  it("多次元で境界指定を混在できる", () => {
    const s = procBody("p: proc; dcl a(3, 0:4) fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toEqual([{ lo: 1, hi: 3 }, { lo: 0, hi: 4 }]);
  });

  it("負の下限も使える", () => {
    const s = procBody("p: proc; dcl a(-2:2) fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.dims).toEqual([{ lo: -2, hi: 2 }]);
  });

  it("まとめ宣言に次元を付けられる", () => {
    const s = procBody("p: proc; dcl (a, b)(5) fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.names).toEqual(["a", "b"]);
    expect(s.items[0]?.dims).toEqual([{ lo: 1, hi: 5 }]);
  });
});

describe("PUT", () => {
  const putOf = (src: string) => {
    const s = procBody(`p: proc; ${src} end p;`)[0];
    if (s?.kind !== "put") throw new Error("PUT ではない");
    return s.options;
  };

  it("PUT LIST", () =>
    expect(putOf("put list('a');")).toEqual([
      { kind: "list", items: [{ kind: "str", value: "a" }] },
    ]));

  it("PUT SKIP LIST", () => {
    const o = putOf("put skip list(1);");
    expect(o[0]).toEqual({ kind: "skip" });
    expect(o[1]?.kind).toBe("list");
  });

  it("PUT SKIP 単独", () => expect(putOf("put skip;")).toEqual([{ kind: "skip" }]));

  it("PUT SKIP(2)", () =>
    expect(putOf("put skip(2);")).toEqual([{ kind: "skip", count: { kind: "num", text: "2" } }]));

  it("LIST の項目が複数", () => {
    const o = putOf("put skip list(i, f);");
    const list = o[1];
    expect(list?.kind === "list" && list.items).toHaveLength(2);
  });
});

describe("IF", () => {
  it("THEN のみ", () => {
    const s = procBody("p: proc; if a = 1 then b = 2; end p;")[0];
    expect(s?.kind).toBe("if");
    if (s?.kind === "if") expect(s.else).toBeUndefined();
  });

  it("ELSE 付き", () => {
    const s = procBody("p: proc; if a = 1 then b = 2; else b = 3; end p;")[0];
    if (s?.kind !== "if") throw new Error("IF ではない");
    expect(s.else?.kind).toBe("assign");
  });

  it("ELSE IF の連鎖", () => {
    const s = procBody("p: proc; if a=1 then x=1; else if a=2 then x=2; else x=3; end p;")[0];
    if (s?.kind !== "if") throw new Error("IF ではない");
    expect(s.else?.kind).toBe("if");
  });

  it("THEN 節に DO 群を置ける", () => {
    const s = procBody("p: proc; if a=1 then do; x=1; y=2; end; end p;")[0];
    if (s?.kind !== "if") throw new Error("IF ではない");
    expect(s.then.kind).toBe("doGroup");
    if (s.then.kind === "doGroup") expect(s.then.body).toHaveLength(2);
  });

  // ELSE は最も内側の IF に結びつく
  it("ぶら下がり ELSE は内側の IF に付く", () => {
    const s = procBody("p: proc; if a=1 then if b=2 then x=1; else x=2; end p;")[0];
    if (s?.kind !== "if") throw new Error("IF ではない");
    expect(s.else).toBeUndefined();
    expect(s.then.kind).toBe("if");
    if (s.then.kind === "if") expect(s.then.else?.kind).toBe("assign");
  });
});

describe("DO", () => {
  it("DO 群", () => {
    const s = procBody("p: proc; do; x=1; end; end p;")[0];
    expect(s?.kind).toBe("doGroup");
  });

  it("DO WHILE", () => {
    const s = procBody("p: proc; do while(x < 3); x = x+1; end; end p;")[0];
    expect(s?.kind).toBe("doWhile");
  });

  it("DO UNTIL", () => {
    const s = procBody("p: proc; do until(x >= 3); x = x+1; end; end p;")[0];
    expect(s?.kind).toBe("doUntil");
  });

  it("DO var = a TO b", () => {
    const s = procBody("p: proc; do i = 1 to 9; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO 反復ではない");
    expect(s.varName).toBe("i");
    expect(s.specs).toHaveLength(1);
    expect(s.specs[0]?.to).toEqual({ kind: "num", text: "9" });
    expect(s.specs[0]?.by).toBeUndefined();
  });

  it("DO var = a TO b BY c", () => {
    const s = procBody("p: proc; do i = 1 to 9 by 3; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO 反復ではない");
    expect(s.specs[0]?.by).toEqual({ kind: "num", text: "3" });
  });

  it("入れ子の DO", () => {
    const s = procBody("p: proc; do i=1 to 2; do j=1 to 2; end; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO 反復ではない");
    expect(s.body[0]?.kind).toBe("doIter");
  });
});

describe("CALL と RETURN", () => {
  it("引数付き CALL", () => {
    const s = procBody("p: proc; call f(1, 2); end p;")[0];
    if (s?.kind !== "call") throw new Error("CALL ではない");
    expect(s.name).toBe("f");
    expect(s.args).toHaveLength(2);
  });

  it("引数なし CALL", () => {
    const s = procBody("p: proc; call f; end p;")[0];
    if (s?.kind !== "call") throw new Error("CALL ではない");
    expect(s.args).toEqual([]);
  });

  it("値を返す RETURN", () => {
    const s = procBody("p: proc; return(1); end p;")[0];
    if (s?.kind !== "return") throw new Error("RETURN ではない");
    expect(s.value).toEqual({ kind: "num", text: "1" });
  });

  it("値のない RETURN", () => {
    const s = procBody("p: proc; return; end p;")[0];
    if (s?.kind !== "return") throw new Error("RETURN ではない");
    expect(s.value).toBeUndefined();
  });
});

describe("式の優先順位", () => {
  const exprOf = (src: string): Expr => {
    const s = procBody(`p: proc; x = ${src}; end p;`)[0];
    if (s?.kind !== "assign") throw new Error("代入ではない");
    return s.value;
  };
  /** 括弧表記にして構造を確認しやすくする。 */
  const show = (e: Expr): string => {
    switch (e.kind) {
      case "num": return e.text;
      case "str": return `'${e.value}'`;
      case "bit": return `'${e.value}'B`;
      case "ref": return e.subscripts.length
        ? `${e.name}(${e.subscripts.map(show).join(",")})` : e.name;
      case "unary": return `(${e.op}${show(e.operand)})`;
      case "binary": return `(${show(e.left)}${e.op}${show(e.right)})`;
    }
  };

  it("* は + より強い", () => expect(show(exprOf("2 + 3 * 4"))).toBe("(2+(3*4))"));
  it("括弧が優先される", () => expect(show(exprOf("(2 + 3) * 4"))).toBe("((2+3)*4)"));
  it("** は * より強い", () => expect(show(exprOf("2 * 3 ** 4"))).toBe("(2*(3**4))"));
  it("** は右結合", () => expect(show(exprOf("2 ** 3 ** 4"))).toBe("(2**(3**4))"));
  it("単項マイナス", () => expect(show(exprOf("-a + b"))).toBe("((-a)+b)"));
  it("NOT", () => expect(show(exprOf("^p"))).toBe("(¬p)"));
  it("|| は + より弱い", () => expect(show(exprOf("a + b || c"))).toBe("((a+b)||c)"));
  it("比較は || より弱い", () => expect(show(exprOf("a || b = c"))).toBe("((a||b)=c)"));
  it("& は比較より弱い", () => expect(show(exprOf("a = 1 & b = 2"))).toBe("((a=1)&(b=2))"));
  it("| は & より弱い", () => expect(show(exprOf("a & b | c & d"))).toBe("((a&b)|(c&d))"));
  it("同じ優先順位は左結合", () => expect(show(exprOf("1 - 2 - 3"))).toBe("((1-2)-3)"));
  it("関数呼び出し", () => expect(show(exprOf("mod(i, 15)"))).toBe("mod(i,15)"));
  it("入れ子の関数呼び出し", () => expect(show(exprOf("abs(mod(a,b))"))).toBe("abs(mod(a,b))"));
  it("ビット定数", () => expect(show(exprOf("'1'b"))).toBe("'1'B"));
});

describe("その他の文", () => {
  it("空文", () => {
    const b = procBody("p: proc; ; end p;");
    expect(b[0]?.kind).toBe("null");
  });

  // ラベル付きの文は「ラベル文」と「本体の文」の2つに分かれる。
  // GOTO の飛び先を文列の中から探せるようにするため。
  it("ラベル付きの文はラベル文と本体に分かれる", () => {
    const b = procBody("p: proc; lab: x = 1; end p;");
    expect(b.map((s) => s.kind)).toEqual(["label", "assign"]);
    if (b[0]?.kind === "label") expect(b[0].name).toBe("lab");
  });
});

describe("未実装機能のエラーメッセージ", () => {
  /**
   * 実装済みの機能に当たったとき、「未対応の属性」ではなく
   * 何が未実装かを伝える。同梱サンプルが実際に使っている:
   *   numwrd.pli -> PRINT（ファイル宣言）
   *   isub.pli   -> DEFINED（iSUB 定義配列）
   */
  it("未実装と分かるメッセージを出す", () => {
    // 実装済みのもの（FILE/PRINT/DEFINED/ENTRY/BASED/POINTER/PICTURE）は含めない
    for (const attr of ["area", "keyed", "refer"]) {
      try {
        procBody(`p: proc; dcl x ${attr}; end p;`);
        expect.unreachable(`${attr} はエラーになるはず`);
      } catch (e) {
        expect(e).toBeInstanceOf(ParseError);
        expect((e as ParseError).message).toContain("未実装");
      }
    }
  });

  it("ファイル宣言は属性ごと受け付ける", () => {
    const st = procBody("p: proc; dcl sysprint print; end p;")[0];
    if (st?.kind !== "declare") throw new Error("宣言ではない");
    expect(st.items[0]?.attr).toEqual({ type: "file", print: true });
  });

  it("ファイルの詳しい属性を読み取る", () => {
    const st = procBody(
      "p: proc; dcl inp file stream input, out file record output env(f recsize(80)); end p;",
    )[0];
    if (st?.kind !== "declare") throw new Error("宣言ではない");
    expect(st.items[0]?.attr).toEqual({ type: "file", record: false, mode: "input" });
    expect(st.items[1]?.attr).toEqual({
      type: "file",
      record: true,
      mode: "output",
      recordSize: 80,
      variableRecords: false,
    });
  });

  it("本当に知らない語は別のメッセージ", () => {
    try {
      procBody("p: proc; dcl x zzzunknown; end p;");
      expect.unreachable("エラーになるはず");
    } catch (e) {
      expect((e as ParseError).message).not.toContain("未実装");
    }
  });
});

describe("エラー", () => {
  it("セミコロンが無ければエラー", () =>
    expect(() => body("p: proc; x = 1 end p;")).toThrow(ParseError));

  it("END が無ければエラー", () =>
    expect(() => body("p: proc; x = 1;")).toThrow(ParseError));

  it("閉じ括弧が無ければエラー", () =>
    expect(() => body("p: proc; x = (1 + 2; end p;")).toThrow(ParseError));

  it("エラーは行番号を持つ", () => {
    try {
      body("p: proc;\n x = 1\n end p;");
      expect.unreachable("エラーになるはず");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBeGreaterThan(1);
    }
  });
});

describe("PUT EDIT", () => {
  const editOf = (src: string) => {
    const s = procBody(`p: proc; ${src} end p;`)[0];
    if (s?.kind !== "put") throw new Error("PUT ではない");
    const e = s.options.find((o) => o.kind === "edit");
    if (e?.kind !== "edit") throw new Error("EDIT がない");
    return e;
  };

  it("A と F(w)", () => {
    // isub.pli: put skip edit('b: ',b)(a,(9)f(4));
    const e = editOf("put skip edit('b: ', b)(a, f(4));");
    expect(e.items).toHaveLength(2);
    expect(e.format).toEqual([
      { kind: "a" },
      { kind: "f", width: { kind: "num", text: "4" } },
    ]);
  });

  it("反復係数 (9)f(4)", () => {
    const e = editOf("put skip edit('b: ', b)(a, (9)f(4));");
    expect(e.format[1]).toEqual({
      kind: "repeat",
      count: { kind: "num", text: "9" },
      items: [{ kind: "f", width: { kind: "num", text: "4" } }],
    });
  });

  it("F(w,d) は小数桁を取る", () => {
    const e = editOf("put edit(x)(f(8,2));");
    expect(e.format[0]).toEqual({
      kind: "f",
      width: { kind: "num", text: "8" },
      decimals: { kind: "num", text: "2" },
    });
  });

  it("A(w)", () => {
    const e = editOf("put edit(s)(a(10));");
    expect(e.format[0]).toEqual({ kind: "a", width: { kind: "num", text: "10" } });
  });

  it("X(w) と COLUMN(n)", () => {
    const e = editOf("put edit(s)(x(3), column(20), a);");
    expect(e.format[0]).toEqual({ kind: "x", width: { kind: "num", text: "3" } });
    expect(e.format[1]).toEqual({ kind: "column", at: { kind: "num", text: "20" } });
  });

  it("書式リスト内の SKIP", () => {
    const e = editOf("put edit(a, b)(f(4), skip, f(4));");
    expect(e.format[1]).toEqual({ kind: "fskip" });
  });

  it("反復係数に括弧付きリストを取れる", () => {
    const e = editOf("put edit(a, b)((2)(f(4), x(1)));");
    const r = e.format[0];
    expect(r?.kind).toBe("repeat");
    if (r?.kind === "repeat") expect(r.items).toHaveLength(2);
  });

  it("EDIT は単独でも使える（SKIP なし）", () => {
    const e = editOf("put edit('x')(a);");
    expect(e.items).toHaveLength(1);
  });
});

describe("GET", () => {
  it("GET STRING ... EDIT", () => {
    // isub.pli: get string(t) edit(d)(f(5));
    const s = procBody("p: proc; get string(t) edit(d)(f(5)); end p;")[0];
    if (s?.kind !== "get") throw new Error("GET ではない");
    expect(s.source).toEqual({
      kind: "string",
      expr: { kind: "ref", name: "t", subscripts: [] },
    });
    expect(s.targets).toHaveLength(1);
    expect(s.format).toEqual([{ kind: "f", width: { kind: "num", text: "5" } }]);
  });

  it("GET STRING ... LIST", () => {
    const s = procBody("p: proc; get string(t) list(a, b); end p;")[0];
    if (s?.kind !== "get") throw new Error("GET ではない");
    expect(s.targets).toHaveLength(2);
    expect(s.format).toBeUndefined();
  });

  it("GET FILE(f) ... LIST", () => {
    const s = procBody("p: proc; get file(sysin) list(a); end p;")[0];
    if (s?.kind !== "get") throw new Error("GET ではない");
    expect(s.source).toEqual({ kind: "file", name: "sysin" });
  });

  it("ファイル指定を省略すると SYSIN", () => {
    const s = procBody("p: proc; get list(a); end p;")[0];
    if (s?.kind !== "get") throw new Error("GET ではない");
    expect(s.source).toEqual({ kind: "file", name: "SYSIN" });
  });

  it("SKIP を付けられる", () => {
    const s = procBody("p: proc; get skip list(a); end p;")[0];
    if (s?.kind !== "get") throw new Error("GET ではない");
    expect(s.skip).toBeNull();
    const s2 = procBody("p: proc; get skip(2) list(a); end p;")[0];
    if (s2?.kind !== "get") throw new Error("GET ではない");
    expect(s2.skip).toEqual({ kind: "num", text: "2" });
  });
});

describe("DEFINED（別名定義）", () => {
  /**
   * isub.pli: dcl d(3) bin fixed def (b(1sub,1sub));
   * d は b の対角成分への別名。iSUB は「この次元の添字」を表す仮変数で、
   * 1sub は第1次元の添字を意味する。
   */
  it("DEFINED の基底参照を保持する", () => {
    const s = procBody("p: proc; dcl d(3) bin fixed def (b(1sub,1sub)); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    const item = s.items[0];
    expect(item?.defined).toBeDefined();
    expect(item?.defined?.name).toBe("b");
    expect(item?.defined?.subscripts).toHaveLength(2);
  });

  it("iSUB は添字の位置を持つ式になる", () => {
    const s = procBody("p: proc; dcl d(3) fixed bin def (b(1sub,1sub)); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.defined?.subscripts[0]).toEqual({ kind: "isub", dim: 1 });
  });

  it("DEFINED と DEF の両方を受け付ける", () => {
    for (const kw of ["def", "defined"]) {
      const s = procBody(`p: proc; dcl d(3) fixed bin ${kw} (b(1sub)); end p;`)[0];
      if (s?.kind !== "declare") throw new Error("宣言ではない");
      expect(s.items[0]?.defined?.name).toBe("b");
    }
  });

  it("添字が定数の DEFINED も書ける", () => {
    const s = procBody("p: proc; dcl x fixed bin def (b(2)); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.defined?.subscripts[0]).toEqual({ kind: "num", text: "2" });
  });
});

describe("SELECT", () => {
  it("SELECT(expr) と WHEN / OTHERWISE", () => {
    const s = procBody("p: proc; select (i); when (1) x=1; when (2,3) x=2; otherwise x=9; end; end p;")[0];
    if (s?.kind !== "select") throw new Error("SELECT ではない");
    expect(s.subject).toEqual({ kind: "ref", name: "i", subscripts: [] });
    expect(s.whens).toHaveLength(2);
    expect(s.whens[1]?.values).toHaveLength(2);
    expect(s.otherwise?.kind).toBe("assign");
  });

  it("SELECT; （条件式を省略した形）", () => {
    const s = procBody("p: proc; select; when (i > 3) x=1; otherwise x=2; end; end p;")[0];
    if (s?.kind !== "select") throw new Error("SELECT ではない");
    expect(s.subject).toBeUndefined();
  });

  it("OTHERWISE は省略できる", () => {
    const s = procBody("p: proc; select (i); when (1) x=1; end; end p;")[0];
    if (s?.kind !== "select") throw new Error("SELECT ではない");
    expect(s.otherwise).toBeUndefined();
  });

  it("WHEN 節に DO 群を置ける", () => {
    const s = procBody("p: proc; select (i); when (1) do; x=1; y=2; end; end; end p;")[0];
    if (s?.kind !== "select") throw new Error("SELECT ではない");
    expect(s.whens[0]?.body.kind).toBe("doGroup");
  });
});

describe("LEAVE / ITERATE / GOTO", () => {
  it("LEAVE", () => {
    const s = procBody("p: proc; do i=1 to 3; leave; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO ではない");
    expect(s.body[0]?.kind).toBe("leave");
  });

  it("ITERATE", () => {
    const s = procBody("p: proc; do i=1 to 3; iterate; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO ではない");
    expect(s.body[0]?.kind).toBe("iterate");
  });

  it("GOTO とラベル", () => {
    const b = procBody("p: proc; goto done; done: x=1; end p;");
    expect(b[0]?.kind).toBe("goto");
    if (b[0]?.kind === "goto") expect(b[0].label).toBe("done");
    // ラベルだけの行は label 文になる
    expect(b.some((s) => s.kind === "label")).toBe(true);
  });

  it("GO TO（2語）も受け付ける", () => {
    const s = procBody("p: proc; go to done; done: x=1; end p;")[0];
    if (s?.kind !== "goto") throw new Error("GOTO ではない");
    expect(s.label).toBe("done");
  });

  it("leave は変数名にもなる", () => {
    const s = procBody("p: proc; leave = 1; end p;")[0];
    expect(s?.kind).toBe("assign");
  });
});

describe("ON / SIGNAL", () => {
  it("ON ERROR と BEGIN ブロック", () => {
    const s = procBody("p: proc; on error begin; x=1; end; end p;")[0];
    if (s?.kind !== "on") throw new Error("ON ではない");
    expect(s.condition).toBe("ERROR");
    expect(s.body.kind).toBe("beginBlock");
  });

  it("ON に単一文を書ける", () => {
    const s = procBody("p: proc; on error x=1; end p;")[0];
    if (s?.kind !== "on") throw new Error("ON ではない");
    expect(s.body.kind).toBe("assign");
  });

  it("ON ZERODIVIDE", () => {
    const s = procBody("p: proc; on zerodivide x=1; end p;")[0];
    if (s?.kind !== "on") throw new Error("ON ではない");
    expect(s.condition).toBe("ZERODIVIDE");
  });

  it("SIGNAL", () => {
    const s = procBody("p: proc; signal error; end p;")[0];
    if (s?.kind !== "signal") throw new Error("SIGNAL ではない");
    expect(s.condition).toBe("ERROR");
  });
});

describe("BEGIN ブロック", () => {
  it("独自の宣言を持てる", () => {
    const s = procBody("p: proc; begin; dcl x fixed bin(31); x=1; end; end p;")[0];
    if (s?.kind !== "beginBlock") throw new Error("BEGIN ではない");
    expect(s.body).toHaveLength(2);
  });
});

describe("DO の複数指定", () => {
  it("TO を2つ並べる", () => {
    const s = procBody("p: proc; do i = 1 to 3, 7 to 9; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO ではない");
    expect(s.specs).toHaveLength(2);
    expect(s.specs[1]?.to).toEqual({ kind: "num", text: "9" });
  });

  it("単一値を並べる", () => {
    const s = procBody("p: proc; do i = 1, 5, 10; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO ではない");
    expect(s.specs).toHaveLength(3);
    expect(s.specs[0]?.to).toBeUndefined();
  });

  it("BY 付きの指定も混在できる", () => {
    const s = procBody("p: proc; do i = 1 to 9 by 2, 20; end; end p;")[0];
    if (s?.kind !== "doIter") throw new Error("DO ではない");
    expect(s.specs[0]?.by).toEqual({ kind: "num", text: "2" });
    expect(s.specs[1]?.to).toBeUndefined();
  });
});

describe("構造体", () => {
  it("レベル番号を読む", () => {
    const s = procBody("p: proc; dcl 1 rec, 2 name char(10), 2 age fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.level).toBe(1);
    expect(s.items[0]?.names).toEqual(["rec"]);
    expect(s.items[1]?.level).toBe(2);
    expect(s.items[1]?.attr).toEqual({ type: "char", length: 10, varying: false });
  });

  it("3階層", () => {
    const s = procBody(
      "p: proc; dcl 1 r, 2 a, 3 b char(4), 3 c fixed bin(31); end p;",
    )[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items.map((x) => x.level)).toEqual([1, 2, 3, 3]);
  });

  it("レベルの無い宣言は level を持たない", () => {
    const s = procBody("p: proc; dcl x fixed bin(31); end p;")[0];
    if (s?.kind !== "declare") throw new Error("宣言ではない");
    expect(s.items[0]?.level).toBeUndefined();
  });

  it("修飾名で参照できる", () => {
    const s = procBody("p: proc; rec.addr.city = 'x'; end p;")[0];
    if (s?.kind !== "assign") throw new Error("代入ではない");
    expect(s.target.name).toBe("rec.addr.city");
  });
});

describe("ENTRY 宣言", () => {
  it("外部手続きの宣言として受け付ける", () => {
    const body = procBody("p: proc; dcl f entry; end p;");
    const d = body[0];
    expect(d?.kind).toBe("declare");
    if (d?.kind === "declare") expect(d.items[0]?.attr).toEqual({ type: "entry" });
  });

  it("引数の記述と OPTIONS は読み飛ばす", () => {
    const body = procBody("p: proc; dcl f entry(fixed bin(31), char(10)) options(asm); end p;");
    const d = body[0];
    if (d?.kind === "declare") expect(d.items[0]?.attr).toEqual({ type: "entry" });
  });

  it("RETURNS の型は覚える", () => {
    const body = procBody("p: proc; dcl f entry returns(fixed dec(7,2)); end p;");
    const d = body[0];
    if (d?.kind === "declare") {
      expect(d.items[0]?.attr).toEqual({
        type: "entry",
        returns: { type: "fixed", base: "dec", p: 7, q: 2 },
      });
    }
  });
});

/**
 * 未実装を名指しで断る。
 *
 * この処理系の約束は「できないことは黙って動かさず、何が未実装かを
 * 名指しで断る」。素の構文エラーになると、綴り間違いと未実装の
 * 区別が付かなくなるので、README が未実装として挙げた機能は
 * 必ず名指しできることを固定する。
 */
describe("未実装の名指し", () => {
  const why = (src: string): string => {
    try {
      parse(src);
      return "(誤りにならなかった)";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const MAIN = (body: string) => `m: proc options(main);\n${body}\nend m;\n`;

  it("README が未実装として挙げた属性を名指しする", () => {
    for (const [code, word] of [
      ["dcl f file keyed;", "KEYED"],
      ["dcl f file regional;", "REGIONAL"],
      ["dcl e event;", "EVENT"],
      ["dcl a area(100);", "AREA"],
      ["dcl 1 b like a;", "LIKE"],
      ["dcl 1 u union, 2 a char(4);", "UNION"],
      ["dcl z complex;", "COMPLEX"],
    ] as const) {
      const m = why(MAIN(`  ${code}`));
      expect(m, code).toContain(word);
      expect(m, code).toContain("未実装");
    }
  });

  it("README が未実装として挙げた文を名指しする", () => {
    for (const [code, word] of [
      ["wait(e);", "WAIT"],
      ["display('x');", "DISPLAY"],
      ["revert error;", "REVERT"],
      ["delete file(f);", "DELETE"],
    ] as const) {
      const m = why(MAIN(`  ${code}`));
      expect(m, code).toContain(word);
      expect(m, code).toContain("未実装");
    }
  });

  it("知らない語は未実装とは言わない（綴り間違いと区別する）", () => {
    expect(why(MAIN("  frobnicate x;"))).toContain("解釈できない文です");
  });

  /**
   * 構造体そのものに付けた次元（構造体の配列）。
   *
   * 平坦化（`declare.ts`）が中間レベルの次元を葉へ渡さないので、
   * 受けると葉が次元を持たない 1 個の箱になり、`tbl.nm(1)` から
   * `tbl.nm(3)` までが全部その 1 個を指して最後に書いた値を返す。
   * 黙って嘘を出すより、宣言の時点で断る。
   */
  it("構造体そのものに付けた次元を名指しで断る", () => {
    const m = why(MAIN("  dcl 1 tbl(3), 2 nm char(4);"));
    expect(m).toContain("構造体の配列");
    expect(m).toContain("未実装");
    expect(m).toContain("tbl");
  });

  it("葉に付けた次元と、子を持たない項目の次元は通る", () => {
    expect(why(MAIN("  dcl 1 rec, 2 nm char(4), 2 a(3) fixed bin(15);"))).toBe(
      "(誤りにならなかった)",
    );
    // 子を持たないレベル 1 は普通の配列
    expect(why(MAIN("  dcl 1 a(3) fixed bin(15);"))).toBe("(誤りにならなかった)");
    // 入れ子の内側の構造体でも、子を持つ項目の次元だけを断る
    expect(why(MAIN("  dcl 1 r, 2 s, 3 t(4) char(2);"))).toBe("(誤りにならなかった)");
  });
});
