/**
 * ブラウザ版に載せるサンプル。
 * すべて実行できることをテストで保証している。
 */
export interface Sample {
  name: string;
  source: string;
  /**
   * 付随ファイル（`::: 名前` の記法）。
   * DL/I のサンプルは DBD・PSB・データが揃っていないと動かないので、
   * サンプルを選んだときに付随ファイル欄へ一緒に入れる。
   */
  aux?: string;
}

export const SAMPLES: Sample[] = [
  {
    name: "Hello World",
    source: `/* 最小のプログラム */
hello: proc options(main);
  put list('HELLO, PL/I');
end hello;
`,
  },
  {
    name: "予約語が無い例",
    source: `/* PL/I には予約語が無い。IF/THEN/ELSE を変数名に使える。
   これは「IF と THEN が等しければ THEN に ELSE を代入する」という文。 */
kw: proc options(main);
  dcl (if, then, else) fixed bin(31);
  if = 1;
  then = 2;
  else = 3;
  if if = then then then = else;
  put skip list(if, then, else);
  if if < then then put skip list('if < then');
  else put skip list('if >= then');
end kw;
`,
  },
  {
    name: "FizzBuzz",
    source: `fb: proc options(main);
  dcl i fixed bin(31);
  do i = 1 to 20;
    if mod(i, 15) = 0 then put skip list('FizzBuzz');
    else if mod(i, 3) = 0 then put skip list('Fizz');
    else if mod(i, 5) = 0 then put skip list('Buzz');
    else put skip list(i);
  end;
end fb;
`,
  },
  {
    name: "固定小数点演算",
    source: `/* FIXED DECIMAL は10進固定小数点として正確に扱われる。
   123.45 * 6.7 は浮動小数では誤差が出るが、ここでは正確に 827.115 になる。 */
fdec: proc options(main);
  dcl x fixed dec(5,2);
  dcl y fixed dec(3,1);
  x = 123.45;
  y = 6.7;
  put skip list(x);
  put skip list(y);
  put skip list(x + y);
  put skip list(x * y);
end fdec;
`,
  },
  {
    name: "階乗",
    source: `fact: proc options(main);
  dcl i fixed dec(2,0);
  dcl f fixed dec(15,0);
  f = 1;
  do i = 1 to 15;
    f = f * i;
    put skip list(i, f);
  end;
end fact;
`,
  },
  {
    name: "ハノイの塔（再帰）",
    source: ` hanoi: proc options(main);

  call dohanoi(3, 1, 3, 2);

  dohanoi: proc(n, f, t, u) recursive;
    dcl (n, f, t, u) fixed bin(31);
    if n > 0 then
    do;
      call dohanoi(n-1, f, u, t);
      call movedisk(f, t);
      call dohanoi(n-1, u, t, f);
    end;
  end dohanoi;

  movedisk: proc(f, t);
    dcl (f, t) fixed bin(31);
    put skip list('move' || f, '->' || t);
  end movedisk;

 end hanoi;
`,
  },
  {
    name: "九九（書式）",
    source: `mt: proc options(main);
  dcl (i, j) fixed bin(31);
  do i = 1 to 9;
    do j = 1 to 9;
      put edit(i * j)(f(4));
    end;
    put skip;
  end;
end mt;
`,
  },
  {
    name: "構造体",
    source: `st: proc options(main);
  dcl 1 rec,
        2 name char(10),
        2 age  fixed bin(31),
        2 addr,
          3 city char(8),
          3 zip  fixed dec(7,0);
  rec.name = 'Taro';
  rec.age = 30;
  rec.addr.city = 'Sendai';
  rec.addr.zip = 9800001;
  put skip list(rec.name);
  put skip list(rec.age);
  put skip list(rec.addr.city);
  put skip list(rec.addr.zip);
end st;
`,
  },
  {
    name: "SELECT と配列式",
    source: `ae: proc options(main);
  dcl a(3) fixed bin(31) init(1, 2, 3);
  dcl b(3) fixed bin(31) init(10, 20, 30);
  dcl c(3) fixed bin(31);
  dcl i fixed bin(31);

  c = a + b;
  put skip list(c(1), c(2), c(3));

  do i = 1 to 4;
    select (i);
      when (1) put skip list('one');
      when (2, 3) put skip list('two or three');
      otherwise put skip list('other');
    end;
  end;
end ae;
`,
  },
  {
    name: "DEFINED と iSUB",
    source: `/* d は b の対角成分への別名。1sub は「別名側の第1次元の添字」を表す。 */
isub: proc options(main);
  dcl b(3,3) bin fixed init(1,2,3, 4,5,6, 7,8,9);
  dcl d(3) bin fixed def (b(1sub,1sub));
  dcl t char(80) var init('   -1   -2   -3');

  put skip list('対角成分');
  put skip edit('b: ', b)(a, (9)f(4));
  put skip edit('d: ', d)(a, (3)f(4));
  put skip;
  get string(t) edit(d)(f(5));
  put skip edit('b: ', b)(a, (9)f(4));
end isub;
`,
  },
  {
    name: "%REPLACE",
    source: `%replace LIMIT by 3;
%replace GREET by 'hello';
rp: proc options(main);
  dcl i fixed bin(31);
  do i = 1 to LIMIT;
    put skip list(GREET);
  end;
  put skip list(LIMIT * 2);
end rp;
`,
  },
  {
    name: "テストの書き方",
    source: `/* テストファイル。主手続きは書かない。
   TEST_ で始まる引数なしの手続きがテストとして実行される。
   SETUP はテストごとに走り、テストは 1 件ずつ別に実行されるので
   あるテストが壊した状態は次のテストに漏れない。 */

dcl counter fixed bin(31);

SETUP: proc;
  counter = 0;
end SETUP;

TEST_DECIMAL_IS_EXACT: proc;
  dcl x fixed dec(5,2);
  x = 0.1;
  x = x + 0.2;
  call ASSERT_EQUALS(0.3, x, '10進なら誤差が出ない');
end TEST_DECIMAL_IS_EXACT;

TEST_SETUP_RUNS_FOR_EACH: proc;
  counter = counter + 1;
  call ASSERT_EQUALS(1, counter, 'SETUP が毎回走る');
end TEST_SETUP_RUNS_FOR_EACH;

TEST_STATE_IS_ISOLATED: proc;
  counter = counter + 1;
  call ASSERT_EQUALS(1, counter, '前のテストの値は残らない');
end TEST_STATE_IS_ISOLATED;

TEST_STRING: proc;
  call ASSERT_EQUALS_CHAR('cd', substr('abcdef', 3, 2), 'SUBSTR');
end TEST_STRING;

TEST_THIS_ONE_FAILS: proc;
  call ASSERT_EQUALS(10, 7 + 2, 'わざと間違えた例');
end TEST_THIS_ONE_FAILS;

DISABLED_TEST_NOT_READY: proc;
  call FAIL('DISABLED_ が付いているので実行されない');
end DISABLED_TEST_NOT_READY;
`,
  },
  {
    name: "IMS/DB（DL/I）",
    source: `/* 階層型データベースを階層順に読む。
   PCB マスクは主手続きの引数で受けたポインタに BASED で宣言する。
   DBD・PSB・データは「ファイル」欄にある。 */
stuprt: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl (io_ptr, db_ptr) pointer;
  dcl 1 db_pcb based(db_ptr),
        2 dbname     char(8),
        2 seg_level  char(2),
        2 stat_code  char(2),
        2 proc_opt   char(4),
        2 reserved   fixed bin(31),
        2 seg_name   char(8),
        2 len_kfb    fixed bin(31),
        2 no_senseg  fixed bin(31),
        2 key_fb     char(9);
  dcl three fixed bin(31) init(3);
  dcl func_gn char(4) init('GN  ');
  dcl seg_io char(13);

  put skip list('LEVEL SEGMENT  DATA');
  /* GA（上の階層へ戻った）と GK（同じ階層の別の型へ移った）は
     警告でセグメントは返るので、GB（終端）まで読み続ける。 */
  do while (db_pcb.stat_code ^= 'GB');
    call plitdli(three, func_gn, db_pcb, seg_io);
    if db_pcb.stat_code ^= 'GB' then
      put skip edit(db_pcb.seg_level, '    ', db_pcb.seg_name, seg_io)(a, a, a, a);
  end;
  put skip list('STATUS=' || db_pcb.stat_code);
end stuprt;
`,
    aux: `::: STUDENT.dbd
         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=4,START=5,TYPE=C
         DBDGEN
         FINISH
         END
::: STUPSB.psb
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=9
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
::: STUDENT.dat
STUDENT S0001YAMAKAWA
COURSE  C001MATH
COURSE  C002PHYS
STUDENT S0002TSUKIMI
COURSE  C001MATH
`,
  },
];
