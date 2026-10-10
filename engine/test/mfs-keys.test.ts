/**
 * 端末の操作を書いた台本（`tm/keys.ts`）。
 *
 * 画面入出力は人が打つものなので、そのままではテストに固定できない。
 * 台本にして CLI とゴールデンテストの両方から同じものを使う。
 */
import { describe, expect, it } from "vitest";
import { KeyScriptError, parseKeys, playKeys, transcript } from "../src/tm/keys.js";
import { loadMfs } from "../src/mfs/source.js";
import { MemoryHost } from "../src/host.js";

describe("台本を読む", () => {
  it("設定と手順を分けて読む", () => {
    const s = parseKeys(
      `* 注釈
# これも注釈
MOD   INVOUT
SPA   20
LTERM TERM0001
USERID USER1
NOW   2026-10-10T15:04:05
ITEMIN=42
ENTER
PF3
PA1
CLEAR
NEXT
`,
      "k.keys",
    );
    expect(s.mod).toBe("INVOUT");
    expect(s.spa).toBe(20);
    expect(s.lterm).toBe("TERM0001");
    expect(s.userid).toBe("USER1");
    expect(s.now?.getFullYear()).toBe(2026);
    expect(s.steps).toEqual([
      { kind: "set", field: "ITEMIN", text: "42" },
      { kind: "submit", aid: { kind: "enter" } },
      { kind: "submit", aid: { kind: "pf", n: 3 } },
      { kind: "submit", aid: { kind: "pa", n: 1 } },
      { kind: "submit", aid: { kind: "clear" } },
      { kind: "next" },
    ]);
  });

  it("項目名は大文字にそろえ、値はそのまま持つ", () => {
    const s = parseKeys("itemin=  42  \n", "k.keys");
    expect(s.steps[0]).toEqual({ kind: "set", field: "ITEMIN", text: "  42" });
  });

  it("誤りは行番号付きで断る", () => {
    expect(() => parseKeys("MOD\n", "k.keys")).toThrow(/MOD に値がありません/);
    expect(() => parseKeys("ENTER\nFOO\n", "k.keys")).toThrow(/FOO は台本の命令ではありません/);
    expect(() => parseKeys("PF25\n", "k.keys")).toThrow(/PF25 は 1〜24 の外です/);
    expect(() => parseKeys("PA4\n", "k.keys")).toThrow(/PA4 は 1〜3 の外です/);
    expect(() => parseKeys("SPA 2\n", "k.keys")).toThrow(/5 以上の整数ではありません/);
    expect(() => parseKeys("NOW きのう\n", "k.keys")).toThrow(/日時として読めません/);
    try {
      parseKeys("ENTER\nNOW\n", "k.keys");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KeyScriptError);
      expect((e as KeyScriptError).line).toBe(2);
    }
  });
});

describe("台本どおりに動かす", () => {
  const MFS = `F        FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE
         DIV   TYPE=INOUT
         DPAGE CURSOR=((2,10))
A        DFLD  POS=(2,10),LTH=4,ATTR=(ALPHA,NOPROT)
T        DFLD  POS=(24,2),LTH=8
         FMTEND
MI       MSG   TYPE=INPUT,SOR=(F,IGNORE),NXT=MO
         SEG
         MFLD  (T,'ECHO    '),LTH=8
         MFLD  A,LTH=4
         MSGEND
MO       MSG   TYPE=OUTPUT,SOR=(F,IGNORE),NXT=MI
         SEG
         MFLD  A,LTH=4
         MSGEND
`;
  const PSB = `         PCB  TYPE=TP
         PSBGEN LANG=PLI,PSBNAME=P
         END
`;
  const SRC = `p: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
  dcl 1 io_pcb based(io_ptr),
        2 lterm_name char(8), 2 reserved1 char(2), 2 stat_code char(2),
        2 msg_date fixed dec(7,0), 2 msg_time fixed dec(7,1),
        2 msg_seq fixed bin(31), 2 mod_name char(8), 2 user_id char(8);
  dcl 1 msg_in, 2 i_ll fixed bin(15), 2 i_zz fixed bin(15),
        2 i_tran char(8), 2 i_a char(4);
  dcl 1 msg_out, 2 o_ll fixed bin(15), 2 o_zz fixed bin(15), 2 o_a char(4);
  dcl three fixed bin(31) init(3);
  dcl four fixed bin(31) init(4);
  dcl func_gu char(4) init('GU  ');
  dcl func_isrt char(4) init('ISRT');
  dcl modname char(8) init('MO      ');
  call plitdli(three, func_gu, io_pcb, msg_in);
  do while (io_pcb.stat_code = '  ');
    msg_out.o_a = msg_in.i_a;
    msg_out.o_ll = 8;
    msg_out.o_zz = 0;
    call plitdli(four, func_isrt, io_pcb, msg_out, modname);
    call plitdli(three, func_gu, io_pcb, msg_in);
  end;
end p;
`;

  const play = (keys: string) =>
    playKeys({
      source: SRC,
      library: loadMfs({ "f.mfs": MFS }),
      host: new MemoryHost({ "P.psb": PSB }),
      psb: "P",
      script: parseKeys(keys, "k.keys"),
    });

  it("打ち込んで送ると画面が返る", () => {
    const { steps } = play("MOD MO\nNOW 2026-10-10T00:00:00\nA=xy\nENTER\n");
    expect(steps).toHaveLength(2);
    expect(steps[1]!.step.ok).toBe(true);
    expect(steps[1]!.step.screen?.fields.find((f) => f.name === "A")?.text).toBe("xy  ");
  });

  it("記録はバイト一致で比べられる形になる", () => {
    const { steps } = play("MOD MO\nNOW 2026-10-10T00:00:00\nA=xy\nENTER\n");
    const text = transcript(steps);
    expect(text).toContain("### 開始\n");
    expect(text).toContain("### ENTER A=xy\n");
    expect(text).toContain(" 2 |         xy\n");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("台本に NOW が無ければ呼ぶ側の時刻を使う", () => {
    const r = playKeys({
      source: SRC,
      library: loadMfs({ "f.mfs": MFS }),
      host: new MemoryHost({ "P.psb": PSB }),
      psb: "P",
      script: parseKeys("MOD MO\nENTER\n", "k.keys"),
      now: new Date(2026, 0, 2),
    });
    expect(r.steps[1]!.step.ok).toBe(true);
  });
});
