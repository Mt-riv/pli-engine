/**
 * ソースを URL に載せて共有する。サーバを使わないので
 * ハッシュ（#s=...）に Base64URL で埋め込む。
 */

/** UTF-8 を Base64URL にする。 */
export function encodeSource(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64URL を UTF-8 に戻す。壊れていれば undefined。 */
export function decodeSource(encoded: string): string | undefined {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** 共有用の URL を組み立てる。 */
export function buildShareUrl(base: string, source: string): string {
  const withoutHash = base.split("#")[0] ?? base;
  return `${withoutHash}#s=${encodeSource(source)}`;
}

export interface ShareOutcome {
  /** クリップボードへ書けたか。 */
  copied: boolean;
  url: string;
  message: string;
}

/**
 * 共有を実行する。
 *
 * クリップボードは安全なコンテキストでしか使えず、file:// では
 * `navigator.clipboard` が存在しない。この UI はローカルのファイルを
 * 直接開く使い方が主なので、使えない場合はハッシュを更新して
 * アドレスバーからコピーしてもらう形に必ず落とす。
 */
export async function share(
  base: string,
  source: string,
  clipboard: { writeText(text: string): Promise<void> } | undefined,
  setHash: (hash: string) => void,
): Promise<ShareOutcome> {
  const url = buildShareUrl(base, source);
  const hash = `s=${encodeSource(source)}`;
  if (clipboard) {
    try {
      await clipboard.writeText(url);
      return { copied: true, url, message: "URLをコピーしました" };
    } catch {
      // 権限が無いなどで失敗した場合もハッシュへ落とす
    }
  }
  setHash(hash);
  return {
    copied: false,
    url,
    message: "URLを更新しました（アドレスバーからコピーしてください）",
  };
}
