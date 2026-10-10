/**
 * ソースを URL に載せて共有する。サーバを使わないので
 * ハッシュ（#s=...）に Base64URL で埋め込む。
 */


import { m } from "../src/i18n/index.js";
/** UTF-8 を Base64URL にする。 */
export function encodeSource(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 共有 URL に載せられるソースの上限（文字数）。
 *
 * 長さを見ないと、受け取った側の復号で巨大な文字列を作られる。
 * ブラウザの URL 長の実用上の上限よりも手前で切る。
 */
export const MAX_SHARE_LENGTH = 256 * 1024;

/** Base64URL を UTF-8 に戻す。壊れていれば undefined。 */
export function decodeSource(encoded: string): string | undefined {
  // 復号する前に長さで弾く。Base64 は 4 文字で 3 バイトなので、
  // 符号の長さから元の大きさが分かる
  if (encoded.length > Math.ceil((MAX_SHARE_LENGTH * 4) / 3)) return undefined;
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text.length > MAX_SHARE_LENGTH ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * 共有する内容。
 *
 * ソースだけでは、`%INCLUDE`・ファイル入出力・DL/I を使ったプログラムを
 * 受け取った側で再現できない（付随ファイルが無いので動かない）。
 */
export interface SharePayload {
  source: string;
  /** 付随ファイル欄の内容（`::: 名前` の記法そのまま）。 */
  aux?: string;
  /** 標準入力（SYSIN）。 */
  stdin?: string;
}

/**
 * 共有用の内容を符号化する。
 *
 * ソースだけなら `s=`（短く、以前の URL とも互換）。
 * 付随ファイルか標準入力があれば `b=`（JSON の束）。
 */
export function encodePayload(p: SharePayload): string {
  const aux = p.aux ?? "";
  const stdin = p.stdin ?? "";
  if (aux === "" && stdin === "") return `s=${encodeSource(p.source)}`;
  const bundle: SharePayload = {
    source: p.source,
    ...(aux === "" ? {} : { aux }),
    ...(stdin === "" ? {} : { stdin }),
  };
  return `b=${encodeSource(JSON.stringify(bundle))}`;
}

/**
 * ハッシュから共有内容を取り出す。壊れていれば undefined。
 *
 * 受け取るのは他人が作った文字列なので、形を明示的に確かめる
 * （`__proto__` のような鍵を拾わないよう、必要な項目だけを読む）。
 */
export function decodePayload(hash: string): SharePayload | undefined {
  const body = hash.replace(/^#/, "");
  if (body.startsWith("s=")) {
    const source = decodeSource(body.slice(2));
    return source === undefined ? undefined : { source };
  }
  if (!body.startsWith("b=")) return undefined;
  const json = decodeSource(body.slice(2));
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof rec[k] === "string" ? (rec[k] as string) : undefined;
  const source = str("source");
  if (source === undefined) return undefined;
  const aux = str("aux");
  const stdin = str("stdin");
  const total = source.length + (aux?.length ?? 0) + (stdin?.length ?? 0);
  if (total > MAX_SHARE_LENGTH) return undefined;
  return {
    source,
    ...(aux === undefined ? {} : { aux }),
    ...(stdin === undefined ? {} : { stdin }),
  };
}

/** 共有用の URL を組み立てる。 */
export function buildShareUrl(base: string, payload: SharePayload | string): string {
  const withoutHash = base.split("#")[0] ?? base;
  const p = typeof payload === "string" ? { source: payload } : payload;
  return `${withoutHash}#${encodePayload(p)}`;
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
  payload: SharePayload | string,
  clipboard: { writeText(text: string): Promise<void> } | undefined,
  setHash: (hash: string) => void,
): Promise<ShareOutcome> {
  const p = typeof payload === "string" ? { source: payload } : payload;
  const url = buildShareUrl(base, p);
  const hash = encodePayload(p);
  if (clipboard) {
    try {
      await clipboard.writeText(url);
      return { copied: true, url, message: m`URLをコピーしました` };
    } catch {
      // 権限が無いなどで失敗した場合もハッシュへ落とす
    }
  }
  setHash(hash);
  return {
    copied: false,
    url,
    message: m`URLを更新しました（アドレスバーからコピーしてください）`,
  };
}
