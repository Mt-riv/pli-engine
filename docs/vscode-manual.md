# VSCode Extension マニュアル

PL/I の構文強調・診断・実行・テスト・検査・Snippet を VSCode に統合します。
**処理系を同梱している**ので、外部のコンパイラは要りません。

対応する拡張子: `.pli` `.pl1` `.plinc` `.inc` `.cpy`

## インストール

### リリースから入手する（手軽）

[Releases](https://github.com/Mt-riv/pli-engine/releases) から
`pli-lang-0.1.0.vsix`（約 62KB）をダウンロードします。ビルドは要りません。

```bash
gh release download vscode-v0.1.0 --repo Mt-riv/pli-engine
```

### 自分で `.vsix` を作る

```bash
cd pli-engine/vscode-pli
npm ci
npm run build
npx @vscode/vsce package      # pli-lang-0.1.0.vsix ができる
```

VSCode の拡張ビュー（`Ctrl+Shift+X` / `Cmd+Shift+X`）→ 右上の `…` →
**「VSIX からのインストール」** → `pli-lang-0.1.0.vsix` を選択。
`Developer: Reload Window` で読み込み直します。

`code` コマンドを PATH に通している場合は次でも入ります。

```bash
code --install-extension pli-lang-0.1.0.vsix
```

### 開発しながら使う

Extension を直しながら試す場合は、**`vscode-pli/` フォルダを VSCode で開いて**
`F5` を押します。ビルドが走り、`--disable-extensions` 付きの別ウィンドウ
（拡張開発ホスト）が立ち上がります。

親の `pli-engine/` を開くと `.vscode/launch.json` が見つからず `F5` が働きません。

## 機能

| 機能 | 操作 |
|------|------|
| 構文強調 | 自動（TextMate 文法。キーワード 133 語、組込関数 98 語） |
| 診断 | 入力中に自動。問題タブ（`Ctrl+Shift+M`）に行・桁付きで表示 |
| 実行 | `PL/I: 実行`（`Ctrl+Alt+R` / `Cmd+Alt+R`） |
| 引数付き実行 | `PL/I: 引数を指定して実行` |
| テスト | `PL/I: テストを実行`（`Ctrl+Alt+T` / `Cmd+Alt+T`） |
| Linter | 入力中に自動。13 規則 |
| Snippet | 38 本。`main` `dow` `getlist` などを入力して `Tab` |

コマンドはすべてコマンドパレット（`Ctrl+Shift+P` / `Cmd+Shift+P`）から
`PL/I:` で引けます。

## 実行する

`.pli` を開いて `Ctrl+Alt+R`。出力パネル（`PL/I` チャネル）に結果が出ます。

```
--- /path/to/hello.pli ---
HELLO, PL/I

成功 / 2ms
```

- 実行時エラーは診断としても表示され、問題タブから行へ飛べます
- 無限ループは上限（文 500 万・出力 100 万文字）で止まります
- 主手続きに引数を渡すには `PL/I: 引数を指定して実行`

## テストする

主手続きを持たず `TEST_` で始まる手続きを並べたファイルを `Ctrl+Alt+T` で
実行します。

```pli
SETUP: proc;
  /* 各テストの前に走る */
end SETUP;

TEST_MOD: proc;
  call ASSERT_EQUALS(2, mod(17, 5), '17 mod 5');
end TEST_MOD;
```

```
--- /path/to/math_test.pli ---
  OK   TEST_MOD (2ms)
  FAIL TEST_OTHER (1ms)
       失敗: 説明 : 期待 10 / 実際 9

テスト 2 / 成功 1 / 失敗 1 / 異常 0 / 省略 0 / 3ms
```

`*_test.pli` などの名前か、**主手続きが無く `TEST_` 手続きがある**場合は、
`PL/I: 実行` でもテストとして走ります。テストファイルをそのまま実行しても
「主手続きが無い」で終わるだけなので、振り替えています。
引数を指定して実行したときは振り替えません。

表明の一覧と設計は [`test.md`](test.md)。
動く例が `engine/examples/tests/` にあります。

## 検査する（Linter）

構文が通っているときだけ自動で走り、問題タブに出ます。
**規則の名前が付く**ので、邪魔な指摘はそのまま設定に書いて切れます。

```
unused は宣言されていますが使われていません。    pli-lint(unused-variable)
i は宣言されていません。暗黙に FIXED BIN(15,0) として宣言されます。
                                                 pli-lint(implicit-declaration)
```

規則の一覧と理由は [`lint.md`](lint.md)。

## 設定

`settings.json`（`Ctrl+,` → 右上のファイルアイコン）で変えられます。

| 設定 | 既定 | 説明 |
|------|------|------|
| `pli.diagnostics.enabled` | `true` | 入力中の構文検査 |
| `pli.lint.enabled` | `true` | 入力中の Linter |
| `pli.lint.rules` | `{}` | 規則ごとの上書き |
| `pli.run.maxSteps` | `5000000` | 実行する文の数の上限（無限ループ対策） |
| `pli.run.maxOutputBytes` | `1000000` | 出力の上限（文字数） |
| `pli.dli.psb` | `""` | IMS/DB（DL/I）で使う PSB の名前。空なら DL/I を使わない |

```jsonc
{
  "pli.lint.rules": {
    "goto-outside-on-unit": "off",
    "implicit-declaration": "error"
  }
}
```

設定を変えると、開いているファイルの診断がすぐ貼り直されます（再読み込み不要）。

## `%INCLUDE` の解決

取り込み元は次の順で探します。

1. **開いている未保存のファイル**（保存前でも取り込めます）
2. 編集中のファイルと同じディレクトリ
3. ワークスペースのフォルダ直下

拡張子は `.inc` `.pli` `.pl1` `.cpy` `.plinc` を順に試します。

取り込んだ先で誤りがあると、その**ファイルと行**で報告します。
主ファイルの行番号として出ることはありません。

## 構文強調の限界

**PL/I には予約語がありません。** 次は合法で、「`IF` と `THEN` が等しければ
`THEN` に `ELSE` を代入する」という意味です。

```pli
IF IF = THEN THEN THEN = ELSE;
```

語がキーワードか変数かは文脈でしか決まらないため、TextMate 文法による
着色は原理的に近似です（上の例では 2 つ目の `IF` が変数なのにキーワードとして
着色されます）。

厳密な判定が要る場合は**診断**を見てください。こちらは同梱の処理系が実際に
構文解析しているので、文脈を正しく解決します。

## よくあるつまずき

| 症状 | 原因と対処 |
|------|-----------|
| キーを押しても何も起きない | ファイルの言語モード（画面右下）が `PL/I` か確認する。別の言語として開かれている場合は、そこをクリックして切り替える |
| 実行すると「このファイルは言語『…』として開かれています」 | 上と同じ。`settings.json` の `files.associations` で `"*.pli": "pli"` を指定すると固定できる |
| `F5` で拡張開発ホストが起動しない | `vscode-pli/` フォルダを開いているか確認（親フォルダでは `launch.json` が見つからない） |
| 問題タブに大量の警告 | Linter の指摘。`pli.lint.rules` で個別に `off` にできる |
| `%INCLUDE` が見つからない | 編集中のファイルの隣かワークスペース直下に置く。拡張子は `.inc` などを自動で試す |
| テストが「テストが見つかりません」 | 手続き名が `TEST_` で始まっているか、引数を取っていないかを確認 |

## 開発

```bash
cd vscode-pli
npm ci
npm test          # 49 件（VSCode を起動せずに動く）
npm run typecheck
npm run build     # esbuild で dist/extension.js（処理系を同梱）
```

VSCode API に依存しない処理は `src/core.ts` に分けてあるので、
VSCode を起動せずにテストできます。
