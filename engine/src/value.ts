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

function ipow(b: bigint, e: number): bigint {
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

export function makeChar(v: string, length?: number, varying = false): CharVal {
  const len = length ?? v.length;
  return { t: "char", v: varying ? v : v.padEnd(len).slice(0, len), length: len, varying };
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
  if (/[eE]/.test(text)) {
    // 指数表記は FLOAT として扱う
    return makeFixed("dec", MAX_DEC, 0, BigInt(Math.trunc(Number(text))));
  }
  const neg = text.startsWith("-");
  const body = text.replace(/^[+-]/, "");
  const dot = body.indexOf(".");
  const digits = body.replace(".", "");
  const q = dot < 0 ? 0 : body.length - dot - 1;
  const p = Math.max(digits.length, 1);
  const v = BigInt(digits === "" ? "0" : digits);
  return makeFixed("dec", p, q, neg ? -v : v);
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

/** DECIMAL を BINARY に変換する（混在時の規則）。 */
function toBinary(x: FixedVal): FixedVal {
  if (x.base === "bin") return x;
  // 整数尺度に落としてから2進精度へ移す。
  // 整数（q=0）の場合を正確に扱う。
  const intPart = rescale(x, 0);
  const p = Math.min(MAX_BIN, Math.max(1, Math.ceil((x.p - x.q) * Math.log2(10))));
  return makeFixed("bin", p, 0, intPart);
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
