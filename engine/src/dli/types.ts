/**
 * DL/I（IMS/DB）の型。
 *
 * この階層（`src/dli/`）は**文字列と値だけを扱う純粋な層**で、
 * 処理系の内部（Interpreter の記憶域や Value）には触らない。
 * PL/I 側との受け渡しは `interp.ts` が引き受ける。
 * 層を分けておくと、DL/I の意味論だけを単体で試験できる。
 */

/** DBD / PSB の記述の誤り。どのファイルの何行目かを必ず持つ。 */
export class DliDefError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
  ) {
    super(`${file} ${line} 行: ${message}`);
    this.name = "DliDefError";
  }
}

/** セグメント内の項目。`START` は 1 始まりの桁。 */
export interface FieldDef {
  name: string;
  start: number;
  bytes: number;
  /** `TYPE=` の値。C（文字）だけを実際に扱う。 */
  /** 項目の型。扱えるのは C（文字）だけ。 */
  type: "C";
}

/** 順序キー項目（`FIELD NAME=(name,SEQ,U)`）。 */
export interface SequenceField extends FieldDef {
  /** `U`（一意）なら true、`M`（重複可）なら false。 */
  unique: boolean;
}

export interface SegmentDef {
  name: string;
  /** ルートなら undefined。 */
  parent?: string;
  /** セグメントの長さ。 */
  bytes: number;
  /** ルートを 1 とする階層の深さ。 */
  level: number;
  fields: FieldDef[];
  /** 順序キー。無いセグメントもある（挿入は兄弟の末尾になる）。 */
  sequence?: SequenceField;
  /** 子セグメントの名前。DBD に書かれた順（階層順の並び順になる）。 */
  children: string[];
}

export interface DbdDef {
  name: string;
  /** `ACCESS=` の最初の値。物理挙動は再現しないので記録だけ。 */
  access: string;
  segments: Map<string, SegmentDef>;
  root: string;
}

/** 感知セグメント（`SENSEG`）。 */
export interface SensegDef {
  name: string;
  parent?: string;
  /** `PROCOPT=` をセグメント単位で上書きした場合。 */
  procopt?: string;
}

export interface PcbDef {
  /** `io` は入出力 PCB（メッセージ用）。DB 呼び出しには使えない。 */
  kind: "io" | "db";
  dbdName?: string;
  dbd?: DbdDef;
  /** 処理オプション。`A` は全部可。 */
  procopt: string;
  /** キーフィードバック領域の長さ。 */
  keylen: number;
  senseg: Map<string, SensegDef>;
}

export interface PsbDef {
  name: string;
  lang: string;
  pcbs: PcbDef[];
}

/** DL/I 呼び出しの結果。PL/I 側への書き戻しは呼び出し元が行う。 */
export interface DliResult {
  /** 2 桁のステータスコード。正常は空白 2 つ。 */
  status: string;
  /** 取れたセグメントの内容。GET 系で成功したときだけ入る。 */
  ioArea?: string;
}
