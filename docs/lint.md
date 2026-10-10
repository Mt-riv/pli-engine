# PL/I Linter

**日本語** | [English](en/lint.md)

構文解析が通ったうえで、**動くけれども怪しい書き方**を指摘する。
構文の誤りは実行時の診断が出すので、Linter は扱わない。
構文が壊れている間は Linter は何も返さない（打鍵の途中で指摘がちらつかないようにするため）。

## 使い方

```bash
npm run plilint -- examples/tests          # ディレクトリを再帰的に
npm run plilint -- a.pli --strict          # 警告も失敗として扱う
npm run plilint -- a.pli --lang en         # 指摘を英語で出す（環境変数 PLI_LANG でも）
npm run plilint -- a.pli --rule goto-outside-on-unit=off
npm run plilint -- --list-rules            # 規則の一覧（全 16 件）と理由
```

既定では **error が 1 件でもあれば終了コード 1**、警告だけなら 0。
`--strict` を付けると警告も失敗にする。

| 入口 | 操作 |
|------|------|
| VSCode Extension | 入力中に自動。問題タブに規則 id 付きで出る |
| ブラウザ版 | 「検査」ボタン |
| CLI | `npm run plilint` |
| プログラム | `lint(source, opts)` |

## 規則

重さは `error` / `warning` / `info` の 3 段階。`off` で止められる。全 16 件。

### correctness — 誤りか、誤りの元になる

| id | 既定 | 内容 |
|----|------|------|
| `implicit-declaration` | warning | 宣言していない名前を使っている |
| `unqualified-member` | **error** | 構造体の項目を名前だけで指している |
| `undefined-procedure` | **error** | 定義されていない手続きを呼んでいる |
| `unused-variable` | warning | 宣言したが一度も使っていない |
| `assigned-but-never-read` | warning | 代入しているが読んでいない |
| `never-assigned` | warning | 値を入れずに読んでいる |
| `unused-procedure` | warning | 定義したが呼ばれていない |
| `shadows-builtin` | warning | 組込関数と同じ名前を宣言している |
| `missing-main` | warning | `OPTIONS(MAIN)` を持つ手続きが無い |
| `mixed-base-arithmetic` | warning | FIXED DEC と FIXED BIN を混ぜて計算している |
| `file-not-declared` | warning | 宣言していないファイルを使っている |
| `endfile-without-on` | warning | `ON ENDFILE` を置かずにファイルから読んでいる |
| `free-then-use` | warning | `FREE` したポインタをそのまま使っている |
| `dli-status-unchecked` | warning | DL/I を呼んだのにステータスコードを見ていない |
| `on-never-raised` | warning | この処理系が起こさない条件に `ON` 単位を置いている |

**`implicit-declaration` がこの Linter の主目的**である。PL/I は宣言の無い名前を
暗黙に宣言する（`I`〜`N` で始まる名前は `FIXED BIN(15,0)`、それ以外は `FLOAT DEC(6)`）。
綴り間違いが黙って別の変数になり、エラーにならないまま誤った値で動き続ける。
予約語が無い言語なので、この種の誤りを機械が拾う価値が特に高い。

`unqualified-member` は `implicit-declaration` の特に質の悪い形。この処理系は
構造体の項目を「親.項目」の名前で持つので、項目だけを書くと**別の変数が
暗黙に宣言される**。`msg_out.out_attr = '00E8'X;` のつもりで
`out_attr = '00E8'X;` と書くと、止まらないまま別の変数へ代入される。
どの構造体の項目かを添えて指摘する。

`mixed-base-arithmetic` は実際に踏んだ落とし穴に対応する。基数が混ざると
PL/I は BINARY に変換して計算するため、10 進で持っていた桁が落ちる。
13 の階乗が FIXEDOVERFLOW になるのがその例。

見るのは**小数が絡む混在**だけ。

```pli
dcl i fixed bin(15);
i = 1;
put list(i * 0.1);     /* 指摘する。0.1 を 2 進の尺度へ直すと端数が出る */
if i = 10.5 then ...;  /* 指摘する。比較も基数を揃えてから行う */
put list(i - 1);       /* 指摘しない。整数なら 2 進へ直しても桁は落ちない */
```

対象の演算子は `+` `-` `*` `/` `**` と比較 8 種。どれも `unifyBase` を
通るので同じ端数が出る。

`dli-status-unchecked` は IMS のプログラムで最も多い誤りに対応する。
DL/I は失敗しても例外を出さず、PCB のステータスコードで知らせる。
見ないと「取れなかったセグメント」を取れたものとして処理してしまう。
ステータスコードは PCB マスクの 3 番目の項目で、名前は自由に付けられる
ので、名前ではなく位置で見ている（処理系が結び付けるのと同じ規則）。
PCB マスクの残りの項目は DL/I が埋めるものなので、読んでいなくても
`assigned-but-never-read` の対象にしない。

### style

| id | 既定 | 内容 |
|----|------|------|
| `goto-outside-on-unit` | info | ON 単位の外で GOTO を使っている |

ON 単位からの脱出には GOTO が要るので、ON 単位の中は対象にしない。

## 誤検出について

Linter は誤検出が出た時点で切られるので、既知の正しいコードに
指摘が出ないことをテストで固定している。

- ブラウザ版のサンプル 14 本 → 指摘 0
- `examples/tests` のテストファイル 5 本 → 指摘 0
- `examples/dli` と `examples/screen` の例 → 指摘 0（CI が `npm run plilint -- examples --strict` で見ている。走らせる方は `test/examples.test.ts`）

判定で気を遣っている点:

- **`LBOUND` / `HBOUND` / `DIM` の第 1 引数は値を読まない。** 配列の形を
  問い合わせているだけなので「値を入れる前に読んでいる」とは言わない
- **`SUBSTR` 疑似変数への代入は第 1 引数への書き込み。**
  `substr(s,3,2) = 'XY'` を `SUBSTR` の呼び出しと取り違えない
- **引数は未使用の対象にしない。** 使うかどうかは呼ぶ側の都合で決まる
- **主手続きとテスト手続き（`TEST_` / `SETUP` / `TEARDOWN`）は
  「呼ばれていない」と言わない。** 入口か、フレームワークが呼ぶもの
- **テストファイルでは `ASSERT_*` などを既知として扱う。**
  フレームワークが実行時に差し込む手続きなので、ソースには宣言が無い
- **構造体は修飾名（`REC.NAME`）でも構造体そのもの（`REC`）でも未宣言にしない**

## プログラムから使う

```ts
import { lint, formatLint, RULES } from "../engine/src/index.js";

const messages = lint(source, {
  rules: { "goto-outside-on-unit": "off", "implicit-declaration": "error" },
});
console.log(formatLint(messages, "a.pli"));
```

`LintMessage` は `{ rule, severity, line, col?, message }`。
式の節点が行を持たないため、指摘は**文の行**を指す。

## VSCode の設定

| 設定 | 既定 | 説明 |
|------|------|------|
| `pli.lint.enabled` | `true` | 入力中に Linter をかける |
| `pli.lint.rules` | `{}` | 規則ごとの上書き |

```jsonc
{
  "pli.lint.rules": {
    "goto-outside-on-unit": "off",
    "implicit-declaration": "error"
  }
}
```

問題タブには規則 id が付くので、出た指摘をそのまま設定に書いて切れる。
