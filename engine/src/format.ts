/**
 * PUT LIST の出力書式。
 *
 * 規則は実在の PL/I 処理系の出力と突き合わせて確かめたもので、
 * 推測ではない。
 *
 *   - FIXED DEC(p,q) のフィールド幅 = p + 3
 *       DEC(5,2) 123.45  -> "  123.45 "     (幅8 + 空白1)
 *       DEC(3,1) 6.7     -> "   6.7 "       (幅6 + 空白1)
 *       DEC(9,3) 827.115 -> "     827.115 " (幅12 + 空白1)
 *   - FIXED BIN(p,q) は10進に換算してから同じ規則を使う
 *       10進桁 d = ceil(p * log10(2)) + 1、幅 = d + 3
 *       BIN(31) -> d=11, 幅14 / BIN(15) -> d=6, 幅9
 *   - 項目は24桁ごとのタブストップに配置する
 *   - 行幅(LINESIZE)は120。次の項目が収まらなければ現在行を120桁まで
 *     空白で埋めて改行する
 *   - 各項目の直後に空白1個
 *
 * 九九の出力が1行目120桁(5項目)・2行目87桁(=3*24+14+1, 4項目)になることで
 * タブストップ24桁と行幅120が裏付けられる。
 */

/** 引用符で囲む。中の引用符は 2 つにする（PL/I の文字定数と同じ）。 */
function quoted(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** PUT LIST のタブストップ間隔。 */
export const TAB_STOP = 24;
/** PRINT ファイルの既定行幅。 */
export const LINE_SIZE = 120;
/** PRINT ファイルの既定ページ長（行数）。 */
export const PAGE_SIZE = 60;

export interface WriterOptions {
  /** 行幅。LINESIZE 指定で変わる。 */
  lineSize?: number;
  /**
   * PRINT ファイルか。
   * PRINT なら 24 桁のタブストップと改ページを使う。
   * PRINT でないストリーム出力は、項目を空白 1 個で区切って並べるだけ。
   */
  print?: boolean;
  /** ページ長（行数）。PRINT ファイルでのみ意味を持つ。 */
  pageSize?: number;
}

/** FIXED DECIMAL(p,q) の出力フィールド幅。 */
export function fixedDecWidth(p: number): number {
  return p + 3;
}

/**
 * FIXED BINARY(p,q) の出力フィールド幅。
 * 2進精度を10進桁に換算して DECIMAL と同じ規則を使う。
 */
export function fixedBinWidth(p: number): number {
  const decimalDigits = Math.ceil(p * Math.log10(2)) + 1;
  return fixedDecWidth(decimalDigits);
}

/**
 * PUT LIST の出力を組み立てる。
 * 行・桁の状態を持ち、タブストップと行幅の折り返しを扱う。
 */
export class ListWriter {
  private lines: string[] = [];
  /** 現在行の内容。 */
  private cur = "";
  private readonly lineSize: number;
  private readonly print: boolean;
  private readonly pageSize: number;
  /**
   * 今のページに書いた行数。`LINENO` 組込関数と `LINE(n)` が使う。
   * （`ENDPAGE` 条件はこの処理系では起こさない。`engine/README.md` 参照）
   */
  private linesOnPage = 0;
  /**
   * 確定済みの行の合計文字数（改行を含む）。
   * `length()` を O(1) にするために持つ。行数で数え直すと
   * PUT のたびに全行を走るので、出力が増えるほど二次で遅くなる。
   */
  private flushed = 0;
  /**
   * `SKIP(0)` で行頭へ戻ったか（PRINT ファイル。規定 p.303）。
   * 次の書き込みは現在行を**上書き**する。
   */
  private rewound = false;

  constructor(opts: WriterOptions = {}) {
    this.lineSize = opts.lineSize ?? LINE_SIZE;
    this.print = opts.print ?? true;
    this.pageSize = opts.pageSize ?? PAGE_SIZE;
  }

  /** 現在の桁位置（1 始まり）。 */
  private get col(): number {
    return this.cur.length + 1;
  }

  /**
   * 書きかけの行を確定して改行する。
   * 行を `lines` に積む経路はすべてここを通す（`page()` を除く）。
   * 直接 push すると `flushed` の加算を忘れて出力上限が効かなくなる。
   */
  private flush(): void {
    this.lines.push(this.cur);
    this.flushed += this.cur.length + 1;
    this.cur = "";
    this.linesOnPage++;
  }

  /** 現在の行番号（1 始まり、ページ内）。LINENO 組込関数が返す値。 */
  lineNumber(): number {
    return this.linesOnPage + 1;
  }

  /**
   * SKIP: n 行進める。
   *
   * ページの行数を超えたら**改ページする**。ENDPAGE 条件の暗黙動作が
   * 暗黙動作は改ページ（規定 p.409-410）なので、条件を起こさない
   * この処理系でも改ページそのものは行う必要がある
   * （`PAGESIZE` を書いた帳票が、見た目だけ静かに違う出力になる）。
   *
   * `n <= 0` は PRINT ファイルでは**現在行の先頭へ戻る**（規定 p.303）。
   * PRINT でないファイルでは 1 行進める。
   */
  skip(n = 1): void {
    if (n <= 0) {
      if (this.print) {
        // 現在行の先頭へ戻る。次の書き込みが上書きになる
        this.rewound = true;
        return;
      }
      this.flush();
      return;
    }
    for (let k = 0; k < n; k++) {
      this.flush();
      if (this.print && this.linesOnPage >= this.pageSize) this.page();
    }
  }

  /**
   * PAGE: 改ページする。
   * 文字としては改ページ文字（0x0C）を書く。
   */
  page(): void {
    if (this.cur !== "") this.skip();
    this.lines.push("\f");
    this.flushed += 2;
    this.linesOnPage = 0;
  }

  /**
   * 文字データ。左詰めで、後ろに空白1個。
   *
   * PRINT でないストリーム出力では**引用符で囲む**
   * （規定 p.316。`GET LIST` で読み戻せる形にするため）。
   * 囲むのは**文字列だけ**で、算術値には付かない（p.315
   * 算術値は文字へ変換して出す）。
   */
  putChar(s: string): void {
    this.place(this.print ? s : quoted(s));
  }

  /** ビットデータ。'0101'B の形で出力する。 */
  putBit(bits: string): void {
    this.place(`'${bits}'B`);
  }

  /**
   * 数値データ。幅 width に右詰めする。
   * PRINT でないファイルでも**引用符を付けない**（規定 p.315）。
   * 付けると、他のプログラムが読む前提のファイルが規定と違う形になる。
   */
  putNumber(rendered: string, width: number): void {
    this.place(rendered.padStart(width));
  }

  /**
   * 項目を配置する。
   * 行頭でなければ次のタブストップまで送り、収まらなければ折り返す。
   */
  private place(item: string): void {
    if (this.takeRewound(item)) return;
    if (!this.print) {
      // PRINT でないストリーム出力は桁揃えをしない。
      // 項目を空白 1 個で区切り、行幅で折り返すだけ。
      if (this.col > 1 && this.cur.length + item.length + 1 > this.lineSize) {
        this.flush();
      }
      // 項目の前に区切りの空白 1 個、後ろにも空白 1 個を置く
      // （`'x'  'y' ` のように間が 2 個に見える）
      if (this.col > 1) this.cur += " ";
      this.cur += item + " ";
      return;
    }
    if (this.col > 1) {
      // 次のタブストップへ送る
      const nextStop = Math.ceil((this.col - 1) / TAB_STOP) * TAB_STOP + 1;
      const target = nextStop === this.col ? this.col : nextStop;
      if (target - 1 + item.length > this.lineSize) {
        // 収まらないので現在行を行幅まで埋めて改行する
        this.cur = this.cur.padEnd(this.lineSize);
        this.flush();
      } else {
        this.cur = this.cur.padEnd(target - 1);
      }
    }
    this.cur += item + " ";
  }

  // ---- EDIT 用の出力 ----
  //
  // EDIT は LIST と違い 24桁タブストップを使わず、書式項目の指定どおりの
  // 位置・幅に書く。末尾に空白も足さない。
  // 同じ行・桁の状態を LIST と共有するため同じクラスに持たせる。

  /** A 書式。幅を省略するとデータ長のまま、指定すると左詰めで固定幅。 */
  editChar(s: string, width?: number): void {
    this.raw(width === undefined ? s : s.padEnd(width).slice(0, width));
  }

  /** F / E 書式。幅 width に右詰めする。 */
  editNumber(rendered: string, width: number): void {
    this.raw(rendered.padStart(width).slice(-width));
  }

  /** B 書式。ビット列を左詰めで置く。 */
  editBit(bits: string, width?: number): void {
    this.editChar(bits, width);
  }

  /** X 書式。空白を n 個置く。 */
  editX(n: number): void {
    this.raw(" ".repeat(Math.max(0, n)));
  }

  /**
   * COLUMN 書式。指定の桁まで空白で送る。
   * 現在位置がその桁を過ぎていれば改行してから送る。
   */
  column(at: number): void {
    // 行幅を超えた桁と 1 未満の桁は桁 1 として扱う（規定 p.321
    // 指定の桁が現在行の右端を超えるか 1 未満なら、既定の桁 1 として扱う）。超えたまま埋めると行幅を超えた行ができる
    const target = at < 1 || at > this.lineSize ? 1 : at;
    if (this.col > target) this.skip();
    this.cur = this.cur.padEnd(target - 1);
  }

  /**
   * 行の折り返しを見て追記する。
   *
   * 行幅を超えた分は**次の行へ送る**（規定 p.317。行幅を超えて書こうとした分は次の行へ送られる）。項目ごと次行へ送ると桁位置が静かにずれ、しかも
   * 行幅を超えた行がそのまま出る。
   */
  private raw(s: string): void {
    if (this.takeRewound(s)) return;
    let rest = s;
    while (this.cur.length + rest.length > this.lineSize) {
      const room = this.lineSize - this.cur.length;
      if (room > 0) {
        this.cur += rest.slice(0, room);
        rest = rest.slice(room);
      }
      this.flush();
    }
    this.cur += rest;
  }

  /**
   * 出力を終端する。
   * プログラム終了時に最終行を改行で終端するため、
   * 書きかけの行があれば改行して閉じる。
   */
  finish(): void {
    if (this.cur !== "") this.flush();
  }

  /**
   * `SKIP(0)` の直後の書き込みを、現在行の先頭への上書きにする。
   * 上書きしたら true。
   */
  private takeRewound(s: string): boolean {
    if (!this.rewound) return false;
    this.rewound = false;
    this.cur = s + this.cur.slice(s.length);
    return true;
  }

  /** これまでに書いた文字数。出力上限の判定に使う。 */
  length(): number {
    return this.flushed + this.cur.length;
  }

  /** 組み立てた全文。 */
  text(): string {
    if (this.lines.length === 0 && this.cur === "") return "";
    // spread を使うと、行数が多いときに `RangeError: Invalid array length`
    // が出る。`runProgram` は「例外を投げず必ず結果オブジェクトを返す」と
    // 約束しているので、ここで落ちてはいけない
    if (this.lines.length === 0) return this.cur;
    return `${this.lines.join("\n")}\n${this.cur}`;
  }
}
