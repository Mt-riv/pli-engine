import { describe, expect, it, vi } from "vitest";
import { buildShareUrl, decodeSource, encodeSource, share } from "../web/share.js";

describe("ソースの符号化", () => {
  it("往復して元に戻る", () => {
    for (const s of ["x = 1;", "put list('日本語');", "", "a\nb\tc", "'¬'"]) {
      expect(decodeSource(encodeSource(s))).toBe(s);
    }
  });

  it("URL に使えない文字を含まない", () => {
    const e = encodeSource("put list('a+b/c=d');");
    expect(e).not.toMatch(/[+/=]/);
  });

  it("壊れた入力では undefined", () => {
    expect(decodeSource("!!!not-base64!!!")).toBeUndefined();
  });
});

describe("buildShareUrl", () => {
  it("ハッシュを付ける", () => {
    expect(buildShareUrl("http://x/y.html", "a")).toBe(`http://x/y.html#s=${encodeSource("a")}`);
  });

  it("既にあるハッシュは置き換える", () => {
    const u = buildShareUrl("http://x/y.html#s=old", "new");
    expect(u).toBe(`http://x/y.html#s=${encodeSource("new")}`);
    expect(u).not.toContain("old");
  });

  it("file:// でも組み立てられる", () => {
    expect(buildShareUrl("file:///tmp/pli.html", "a")).toContain("file:///tmp/pli.html#s=");
  });
});

describe("share", () => {
  it("クリップボードが使えればコピーする", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const setHash = vi.fn();
    const r = await share("http://x/", "a", { writeText }, setHash);
    expect(r.copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith(`http://x/#s=${encodeSource("a")}`);
    expect(setHash).not.toHaveBeenCalled();
  });

  /**
   * file:// は安全なコンテキストではないので navigator.clipboard が無い。
   * この UI はローカルのファイルを直接開く使い方が主なので、
   * 無い場合に何も起きないのは不具合になる。必ずハッシュへ落とす。
   */
  it("クリップボードが無ければハッシュを更新する", async () => {
    const setHash = vi.fn();
    const r = await share("file:///tmp/pli.html", "a", undefined, setHash);
    expect(r.copied).toBe(false);
    expect(setHash).toHaveBeenCalledWith(`s=${encodeSource("a")}`);
    expect(r.message).toContain("アドレスバー");
  });

  it("クリップボードが例外を投げてもハッシュへ落とす", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const setHash = vi.fn();
    const r = await share("http://x/", "a", { writeText }, setHash);
    expect(r.copied).toBe(false);
    expect(setHash).toHaveBeenCalled();
  });

  it("共有したURLは復元できる", async () => {
    const setHash = vi.fn();
    const source = "h: proc options(main); put list('共有'); end h;";
    const r = await share("file:///tmp/pli.html", source, undefined, setHash);
    const hash = r.url.split("#s=")[1]!;
    expect(decodeSource(hash)).toBe(source);
  });
});
