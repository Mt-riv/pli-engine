/**
 * PL/I 側から来た名前の封じ込め。
 *
 * ここが抜けると `OPEN FILE(f) TITLE('../../どこか')` でソースの外を
 * 読み書きできる。`TITLE` は式なので実行時に任意の文字列を組み立てられ、
 * コードレビューでは気づけない形になる。シンボリックリンクも辿るので、
 * 文字列の前方一致だけでは守れない（realpath を見る必要がある）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDliName, isPlainName, resolveName } from "../scripts/safe-path.js";
import { NodeHost } from "../scripts/node-host.js";

let root: string;
let base: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pli-safe-"));
  base = join(root, "work");
  outside = join(root, "outside");
  mkdirSync(base);
  mkdirSync(outside);
  writeFileSync(join(base, "INSIDE.txt"), "ok\n");
  writeFileSync(join(outside, "SECRET.txt"), "secret\n");
  mkdirSync(join(base, "DATA"));
  writeFileSync(join(base, "DATA.txt"), "file-not-dir\n");
  symlinkSync(join(outside, "SECRET.txt"), join(base, "LINK.txt"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isPlainName", () => {
  it("識別子の形だけを通す", () => {
    expect(isPlainName("DATA")).toBe(true);
    expect(isPlainName("REPORT.txt")).toBe(true);
  });

  it("区切り・親参照・NUL を拒否する", () => {
    for (const bad of [
      "../x",
      "a/b",
      "a\\b",
      "C:/x",
      "..",
      ".",
      ".hidden",
      "a\0b",
      "",
    ]) {
      expect(isPlainName(bad), bad).toBe(false);
    }
  });
});

describe("resolveName", () => {
  const roots = () => ({ roots: [base] });

  it("許可ルートの中は読める", () => {
    expect(resolveName("INSIDE", [".txt"], [base], { ...roots(), existsOnly: true }))
      .toBe(join(base, "INSIDE.txt"));
  });

  it("`..` で外へは出られない", () => {
    expect(
      resolveName("../outside/SECRET.txt", [""], [base], {
        ...roots(),
        existsOnly: true,
      }),
    ).toBeUndefined();
  });

  it("絶対パスは既定で拒否する", () => {
    expect(
      resolveName(join(outside, "SECRET.txt"), [""], [base], {
        ...roots(),
        existsOnly: true,
      }),
    ).toBeUndefined();
  });

  it("シンボリックリンクで外へは出られない（realpath を見る）", () => {
    // 名前は素の識別子。文字列の検査だけでは通ってしまう形
    expect(resolveName("LINK", [".txt"], [base], { ...roots(), existsOnly: true }))
      .toBeUndefined();
  });

  it("ディレクトリは選ばない（DATA/ より DATA.txt）", () => {
    expect(
      resolveName("DATA", ["", ".txt"], [base], { ...roots(), existsOnly: true }),
    ).toBe(join(base, "DATA.txt"));
  });
});

describe("NodeHost", () => {
  it("外へ出る TITLE は開けない", () => {
    const host = new NodeHost({ baseDir: base });
    expect(host.openFile("../outside/SECRET.txt", "input")).toBeUndefined();
    expect(host.refused.has("../outside/SECRET.txt")).toBe(true);
  });

  it("中のファイルは開ける", () => {
    const host = new NodeHost({ baseDir: base });
    expect(host.openFile("INSIDE", "input")?.read?.()).toBe("ok\n");
  });

  it("%INCLUDE も封じ込める", () => {
    const host = new NodeHost({ baseDir: base });
    expect(host.readInclude("../outside/SECRET.txt")).toBeUndefined();
  });

  it("allowOutside なら逃げ道がある", () => {
    const host = new NodeHost({ baseDir: base, allowOutside: true });
    expect(host.openFile("../outside/SECRET.txt", "input")?.read?.()).toBe("secret\n");
  });

  it("includeDirs で許可した先は読める", () => {
    const host = new NodeHost({ baseDir: base, includeDirs: [outside] });
    expect(host.openFile("SECRET", "input")?.read?.()).toBe("secret\n");
  });

  it("外へ書こうとしても作らない", () => {
    const host = new NodeHost({ baseDir: base });
    expect(host.openFile("../outside/NEW.txt", "output")).toBeUndefined();
  });

  it("既存のシンボリックリンクへは書かない", () => {
    const host = new NodeHost({ baseDir: base, allowOutside: true });
    const f = host.openFile("LINK.txt", "output");
    // allowOutside でもリンク先の上書きは拒む
    expect(() => f?.write?.("overwritten")).toThrow();
  });
});

describe("isDliName", () => {
  it("IMS の名前は 1〜8 桁の英数字と $ # @", () => {
    expect(isDliName("STUDENT")).toBe(true);
    expect(isDliName("A$#@1234")).toBe(true);
    expect(isDliName("TOOLONGNAME")).toBe(false);
    expect(isDliName("../../EVIL")).toBe(false);
    expect(isDliName("")).toBe(false);
  });
});
