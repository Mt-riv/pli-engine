# IMS/DB（DL/I）

PL/I から `CALL PLITDLI` で**階層型データベース**を読み書きできる。
IMS をインストールする必要は無い。DBD・PSB・データはテキストファイルで、
ブラウザ版なら「ファイル」欄に書くだけで動く。

```pli
stuprt: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl (io_ptr, db_ptr) pointer;
  %include dlipcb;                      /* PCB マスク */
  dcl three fixed bin(31) init(3);
  dcl func_gn char(4) init('GN  ');
  dcl seg_io char(13);

  do while (db_pcb.stat_code ^= 'GB');
    call plitdli(three, func_gn, db_pcb, seg_io);
    if db_pcb.stat_code ^= 'GB' then
      put skip list(db_pcb.seg_name, seg_io);
  end;
end stuprt;
```

## 何を再現し、何を再現しないか

再現するのは**論理層**だけ。

| 再現する | 再現しない |
|---------|-----------|
| 階層構造・階層順（hierarchic sequence） | 物理の配置（HDAM の RAP、ポインタ、OSAM のデータセット） |
| 順序キーと連結キー | アクセス方式の違い（HDAM / HIDAM / HISAM / HSAM / DEDB） |
| 現在位置と親の確立（parentage） | 二次索引（`LCHILD` / `XDFLD`）、論理関係 |
| ステータスコード | IMS TM / DC（メッセージキュー）、`EXEC DLI`、AIB インタフェース |
| `PROCOPT` の強制、ロードモード | ロック（`Q` コマンドコード）、`CHKP` / `ROLB` などの同期点 |

`ACCESS=HDAM` でも `ACCESS=HIDAM` でも振る舞いは同じになる。
業務プログラムから見える違いは階層順と順序キーだけで決まるので、
学習と検証の用には足りる。再現しないものに当たると、
**何が未実装かを名指しで断る**（黙って別の結果を返したりしない）。

> **ステータスコードの根拠について。** 出力書式や精度規則は実在の PL/I
> 処理系と突き合わせて決めているが、DL/I にはそれができない（IMS は
> z/OS 専用で、手元のリファレンス実装に DL/I は無い）。そこで DL/I は
> IBM の仕様文書を正とし、各コードの意味を
> `engine/test/dli-engine.test.ts` のコメントに引用して担保している。

## 3 つのファイル

### DBD — 階層の定義

DBDGEN への入力をそのまま書く。書式はアセンブラのマクロ命令で、
1 桁目の `*` は注釈。**1 桁目が非空白だとラベルとして読まれるので、
命令は必ず 1 桁目を空けて書く。** 72 桁目が非空白なら次行へ継続
（続きは 16 桁目から）。オペランドの後の空白から先は注釈。
行頭の空白は 1 つ以上であれば数を問わない（実機のように 10 桁目へ揃えなくてよい）。

```
         DBD  NAME=STUDENT,ACCESS=HDAM
         DATASET DD1=STUDDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=4,START=5,TYPE=C
         DBDGEN
         FINISH
         END
```

| 文 | 必須のオペランド | 備考 |
|----|----------------|------|
| `DBD` | `NAME=` | `ACCESS=` は記録するだけ |
| `DATASET` / `AREA` | — | 受け取るが使わない |
| `SEGM` | `NAME=` `BYTES=` | `PARENT=0` でルート。ルートは 1 つだけ |
| `FIELD` | `NAME=` `BYTES=` `START=` | `NAME=(名前,SEQ,U)` で順序キー。`U` は一意、`M` は重複可 |
| `DBDGEN` | — | 必須 |

`START=` は 1 始まりの桁。項目がセグメント長に収まらなければ誤りになる。
順序キーの無いセグメントも書ける（挿入は兄弟の末尾になる）。

### PSB — どのセグメントを何のために見るか

```
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=9
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
```

- `PROCOPT=` を省くと `A`（全部可）。`KEYLEN=` を省くと連結キーの最大長
- `SENSEG` を 1 つも書かなければ DBD の全セグメントに感知する（手で書く題材のための補い。実機では必須）
- `CMPAT=YES` を付けると**入出力 PCB が先頭に 1 つ増える**。`PCB TYPE=TP` と書いても同じ場所を取る
- 感知していないセグメントを SSA に書くと `AM` になる

`PROCOPT` の文字と、許す呼び出し:

| 文字 | 許す呼び出し |
|------|------------|
| `A` | 全部 |
| `G` / `O` | 取り出し |
| `I` | 挿入 |
| `R` | 置換（取り出しを含む） |
| `D` | 削除（取り出しを含む） |
| `L` | **挿入だけ**（ロードモード。取り出しはできない） |

`P`（パス呼び出し）・`E`（排他）・`S` は記述としては受け付けるが、
この処理系では効かない。`D` コマンドコードのパス呼び出しは
`PROCOPT` に `P` が無くても通る。
`SENSEG` ごとの `PROCOPT=` も読むだけで、判定は PCB 単位のものだけを見る。

### 挿入するときの親

`ISRT` は親から挿入するセグメントまでのパスを SSA で指定する。
**親側の SSA を省くと、直前の `GU` / `GN` が確立した位置から親を決める。**

```pli
/* IMS で最もよく書かれる形 */
call plitdli(4, func_gu,   db_pcb, io, 'STUDENT (STUDNO   =S0001)');
call plitdli(4, func_isrt, db_pcb, io, 'COURSE  ');   /* 親は S0001 */
```

位置が無い（まだ何も取っていない）ときは `GE`、
ロードモード（`PROCOPT=L`）なら「親が無い」の `LD` になる。

挿入する側（最下位）の SSA に**修飾を付けてはいけない**。
条件は使われないので、付けると `AJ` で断る。

### 感知していないセグメントは見えない

`SENSEG` で宣言していないセグメントは、無修飾の `GN` でも返らない。
実機の PCB が「感知したものだけが見える階層」になるのと同じ。
`SENSEG` ごとの `PROCOPT=` も効く（PCB 単位の `PROCOPT` と**両方**を満たす必要がある）。

### データ — 行指向のテキスト

`<DBD 名>.dat` に、1 行 1 セグメント出現で書く。
**先頭 8 桁がセグメント名**、以降が `BYTES=` 長のセグメントデータ。
改行は LF でも CRLF でもよい。`BYTES=` を超える分は切り捨てる。

```
STUDENT S0001YAMAKAWA
COURSE  C001MATH
COURSE  C002PHYS
STUDENT S0002TSUKIMI
COURSE  C001MATH
```

**階層は行の順で決まる。** ある行の親は、直前に現れた「親の型」の出現。
これは IMS の階層順そのものなので、形式のために新しい規則は作っていない。
人が読めて diff も取れるので、ブラウザの仮想ファイルでそのまま編集できる。

兄弟は順序キーの昇順でなければならない。崩れていたら読み込みで止める
（黙って並べ替えると、プログラムが見る順と食い違う）。

更新（`ISRT` / `REPL` / `DLET`）は実行の終わりにこのファイルへ書き戻す。
異常終了でも、そこまでの更新は残る（ファイル入出力と同じ約束）。

## 呼び出し方

### PSB の指定

どの PSB を使うかはプログラムに書かない（実機では JCL が決める）。

| 入口 | 指定の仕方 |
|------|-----------|
| ブラウザ版 | 「ファイル」欄に `<名前>.psb` を置く（1 つだけ）。置いてあれば DL/I が有効になる |
| CLI | `npm run pli -- prog.pli --psb STUPSB` |
| テスト CLI | `npm run plitest -- examples/tests --psb STUPSB` |
| VSCode | 設定 `pli.dli.psb` |
| プログラム | `runProgram(source, { host, psb: "STUPSB" })` |

指定せずに `CALL PLITDLI` に達すると、PSB が無いと言って止まる。

### PCB マスク

実機と同じく、主手続きの引数で受けたポインタに `BASED` で重ねる。
**項目の名前は自由**だが、**並びと桁は規定のとおり**でなければならない。

```pli
dcl 1 db_pcb based(db_ptr),
      2 dbname     char(8),
      2 seg_level  char(2),
      2 stat_code  char(2),
      2 proc_opt   char(4),
      2 reserved   fixed bin(31),
      2 seg_name   char(8),
      2 len_kfb    fixed bin(31),
      2 no_senseg  fixed bin(31),
      2 key_fb     char(9);      /* KEYLEN に合わせる（この文書の PSB の例は KEYLEN=9） */
```

主手続きの引数の並びは PSB の PCB の並びと同じ。`CMPAT=YES` なら
先頭が入出力 PCB なので `proc(io_ptr, db_ptr)` になる。

項目の結び付けは**名前ではなく宣言順**で行う。PCB マスクの名前は
プログラムごとに違うので、名前では引けない（実機が変位で重ねるのと
同じ構図）。並びが足りなければ、いくつ必要かを言って止める。

> PSB の DB PCB が 1 つだけなら、`BASED` にせず構造体をそのまま渡しても
> 受け付ける。短い題材を書くときのための便宜で、実機にこの形は無い。
> `CHAR(*)` は書けないので、`KEY_FB` の長さは明示する。

### CALL の形

```pli
call plitdli(引数個数, 機能コード, PCB, セグメント I/O 領域, SSA...);
```

第 1 引数は**後ろに渡した引数の個数**。`FIXED BIN(31)` の変数で渡す。
食い違っていたら、宣言した数と実際の数を添えて止める
（実機では落ちるだけで原因が分からない、IMS で最も多い誤りのひとつ）。

セグメント I/O 領域は `CHAR(n)` でも構造体でもよい。構造体のときの
項目の幅はレコード入出力と同じ規則（`CHAR` と `PICTURE` だけ）。

### 機能コード

| コード | 意味 |
|--------|------|
| `GU` / `GHU` | 先頭から探して 1 件取る（Get Unique） |
| `GN` / `GHN` | 階層順に次を取る（Get Next） |
| `GNP` / `GHNP` | 確立した親の配下だけを順に取る（Get Next in Parent） |
| `ISRT` | 挿入 |
| `REPL` | 置換。直前に `GH` 系で取っていなければならない |
| `DLET` | 削除。配下の子もまとめて消える |

`GH` 系（ホールド付き）で取ったセグメントだけが `REPL` / `DLET` の対象。
ホールドは 1 回で使い切る。

### SSA（セグメント検索引数）

桁で決まった書式。**1〜8 桁がセグメント名**、9 桁目から先が修飾。

```pli
dcl ssa char(25) init('STUDENT (STUDNO   =S0001)');
/*                     ^^^^^^^^ ^^^^^^^^^^^^^^^      */
/*                     名前8桁   項目8桁+演算子2桁+値   */
```

**項目名をちょうど 8 桁、関係演算子をちょうど 2 桁**に収めるのが規則。
`STUDNO` は 6 文字なので 8 桁に揃えると空白 2 つ、演算子を右詰めにすると
`=` の前の空白は**合わせて 3 つ**になる。桁がずれると `AJ`
（空白 2 つにすると、演算子の欄が `=S` と読まれる）。

| 書けるもの | 例 |
|-----------|-----|
| 無修飾 | `'STUDENT '` |
| 関係演算子 | `=` `EQ` `>` `GT` `<` `LT` `>=` `GE` `<=` `LE` `!=` `NE` `^=`（2 桁の欄に収める。左詰め・右詰めどちらでもよい） |
| 複数条件 | `'...&...'`（AND）、`'...|...'`（OR）。`*` も AND。`#` は書式として受けるが独立 AND の意味は与えず、AND と同じに扱う（独立 AND が効くのは二次索引を使う SSA で、二次索引は未実装） |
| 複数レベル | SSA を複数渡して階層のパスを絞る。上位が無修飾なら、全 SSA を満たす経路まで階層順に探す。階層順から外れていたら `AC` |
| コマンドコード | `'COURSE  *F'` のように `*` の後に続ける |

値の長さは本来 DBD の項目長と同じでなければならないが、この処理系は
**項目長を上限として、閉じ括弧か論理記号まで**を値とする。手で書くときに
`(STUDNO   =S1)` のように項目長より短く書けるようにするため。
ただし比較は**値を空白で埋めてからの完全一致**なので、短く書いた値が当たるのは
項目の中身も空白詰めのときだけで、前方一致にはならない。
長すぎる値は桁のずれなので断る。

コマンドコード:

| コード | 意味 |
|--------|------|
| `F` | 親の下の最初の出現に戻る |
| `L` | 最後の出現を取る（`GU` / `GHU` と、`ISRT` で親を絞るときだけ効く。`GN` 系では無視される） |
| `D` | パス呼び出し。そのレベルから下までを 1 回で I/O 領域に入れる |
| `P` | 親をそのレベルに確立する（既定は最下位） |
| `U` / `V` | そのレベルは現在位置で絞る |
| `C` | 括弧の中を連結キーとして引く（`'GRADE   *C(S0001C0012A)'`） |
| `-` | 何もしない |

`A` `G` `M` `N` `Q` は書式としては受けるが、使うと未実装だと断る。

### ステータスコード

PCB の `STAT_CODE` に 2 桁で返る。**DL/I は失敗しても例外を出さない。**
見なければ、取れなかったセグメントを取れたものとして処理してしまう。
Linter の `dli-status-unchecked` が、一度も読んでいなければ指摘する。

| コード | 意味 | 返るとき |
|--------|------|---------|
| 空白 | 正常 | — |
| `GA` | 上位のレベルへ移った（**セグメントは返る**） | 無修飾の `GN` |
| `GK` | 同じレベルの別の型へ移った（**セグメントは返る**） | 無修飾の `GN` |
| `GB` | データベースの終端。**修飾付きの `GN` で該当が無いときもこれ**（`GE` ではない） | `GN` |
| `GE` | 該当なし | `GU` / `GNP`、および親を絞る SSA が当たらない `ISRT` |
| `GP` | 親が確立していない | `GNP` |
| `II` | 既にある（一意キーの重複） | `ISRT` |
| `DJ` | 直前に `GH` 系が無い | `REPL` / `DLET` |
| `DA` | 順序キーを変えた | `REPL` |
| `AC` | SSA の階層が DBD と合わない | 全部 |
| `AD` | 機能コードが正しくない。`ISRT` に SSA が 1 つも無い | 全部 |
| `AJ` | 挿入する側の SSA に修飾が付いている。データに制御文字が入っている | `ISRT` / `REPL` |
| `AJ` | SSA の書式が正しくない | 全部 |
| `AM` | `PROCOPT` か感知の範囲外 | 全部 |
| `LB` `LC` `LD` `LE` | ロードモードの順序違反（既存 / キー順 / 親が無い / 兄弟の順） | `ISRT` |

**`GA` と `GK` は警告で、セグメントは返る。** `stat_code = '  '` を
ループの条件にすると、階層をまたいだところで読み落とす。
全件たどるなら `stat_code ^= 'GB'` を条件にする。

## 例

- `engine/examples/tests/dli_test.pli` — PL/I で書いた 12 本のテスト。
  `STUDENT.dbd` / `STUPSB.psb` / `STUDENT.dat` / `dlipcb.inc` が同じ場所にある
- ブラウザ版のサンプル「IMS/DB（DL/I）」 — 選ぶと DBD・PSB・データも一緒に入る

```bash
cd engine
npm run plitest -- examples/tests    # 書き戻さない。PSB は隣の *.psb を自動で使う
npm run pli -- examples/dli/stuprt.pli --psb STUPSB
```

`examples/dli/STUPSB.psb` には `CMPAT=YES` が付いていて（入出力 PCB が
先頭に付く）、`examples/tests/STUPSB.psb` には付いていない。
主手続きが受け取るポインタの数が変わるので、PSB を取り違えないこと。

`plitest` は既定で**どのファイルへも書き戻さない**（DL/I のデータファイルも、
`PUT FILE` で作ったファイルも）。テストを走らせるたびに
元データが変わると 2 回目から結果が変わるため（`DLET` のテストで実際に
起きた）。反映したいときは `--write`。

## Snippet

| 入力 | 入るもの |
|------|---------|
| `pcb` | PCB マスクの宣言 |
| `dlifunc` | `PLITDLI` の宣言と機能コードの定義 |
| `dligu` | `GU` + 修飾 SSA + ステータスコードの分岐 |
| `dlign` | `GN` のループ（`GB` まで） |
| `dlirepl` | `GHU` + `REPL` |
