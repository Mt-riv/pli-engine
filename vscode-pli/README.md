# PL/I VSCode Extension

**日本語** | [English](README.en.md)

PL/I の構文強調・診断・実行・テスト・Snippet・Linter を VSCode に統合する。
**処理系（`pli-engine`）を同梱している**ので、外部のコンパイラを必要としない。

> **使い方の手引きはリポジトリの `docs/vscode-manual.md`。**
> この文書は作りの説明と開発手順。
> （vsix には Extension のフォルダしか入らないので、外を指すリンクは張らない）

## 機能

| 機能 | 内容 |
|------|------|
| 構文強調 | TextMate 文法。キーワード 133 語、組込関数 120 語（実装済み 21 種と、名前だけ知っている 99 語を別スコープで着色） |
| 診断 | 入力中に構文を検査し、問題タブに行・桁付きで表示 |
| 実行 | `PL/I: 実行`（`Cmd/Ctrl+Alt+R`）で出力パネルに結果を表示 |
| 引数付き実行 | `PL/I: 引数を指定して実行` で主手続きに引数を渡す |
| テスト | `PL/I: テストを実行`（`Cmd/Ctrl+Alt+T`） |
| 画面（MFS） | `PL/I: 画面を動かす（MFS）` で 3270 の画面を台本どおりに動かし、画面像を出力パネルに出す。書式定義 `*.mfs` と台本 `*.keys` はソースと同じ場所から読む |
| Snippet | 43 本。`main` `proc` `dowhile` `sel` `onerr` などを入力して展開 |
| Linter | 入力中に 16 規則で検査。問題タブに規則 id 付きで出る |
| IMS/DB（DL/I） | `CALL PLITDLI` で階層型データベースを読み書きする。設定 `pli.dli.psb` に PSB の名前を入れると有効になる |

対応する拡張子: `.pli` `.pl1` `.plinc` `.inc` `.cpy`

### テスト

主手続きを持たず `TEST_` で始まる手続きを並べたファイルをテストとして実行する。
書き方と表明の一覧はリポジトリの `docs/test.md` にある。

```pli
TEST_MOD: proc;
  call ASSERT_EQUALS(2, mod(17, 5), '17 mod 5');
end TEST_MOD;
```

`*_test.pli` などの名前か、**主手続きが無く `TEST_` 手続きがある**場合は、
`PL/I: 実行` でもテストとして走る。テストファイルをそのまま実行しても
「主手続きが無い」で終わるだけなので、振り替えている。
引数を指定して実行したときは利用者の意図がはっきりしているため振り替えない。

### Linter

構文が通っているときだけ動き、宣言していない名前・使っていない変数・
基数の混在などを指摘する。規則と理由は
リポジトリの `docs/lint.md` にある。

問題タブには規則 id が付く（例: `implicit-declaration`）ので、
邪魔な指摘はそのまま設定に書いて切れる。

```jsonc
{
  "pli.lint.rules": { "goto-outside-on-unit": "off" },
}
```

### Snippet

定義源は `../engine/src/snippets.ts` の 1 箇所で、
`snippets/pli.json` は `npm run gen:snippets`（engine 側）で生成する。
同じ定義をブラウザ版からも使うため、食い違いが起きない作りにしてある。

## 設定

| 設定 | 既定 | 説明 |
|------|------|------|
| `pli.diagnostics.enabled` | `true` | 入力中の構文検査 |
| `pli.run.maxSteps` | `5000000` | 実行する文の数の上限（無限ループ対策） |
| `pli.run.maxOutputBytes` | `1000000` | 出力の上限（文字数） |
| `pli.lint.enabled` | `true` | 入力中に Linter をかける |
| `pli.lint.rules` | `{}` | 規則ごとの上書き（`off` / `info` / `warning` / `error`） |
| `pli.dli.psb` | `""` | IMS/DB（DL/I）で使う PSB の名前。入れると `<名前>.psb` を読み、主手続きの引数が PCB のポインタになる。空なら DL/I を使わない |
| `pli.language` | `"auto"` | メッセージと診断の言語（`auto` / `ja` / `en`）。`auto` は VSCode の表示言語に合わせる。コマンド名と設定の説明は VSCode の表示言語で決まる |

## IMS/DB（DL/I）

設定 `pli.dli.psb` に PSB の名前（拡張子なし）を入れると、`CALL PLITDLI` で
階層型データベースを読み書きできる。`<PSB 名>.psb` / `<DBD 名>.dbd` /
`<DBD 名>.dat` を、開いているファイルの隣かワークスペース直下に置く。
空のままなら DL/I は使わない（`CALL PLITDLI` は「PSB が指定されていません」と
言って止まる）。

PSB 名は IMS の規則どおり 1〜8 桁の英数字と `$ # @` だけを受け付ける。
そのままファイル名になるので、形が違う値は無視して警告を出す。

書き方の詳細はリポジトリの `docs/dli.md`。

## 読み書きするファイルの範囲

`%INCLUDE` とファイル入出力は、**開いているファイルのディレクトリと
ワークスペースのフォルダの中だけ**を読み書きする。`../` や絶対パスで
外へ出ることはできず、シンボリックリンクも実体の位置で判定する。

`PL/I: テストを実行` は実ファイルへ書き戻さない。テストが書いたファイルで
次回の結果が変わらないようにするためで、CLI の `plitest` と同じ約束。

この Extension は**信頼済みのワークスペースでしか動かない**
（`capabilities.untrustedWorkspaces: false`）。ワークスペースの設定と
ソースを読んで解析するため。

## 構文強調の限界

**PL/I には予約語が無い。** 次は合法なコードで、
「`IF` と `THEN` が等しければ `THEN` に `ELSE` を代入する」という意味になる。

```pli
IF IF = THEN THEN THEN = ELSE;
```

語がキーワードか変数かは**文脈でしか決まらない**ため、
TextMate 文法による着色は原理的に近似でしかない。
上の例では 2 つ目の `IF` が変数なのにキーワードとして着色される。

厳密な判定が必要な場合は**診断**を使う。こちらは同梱の処理系が
実際に構文解析しているので、文脈を正しく解決する。

## 構成

```
vscode-pli/
  package.json              Extension の定義（言語・文法・コマンド・設定）
  language-configuration.json  コメント・括弧・字下げの規則
  syntaxes/pli.tmLanguage.json 構文強調の定義
  snippets/pli.json         Snippet （engine から生成。手で編集しない）
  src/core.ts               VSCode に依存しない処理（テスト対象）
  src/extension.ts          VSCode への接続
  .vscode/launch.json       F5 で拡張開発ホストを起動する構成
  test/                     core.ts・文法ファイル・package.json の検証
```

VSCode API に依存しない処理を `core.ts` に分けてあるので、
VSCode を起動せずにテストできる。

## 開発

```bash
npm ci
npm test        # VSCode を起動せずに動く
npm run typecheck
npm run build   # esbuild で dist/extension.js にバンドル（エンジン同梱）
```

### 動作確認

1. **このフォルダ（`vscode-pli/`）を VSCode で開く**。
   親の `pli-engine/` を開くと `.vscode/launch.json` が見つからず `F5` が働かない
2. `F5` で拡張開発ホストを起動（`npm run build` が先に走る）。
   `../engine/examples/tests/arith_test.pli` が開いた状態で立ち上がる
3. `Cmd/Ctrl+Alt+T` でテスト、`Cmd/Ctrl+Alt+R` で実行
4. キーが効かないときは `Cmd/Ctrl+Shift+P` から `PL/I: テストを実行` を選ぶ。
   コマンドが出てこなければ、Extension が読み込まれていないか、
   ファイルが別の言語 ID として開かれている（画面右下の言語モードを確認する）

拡張開発ホストは `--disable-extensions` で起動する。他の拡張を読み込まないので、
言語 ID の競合もログの騒音も出ない状態で確認できる。

### パッケージ化

`vsce` が必要。

```bash
npx @vscode/vsce package
```

生成された `.vsix` は `code --install-extension pli-lang-0.5.0.vsix` で導入できる。

## ライセンス

MIT License（Copyright (c) 2026 Mt-riv）。同梱の `LICENSE` を参照。
