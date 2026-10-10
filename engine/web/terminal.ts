/**
 * ブラウザの端末。24×80 の画面を出し、打ち込めるようにする。
 *
 * 本物の 3270 のデータストリームは作らない（`src/mfs/device.ts` の
 * 冒頭に理由がある）。ここがやるのは
 *
 *   - 画面の文字を等幅の面として出す（保護された項目と固定文字）
 *   - 打ち込める項目の上に入力欄を重ねる（位置は `ch` で合わせる）
 *   - 押したキー（ENTER / PF / PA / CLEAR）と、打ち込んだ値を渡す
 *
 * 外部ライブラリは使わない。CDN への接続が要ると、オフラインで
 * 動かなくなり「HTML 1 枚で配れる」形が壊れる。
 */

import { cells, type Screen, type ScreenField } from "../src/index.js";
import type { Aid } from "../src/index.js";

/** 1 文字分の高さ（px）。CSS の line-height と合わせる。 */
const CELL_H = 17;

/**
 * HTML に埋める文字を無害にする。
 *
 * 画面の中身・書式の名前・通知の文面には、プログラムが決めた文字列
 * （`ISRT` に渡した MOD 名など）がそのまま入る。`innerHTML` に渡す値は
 * 必ずこれを通す。大文字化は防壁にならない（`&#97;` のような数値文字参照は
 * 大文字化を素通りして `innerHTML` 代入時に復号される）。
 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const esc = escapeHtml;

/** その行に重なる項目を、桁ごとの印にする。 */
function marksOf(screen: Screen, line: number): (ScreenField | undefined)[] {
  const marks: (ScreenField | undefined)[] = Array.from({ length: screen.cols });
  for (const f of screen.fields) {
    if (f.attr.display === "none") continue;
    const start = (f.line - 1) * screen.cols + (f.col - 1);
    for (let i = 0; i < f.length; i++) {
      const addr = start + i;
      const row = Math.floor(addr / screen.cols) + 1;
      if (row !== line) continue;
      marks[addr % screen.cols] = f;
    }
  }
  return marks;
}

export class Terminal {
  /** 打ち込まれた値（項目名 → 中身）。送るたびに空にする。 */
  private readonly typed = new Map<string, string>();
  private onSubmit: (aid: Aid, fields: Map<string, string>) => void = () => {};

  constructor(private readonly root: HTMLElement) {}

  /** 送信のときに呼ばれる手続きを登録する。 */
  listen(fn: (aid: Aid, fields: Map<string, string>) => void): void {
    this.onSubmit = fn;
  }

  /** 打ち込まれた値。 */
  values(): Map<string, string> {
    return new Map(this.typed);
  }

  /** 送る。打ち込んだ値を渡し、控えを空にする。 */
  submit(aid: Aid): void {
    const fields = new Map(this.typed);
    this.typed.clear();
    this.onSubmit(aid, fields);
  }

  /** 画面を出す。 */
  render(screen: Screen | undefined): void {
    this.typed.clear();
    this.root.textContent = "";
    if (screen === undefined) {
      this.root.textContent = "画面はまだありません。";
      return;
    }
    const board = document.createElement("div");
    board.className = "board";
    board.style.width = `${screen.cols}ch`;

    const grid = cells(screen);
    const rows: string[] = [];
    for (let line = 1; line <= screen.rows; line++) {
      const marks = marksOf(screen, line);
      const chars = grid[line - 1] ?? [];
      let html = "";
      let run = "";
      let runClass = "";
      const flush = () => {
        if (run === "") return;
        html += runClass === "" ? esc(run) : `<span class="${runClass}">${esc(run)}</span>`;
        run = "";
      };
      for (let col = 1; col <= screen.cols; col++) {
        const f = marks[col - 1];
        // 打ち込める項目は入力欄が受け持つので、面には出さない
        const hidden = f !== undefined && !f.attr.protect && f.name !== undefined;
        const cls = f === undefined ? "" : f.attr.display === "hi" ? "hi" : "";
        const ch = hidden ? " " : (chars[col - 1] ?? " ");
        if (cls !== runClass) {
          flush();
          runClass = cls;
        }
        run += ch;
      }
      flush();
      rows.push(html);
    }
    const pre = document.createElement("pre");
    pre.innerHTML = rows.join("\n");
    board.appendChild(pre);

    for (const f of screen.fields) {
      if (f.attr.protect || f.name === undefined || f.attr.display === "none") continue;
      board.appendChild(this.inputFor(f, screen));
    }
    this.root.appendChild(board);

    // カーソルの位置にある項目へ焦点を移す
    const at = screen.fields.find(
      (f) =>
        !f.attr.protect &&
        f.name !== undefined &&
        f.line === screen.cursor.line &&
        f.col === screen.cursor.col,
    );
    if (at?.name !== undefined) {
      const el = board.querySelector<HTMLInputElement>(`input[data-name="${at.name}"]`);
      el?.focus();
      el?.setSelectionRange(0, 0);
    }
  }

  private inputFor(f: ScreenField, screen: Screen): HTMLInputElement {
    const el = document.createElement("input");
    el.type = "text";
    el.className = `fld${f.attr.display === "hi" ? " hi" : ""}`;
    el.dataset.name = f.name ?? "";
    el.value = f.text.replace(/ +$/, "");
    el.maxLength = f.length;
    el.size = f.length;
    el.spellcheck = false;
    el.autocomplete = "off";
    el.setAttribute("aria-label", `${f.name ?? ""}（${f.line} 行 ${f.col} 桁）`);
    if (f.attr.numeric) el.inputMode = "numeric";
    el.style.left = `${f.col - 1}ch`;
    el.style.top = `${(f.line - 1) * CELL_H}px`;
    el.style.width = `${f.length}ch`;
    el.addEventListener("input", () => {
      if (f.name !== undefined) this.typed.set(f.name, el.value);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.submit({ kind: "enter" });
    });
    // 画面の外へはみ出す項目は作らない（位置が合わなくなる）
    if (f.line > screen.rows) el.classList.add("hidden");
    return el;
  }
}

/** PF / PA キーの一覧（選べる形にするため）。 */
export function functionKeys(): { label: string; aid: Aid }[] {
  const out: { label: string; aid: Aid }[] = [];
  for (let n = 1; n <= 24; n++) out.push({ label: `PF${n}`, aid: { kind: "pf", n } });
  for (let n = 1; n <= 3; n++) out.push({ label: `PA${n}`, aid: { kind: "pa", n } });
  out.push({ label: "CLEAR", aid: { kind: "clear" } });
  return out;
}
