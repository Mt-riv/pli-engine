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

PL/I と IMS/DB は 1960 年代に生まれた技術です（PL/I は 1964 年、IMS は 1968 年）。それなのに、個人が
触る手段がほとんどありません。z/OS は個人で借りられる値段ではなく、
PL/I コンパイラも IMS も商用製品です。結果として「名前は聞くが、
書いたことも動かしたこともない」技術になっています。

この道具一式は、その 2 つを**ブラウザ 1 枚**で動かせるところまで持ってきます。
ファイルをダブルクリックすれば、その場で PL/I を書いて、階層型データベースを
読み書きできます。インストールもサーバも要りません。

| 意義 | 中身 |
|------|------|
| **教育** | 「COBOL でも SQL でもない書き方」を実際に動かして覚えられる。10 進固定小数点、`PICTURE` による桁編集、`ON` 条件、`GU` / `GN` による位置づけ — どれも説明を読むより動かした方が早い |
| **歴史** | 動かない技術は読み物でしか残らない。動く形で残しておけば、なぜその設計になったのか（なぜ予約語が無いのか、なぜ `JOIN` が無いのか）を手で確かめられる |
| **保守の入口** | PL/I や IMS のコードを読むことになった人が、手元で文法と挙動を試せる。本番に触る前に、落とし穴（ステータスコードを見ない、基数を混ぜる）を安全に踏める |

性能や互換性で商用製品の代わりになるものではありません。**サブセット**です。
できないことを黙って動かすことはせず、何が未実装かを名指しで断ります。

## PL/I とは

IBM が 1964 年に発表した汎用プログラミング言語（Programming Language One）。
科学技術計算の FORTRAN と事務処理の COBOL を**1 つの言語に統合する**ことを
狙って作られました。

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
- **構造体・配列**を当初から持ち、後の版で**ポインタと `BASED` 記憶域**が入りました

抽象度は COBOL より高い一方で、C が広まるより前からポインタや記憶域の
重ね合わせといった低水準の操作も備えていました。ただしこの処理系は、
そのうち `UNION` による重ね合わせを実装していません（[処理系の限界](#処理系の限界)）。

## IMS/DB とは

IBM が 1968 年に製品化した**階層型データベース**（IMS = Information Management
System）。元はアポロ計画の部品表を管理するために開発されたもので、
リレーショナルデータベースより**前**の世代にあたります。

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
  （IMS のプログラムで典型的な誤り。この処理系の Linter が `dli-status-unchecked` として指摘します）

使い方の詳細は [`docs/dli.md`](docs/dli.md)。

## できること

| できること | 入口 |
|-----------|------|
| PL/I を書いて即実行する | [ブラウザ版（HTML 1 枚）](docs/browser-manual.md) / [VSCode Extension](docs/vscode-manual.md) |
| 書いたコードを**テスト**する（PL/I で書くテストフレームワーク） | 両方 + CLI `npm run plitest` |
| **階層型データベース（IMS/DB）**を読み書きする | 両方 + CLI `npm run pli -- x.pli --psb NAME` |
| **3270 の画面（MFS）**を読み書きする | ブラウザ版の「端末」 + CLI `npm run pli -- x.pli --psb NAME --keys x.keys` + VSCode |
| 怪しい書き方を**検査**する（Linter 15 規則） | 両方 + CLI `npm run plilint` |
| よく書く形を **Snippet** から入れる（43 本） | 両方 |

対応している PL/I の範囲（内部の作りは [`engine/README.md`](engine/README.md)）:

- 宣言・式・代入・`IF` / `DO`（`DO;` / `DO WHILE` / `DO UNTIL` / 反復、および複数指定）/
  `SELECT` / `GOTO` / `LEAVE` / `ITERATE`
- 手続き（入れ子・再帰・戻り値）、`BEGIN` ブロック、構造体、配列、`DEFINED` + iSUB。
  引数は PL/I の規定どおり**参照渡し**で、宣言した属性が渡した値と違うときだけ
  一時変数（ダミー引数）になります
- `PUT LIST` / `PUT EDIT` / `GET LIST` / `GET EDIT`（規定どおりの桁揃え）
- **10 進固定小数点の正確な算術**（`123.45 * 6.7 = 827.115` が誤差なく出る）
- `ON` 単位と条件。発火するのは `ERROR` / `ZERODIVIDE` / `FIXEDOVERFLOW` / `SIZE` /
  `SUBSCRIPTRANGE` / `CONVERSION` / `ENDFILE(f)` / `UNDEFINEDFILE(f)` の 8 つ
  （`SIGNAL` は任意の名前で起こせます）。`ON ... SYSTEM;` で既定動作に戻せます。
  これ以外の条件名に `ON` 単位を置いても構文は通りますが、処理系がその条件を
  起こさないため実行されません
- **ストリーム入出力**（`OPEN` / `CLOSE` / `GET FILE` / `PUT FILE` / `LINESIZE`）
- **`%INCLUDE`**（取り込んだ先の誤りも、ファイル名と元の行を添えて報告）
- **`PICTURE`**（`$$$,$$9V.99` のような数値編集）
- **`BASED` 記憶域とポインタ**（`ALLOCATE` / `FREE` / `->` / `ADDR` / `NULL`）
- **レコード入出力**（`READ` / `WRITE` / `REWRITE`、`ENVIRONMENT(F RECSIZE(n))`）
- **IMS/DB（DL/I）**（`CALL PLITDLI` で階層型 DB を読み書き。DBD / PSB / SSA /
  PCB のステータスコード。詳細は [`docs/dli.md`](docs/dli.md)）
- **画面入出力（MFS）と IMS TM**（`FMT` / `MSG` の書式定義から MID / MOD /
  DIF / DOF を作り、3270 の画面を組む。入出力 PCB への `GU` / `GN` / `ISRT` /
  `PURG`、会話型の SPA、`/FORMAT`。詳細は [`docs/mfs.md`](docs/mfs.md)）
- 組込関数 21 種、`%REPLACE`

出力書式と精度規則は、実在の PL/I 処理系の出力と突き合わせて決めています。
条件の扱いも突き合わせましたが、**計算条件の再試行だけは意図的に規定から
外しました**（止まらないプログラムを作らないため。理由は
[`engine/README.md`](engine/README.md) の「ON 条件の扱いを規定からずらした」）。
書式や精度を推測で埋めた箇所はありません。保留していた 3 点（基数混在の端数、
`F` 書式の丸めと桁あふれ、レコードの切り方）も実機で確かめ、**2 つは実装を
直しました**（詳細は [`engine/README.md`](engine/README.md) の
「実機と突き合わせて決めたこと」）。

実機と**意図的に違えている**ところは 2 つだけで、理由を同じ README の
「実機と違えている点」に書いてあります（10 進の最大精度を IBM PL/I for
MVS and VM 1.1 の 15 桁に合わせていること、レコードの区切りを行にしていること）。

ただし **IMS 関連（DL/I と MFS）だけは突き合わせる相手がありません**（IMS は
z/OS 専用で、手元で動かせる実装も入手できません）。この 2 つは IBM の仕様文書を
正とし、各規則の根拠をテストに引用して担保しています。画面像のゴールデンは
実機由来のものと混ざらないよう別の場所（`engine/test/screen/`）に置き、
出処の 1 行目を「IBM 仕様に基づく（実機の出力ではない）」で始めることを
テストで機械的に確かめています。

## 必要なもの

| | 版 | 用途 |
|--|----|------|
| Node.js | 20 以上 | ビルドと CLI。[nodejs.org](https://nodejs.org/) |
| git | 任意 | 取得 |
| VSCode | 1.90 以上 | Extension を使う場合のみ |

ブラウザで動かすだけなら、ビルドの後は Node.js も不要です
（生成物は HTML ファイル 1 つ）。

## セットアップ

以下のコマンドは、**共通手順を終えた直後（`pli-engine/engine` の中）**
からの相対パスで書いています。

### 共通（クローンとビルド）

```bash
git clone https://github.com/Mt-riv/pli-engine.git
cd pli-engine/engine
npm ci
npm run web:build      # dist-web/index.html ができる（1 ファイル）
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
`pli-lang-0.3.0.vsix` をダウンロードします。ビルドは要りません。

`gh` が使えるなら次でも取れます。

```bash
gh release download vscode-v0.3.0 --repo Mt-riv/pli-engine
```

#### 自分でビルドする

```bash
cd ../vscode-pli        # pli-engine/engine から
npm ci
npm run build
npx @vscode/vsce package      # pli-lang-0.3.0.vsix ができる
```

#### インストール

VSCode の拡張ビュー（`Ctrl+Shift+X` / `Cmd+Shift+X`）→ 右上の `…` →
**「VSIX からのインストール」** で `pli-lang-0.3.0.vsix` を選びます。
`code` コマンドが使えるなら `code --install-extension pli-lang-0.3.0.vsix` でも入ります。

使い方は [`docs/vscode-manual.md`](docs/vscode-manual.md)。

### CLI（テストと Linter）

```bash
cd ../engine            # VSCode の手順を飛ばした場合はそのまま engine にいます
npm run pli -- examples/dli/stuprt.pli --psb STUPSB   # プログラムを 1 本走らせる
npm run plitest -- examples/tests    # PL/I で書いたテストを走らせる（PSB は自動検出）
npm run plilint -- examples          # 怪しい書き方を検査する
npm run plilint -- --list-rules      # 規則の一覧と、その理由
npm run pli -- --help                # オプションの一覧
```

Windows でも同じコマンドが動きます（`npm run` 経由なのでパス区切りを問いません）。

`--help` でオプションの一覧が出ます。おもなもの:

| オプション | 対象 | 内容 |
|-----------|------|------|
| `--psb <名前>` | `pli` / `plitest` | IMS/DB（DL/I）を使う。`plitest` は省略すると隣の `*.psb` を自動で使う |
| `--keys <ファイル>` | `pli` | 端末の台本を流して画面を出す（MFS）。隣の `*.mfs` を書式定義として読む |
| `--stdin <ファイル>` | `pli` | SYSIN に流し込む |
| `--max-steps N` / `--max-output N` | `pli` | 実行の上限（1 以上の整数。不正な値は終了コード 2） |
| `-I <ディレクトリ>` | `pli` | `%INCLUDE` とファイルの探索先を足す |
| `--allow-outside` | `pli` | ソースのディレクトリの外も読み書きできるようにする |
| `--write` | `plitest` | テストの書き出しを実ファイルへ反映する（既定は反映しない） |
| `--all` | `plitest` | 名前が規約に合わないファイルも中身で判定する |
| `--strict` | `plilint` | warning も失敗として扱う |

**ファイル入出力の範囲。** `pli` は既定で、ソースのあるディレクトリと `-I` で
足した場所だけを読み書きします。`../` や絶対パスで外へ出ることはできず、
シンボリックリンクも実体の位置で判定します。外を触るときは `--allow-outside`
を明示してください。

## マニュアル

| 文書 | 内容 |
|------|------|
| [`docs/browser-manual.md`](docs/browser-manual.md) | **ブラウザ版の使い方**。実行・テスト・検査・Snippet・ファイル・共有 |
| [`docs/vscode-manual.md`](docs/vscode-manual.md) | **VSCode Extension の使い方**。コマンド・設定・トラブルシュート |
| [`docs/test.md`](docs/test.md) | テストフレームワークの設計と書き方 |
| [`docs/lint.md`](docs/lint.md) | Linter の規則一覧と、各規則の理由 |
| [`docs/dli.md`](docs/dli.md) | **IMS/DB（DL/I）の使い方**。DBD / PSB / データの書き方、SSA、ステータスコード |
| [`docs/mfs.md`](docs/mfs.md) | **画面入出力（MFS）の使い方**。書式定義、入出力 PCB、台本、会話型 |
| [`engine/README.md`](engine/README.md) | 処理系の内部。字句・構文・評価・書式の作り |

## リポジトリの構成

```
engine/        処理系（TypeScript、Node 非依存）
  src/           字句・構文・評価・Linter・テストフレームワーク・PICTURE・入出力
  web/           ブラウザ版（HTML 1 枚にビルドされる）
  examples/      PL/I で書いたテストの例（tests/）と IMS/DB の動く例（dli/）
  scripts/       CLI（pli / plitest / plilint / Snippet 生成）と実ファイル用のホスト
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
- 組込関数は 21 種だけです。`SQRT` / `DATE` / `ONCODE` など PL/I の
  他の組込関数は**名前は知っていて、使うと「未実装」と断ります**

未実装の機能に当たると、何が未実装かを名指しで報告します。
属性（`KEYED` / `REGIONAL` / `AREA` / `UNION` / `LIKE` / `EVENT` など）と
文（`WAIT` / `DISPLAY` / `REVERT` / `DELETE` など）、組込関数のいずれも、
名前で区別して「未実装」と答えます。知らない語は「解釈できない」と
答えるので、綴り間違いと未実装は見分けられます。

## 設計で決めていること

- **字句解析はキーワードを判定しない。** PL/I には予約語が無く、
  `IF IF = THEN THEN THEN = ELSE;` が合法です。語がキーワードか識別子かは
  文脈でしか決まらないため、判断は構文解析に委ねています
- **FIXED DECIMAL は尺度付きの BigInt。** JavaScript の数値で代用すると
  10 進の計算が合いません
- **ブラウザには別プロセスが無い。** 暴走は処理系側の上限で止めます。
  文の数（既定 500 万）と出力（既定 100 万文字）だけでは足りず、
  `dcl a(200000000)` のような**1 文**でメモリを使い切れるので、
  配列の要素数・文字列の長さ・`ALLOCATE` の回数にも上限があります
- **外界に触れる処理は 1 箇所にまとめる。** `%INCLUDE` とファイル入出力は
  `PliHost` という差し込み口を通します。`src/` に `node:fs` を持ち込むと
  「HTML 1 枚で配れる」形が壊れるためです

## 開発

```bash
cd engine && npm ci && npm test         # TypeScript 側のテスト
cd ../vscode-pli && npm ci && npm test  # VSCode を起動せずに動く
```

出力書式と精度規則は `engine/test/golden/` に**バイト単位で**固定しています。
期待値を取り直す道具は別リポジトリ（`pli-oracle`。非公開）にあり、
このリポジトリのテストはそれが無くても動きます
（詳細は [`engine/test/golden/README.md`](engine/test/golden/README.md)）。

push と Pull Request ごとに GitHub Actions が同じものを走らせます
（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。
型検査・テスト・PL/I で書いたテスト・Linter・ブラウザ版のビルド・
vsix のパッケージまでを通し、出荷物に入る依存の脆弱性も見ています。

## ライセンス

[MIT License](LICENSE)
