/**
 * MFS の書式定義を読む。
 *
 * 書式はアセンブラのマクロ命令（`../macro.ts`）。実機の MFS Language
 * Utility は 2 段構えで中間ブロックを作るが、ここは 1 回で制御ブロックに
 * する。ただし **MID / MOD / DIF / DOF という区別は残す**（誤りの文面と
 * 文書が実機と噛み合わなくなるため）。
 *
 * 引き受けないものは**名指しで断る**。黙って既定値に落とすと、
 * 書いたとおりに動いていないことに気づけない。
 */

import { IMS_NAME, listOf, readMacros, type MacroStmt } from "../macro.js";
import { validateLayout } from "./device.js";
import {
  DEFAULT_ATTR,
  FILL_BLANK,
  MfsDefError,
  MfsLibrary,
  NO_DSCA,
  type Attr,
  type DeviceFormat,
  type Dfld,
  type Dpage,
  type Dsca,
  type Eattr,
  type Fill,
  type Lpage,
  type MessageDesc,
  type Mfld,
  type MfldSource,
  type MsgSeg,
  type Pfk,
  type SystemLiteral,
} from "./blocks.js";

/** 一覧や表示に使わない、注記のための命令。読み飛ばす。 */
const LISTING_OPS = new Set(["PRINT", "EJECT", "SPACE", "TITLE", "END"]);

/**
 * 画面の大きさ。`3270-An` の `n` は 3278 の型番に対応する。
 * ここに無い装置は断る（大きさを当てずっぽうで決めると画面がずれる）。
 */
const SCREEN_SIZE = new Map<string, { rows: number; cols: number }>([
  ["3270-A1", { rows: 12, cols: 40 }],
  ["3270-A2", { rows: 24, cols: 80 }],
  ["3270-A3", { rows: 32, cols: 80 }],
  ["3270-A4", { rows: 43, cols: 80 }],
  ["3270,1", { rows: 12, cols: 40 }],
  ["3270,2", { rows: 24, cols: 80 }],
  ["3270", { rows: 24, cols: 80 }],
]);

/** `EATTR=` で受け付ける色。 */
const COLORS = new Set(["BLUE", "RED", "PINK", "GREEN", "TURQ", "YELLOW", "NEUTRAL", "DEFAULT"]);
/** `EATTR=` で受け付ける強調。 */
const HIGHLIGHTS = new Set(["HD", "HBLINK", "HREV", "HUL"]);

/** 出力に使えるシステム定数と、その長さ。 */
const SYSTEM_LITERALS = new Map<SystemLiteral, number>([
  ["DATE1", 6],
  ["DATE2", 8],
  ["DATE3", 8],
  ["DATE4", 8],
  ["TIME", 8],
  ["LTNAME", 8],
]);

/** 読み取りの途中の状態。 */
interface Context {
  readonly file: string;
  formats: DeviceFormat[];
  messages: MessageDesc[];
  fmt: DeviceFormat | undefined;
  msg: MessageDesc | undefined;
  dpage: Dpage | undefined;
  seg: MsgSeg | undefined;
  lpage: Lpage | undefined;
  /** `DO` の中にいる間、ここに命令をためる。 */
  loop:
    | {
        count: number;
        lineInc: number;
        colInc: number;
        suffix: number;
        stmts: MacroStmt[];
        /** `DO` を書いた行。閉じ忘れの診断に使う。 */
        srcLine: number;
      }
    | undefined;
  /**
   * いまの FMT で `DEV` を読んだか。
   *
   * `deviceType` は既定値（`3270-A2`）が入っているので、
   * 「書かれたか」はこちらで持つ。
   */
  devSeen: boolean;
}

function fail(c: Context, s: MacroStmt, message: string): never {
  throw new MfsDefError(message, c.file, s.line);
}

/** `キー=` を取る。無ければ undefined。 */
function opt(s: MacroStmt, key: string): string | undefined {
  return s.operands.get(key);
}

/** `キー=` を名前として取る。 */
function name(c: Context, s: MacroStmt, key: string, value: string): string {
  const up = value.toUpperCase();
  if (!IMS_NAME.test(up)) {
    fail(c, s, `${s.op} 文の ${key}=${value} は名前として使えません（1〜8 桁の英数字と $ # @）`);
  }
  return up;
}

/**
 * 正の整数として取る。
 *
 * `Number()` に任せると `0x10` が 16、`1e1` が 10 として通る。
 * MFS の定義文に 16 進や指数表記の 10 進数は無いので、
 * 綴り間違いを黙って別の値として受けないよう 10 進の数字だけに限る。
 */
function int(c: Context, s: MacroStmt, what: string, value: string): number {
  const t = value.trim();
  if (!/^\d+$/.test(t)) fail(c, s, `${what} の ${value} は正の整数ではありません`);
  const n = Number(t);
  if (n <= 0) fail(c, s, `${what} の ${value} は正の整数ではありません`);
  return n;
}

/**
 * アポストロフィで囲んだ文字の並びを取り出す。
 * 中の `''` は 1 つの `'` にする。囲まれていなければ undefined。
 */
function literal(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 2 || !t.startsWith("'") || !t.endsWith("'")) return undefined;
  return t.slice(1, -1).replace(/''/g, "'");
}

/** `X'hh'` / `C'c'` / `NULL` を埋め文字として読む。 */
function fillOf(c: Context, s: MacroStmt, value: string): Fill {
  const t = value.trim();
  const up = t.toUpperCase();
  if (up === "NULL" || up === "NONE") return { kind: "null" };
  if (up === "PT") {
    fail(c, s, "FILL=PT（プログラムタブ）は未実装です（X'hh' / C'c' / NULL を使ってください）");
  }
  if (up.startsWith("X'") && t.endsWith("'")) {
    const hex = t.slice(2, -1);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) fail(c, s, `FILL=${t} は 2 桁の 16 進ではありません`);
    // この処理系の画面は文字の面しか持たないので、EBCDIC の符号を
    // そのまま文字コードとして使うと別の字になる（X'5C' は EBCDIC の
    // `*` だが Unicode では `\`）。X'00' は生の NUL が画面像と
    // セグメントに入ってしまう。半分だけ翻訳すると結果が予測できないので、
    // 意味が確かな 2 つだけを受けて、残りは名指しで断る
    const code = parseInt(hex, 16);
    if (code === 0x40) return { kind: "char", c: " " };
    if (code === 0x00) return { kind: "null" };
    fail(
      c,
      s,
      `FILL=${t} は未実装です（EBCDIC と文字の対応表を持たないため、` +
        `X'40'（空白）と X'00'（埋めない）だけを扱う。文字で書くなら C'c'）`,
    );
  }
  if (up.startsWith("C'") && t.endsWith("'")) {
    const ch = t.slice(2, -1).replace(/''/g, "'");
    if (ch.length !== 1) fail(c, s, `FILL=${t} は 1 文字ではありません`);
    return { kind: "char", c: ch };
  }
  fail(c, s, `FILL=${t} は読めません（X'hh' / C'c' / NULL）`);
}

/** `ATTR=(NUM,PROT,HI)` を読む。 */
function attrOf(c: Context, s: MacroStmt, value: string): Attr {
  const attr: Attr = { ...DEFAULT_ATTR };
  for (const raw of listOf(value)) {
    switch (raw.trim().toUpperCase()) {
      case "ALPHA": attr.numeric = false; break;
      case "NUM": attr.numeric = true; break;
      case "NOPROT": attr.protect = false; break;
      case "PROT": attr.protect = true; break;
      case "NORM": attr.display = "norm"; break;
      case "NODISP": attr.display = "none"; break;
      case "HI": attr.display = "hi"; break;
      case "NOMOD": attr.modified = false; break;
      case "MOD": attr.modified = true; break;
      case "DET":
      case "IDET":
      case "NODET":
        fail(c, s, `ATTR=${raw.trim().toUpperCase()}（選択ペン）は未実装です`);
      case "STRIP":
      case "NOSTRIP":
        fail(c, s, `ATTR=${raw.trim().toUpperCase()}（EGCS / DBCS）は未実装です`);
      default:
        fail(c, s, `ATTR=${raw.trim()} は読めません`);
    }
  }
  return attr;
}

/** `EATTR=(RED,HI)` を読む。色と強調だけ。 */
function eattrOf(c: Context, s: MacroStmt, value: string): Eattr {
  const out: Eattr = {};
  for (const raw of listOf(value)) {
    const v = raw.trim().toUpperCase();
    if (COLORS.has(v)) out.color = v;
    else if (HIGHLIGHTS.has(v)) out.highlight = v;
    else if (v.startsWith("PX") || v.startsWith("PC") || v.startsWith("EGCS")) {
      fail(c, s, `EATTR=${v}（プログラムシンボル / EGCS）は未実装です`);
    } else fail(c, s, `EATTR=${raw.trim()} は読めません（色と強調だけ）`);
  }
  return out;
}

/** `POS=(行,桁)` / `POS=(行,桁,ページ)` を読む。 */
function posOf(c: Context, s: MacroStmt, value: string): { line: number; col: number } {
  const parts = listOf(value);
  if (parts.length < 2 || parts.length > 3) fail(c, s, `POS=${value} は (行,桁) の形ではありません`);
  const line = int(c, s, "POS の行", parts[0]!);
  const col = int(c, s, "POS の桁", parts[1]!);
  if (parts.length === 3 && int(c, s, "POS のページ", parts[2]!) !== 1) {
    fail(c, s, "POS= の物理ページ指定（2 ページ目以降）は未実装です");
  }
  return { line, col };
}

/** `CURSOR=((行,桁))` を読む。 */
function cursorOf(c: Context, s: MacroStmt, value: string): { line: number; col: number } {
  const first = listOf(value)[0];
  if (first === undefined) fail(c, s, `CURSOR=${value} は ((行,桁)) の形ではありません`);
  const parts = listOf(first);
  if (parts.length < 2) fail(c, s, `CURSOR=${value} は ((行,桁)) の形ではありません`);
  if (parts.length > 2) fail(c, s, "CURSOR= に項目名を添える書き方は未実装です");
  return {
    line: int(c, s, "CURSOR の行", parts[0]!),
    col: int(c, s, "CURSOR の桁", parts[1]!),
  };
}

/** `DSCA=X'00A0'` を読む。 */
function dscaOf(c: Context, s: MacroStmt, value: string): Dsca {
  const t = value.trim().toUpperCase();
  let n: number;
  if (t.startsWith("X'") && t.endsWith("'")) {
    const hex = t.slice(2, -1);
    if (!/^[0-9A-F]{1,4}$/.test(hex)) fail(c, s, `DSCA=${value} は 16 進ではありません`);
    n = parseInt(hex, 16);
  } else {
    n = int(c, s, "DSCA", t);
  }
  const low = n & 0xff;
  // 扱うのは 3 ビットだけ。知らないビットを黙って落とすと
  // 指定したのに何も起きない（`DSCA=X'8000'` が無言の no-op になっていた）。
  // 0x80 は MFS が使う埋めビットなので通す
  const known = 0x80 | 0x40 | 0x20 | 0x10;
  const rest = n & ~known & 0xffff;
  if (rest !== 0) {
    fail(
      c,
      s,
      `DSCA=${value} のうち X'${rest.toString(16).toUpperCase().padStart(4, "0")}' の` +
        `ビットは未実装です（扱うのは X'40' 書式書き出し / X'20' 打ち込める項目の消去 / ` +
        `X'10' 警報だけ）`,
    );
  }
  return {
    eraseAll: (low & 0x40) !== 0,
    eraseUnprotected: (low & 0x20) !== 0,
    alarm: (low & 0x10) !== 0,
  };
}

/** `PFK=(項目名,1='…',2='…')` を読む。 */
function pfkOf(c: Context, s: MacroStmt, value: string): { field?: string; keys: Map<number, Pfk> } {
  const items = listOf(value);
  const keys = new Map<number, Pfk>();
  let field: string | undefined;
  let next = 1;
  for (const [i, raw] of items.entries()) {
    const item = raw.trim();
    const eq = item.indexOf("=");
    const quoted = literal(item);
    if (i === 0 && eq < 0 && quoted === undefined) {
      field = name(c, s, "PFK", item);
      continue;
    }
    let keyNo = next;
    let body = item;
    if (eq > 0 && literal(item.slice(0, eq)) === undefined) {
      keyNo = int(c, s, "PFK のキー番号", item.slice(0, eq));
      body = item.slice(eq + 1).trim();
    }
    const text = literal(body);
    if (text === undefined) {
      fail(c, s, `PFK の ${body} は未実装です（固定文字 '…' だけを扱う）`);
    }
    if (keyNo < 1 || keyNo > 24) fail(c, s, `PFK のキー番号 ${keyNo} は 1〜24 の外です`);
    keys.set(keyNo, { ...(field === undefined ? {} : { dfld: field }), literal: text });
    next = keyNo + 1;
  }
  // 固定文字を入れる先の項目名が無いと、`formatInput` が何も入れず
  // **PF キーが ENTER と同じ動きになる**（誤りも出ない）。
  // PF キーでトランザクションコードやコマンドを入れるのは定石なので、
  // 書き方を 1 つ間違えただけで別のトランザクションが走ってしまう
  if (keys.size > 0 && field === undefined) {
    fail(
      c,
      s,
      "PFK= に固定文字を入れる項目名がありません" +
        "（PFK=(項目名,3='/FOR MENU.') の形で書いてください）",
    );
  }
  return { ...(field === undefined ? {} : { field }), keys };
}

// ---- DEV / DIV / DPAGE / DFLD ----

function startFormat(c: Context, s: MacroStmt): void {
  if (s.label === undefined) fail(c, s, "FMT 文にラベル（書式の名前）がありません");
  c.fmt = {
    name: name(c, s, "ラベル", s.label),
    deviceType: "3270-A2",
    rows: 24,
    cols: 80,
    div: "INOUT",
    pfk: new Map(),
    dsca: { ...NO_DSCA },
    dpages: [],
    file: c.file,
    srcLine: s.line,
  };
  c.dpage = undefined;
  c.devSeen = false;
}

function applyDev(c: Context, s: MacroStmt): void {
  const fmt = c.fmt ?? fail(c, s, "DEV 文が FMT の外にあります");
  // 実機の FMT は装置ごとに DEV を並べられるが、ここは後の DEV が
  // 行数・桁数・PFK を上書きし、DFLD は全部同じ DPAGE に積まれる。
  // DPAGE が無いと「最後の装置の大きさを持つ 1 つの書式」に
  // 黙って混ざるので断る
  if (c.devSeen) {
    fail(c, s, "複数装置の書式（DEV を並べる形）は未実装です（DEV は 1 つだけ）");
  }
  c.devSeen = true;
  const typeText = opt(s, "TYPE") ?? fail(c, s, "DEV 文に TYPE= がありません");
  const key = listOf(typeText).join(",").toUpperCase();
  const size = SCREEN_SIZE.get(key);
  if (size === undefined) {
    fail(
      c,
      s,
      `DEV TYPE=${typeText} は未実装です（扱えるのは ${[...SCREEN_SIZE.keys()].join(" / ")}）`,
    );
  }
  fmt.deviceType = key;
  fmt.rows = size.rows;
  fmt.cols = size.cols;

  const feat = opt(s, "FEAT");
  if (feat !== undefined) {
    const items = listOf(feat).map((x) => x.trim().toUpperCase());
    if (items.length !== 1 || items[0] !== "IGNORE") {
      fail(c, s, `DEV FEAT=${feat} は未実装です（FEAT=IGNORE だけを扱う）`);
    }
  }
  const pfk = opt(s, "PFK");
  if (pfk !== undefined) {
    const parsed = pfkOf(c, s, pfk);
    fmt.pfk = parsed.keys;
  }
  const dsca = opt(s, "DSCA");
  if (dsca !== undefined) fmt.dsca = dscaOf(c, s, dsca);
  const sysmsg = opt(s, "SYSMSG");
  if (sysmsg !== undefined) fmt.sysmsg = name(c, s, "SYSMSG", sysmsg);
  for (const key2 of ["WIDTH", "PAGE", "SUBSTR", "MODE", "CARD", "FTAB", "HTAB", "VT", "VTAB"]) {
    if (s.operands.has(key2)) fail(c, s, `DEV ${key2}= は未実装です（印刷装置・カードは対象外）`);
  }
}

function applyDiv(c: Context, s: MacroStmt): void {
  const fmt = c.fmt ?? fail(c, s, "DIV 文が FMT の外にあります");
  const type = (opt(s, "TYPE") ?? "INOUT").toUpperCase();
  if (type !== "INPUT" && type !== "OUTPUT" && type !== "INOUT") {
    fail(c, s, `DIV TYPE=${type} は読めません（INPUT / OUTPUT / INOUT）`);
  }
  if (s.operands.has("COMPR") || s.operands.has("OPTIONS") || s.operands.has("RCDCT")) {
    fail(c, s, "DIV の COMPR= / OPTIONS= / RCDCT= は未実装です");
  }
  fmt.div = type;
}

function applyDpage(c: Context, s: MacroStmt): void {
  const fmt = c.fmt ?? fail(c, s, "DPAGE 文が FMT の外にあります");
  if (opt(s, "MULT")?.toUpperCase() === "YES") {
    fail(c, s, "DPAGE MULT=YES（複数物理ページの入力）は未実装です");
  }
  if (s.operands.has("COND") || s.operands.has("ACTVPID") || s.operands.has("ORIGIN")) {
    fail(c, s, "DPAGE の COND= / ACTVPID= / ORIGIN= は未実装です");
  }
  const cursor = opt(s, "CURSOR");
  const fill = opt(s, "FILL");
  const dpage: Dpage = {
    ...(cursor === undefined ? {} : { cursor: cursorOf(c, s, cursor) }),
    ...(fill === undefined ? {} : { fill: fillOf(c, s, fill) }),
    dflds: [],
  };
  fmt.dpages.push(dpage);
  c.dpage = dpage;
}

function applyDfld(c: Context, s: MacroStmt, suffix: string, lineInc: number, colInc: number): void {
  const fmt = c.fmt ?? fail(c, s, "DFLD 文が FMT の外にあります");
  if (c.dpage === undefined) {
    // DPAGE を書かない定義も通る（1 画面として扱う）
    const dpage: Dpage = { dflds: [] };
    fmt.dpages.push(dpage);
    c.dpage = dpage;
  }
  if (s.flags.includes("PASSWORD")) fail(c, s, "DFLD の PASSWORD は未実装です");
  for (const key of ["OPCTL", "EXIT", "SCA", "EXTATT", "PEN"]) {
    if (s.operands.has(key)) fail(c, s, `DFLD ${key}= は未実装です`);
  }

  const text = s.positional[0] === undefined ? undefined : literal(s.positional[0]);
  if (s.positional[0] !== undefined && text === undefined) {
    fail(c, s, `DFLD の ${s.positional[0]} は読めません（固定文字は '…' で囲む）`);
  }
  const posText = opt(s, "POS") ?? fail(c, s, "DFLD 文に POS= がありません");
  const pos = posOf(c, s, posText);
  const lthText = opt(s, "LTH");
  const length =
    lthText !== undefined
      ? int(c, s, "LTH", listOf(lthText)[0]!)
      : (text?.length ?? fail(c, s, "DFLD に LTH= も固定文字もありません"));

  const attrText = opt(s, "ATTR");
  const eattrText = opt(s, "EATTR");
  const label = s.label === undefined ? undefined : name(c, s, "ラベル", s.label) + suffix;
  if (label !== undefined && label.length > 8) {
    fail(c, s, `ラベル ${label} が 8 桁を超えます（DO で繰り返す項目のラベルは 6 桁まで）`);
  }
  const dfld: Dfld = {
    ...(label === undefined ? {} : { name: label }),
    line: pos.line + lineInc,
    col: pos.col + colInc,
    length,
    ...(text === undefined ? {} : { literal: text }),
    attr: attrText === undefined ? { ...DEFAULT_ATTR } : attrOf(c, s, attrText),
    ...(eattrText === undefined ? {} : { eattr: eattrOf(c, s, eattrText) }),
    srcLine: s.line,
  };
  if (dfld.line === 1 && dfld.col === 1) {
    // 属性バイトが 1 つ前の位置に入るので、画面の先頭には置けない
    // （実機も 3270 では POS=(1,1) を書いてはならないと規定している）
    fail(c, s, "POS=(1,1) は 3270 では使えません（属性バイトの置き場所が無い）");
  }
  if (dfld.line < 1 || dfld.line > fmt.rows || dfld.col < 1 || dfld.col > fmt.cols) {
    fail(
      c,
      s,
      `POS=(${dfld.line},${dfld.col}) は画面（${fmt.rows} 行 × ${fmt.cols} 桁）の外です`,
    );
  }
  if (dfld.col + dfld.length - 1 > fmt.cols) {
    fail(
      c,
      s,
      `${dfld.name ?? "固定文字"} は ${dfld.col} 桁から ${dfld.length} 桁で、` +
        `画面の右端（${fmt.cols} 桁）を越えます`,
    );
  }
  c.dpage.dflds.push(dfld);
}

// ---- MSG / LPAGE / SEG / MFLD ----

function startMessage(c: Context, s: MacroStmt): void {
  if (s.label === undefined) fail(c, s, "MSG 文にラベル（メッセージ記述の名前）がありません");
  const type = (opt(s, "TYPE") ?? "INPUT").toUpperCase();
  if (type !== "INPUT" && type !== "OUTPUT") {
    fail(c, s, `MSG TYPE=${type} は読めません（INPUT / OUTPUT）`);
  }
  const optText = opt(s, "OPT");
  if (optText !== undefined && optText.trim() !== "1") {
    fail(c, s, `MSG OPT=${optText.trim()} は未実装です（OPT=1 だけを扱う）`);
  }
  if (opt(s, "PAGE")?.toUpperCase() === "YES") {
    fail(c, s, "MSG PAGE=YES（論理ページング）は未実装です");
  }
  for (const key of ["COMPT", "DPM", "FILL1", "NXTMSG"]) {
    if (s.operands.has(key)) fail(c, s, `MSG ${key}= は未実装です`);
  }
  const sorText = opt(s, "SOR") ?? fail(c, s, "MSG 文に SOR= がありません");
  const sorItems = listOf(sorText);
  const sor = name(c, s, "SOR", sorItems[0] ?? "");
  const rest = sorItems.slice(1).map((x) => x.trim().toUpperCase());
  for (const r of rest) {
    if (r !== "IGNORE") fail(c, s, `MSG SOR= の ${r} は未実装です（IGNORE だけを扱う）`);
  }
  const next = opt(s, "NXT");
  const fill = opt(s, "FILL");
  c.msg = {
    name: name(c, s, "ラベル", s.label),
    type,
    sor,
    sorIgnore: rest.includes("IGNORE"),
    ...(next === undefined ? {} : { next: name(c, s, "NXT", next) }),
    ...(fill === undefined ? {} : { fill: fillOf(c, s, fill) }),
    lpages: [],
    file: c.file,
    srcLine: s.line,
  };
  c.lpage = undefined;
  c.seg = undefined;
}

function applyLpage(c: Context, s: MacroStmt): void {
  const msg = c.msg ?? fail(c, s, "LPAGE 文が MSG の外にあります");
  if (s.operands.has("COND")) fail(c, s, "LPAGE COND= は未実装です");
  if (s.operands.has("SOR") || s.operands.has("PROMPT")) {
    fail(c, s, "LPAGE の SOR= / PROMPT= は未実装です");
  }
  const lpage: Lpage = { segs: [] };
  msg.lpages.push(lpage);
  c.lpage = lpage;
  c.seg = undefined;
}

function currentLpage(c: Context, s: MacroStmt): Lpage {
  const msg = c.msg ?? fail(c, s, `${s.op} 文が MSG の外にあります`);
  if (c.lpage === undefined) {
    const lpage: Lpage = { segs: [] };
    msg.lpages.push(lpage);
    c.lpage = lpage;
  }
  return c.lpage;
}

function applySeg(c: Context, s: MacroStmt): void {
  for (const key of ["EXIT", "GRAPHIC"]) {
    if (s.operands.has(key)) fail(c, s, `SEG ${key}= は未実装です`);
  }
  const lpage = currentLpage(c, s);
  const seg: MsgSeg = { mflds: [] };
  lpage.segs.push(seg);
  c.seg = seg;
}

/** `MFLD` の取り先を読む。 */
function mfldSource(c: Context, s: MacroStmt, suffix: string): MfldSource {
  const raw = s.positional[0];
  if (raw === undefined) return { kind: "filler" };
  const text = literal(raw);
  if (text !== undefined) return { kind: "literal", text };
  if (!raw.startsWith("(")) return { kind: "dfld", name: name(c, s, "MFLD", raw) + suffix };

  const items = listOf(raw);
  if (items.length !== 2) {
    fail(c, s, `MFLD の ${raw} は (項目,'固定文字') / (項目,システム定数) の形ではありません`);
  }
  const field = name(c, s, "MFLD", items[0]!.trim()) + suffix;
  const second = items[1]!.trim();
  const secondLiteral = literal(second);
  if (secondLiteral === undefined) {
    const which = second.toUpperCase() as SystemLiteral;
    if (!SYSTEM_LITERALS.has(which)) {
      fail(
        c,
        s,
        `MFLD の ${second} は未実装です（固定文字 '…' か ` +
          `${[...SYSTEM_LITERALS.keys()].join(" / ")}）`,
      );
    }
    return { kind: "system", name: field, which };
  }
  return { kind: "dfld-literal", name: field, text: secondLiteral };
}

function applyMfld(c: Context, s: MacroStmt, suffix: string): void {
  const msg = c.msg ?? fail(c, s, "MFLD 文が MSG の外にあります");
  for (const key of ["EXIT", "HDRCTL", "SCA", "DFLD"]) {
    if (s.operands.has(key)) fail(c, s, `MFLD ${key}= は未実装です`);
  }
  if (c.seg === undefined) {
    applySeg(c, {
      ...s,
      op: "SEG",
      operands: new Map(),
      flags: [],
      positional: [],
      positionalWithHoles: [],
    });
  }
  const seg = c.seg!;
  const source = mfldSource(c, s, suffix);

  const lthText = opt(s, "LTH");
  if (lthText !== undefined && listOf(lthText).length > 1) {
    fail(c, s, `MFLD LTH=${lthText} は未実装です（長さは 1 つだけ）`);
  }
  const attrText = (opt(s, "ATTR") ?? "NO").toUpperCase();
  if (attrText !== "YES" && attrText !== "NO") {
    fail(c, s, `MFLD ATTR=${attrText} は読めません（YES / NO）`);
  }
  const attrBytes = attrText === "YES";
  let length: number;
  if (lthText !== undefined) {
    length = int(c, s, "LTH", listOf(lthText)[0]!);
    if (attrBytes) length += 2;
  } else if (source.kind === "literal") {
    length = source.text.length;
  } else if (source.kind === "system") {
    length = SYSTEM_LITERALS.get(source.which)!;
  } else if (source.kind === "dfld-literal") {
    length = source.text.length;
  } else {
    fail(c, s, "MFLD に LTH= がありません");
  }
  const just = (opt(s, "JUST") ?? "L").toUpperCase();
  if (just !== "L" && just !== "R") fail(c, s, `MFLD JUST=${just} は読めません（L / R）`);
  const fill = opt(s, "FILL");
  const mfld: Mfld = {
    source,
    length,
    just,
    fill: fill === undefined ? (msg.fill ?? FILL_BLANK) : fillOf(c, s, fill),
    attrBytes,
    srcLine: s.line,
  };
  seg.mflds.push(mfld);
}

// ---- DO / ENDDO ----

function startDo(c: Context, s: MacroStmt): void {
  const bound = opt(s, "BOUND");
  if (bound !== undefined && bound.toUpperCase() !== "LINE") {
    fail(c, s, `DO BOUND=${bound} は未実装です（BOUND=LINE だけを扱う）`);
  }
  // 位置オペランドは**穴を残した並び**から取る。`DO 3,,5` は
  // 「回数 3 / 行の増分は既定 / 桁の増分 5」。空を落とすと 5 が
  // 行の増分に入り、横に並べたい項目が縦に並ぶ（しかも誤りは出ない）
  const ops = s.positionalWithHoles;
  const at = (i: number): string | undefined => {
    const v = ops[i];
    return v === undefined || v === "" ? undefined : v;
  };
  const countText = at(0) ?? opt(s, "COUNT");
  if (countText === undefined) fail(c, s, "DO 文に繰り返し回数がありません");
  const count = int(c, s, "DO の回数", countText);
  if (count > 99) fail(c, s, `DO の回数 ${count} は 99 を超えます`);
  if (ops.length > 3) {
    fail(c, s, `DO の位置オペランドは 3 つまでです（回数, 行の増分, 桁の増分）`);
  }
  const suffixText = opt(s, "SUF") ?? "01";
  const suffix = int(c, s, "DO の SUF", suffixText);
  c.loop = {
    count,
    lineInc: at(1) === undefined ? 0 : Number(at(1)),
    colInc: at(2) === undefined ? 0 : Number(at(2)),
    suffix,
    stmts: [],
    srcLine: s.line,
  };
  if (!Number.isInteger(c.loop.lineInc) || !Number.isInteger(c.loop.colInc)) {
    fail(c, s, "DO の増分は整数で書いてください");
  }
}

function endDo(c: Context, s: MacroStmt): void {
  const loop = c.loop ?? fail(c, s, "ENDDO に対応する DO がありません");
  c.loop = undefined;
  for (let i = 0; i < loop.count; i++) {
    const suffix = String(loop.suffix + i).padStart(2, "0");
    if (suffix.length > 2) fail(c, s, `DO の通し番号 ${suffix} が 2 桁を超えます`);
    for (const inner of loop.stmts) {
      if (inner.op === "DFLD") {
        applyDfld(c, inner, suffix, loop.lineInc * i, loop.colInc * i);
      } else if (inner.op === "MFLD") {
        applyMfld(c, inner, suffix);
      } else if (inner.op === "DO") {
        // DO の中の DO はここまで来る（中身はためられている）
        fail(c, inner, "DO の入れ子は未実装です");
      } else {
        fail(c, inner, `DO の中に ${inner.op} 文は書けません（DFLD / MFLD だけ）`);
      }
    }
  }
}

// ---- 入口 ----

/** 1 つの MFS 定義ファイルを読む。 */
export function parseMfs(
  text: string,
  file: string,
): { formats: DeviceFormat[]; messages: MessageDesc[] } {
  const c: Context = {
    file,
    formats: [],
    messages: [],
    fmt: undefined,
    msg: undefined,
    dpage: undefined,
    seg: undefined,
    lpage: undefined,
    loop: undefined,
    devSeen: false,
  };
  for (const s of readMacros(text, file)) {
    if (LISTING_OPS.has(s.op)) continue;
    if (c.loop !== undefined && s.op !== "ENDDO") {
      c.loop.stmts.push(s);
      continue;
    }
    switch (s.op) {
      case "FMT":
        if (c.fmt !== undefined) fail(c, s, "前の FMT が FMTEND で閉じていません");
        if (c.msg !== undefined) fail(c, s, "前の MSG が MSGEND で閉じていません");
        startFormat(c, s);
        break;
      case "DEV": applyDev(c, s); break;
      case "DIV": applyDiv(c, s); break;
      case "DPAGE": applyDpage(c, s); break;
      case "DFLD": applyDfld(c, s, "", 0, 0); break;
      case "FMTEND": {
        const fmt = c.fmt ?? fail(c, s, "FMTEND に対応する FMT がありません");
        if (fmt.dpages.length === 0) fail(c, s, `書式 ${fmt.name} に DFLD が 1 つもありません`);
        c.formats.push(fmt);
        c.fmt = undefined;
        c.dpage = undefined;
        break;
      }
      case "MSG":
        if (c.fmt !== undefined) fail(c, s, "前の FMT が FMTEND で閉じていません");
        if (c.msg !== undefined) fail(c, s, "前の MSG が MSGEND で閉じていません");
        startMessage(c, s);
        break;
      case "LPAGE": applyLpage(c, s); break;
      case "SEG": applySeg(c, s); break;
      case "MFLD": applyMfld(c, s, ""); break;
      case "MSGEND": {
        const msg = c.msg ?? fail(c, s, "MSGEND に対応する MSG がありません");
        if (msg.lpages.length === 0 || msg.lpages.every((l) => l.segs.length === 0)) {
          fail(c, s, `メッセージ記述 ${msg.name} に MFLD が 1 つもありません`);
        }
        c.messages.push(msg);
        c.msg = undefined;
        c.lpage = undefined;
        c.seg = undefined;
        break;
      }
      case "DO": startDo(c, s); break;
      case "ENDDO": endDo(c, s); break;
      case "PASSWORD":
        fail(c, s, "PASSWORD 文は未実装です");
      case "TABLE":
      case "PDB":
      case "PPAGE":
      case "COPY":
      case "EQU":
      case "IF":
        fail(c, s, `${s.op} 文は未実装です`);
      default:
        fail(c, s, `${s.op} は MFS の定義文ではありません`);
    }
  }
  if (c.loop !== undefined) {
    // 開始行を持たせないと行番号が常に 1 になる。
    // FMT / MSG の閉じ忘れは正しい行を出しているので、ここだけ揃えていなかった
    throw new MfsDefError("DO が ENDDO で閉じていません", file, c.loop.srcLine);
  }
  if (c.fmt !== undefined) throw new MfsDefError("FMT が FMTEND で閉じていません", file, c.fmt.srcLine);
  if (c.msg !== undefined) throw new MfsDefError("MSG が MSGEND で閉じていません", file, c.msg.srcLine);
  return { formats: c.formats, messages: c.messages };
}

/** 付随ファイルにある MFS 定義（`*.mfs`）の名前を並べる。 */
export function mfsFileNames(files: Record<string, string>): string[] {
  return Object.keys(files)
    .filter((n) => /\.mfs$/i.test(n))
    .sort();
}

/**
 * `*.mfs` を全部読んで 1 つの表にする。
 * 名前は表の全体で一意（実機の `IMS.FORMAT` ライブラリと同じ）。
 */
export function loadMfs(files: Record<string, string>): MfsLibrary {
  const formats = new Map<string, DeviceFormat>();
  const messages = new Map<string, MessageDesc>();
  for (const file of mfsFileNames(files)) {
    const parsed = parseMfs(files[file] ?? "", file);
    for (const f of parsed.formats) {
      const prev = formats.get(f.name);
      if (prev !== undefined) {
        throw new MfsDefError(`書式 ${f.name} は ${prev.file} にもあります`, file, f.srcLine);
      }
      formats.set(f.name, f);
    }
    for (const m of parsed.messages) {
      const prev = messages.get(m.name);
      if (prev !== undefined) {
        throw new MfsDefError(
          `メッセージ記述 ${m.name} は ${prev.file} にもあります`,
          file,
          m.srcLine,
        );
      }
      messages.set(m.name, m);
    }
  }
  for (const f of formats.values()) {
    if (f.dpages.length > 1) {
      throw new MfsDefError(
        `書式 ${f.name} に DPAGE が ${f.dpages.length} 個あります` +
          "（2 画面目を選ぶ仕掛け（ページング）が未実装なので 1 つだけ）",
        f.file,
        f.srcLine,
      );
    }
    // 項目の重なりは画面を組めないので、読んだ時点で断る
    validateLayout(f);
    // ラベルが重なると `fieldNamed` が先頭にしか届かず、2 つめは
    // 画面に出るのに永久に空のまま（MFLD も打ち込みも先頭へ行く）
    const seen = new Set<string>();
    for (const d of f.dpages.flatMap((p2) => p2.dflds)) {
      if (d.name === undefined) continue;
      if (seen.has(d.name)) {
        throw new MfsDefError(
          `書式 ${f.name} に DFLD ${d.name} が 2 つあります（ラベルは書式の中で一意）`,
          f.file,
          d.srcLine,
        );
      }
      seen.add(d.name);
    }
  }
  // 参照の食い違いは、使うときではなく読んだ時点で断る
  for (const m of messages.values()) {
    const fmt = formats.get(m.sor);
    if (fmt === undefined) {
      throw new MfsDefError(
        `MSG ${m.name} の SOR=${m.sor} にあたる FMT がありません`,
        m.file,
        m.srcLine,
      );
    }
    if (m.next !== undefined && !messages.has(m.next)) {
      throw new MfsDefError(
        `MSG ${m.name} の NXT=${m.next} にあたる MSG がありません`,
        m.file,
        m.srcLine,
      );
    }
    if (m.lpages.length > 1) {
      throw new MfsDefError(
        `メッセージ記述 ${m.name} に LPAGE が ${m.lpages.length} 個あります` +
          "（どれを使うかを決める LPAGE COND= が未実装なので 1 つだけ）",
        m.file,
        m.srcLine,
      );
    }
    const named = new Set(
      fmt.dpages.flatMap((d) => d.dflds.map((x) => x.name).filter((x) => x !== undefined)),
    );
    for (const seg of m.lpages.flatMap((l) => l.segs)) {
      for (const f of seg.mflds) {
        checkMfld(m, f, named);
      }
    }
  }
  return new MfsLibrary(formats, messages);
}

/** `MFLD` が指す先と、向きに合った書き方かを見る。 */
function checkMfld(m: MessageDesc, f: Mfld, named: Set<string>): void {
  const where = (text: string): never => {
    throw new MfsDefError(`MSG ${m.name} の ${text}`, m.file, f.srcLine);
  };
  if (m.type === "OUTPUT") {
    if (f.source.kind === "literal") {
      where("出力の MFLD に固定文字だけを書くことはできません（置く先の項目がありません）");
    }
    if (f.source.kind === "dfld-literal") {
      where("出力の MFLD に固定文字を添える書き方は未実装です（入力用の書き方）");
    }
  } else {
    if (f.source.kind === "system") {
      where(`システム定数 ${f.source.which} は出力専用です`);
    }
    if (f.attrBytes) {
      where("入力の MFLD の ATTR=YES は未実装です（装置は属性を返さない）");
    }
  }
  const target =
    f.source.kind === "dfld" || f.source.kind === "dfld-literal" || f.source.kind === "system"
      ? f.source.name
      : undefined;
  if (target !== undefined && !named.has(target)) {
    where(`MFLD ${target} にあたる DFLD が ${m.sor} にありません`);
  }
}
