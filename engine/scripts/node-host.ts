/**
 * 実ファイルで動くホスト。CLI 専用。
 *
 * `node:fs` をここに閉じ込めるのが要点。`src/` に入れると
 * ブラウザで動かなくなり、「HTML 1 枚で配れる」形が壊れる。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FileMode, PliFile, PliHost } from "../src/index.js";

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
}

export class NodeHost implements PliHost {
  readonly stdin: string;
  /** 書き出したファイル（dryRun のときの確認用）。 */
  readonly written = new Map<string, string>();

  private readonly dirs: string[];

  constructor(private readonly opts: NodeHostOptions) {
    this.stdin = opts.stdin ?? "";
    this.dirs = [opts.baseDir, ...(opts.includeDirs ?? [])];
  }

  private find(name: string, extensions: readonly string[]): string | undefined {
    if (isAbsolute(name)) {
      return existsSync(name) ? name : undefined;
    }
    for (const dir of this.dirs) {
      for (const ext of extensions) {
        const p = join(dir, name + ext);
        if (existsSync(p)) return p;
      }
    }
    return undefined;
  }

  readInclude(name: string): string | undefined {
    const p = this.find(name, INCLUDE_EXTENSIONS);
    return p === undefined ? undefined : readFileSync(p, "utf8");
  }

  openFile(name: string, mode: FileMode): PliFile | undefined {
    const found = this.find(name, DATA_EXTENSIONS);
    if (mode === "input" && found === undefined) return undefined;
    const path = found ?? resolve(this.opts.baseDir, name);

    let buffer = mode === "output" ? "" : found ? readFileSync(found, "utf8") : "";
    return {
      read: () => buffer,
      write: (contents: string) => {
        buffer = contents;
        this.written.set(path, contents);
        if (this.opts.dryRun) return;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
      },
    };
  }
}

/** ソースファイルのパスから、その隣を基準にするホストを作る。 */
export function hostForFile(file: string, stdin?: string): NodeHost {
  return new NodeHost({ baseDir: dirname(resolve(file)), ...(stdin === undefined ? {} : { stdin }) });
}
