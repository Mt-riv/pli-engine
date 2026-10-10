/**
 * アセンブラのマクロ命令を読む層。
 *
 * この書式を使う定義は 3 つある。**DBDGEN / PSBGEN への入力**（`dli/`）と
 * **MFS の書式定義**（`mfs/`）で、どれも実機の規則をそのまま使う。
 *
 *   1 桁目が `*` なら注釈行
 *   1 桁目が非空白ならラベル、その後に命令、その後にオペランド
 *   オペランドの後に空白が来たら、そこから先は注釈
 *   72 桁目が非空白なら次の行へ継続し、続きは 16 桁目から
 *
 * 自由形式（行頭の空白の数は問わない）でも書けるようにしてある。
 * ブラウザで手書きするとき 10 桁目に揃えるのは苦しいため。
 */

/**
 * 定義の記述の誤り。**どのファイルの何行目かを必ず持つ。**
 *
 * DBD・PSB・MFS で派生させる（`DliDefError` / `MfsDefError`）。
 * 利用者から見れば「定義ファイルの何行目が悪い」という同じ話なので、
 * 受け取る側（`interp.ts`）は基底で捕まえられる形にしてある。
 */
export class DefError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
    name = "DefError",
  ) {
    super(`${file} ${line} 行: ${message}`);
    this.name = name;
  }
}

/** 1 つのマクロ命令。 */
export interface MacroStmt {
  /** 命令の始まる行（1 始まり）。継続した場合は先頭の行。 */
  line: number;
  label?: string;
  /** 命令の名前。大文字にそろえる。 */
  op: string;
  /** `キー=値` のオペランド。キーは大文字。値は書かれたまま。 */
  operands: Map<string, string>;
  /** `キー=` の形を取らないオペランド（`SEQ` など）。大文字にそろえる。 */
  flags: string[];
  /**
   * `キー=` の形を取らないオペランドを**書かれたまま**並べたもの。
   *
   * MFS の固定文字（`DFLD '在庫照会',POS=(1,30)`）はここから取る。
   * `flags` と同じ並びだが、大文字化していない点が違う。
   * 文字の並びを大文字に変えてしまうと画面に出る文字が変わるため、
   * 両方を持つ。
   */
  positional: string[];
  /**
   * 同じものを、**書かなかった位置を空文字で残して**並べたもの。
   *
   * アセンブラのマクロ命令はカンマを続けて位置オペランドを省ける。
   * `DO 3,,5` は「回数 3、行の増分は既定、桁の増分 5」で、
   * 空を落とすと 5 が**行の増分**に入って項目が縦に並んでしまう。
   * いっぽう `MFLD ,LTH=2`（場所取り）は空を落とす方が扱いやすいので、
   * 両方を持って使う側が選ぶ。
   */
  positionalWithHoles: string[];
}

/** 継続行の印が入る桁（1 始まり）。 */
const CONTINUE_COLUMN = 72;
/** 継続した行で中身が始まる桁（1 始まり）。 */
const CONTINUE_RESUME = 16;

/**
 * 空白で区切られた語を 1 つ取り出す。
 * 括弧とアポストロフィの中の空白は区切りにしない
 * （`ACCESS=(HDAM, OSAM)` のような書き方を許すため）。
 */
function takeWord(text: string, from: number): { word: string; next: number } {
  let i = from;
  while (i < text.length && text[i] === " ") i++;
  const start = i;
  let depth = 0;
  let quoted = false;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === " " && depth === 0) break;
  }
  return { word: text.slice(start, i), next: i };
}

/**
 * 括弧の外のカンマで区切る。
 * `NAME=(A,SEQ,U),BYTES=5` を 2 つのオペランドに分けるのに使う。
 */
export function splitTop(text: string, keepEmpty = false): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return keepEmpty ? out : out.filter((s) => s.length > 0);
}

/**
 * `キー=値` の `=` の位置を探す。括弧とアポストロフィの中は見ない。
 *
 * 見ないのは MFS の固定文字のため。`DFLD 'A=B',POS=(1,1)` の `=` を
 * 区切りと見ると、キーが `'A`、値が `B'` になる。
 * 逆に `PFK=(FLD,1='/FOR X.')` は**先頭の** `=` だけを見れば正しく割れる。
 */
function keyValueSplit(text: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === "'") quoted = false;
      continue;
    }
    if (c === "'") quoted = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "=" && depth === 0) return i;
  }
  return -1;
}

/**
 * 括弧を 1 段はがして中身を取り出す。
 * `(A,SEQ,U)` → `["A", "SEQ", "U"]`、`A` → `["A"]`。
 */
export function listOf(value: string): string[] {
  const t = value.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return [t];
  return splitTop(t.slice(1, -1)).map((s) => s.trim());
}

/** 行を継続の印でつなぎ、1 命令ずつに組み立てる。 */
function joinLines(text: string, file: string): { line: number; text: string }[] {
  const raw = text.split("\n");
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const first = raw[i]!;
    if (first.trim() === "" || first.startsWith("*")) continue;
    let body = first.slice(0, CONTINUE_COLUMN - 1).trimEnd();
    let continuing = first.length >= CONTINUE_COLUMN && first[CONTINUE_COLUMN - 1] !== " ";
    const startLine = i + 1;
    while (continuing) {
      const cont = raw[++i];
      if (cont === undefined) {
        throw new DefError("継続の印が付いていますが、続きの行がありません", file, startLine);
      }
      body += cont.slice(CONTINUE_RESUME - 1, CONTINUE_COLUMN - 1).trimEnd();
      continuing = cont.length >= CONTINUE_COLUMN && cont[CONTINUE_COLUMN - 1] !== " ";
    }
    out.push({ line: startLine, text: body });
  }
  return out;
}

/** マクロ命令の並びに分解する。 */
export function readMacros(text: string, file: string): MacroStmt[] {
  const out: MacroStmt[] = [];
  for (const { line, text: body } of joinLines(text, file)) {
    let pos = 0;
    let label: string | undefined;
    if (body[0] !== undefined && body[0] !== " ") {
      const t = takeWord(body, 0);
      label = t.word;
      pos = t.next;
    }
    const opWord = takeWord(body, pos);
    if (opWord.word === "") continue;
    const operandWord = takeWord(body, opWord.next);
    // operandWord の後ろは注釈なので読まない

    // オペランド欄がカンマで終わっているのに、空白を挟んで続きがある。
    // `takeWord` は最初の空白で切って残りを注釈として捨てるので、
    // `DFLD POS=(1,2),LTH=5, ATTR=(ALPHA,PROT)` の ATTR= が
    // **黙って消えて既定（打ち込める項目）になっていた**
    if (operandWord.word.endsWith(",") && body.slice(operandWord.next).trim() !== "") {
      throw new DefError(
        `オペランドがカンマで終わっていますが、空白を挟んで続きがあります` +
          `（${body.slice(operandWord.next).trim()}）。` +
          `カンマの後に空白を入れず続けるか、72 桁目に継続の印を付けてください`,
        file,
        line,
      );
    }

    const operands = new Map<string, string>();
    const positional: string[] = [];
    const positionalWithHoles: string[] = [];
    for (const part of splitTop(operandWord.word, true)) {
      const eq = keyValueSplit(part);
      if (eq < 0) {
        positionalWithHoles.push(part.trim());
        if (part.length > 0) positional.push(part.trim());
      } else {
        operands.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim());
      }
    }
    out.push({
      line,
      ...(label === undefined ? {} : { label }),
      op: opWord.word.toUpperCase(),
      operands,
      flags: positional.map((p) => p.toUpperCase()),
      positional,
      positionalWithHoles,
    });
  }
  return out;
}

/** オペランドを取る。無ければ誤りとして止める。 */
export function required(s: MacroStmt, key: string, file: string): string {
  const v = s.operands.get(key);
  if (v === undefined) {
    throw new DefError(`${s.op} 文に ${key}= がありません`, file, s.line);
  }
  return v;
}

/**
 * IMS の名前として受け付けられる形か。1〜8 桁の英数字と `$ # @`。
 *
 * DBD 名と PSB 名は**そのままファイル名になる**（`<名前>.dbd` /
 * `<名前>.dat`）。検査しないと、`.psb` に書いた
 * `DBDNAME=../../どこか` がそのままパスになり、データファイルが
 * 読み書き先を決めてしまう。セグメント名と項目名も、`.dat` の
 * 名前欄と SSA が 8 桁なので、9 桁以上は定義できても参照できない。
 */
const IMS_NAME = /^[A-Z0-9$#@]{1,8}$/;

/** オペランドを IMS の名前として取る。形が違えば誤りとして止める。 */
export function requiredName(s: MacroStmt, key: string, file: string): string {
  const raw = required(s, key, file);
  const name = raw.toUpperCase();
  if (!IMS_NAME.test(name)) {
    throw new DefError(
      `${s.op} 文の ${key}=${raw} は IMS の名前として使えません` +
        `（1〜8 桁の英数字と $ # @ だけ）`,
      file,
      s.line,
    );
  }
  return name;
}

export { IMS_NAME };

/** 数値のオペランドを取る。 */
export function numberOf(s: MacroStmt, key: string, file: string): number {
  const text = required(s, key, file);
  const n = Number(listOf(text)[0]);
  if (!Number.isInteger(n) || n <= 0) {
    throw new DefError(`${s.op} 文の ${key}=${text} は正の整数ではありません`, file, s.line);
  }
  return n;
}
