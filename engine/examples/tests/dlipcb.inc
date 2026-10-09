/* DB PCB マスク。DL/I の応答がここに入る。
   項目の名前は自由だが、並びと桁は規定のとおりでなければならない。
   PSB の PCB が 1 つだけなので BASED にせず、そのまま渡せる。 */
dcl 1 pcb,
      2 dbname     char(8),
      2 seg_level  char(2),
      2 stat_code  char(2),
      2 proc_opt   char(4),
      2 reserved   fixed bin(31),
      2 seg_name   char(8),
      2 len_kfb    fixed bin(31),
      2 no_senseg  fixed bin(31),
      2 key_fb     char(9);
