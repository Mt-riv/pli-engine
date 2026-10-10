import { describe, expect, it, vi } from "vitest";
import {
  buildShareUrl,
  decodePayload,
  decodeSource,
  encodePayload,
  encodeSource,
  share,
  MAX_SHARE_LENGTH,
} from "../web/share.js";

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

/**
 * 共有 URL の長さの上限。
 *
 * 受け取る側が復号するので、長さを見ないまま `atob` に渡すと
 * 巨大な文字列を作られる。符号の長さで先に弾く。
 */
describe("長さの上限", () => {
  it("上限までは往復する", () => {
    const text = "a".repeat(1000);
    expect(decodeSource(encodeSource(text))).toBe(text);
  });

  it("上限を超える符号は復号しない", () => {
    const tooLong = "A".repeat(Math.ceil((MAX_SHARE_LENGTH * 4) / 3) + 1);
    expect(decodeSource(tooLong)).toBeUndefined();
  });

  it("上限を超えるソースは復号しない", () => {
    const text = "a".repeat(MAX_SHARE_LENGTH + 1);
    expect(decodeSource(encodeSource(text))).toBeUndefined();
  });
});

/**
 * 付随ファイルと標準入力の共有。
 *
 * ソースだけでは、`%INCLUDE`・ファイル入出力・DL/I を使ったプログラムを
 * 受け取った側で再現できない。
 */
describe("共有する内容", () => {
  it("ソースだけなら s= で短いまま（以前の URL と互換）", () => {
    const h = encodePayload({ source: "x = 1;" });
    expect(h.startsWith("s=")).toBe(true);
    expect(decodePayload(`#${h}`)).toEqual({ source: "x = 1;" });
  });

  it("付随ファイルがあれば束にする", () => {
    const p = { source: "x = 1;", aux: "::: a.inc\ndcl x;\n" };
    const h = encodePayload(p);
    expect(h.startsWith("b=")).toBe(true);
    expect(decodePayload(`#${h}`)).toEqual(p);
  });

  it("標準入力も載る", () => {
    const p = { source: "get list(x);", stdin: "1 2 3\n" };
    expect(decodePayload(`#${encodePayload(p)}`)).toEqual(p);
  });

  it("3 つ揃っても往復する", () => {
    const p = { source: "x = 1;", aux: "::: a\n1\n", stdin: "9\n" };
    expect(decodePayload(`#${encodePayload(p)}`)).toEqual(p);
  });

  it("壊れたハッシュは undefined", () => {
    expect(decodePayload("#b=!!!")).toBeUndefined();
    expect(decodePayload("#x=abc")).toBeUndefined();
    expect(decodePayload("")).toBeUndefined();
  });

  it("source が無い束は受け取らない", () => {
    const bad = `b=${encodeSource(JSON.stringify({ aux: "x" }))}`;
    expect(decodePayload(`#${bad}`)).toBeUndefined();
  });

  it("余分な鍵は拾わない（必要な項目だけ読む）", () => {
    const bad = `b=${encodeSource(
      JSON.stringify({ source: "x", __proto__: { polluted: true }, extra: 1 }),
    )}`;
    const got = decodePayload(`#${bad}`);
    expect(got).toEqual({ source: "x" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("合計が上限を超える束は受け取らない", () => {
    const big = "a".repeat(MAX_SHARE_LENGTH);
    const bad = `b=${encodeSource(JSON.stringify({ source: big, aux: big }))}`;
    expect(decodePayload(`#${bad}`)).toBeUndefined();
  });

  it("URL は束を載せたハッシュになる", () => {
    const url = buildShareUrl("https://example.test/x#old", {
      source: "x = 1;",
      aux: "::: a\n1\n",
    });
    expect(url.startsWith("https://example.test/x#b=")).toBe(true);
  });
});
