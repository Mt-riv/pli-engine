/**
 * PL/I 側から来た名前を、許可したディレクトリの中へ封じ込める。
 *
 * CLI（`node-host.ts`）と VSCode Extension（`../../vscode-pli/src/extension.ts`）の
 * 両方がここを通す。`node:fs` を使うので `src/` には置けない
 * （`src/` はブラウザで動く必要がある）。
 *
 * ## なぜ必要か
 *
 * この処理系の設計前提は「PL/I のファイル名は識別子なので `.` も `/` も
 * 含められない」＝ソースの隣しか触らない、だった。しかしその前提を破る口がある。
 *
 * - `OPEN FILE(f) TITLE('../../etc/passwd')` の `TITLE` は**式**なので、
 *   実行時に任意の文字列を組み立てられる
 * - `%INCLUDE '任意のパス';` は文字列を取れる。しかも VSCode では
 *   ファイルを**開いただけ**で（構文検査のプリプロセスで）読まれる
 * - DL/I の `DBDNAME=` / `DBD NAME=` がそのままパスになるので、
 *   **データファイルが読み書き先を決める**
 *
 * ## 方針
 *
 * 1. 名前に区切り文字・NUL・親への参照が入っていたら、その時点で拒否する
 *    （設計前提をコードで強制する）
 * 2. 組み立てたパスを `realpath` で解決し、許可ルートの**実パス**の配下か確かめる
 *    文字列の前方一致だけではシンボリックリンクで抜けられる。
 *    `DATA.txt -> /etc/hosts` を置けば、PL/I 側は普通の識別子だけで外へ出られる
 * 3. 絶対パスは既定で拒否する
 */
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ContainOptions {
  /** 許可するディレクトリ。ここの実パスの配下だけを触れる。 */
  roots: string[];
  /** 真なら絶対パスも（許可ルートの配下であれば）受け付ける。 */
  allowAbsolute?: boolean;
  /**
   * 真なら名前に `/` や `..` が入っていても拒否しない。
   * `--allow-outside` の逃げ道のためだけにある。
   */
  allowPathSeparators?: boolean;
}

/**
 * PL/I のファイル名として受け付けられる形か。
 *
 * 実機の PL/I ではファイル名は識別子で、`/` も `..` も書けない。
 * `TITLE` と `%INCLUDE '...'` だけが文字列を取れるので、ここで揃える。
 */
export function isPlainName(name: string): boolean {
  if (name === "" || name.length > 255) return false;
  if (name.includes("\0")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  // Windows のドライブ指定とデータストリーム
  if (name.includes(":")) return false;
  // `..` そのもの、および `.` で始まる隠しファイル
  if (name === "." || name === ".." || name.startsWith(".")) return false;
  return true;
}

/** 実パスを求める。存在しないパスは、存在する祖先まで遡って解決する。 */
function realPathOfNearest(p: string): string {
  let at = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(at)) {
      // シンボリックリンクはここで実体へ解決される
      return join(realpathSync.native(at), ...tail.reverse());
    }
    const parent = dirname(at);
    if (parent === at) return join(at, ...tail.reverse());
    tail.push(at.slice(parent.length + 1));
    at = parent;
  }
}

/** `child` が `root` の配下（または root 自身）か。どちらも実パスで渡す。 */
function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 許可ルートの配下に収まるパスだけを返す。外へ出るものは undefined。
 *
 * `name` は PL/I 側から来た名前、`candidate` はそれを組み立てた候補パス。
 */
export function contain(
  candidate: string,
  opts: ContainOptions,
): string | undefined {
  if (candidate.includes("\0")) return undefined;
  const real = realPathOfNearest(candidate);
  for (const root of opts.roots) {
    if (!existsSync(root)) continue;
    if (isInside(realpathSync.native(root), real)) return candidate;
  }
  return undefined;
}

/**
 * PL/I の名前から候補パスを作り、封じ込めを通ったものだけを返す。
 *
 * `extensions` は補う拡張子の並び。`existsOnly` が真なら、
 * 実際に存在するファイルだけを返す（読み取り用）。
 */
export function resolveName(
  name: string,
  extensions: readonly string[],
  dirs: readonly string[],
  opts: ContainOptions & { existsOnly?: boolean },
): string | undefined {
  if (isAbsolute(name)) {
    if (opts.allowAbsolute !== true) return undefined;
    const kept = contain(name, opts);
    if (kept === undefined) return undefined;
    if (opts.existsOnly === true && !isReadableFile(kept)) return undefined;
    return kept;
  }
  if (opts.allowPathSeparators !== true && !isPlainName(name)) return undefined;
  for (const dir of dirs) {
    for (const ext of extensions) {
      const p = join(dir, name + ext);
      const kept = contain(p, opts);
      if (kept === undefined) continue;
      if (opts.existsOnly === true) {
        if (isReadableFile(kept)) return kept;
        continue;
      }
      if (existsSync(kept)) return kept;
    }
  }
  return undefined;
}

/**
 * ふつうのファイルとして読めるか。
 *
 * `existsSync` だけで選ぶと、`dcl data file;` に対して `data/` という
 * **ディレクトリ**が `data.txt` より先に当たる。CLI は生の `EISDIR` で落ち、
 * VSCode は読み取り失敗を空文字に置き換えて黙って動く。
 */
export function isReadableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 書き込み先として安全か。
 *
 * 既存のシンボリックリンクへ書くと、リンク先（許可ルートの外）が
 * 上書きされる。`contain` は実パスを見るので通常は弾かれるが、
 * 書き込み直前にもう一度確かめる。
 */
export function isSafeWriteTarget(p: string): boolean {
  try {
    const st = lstatSync(p);
    // 既存ならふつうのファイルだけ許す（リンク・ディレクトリは拒否）
    return st.isFile();
  } catch {
    // 無ければ新規作成。親ディレクトリが実在することを求める
    return isExistingDir(dirname(p));
  }
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * DL/I の DBD 名・PSB 名として受け付けられる形か。
 *
 * IMS の規則どおり 1〜8 桁の英数字と `$ # @`。
 * これを通さないと、`.psb` に書いた `DBDNAME=../../OUTSIDE/EVIL` が
 * そのままパスになる（データファイルが読み書き先を決めてしまう）。
 */
export function isDliName(name: string): boolean {
  return /^[A-Za-z0-9$#@]{1,8}$/.test(name);
}

export { sep };
