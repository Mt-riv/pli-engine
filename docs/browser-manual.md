# ブラウザ版マニュアル

ブラウザだけで PL/I を書いて動かす画面の使い方です。
**HTML ファイル 1 つ**で完結しており、サーバもインターネット接続も要りません。

## 起動

```bash
cd engine
npm ci
npm run web:build          # dist-web/index.html ができる（HTML 1 枚）
```

| OS | 開き方 |
|----|--------|
| macOS | `open dist-web/index.html` |
| Windows | `start dist-web\index.html` |
| Linux | `xdg-open dist-web/index.html` |

ファイルマネージャでダブルクリックしても開きます。**このファイルを
そのまま人に渡せば、相手も同じように使えます**（Node.js も不要）。

開発中に自動再読み込みしたい場合は `npm run web:dev` でサーバが立ちます。

## 画面

```
┌─────────────────────────────────────────────────────────────┐
│ PL/I エンジン  v0.3.0 [サンプル▼] [Snippet▼] [実行] [ファイル] [検査] [端末] [URLで共有] │
├──────────────────────────────┬──────────────────────────────┤
│ ソース                 1:1   │ 出力                          │
│  1 │ hello: proc options(main);                             │
│  2 │   put list('HELLO');  │  HELLO                        │
│  3 │ end hello;            │                               │
│    │                       ├──────────────────────────────┤
│                            │ 診断（クリックで該当行へ）     │
├──────────────────────────────┤──────────────────────────────┤
│ [付随ファイル][標準入力 (SYSIN)] │ 成功 / 2ms / 1行出力          │
│ ::: data.txt                 │                              │
│ 1 2 3                        │                              │
└──────────────────────────────┴──────────────────────────────┘
```

| 部品 | 役割 |
|------|------|
| サンプル | 14 本の例を読み込む。すべて実行可能 |
| Snippet | 43 本の定型を挿入する。挿入位置の字下げに合わせて貼られる |
| 実行 (Ctrl+Enter) | プログラムを動かす |
| ファイル | 下の引き出しを開閉する（付随ファイルと標準入力） |
| 検査 | 実行せずに Linter をかける |
| 端末 | 3270 の画面に切り替える（MFS。下の「画面を動かす（MFS）」） |
| URLで共有 | ソースを URL に埋め込む |
| 行番号 | 現在行は青、誤りのある行は赤 |
| 診断 | クリックするとその行へ飛ぶ |

## 実行する

`実行` ボタンか **`Ctrl+Enter`**。結果は右側に出ます。

```pli
calc: proc options(main);
  dcl x fixed dec(5,2);
  dcl y fixed dec(3,1);
  x = 123.45;
  y = 6.7;
  put list(x * y);     /* 827.115 — 2進浮動小数点なら 827.11499... */
end calc;
```

誤りがあると診断が下に出ます。クリックするとその行へカーソルが移ります。

- **無限ループは自動で止まります**（実行する文 500 万、出力 100 万文字が上限）。
  `do while('1'b); end;` も 0.1 秒ほどで停止します
- ブラウザには別プロセスが無いので、この上限が唯一の安全装置です

## テストとして実行する

主手続き（`OPTIONS(MAIN)`）が無く `TEST_` で始まる手続きがあるファイルは、
`実行` を押すと**テスト**として走ります。

```pli
SETUP: proc;            /* 各テストの前に走る */
  counter = 0;
end SETUP;

TEST_DECIMAL_IS_EXACT: proc;
  dcl x fixed dec(5,2);
  x = 0.1;
  x = x + 0.2;
  call ASSERT_EQUALS(0.3, x, '10進なら誤差が出ない');
end TEST_DECIMAL_IS_EXACT;

DISABLED_TEST_WIP: proc;   /* 接頭辞 DISABLED_TEST_ が付くと省略される */
  call FAIL('まだ書いていない');
end DISABLED_TEST_WIP;
```

結果はこう出ます。

```
--- テスト ---
  SKIP DISABLED_TEST_WIP (0ms)
       省略: DISABLED_ が付いているため実行しません
  OK   TEST_DECIMAL_IS_EXACT (8ms)
  FAIL TEST_THIS_ONE_FAILS (2ms)
       失敗: わざと間違えた例 : 期待 10 / 実際 9

テスト 3 / 成功 1 / 失敗 1 / 異常 0 / 省略 1 / 12ms
```

失敗したテストが `PUT` で出した内容は末尾に添えられます。
使える表明と設計の考え方は [`test.md`](test.md)。

サンプルの「テストの書き方」を選ぶと、動く例がそのまま入ります。

## 検査する（Linter）

`検査` ボタンは**実行せずに**怪しい書き方を指摘します。

```
2行: unused は宣言されていますが使われていません。 [unused-variable]
9行: i は宣言されていません。暗黙に FIXED BIN(15,0) として宣言されます。 [implicit-declaration]
```

- 黄色が警告、赤が誤り、灰色が情報
- 角括弧の中が規則の名前です

とくに `implicit-declaration` が重要です。PL/I は宣言の無い名前を暗黙に
宣言する（`I`〜`N` で始まれば `FIXED BIN(15,0)`、他は `FLOAT DEC(6)`）ため、
綴り間違いが黙って別の変数になります。規則の一覧は
[`lint.md`](lint.md)。

## Snippet を入れる

ヘッダの「Snippet…」から選ぶと、カーソル位置に挿入されます。
2 行目以降は挿入位置の字下げに揃います。

| よく使うもの | 内容 |
|-------------|------|
| 主手続き | `OPTIONS(MAIN)` の骨格 |
| 標準入力から読む | `ON ENDFILE` 付きの読み取りループ |
| ファイルを読む／書く | `OPEN` から `CLOSE` まで |
| 連結リストの節 | `BASED` 構造体とポインタ |
| 金額のピクチャ | `PIC'$$$,$$9V.99'` |
| テスト手続き | `TEST_` の雛形 |

## ファイルを使う

`ファイル` ボタンで下の引き出しが開きます。2 つの面があります。

### 付随ファイル

`::: 名前` の行で区切って、複数のファイルを 1 つの欄に書きます。

```
::: decls.inc
  dcl total fixed dec(7,2);
  dcl rate  fixed dec(3,2);
::: data.txt
10 20 30
```

これが `%INCLUDE` の取り込み元と、入出力の相手になります。

```pli
p: proc options(main);
%include decls;                      /* decls.inc を取り込む */
  dcl inp file stream input;
  dcl (a, b, c) fixed bin(31);
  on endfile(inp) ;
  open file(inp) input title('data.txt');
  get file(inp) list(a, b, c);
  put list(a + b + c);
end p;
```

- 名前の大文字小文字は区別しません
- `%INCLUDE decls;` は `decls` → `decls.inc` → `decls.pli` → `decls.pl1` →
`decls.cpy` → `decls.plinc` の順に探します
- 入出力は `data` に対して `data.txt` / `data.dat` / `data.csv` も試します
  （PL/I のファイル名は識別子なので `.` を書けないため）
- **プログラムが書き出したファイルは、実行後この欄に現れます**。
  そのまま次の入力にも使えます
- 取り込んだ先で誤りがあると `decls.inc 2行5桁: ...` と、そのファイルの
  位置で報告します

### IMS/DB（DL/I）を使う

付随ファイルに `<名前>.psb` を置くと、そのまま DL/I が有効になります。
実機では JCL が PSB を決めますが、ブラウザに JCL はありません。
設定欄を増やすより、置いたファイルから決める方が迷いが少ないためです。

```
::: STUDENT.dbd
         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         DBDGEN
         END
::: STUPSB.psb
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=5
         SENSEG NAME=STUDENT,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
::: STUDENT.dat
STUDENT S0001YAMAKAWA
STUDENT S0002TSUKIMI
```

- `.psb` が 2 つ以上あるとどちらか決められないので、その旨を出して
  DL/I を使わずに実行します
- `ISRT` / `REPL` / `DLET` の更新は、実行後に `.dat` の欄へ戻ります
- 書き方は [`dli.md`](dli.md)。サンプル「IMS/DB（DL/I）」を選ぶと
  この 3 つのファイルも一緒に入ります

### 標準入力（SYSIN）

`GET LIST` / `GET EDIT` が読む内容です。

```
10 20 30
40 50
```

```pli
p: proc options(main);
  dcl (v, total) fixed bin(31);
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
```

**`ON ENDFILE` は必須です。** 置かないと入力が尽きた時点で `ERROR` に連鎖して
プログラムが終わります。

なお「最後の項目を読んだその `GET`」で `ENDFILE` が上がります
（値の代入は済んでいます）。上の例で `10 20 30\n40 50` を与えると合計は
100 になり、150 にはなりません。末尾に空行を足すと 150 になります。

## 画面を動かす（MFS）

ヘッダの **「端末」** で 3270 の画面に切り替わります。

1. 付随ファイルに書式定義（`::: 名前.mfs`）と PSB（`::: 名前.psb`）を置く。
   PSB には入出力 PCB（`PCB TYPE=TP` か `CMPAT=YES`）が要ります
2. 「最初の画面」に MOD の名前を入れて **「開始」**
3. 打ち込める項目には入力欄が重なります。打って **ENTER**（入力欄で
   Enter キーを押しても同じ）
4. PF キーは右の一覧から選んで **「送信」**。出力メッセージが溜まっていれば
   **「次の画面」**

サンプル **「画面入出力（MFS）＋ IMS/DB」** を選ぶと、書式定義・PSB・
データベースが一式入って端末が開きます。

**1 回の入力ごとにプログラムを頭から動かします**（実機の MPP と同じ）。
画面と画面の間でプログラムは生きておらず、引き継がれるのは
データベース・会話の状態（SPA）・次に読む書式だけです。
詳細は [`mfs.md`](mfs.md)。

**会話型（SPA）はブラウザ版の端末では動きません。** SPA の長さを与える
口が無いためです。CLI の `--keys` か VSCode の「画面を動かす（MFS）」で、
台本に `SPA` を書いて試してください。

## 共有する

`URLで共有` はソースを URL のハッシュに埋め込みます。

```
file:///.../index.html#s=aGVsbG86IHByb2Mgb3B0aW9ucyhtYWluKTsK...
```

- `http(s)://` で開いている場合は URL をクリップボードにコピーします
- `file://` ではクリップボードが使えないので、アドレスバーを書き換えます。
  そこからコピーしてください
- その URL を開くと内容が復元されます。**ソースだけでなく付随ファイルと標準入力も載る**ので、`%INCLUDE` やファイル入出力、DL/I を使ったプログラムも受け取った側で動きます。
受け取った側では**自動では実行しません**。中身を確かめてから「実行する」を押してください（保存した内容より優先）
- Base64 で約 1.33 倍になるため、長いソースはブラウザの URL 長上限に
  当たります。その場合はファイルを直接渡してください

## 保存

編集中のソース・付随ファイル・標準入力は `localStorage` に自動保存され、
次に開いたときに復元されます。プライベートウィンドウなどで保存できない場合も、
動作には影響しません（保存を諦めて続行します）。

## よくあるつまずき

| 症状 | 原因と対処 |
|------|-----------|
| `UNDEFINEDFILE（ファイル xxx）` | PL/I のファイル名と付随ファイルの名前が違う。`OPEN ... TITLE('data.txt')` で結び付ける |
| `UNDEFINEDFILE …… INPUT と宣言したファイルを OUTPUT として使っています` | 宣言と使い方が逆。`dcl f file stream input;` なら `GET`、`output` なら `PUT` |
| 入力を読むと途中で終わる | `ON ENDFILE` が無い。置くと続行できる |
| 最後の 1 件が処理されない | ENDFILE の時機による。入力の末尾に空行を足す |
| `%INCLUDE の xxx が見つかりません` | 付随ファイルの名前を確認する。`::: ` の後ろの綴りがそのまま名前 |
| `PA1（物理ページング）は未実装です` | PA キーは再現しません。ENTER か PF キーで送る |
| 画面が真っ白 | ビルドが古い可能性。`npm run web:build` をやり直す |
| 共有ボタンが無反応に見える | `file://` ではコピーではなくアドレスバーが変わる |

## 制限

- 自作処理系のサブセットです。未実装の機能は名指しで報告します
  （一覧は [`../README.md`](../README.md) の「処理系の限界」）
- レコード入出力の区切りは**行**です。固定長レコードを扱う処理系では
  改行を含まないバイト列として読むものもあるので、他の処理系へ持っていく
  データはその点を確かめてください
