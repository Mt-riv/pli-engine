/**
 * IMS TM（メッセージキュー）と、PL/I から入出力 PCB を呼ぶ経路。
 *
 * 1 回の実行で処理するのは**キューに積まれた分だけ**。実機の MPP も
 * 同じで、`GU` がキューの次を取り、空になれば `QC` を返して終わる。
 * 画面との往復は実行の外側（1 入力 = 1 回の実行）で回す。
 *
 * 期待値の出どころは IBM の仕様文書（実機の出力ではない）。
 * ステータスコードの意味は次のとおり。
 *
 *   QC — キューにメッセージが無い（`GU`）
 *   QD — このメッセージにこれ以上セグメントが無い（`GN`）
 *   QE — `GU` より先に `GN` を出した
 *   AD — 機能コードが正しくない
 */
import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/host.js";
import { runProgram } from "../src/run.js";
import { julianDate, timeOfDay, TmRuntime, TmUnsupported } from "../src/tm/tm.js";
import { formatInput } from "../src/mfs/input.js";
import { loadMfs } from "../src/mfs/source.js";
import { formatOutput, systemLiteral } from "../src/mfs/output.js";
import { dayOfYear } from "../src/datetime.js";
import { fieldNamed, rowText } from "../src/mfs/device.js";

const PSB = `         PCB  TYPE=TP
         PSBGEN LANG=PLI,PSBNAME=INVPSB
         END
`;

const MFS = `INVFMT   FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE,PFK=(PFKEY,3='/EXIT     ')
         DIV   TYPE=INOUT
         DPAGE CURSOR=((5,20))
         DFLD  'ITEM:',POS=(5,10)
ITEMIN   DFLD  POS=(5,20),LTH=6,ATTR=(NUM,NOPROT,HI)
NAMEOUT  DFLD  POS=(7,20),LTH=20,ATTR=(ALPHA,PROT)
PFKEY    DFLD  POS=(24,2),LTH=10
         FMTEND
INVIN    MSG   TYPE=INPUT,SOR=(INVFMT,IGNORE),NXT=INVOUT
         SEG
         MFLD  (PFKEY,'INVQ      '),LTH=10
         MFLD  ITEMIN,LTH=6,JUST=R,FILL=C'0'
         MSGEND
INVOUT   MSG   TYPE=OUTPUT,SOR=(INVFMT,IGNORE),NXT=INVIN
         SEG
         MFLD  NAMEOUT,LTH=20
         MSGEND
`;

const SOURCE = `invq: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
  dcl 1 io_pcb based(io_ptr),
        2 lterm_name char(8),
        2 reserved1  char(2),
        2 stat_code  char(2),
        2 msg_date   fixed dec(7,0),
        2 msg_time   fixed dec(7,1),
        2 msg_seq    fixed bin(31),
        2 mod_name   char(8),
        2 user_id    char(8);
  dcl 1 msg_in,
        2 in_ll   fixed bin(15),
        2 in_zz   fixed bin(15),
        2 in_tran char(10),
        2 in_item char(6);
  dcl 1 msg_out,
        2 out_ll   fixed bin(15),
        2 out_zz   fixed bin(15),
        2 out_name char(20);
  dcl three fixed bin(31) init(3);
  dcl four  fixed bin(31) init(4);
  dcl func_gu   char(4) init('GU  ');
  dcl func_isrt char(4) init('ISRT');
  dcl modname   char(8) init('INVOUT  ');

  call plitdli(three, func_gu, io_pcb, msg_in);
  do while (io_pcb.stat_code = '  ');
    msg_out.out_name = 'ITEM=' || msg_in.in_item;
    msg_out.out_ll = 24;
    msg_out.out_zz = 0;
    call plitdli(four, func_isrt, io_pcb, msg_out, modname);
    call plitdli(three, func_gu, io_pcb, msg_in);
  end;
  put skip list(io_pcb.lterm_name, io_pcb.msg_seq, io_pcb.stat_code);
end invq;
`;

function run(tm: TmRuntime, source = SOURCE) {
  return runProgram(source, {
    host: new MemoryHost({ "INVPSB.psb": PSB }),
    psb: "INVPSB",
    tm,
  });
}

describe("キューの意味論", () => {
  it("GU はキューの次を取り、空になれば QC", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["A"] }, { segments: ["B"] }] });
    expect(tm.call("GU  ", undefined, undefined)).toEqual({ status: "  ", segment: "A" });
    expect(tm.call("GU  ", undefined, undefined)).toEqual({ status: "  ", segment: "B" });
    expect(tm.call("GU  ", undefined, undefined)).toEqual({ status: "QC" });
  });

  it("GN は同じメッセージの次のセグメント。尽きれば QD", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["S1", "S2"] }] });
    expect(tm.call("GU  ", undefined, undefined).segment).toBe("S1");
    expect(tm.call("GN  ", undefined, undefined).segment).toBe("S2");
    expect(tm.call("GN  ", undefined, undefined)).toEqual({ status: "QD" });
  });

  it("GU より先の GN は QE", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["S1"] }] });
    expect(tm.call("GN  ", undefined, undefined)).toEqual({ status: "QE" });
  });

  it("知らない機能コードは AD", () => {
    expect(new TmRuntime().call("XXXX", undefined, undefined)).toEqual({ status: "AD" });
  });

  it("名前は知っているが引き受けない呼び出しは名指しで断る", () => {
    expect(() => new TmRuntime().call("CHNG", undefined, undefined)).toThrow(TmUnsupported);
    expect(() => new TmRuntime().call("CHNG", undefined, undefined)).toThrow(/代替 PCB/);
  });

  it("ISRT は 1 つのメッセージに積まれ、GU が同期点になる", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["in1"] }, { segments: ["in2"] }] });
    tm.call("GU  ", undefined, undefined);
    tm.call("ISRT", "out1", "MODA    ");
    tm.call("ISRT", "out2", undefined);
    expect(tm.outputs).toHaveLength(0); // まだ送られていない
    tm.call("GU  ", undefined, undefined);
    expect(tm.outputs).toEqual([{ segments: ["out1", "out2"], modName: "MODA" }]);
  });

  it("PURG はそこまでを 1 つのメッセージとして送り出す", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["in"] }] });
    tm.call("GU  ", undefined, undefined);
    tm.call("ISRT", "a", "M1      ");
    tm.call("PURG", undefined, undefined);
    tm.call("ISRT", "b", "M2      ");
    tm.finish();
    expect(tm.outputs).toEqual([
      { segments: ["a"], modName: "M1" },
      { segments: ["b"], modName: "M2" },
    ]);
  });

  it("入出力 PCB の日付と時刻は渡した時刻から作る", () => {
    expect(julianDate(new Date(2026, 9, 10))).toBe(26283);
    expect(julianDate(new Date(2026, 0, 1))).toBe(26001);
    expect(timeOfDay(new Date(2026, 0, 1, 15, 4, 5, 600))).toBe(150405.6);
  });
});

describe("PL/I から入出力 PCB を呼ぶ", () => {
  it("GU → ISRT → QC で終わる", () => {
    const tm = new TmRuntime({
      lterm: "TERM0001",
      now: new Date(2026, 9, 10, 15, 4, 5),
      queue: [{ segments: ["INVQ      000042"], modName: "INVOUT" }],
    });
    const r = run(tm);
    expect(r.diagnostics).toEqual([]);
    tm.finish();
    expect(tm.outputs).toEqual([
      { segments: ["ITEM=000042         "], modName: "INVOUT" },
    ]);
  });

  it("入出力 PCB のマスクに端末名・通番・ステータスが入る", () => {
    const tm = new TmRuntime({
      lterm: "TERM0001",
      now: new Date(2026, 9, 10, 15, 4, 5),
      queue: [{ segments: ["INVQ      000042"] }, { segments: ["INVQ      000043"] }],
    });
    const r = run(tm);
    expect(r.stdout.trim().split(/\s+/)).toEqual(["TERM0001", "2", "QC"]);
  });

  it("LL の分だけが送られる（領域の後ろは切る）", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["INVQ      000042"] }] });
    const source = SOURCE.replace("msg_out.out_ll = 24;", "msg_out.out_ll = 9;");
    expect(run(tm, source).diagnostics).toEqual([]);
    tm.finish();
    expect(tm.outputs[0]!.segments).toEqual(["ITEM="]);
  });

  it("LL を入れ忘れたら名指しで断る", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["INVQ      000042"] }] });
    const source = SOURCE.replace("msg_out.out_ll = 24;", "msg_out.out_ll = 0;");
    const r = run(tm, source);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.message).toMatch(/セグメント長 LL/);
  });

  it("キューが空なら 1 回目の GU で QC（何も出さずに終わる）", () => {
    const tm = new TmRuntime({ lterm: "T", queue: [] });
    const r = run(tm);
    expect(r.diagnostics).toEqual([]);
    tm.finish();
    expect(tm.outputs).toEqual([]);
    expect(r.stdout).toContain("QC");
  });

  it("メッセージキューを渡さずに入出力 PCB を呼べば断る", () => {
    const r = runProgram(SOURCE, {
      host: new MemoryHost({ "INVPSB.psb": PSB }),
      psb: "INVPSB",
    });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.message).toMatch(/メッセージキューが必要/);
  });

  it("LL ZZ の無い領域を渡せば、宣言の形を示して断る", () => {
    const tm = new TmRuntime({ queue: [{ segments: ["X"] }] });
    const source = `p: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
  dcl 1 io_pcb based(io_ptr),
        2 lterm_name char(8), 2 reserved1 char(2), 2 stat_code char(2),
        2 msg_date fixed dec(7,0), 2 msg_time fixed dec(7,1),
        2 msg_seq fixed bin(31), 2 mod_name char(8), 2 user_id char(8);
  dcl area char(20);
  dcl three fixed bin(31) init(3);
  dcl func_gu char(4) init('GU  ');
  call plitdli(three, func_gu, io_pcb, area);
end p;
`;
    const r = run(tm, source);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.message).toMatch(/メッセージ I\/O 領域として使えません/);
  });
});

describe("入力の経路（DIF + MID → セグメント）", () => {
  const lib = () => loadMfs({ "INV.mfs": MFS });

  it("打ち込まれた項目がセグメントに並ぶ", () => {
    const segs = formatInput(lib(), "INVIN", {
      aid: { kind: "enter" },
      fields: new Map([["ITEMIN", "42"]]),
    });
    // 先頭 10 桁は MFLD の固定文字（トランザクションコード）
    // ITEMIN は JUST=R, FILL=C'0' なので右そろえで 0 詰め
    expect(segs).toEqual(["INVQ      000042"]);
  });

  it("変更されていない項目は FILL で埋まる", () => {
    const segs = formatInput(lib(), "INVIN", { aid: { kind: "enter" }, fields: new Map() });
    expect(segs).toEqual(["INVQ      000000"]);
  });

  it("PF キーの割り当ては、その項目の中身になる", () => {
    const segs = formatInput(lib(), "INVIN", {
      aid: { kind: "pf", n: 3 },
      fields: new Map([["ITEMIN", "1"]]),
    });
    expect(segs).toEqual(["/EXIT     000001"]);
  });

  it("FILL=NULL の項目は、入力が無ければセグメントから消える", () => {
    const l = loadMfs({
      "n.mfs":
        `F        FMT\n         DEV   TYPE=3270-A2\n         DIV   TYPE=INOUT\n` +
        `A        DFLD  POS=(1,2),LTH=4\nB        DFLD  POS=(2,2),LTH=4\n         FMTEND\n` +
        `M        MSG   TYPE=INPUT,SOR=F\n         SEG\n         MFLD  A,LTH=4,FILL=NULL\n` +
        `         MFLD  B,LTH=4\n         MSGEND\n`,
    });
    expect(formatInput(l, "M", { aid: { kind: "enter" }, fields: new Map([["B", "xy"]]) })).toEqual([
      "xy  ",
    ]);
    expect(
      formatInput(l, "M", { aid: { kind: "enter" }, fields: new Map([["A", "ab"], ["B", "xy"]]) }),
    ).toEqual(["ab  xy  "]);
  });

  it("MOD を MID として使おうとすれば断る", () => {
    expect(() =>
      formatInput(lib(), "INVOUT", { aid: { kind: "enter" }, fields: new Map() }),
    ).toThrow(/MOD/);
  });
});

/**
 * 通日（`yyddd` と `DATE1`）。
 *
 * 経過ミリ秒の床で求めていたので、夏時間のある地域では 1 時間ぶん
 * 足りず、0 時台の時刻で前日になっていた。`DATE2`（`getMonth()` 由来）
 * とは食い違うので、どちらが正しいかに関係なく**内部矛盾**だった。
 * 式は `src/datetime.ts` に 1 つだけ置いて両方が使う。
 */
describe("通日は時間帯と時刻に依らない", () => {
  const cases: [number, number, number, number][] = [
    [2026, 0, 1, 1],
    [2026, 9, 10, 283],
    [2026, 11, 31, 365],
    // 閏年
    [2024, 11, 31, 366],
    [2024, 2, 1, 61],
  ];

  it("暦の日付から求める", () => {
    for (const [y, m, d, want] of cases) {
      expect(dayOfYear(new Date(y, m, d)), `${y}-${m + 1}-${d}`).toBe(want);
      // 時刻を変えても同じ
      expect(dayOfYear(new Date(y, m, d, 0, 30)), `${y}-${m + 1}-${d} 00:30`).toBe(want);
      expect(dayOfYear(new Date(y, m, d, 23, 59)), `${y}-${m + 1}-${d} 23:59`).toBe(want);
    }
  });

  it("入出力 PCB の日付と DATE1 が食い違わない", () => {
    const d = new Date(2026, 9, 10, 0, 30);
    expect(julianDate(d)).toBe(26283);
    expect(systemLiteral("DATE1", { now: d, lterm: "T" })).toBe("26.283");
    expect(systemLiteral("DATE2", { now: d, lterm: "T" })).toBe("10/10/26");
  });
});

describe("端から端まで（入力 → プログラム → 画面）", () => {
  it("打ち込んだ値が画面に返る", () => {
    const l = loadMfs({ "INV.mfs": MFS });
    const segments = formatInput(l, "INVIN", {
      aid: { kind: "enter" },
      fields: new Map([["ITEMIN", "42"]]),
    });
    const tm = new TmRuntime({
      lterm: "TERM0001",
      now: new Date(2026, 9, 10, 15, 4, 5),
      queue: [{ mid: "INVIN", segments, modName: "INVOUT" }],
    });
    const r = run(tm);
    expect(r.diagnostics).toEqual([]);
    tm.finish();
    const out = tm.outputs[0]!;
    const screen = formatOutput(l, out.modName ?? "INVOUT", out.segments, {
      now: new Date(2026, 9, 10, 15, 4, 5),
      lterm: "TERM0001",
    });
    expect(fieldNamed(screen, "NAMEOUT")!.text).toBe("ITEM=000042         ");
    expect(rowText(screen, 7)).toBe("                   ITEM=000042");
    expect(screen.cursor).toEqual({ line: 5, col: 20 });
  });
});
