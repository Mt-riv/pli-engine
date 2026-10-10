/**
 * 画面との往復（`tm/session.ts`）。
 *
 * **1 回の入力 = 1 回のプログラム実行。** 実機の MPP と同じ形なので、
 * 実行器を止めて人の入力を待つ必要がない。引き継がれるのは
 * データベース（ホスト）・会話の状態（SPA）・次に読む書式（`NXT=`）だけ。
 *
 * 期待値の出どころは IBM の仕様文書（実機の出力ではない）。
 * SPA の形は `LL`(2) + `ZZZZ`(4) + トランザクションコード(8) + 作業域。
 * 先頭 6 バイトはプログラムが触ってはならないと規定されている。
 */
import { describe, expect, it } from "vitest";
import { MemoryHost } from "../src/host.js";
import { loadMfs } from "../src/mfs/source.js";
import { fieldNamed } from "../src/mfs/device.js";
import { Session, firstWord } from "../src/tm/session.js";

const PSB = `         PCB  TYPE=TP
         PSBGEN LANG=PLI,PSBNAME=INVPSB
         END
`;

const MFS = `INVFMT   FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE,PFK=(PFKEY,3='/FOR OTHER. ')
         DIV   TYPE=INOUT
         DPAGE CURSOR=((5,20))
         DFLD  'ITEM:',POS=(5,10)
ITEMIN   DFLD  POS=(5,20),LTH=6,ATTR=(NUM,NOPROT,HI)
NAMEOUT  DFLD  POS=(7,20),LTH=20,ATTR=(ALPHA,PROT)
PFKEY    DFLD  POS=(24,2),LTH=12
         FMTEND
OTHFMT   FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE
         DIV   TYPE=INOUT
         DFLD  'MENU',POS=(2,2)
CHOICE   DFLD  POS=(4,2),LTH=4,ATTR=(ALPHA,NOPROT)
         FMTEND
INVIN    MSG   TYPE=INPUT,SOR=(INVFMT,IGNORE),NXT=INVOUT
         SEG
         MFLD  (PFKEY,'INVQ        '),LTH=12
         MFLD  ITEMIN,LTH=6,JUST=R,FILL=C'0'
         MSGEND
INVOUT   MSG   TYPE=OUTPUT,SOR=(INVFMT,IGNORE),NXT=INVIN
         SEG
         MFLD  NAMEOUT,LTH=20
         MSGEND
OTHIN    MSG   TYPE=INPUT,SOR=(OTHFMT,IGNORE),NXT=OTHER
         SEG
         MFLD  CHOICE,LTH=4
         MSGEND
OTHER    MSG   TYPE=OUTPUT,SOR=(OTHFMT,IGNORE),NXT=OTHIN
         SEG
         MFLD  CHOICE,LTH=4
         MSGEND
`;

const PCB_MASK = `  dcl 1 io_pcb based(io_ptr),
        2 lterm_name char(8),
        2 reserved1  char(2),
        2 stat_code  char(2),
        2 msg_date   fixed dec(7,0),
        2 msg_time   fixed dec(7,1),
        2 msg_seq    fixed bin(31),
        2 mod_name   char(8),
        2 user_id    char(8);`;

/** 1 件取って 1 件返すだけのプログラム。 */
const ECHO = `invq: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
${PCB_MASK}
  dcl 1 msg_in,
        2 in_ll   fixed bin(15),
        2 in_zz   fixed bin(15),
        2 in_tran char(12),
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
end invq;
`;

const NOW = () => new Date(2026, 9, 10, 15, 4, 5);

function session(source = ECHO, extra: Record<string, unknown> = {}) {
  return new Session({
    source,
    library: loadMfs({ "INV.mfs": MFS }),
    host: new MemoryHost({ "INVPSB.psb": PSB }),
    psb: "INVPSB",
    mod: "INVOUT",
    lterm: "TERM0001",
    now: NOW,
    ...extra,
  });
}

const enter = (fields: Record<string, string> = {}) => ({
  aid: { kind: "enter" } as const,
  fields: new Map(Object.entries(fields)),
});

describe("最初の画面", () => {
  it("MOD の名前で画面を出し、次に読む MID が決まる", () => {
    const s = session();
    const step = s.start();
    expect(step.ok).toBe(true);
    expect(step.screen?.format).toBe("INVFMT");
    expect(s.inputFormat).toBe("INVIN");
  });

  it("MOD の名前を与えなければ、そう言う", () => {
    const s = session(ECHO, { mod: undefined });
    expect(s.start().notice).toMatch(/最初に出す書式/);
    expect(s.start().ok).toBe(false);
  });

  it("画面を出す前に打ち込めば、そう言う", () => {
    const s = session(ECHO, { mod: undefined });
    expect(s.send(enter()).notice).toMatch(/入力の書式が決まっていません/);
  });
});

describe("1 回の入力 = 1 回の実行", () => {
  it("打ち込んだ値が次の画面に返る", () => {
    const s = session();
    s.start();
    const step = s.send(enter({ ITEMIN: "42" }));
    expect(step.ok).toBe(true);
    expect(fieldNamed(step.screen!, "NAMEOUT")!.text).toBe("ITEM=000042         ");
  });

  it("何度でも続けられる（毎回プログラムを頭から動かす）", () => {
    const s = session();
    s.start();
    s.send(enter({ ITEMIN: "1" }));
    const step = s.send(enter({ ITEMIN: "2" }));
    expect(fieldNamed(step.screen!, "NAMEOUT")!.text).toBe("ITEM=000002         ");
  });

  it("PF キーの割り当てが /FORMAT なら、そのまま書式が変わる", () => {
    const s = session();
    s.start();
    const step = s.send({ aid: { kind: "pf", n: 3 }, fields: new Map() });
    expect(step.screen?.format).toBe("OTHFMT");
    expect(s.inputFormat).toBe("OTHIN");
  });

  it("知らないコマンドは断る（画面は変わらない）", () => {
    const s = session();
    s.start();
    const step = s.send(enter({ PFKEY: "/DIS.       " }));
    expect(step.notice).toMatch(/コマンド \/DIS は未実装/);
    expect(step.screen?.format).toBe("INVFMT");
  });

  it("プログラムが落ちれば診断が返る（画面はそのまま）", () => {
    const s = session(ECHO.replace("msg_out.out_ll = 24;", "msg_out.out_ll = 0;"));
    s.start();
    const step = s.send(enter({ ITEMIN: "42" }));
    expect(step.ok).toBe(false);
    expect(step.diagnostics[0]!.message).toMatch(/セグメント長 LL/);
  });

  it("画面を返さないプログラムなら、そう言う", () => {
    const quiet = `p: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
${PCB_MASK}
  dcl 1 msg_in, 2 in_ll fixed bin(15), 2 in_zz fixed bin(15), 2 in_rest char(18);
  dcl three fixed bin(31) init(3);
  dcl func_gu char(4) init('GU  ');
  call plitdli(three, func_gu, io_pcb, msg_in);
  put skip list('なにもしない');
end p;
`;
    const s = session(quiet);
    s.start();
    const step = s.send(enter({ ITEMIN: "42" }));
    expect(step.notice).toMatch(/画面を返しませんでした/);
    expect(step.stdout).toContain("なにもしない");
  });
});

describe("出力が複数あるとき", () => {
  const twice = ECHO.replace(
    "call plitdli(four, func_isrt, io_pcb, msg_out, modname);",
    `call plitdli(four, func_isrt, io_pcb, msg_out, modname);
    call plitdli(two, func_purg, io_pcb);
    msg_out.out_name = 'SECOND';
    call plitdli(four, func_isrt, io_pcb, msg_out, modname);`,
  ).replace(
    "dcl modname   char(8) init('INVOUT  ');",
    "dcl modname   char(8) init('INVOUT  ');\n  dcl two fixed bin(31) init(2);\n  dcl func_purg char(4) init('PURG');",
  );

  it("最初の 1 つを出し、残りは溜める", () => {
    const s = session(twice);
    s.start();
    const step = s.send(enter({ ITEMIN: "7" }));
    expect(fieldNamed(step.screen!, "NAMEOUT")!.text).toBe("ITEM=000007         ");
    expect(step.queued).toBe(1);
  });

  it("次を求めれば次が出る", () => {
    const s = session(twice);
    s.start();
    s.send(enter({ ITEMIN: "7" }));
    const step = s.next();
    expect(fieldNamed(step.screen!, "NAMEOUT")!.text).toBe("SECOND              ");
    expect(step.queued).toBe(0);
    expect(s.next().notice).toMatch(/次のメッセージはありません/);
  });
});

describe("会話型（SPA）", () => {
  // SPA は LL(2) + ZZZZ(4) + トランザクションコード(8) + 作業域(6) = 20
  const CONV = `conv: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
${PCB_MASK}
  dcl 1 spa,
        2 s_ll   fixed bin(15),
        2 s_zz   fixed bin(15),
        2 s_zz2  char(2),
        2 s_tran char(8),
        2 s_save char(6);
  dcl 1 msg_in,
        2 in_ll   fixed bin(15),
        2 in_zz   fixed bin(15),
        2 in_tran char(12),
        2 in_item char(6);
  dcl 1 msg_out,
        2 out_ll   fixed bin(15),
        2 out_zz   fixed bin(15),
        2 out_name char(20);
  dcl three fixed bin(31) init(3);
  dcl four  fixed bin(31) init(4);
  dcl func_gu   char(4) init('GU  ');
  dcl func_gn   char(4) init('GN  ');
  dcl func_isrt char(4) init('ISRT');
  dcl modname   char(8) init('INVOUT  ');
  call plitdli(three, func_gu, io_pcb, spa);
  call plitdli(three, func_gn, io_pcb, msg_in);
  msg_out.out_name = 'PREV=' || spa.s_save;
  spa.s_save = msg_in.in_item;
  /* MID が JUST=R, FILL=C'0' なので 'END' は '000END' で届く */
  if msg_in.in_item = '000END' then spa.s_tran = ' ';
  spa.s_ll = 20;
  spa.s_zz = 0;
  msg_out.out_ll = 24;
  msg_out.out_zz = 0;
  call plitdli(three, func_isrt, io_pcb, spa);
  call plitdli(four, func_isrt, io_pcb, msg_out, modname);
end conv;
`;

  it("SPA に書いた値が次の入力に戻る", () => {
    const s = session(CONV, { spa: 20 });
    s.start();
    const first = s.send(enter({ ITEMIN: "11" }));
    expect(fieldNamed(first.screen!, "NAMEOUT")!.text).toBe("PREV=               ");
    expect(s.inConversation).toBe(true);
    const second = s.send(enter({ ITEMIN: "22" }));
    expect(fieldNamed(second.screen!, "NAMEOUT")!.text).toBe("PREV=000011         ");
  });

  it("トランザクションコードを空白にすれば会話が終わる", () => {
    const s = session(CONV, { spa: 20 });
    s.start();
    s.send(enter({ ITEMIN: "11" }));
    expect(s.inConversation).toBe(true);
    s.send({ aid: { kind: "enter" }, fields: new Map([["ITEMIN", "END"]]) });
    expect(s.inConversation).toBe(false);
  });

  it("SPA の設定が無いと、SPA の ISRT が画面用のセグメントになって断られる", () => {
    // 会話型のプログラムは最初に SPA を ISRT する。SPA の長さを
    // 与えていないと、こちら側はそれを画面用のセグメントとして扱う
    const s = session(CONV);
    s.start();
    const step = s.send(enter({ ITEMIN: "11" }));
    expect(step.ok).toBe(false);
    expect(step.notice).toMatch(/1 個ですが、2 個 ISRT/);
  });
});

describe("小道具", () => {
  it("先頭の語を取る（空白とカンマで切る）", () => {
    expect(firstWord("INVQ      000042")).toBe("INVQ");
    expect(firstWord("/FOR OTHER")).toBe("/FOR");
    expect(firstWord("   ")).toBe("");
  });
});
