/**
 * PL/I のコード Snippet。
 *
 * VSCode Extension とブラウザ版の両方で使うため、定義はここ一箇所に置く。
 * VSCode 用の JSON は `scripts/gen-snippets.ts` がここから生成する。
 *
 * 本文は VSCode の Snippet 記法（`${1:名前}` と `$0`）で書く。
 * ブラウザ版は `plainText()` で記法を取り除いて挿入する。
 */

export interface Snippet {
  /** 一覧に出す名前。 */
  name: string;
  /** 入力して展開する語。 */
  prefix: string;
  description: string;
  body: string[];
  /** 展開しただけで完結したプログラムになるか。 */
  standalone?: boolean;
}

export const SNIPPETS: Snippet[] = [
  {
    name: "主手続き",
    prefix: "main",
    description: "OPTIONS(MAIN) を持つ主手続き",
    standalone: true,
    body: ["${1:prog}: proc options(main);", "  $0", "end ${1:prog};", ""],
  },
  {
    name: "Hello World",
    prefix: "hello",
    description: "最小のプログラム",
    standalone: true,
    body: [
      "hello: proc options(main);",
      "  put list('HELLO, PL/I');",
      "end hello;",
      "",
    ],
  },
  {
    name: "引数を取る主手続き",
    prefix: "mainarg",
    description: "コマンドライン引数を受け取る主手続き",
    standalone: true,
    body: [
      "${1:prog}: proc(parm) options(main);",
      "  dcl parm char(100) varying;",
      "  put skip list(parm);",
      "  $0",
      "end ${1:prog};",
      "",
    ],
  },
  {
    name: "内部手続き",
    prefix: "proc",
    description: "引数を取る内部手続き",
    body: [
      "${1:name}: proc(${2:arg});",
      "  dcl ${2:arg} fixed bin(31);",
      "  $0",
      "end ${1:name};",
    ],
  },
  {
    name: "値を返す手続き",
    prefix: "func",
    description: "RETURNS を持つ手続き",
    body: [
      "${1:name}: proc(${2:arg}) returns(${3:fixed bin(31)});",
      "  dcl ${2:arg} fixed bin(31);",
      "  $0",
      "  return(${2:arg});",
      "end ${1:name};",
    ],
  },
  {
    name: "再帰手続き",
    prefix: "recur",
    description: "RECURSIVE を持つ手続き",
    body: [
      "${1:fib}: proc(n) returns(fixed bin(31)) recursive;",
      "  dcl n fixed bin(31);",
      "  if n < 2 then return(n);",
      "  return(${1:fib}(n-1) + ${1:fib}(n-2));",
      "end ${1:fib};",
    ],
  },
  {
    name: "宣言（整数）",
    prefix: "dclbin",
    description: "FIXED BINARY の宣言",
    body: ["dcl ${1:i} fixed bin(${2:31});$0"],
  },
  {
    name: "宣言（10進固定小数点）",
    prefix: "dcldec",
    description: "FIXED DECIMAL の宣言。金額など正確な10進計算に使う",
    body: ["dcl ${1:amount} fixed dec(${2:15},${3:2});$0"],
  },
  {
    name: "宣言（文字列）",
    prefix: "dclchar",
    description: "CHARACTER VARYING の宣言",
    body: ["dcl ${1:s} char(${2:80}) varying;$0"],
  },
  {
    name: "宣言（配列）",
    prefix: "dclarr",
    description: "初期値付きの配列",
    body: ["dcl ${1:a}(${2:10}) fixed bin(31) init(${3:0});$0"],
  },
  {
    name: "宣言（構造体）",
    prefix: "struct",
    description: "レベル番号を使った構造体",
    body: [
      "dcl 1 ${1:rec},",
      "      2 ${2:name} char(${3:20}) varying,",
      "      2 ${4:count} fixed bin(31);",
      "$0",
    ],
  },
  {
    name: "IF / THEN / ELSE",
    prefix: "if",
    description: "条件分岐",
    body: ["if ${1:cond} then", "  ${2:;}", "else", "  ${3:;}", "$0"],
  },
  {
    name: "IF と DO 群",
    prefix: "ifdo",
    description: "複数文を持つ条件分岐",
    body: ["if ${1:cond} then", "  do;", "    $0", "  end;"],
  },
  {
    name: "DO 反復",
    prefix: "do",
    description: "添字による繰り返し",
    body: ["do ${1:i} = ${2:1} to ${3:10};", "  $0", "end;"],
  },
  {
    name: "DO WHILE",
    prefix: "dowhile",
    description: "条件が真の間繰り返す",
    body: ["do while(${1:cond});", "  $0", "end;"],
  },
  {
    name: "DO UNTIL",
    prefix: "dountil",
    description: "条件が真になるまで繰り返す",
    body: ["do until(${1:cond});", "  $0", "end;"],
  },
  {
    name: "SELECT",
    prefix: "select",
    description: "値による分岐",
    body: [
      "select (${1:expr});",
      "  when (${2:1}) ${3:;}",
      "  otherwise ${4:;}",
      "end;",
      "$0",
    ],
  },
  {
    name: "SELECT（条件式）",
    prefix: "selectw",
    description: "条件による分岐（SELECT; 形式）",
    body: [
      "select;",
      "  when (${1:cond}) ${2:;}",
      "  otherwise ${3:;}",
      "end;",
      "$0",
    ],
  },
  {
    name: "PUT LIST",
    prefix: "put",
    description: "値を並べて出力（24桁ごとに配置される）",
    body: ["put skip list(${1:x});$0"],
  },
  {
    name: "PUT EDIT",
    prefix: "pute",
    description: "書式を指定して出力",
    body: ["put skip edit(${1:x})(${2:f(10)});$0"],
  },
  {
    name: "GET STRING",
    prefix: "gets",
    description: "文字列から値を読み取る",
    body: ["get string(${1:text}) edit(${2:x})(${3:f(10)});$0"],
  },
  {
    name: "ON 条件",
    prefix: "on",
    description: "条件が起きたときの処理",
    body: [
      "on ${1|error,zerodivide,fixedoverflow,conversion,subscriptrange|}",
      "  begin;",
      "    $0",
      "  end;",
    ],
  },
  {
    name: "BEGIN ブロック",
    prefix: "begin",
    description: "独自の名前の有効範囲を持つブロック",
    body: ["begin;", "  $0", "end;"],
  },
  {
    name: "%REPLACE",
    prefix: "replace",
    description: "定数の定義（プリプロセッサ）",
    body: ["%replace ${1:NAME} by ${2:1};$0"],
  },
  {
    name: "DEFINED（別名）",
    prefix: "defined",
    description: "別の変数への別名。iSUB で添字を対応づけられる",
    body: ["dcl ${1:d}(${2:3}) fixed bin(31) def (${3:b}(1sub,1sub));$0"],
  },
  {
    name: "FizzBuzz",
    prefix: "fizzbuzz",
    description: "動作確認用のサンプル",
    standalone: true,
    body: [
      "fb: proc options(main);",
      "  dcl i fixed bin(31);",
      "  do i = 1 to 20;",
      "    if mod(i, 15) = 0 then put skip list('FizzBuzz');",
      "    else if mod(i, 3) = 0 then put skip list('Fizz');",
      "    else if mod(i, 5) = 0 then put skip list('Buzz');",
      "    else put skip list(i);",
      "  end;",
      "end fb;",
      "",
    ],
  },
  {
    name: "10進計算の例",
    prefix: "decdemo",
    description: "FIXED DECIMAL による正確な10進計算（浮動小数では誤差が出る）",
    standalone: true,
    body: [
      "money: proc options(main);",
      "  dcl price fixed dec(7,2);",
      "  dcl rate  fixed dec(3,2);",
      "  dcl tax   fixed dec(9,4);",
      "  price = 1980.00;",
      "  rate  = 0.10;",
      "  tax   = price * rate;",
      "  put skip list('税抜', price);",
      "  put skip list('税額', tax);",
      "  put skip list('税込', price + tax);",
      "end money;",
      "",
    ],
  },
  {
    name: "テスト手続き",
    prefix: "test",
    description: "pli-test のテスト手続き（TEST_ で始める）",
    body: [
      "TEST_${1:name}: proc;",
      "  call ASSERT_EQ(${2:actual}, ${3:expected}, '${1:name}');",
      "  $0",
      "end TEST_${1:name};",
    ],
  },
  {
    name: "標準入力から読む",
    prefix: "getlist",
    description: "SYSIN から読み、ENDFILE で終わるループ",
    standalone: true,
    body: [
      "${1:prog}: proc options(main);",
      "  dcl ${2:value} fixed bin(31);",
      "  dcl done bit(1);",
      "  done = '0'b;",
      "  on endfile(sysin) done = '1'b;",
      "  do while(^done);",
      "    get list(${2:value});",
      "    if ^done then do;",
      "      $0",
      "    end;",
      "  end;",
      "end ${1:prog};",
      "",
    ],
  },
  {
    name: "ファイルを読む",
    prefix: "readfile",
    description: "名前付きファイルを開いて読み、閉じる",
    body: [
      "dcl ${1:inp} file stream input;",
      "dcl done bit(1);",
      "done = '0'b;",
      "on endfile(${1:inp}) done = '1'b;",
      "open file(${1:inp}) input;",
      "do while(^done);",
      "  get file(${1:inp}) list(${2:value});",
      "  if ^done then do;",
      "    $0",
      "  end;",
      "end;",
      "close file(${1:inp});",
    ],
  },
  {
    name: "ファイルへ書く",
    prefix: "writefile",
    description: "名前付きファイルを開いて書き、閉じる",
    body: [
      "dcl ${1:rep} file stream output print;",
      "open file(${1:rep}) output linesize(${2:80});",
      "put file(${1:rep}) list(${3:'text'});",
      "$0",
      "close file(${1:rep});",
    ],
  },
  {
    name: "取り込み",
    prefix: "include",
    description: "宣言群を取り込む",
    body: ["%include ${1:decls};", "$0"],
  },
  {
    name: "金額のピクチャ",
    prefix: "picamt",
    description: "通貨記号付きの金額（浮動する $ とカンマ）",
    // VSCode の Snippet 記法では $ が特別なので \$ と書く
    body: ["dcl ${1:amount} pic'\\$\\$\\$,\\$\\$9V.99';", "$0"],
  },
  {
    name: "ゼロ抑制のピクチャ",
    prefix: "piczz",
    description: "先行ゼロを空白にする整数",
    body: ["dcl ${1:count} pic'ZZZZ9';", "$0"],
  },
  {
    name: "連結リストの節",
    prefix: "node",
    description: "BASED の構造体とポインタ",
    body: [
      "dcl ${1:cur} pointer;",
      "dcl 1 ${2:node} based(${1:cur}),",
      "      2 value fixed bin(31),",
      "      2 next pointer;",
      "$0",
    ],
  },
  {
    name: "確保して繋ぐ",
    prefix: "alloc",
    description: "ALLOCATE して先頭に挿す",
    body: [
      "allocate ${1:node} set(${2:cur});",
      "${2:cur} -> ${1:node}.value = ${3:0};",
      "${2:cur} -> ${1:node}.next = ${4:head};",
      "${4:head} = ${2:cur};",
      "$0",
    ],
  },
  {
    name: "リストを走査",
    prefix: "walk",
    description: "NULL まで辿る",
    body: [
      "${1:cur} = ${2:head};",
      "do while(${1:cur} ^= null());",
      "  $0",
      "  ${1:cur} = ${1:cur} -> ${3:node}.next;",
      "end;",
    ],
  },
  {
    name: "レコードを読む",
    prefix: "readrec",
    description: "固定長レコードを順に読む",
    body: [
      "dcl ${1:inp} file record input env(f recsize(${2:80}));",
      "dcl 1 ${3:rec},",
      "      2 ${4:name} char(10),",
      "      2 ${5:value} pic'999';",
      "dcl done bit(1);",
      "done = '0'b;",
      "on endfile(${1:inp}) done = '1'b;",
      "open file(${1:inp}) input;",
      "do while('1'b);",
      "  read file(${1:inp}) into(${3:rec});",
      "  if done then leave;",
      "  $0",
      "end;",
      "close file(${1:inp});",
    ],
  },
  {
    name: "PCB マスク（DL/I）",
    prefix: "pcb",
    description: "IMS/DB の DB PCB マスク。主手続きの引数で受けたポインタに重ねる",
    body: [
      "dcl 1 ${1:db_pcb} based(${2:db_ptr}),",
      "      2 dbname     char(8),",
      "      2 seg_level  char(2),",
      "      2 stat_code  char(2),",
      "      2 proc_opt   char(4),",
      "      2 reserved   fixed bin(31),",
      "      2 seg_name   char(8),",
      "      2 len_kfb    fixed bin(31),",
      "      2 no_senseg  fixed bin(31),",
      "      2 key_fb     char(${3:20});",
      "$0",
    ],
  },
  {
    name: "DL/I の機能コード",
    prefix: "dlifunc",
    description: "よく使う DL/I の機能コードと引数個数の宣言",
    body: [
      "dcl plitdli entry;",
      "dcl (three, four, five) fixed bin(31);",
      "dcl func_gu   char(4) init('GU  ');",
      "dcl func_gn   char(4) init('GN  ');",
      "dcl func_gnp  char(4) init('GNP ');",
      "dcl func_ghu  char(4) init('GHU ');",
      "dcl func_isrt char(4) init('ISRT');",
      "dcl func_repl char(4) init('REPL');",
      "dcl func_dlet char(4) init('DLET');",
      "three = 3; four = 4; five = 5;",
      "$0",
    ],
  },
  {
    name: "DL/I で 1 件取る（GU）",
    prefix: "dligu",
    description: "修飾 SSA でセグメントを 1 件取り、ステータスコードを見る",
    body: [
      "/* 項目名は 8 桁、関係演算子は 2 桁。桁がずれると AJ になる */",
      "dcl ssa char(${1:25}) init('${2:STUDENT} (${3:STUDNO}   =${4:S0001})');",
      "call plitdli(four, func_gu, ${5:db_pcb}, ${6:seg_io}, ssa);",
      "select (${5:db_pcb}.stat_code);",
      "  when ('  ') put skip list(${6:seg_io});",
      "  when ('GE') put skip list('NOT FOUND');",
      "  otherwise put skip list('DLI ERROR ' || ${5:db_pcb}.stat_code);",
      "end;",
      "$0",
    ],
  },
  {
    name: "DL/I で順に読む（GN）",
    prefix: "dlign",
    description: "階層順に全件たどる。GA / GK は警告なので GB まで続ける",
    body: [
      "do while (${1:db_pcb}.stat_code ^= 'GB');",
      "  call plitdli(three, func_gn, ${1:db_pcb}, ${2:seg_io});",
      "  if ${1:db_pcb}.stat_code ^= 'GB' then do;",
      "    put skip list(${1:db_pcb}.seg_name, ${2:seg_io});",
      "    $0",
      "  end;",
      "end;",
    ],
  },
  {
    name: "DL/I で書き換える（GHU + REPL）",
    prefix: "dlirepl",
    description: "ホールド付きで取ってから置き換える。順序キーは変えられない",
    body: [
      "call plitdli(four, func_ghu, ${1:db_pcb}, ${2:seg_io}, ${3:ssa});",
      "if ${1:db_pcb}.stat_code = '  ' then do;",
      "  $0",
      "  call plitdli(three, func_repl, ${1:db_pcb}, ${2:seg_io});",
      "  if ${1:db_pcb}.stat_code ^= '  ' then",
      "    put skip list('REPL FAILED ' || ${1:db_pcb}.stat_code);",
      "end;",
    ],
  },
];

/** VSCode の Snippet 記法を取り除いて素のテキストにする。 */
export function plainText(body: string[]): string {
  return body
    .join("\n")
    // ${1|a,b,c|} → 最初の選択肢
    .replace(/\$\{\d+\|([^|]*)\|\}/g, (_m, choices: string) => choices.split(",")[0] ?? "")
    // ${1:既定値} → 既定値
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    // ${1} / $1 / $0 → 空
    .replace(/\$\{\d+\}/g, "")
    .replace(/\$\d+/g, "")
    // 退避した \$ を戻す（PICTURE の通貨記号など）
    .replace(/\\\$/g, "$");
}

export interface VscodeSnippet {
  prefix: string;
  body: string[];
  description: string;
}

/** VSCode の snippets ファイルの形に変換する。 */
export function toVscodeSnippets(): Record<string, VscodeSnippet> {
  const out: Record<string, VscodeSnippet> = {};
  for (const s of SNIPPETS) {
    out[s.name] = { prefix: s.prefix, body: s.body, description: s.description };
  }
  return out;
}
