/**
 * 利用者に見せる文字列の多言語化。
 *
 * **日本語の文そのものを鍵にする。** `m` はタグ付きテンプレートで、
 * 差し込みのところを `{0}` に置き換えた文を鍵として表を引く。
 *
 *     throw new RuntimeError(m`PSB 名 ${name} は IMS の名前として使えません`, line);
 *     // 鍵: "PSB 名 {0} は IMS の名前として使えません"
 *
 * 鍵を別に考えない理由は 2 つある。呼び出し側に日本語が見えたまま残るので
 * 読んで分かること、そして **locale が ja のとき `m` は素の文字列連結と
 * 完全に同じものを返す**ので、既存の出力が 1 文字も変わらないこと。
 * 包み間違えれば日本語の出力が変わり、テストが落ちて気づける。
 *
 * 訳が無い鍵は黙って日本語のまま出す。訳し忘れで文字列が消えたり
 * `undefined` が出たりするより、日本語が出る方がましなので。
 * 訳し忘れそのものは `test/i18n.test.ts` が TypeScript の構文木から
 * 鍵を全部集めて表と突き合わせ、取りこぼしを落とす。
 */

import { EN } from "./en.js";

export type Locale = "ja" | "en";

/** 対応している言語。最初のものが既定。 */
export const LOCALES = ["ja", "en"] as const;

export const DEFAULT_LOCALE: Locale = "ja";

/** 鍵（`{0}` を含む日本語の文）から訳への表。 */
export type Catalog = Record<string, string>;

/**
 * 言語ごとの表。ja は原文そのものなので持たない。
 *
 * `engine/` の中の文字列はすべて `en.ts` に入っている。
 * VSCode 拡張のように別のところで定義した文字列は
 * `addCatalog` で足す。
 */
const catalogs = new Map<Locale, Catalog>([["en", { ...EN }]]);

let current: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
}

/**
 * `locale` の間だけ切り替えて `fn` を走らせる。
 *
 * `locale` が undefined のときは今のまま走らせる（呼び出し側で
 * 分岐を書かなくて済むように）。
 */
export function withLocale<T>(locale: Locale | undefined, fn: () => T): T {
  if (locale === undefined || locale === current) return fn();
  const before = current;
  current = locale;
  try {
    return fn();
  } finally {
    current = before;
  }
}

/** 表を足す（同じ鍵があれば後から足した方が勝つ）。 */
export function addCatalog(locale: Locale, entries: Catalog): void {
  const found = catalogs.get(locale);
  if (found === undefined) catalogs.set(locale, { ...entries });
  else Object.assign(found, entries);
}

/** いま使っている言語の表。無ければ undefined（＝原文のまま）。 */
function catalog(): Catalog | undefined {
  return current === DEFAULT_LOCALE ? undefined : catalogs.get(current);
}

/** タグ付きテンプレートの固定部分から鍵を作る。 */
export function keyOf(parts: readonly string[]): string {
  let key = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) key += `{${i - 1}}${parts[i] ?? ""}`;
  return key;
}

/** 鍵の `{0}` を差し込みの値で埋める。 */
function fill(text: string, args: readonly unknown[]): string {
  return text.replace(/\{(\d+)\}/g, (whole, n: string) => {
    const arg = args[Number(n)];
    return arg === undefined ? whole : String(arg);
  });
}

/** 固定部分と差し込みをそのままつなぐ（＝日本語の出力）。 */
function plain(parts: readonly string[], args: readonly unknown[]): string {
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) out += `${String(args[i - 1])}${parts[i] ?? ""}`;
  return out;
}

/**
 * 利用者に見せる文字列。
 *
 *     m`${name} は BASED で宣言されていません`
 */
export function m(parts: TemplateStringsArray, ...args: unknown[]): string {
  const table = catalog();
  if (table === undefined) return plain(parts, args);
  const found = table[keyOf(parts)];
  return found === undefined ? plain(parts, args) : fill(found, args);
}

/**
 * 日本語を鍵として印を付けるだけ（返す値は引数そのまま）。
 *
 * モジュールの直下に置く表は import のときに 1 度だけ評価されるので、
 * そこで `m` を呼ぶと**その時点の言語**で固まってしまう。表には
 * `msg("…")` で日本語を入れておき、使うところで `tr` に通す。
 *
 *     const UNIMPL = { KEYED: msg("索引ファイル") };
 *     throw new ParseError(m`${kw} は未実装です（${tr(UNIMPL[kw])}）`, line);
 */
export function msg(text: string): string {
  return text;
}

/** `msg` で印を付けた日本語を、いまの言語に訳す。 */
export function tr(text: string, ...args: unknown[]): string {
  const table = catalog();
  const found = table?.[text];
  return fill(found ?? text, args);
}

/**
 * `ja` / `ja-JP` / `en-US` のような言語タグを locale にする。
 *
 * 分からないものは undefined を返す（呼び出し側が既定を決める）。
 */
export function normalizeLocale(tag: string | undefined): Locale | undefined {
  if (tag === undefined) return undefined;
  const head = tag.trim().toLowerCase().split(/[-_.]/)[0];
  return LOCALES.find((l) => l === head);
}
