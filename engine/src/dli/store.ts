/**
 * 階層セグメント記憶。
 *
 * データの実体は IMS のアンロードに倣った**行指向のテキスト**にした。
 *
 *   STUDENT S0001YAMAKAWA
 *   COURSE  C001MATH
 *
 * 先頭 8 桁がセグメント名、以降が `BYTES=` 長のセグメントデータ。
 * 階層は行の順で決まる（子の親は、直前に現れた親の型の出現）。
 * これは IMS の階層順そのものなので、形式を決めるために新しい規則を
 * 作らずに済む。人が読めて diff も取れるので、ブラウザの仮想ファイルで
 * そのまま編集できる。
 *
 * 物理の配置（RAP・ポインタ・データセット）は再現しない。
 * 業務プログラムから見える違いは階層順と順序キーだけで決まる。
 */

import { m } from "../i18n/index.js";
import { DliDefError, type DbdDef, type SegmentDef } from "./types.js";

/** セグメント名の欄の幅。 */
const NAME_WIDTH = 8;

/** セグメントの出現。 */
export interface Occurrence {
  type: string;
  /** `BYTES=` 長に揃えたセグメントデータ。 */
  data: string;
  parent?: Occurrence;
  /** 子の出現。型の並び（DBD の順）、同じ型の中は順序キーの順。 */
  children: Occurrence[];
}

export class Database {
  /** ルートセグメントの出現。順序キーの順。 */
  readonly roots: Occurrence[] = [];

  constructor(readonly dbd: DbdDef) {}

  // ---- 読み書き ----

  static load(dbd: DbdDef, text: string, file: string): Database {
    const db = new Database(dbd);
    const last = new Map<string, Occurrence>();
    // CRLF も受ける。`\n` だけで切ると `\r` がデータの末尾に残り、
    // キーの比較や unload が静かに狂う（Windows や
    // VSCode の改行設定で起きる）
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const lineNo = i + 1;
      const type = line.slice(0, NAME_WIDTH).trim().toUpperCase();
      const seg = dbd.segments.get(type);
      if (seg === undefined) {
        throw new DliDefError(
          m`セグメント ${type} は DBD ${dbd.name} にありません`,
          file,
          lineNo,
        );
      }
      let parent: Occurrence | undefined;
      if (seg.parent !== undefined) {
        parent = last.get(seg.parent);
        if (parent === undefined) {
          throw new DliDefError(
            m`${type} の親 ${seg.parent} がまだ現れていません`,
            file,
            lineNo,
          );
        }
      }
      const raw = line.slice(NAME_WIDTH);
      // 桁あふれは黙って切らない。切ると「書いたはずの値が無い」に
      // なり、桁ずれを見逃す（SSA は長すぎる値を断っているので揃える）
      if (raw.trimEnd().length > seg.bytes) {
        throw new DliDefError(
          m`${type} の行が長すぎます（BYTES=${seg.bytes} に対して ${raw.trimEnd().length} 桁）`,
          file,
          lineNo,
        );
      }
      const occ: Occurrence = {
        type,
        data: fit(raw, seg.bytes),
        ...(parent === undefined ? {} : { parent }),
        children: [],
      };
      const siblings = parent === undefined ? db.roots : parent.children;
      db.checkOrder(siblings, occ, seg, file, lineNo);
      siblings.push(occ);
      last.set(type, occ);
      // 親が変わったら、その配下の型の「直前の出現」は無効になる
      for (const name of descendants(dbd, type)) last.delete(name);
    }
    return db;
  }

  /** 階層順のテキストに戻す。`load` した内容は元のまま出る。 */
  unload(): string {
    const lines = this.hierarchy().map((o) => o.type.padEnd(NAME_WIDTH) + o.data);
    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  }

  // ---- 走査 ----

  /** 全出現を階層順（親 → 子 → 孫 → 次の子）で返す。 */
  hierarchy(): Occurrence[] {
    const out: Occurrence[] = [];
    const walk = (list: Occurrence[]): void => {
      for (const o of list) {
        out.push(o);
        walk(o.children);
      }
    };
    walk(this.roots);
    return out;
  }

  /** 階層順で次の出現。終端なら undefined。 */
  next(from: Occurrence): Occurrence | undefined {
    if (from.children.length > 0) return from.children[0];
    for (let o: Occurrence | undefined = from; o !== undefined; o = o.parent) {
      const siblings = o.parent === undefined ? this.roots : o.parent.children;
      const at = siblings.indexOf(o);
      if (at >= 0 && at + 1 < siblings.length) return siblings[at + 1];
    }
    return undefined;
  }

  /** 階層順の最初の出現。 */
  first(): Occurrence | undefined {
    return this.roots[0];
  }

  // ---- 更新 ----

  /**
   * 子（`parent` が undefined ならルート）として挿入する。
   *
   * 順序キーがあれば昇順の位置へ、無ければ同じ型の末尾へ入れる。
   * 重複の検査はしない。一意キーの重複は DL/I 側が `II` で断る。
   */
  insert(parent: Occurrence | undefined, type: string, data: string): Occurrence {
    const seg = this.dbd.segments.get(type)!;
    const occ: Occurrence = {
      type,
      data: fit(data, seg.bytes),
      ...(parent === undefined ? {} : { parent }),
      children: [],
    };
    const siblings = parent === undefined ? this.roots : parent.children;
    siblings.splice(this.placeFor(siblings, occ, seg), 0, occ);
    return occ;
  }

  /** 出現を消す。配下の子も一緒に消える（物理削除の連鎖）。 */
  remove(occ: Occurrence): void {
    const siblings = occ.parent === undefined ? this.roots : occ.parent.children;
    const at = siblings.indexOf(occ);
    if (at >= 0) siblings.splice(at, 1);
  }

  /** セグメントデータを置き換える。長さは `BYTES=` に揃える。 */
  replace(occ: Occurrence, data: string): void {
    occ.data = fit(data, this.dbd.segments.get(occ.type)!.bytes);
  }

  // ---- 項目 ----

  /** 項目の値。桁は 1 始まり。 */
  static fieldValue(dbd: DbdDef, occ: Occurrence, field: string): string | undefined {
    const f = dbd.segments.get(occ.type)?.fields.find((x) => x.name === field.toUpperCase());
    if (f === undefined) return undefined;
    return occ.data.slice(f.start - 1, f.start - 1 + f.bytes);
  }

  /** 順序キーの値。順序キーが無ければ空文字列。 */
  static keyValue(dbd: DbdDef, occ: Occurrence): string {
    const seq = dbd.segments.get(occ.type)?.sequence;
    if (seq === undefined) return "";
    return occ.data.slice(seq.start - 1, seq.start - 1 + seq.bytes);
  }

  /** ルートからこの出現までの連結キー。キーフィードバック領域に入る。 */
  static concatenatedKey(dbd: DbdDef, occ: Occurrence): string {
    const parts: string[] = [];
    for (let o: Occurrence | undefined = occ; o !== undefined; o = o.parent) {
      parts.unshift(Database.keyValue(dbd, o));
    }
    return parts.join("");
  }

  // ---- 内部 ----

  /** 同じ型の兄弟の中で挿入すべき位置。 */
  private placeFor(siblings: Occurrence[], occ: Occurrence, seg: SegmentDef): number {
    const order = this.typeOrder(occ.parent, occ.type);
    const key = Database.keyValue(this.dbd, occ);
    let at = siblings.length;
    for (let i = 0; i < siblings.length; i++) {
      const s = siblings[i]!;
      const sOrder = this.typeOrder(occ.parent, s.type);
      if (sOrder < order) continue;
      if (sOrder > order) return i;
      // 同じ型。順序キーが無ければ末尾へ送る
      if (seg.sequence === undefined) continue;
      if (Database.keyValue(this.dbd, s) > key) return i;
      at = i + 1;
    }
    return at;
  }

  /** 親の下での型の並び順。DBD に書かれた順になる。 */
  private typeOrder(parent: Occurrence | undefined, type: string): number {
    if (parent === undefined) return 0;
    const order = this.dbd.segments.get(parent.type)!.children.indexOf(type);
    return order < 0 ? 0 : order;
  }

  /** 読み込み中の順序の検査。兄弟は型の順・キーの昇順でなければならない。 */
  private checkOrder(
    siblings: Occurrence[],
    occ: Occurrence,
    seg: SegmentDef,
    file: string,
    line: number,
  ): void {
    // 兄弟は DBD の子の宣言順に固まって並んでいなければならない。
    // `COURSE, ADDR, COURSE` のような混在を通すと、階層順が
    // DBD の並びとずれたまま保持され、以降の挿入でさらに乱れる
    const order = (type: string): number => {
      const parentType = occ.parent?.type;
      const list =
        parentType === undefined
          ? [...this.dbd.segments.values()].filter((x) => x.parent === undefined).map((x) => x.name)
          : (this.dbd.segments.get(parentType)?.children ?? []);
      return list.indexOf(type);
    };
    const mine = order(occ.type);
    for (const sib of siblings) {
      if (sib.type === occ.type) continue;
      if (order(sib.type) > mine) {
        throw new DliDefError(
          m`${occ.type} が ${sib.type} より後に来ています（兄弟は DBD の子の宣言順に並べてください）`,
          file,
          line,
        );
      }
    }
    if (seg.sequence === undefined) return;
    const prev = [...siblings].reverse().find((s) => s.type === occ.type);
    if (prev === undefined) return;
    const a = Database.keyValue(this.dbd, prev);
    const b = Database.keyValue(this.dbd, occ);
    if (b > a) return;
    if (b === a && seg.sequence.unique) {
      throw new DliDefError(
        m`${occ.type} の順序キー ${b.trim()} が重複しています`,
        file,
        line,
      );
    }
    if (b < a) {
      throw new DliDefError(
        m`${occ.type} の順序キー ${b.trim()} が ${a.trim()} より前にあります（階層順に並べてください）`,
        file,
        line,
      );
    }
  }
}

/** 長さを `BYTES=` に揃える。足りなければ空白詰め、長ければ切り捨て。 */
function fit(data: string, bytes: number): string {
  return data.padEnd(bytes).slice(0, bytes);
}

/** そのセグメントの配下にある全セグメント名。 */
function descendants(dbd: DbdDef, type: string): string[] {
  const out: string[] = [];
  const walk = (name: string): void => {
    for (const child of dbd.segments.get(name)?.children ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(type);
  return out;
}
