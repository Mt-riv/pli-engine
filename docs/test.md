# PL/I テストフレームワーク

PL/I で書いたテストを PL/I で走らせる。

テストの中身は**ただの PL/I** で、フレームワークのための特別な構文は無い。
表明も `CALL` で呼ぶ普通の手続きである。言語に無いものを持ち込まずに
済ませるため、この形にしてある。

## テストファイルの形

主手続きを**書かない**。手続きを並べるだけである。

```pli
/* math_test.pli */

dcl counter fixed bin(31);

SETUP: proc;
  counter = 0;
end SETUP;

TEARDOWN: proc;
  /* 後片付け。テストが失敗しても必ず走る */
end TEARDOWN;

TEST_MOD: proc;
  call ASSERT_EQUALS(2, mod(17, 5), '17 mod 5');
end TEST_MOD;

DISABLED_TEST_NOT_READY: proc;
  call FAIL('まだ書いていない');
end DISABLED_TEST_NOT_READY;
```

| 名前 | 扱い |
|------|------|
| `TEST_*` | テストとして実行する（引数なしの手続きのみ） |
| `DISABLED_TEST_*` | 実行せず「省略」と報告する |
| `SETUP` | 各テストの**前**に実行する |
| `TEARDOWN` | 各テストの**後**に実行する。テストが失敗しても走る |
| その他の手続き | テストから呼べる補助として扱う |

大文字小文字は区別しない（`test_mod` でもよい）。
引数を取る手続きはテストとみなさない。テストは引数なしで呼ぶためである。

## 表明

| 呼び出し | 条件 |
|---------|------|
| `ASSERT_EQUALS(期待, 実際, 説明)` | 数値が等しい |
| `ASSERT_NOT_EQUALS(期待しない値, 実際, 説明)` | 数値が異なる |
| `ASSERT_EQUALS_CHAR(期待, 実際, 説明)` | 文字列が等しい |
| `ASSERT_TRUE(条件, 説明)` | 条件が真 |
| `ASSERT_FALSE(条件, 説明)` | 条件が偽 |
| `FAIL(説明)` | 無条件に失敗させる |
| `SKIP_TEST(説明)` | そのテストを「省略」にして打ち切る |

引数順は **(期待, 実際)** である。逆にすると報告の
「期待 / 実際」が入れ替わって読めなくなるので、ここは揃えておく価値がある。

数値の表明は `FIXED DEC(15,5)` で受ける。報告に出すときは
桁合わせの空白と小数部の末尾の 0 を落とすので、`期待 10 / 実際 9` と出る。

### 表明が失敗したときの流れ

1. 目印付きの行を出力する（フレームワークが後で読み取るため）
2. `SIGNAL ERROR` を上げる
3. フレームワークが仕掛けた `ON ERROR` 単位が `TEARDOWN` を呼ぶ
4. ERROR は再開可能でないため、そこでプログラムが終わる

つまり**失敗した時点でそのテストは中断し、`TEARDOWN` は必ず走る**。
`TEARDOWN` 自身が異常を起こしたときに
`ON` 単位へ再入しないよう、旗で守っている。

## テストごとに別のプログラムとして実行する

フレームワークはテスト 1 件につき 1 本の駆動プログラムを組み立てて実行する。

```
__PLITEST_RUNNER: proc options(main);
  <表明一式>
  <利用者のテストファイルの中身>
  on error begin; call TEARDOWN; end;
  call SETUP;
  call TEST_MOD;      ← この 1 件だけ
  call TEARDOWN;
end __PLITEST_RUNNER;
```

この作りから次が従う。

- **テストの間で状態が漏れない。** 静的な変数を書き換えるテストがあっても、
  次のテストは初期状態から始まる。
- **順序に依存できない。** テストが互いに依存する書き方が、そもそもできない。
- **全体の前後に一度だけ走る仕掛けは意味を持たない。** テストごとに別の
  実行なので、「全体の前に一度だけ」という場所が存在しない。
  守れない約束を API として置く方が害が大きいので、意図的に持たない。
  重い準備を一度だけ済ませたい場合は `SETUP` に書く（毎回走る）。

代償は速度である。テスト 1 件ごとに解析と実行をやり直す。
エンジンが速いので実測では 1 件 1〜8ms に収まっており、問題にならない。

## CLI

```bash
npm run plitest -- examples/tests                  # ディレクトリを再帰的に
npm run plitest -- a_test.pli b_test.pli           # ファイルを並べて
npm run plitest -- examples/tests --xml out/     # CI 用の XML も出す
npm run plitest -- examples/tests --quiet          # 失敗したファイルだけ表示
npm run plitest -- a_test.pli --max-steps 100000   # 文の実行数の上限
```

ディレクトリを指定したときは `*_test.pli` / `test_*.pli` / `*.test.pli`
（拡張子は `.pli` / `.pl1`）をテストファイルとみなす。
ファイルを直接指定したときは名前を問わない。

失敗・異常が 1 件でもあれば**終了コード 1**。そのまま CI に載せられる。

```
--- arith_test.pli ---
  OK   TEST_DECIMAL_MULTIPLY_IS_EXACT (2ms)
  FAIL TEST_MOD (1ms)
       失敗: 17 mod 5 : 期待 3 / 実際 2
  ERR  TEST_OVERFLOW (1ms)
       異常: FIXEDOVERFLOW

テスト 3 / 成功 1 / 失敗 1 / 異常 1 / 省略 0 / 4ms

--- TEST_MOD の出力 ---
[SETUP]
17 を 5 で割った余りを調べる
[TEARDOWN]
```

失敗・異常で終わったテストが `PUT` で出した内容は報告の末尾に添える
（成功した分まで出すと報告が埋もれるので添えない）。
`TEARDOWN` が走っていることもここで分かる。

## エディタから

| 入口 | 操作 |
|------|------|
| VSCode 拡張 | `PL/I: テストを実行`（`Cmd/Ctrl+Alt+T`） |
| ブラウザ版 | テストファイルを開いて「実行」。自動でテストとして走る |

どちらも、主手続きが無く `TEST_` 手続きがある場合は
`実行` でもテストとして走る（そのまま実行しても「主手続きが無い」で
終わるだけなので、振り替えても利用者の意図を損なわない）。
判定は `isTestFileName()` / `isTestSource()` に置き、両方の入口で同じ基準にしている。

## プログラムから使う

```ts
import { runTestSource, formatReport, toXmlReport } from "pli-engine";

const report = runTestSource(source);
// failedOutput で、失敗したテストが PUT で出した内容を末尾に添える
console.log(formatReport(report, "math_test.pli", { failedOutput: true }));
writeFileSync("out.xml", toXmlReport(report, "math_test"));
```

`TestReport` は `{ results, total, passed, failures, errors, skipped, ok, durationMs, note? }`。
`results[]` の各要素は `{ name, status, message?, stdout, durationMs }` で、
`status` は `passed` / `failed` / `error` / `skipped` のいずれか。

`failures`（表明の失敗）と `errors`（想定外の異常）を分けてある。
前者はテストが仕事をした結果で、後者はテストが成り立っていないことを意味し、
読む側の対応が違うためである。

## failure と error の見分け方

フレームワークは「表明の目印が出ているか」で判定する。

- 目印があれば **failure**（`ASSERT_*` か `FAIL` が上げた）
- 目印が無いのに異常終了していれば **error**
  （`FIXEDOVERFLOW`、`ZERODIVIDE`、文の上限超過、構文の誤りなど）

終了コードだけを見ないのは、「エラーを出しながら成功の終了コードを返す」
処理系が珍しくないためである。

## 既知の制限

- 表明は `FIXED DEC(15,5)` の範囲。これを超える数は `ASSERT_EQUALS_CHAR` で比較する
- 浮動小数点どうしの近似比較（`assertEquals(a, b, delta)` 相当）は未実装
- 例外の表明（`assertThrows` 相当）は未実装。`ON` 単位と旗で代用する
- テストファイルの中で `OPTIONS(MAIN)` を書くと、テストファイルと判定されない
