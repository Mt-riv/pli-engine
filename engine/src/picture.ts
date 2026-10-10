/**
 * PICTURE 属性（数値編集）。
 *
 * `DCL AMT PIC'$$$,$$9V.99';` のように、桁揃え・ゼロ抑制・通貨記号・符号を
 * 宣言で書く PL/I の中心的な機能。値は内部では 10 進固定小数点として持ち、
 * 表示のときだけこの編集を通す。
 *
 * 扱う文字:
 *   9      数字（ゼロも表示する）
 *   V      小数点の位置（文字は出ない）
 *   Z      ゼロ抑制（先行ゼロを空白にする）
 *   *      ゼロ抑制（先行ゼロを * にする）
 *   Y      ゼロなら空白にする桁
 *   $ + - S  通貨記号と符号。2 個以上続けると「浮動」する
 *   . , / B  挿入文字（抑制された範囲では詰め文字に変わる）
 *   CR DB  末尾に付ける。負のときだけ出る
 *
 * 扱わないもの（宣言時に誤りとして報告する）:
 *   E K    浮動小数点のピクチャ
 *   A X    文字・混在のピクチャ（数値編集ではない）
 *   T I R  符号を数字に重ねる表現（オーバーパンチ）
 *   G M    図形文字
 */

import { MAX_DEC, type FixedVal, type PictureSpec as PictureSpecBase } from "./value.js";

export class PictureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PictureError";
  }
}

/** 値がピクチャの桁に収まらない。PL/I の SIZE 条件になる。 */
export class PictureSizeError extends Error {
  constructor(readonly picture: string) {
    super(`SIZE`);
    this.name = "PictureSizeError";
  }
}

/** 出力の 1 文字分。 */
type PicPos =
  /** 数字を置く位置。suppress は先行ゼロの扱い。 */
  | { kind: "digit"; suppress: "none" | "blank" | "star" | "drift" }
  /** 浮動記号の先頭（記号だけを置く位置）。 */
  | { kind: "driftHead"; symbol: string }
  /** 固定の符号・通貨記号。 */
  | { kind: "static"; symbol: string; signed: boolean }
  /** 挿入文字。抑制された範囲では詰め文字になる。 */
  | { kind: "insert"; ch: string }
  /** CR / DB。負のときだけ出る。 */
  | { kind: "suffix"; text: string };

export interface PictureSpec extends PictureSpecBase {
  positions: PicPos[];
}

const DRIFTABLE = new Set(["$", "+", "-", "S"]);
const INSERTION = new Set([".", ",", "/", "B"]);

/**
 * ピクチャ文字列を解析する。
 *
 * 浮動記号の列（`$$$` など）は「記号 1 個分 + 数字 (n-1) 桁」として扱う。
 * これは PL/I の規定どおりで、`$$$9` は 3 桁の数を表す。
 */
export function parsePicture(source: string): PictureSpec {
  const src = source.toUpperCase();
  const positions: PicPos[] = [];
  let p = 0;
  let q = 0;
  let seenV = false;
  /**
   * ピクチャに `V` があるか。
   *
   * `V` が無ければ最初の `.` を小数点の位置として扱う。
   * これを見ないと `ZZ9.99` が p=5 / q=0 と解釈され、
   * 12.34 が 12 に切られて桁がずれる。
   */
  const hasV = src.includes("V");
  let integerDigits = 0;
  let driftSymbol: string | undefined;
  let fill: " " | "*" = " ";

  let i = 0;
  const countDigit = () => {
    p++;
    if (seenV) q++;
    else integerDigits++;
  };

  while (i < src.length) {
    const c = src[i]!;

    // CR / DB は末尾の 2 文字
    if ((c === "C" && src[i + 1] === "R") || (c === "D" && src[i + 1] === "B")) {
      positions.push({ kind: "suffix", text: src.slice(i, i + 2) });
      i += 2;
      continue;
    }

    if (c === "V") {
      if (seenV) throw new PictureError("PICTURE に V は 1 つだけです");
      seenV = true;
      i++;
      continue;
    }

    if (c === "9") {
      positions.push({ kind: "digit", suppress: "none" });
      countDigit();
      i++;
      continue;
    }

    if (c === "Y") {
      // ゼロなら空白にする桁。抑制と同じ扱いで足りる
      positions.push({ kind: "digit", suppress: "blank" });
      countDigit();
      i++;
      continue;
    }

    if (c === "Z" || c === "*") {
      if (seenV) {
        // 小数部のゼロ抑制は値全体がゼロのときだけ効く。
        // 桁としては通常の数字と同じに扱う
        positions.push({ kind: "digit", suppress: c === "Z" ? "blank" : "star" });
      } else {
        positions.push({ kind: "digit", suppress: c === "Z" ? "blank" : "star" });
      }
      if (c === "*") fill = "*";
      countDigit();
      i++;
      continue;
    }

    if (DRIFTABLE.has(c)) {
      // 浮動記号の列。`$$$,$$9` のように挿入文字を挟んでも 1 つの列とみなす
      // （PL/I の規定。カンマは列の一部）
      const run: ("symbol" | string)[] = [];
      let j = i;
      while (j < src.length) {
        if (src[j] === c) {
          run.push("symbol");
          j++;
          continue;
        }
        // 挿入文字のあとに同じ記号が続くなら、列の中の挿入文字
        if (INSERTION.has(src[j]!)) {
          let k = j;
          while (k < src.length && INSERTION.has(src[k]!)) k++;
          if (src[k] === c) {
            for (let m = j; m < k; m++) run.push(src[m]!);
            j = k;
            continue;
          }
        }
        break;
      }
      const symbolCount = run.filter((x) => x === "symbol").length;

      if (symbolCount === 1) {
        positions.push({ kind: "static", symbol: c, signed: c !== "$" });
        i++;
        continue;
      }
      if (driftSymbol !== undefined) {
        throw new PictureError("PICTURE の浮動記号は 1 種類だけです");
      }
      driftSymbol = c;
      let seenSymbol = 0;
      for (const item of run) {
        if (item === "symbol") {
          seenSymbol++;
          if (seenSymbol === 1) {
            positions.push({ kind: "driftHead", symbol: c });
          } else {
            positions.push({ kind: "digit", suppress: "drift" });
            countDigit();
          }
        } else {
          positions.push({ kind: "insert", ch: item === "B" ? " " : item });
        }
      }
      i = j;
      continue;
    }

    if (INSERTION.has(c)) {
      // `.` は小数点としても働く（`PIC'ZZ9.99'`）。
      // 文字として出しつつ、以降の数字は小数部として数える。
      //
      // 以前は挿入文字としてしか扱っていなかったため、
      // `ZZ9.99` が p=5 / q=0 と解釈され、12.34 が 12 に切られて
      // 桁がずれていた（`ZZ9V.99` と書いたときだけ正しく動いていた）。
      // `V` が無いピクチャでは、最初の `.` が小数点の位置も表す。
      // `ZZ9V.99` のように `V` を併記した形では、尺度は `V` が決めるので
      // `.` は文字を出すだけ（これが実機の標準の書き方）。
      if (c === "." && !hasV && !seenV) seenV = true;
      positions.push({ kind: "insert", ch: c === "B" ? " " : c });
      i++;
      continue;
    }

    throw new PictureError(
      `PICTURE に使えない文字です: ${JSON.stringify(src[i])}（この処理系は数値編集のみ対応）`,
    );
  }

  if (p === 0) throw new PictureError("PICTURE に数字の位置がありません");
  if (p > MAX_DEC) throw new PictureError(`PICTURE の桁数が多すぎます（上限 ${MAX_DEC}）`);

  return {
    source,
    p,
    q,
    width: positions.reduce((n, x) => n + (x.kind === "suffix" ? x.text.length : 1), 0),
    positions,
    integerDigits,
    ...(driftSymbol === undefined ? {} : { driftSymbol }),
    fill,
  };
}

/** 値をピクチャの桁数に合わせた数字列にする。符号は含まない。 */
function digitsOf(spec: PictureSpec, value: FixedVal): string {
  const neg = value.v < 0n;
  let v = neg ? -value.v : value.v;

  // 尺度をピクチャの小数桁に合わせる
  if (value.q > spec.q) {
    const drop = 10n ** BigInt(value.q - spec.q);
    v = v / drop; // 切り捨て。PL/I の代入も切り捨て
  } else if (value.q < spec.q) {
    v = v * 10n ** BigInt(spec.q - value.q);
  }

  const s = v.toString();
  if (s.length > spec.p) throw new PictureSizeError(spec.source);
  return s.padStart(spec.p, "0");
}

/**
 * 値をピクチャに従って編集した文字列にする。
 *
 * 抑制の考え方: 整数部の最初の有効数字より前にある「抑制できる位置」を
 * 詰め文字に置き換える。挿入文字（`,` など）もその範囲なら詰め文字になる。
 * 浮動記号は、抑制された最後の位置に置く。
 */
export function editPicture(spec: PictureSpec, value: FixedVal): string {
  const digits = digitsOf(spec, value);
  const negative = value.v < 0n;

  // 各位置に数字を割り当てる
  const out: (string | null)[] = [];
  let di = 0;
  let firstSignificant = -1; // 有効数字が現れた最初の位置
  let lastIntegerDigitPos = -1;
  let digitIndexAt: number[] = [];

  spec.positions.forEach((pos, idx) => {
    if (pos.kind !== "digit") {
      out.push(null);
      digitIndexAt.push(-1);
      return;
    }
    const d = digits[di]!;
    const isInteger = di < spec.integerDigits;
    if (isInteger) lastIntegerDigitPos = idx;
    if (firstSignificant < 0 && d !== "0" && isInteger) firstSignificant = idx;
    out.push(d);
    digitIndexAt.push(di);
    di++;
  });

  // 整数部が全部ゼロなら、最後の整数桁までを抑制の対象にする
  const suppressUntil =
    firstSignificant >= 0 ? firstSignificant : lastIntegerDigitPos + 1;

  // 抑制できない桁（9）があればそこで抑制を打ち切る
  let effectiveUntil = 0;
  for (let idx = 0; idx < suppressUntil; idx++) {
    const pos = spec.positions[idx]!;
    if (pos.kind === "digit" && pos.suppress === "none") break;
    effectiveUntil = idx + 1;
  }

  const text: string[] = [];
  let driftPlaced = false;
  // 浮動記号を置く位置: 抑制された範囲の最後
  const driftAt = effectiveUntil - 1;

  spec.positions.forEach((pos, idx) => {
    const suppressed = idx < effectiveUntil;
    switch (pos.kind) {
      case "digit": {
        if (suppressed && pos.suppress !== "none") {
          text.push(idx === driftAt && spec.driftSymbol ? driftChar(spec, negative) : spec.fill);
          if (idx === driftAt && spec.driftSymbol) driftPlaced = true;
        } else {
          text.push(out[idx] ?? "0");
        }
        return;
      }
      case "driftHead": {
        if (idx === driftAt || effectiveUntil === 0) {
          text.push(driftChar(spec, negative));
          driftPlaced = true;
        } else {
          text.push(suppressed ? spec.fill : driftChar(spec, negative));
          if (!suppressed) driftPlaced = true;
        }
        return;
      }
      case "static":
        text.push(staticChar(pos.symbol, pos.signed, negative));
        return;
      case "insert":
        if (idx === driftAt && spec.driftSymbol !== undefined) {
          // 抑制された範囲の最後が挿入文字（`$$$,$$9` のカンマなど）なら
          // そこが記号の位置になる
          text.push(driftChar(spec, negative));
          driftPlaced = true;
          return;
        }
        text.push(suppressed ? spec.fill : pos.ch);
        return;
      case "suffix":
        text.push(negative ? pos.text : " ".repeat(pos.text.length));
        return;
    }
  });

  // 浮動記号が置かれていない（全桁が有効）場合は先頭に寄せる
  if (spec.driftSymbol !== undefined && !driftPlaced) {
    const head = spec.positions.findIndex((x) => x.kind === "driftHead");
    if (head >= 0) text[head] = driftChar(spec, negative);
  }

  return text.join("");
}

function driftChar(spec: PictureSpec, negative: boolean): string {
  const sym = spec.driftSymbol ?? " ";
  return staticChar(sym, sym !== "$", negative);
}

function staticChar(symbol: string, signed: boolean, negative: boolean): string {
  if (!signed) return symbol; // $ はそのまま
  switch (symbol) {
    case "S":
      return negative ? "-" : "+";
    case "+":
      return negative ? " " : "+";
    case "-":
      return negative ? "-" : " ";
    default:
      return symbol;
  }
}

/**
 * 編集された文字列から数値の文字列表現に戻す（GET で読むときに使う）。
 * 編集文字を取り除き、CR / DB と符号を解釈する。
 */
export function uneditPicture(text: string, spec: PictureSpec): string {
  const upper = text.toUpperCase();
  const negative =
    upper.includes("CR") || upper.includes("DB") || upper.includes("-");
  const digits = upper.replace(/[^0-9]/g, "");
  if (digits === "") return "0";
  const intPart = digits.slice(0, Math.max(0, digits.length - spec.q));
  const frac = spec.q === 0 ? "" : digits.slice(digits.length - spec.q).padStart(spec.q, "0");
  const body = `${intPart === "" ? "0" : intPart}${spec.q === 0 ? "" : "." + frac}`;
  return negative ? `-${body}` : body;
}
