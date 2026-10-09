/**
 * 外界への差し込み口。
 *
 * 入出力と `%INCLUDE` は処理系の外に触れる。しかしこのエンジンは
 * ブラウザで動くことが存在理由なので、`src/` に `node:fs` を持ち込むと
 * 「HTML 1 枚で配れる」という前提が壊れる。
 * そこで外界への口をここ 1 つにまとめ、呼ぶ側が実装を渡す。
 *
 *   ブラウザ版   — 画面で編集できるメモリ上の仮想ファイル
 *   CLI      — 実ファイル（node:fs は scripts/ 側に置く）
 *   VSCode   — ワークスペースのファイル
 *   テスト   — その場で作ったオブジェクト
 */

/** ファイルを開くときの用途。 */
export type FileMode = "input" | "output" | "update";

/**
 * 開かれたファイル。
 *
 * ストリーム入出力は文字の並び、レコード入出力は行の並びとして扱う。
 * レコードは行（文字列）で持ち、長さの調整は入出力の層で行う。
 */
export interface PliFile {
  /** 読み出す内容。`input` / `update` で使う。 */
  read?(): string;
  /** 書き出す内容。`output` / `update` で閉じるときに呼ばれる。 */
  write?(contents: string): void;
}

export interface PliHost {
  /**
   * `%INCLUDE` の解決。名前はソースに書かれたまま（大文字小文字そのまま）渡す。
   * 見つからなければ undefined を返す。例外は投げない。
   */
  readInclude?(name: string): string | undefined;

  /**
   * 名前付きファイルを開く。無ければ undefined。
   * `output` で開いたときは、存在しなくても新規作成として扱ってよい。
   */
  openFile?(name: string, mode: FileMode): PliFile | undefined;

  /** SYSIN の内容。`GET`（ファイル指定なし）と `GET FILE(SYSIN)` が読む。 */
  stdin?: string;
}

/**
 * メモリ上の仮想ファイルで動くホスト。
 *
 * ブラウザ版とテストの既定。ファイル名は**大文字小文字を区別しない**
 * （PL/I のファイル名は識別子なので）。
 */
export class MemoryHost implements PliHost {
  private readonly files = new Map<string, string>();
  /**
   * 表示用の名前。突き合わせは大文字で行うが、画面に出すときは
   * 利用者が書いたとおりの綴りに戻す。
   */
  private readonly names = new Map<string, string>();

  constructor(
    files: Record<string, string> = {},
    readonly stdin: string = "",
  ) {
    for (const [name, text] of Object.entries(files)) this.put(name, text);
  }

  /** 内容を置く。取り込み元にも入出力にも同じ表を使う。 */
  put(name: string, contents: string): void {
    const key = name.toUpperCase();
    this.files.set(key, contents);
    if (!this.names.has(key)) this.names.set(key, name);
  }

  get(name: string): string | undefined {
    return this.files.get(name.toUpperCase());
  }

  /** 書き出された分も含めた全ファイル。実行後の確認に使う。 */
  entries(): Record<string, string> {
    return Object.fromEntries(
      [...this.files].map(([k, v]) => [this.names.get(k) ?? k, v]),
    );
  }

  /**
   * 名前に拡張子を補って探す。
   *
   * PL/I のファイル名は識別子なので `.` を含められない。本来は ddname の
   * ような仕組みで実体に結び付けるが、ここには無いので拡張子を順に試す。
   * `dcl data file;` と書いて `data.txt` を読めるようにするため。
   */
  private resolve(name: string, extensions: readonly string[]): string | undefined {
    for (const ext of ["", ...extensions]) {
      const key = `${name}${ext}`.toUpperCase();
      if (this.files.has(key)) return key;
    }
    return undefined;
  }

  readInclude(name: string): string | undefined {
    const key = this.resolve(name, [".inc", ".pli", ".pl1", ".cpy", ".plinc"]);
    return key === undefined ? undefined : this.files.get(key);
  }

  openFile(name: string, mode: FileMode): PliFile | undefined {
    const found = this.resolve(name, [".txt", ".dat", ".csv"]);
    if (mode === "input" && found === undefined) return undefined;
    const key = found ?? name.toUpperCase();
    let buffer = mode === "output" ? "" : (this.files.get(key) ?? "");
    return {
      read: () => buffer,
      write: (contents: string) => {
        buffer = contents;
        this.files.set(key, contents);
        if (!this.names.has(key)) this.names.set(key, name);
      },
    };
  }
}
