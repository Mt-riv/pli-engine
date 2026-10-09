# engine — 処理系の内部

ブラウザでも Node でも動く TypeScript 実装。Node 依存は無い。

この文書は**内部の作り**の説明。使い方は
[`../docs/browser-manual.md`](../docs/browser-manual.md) と
[`../docs/vscode-manual.md`](../docs/vscode-manual.md)。

## 現状

| 層 | 状態 | テスト |
|----|------|--------|
| 字句解析 `src/lexer.ts` | 完了 | 46 |
| プリプロセッサ `src/preprocess.ts` | `%REPLACE` / 一覧制御 | 8 |
| 出力書式 `src/format.ts` | 完了 | 30 |
| 構文解析 `src/parser.ts` | 完了 | 111 |
| 値・算術 `src/value.ts` | 完了 | 22 |
| 評価器 `src/interp.ts` | 完了 | 57 |
| 実行 API `src/run.ts` | 構造化された診断 | 12 |
| Linter `src/lint.ts` | 13 規則。CLI 付き | 36 |
| ストリーム入出力 `src/streamio.ts` | ファイル表と入力カーソル | 27 |
| `PICTURE` `src/picture.ts` | 数値編集 | 31 |
| `BASED` 記憶域 | `interp.ts` / `value.ts` | 16 |
| レコード入出力 | `streamio.ts` / `interp.ts` | 11 |
| `%INCLUDE` とホスト | `src/host.ts` / `preprocess.ts` | 16 + 7 |
| Snippet `src/snippets.ts` | 38本（単一の定義源） | 37 |
| テストフレームワーク `src/testing.ts` | CLI 付き | 32 + 4 |
| ブラウザ版 `web/` | HTML 1枚で動作 | 21 + 11 |

合計 **563 件**（`npm test`）。

実在の PL/I 処理系の出力と突き合わせながら作っており、
出力書式・精度規則・条件の扱いはその結果を反映している。
次のような題材が通る。

- **ハノイの塔** — 再帰、入れ子手続き、`||` による数値→文字の暗黙変換
- **対角成分の別名** — 2次元配列、`DEFINED` + iSUB、`PUT EDIT`、`GET STRING EDIT`
- **数値の読み上げ** — 115行。コマンドライン引数、`PUT EDIT`、下限付き配列、文字列処理

## 設計上の最重要事項: 字句解析はキーワードを判定しない

PL/I には予約語が無く、次が合法なコードである。

```pli
IF IF = THEN THEN THEN = ELSE;
```

「IF と THEN が等しければ THEN に ELSE を代入する」という意味になる。
したがって語がキーワードか識別子かは**文脈でしか決まらない**。
字句解析は一律に `word` を返し、判断は構文解析に委ねる。

この性質を最初のテストに据えてあるので、素朴なキーワードテーブルに
後戻りできない構造になっている。

## PUT LIST の出力書式

推測ではなく、実在の PL/I 処理系の出力と突き合わせて導いた。

| 要素 | 規則 |
|------|------|
| `FIXED DEC(p,q)` のフィールド幅 | **p + 3** |
| `FIXED BIN(p,q)` のフィールド幅 | 10進桁 `ceil(p·log10 2) + 1` に **+3**（BIN(31)→14、BIN(15)→9） |
| 項目の配置 | **24桁ごとのタブストップ**。数値は右詰め、文字は左詰め |
| 行幅 | **120桁**。次の項目が収まらなければ現在行を120桁まで空白で埋めて改行 |
| 項目の後ろ | 空白1個 |

根拠の一例: 九九（`put list` を9回）の出力は1行目が **120桁（5項目 = 5×24）**、
2行目が **87桁（= 3×24 + 14 + 1、4項目）** になる。

## 文の種別判定（構文解析の核）

予約語が無いため、文がどの種類かは文脈でしか決まらない。採用した規則:

> 先頭が「参照（語 + 省略可能な添字）」に続いて `=` なら**代入文**。
> そうでなければ先頭語を**文キーワード**として解釈する。

これで次がすべて正しく解釈される。

| 入力 | 解釈 |
|------|------|
| `IF IF = THEN THEN THEN = ELSE;` | IF 文（条件 `IF=THEN`、本体 `THEN=ELSE`） |
| `THEN = ELSE;` | 代入文 |
| `do = 5;` | 代入文（`do` という変数へ） |
| `do i = 1 to 9;` | DO 反復文 |
| `a(2,3) = 7;` | 代入文（添字付き） |
| `put list(1);` | PUT 文（`(` で始まるが `=` が続かない） |

## 実物から学んだこと

同梱サンプルを実際に解析して判明した、仕様書だけでは気付けない点。

1. **0x20 未満の制御文字は無視しなければならない** —
   古いソースは末尾に 0x1A（DOS の EOF マーカー）を持つことがある。
   仕様にも
   "Other than newlines, characters lower in the collating-sequence
   than spaces ('20'x) are ignored." と明記されている
2. **`OPTIONS` は空白区切り** — `options(main reentrant)`。カンマではない
3. **配列は下限を明示できる** — `dcl ones(0:9) char(8)` は 0..9 の10要素
4. **宣言の括弧は2種類ある** — 名前直後は次元 `b(3,3)`、属性語の後は精度 `bin(31)`
5. **`INITIAL` は値のリストを取る** — `init(1,2,3)`

## 算術の実装

**FIXED DECIMAL を10進固定小数点として正確に扱う**。値は「尺度付きの
BigInt」で保持する（DECIMAL なら実値 = v / 10^q、BINARY なら v / 2^q）。
JS の number（2進浮動小数）で代用すると `123.45 * 6.7 = 827.115` が
一致しない。

精度規則も PL/I の規定どおりに実装した。いずれも出力幅から裏が取れている。

| 演算 | 規則 |
|------|------|
| 加減算 | p = max(p1-q1, p2-q2) + max(q1,q2) + 1, q = max(q1,q2) |
| 乗算 | p = p1+p2+1, q = q1+q2 |
| 除算 | p = N, q = N - ((p1-q1) + q2)（N は最大精度: DEC 15 / BIN 31） |
| 基数混在 | **BINARY に変換する** |
| `MOD` | p = min(N, p2-q2+max(q1,q2))（結果は第2引数より小さいため） |
| FLOAT との混在 | **FLOAT が優位** |

「基数混在は BINARY」が正しいことは、13 の階乗がちょうど溢れること
（13! = 6,227,020,800 > 2³¹−1）で確認できる。DECIMAL のままなら
15 桁に収まるので溢れない。

## 作る途中でつまずいた点

単体テストは通るのに、まとまったプログラムでは合わない——という差が有益だった。

1. **プログラム終了時に最終行を改行で終端する** — これ1つの修正で
   出力の一致が大きく進んだ
2. **引数名の `DECLARE` は属性宣言であって新変数ではない** —
   `proc(n)` の本体の `dcl n fixed bin(31);` を新変数として 0 で
   初期化すると引数が失われる。再帰と入れ子手続きがこれに依存する
3. **`LENGTH` / `INDEX` は `FIXED BIN(15,0)` を返す** — 出力幅 9 から分かる
4. **`MOD` は整数剰余** — 除算の精度規則を使うと `MOD(17,5)` が 0 になる
5. **`FLOAT DEC(6)` のフィールド幅は p+8** — ` 3.50000E+0000` で14桁

## 書式付き入出力と別名定義

| 機能 | 必要になった題材 |
|------|----------------|
| `PUT EDIT` と書式項目（`A` / `F(w,d)` / `E` / `B` / `X` / `COLUMN` / `SKIP` / 反復係数） | `PUT EDIT` の例、数値の読み上げ |
| データリスト中の**配列の自動展開** | 対角成分の別名 |
| `GET STRING ... EDIT` / `... LIST` | `PUT EDIT` の例、数値の読み上げ |
| `DEFINED` + iSUB（別名定義） | 対角成分の別名 |
| ファイル宣言（`dcl sysprint print;`）※標準出力として受け付ける | 数値の読み上げ |
| 主手続きの引数（コマンドライン引数） | 数値の読み上げ |
| 配列の評価（多次元、下限付き、`INIT` リスト） | `PUT EDIT` の例、数値の読み上げ |

### EDIT と LIST の違い

同じ行・桁を共有するが書き方が違う。

| | タブストップ | 末尾の空白 |
|--|------------|-----------|
| `PUT LIST` | 24桁ごと | 項目ごとに1個付く |
| `PUT EDIT` | 使わない（書式の指定どおり） | 付かない |

根拠: `put skip edit('b: ',b)(a,(9)f(4))` の出力が
`3 + 9×4 = 39` 桁ちょうどで、末尾に空白が無い。

### DEFINED の別名セマンティクス

```pli
dcl b(3,3) bin fixed init(1,2,3, 4,5,6, 7,8,9);
dcl d(3)   bin fixed def (b(1sub,1sub));
```

`d` は記憶域を持たず `b` の対角成分への別名になる。`1sub` は
「別名側の第1次元の添字」を表す仮変数なので、`d(i)` は `b(i,i)` を指す。
読み書きの両方が基底変数へ転送される必要があり、対角成分の別名は
`get string(t) edit(d)(f(5))` で `d` に書いて `b` の変化を出力している。

## 制御構造・構造体・条件

| 機能 | 備考 |
|------|------|
| `SELECT` / `WHEN` / `OTHERWISE` | `SELECT(expr)` と `SELECT;` の両形式 |
| `LEAVE` / `ITERATE` | 内部例外で制御 |
| `DO` の複数指定 | `do i = 1 to 3, 7 to 9;` / `do i = 1, 5, 10;` |
| `GOTO` と文ラベル | 文列からラベルを探して飛ぶ。見つからなければ上位へ伝播 |
| 構造体 | レベル番号から修飾名（`REC.ADDR.CITY`）を組んで葉を登録 |
| `ON` 条件 / `SIGNAL` | ERROR は再開可能でない扱い |
| `BEGIN` ブロック | 独自の名前の有効範囲を持つ |
| 配列式 | `c = a + b` / `c = a * 2` を要素ごとに計算 |
| `SUBSTR` 疑似変数 | `substr(s,3,2) = 'XY'` |
| `%REPLACE` と一覧制御文 | トークン列の段階で処理（文字列リテラルを誤置換しない） |
| 組込関数 | `CEIL` `FLOOR` `ROUND` `SIGN` `DIVIDE` `TRANSLATE` `VERIFY` `LBOUND` `HBOUND` `DIM` |

### 戻り値型と精度

出力フィールド幅から逆算した。

| 組込関数 | 結果の型 | 幅 |
|---------|---------|-----|
| `LENGTH` / `INDEX` / `VERIFY` / `SIGN` | `FIXED BIN(15,0)` | 9 |
| `LBOUND` / `HBOUND` / `DIM` | `FIXED BIN(31,0)` | 14 |
| `CEIL` / `FLOOR` | `FIXED(min(N, max(p-q,1)+1), 0)` | `ceil(2.1)` で 5 |
| `DIVIDE(a,b,p,q)` | `FIXED DEC(p,q)` | p+3 |
| `MOD` | `p = min(N, p2-q2+max(q1,q2))` | `mod(17,5)` で 4 |

`CEIL` を「切り捨ててから 1 を足す」と実装すると加算の精度規則で
p が広がり、出力幅が合わなくなる。結果精度を直接構成する必要がある。

### 文字比較は照合順序（文字コード順）

`'Z' < 'a'` は真（0x5A < 0x61）。JS の `localeCompare` はロケール依存で
これを偽にすることがあるため使えない。短い側は空白で埋めて比べる。

### ON 条件の罠

計測して分かったこと。

- **`ON ZERODIVIDE` の ON 単位から正常復帰すると演算が再試行され、
  無限ループになる**（実測で18万行出力してタイムアウト）
- **`ON ERROR` の ON 単位から正常復帰するとプログラムが終了する**
  （ERROR は再開可能でない。stderr にバナーを出して exit 0）

このためテストでは `SIGNAL` を使う形にし、
マニフェストに `expectRuntimeError` を立てて標準出力の一致だけを要求している。

## 実装していないもの

| 機能 | 理由 |
|------|------|
| 索引・直接編成（`KEYED` / `REGIONAL`） | 学習の題材としてまれで、実装量が大きい |
| `AREA` / `OFFSET` | `BASED` があれば大半の題材が書ける |
| 多重処理（`TASK` / `WAIT` / `EVENT`） | 単一スレッドの処理系に載せる意味が無い |
| `UNION` | 記憶域の重ね合わせ。アドレスを持たない設計と相性が悪い |
| `LABEL` 変数 / `REFER` | 需要が薄いわりに有効範囲の扱いが重い |

未実装の属性や文に当たると、何が未実装かを名指しで報告する。

## `%INCLUDE` とホスト抽象

外界（取り込み元のファイル、入出力の相手）への口は `src/host.ts` の
`PliHost` 1 つにまとめてある。`src/` に `node:fs` を持ち込むと
「HTML 1 枚で配れる」形が壊れるため。

| 呼ぶ側 | 渡すもの |
|--------|---------|
| ブラウザ版 | 画面の「ファイル」欄に書いた仮想ファイル（`MemoryHost`） |
| CLI | 実ファイル（`scripts/node-host.ts`。`node:fs` はここだけ） |
| VSCode 拡張 | 開いているファイルの隣とワークスペース直下 |
| テスト | その場で作ったオブジェクト |

```pli
%include 'DECLS.inc';      /* 文字列 */
%include decls;            /* 名前（拡張子は .inc .pli などを順に試す） */
%include syslib(dsa);      /* ライブラリ指定。括弧の中の名前を使う */
%include a, b;             /* まとめて */
```

**取り込んだトークンには取り込み元の名前を持たせている。** 付けないと
取り込んだ先の誤りが主ファイルの行として報告され、診断が嘘になる。
診断の `file` に入り、VSCode でもブラウザ版でも
`DECLS.inc 2行5桁: ...` のように出る。

循環取り込みと深すぎる入れ子（16 段）は誤りとして止める。
放っておくと止まらないので、必ず誤りとして止める方針。

`DCL f ENTRY;` も受け付ける。実体は別ファイルにあるので呼べないが、
取り込んだ宣言群に外部手続きが含まれていても Linter が
誤検出を出さないようにするため。

## ストリーム入出力

```pli
dcl inp file stream input;
dcl rep file stream output print;
dcl done bit(1);

done = '0'b;
on endfile(inp) done = '1'b;
open file(inp) input, file(rep) output linesize(80);

do while(^done);
  get file(inp) list(value);
  if ^done then put file(rep) skip list(value);
end;

close file(inp), file(rep);
```

| 対応 | 内容 |
|------|------|
| 文 | `OPEN` / `CLOSE` / `GET` / `PUT`（`FILE` 指定、省略時は SYSIN / SYSPRINT） |
| 指定 | `SKIP` / `PAGE` / `LINE(n)` / `LINESIZE` / `PAGESIZE` / `TITLE` |
| 条件 | `ENDFILE(f)` / `UNDEFINEDFILE(f)`（ファイルごとに ON 単位を置ける） |
| 宣言 | `FILE` `STREAM` `RECORD` `INPUT` `OUTPUT` `UPDATE` `PRINT` `ENVIRONMENT` |

設計上の要点:

- **入出力の条件は ON 単位から復帰して実行を続ける。** 計算条件
  （FIXEDOVERFLOW など）と扱いが違う。`on endfile(sysin) done = '1'b;` と
  書いてループの判定に使う書き方がこれに依存する
- **PRINT かどうかで書式が変わる。** PRINT は 24 桁タブストップと改ページ、
  PRINT でないストリーム出力は項目を空白 1 個で区切るだけ
- **行・桁の状態はファイルごとに持つ。** `LINESIZE` がファイル単位なので、
  `ListWriter` を 1 つ共有する作りでは成り立たない
- ファイル名は識別子なので `.` を含められない。ホストは `data` に対して
  `data.txt` / `data.dat` / `data.csv` を順に試す
- 閉じ忘れたファイルもプログラム終了時に書き戻す

## PICTURE

```pli
dcl amount pic'$$$,$$9V.99';
dcl count  pic'ZZZZ9';
dcl rate   pic'S9V.999';

amount = 1234.5;     /* 表示は " $1,234.50" */
amount = amount * 2; /* 算術にも使える。代入で再び編集される */
```

| 文字 | 意味 |
|------|------|
| `9` | 数字（ゼロも表示） |
| `V` | 小数点の位置（文字は出ない） |
| `Z` `*` | ゼロ抑制（空白 / アスタリスク詰め） |
| `$` `+` `-` `S` | 通貨記号と符号。2 個以上続けると**浮動**する |
| `.` `,` `/` `B` | 挿入文字（抑制された範囲では詰め文字になる） |
| `CR` `DB` | 末尾。負のときだけ出る |

- 内部は 10 進固定小数点。**表示のときだけ**編集を通すので、算術は
  通常の `FIXED DEC` と同じに書ける。結果にピクチャは伝わらない
- `$$$,$$9` のカンマは**浮動記号列の一部**。記号は最初の有効数字の
  直前（この例ではカンマの位置）に置かれる
- 桁に収まらない代入は **SIZE 条件**（`FIXEDOVERFLOW` ではない）
- 文字列との連結や `CHAR` への代入でも編集した形になる
- 対応しない指定（`A` `X` `E` `K` `T` `I` `R` `G` `M`）は宣言の時点で
  「使えない文字」として報告する

## BASED 記憶域とポインタ

```pli
dcl (head, cur) pointer;
dcl 1 node based(cur),
      2 value fixed bin(31),
      2 next  pointer;

head = null();
allocate node set(cur);
cur -> node.value = 10;
cur -> node.next = head;
head = cur;
...
free cur -> node;
```

| 対応 | 内容 |
|------|------|
| 宣言 | `POINTER` / `PTR`、`BASED(p)` / `BASED`、構造体ごと |
| 文 | `ALLOCATE x SET(p)` / `ALLOCATE x`、`FREE p -> x` |
| 参照 | `p -> x`、`p -> rec.field` |
| 組込 | `ADDR(x)`、`NULL()` |

**アドレス値は持たない。** ポインタは「確保した記憶域への参照」で、
算術（`p + 1`）も型の違う再解釈もできない。本物のアドレス空間を模すと
エミュレータを作ることになり、学習と検証という目的に費用が見合わない。
できないことははっきり断る方が、中途半端に動いて嘘の結果を出すよりよい。

代わりに**未定義動作になるものを必ず捕まえる**。

| 操作 | PL/I の規定 | この処理系 |
|------|------|-----------|
| NULL をたどる | 未定義動作 | 誤りとして止める |
| 解放済みをたどる | 未定義動作（たまたま動くこともある） | 誤りとして止める |
| 二重の FREE | 未定義動作 | 誤りとして止める |

`ADDR(x)` は変数のセルを共有するポインタを返すので、別名越しの
書き込みが元の変数に反映される。`ADDR` で取ったポインタを別の
`BASED` 宣言で見る場合、記憶域が 1 つしか持っていなければ
それを指しているとみなす（型の重ね合わせの簡易版）。

## レコード入出力

```pli
dcl inp file record input env(f recsize(13));
dcl 1 rec,
      2 name char(10),
      2 age  pic'999';

on endfile(inp) done = '1'b;
open file(inp) input title('IN.TXT');
read file(inp) into(rec);
```

| 文 | 内容 |
|----|------|
| `READ FILE(f) INTO(rec)` | 1 レコード読んで変数・構造体へ配る |
| `READ FILE(f) SET(p)` | 読んだレコードを指すポインタを設定する |
| `WRITE FILE(f) FROM(rec)` | 1 レコード書く |
| `REWRITE FILE(f) FROM(rec)` | 直前に読んだレコードを置き換える（UPDATE） |

**文字として表現できる項目だけを扱う。** 本来のレコードは記憶域そのもの
（packed decimal など）が入るが、仮想ファイルは文字列なので再現できない。
数値は `PICTURE` か文字で持つ。扱えない項目は黙って壊さず、
`RECORD 入出力で扱えません` と知らせる。

`ENVIRONMENT(F RECSIZE(n))` の固定長は、読むときに空白で埋め、
書くときに切り詰める。`KEY` 指定（索引ファイル）は未実装と報告する。

## Linter

構文は通るが怪しい書き方を指摘する。詳細は [`../docs/lint.md`](../docs/lint.md)。

```bash
npm run plilint -- examples/tests       # ディレクトリを再帰的に
npm run plilint -- --list-rules         # 規則と、その理由
```

主目的は **`implicit-declaration`**。PL/I は宣言の無い名前を暗黙に宣言する
（`I`〜`N` は `FIXED BIN(15,0)`、他は `FLOAT DEC(6)`）ため、綴り間違いが
黙って別の変数になり、誤った値のまま動き続ける。予約語が無い言語なので、
この種の誤りを機械が拾う価値が特に高い。

誤検出が出た時点で Linter は切られる。ブラウザ版のサンプル12本と
`examples/tests` に対して**指摘 0** であることをテストで固定している。

## Snippet

38本の Snippet を `src/snippets.ts` に定義している。**定義源はここだけ**で、
VSCode 用の `snippets/pli.json` は生成物である。

```bash
npm run gen:snippets   # ../vscode-pli/snippets/pli.json を書き出す
```

同じ定義をブラウザ版のヘッダの「Snippet…」からも挿入できる。
VSCode の Snippet 記法（`${1:名前}`）は `plainText()` で落としてから挿入し、
2 行目以降は挿入位置の字下げに合わせる。

全 Snippet が**解析できること**と、`standalone` 印のあるものは
**挿入しただけで実行できること**をテストで確かめている（37 件）。
Snippet が PL/I として壊れていても気付けない状態を避けるため。

## テストフレームワーク

PL/I で書いたテストを PL/I で走らせる。詳細は [`../docs/test.md`](../docs/test.md)。

```pli
/* math_test.pli — 主手続きは書かない */
SETUP: proc;
  /* 各テストの前に走る */
end SETUP;

TEST_DECIMAL_IS_EXACT: proc;
  dcl x fixed dec(5,2);
  x = 0.1;
  x = x + 0.2;
  call ASSERT_EQUALS(0.3, x, '10進なら誤差が出ない');
end TEST_DECIMAL_IS_EXACT;
```

```bash
npm run plitest -- examples/tests            # ディレクトリをまとめて
npm run plitest -- math_test.pli --xml out # CI 用の XML も出す
```

失敗・異常が 1 件でもあれば終了コード 1 を返すので、そのまま CI に載せられる。

決めごとは、`ASSERT_EQUALS(期待, 実際, 説明)` の引数順、表明の失敗で
即中断すること、failure（表明の失敗）と error（想定外の異常）の区別、
`SETUP` / `TEARDOWN`、`DISABLED_` 接頭辞、CI 用の XML 出力。

**全体の前後に一度だけ走る仕掛けは意図的に持たない。** テストは 1 件ずつ
別のプログラムとして実行するので、複数のテストにまたがる状態が存在せず、
「一度だけ」という約束を果たせない。守れない約束を API として置く方が
害が大きいと判断した。

## 利用側

入口はいくつかあるが、どれも `src/index.ts` が公開するものだけを使い、
Node 依存は無い（CLI だけは当然ファイルを読む）。

`src/index.ts` は 3 つの実体をまとめただけの窓口である。

| 実体 | 役目 |
|------|------|
| `src/run.ts` | ソースを実行して診断を返す |
| `src/lint.ts` | 構文は通るが怪しい書き方を指摘する |
| `src/snippets.ts` | Snippet の定義（単一の定義源） |
| `src/testing.ts` | テストフレームワーク |

`testing.ts` が `run.ts` を使うため、循環参照を避けて
実行の層は `index.ts` から分けてある。

| 入口 | 場所 | 説明 |
|------|------|------|
| ブラウザ版 | [`web/`](web/README.md) | **HTML 1枚**。ダブルクリックで開くだけ。サーバ不要・オフライン可 |
| VSCode 拡張 | [`../vscode-pli/`](../vscode-pli/README.md) | 構文強調・診断・実行・テスト・Snippet。処理系を同梱 |
| テストの CLI | `scripts/plitest.ts` | `npm run plitest -- <ファイル/ディレクトリ>` |
| Linter の CLI | `scripts/plilint.ts` | `npm run plilint -- <ファイル/ディレクトリ>` |

### 公開 API

```ts
import { runProgram } from "pli-engine";

const r = runProgram(source, {
  args: ["123"],           // 主手続きの引数
  maxSteps: 5_000_000,     // 無限ループ対策
  maxOutputBytes: 1_000_000,
});
// r.ok / r.stdout / r.diagnostics[] / r.truncated / r.durationMs
```

診断は `{ severity, phase, line, col?, message }` の配列で返る。
`phase` は `preprocess` / `lex` / `parse` / `runtime` のいずれか。

ブラウザには別プロセスが無いため、**無限ループはエンジン側で止める**。
文の数を数えるだけでなく、本体が空のループ（`do while('1'b); end;`）でも
止まるようループの周回でも数えている。
