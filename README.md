# pli-engine — PL/I を書いて動かす道具一式

PL/I のプログラムを**ブラウザだけで**、あるいは**VSCode の中で**書いて動かせます。
コンパイラのインストールは要りません。処理系（インタプリタ）を TypeScript で
自作して同梱しているためです。

```pli
hello: proc options(main);
  put list('HELLO, PL/I');
end hello;
```

## このプロジェクトの目的

**メインフレームの環境が無くても、手続き型言語と階層型データベースを
手を動かして体感できるようにすること。**

PL/I と IMS/DB は 1960 年代後半に生まれ、いまも銀行・保険・公共の基幹系で
動いています。それなのに、個人が触る手段がほとんどありません。z/OS は
個人で借りられる値段ではなく、PL/I コンパイラも IMS も商用製品です。
結果として「名前は聞くが、書いたことも動かしたこともない」技術になっています。

この道具一式は、その 2 つを**ブラウザ 1 枚**で動かせるところまで持ってきます。
ファイルをダブルクリックすれば、その場で PL/I を書いて、階層型データベースを
読み書きできます。インストールもサーバも要りません。

| 意義 | 中身 |
|------|------|
| **教育** | 「COBOL でも SQL でもない書き方」を実際に動かして覚えられる。10 進固定小数点、`PICTURE` による桁編集、`ON` 条件、`GU` / `GN` による位置づけ — どれも説明を読むより動かした方が早い |
| **歴史** | 動かない技術は読み物でしか残らない。動く形で残しておけば、なぜその設計になったのか（なぜ予約語が無いのか、なぜ `JOIN` が無いのか）を手で確かめられる |
| **保守の入口** | 現役の資産を読む人が、手元で文法と挙動を試せる。本番に触る前に、落とし穴（ステータスコードを見ない、基数を混ぜる）を安全に踏める |

性能や互換性で商用製品の代わりになるものではありません。**サブセット**です。
できないことは黙って動かさず、何が未実装かを名指しで断ります。

## PL/I とは

IBM が 1964 年に発表した汎用プログラミング言語（Programming Language One）。
科学技術計算の FORTRAN と事務処理の COBOL を**1 つの言語に統合する**ことを
狙って作られました。いまも金融系の基幹バッチで現役です。

特徴的なところ:

- **予約語が無い。** `IF` も `THEN` も変数名に使えます。文脈だけで決まるので、
  次のプログラムは合法です（この処理系でも動きます）

  ```pli
  dcl (if, then, else) fixed bin(31);
  if = 1; then = 2; else = 3;
  if if = then then then = else;
  ```

- **10 進固定小数点が言語の型。** 金額計算で誤差が出ません。
  `123.45 * 6.7` は `827.115` ちょうどになります（2 進浮動小数点だとずれる）
- **`PICTURE` で桁を編集する。** `dcl amt pic'$$$,$$9V.99';` に `1234.5` を
  入れると ` $1,234.50` になります（先頭の空白まで規定どおり）。
  帳票を書くための機能が言語側にあります
- **`ON` 条件で異常を受ける。** `on zerodivide ...` / `on endfile(f) ...` のように、
  例外処理を宣言的に書きます（例外機構としては現代の `try` より古い世代）
- **構造体・配列・ポインタ・`BASED` 記憶域**を最初から持っています

COBOL より抽象度が高い一方で、C が広まるより前からポインタや記憶域の
重ね合わせといった低水準の操作も持っていた、という位置づけです。

## IMS/DB とは

IBM が 1968 年に製品化した**階層型データベース**（IMS = Information Management
System）。元はアポロ計画の部品表を管理するために開発されたもので、
リレーショナルデータベースより**前**の世代にあたります。
いまも大量トランザクションの基幹系で使われています。

データを表ではなく**木**で持ちます。

```
STUDENT（学生）
  └ COURSE（履修科目）
      └ GRADE（成績）
```

RDB との違いが、そのままプログラムの書き方の違いになります。

| | リレーショナル（SQL） | 階層型（IMS/DB） |
|---|---|---|
| データの形 | 表と外部キー | 親子の木 |
| 関連の取り出し | `JOIN` | 木を**たどる**（親から子へ） |
| 問い合わせ | 「何が欲しいか」を書く（宣言的） | 「どう進むか」を書く（手続き的） |
| 現在位置 | カーソルを使わない限り無い | **常にある**。直前にどこにいたかで次の呼び出しの結果が変わる |
| 失敗の知らせ方 | 例外・エラー | **ステータスコード**（例外は出ない） |

PL/I からは `CALL PLITDLI` で呼びます。DL/I（Data Language/I）が
そのインタフェースです。

```pli
/* S0002 の学生を 1 件取る */
dcl ssa char(25) init('STUDENT (STUDNO   =S0002)');
call plitdli(four, func_gu, db_pcb, seg_io, ssa);
if db_pcb.stat_code = '  ' then put list(seg_io);
```

- `GU`（Get Unique）で 1 件取り、`GN`（Get Next）で木を階層順にたどります
- 何がどこにあるかは **DBD**（データベースの定義）が、プログラムが何を
  見てよいかは **PSB** が決めます。どちらもテキストファイルです
- **失敗しても例外は出ません。** `PCB` のステータスコードを見ないと、
  取れなかったセグメントを取れたものとして処理してしまいます
  （IMS のプログラムで最も多い誤り。この処理系の Linter が指摘します）

使い方の詳細は [`docs/dli.md`](docs/dli.md)。

## できること

| できること | 入口 |
|-----------|------|
| PL/I を書いて即実行する | [ブラウザ版（HTML 1 枚）](docs/browser-manual.md) / [VSCode Extension](docs/vscode-manual.md) |
| 書いたコードを**テスト**する（PL/I で書くテストフレームワーク） | 両方 + CLI `npm run plitest` |
| **階層型データベース（IMS/DB）**を読み書きする | 両方 + CLI `npm run pli -- x.pli --psb NAME` |
| 怪しい書き方を**検査**する（Linter 14 規則） | 両方 + CLI `npm run plilint` |
| よく書く形を**Snippet**から入れる（43 本） | 両方 |

対応している PL/I の範囲（内部の作りは [`engine/README.md`](engine/README.md)）:

- 宣言・式・代入・`IF` / `DO`（3 形態と複数指定）/ `SELECT` / `GOTO` / `LEAVE` / `ITERATE`
- 手続き（入れ子・再帰・引数・戻り値）、`BEGIN` ブロック、構造体、配列、`DEFINED` + iSUB
- `PUT LIST` / `PUT EDIT` / `GET LIST` / `GET EDIT`（規定どおりの桁揃え）
- **10 進固定小数点の正確な算術**（`123.45 * 6.7 = 827.115` が誤差なく出る）
- `ON` 単位と条件（`ERROR` / `ZERODIVIDE` / `FIXEDOVERFLOW` / `ENDFILE` / `SIZE` ほか）
- **ストリーム入出力**（`OPEN` / `CLOSE` / `GET FILE` / `PUT FILE` / `LINESIZE`）
- **`%INCLUDE`**（取り込んだ先の誤りも、正しいファイルと行で報告）
- **`PICTURE`**（`$$$,$$9V.99` のような数値編集）
- **`BASED` 記憶域とポインタ**（`ALLOCATE` / `FREE` / `->` / `ADDR` / `NULL`）
- **レコード入出力**（`READ` / `WRITE` / `REWRITE`、`ENVIRONMENT(F RECSIZE(n))`）
- **IMS/DB（DL/I）**（`CALL PLITDLI` で階層型 DB を読み書き。DBD / PSB / SSA /
  PCB のステータスコード。詳細は [`docs/dli.md`](docs/dli.md)）
- 組込関数 21 種、`%REPLACE`

出力書式・精度規則・条件の扱いは、実在の PL/I 処理系の出力と突き合わせて
決めています。推測で作った部分は残していません。

ただし **IMS/DB（DL/I）だけは突き合わせる相手がありません**（IMS は z/OS
専用です）。DL/I は IBM の仕様文書を正とし、各ステータスコードの意味を
テストのコメントに引用して担保しています。

## 必要なもの

| | 版 | 用途 |
|--|----|------|
| Node.js | 20 以上 | ビルドと CLI。[nodejs.org](https://nodejs.org/) |
| git | 任意 | 取得 |
| VSCode | 1.90 以上 | Extension を使う場合のみ |

ブラウザで動かすだけなら、ビルドの後は Node.js も不要です
（生成物は HTML ファイル 1 つ）。

## セットアップ

### 共通（クローンとビルド）

```bash
git clone https://github.com/Mt-riv/pli-engine.git
cd pli-engine/engine
npm ci
npm run web:build      # dist-web/index.html ができる
```

#### macOS

```bash
open dist-web/index.html
```

Node.js を Homebrew で入れる場合は `brew install node`。

#### Windows

PowerShell で:

```powershell
git clone https://github.com/Mt-riv/pli-engine.git
cd pli-engine\engine
npm ci
npm run web:build
start dist-web\index.html
```

Node.js は [nodejs.org](https://nodejs.org/) の LTS 版インストーラ、または
`winget install OpenJS.NodeJS.LTS` で入ります。
PowerShell の実行ポリシーで `npm` が止まる場合は
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を一度実行してください。

#### Linux

```bash
xdg-open dist-web/index.html
```

ディストリビューションの Node.js は古いことがあります。20 未満なら
[nodesource](https://github.com/nodesource/distributions) か
[nvm](https://github.com/nvm-sh/nvm) を使ってください。

### VSCode Extension を入れる

#### リリースから入手する（手軽）

[Releases](https://github.com/Mt-riv/pli-engine/releases) から
`pli-lang-0.2.0.vsix` をダウンロードします。ビルドは要りません。

`gh` が使えるなら次でも取れます。

```bash
gh release download vscode-v0.2.0 --repo Mt-riv/pli-engine
```

#### 自分でビルドする

```bash
cd pli-engine/vscode-pli
npm ci
npm run build
npx @vscode/vsce package      # pli-lang-0.2.0.vsix ができる
```

#### インストール

VSCode の拡張ビュー（`Ctrl+Shift+X` / `Cmd+Shift+X`）→ 右上の `…` →
**「VSIX からのインストール」** で `pli-lang-0.2.0.vsix` を選びます。
`code` コマンドが使えるなら `code --install-extension pli-lang-0.2.0.vsix` でも入ります。

使い方は [`docs/vscode-manual.md`](docs/vscode-manual.md)。

### CLI（テストと Linter）

```bash
cd pli-engine/engine
npm run pli -- examples/dli/stuprt.pli --psb STUPSB   # プログラムを 1 本走らせる
npm run plitest -- examples/tests --psb STUPSB        # PL/I で書いたテストを走らせる
npm run plilint -- examples/tests    # 怪しい書き方を検査する
npm run plilint -- --list-rules      # 規則の一覧と、その理由
```

Windows でも同じコマンドが動きます（`npm run` 経由なのでパス区切りを問いません）。

## マニュアル

| 文書 | 内容 |
|------|------|
| [`docs/browser-manual.md`](docs/browser-manual.md) | **ブラウザ版の使い方**。実行・テスト・検査・Snippet・ファイル・共有 |
| [`docs/vscode-manual.md`](docs/vscode-manual.md) | **VSCode Extension の使い方**。コマンド・設定・トラブルシュート |
| [`docs/test.md`](docs/test.md) | テストフレームワークの設計と書き方 |
| [`docs/lint.md`](docs/lint.md) | Linter の規則一覧と、各規則の理由 |
| [`docs/dli.md`](docs/dli.md) | **IMS/DB（DL/I）の使い方**。DBD / PSB / データの書き方、SSA、ステータスコード |
| [`engine/README.md`](engine/README.md) | 処理系の内部。字句・構文・評価・書式の作り |

## リポジトリの構成

```
engine/        処理系（TypeScript、Node 非依存）
  src/           字句・構文・評価・Linter・テストフレームワーク・PICTURE・入出力
  web/           ブラウザ版（HTML 1 枚にビルドされる）
  examples/      PL/I で書いたテストの例
  scripts/       CLI（plitest / plilint / Snippet 生成）
vscode-pli/    VSCode Extension（処理系を同梱）
docs/          文書
  browser-manual.md  ブラウザ版の使い方
  vscode-manual.md   VSCode Extension の使い方
  test.md            テストフレームワークの設計と書き方
  lint.md            Linter の規則一覧と理由
  dli.md             IMS/DB（DL/I）の使い方
```

## 処理系の限界

PL/I のサブセットです。学習と検証には充分ですが、次は実装していません。

- 索引・直接編成ファイル（`KEYED` / `REGIONAL`）
- IMS の物理層（HDAM / HIDAM などの違い）、二次索引、論理関係、
  IMS TM（メッセージ処理）、`EXEC DLI`、同期点（`CHKP` / `ROLB`）
- `AREA` / `OFFSET`、自己定義構造体（`REFER`）、`UNION`、`LABEL` 変数
- 多重処理（`TASK` / `WAIT` / `EVENT`）
- 浮動小数点は JavaScript の数値（表示は `FLOAT DEC(6)` 相当の桁）
- ポインタは**アドレス値を持ちません**。確保した記憶域への参照なので、
  ポインタ算術や型の違う再解釈はできません（代わりに NULL・解放済み・
  二重解放を必ず検出します）

未実装の機能に当たると、何が未実装かを名指しで報告します。

## 設計で決めていること

- **字句解析はキーワードを判定しない。** PL/I には予約語が無く、
  `IF IF = THEN THEN THEN = ELSE;` が合法です。語がキーワードか識別子かは
  文脈でしか決まらないため、判断は構文解析に委ねています
- **FIXED DECIMAL は尺度付きの BigInt。** JavaScript の数値で代用すると
  10 進の計算が合いません
- **ブラウザには別プロセスが無い。** 無限ループと出力の暴走は処理系側の
  上限（文 500 万・出力 100 万文字）で止めます
- **外界に触れる処理は 1 箇所にまとめる。** `%INCLUDE` とファイル入出力は
  `PliHost` という差し込み口を通します。`src/` に `node:fs` を持ち込むと
  「HTML 1 枚で配れる」形が壊れるためです

## 開発

```bash
cd engine && npm ci && npm test         # 694 件
cd ../vscode-pli && npm ci && npm test  #  53 件
```

## ライセンス

[MIT License](LICENSE)
