/**
 * 実ファイルで動くホスト。CLI 専用。
 *
 * `node:fs` をここに閉じ込めるのが要点。`src/` に入れると
 * ブラウザで動かなくなり、「HTML 1 枚で配れる」形が壊れる。
 *
 * PL/I 側から来た名前は必ず `safe-path.ts` の封じ込めを通す。
 * 通さないと `OPEN FILE(f) TITLE('../../どこか')` でソースの外を読み書きできる。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IMS_NAME } from "../src/index.js";
import type { FileMode, PliFile, PliHost } from "../src/index.js";
import {
  contain,
  isPlainName,
  isReadableFile,
  isSafeWriteTarget,
  resolveName,
  type ContainOptions,
} from "./safe-path.js";

/** `%INCLUDE a;` で試す名前。拡張子を順に補って探す。 */
const INCLUDE_EXTENSIONS = ["", ".inc", ".pli", ".pl1", ".cpy", ".plinc"];
/** データファイルで試す拡張子。PL/I のファイル名は `.` を含められない。 */
const DATA_EXTENSIONS = ["", ".txt", ".dat", ".csv"];

export interface NodeHostOptions {
  /** 相対パスの基準。ふつうは実行するソースのあるディレクトリ。 */
  baseDir: string;
  /** 追加の探索先（`-I` 相当）。 */
  includeDirs?: string[];
  stdin?: string;
  /** 真なら書き出しを行わず、内容を覚えるだけにする。 */
  dryRun?: boolean;
  /**
   * 真なら絶対パスと許可ルート外も受け付ける（`--allow-outside`）。
   * 自分のファイルを自分で触るときの逃げ道で、既定は偽。
   */
  allowOutside?: boolean;
}

export class NodeHost implements PliHost {
  readonly stdin: string;
  /** 書き出したファイル（dryRun のときの確認用）。 */
  readonly written = new Map<string, string>();
  /** 封じ込めで拒否した名前。呼び出し側が報告に使える。 */
  readonly refused = new Set<string>();

  private readonly dirs: string[];
  private readonly contain: ContainOptions;

  constructor(private readonly opts: NodeHostOptions) {
    this.stdin = opts.stdin ?? "";
    this.dirs = [opts.baseDir, ...(opts.includeDirs ?? [])];
    this.contain =
      opts.allowOutside === true
        ? { roots: ["/"], allowAbsolute: true, allowPathSeparators: true }
        : { roots: this.dirs };
  }

  /** 読み取り用。実在するふつうのファイルだけを返す。 */
  private find(name: string, extensions: readonly string[]): string | undefined {
    const p = resolveName(name, extensions, this.dirs, {
      ...this.contain,
      existsOnly: true,
    });
    if (p === undefined) this.refused.add(name);
    return p;
  }

  readInclude(name: string): string | undefined {
    const p = this.find(name, INCLUDE_EXTENSIONS);
    return p === undefined ? undefined : readFileSync(p, "utf8");
  }

  openFile(name: string, mode: FileMode): PliFile | undefined {
    const found = this.find(name, DATA_EXTENSIONS);
    if (mode === "input") {
      if (found === undefined) return undefined;
      const buffer = readFileSync(found, "utf8");
      return { read: () => buffer, write: () => {} };
    }
    // 出力・更新は新規作成もありうる
    const path = found ?? this.pathForNewFile(name);
    if (path === undefined) return undefined;

    let buffer =
      mode === "output" ? "" : found === undefined ? "" : readFileSync(found, "utf8");
    return {
      read: () => buffer,
      write: (contents: string) => {
        buffer = contents;
        this.written.set(path, contents);
        if (this.opts.dryRun === true) return;
        if (!isSafeWriteTarget(path)) {
          // 既存のシンボリックリンクやディレクトリへは書かない。
          // 書くとリンク先（許可ルートの外）を上書きしてしまう。
          // 親ディレクトリも勝手には作らない（mkdir -p は境界を越える）
          throw new Error(`ファイル ${name} へは書き込めません`);
        }
        writeFileSync(path, contents);
      },
    };
  }

  /** まだ無いファイルを作るときのパス。封じ込めを通らなければ undefined。 */
  private pathForNewFile(name: string): string | undefined {
    if (this.opts.allowOutside === true) return resolve(this.opts.baseDir, name);
    if (!isPlainName(name)) {
      this.refused.add(name);
      return undefined;
    }
    const kept = contain(join(this.opts.baseDir, name), this.contain);
    if (kept === undefined) this.refused.add(name);
    return kept;
  }
}

/**
 * ソースの隣にある PSB の名前。ちょうど 1 つあるときだけ返す。
 *
 * PSB は実機では JCL が決めるものでソースには書けないので、
 * 指定が無いときの既定としてここから拾う。2 つ以上あるときは
 * どれを使うか決められないので何も返さない（黙って選ばない）。
 *
 * CLI（plitest）と VSCode 拡張の両方がこれを使う。別々に持つと
 * 同じソースが「コマンドラインでは通るのにエディタでは全部異常」になる。
 */
export function psbBeside(file: string): string | undefined {
  try {
    const names = readdirSync(dirname(resolve(file)))
      .filter((n) => /\.psb$/i.test(n))
      .map((n) => n.replace(/\.psb$/i, ""))
      // IMS の名前になれないものは PSB として指定できない。
      // 数に入れると `my-psb.psb` が 1 つあるだけで
      // 「PSB 名 my-psb は IMS の名前として使えません」で止まる
      .filter((n) => IMS_NAME.test(n.toUpperCase()));
    return names.length === 1 ? names[0] : undefined;
  } catch {
    return undefined;
  }
}

/** ソースファイルのパスから、その隣を基準にするホストを作る。 */
export function hostForFile(
  file: string,
  stdin?: string,
  dryRun?: boolean,
  extra?: { includeDirs?: string[]; allowOutside?: boolean },
): NodeHost {
  return new NodeHost({
    baseDir: dirname(resolve(file)),
    ...(stdin === undefined ? {} : { stdin }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(extra?.includeDirs === undefined ? {} : { includeDirs: extra.includeDirs }),
    ...(extra?.allowOutside === undefined ? {} : { allowOutside: extra.allowOutside }),
  });
}

export { isReadableFile };
