/**
 * 端末の操作を書いた台本。
 *
 * 画面入出力は人が打つものなので、そのままではテストに固定できない。
 * 打つ手順をテキストで書けるようにして、CLI とゴールデンテストの
 * 両方から同じものを使う。
 *
 *   MOD   INVOUT            最初に出す画面（端末で /FORMAT と打つ代わり）
 *   SPA   20                会話型トランザクションの SPA の長さ
 *   LTERM TERM0001          論理端末名
 *   NOW   2026-10-10T15:04:05   時刻（書かないと固定できない）
 *   ITEMIN=42               項目に打ち込む
 *   ENTER                   送る
 *   PF3                     PF キーで送る
 *   NEXT                    溜まっている次のメッセージを出す
 *
 * 行頭の `*` と `#` は注釈。
 */

import { DefError } from "../macro.js";
import { renderScreen, type RenderOptions } from "../mfs/render.js";
import { aidName, type Aid, type DeviceInput } from "../mfs/input.js";
import { Session, type SessionOptions, type SessionStep } from "./session.js";

/** 台本の書き方の誤り。 */
export class KeyScriptError extends DefError {
  constructor(message: string, file: string, line: number) {
    super(message, file, line, "KeyScriptError");
  }
}

export type KeyStep =
  | { kind: "set"; field: string; text: string }
  | { kind: "submit"; aid: Aid }
  | { kind: "next" };

export interface KeyScript {
  mod?: string;
  spa?: number;
  lterm?: string;
  userid?: string;
  now?: Date;
  steps: KeyStep[];
}

/** 台本を読む。 */
export function parseKeys(text: string, file: string): KeyScript {
  const script: KeyScript = { steps: [] };
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("*") || line.startsWith("#")) continue;
    const at = i + 1;
    const eq = line.indexOf("=");
    if (eq > 0) {
      script.steps.push({
        kind: "set",
        field: line.slice(0, eq).trim().toUpperCase(),
        text: line.slice(eq + 1),
      });
      continue;
    }
    const [word, ...rest] = line.split(/\s+/);
    const operand = rest.join(" ");
    const upper = (word ?? "").toUpperCase();
    switch (upper) {
      case "MOD":
      case "SPA":
      case "LTERM":
      case "USERID":
      case "NOW": {
        if (operand === "") throw new KeyScriptError(`${upper} に値がありません`, file, at);
        if (upper === "MOD") script.mod = operand.toUpperCase();
        else if (upper === "LTERM") script.lterm = operand;
        else if (upper === "USERID") script.userid = operand;
        else if (upper === "SPA") {
          const n = Number(operand);
          if (!Number.isInteger(n) || n <= 4) {
            throw new KeyScriptError(`SPA ${operand} は 5 以上の整数ではありません`, file, at);
          }
          script.spa = n;
        } else {
          // 日付だけの形（`2026-10-10`）は、JS の規則で **UTC 0 時**として
          // 読まれる。負のオフセットの地域では前日になり、`DATE2` が
          // 1 日ずれるので、年月日を地方時として組み立てる
          const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(operand);
          const d =
            ymd === null
              ? new Date(operand)
              : new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
          if (Number.isNaN(d.getTime())) {
            throw new KeyScriptError(`NOW ${operand} は日時として読めません`, file, at);
          }
          script.now = d;
        }
        break;
      }
      case "ENTER":
        script.steps.push({ kind: "submit", aid: { kind: "enter" } });
        break;
      case "CLEAR":
        script.steps.push({ kind: "submit", aid: { kind: "clear" } });
        break;
      case "NEXT":
        script.steps.push({ kind: "next" });
        break;
      default: {
        const m = /^(PF|PA)(\d{1,2})$/.exec(upper);
        if (m === null) throw new KeyScriptError(`${word} は台本の命令ではありません`, file, at);
        const n = Number(m[2]);
        const limit = m[1] === "PF" ? 24 : 3;
        if (n < 1 || n > limit) {
          throw new KeyScriptError(`${upper} は 1〜${limit} の外です`, file, at);
        }
        script.steps.push({
          kind: "submit",
          aid: m[1] === "PF" ? { kind: "pf", n } : { kind: "pa", n },
        });
      }
    }
  }
  return script;
}

/** 1 手ごとの結果。 */
export interface Playback {
  /** 何をしたか（`開始` / `ENTER` / `PF3` / `NEXT`）。 */
  label: string;
  /** 打ち込んだ項目。 */
  typed: Map<string, string>;
  step: SessionStep;
}

export interface PlaybackOptions
  extends Omit<SessionOptions, "mod" | "spa" | "lterm" | "userid" | "now"> {
  script: KeyScript;
  /** 台本に `NOW` が無いときに使う時刻。 */
  now?: Date;
}

/** 台本どおりに動かす。 */
export function playKeys(opts: PlaybackOptions): { session: Session; steps: Playback[] } {
  const { script } = opts;
  const now = script.now ?? opts.now ?? new Date(0);
  const session = new Session({
    source: opts.source,
    library: opts.library,
    host: opts.host,
    psb: opts.psb,
    ...(script.mod === undefined ? {} : { mod: script.mod }),
    ...(script.spa === undefined ? {} : { spa: script.spa }),
    ...(script.lterm === undefined ? {} : { lterm: script.lterm }),
    ...(script.userid === undefined ? {} : { userid: script.userid }),
    now: () => now,
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
  });
  const steps: Playback[] = [{ label: "開始", typed: new Map(), step: session.start() }];
  let typed = new Map<string, string>();
  for (const s of script.steps) {
    if (s.kind === "set") {
      typed.set(s.field, s.text);
      continue;
    }
    if (s.kind === "next") {
      steps.push({ label: "NEXT", typed: new Map(), step: session.next() });
      continue;
    }
    const input: DeviceInput = { aid: s.aid, fields: typed };
    steps.push({ label: aidName(s.aid), typed, step: session.send(input) });
    typed = new Map();
  }
  return { session, steps };
}

/**
 * 動かした結果をテキストにする。
 *
 * ゴールデンテストはこれを**バイト一致**で比べる。差分がそのまま
 * 原因を指すように、画面像・通知・標準出力・診断を 1 本にまとめる。
 */
export function transcript(steps: readonly Playback[], opts: RenderOptions = {}): string {
  const out: string[] = [];
  for (const { label, typed, step } of steps) {
    const keys = [...typed].map(([k, v]) => `${k}=${v}`).join(" ");
    out.push(`### ${label}${keys === "" ? "" : ` ${keys}`}`);
    if (step.screen !== undefined) out.push(renderScreen(step.screen, opts).replace(/\n$/, ""));
    if (step.notice !== undefined) out.push(`通知 ${step.notice}`);
    if (step.queued > 0) out.push(`未出力のメッセージ ${step.queued} 件`);
    const stdout = step.stdout.replace(/\n$/, "");
    if (stdout !== "") out.push("標準出力", stdout);
    for (const d of step.diagnostics) out.push(`診断 ${d.line} 行: ${d.message}`);
  }
  return out.join("\n") + "\n";
}
