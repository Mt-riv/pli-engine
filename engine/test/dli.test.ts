/**
 * DL/I（IMS/DB）呼び出しの入口。
 *
 * `CALL PLITDLI(...)` は外部手続きではなく処理系が受け持つ。
 * ここではまず「呼び出しが処理系に届くか」だけを確かめる。
 */

import { describe, it, expect } from "vitest";
import { runProgram } from "../src/run.js";
import { MemoryHost } from "../src/host.js";

/** PCB マスクの規定の並び。DL/I を使うテストはこれを使う。 */
const PCB_MASK = `  dcl 1 db_pcb based(db_ptr),
        2 dbname     char(8),
        2 seg_level  char(2),
        2 stat_code  char(2),
        2 proc_opt   char(4),
        2 reserved   fixed bin(31),
        2 seg_name   char(8),
        2 len_kfb    fixed bin(31),
        2 no_senseg  fixed bin(31),
        2 key_fb     char(20);`;

describe("DL/I 呼び出しの入口", () => {
  it("PSB を指定せずに CALL PLITDLI すると、PSB が無いことを知らせる", () => {
    const src = `p: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl four fixed bin(31) init(4);
  dcl func char(4) init('GU  ');
  dcl seg_io char(80);
${PCB_MASK}
  call plitdli(four, func, db_pcb, seg_io);
end p;`;
    const r = runProgram(src, { host: new MemoryHost() });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toContain("PSB");
  });

  it("PLITDLI と同じ名前の手続きを自分で書いたら、そちらが呼ばれる", () => {
    const src = `p: proc options(main);
  call plitdli;
  plitdli: proc;
    put list('MINE');
  end plitdli;
end p;`;
    const r = runProgram(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.stdout).toBe("MINE \n");
  });

  it("PLITDLI でない未定義の手続きは、従来どおりのメッセージになる", () => {
    const r = runProgram(`p: proc options(main);
  call nosuch;
end p;`);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]!.message).toBe("手続き nosuch が見つかりません");
  });
});
