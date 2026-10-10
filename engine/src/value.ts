/**
 * PL/I の値表現と算術。
 *
 * 要点: FIXED DECIMAL は**10進固定小数点**として正確に扱う必要がある。
 * JS の number（2進浮動小数）で代用すると、PL/I が出すべき
 * 123.45 * 6.7 = 827.115 のような値にならない。
 * そこで値を「尺度付きの BigInt」で保持する。
 *   DECIMAL: 実際の値 = v / 10^q
 *   BINARY : 実際の値 = v / 2^q
 *
 * 精度規則は PL/I の規定どおり。
 *   加減算: p = max(p1-q1, p2-q2) + max(q1,q2) + 1, q = max(q1,q2)
 *   乗算  : p = p1+p2+1, q = q1+q2
 *   除算  : p = N, q = N - ((p1-q1) + q2)   N は最大精度
 *   混在  : BINARY と DECIMAL が混ざると BINARY に変換する
 */

/** 最大精度。PL/I では実装定義で、この処理系はこの値を使う。 */
export const MAX_DEC = 15;
export const MAX_BIN = 31;

export type Base = "bin" | "dec";

/** PICTURE の解析結果。実体は picture.ts にある。 */
export interface PictureSpec {
  source: string;
  p: number;
  q: number;
  width: number;
  integerDigits: number;
  driftSymbol?: string;
  fill: " " | "*";
  // 位置の並びは picture.ts の中だけで使う
  positions: unknown[];
}

export interface FixedVal {
  t: "fixed";
  base: Base;
  p: number;
  q: number;
  /** 尺度付きの値。実際の値は v / radix^q。 */
  v: bigint;
  /**
   * PICTURE 属性。付いていると表示のときだけ編集を通す。
   * 算術は通常の FIXED と同じで、結果にピクチャは伝わらない
   * （PL/I の規定どおり。編集は宣言した変数の表示にだけ効く）。
   */
  pic?: PictureSpec;
}

export interface FloatVal {
  t: "float";
  base: Base;
  p: number;
  v: number;
}

export interface CharVal {
  t: "char";
  v: string;
  /** 宣言長。VARYING でなければこの長さに空白詰めされる。 */
  length: number;
  varying: boolean;
}

export interface BitVal {
  t: "bit";
  v: string;
  length: number;
}

/**
 * ポインタ。
 *
 * **アドレス値ではなく、確保した記憶域そのものへの参照**を持つ。
 * 本物のアドレス空間を模すと、ポインタ算術や型の違う再解釈まで
 * 面倒を見ることになる。それはエミュレータの仕事で、
 * 学習と検証という目的に対して費用が見合わない。
 * できないことははっきり断る方が、中途半端に動いて嘘の結果を出すより良い。
 */
export interface PointerVal {
  t: "pointer";
  /** 指している記憶域。NULL なら undefined。 */
  target?: Storage;
}

/**
 * 確保した記憶域。
 * 構造体ごと確保するので、葉の修飾名からセルの並びを引く。
 */
export interface Storage {
  /** 修飾名（大文字）→ 要素の並び。 */
  cells: Map<string, Value[]>;
  /** 解放済みか。解放後に触ったら誤りとして止める。 */
  freed: boolean;
  /** どの宣言から確保したか（診断用）。 */
  group: string;
  /**
   * DL/I の PCB として処理系が用意した記憶域なら、その PCB の番号。
   *
   * PCB マスクの葉の名前はプログラムが自由に付けるので（`STAT_CODE` でも
   * `HOW_IT_WENT` でもよい）、名前では引けない。この印が付いた記憶域は
   * **葉の宣言順**で項目を結び付ける。実機が変位で重ねるのと同じ構図。
   */
  pcbIndex?: number;
}

export type Value = FixedVal | FloatVal | CharVal | BitVal | PointerVal;

export function makePointer(target?: Storage): PointerVal {
  return target === undefined ? { t: "pointer" } : { t: "pointer", target };
}

export class FixedOverflow extends Error {
  constructor(message = "FIXEDOVERFLOW") {
    super(message);
    this.name = "FixedOverflow";
  }
}

export class ZeroDivide extends Error {
  constructor(message = "ZERODIVIDE") {
    super(message);
    this.name = "ZeroDivide";
  }
}

const maxPrecision = (base: Base) => (base === "bin" ? MAX_BIN : MAX_DEC);
const radix = (base: Base) => (base === "bin" ? 2n : 10n);

export function ipow(b: bigint, e: number): bigint {
  let r = 1n;
  for (let k = 0; k < e; k++) r *= b;
  return r;
}

/** 2進精度を10進桁数に換算する。 */
export function binDigitsToDec(p: number): number {
  return Math.ceil(p * Math.log10(2)) + 1;
}

export function makeFixed(base: Base, p: number, q: number, v: bigint): FixedVal {
  return { t: "fixed", base, p, q, v };
}

/**
 * 文字値を作る。
 *
 * `length` は宣言された長さ（VARYING なら**最大**長）。
 * VARYING も最大長で切る。切らないと `dcl t char(5) varying;` に
 * 8 文字を代入したとき 8 文字のまま保持され、`LENGTH(t)` が 8 を返す。
 */
export function makeChar(v: string, length?: number, varying = false): CharVal {
  const len = length ?? v.length;
  return {
    t: "char",
    v: varying ? v.slice(0, len) : v.padEnd(len).slice(0, len),
    length: len,
    varying,
  };
}

export function makeBit(v: string, length?: number): BitVal {
  const len = length ?? v.length;
  return { t: "bit", v: v.padEnd(len, "0").slice(0, len), length: len };
}

/**
 * 算術定数のリテラルを値にする。
 * PL/I の算術定数は FIXED DECIMAL で、桁数がそのまま精度になる。
 */
export function fixedFromLiteral(text: string): FixedVal {
  const neg = text.startsWith("-");
  const body = text.replace(/^[+-]/, "");
  // 指数の部分。PL/I の指数付き定数は浮動小数点定数なので、
  // ふつうはここへ来ない（`interp.ts` が FLOAT の値にする）。
  // それでも**小数点の位置をずらして**正しく持つ。以前は
  // `BigInt(Math.trunc(Number(text)))` で整数に切っていて、
  // `2.5e-8` が 0 になり `1e400` では生の JS 例外が漏れていた
  const eAt = body.search(/[eE]/);
  const exp = eAt < 0 ? 0 : Number(body.slice(eAt + 1));
  const mant = eAt < 0 ? body : body.slice(0, eAt);
  const dot = mant.indexOf(".");
  const digits = mant.replace(".", "");
  // 精度は**書かれた桁数**（PL/I の規定）。`0.1` は 2 桁なので p=2。
  // ここを値の桁数にすると算術の精度規則が変わり、出力幅がずれる
  // （golden の mixed-radix が `0.06` の幅で固定している）
  let p = Math.max(digits.length, 1);
  let q = (dot < 0 ? 0 : mant.length - dot - 1) - exp;
  let v = BigInt(digits === "" ? "0" : digits);
  if (q < 0) {
    // 小数点が右へ出る分は整数側へ寄せる
    v *= ipow(10n, -q);
    p += -q;
    q = 0;
  } else {
    p = Math.max(p, q);
  }
  return makeFixed("dec", p, q, neg ? -v : v);
}

/**
 * FLOAT の値を FIXED DECIMAL にする。
 *
 * `fixedFromLiteral(String(v))` を通してはいけない。JavaScript は
 * `|x| < 1e-6` と `|x| >= 1e21` を指数表記で文字列化するので、
 * 以前はその経路で**桁がまるごと消えて 0 になっていた**
 * （`a = 0.001` のとき `a*a*a` の表示は `1.00000E-0009` なのに
 * 比較では 0 になり、`a*a*a > 0` が偽になった）。
 *
 * 仮数と指数を分けて、10 進の尺度付き整数として組む。
 * 10 進の最大精度（15 桁）に収まらない小さな値は 0 方向へ切り捨てる
 * （FIXED への代入と同じ向き）。呼ぶ前に `Number.isFinite` を確かめること。
 */
export function fixedFromFloat(x: number): FixedVal {
  if (x === 0) return makeFixed("dec", 1, 0, 0n);
  const [mant, expText] = x.toExponential(MAX_DEC - 1).split("e");
  const exp = Number(expText);
  const neg = mant!.startsWith("-");
  // 仮数の数字だけ（MAX_DEC 桁）。末尾の 0 は尺度を無駄に増やすので落とす
  const digits = mant!.replace(/^[+-]/, "").replace(".", "").replace(/0+$/, "") || "0";
  // digits は 10^(digits.length - 1) の位から始まる整数
  let q = digits.length - 1 - exp;
  let v = BigInt(digits);
  if (q < 0) {
    v *= ipow(10n, -q);
    q = 0;
  } else if (q > MAX_DEC) {
    // FIXED DEC(15,15) より細かい桁は持てない
    v = truncateScale(v, q - MAX_DEC);
    q = MAX_DEC;
  }
  const p = Math.max(v.toString().length, q, 1);
  return makeFixed("dec", p, q, neg ? -v : v);
}

/** 10 進で n 桁ぶん 0 方向へ切り捨てる。 */
function truncateScale(v: bigint, n: number): bigint {
  const div = ipow(10n, n);
  return v < 0n ? -(-v / div) : v / div;
}

/** 尺度を newQ に合わせる（切り捨て）。 */
function rescale(x: FixedVal, newQ: number): bigint {
  if (newQ === x.q) return x.v;
  const r = radix(x.base);
  if (newQ > x.q) return x.v * ipow(r, newQ - x.q);
  const div = ipow(r, x.q - newQ);
  // 0 方向への切り捨て
  return x.v < 0n ? -(-x.v / div) : x.v / div;
}

/**
 * DECIMAL を BINARY に変換する（混在時の規則）。
 *
 * PL/I の規定では、10 進の精度 (p,q) は 2 進の
 * (ceil(p*log2(10)) + 1, ceil(q*log2(10))) になる。
 * `log2(10) ≈ 3.32` なので、10 進 1 桁はおよそ 2 進 3.32 桁。
 *
 * **小数部を捨ててはいけない。** 以前は整数尺度（q=0）に落としていたため、
 * `dcl i fixed bin(15);` に対して `i * 1.5` が 1.5 を 1 と見て
 * 10 を返していた。`I`〜`N` の暗黙変数は FIXED BIN(15,0) なので、
 * ごく普通のコードがこの経路を通る。比較も狂って
 * `i = 10.5` が真になっていた。
 *
 * 2 進尺度に移す時点で、10 進で正確だった値が落ちることはある
 * （`0.1` は 2 進では循環小数）。これは混在そのものの性質で、
 * Linter の `mixed-base-arithmetic` が警告する理由でもある。
 */
function toBinary(x: FixedVal): FixedVal {
  if (x.base === "bin") return x;
  const scale = Math.log2(10);
  const q = Math.min(MAX_BIN, Math.ceil(x.q * scale));
  const p = Math.min(MAX_BIN, Math.max(q + 1, Math.ceil(x.p * scale) + 1));
  // v_dec / 10^x.q を 2^q 倍した整数にする。
  // 先に掛けてから割ることで、途中の桁落ちを防ぐ。
  //
  // 2 進尺度に収まらない端数は **0 方向へ切り捨てる**。
  // 実機（Iron Spring PL/I 1.4.1）で確かめた。`dcl i fixed bin(15); i = 1;` で
  //   (i*0.1)*16 → 1       四捨五入なら 2（0.1×2⁴ = 1.6）
  //   (i*0.3)*16 → 4       四捨五入なら 5（0.3×2⁴ = 4.8）
  //   (i*(-0.1))*16 → -1   床なら -2
  // 以前は四捨五入していた（誤差が小さいから、という推測）。
  const num = x.v * ipow(2n, q);
  const den = ipow(10n, x.q);
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const truncated = abs / den;
  return makeFixed("bin", p, q, neg ? -truncated : truncated);
}

/** 2項演算のために両辺の基数を揃える。 */
function unifyBase(a: FixedVal, b: FixedVal): [FixedVal, FixedVal] {
  if (a.base === b.base) return [a, b];
  return [toBinary(a), toBinary(b)];
}

/** 結果が精度に収まるか確認する。収まらなければ FIXEDOVERFLOW。 */
function checkOverflow(x: FixedVal): FixedVal {
  const intDigits = x.p - x.q;
  const limit = ipow(radix(x.base), intDigits);
  const intPart = rescale(x, 0);
  const abs = intPart < 0n ? -intPart : intPart;
  if (abs >= limit) throw new FixedOverflow();
  return x;
}

export function add(a: FixedVal, b: FixedVal): FixedVal {
  return addSub(a, b, false);
}

export function sub(a: FixedVal, b: FixedVal): FixedVal {
  return addSub(a, b, true);
}

function addSub(a0: FixedVal, b0: FixedVal, subtract: boolean): FixedVal {
  const [a, b] = unifyBase(a0, b0);
  const q = Math.max(a.q, b.q);
  const N = maxPrecision(a.base);
  const p = Math.min(N, Math.max(a.p - a.q, b.p - b.q) + q + 1);
  const va = rescale(a, q);
  const vb = rescale(b, q);
  return checkOverflow(makeFixed(a.base, p, q, subtract ? va - vb : va + vb));
}

export function mul(a0: FixedVal, b0: FixedVal): FixedVal {
  const [a, b] = unifyBase(a0, b0);
  const N = maxPrecision(a.base);
  const q = Math.min(N, a.q + b.q);
  const p = Math.min(N, a.p + b.p + 1);
  let v = a.v * b.v;
  // q を上限で切った場合は値も合わせる
  const extra = a.q + b.q - q;
  if (extra > 0) {
    const d = ipow(radix(a.base), extra);
    v = v < 0n ? -(-v / d) : v / d;
  }
  return checkOverflow(makeFixed(a.base, p, q, v));
}

export function div(a0: FixedVal, b0: FixedVal): FixedVal {
  const [a, b] = unifyBase(a0, b0);
  if (b.v === 0n) throw new ZeroDivide();
  const N = maxPrecision(a.base);
  const q = Math.max(0, Math.min(N, N - ((a.p - a.q) + b.q)));
  // a/b を尺度 q で求める: v = a.v * radix^(q + b.q - a.q) / b.v
  const shift = q + b.q - a.q;
  const r = radix(a.base);
  let num = a.v;
  let den = b.v;
  if (shift >= 0) num *= ipow(r, shift);
  else den *= ipow(r, -shift);
  const negative = (num < 0n) !== (den < 0n);
  const an = num < 0n ? -num : num;
  const ad = den < 0n ? -den : den;
  const v = an / ad;
  return checkOverflow(makeFixed(a.base, N, q, negative ? -v : v));
}

/**
 * 指数が整数で 0 以上でなければ true。
 *
 * PL/I はそのとき結果を FLOAT にする。`FixedOverflow` を投げると
 * 条件名と理由が合わなくなる（`4 ** 1.5` は桁あふれではない）。
 */
export function powNeedsFloat(b: FixedVal): boolean {
  if (b.q > 0 && rescale(b, 0) * ipow(radix(b.base), b.q) !== b.v) return true;
  return rescale(b, 0) < 0n;
}

/**
 * `x ** y`（y は 0 以上の整数）の結果が FIXED に収まるか。
 *
 * PL/I の規定では結果は FIXED(p, q) で p = (p1+1)*y - 1、q = q1*y。
 * これが最大精度を超えるなら FLOAT で計算する。
 *
 * 実機（Iron Spring PL/I 1.4.1）で境目を確かめた。最大精度が 18 の実機では
 *   2**8  → 256（FIXED、p=15）
 *   2**9  → 512（FIXED、p=17）
 *   2**10 → 1.0E+0003（**FLOAT**。p=19 で超える）
 *   2.0**3 → 8.000（p=8, q=3。繰り返し乗算と同じ精度）
 * この処理系の 10 進の最大精度は 15 なので、境目は実機より早い
 * （`2**8` までが FIXED）。最大精度の違いは README「実機と違えている点」。
 */
export function powFitsFixed(a: FixedVal, b: FixedVal): boolean {
  const e = Number(rescale(b, 0));
  if (!Number.isInteger(e) || e < 0) return false;
  if (e === 0) return true;
  const max = a.base === "bin" ? MAX_BIN : MAX_DEC;
  return (a.p + 1) * e - 1 <= max && a.q * e <= max;
}

export function pow(a: FixedVal, b: FixedVal): FixedVal {
  const e = Number(rescale(b, 0));
  if (!Number.isInteger(e) || e < 0) {
    throw new FixedOverflow("整数の指数のみ対応しています");
  }
  let acc = makeFixed(a.base, a.p, a.q, a.v);
  if (e === 0) return makeFixed(a.base, 1, 0, 1n);
  for (let k = 1; k < e; k++) acc = mul(acc, a);
  return acc;
}

export function neg(a: FixedVal): FixedVal {
  return makeFixed(a.base, a.p, a.q, -a.v);
}

/**
 * F 書式のために小数 q 桁へ丸める。**半分は 0 から遠い側へ。**
 *
 * 代入（`assignTo`）とは丸め方が違う。実機（Iron Spring PL/I 1.4.1）で
 * 両方を確かめた:
 *
 * | | 代入 `dcl y fixed dec(5,1); y = x;` | `put edit(x)(f(6,1))` |
 * |---|---|---|
 * | x = 1.26 | 1.2（切り捨て） | 1.3（丸め） |
 * | x = 1.25 | 1.2 | 1.3（0 から遠い側。偶数側ではない） |
 * | x = -1.26 | -1.2 | -1.3 |
 *
 * つまり丸めは**書式の性質**で、代入の性質ではない。同じ経路で実装すると
 * どちらかが必ず間違う。
 *
 * 桁あふれは見ない（F 書式は幅に収まらなければ右から詰めるだけで、
 * 条件は上げない。これも実機で確かめた）。
 */
export function roundForFormat(x: FixedVal, q: number): FixedVal {
  // 10 進の桁に対する丸めなので、まず 10 進へ移す
  const d = x.base === "dec" ? x : toDecimal(x);
  if (d.q === q) return d;
  if (q > d.q) {
    // 桁を増やすだけ（0 を足す）
    const p = Math.min(MAX_DEC, d.p + (q - d.q));
    return makeFixed("dec", Math.max(p, q), q, d.v * ipow(10n, q - d.q));
  }
  const den = ipow(10n, d.q - q);
  const neg = d.v < 0n;
  const abs = neg ? -d.v : d.v;
  // (abs + den/2) / den を整数演算で。half away from zero
  const rounded = (abs * 2n + den) / (den * 2n);
  const p = Math.max(1, q, d.p - (d.q - q));
  return makeFixed("dec", p, q, neg ? -rounded : rounded);
}

/** 宣言された型へ代入する（尺度を合わせ、桁が溢れたらエラー）。 */
export function assignTo(x: FixedVal, base: Base, p: number, q: number): FixedVal {
  const src = x.base === base ? x : base === "bin" ? toBinary(x) : toDecimal(x);
  const v = rescale(src, q);
  return checkOverflow(makeFixed(base, p, q, v));
}

/** BINARY を DECIMAL に変換する。 */
function toDecimal(x: FixedVal): FixedVal {
  if (x.base === "dec") return x;
  // 2進尺度を10進尺度に移す。d = ceil(q * log10 2) 桁を保つ。
  const d = x.q === 0 ? 0 : Math.ceil(x.q * Math.log10(2));
  const num = x.v * ipow(10n, d);
  const den = ipow(2n, x.q);
  const negative = num < 0n;
  const an = negative ? -num : num;
  const v = an / den;
  const p = Math.min(MAX_DEC, binDigitsToDec(x.p));
  return makeFixed("dec", p, d, negative ? -v : v);
}

/** 値を10進の文字列にする（符号と小数点付き、余分な空白なし）。 */
export function render(x: Value): string {
  switch (x.t) {
    case "pointer":
      // ポインタはアドレス値を持たないので、有無だけを示す
      return x.target === undefined ? "NULL" : "POINTER";
    case "char":
      return x.v;
    case "bit":
      return x.v;
    case "float": {
      // FLOAT DEC(p) は仮数 p 桁 + 4桁指数（' 3.50000E+0000' の形）
      const digits = Math.max(1, x.p - 1);
      const s = x.v.toExponential(digits);
      const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
      if (!m) return s;
      return `${m[1]}E${m[2]}${m[3]!.padStart(4, "0")}`;
    }
    case "fixed": {
      const d = x.base === "bin" ? toDecimal(x) : x;
      const negative = d.v < 0n;
      const abs = (negative ? -d.v : d.v).toString();
      let out: string;
      if (d.q <= 0) {
        out = abs;
      } else {
        const padded = abs.padStart(d.q + 1, "0");
        const cut = padded.length - d.q;
        out = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
      }
      return negative ? `-${out}` : out;
    }
  }
}

/** 比較。a<b なら負、等しければ 0、a>b なら正。 */
export function compare(a: FixedVal, b: FixedVal): number {
  const [x, y] = unifyBase(a, b);
  const q = Math.max(x.q, y.q);
  const vx = rescale(x, q);
  const vy = rescale(y, q);
  return vx < vy ? -1 : vx > vy ? 1 : 0;
}

/**
 * 数値を文字データに変換する。
 * PL/I は数値を文字へ暗黙変換するとき、出力フィールド幅に右詰めした
 * 文字列を作る。hanoi.pli の `'move' || f` がこれに依存している。
 */
export function toCharString(x: FixedVal): string {
  const width =
    x.base === "bin" ? binDigitsToDec(x.p) + 3 : x.p + 3;
  return render(x).padStart(width);
}
