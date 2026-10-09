/**
 * ストリーム入出力のファイル管理。
 *
 * PL/I のストリーム入出力は「文字の並び」を読み書きする。
 * 行（レコード）の区切りは `SKIP` と、入力では項目の区切りとして効く。
 *
 * 標準のファイル:
 *   SYSPRINT  — 標準出力。PRINT 属性（24 桁タブストップ・行幅 120）
 *   SYSIN     — 標準入力
 *   その他     — ホスト（`PliHost`）が解決する名前付きファイル
 *
 * 宣言されていないファイル名には既定属性が割り当てられ、そのまま開ける。
 */

import { ListWriter, type WriterOptions } from "./format.js";
import type { PliFile, PliHost } from "./host.js";

export type OpenMode = "input" | "output" | "update";

export interface FileAttributes {
  /** STREAM（既定）か RECORD か。 */
  record?: boolean;
  /** ENVIRONMENT(F RECSIZE(n)) の n。固定長レコードの長さ。 */
  recordSize?: number;
  /** 可変長レコード（ENVIRONMENT(V)）。 */
  variableRecords?: boolean;
  print?: boolean;
  mode?: OpenMode;
  lineSize?: number;
  pageSize?: number;
  /** TITLE 指定。実際に開く名前。省略するとファイル名そのもの。 */
  title?: string;
}

/**
 * 入力の読み取り位置。
 *
 * `GET LIST` は空白・カンマ・改行を区切りとして項目を切り出す。
 * `GET EDIT` は桁数で切り出し、`SKIP` で次の行へ送る。
 */
export class InputCursor {
  private pos = 0;

  constructor(private readonly text: string) {}

  /**
   * 次に読むものが無いか。
   *
   * 「項目がレコードの終わりで切れ、次のレコードが無い」ときに
   * その GET で ENDFILE を上げる（値の代入は済ませる）。
   * ここでは「残りが空、または改行 1 つだけ」をその状態とみなす。
   * 末尾に空行が続く場合は ENDFILE を上げない。
   */
  atLastItem(): boolean {
    const rest = this.text.slice(this.pos);
    return /^[ \t]*\n?[ \t]*$/.test(rest);
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  /** 残りが空白だけか（LIST 入力で次の項目が無いことの判定）。 */
  private restIsBlank(): boolean {
    return /^[\s,]*$/.test(this.text.slice(this.pos));
  }

  /**
   * LIST 入力の 1 項目を読む。
   *
   * 区切りは空白とカンマ。引用符で囲まれた文字列は 1 項目として扱い、
   * 中の `''` は `'` 1 個にする（PL/I の文字列と同じ規則）。
   * 読むものが無ければ undefined（呼び出し側が ENDFILE を起こす）。
   */
  nextItem(): string | undefined {
    if (this.restIsBlank()) {
      this.pos = this.text.length;
      return undefined;
    }
    // 区切りを読み飛ばす。カンマは 1 個だけ区切りとして消費する
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
    if (this.text[this.pos] === ",") {
      this.pos++;
      while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
    }
    if (this.pos >= this.text.length) return undefined;

    if (this.text[this.pos] === "'") {
      this.pos++;
      let out = "";
      while (this.pos < this.text.length) {
        const c = this.text[this.pos]!;
        if (c === "'") {
          if (this.text[this.pos + 1] === "'") {
            out += "'";
            this.pos += 2;
            continue;
          }
          this.pos++;
          break;
        }
        out += c;
        this.pos++;
      }
      return out;
    }

    const start = this.pos;
    while (this.pos < this.text.length && !/[\s,]/.test(this.text[this.pos]!)) this.pos++;
    return this.text.slice(start, this.pos);
  }

  /** EDIT 入力。現在位置から n 文字を取る。足りなければ空白で埋める。 */
  take(n: number): string {
    const s = this.text.slice(this.pos, this.pos + n);
    this.pos = Math.min(this.text.length, this.pos + n);
    return s.padEnd(n);
  }

  /** 現在位置から行末まで。幅を省略した A 書式で使う。 */
  restOfLine(): string {
    const next = this.text.indexOf("\n", this.pos);
    const end = next < 0 ? this.text.length : next;
    const s = this.text.slice(this.pos, end);
    this.pos = end;
    return s;
  }

  /** n 文字読み飛ばす（X 書式）。 */
  advance(n: number): void {
    this.pos = Math.min(this.text.length, this.pos + n);
  }

  /** SKIP: 次の行の先頭へ送る。 */
  skipLine(n = 1): void {
    for (let k = 0; k < n; k++) {
      const next = this.text.indexOf("\n", this.pos);
      this.pos = next < 0 ? this.text.length : next + 1;
    }
  }

  /** 現在行の残り（COLUMN 指定の基準に使う）。 */
  columnTo(at: number): void {
    const lineStart = this.text.lastIndexOf("\n", Math.max(0, this.pos - 1)) + 1;
    this.pos = Math.min(this.text.length, lineStart + Math.max(0, at - 1));
  }
}

/**
 * 開かれた 1 つのファイル。
 *
 * ストリームとレコードで持つものが違う。
 *   ストリーム入力 — 文字の位置を追うカーソル
 *   ストリーム出力 — 行・桁の状態を持つ書き出し口
 *   レコード入出力 — レコード（行）の並び
 *
 * 本来のレコードは固定長の記憶域で、packed decimal などの
 * 2 進表現がそのまま入る。ここでは仮想ファイルが文字列なので
 * **文字として表現できる項目だけ**を扱う（数値項目は PICTURE か
 * 文字で持つ必要がある）。この違いは文書に明記してある。
 */
export class StreamFile {
  readonly writer: ListWriter | undefined;
  readonly cursor: InputCursor | undefined;
  /** レコード入力の残り。 */
  private readonly records: string[] = [];
  private recordIndex = 0;
  /** レコード出力。 */
  private readonly written: string[] = [];
  /** 書き戻し先。SYSPRINT と SYSIN は持たない。 */
  private readonly backing: PliFile | undefined;

  constructor(
    readonly name: string,
    readonly mode: OpenMode,
    readonly attrs: FileAttributes,
    opts: { contents?: string; backing?: PliFile; writerOptions?: WriterOptions } = {},
  ) {
    this.backing = opts.backing;
    if (attrs.record) {
      const text = opts.contents ?? "";
      if (text !== "") {
        this.records = text.replace(/\n$/, "").split("\n");
      }
      if (mode === "update") {
        // 更新は読みながら書き換えるので、読んだ内容を土台にする
        this.written = [...this.records];
      }
      return;
    }
    if (mode === "input") {
      this.cursor = new InputCursor(opts.contents ?? "");
    } else {
      this.writer = new ListWriter(opts.writerOptions ?? {});
    }
  }

  /** レコードを 1 つ読む。終わりなら undefined。 */
  readRecord(): string | undefined {
    if (this.recordIndex >= this.records.length) return undefined;
    const raw = this.records[this.recordIndex++]!;
    const size = this.attrs.recordSize;
    // 固定長なら長さを揃える（短いレコードは空白で埋める）
    return size === undefined ? raw : raw.padEnd(size).slice(0, size);
  }

  /** レコードを 1 つ書く。 */
  writeRecord(text: string): void {
    const size = this.attrs.recordSize;
    this.written.push(size === undefined ? text : text.padEnd(size).slice(0, size));
  }

  /** 直前に読んだレコードを置き換える（UPDATE）。 */
  rewriteRecord(text: string): boolean {
    if (this.recordIndex === 0) return false;
    const size = this.attrs.recordSize;
    this.written[this.recordIndex - 1] = size === undefined
      ? text
      : text.padEnd(size).slice(0, size);
    return true;
  }

  /** 閉じる。出力なら内容をホストへ書き戻す。 */
  close(): void {
    if (this.attrs.record) {
      if (this.mode === "input") return;
      this.backing?.write?.(this.written.length === 0 ? "" : this.written.join("\n") + "\n");
      return;
    }
    if (!this.writer) return;
    this.writer.finish();
    this.backing?.write?.(this.writer.text());
  }
}

/** ファイル名の標準形。PL/I のファイル名は識別子なので大文字で持つ。 */
export function fileKey(name: string): string {
  return name.toUpperCase();
}

export const SYSPRINT = "SYSPRINT";
export const SYSIN = "SYSIN";

/**
 * 実行中に開いているファイルの表。
 *
 * SYSPRINT と SYSIN は宣言も OPEN も無しで使える。
 * それ以外はホストに問い合わせる。
 */
export class FileTable {
  private readonly open = new Map<string, StreamFile>();
  /** 宣言で分かっている属性。OPEN していないファイルを使うときの既定になる。 */
  private readonly declared = new Map<string, FileAttributes>();

  constructor(
    private readonly host: PliHost | undefined,
    private readonly stdin: string,
  ) {}

  declare(name: string, attrs: FileAttributes): void {
    const key = fileKey(name);
    this.declared.set(key, { ...this.declared.get(key), ...attrs });
  }

  declaredAttrs(name: string): FileAttributes {
    return this.declared.get(fileKey(name)) ?? {};
  }

  isOpen(name: string): boolean {
    return this.open.has(fileKey(name));
  }

  get(name: string): StreamFile | undefined {
    return this.open.get(fileKey(name));
  }

  /** SYSPRINT。プログラムの標準出力。 */
  sysprint(): StreamFile {
    const existing = this.open.get(SYSPRINT);
    if (existing) return existing;
    const f = new StreamFile(SYSPRINT, "output", { print: true }, {
      writerOptions: { print: true },
    });
    this.open.set(SYSPRINT, f);
    return f;
  }

  /**
   * ファイルを開く。
   *
   * 既に開いていれば**そのまま返す**。暗黙 OPEN と区別が付かないので、
   * 明示的な二重 OPEN だけ呼び出し側で誤りにする。
   */
  openFile(name: string, want: FileAttributes): StreamFile {
    const key = fileKey(name);
    const existing = this.open.get(key);
    if (existing) return existing;

    const attrs: FileAttributes = { ...this.declared.get(key), ...want };
    const mode: OpenMode = attrs.mode ?? (key === SYSIN ? "input" : "output");
    const title = attrs.title ?? name;

    if (key === SYSPRINT && mode === "output") {
      const f = this.sysprint();
      return f;
    }
    if (key === SYSIN && mode === "input") {
      const f = new StreamFile(SYSIN, "input", attrs, { contents: this.stdin });
      this.open.set(key, f);
      return f;
    }

    const backing = this.host?.openFile?.(title, mode);
    if (backing === undefined) {
      throw new UndefinedFileError(name);
    }
    const f = new StreamFile(name, mode, attrs, {
      ...(mode === "input" || mode === "update"
        ? { contents: backing.read?.() ?? "" }
        : {}),
      backing,
      writerOptions: {
        print: attrs.print ?? false,
        ...(attrs.lineSize === undefined ? {} : { lineSize: attrs.lineSize }),
        ...(attrs.pageSize === undefined ? {} : { pageSize: attrs.pageSize }),
      },
    });
    this.open.set(key, f);
    return f;
  }

  close(name: string): boolean {
    const key = fileKey(name);
    const f = this.open.get(key);
    if (!f) return false;
    f.close();
    this.open.delete(key);
    return true;
  }

  /** プログラム終了時。開いたままのファイルを全て閉じる。 */
  closeAll(): void {
    for (const key of [...this.open.keys()]) {
      if (key === SYSPRINT) continue; // 標準出力は呼び出し側が取り出す
      this.close(key);
    }
  }

  /** 出力の総量。上限の判定に使う。 */
  totalWritten(): number {
    let n = 0;
    for (const f of this.open.values()) n += f.writer?.length() ?? 0;
    return n;
  }
}

/** UNDEFINEDFILE 条件のもとになる誤り。 */
export class UndefinedFileError extends Error {
  constructor(readonly fileName: string) {
    super(`ファイル ${fileName} を開けません`);
    this.name = "UndefinedFileError";
  }
}
