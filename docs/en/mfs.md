# Screen I/O (MFS)

[日本語](../mfs.md) | **English**

From PL/I you can read and write a **3270 screen**. You do not have to install
IMS. The format definitions (`*.mfs`) are text; in the browser version you
write them in the Files box and open the Terminal.

```
INVFMT   FMT
         DEV   TYPE=3270-A2,FEAT=IGNORE
         DIV   TYPE=INOUT
         DPAGE CURSOR=((5,20))
         DFLD  'ITEM NO:',POS=(5,10),ATTR=(ALPHA,PROT)
ITEMIN   DFLD  POS=(5,20),LTH=6,ATTR=(NUM,NOPROT,HI)
NAMEOUT  DFLD  POS=(7,20),LTH=20,ATTR=(ALPHA,PROT)
PFKEY    DFLD  POS=(24,2),LTH=12
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
```

**The program knows nothing about the screen.** All it reads and writes is a
segment (`LL ZZ` and the data); which column holds what is decided by the
format definitions. That is what MFS is for.

## The four control blocks

| Block | Full name | What it does | Which statements build it |
|---------|-------|------|--------------------|
| **MID** | Message Input Descriptor | turns what came from the device into what the program sees | `MSG TYPE=INPUT` … `MSGEND` |
| **MOD** | Message Output Descriptor | spreads what the program wrote out towards the device | `MSG TYPE=OUTPUT` … `MSGEND` |
| **DIF** | Device Input Format | the shape of the data coming from the device | `DIV TYPE=INPUT` / `INOUT` inside a `FMT` |
| **DOF** | Device Output Format | the shape of the screen sent to the device | `DIV TYPE=OUTPUT` / `INOUT` inside a `FMT` |

The four make one set. With `DIV TYPE=INOUT` (the usual thing for a 3270
display) one `FMT` produces both the DIF and the DOF.

```
input    terminal → [DIF] position→field → [MID] field→segment → GU / GN
output   ISRT → [MOD] segment→field → [DOF] field→position → screen → terminal
```

## One input = one run of the program

**The program is not alive between screens.** As in a real MPP, `GU` takes the
next message off the queue, the program processes it, returns it with `ISRT`,
and when the queue is empty `QC` comes back and it ends.

Only these three carry over.

| What carries over | Who holds it |
|----------------|-------|
| The contents of the database | the host (written back at the end of the run) |
| The state of the conversation | the SPA. **IMS holds it, not the program** |
| Which format is read next | the `NXT=` of the MOD that was just sent |

Shaped this way, the interpreter never has to stop and wait for a person.
Waiting in a browser would need a Worker and `SharedArrayBuffer`, and the
headers for that (COOP/COEP) need a server, which would break the premise that
one HTML file is enough. **What a real system cannot do either** (going back
and forth with a person inside one run) cannot be done here.

## What is reproduced and what is not

| Reproduced | Not reproduced |
|---------|-----------|
| The position, length and attributes of a field (protected / numeric / highlighted / non-display) | **A real 3270 data stream** (the `SBA` / `SF` / `IC` orders) |
| The rule that the attribute byte eats the position just before the field | Talking to tn3270, a real terminal |
| The modified data tag (MDT) and read modified | DBCS / EGCS, programmed symbols, field outlining |
| `JUST` / `FILL` / truncation, literals, system literals | Logical paging (`MSG PAGE=YES`) and physical paging (PA1) |
| The repetition and the serial numbers of `DO` / `ENDDO` | Split screens (3290 partitions) |
| PF key assignment, `DSCA`, `ATTR=YES` | `OPT=2` / `OPT=3`, `PASSWORD`, `TABLE` / `PDB` |
| The message queue (`GU` / `GN` / `ISRT` / `PURG`) | Alternate PCBs (changing the destination with `CHNG` / `ISRT`) |
| Conversational programs (the SPA), `/FORMAT` | IMS commands other than `/FORMAT`, MFS exit routines |
| `CLEAR` (wipe the buffer and send the AID alone) | PA1 to PA3 (physical paging) |
| `DEV SYSMSG=` (put an IMS notice in that field) | `DFLD EATTR=` (colour, underline and the like do not show in the screen image; the checks warn about it) |

**Why no real data stream is produced.** The output formats and the precision
of this implementation were decided by comparing with a real PL/I
implementation, but that cannot be done for MFS (IMS runs on z/OS only and
there is no implementation to run at home). Pinning something byte for byte
when there is no way to check it means **pinning a wrong value with nothing to
notice**. What a business program sees is a segment, not a data stream, so
reproducing down to the field is enough.

When you hit something that is not reproduced, **it says so by name**. It
never quietly returns a different answer.

## The statements of a format definition

| Statement | The main operands | Notes |
|----|--------------|------|
| `FMT` / `FMTEND` | (the label is the name of the format) | |
| `DEV` | `TYPE=`, `FEAT=IGNORE`, `PFK=`, `DSCA=`, `SYSMSG=` | `TYPE` is `3270-A1` (12x40) / `A2` (24x80) / `A3` (32x80) / `A4` (43x80), `3270,1` (12x40), `3270,2` or `3270` (both 24x80). **Only one `DEV`** (listing one per device is not implemented). `PFK=` needs the name of the field the literal goes into |
| `DIV` | `TYPE=INOUT` / `INPUT` / `OUTPUT` | on a 3270 it is `INOUT` (the default) |
| `DPAGE` | `CURSOR=((row,column))`, `FILL=` | only one (paging is not implemented). `FILL=` takes `C'c'` / `X'40'` (blank) / `X'00'` or `NULL` (no fill). Any other `X'hh'` is refused, because there is no EBCDIC table here |
| `DFLD` | a literal, `POS=(row,column)`, `LTH=`, `ATTR=`, `EATTR=` | with a label, an MFLD can point at it (**unique within the format**). `POS=(1,1)` cannot be written (there is nowhere for the attribute byte). `EATTR=` is read but does not show in the screen image |
| `DO` / `ENDDO` | the count, the row step, the column step, `SUF=` | no nesting. The count goes up to 99. A label on a repeated `DFLD` may be up to 6 characters (a 2-digit serial number is appended). A position operand can be left out by running the commas together (`DO 3,,5` means a column step of 5) |
| `MSG` / `MSGEND` | `TYPE=`, `SOR=`, `NXT=`, `OPT=1`, `FILL=` | `SOR=` is required. `TYPE=` defaults to `INPUT` |
| `LPAGE` | (no operands) | only one (because `COND=` is not implemented). Left out, one is assumed |
| `SEG` | (no operands) | left out, one is assumed |
| `MFLD` | a field name / a literal / `(field,'literal')` / `(field,DATE2)`, `LTH=`, `JUST=`, `FILL=`, `ATTR=` | `JUST=` defaults to `L`. The system literals are the six `DATE1` (6 characters) / `DATE2` / `DATE3` / `DATE4` / `TIME` / `LTNAME` (8 each), and they **can only be used in an output MSG** |

The format is assembler macro statements (the same as DBDGEN and PSBGEN). A
`*` in column 1 is a comment; a non-blank column 72 continues onto the next
line and resumes at column 16. The number of blanks at the start of a line
does not matter.

**Everything after the blank that follows the operands is a comment.** So
putting a blank after a comma, as in
`DFLD POS=(1,2),LTH=5, ATTR=(ALPHA,PROT)`, turns the rest into a comment and
`ATTR=` disappears. Falling back quietly to the default (a field you can type
into) is impossible to notice, so **this shape is refused as a mistake**.
Either continue right after the comma with no blank, or put the continuation
mark in column 72.

**A positional operand can be left out by running the commas together.**
`DO 3,,5` means "count 3 / the default row step / a column step of 5", which
lines the fields up across the screen.

With `ATTR=` left out it is **ALPHA, NOPROT, NORM, NOMOD**.

## Writing the program

The I/O PCB goes first in the PSB (`PCB TYPE=TP`, or `CMPAT=YES`).

```
         PCB  TYPE=TP
         PSBGEN LANG=PLI,PSBNAME=INVPSB
         END
```

The main procedure receives the pointers in that order.

```pli
invq: proc(io_ptr) options(main);
  dcl plitdli entry;
  dcl io_ptr pointer;
  dcl 1 io_pcb based(io_ptr),
        2 lterm_name char(8),      /* the logical terminal name */
        2 reserved1  char(2),
        2 stat_code  char(2),      /* the status code */
        2 msg_date   fixed dec(7,0),   /* the Julian date yyddd */
        2 msg_time   fixed dec(7,1),   /* hhmmss.t */
        2 msg_seq    fixed bin(31),
        2 mod_name   char(8),      /* the output format MFS uses */
        2 user_id    char(8);
  dcl 1 msg_in,
        2 in_ll   fixed bin(15),   /* the length, including LL and ZZ */
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
    msg_out.out_name = 'BOLT ' || msg_in.in_item;
    msg_out.out_ll = 24;                     /* 4 + 20 */
    msg_out.out_zz = 0;
    call plitdli(four, func_isrt, io_pcb, msg_out, modname);
    call plitdli(three, func_gu, io_pcb, msg_in);
  end;
end invq;
```

To use a database as well, list the DB PCBs **after** the I/O PCB and receive
the pointers in that order in the main procedure. **A working set** (`.pli` /
`.mfs` / `.psb` / `.dat` / the script) is in `engine/test/screen/dbinq.*`.

Four things matter.

1. **The first two items of the message I/O area are `LL` and `ZZ`.** Declare
   both as `FIXED BIN(15)`. `LL` must include the four bytes of `LL` and `ZZ`
   themselves. Forget it and it refuses by name (rather than quietly showing
   an empty screen).
2. **Only as much as `LL` is sent.** The rest of the area is cut (a real
   system looks at `LL` too).
3. **The output format is the fourth argument of `ISRT`** (counting from the
   function code; the fifth inside the parentheses of the `CALL`). Left out,
   it is the `NXT=` of the input MID.
4. **Write a structure item as "parent.item".** Write the item alone and this
   implementation declares another variable implicitly. The linter rule
   `unqualified-member` reports it.

### The status codes of the I/O PCB

| Code | What it means | On which call |
|-------|------|--------------|
| two blanks | fetched / inserted | any |
| `QC` | there is no message on the queue (the end of the program) | `GU` |
| `QD` | there are no more segments in this message | `GN` |
| `QE` | a `GN` came before a `GU` | `GN` |
| `AD` | the function code is wrong; `GHU` / `GHN` (a hold retrieval belongs to a database PCB only) | any |

The following calls are **known by name and refused as "not implemented"**:
`CHKP` / `XRST` / `ROLB` / `ROLL` / `ROLS` / `SETS` / `LOG` / `STAT` /
`SNAP` / `GSCD` / `APSB` / `DPSB` / `CHNG` / `SETO` / `CMD` / `GCMD` /
`AUTH` / `INIT`. Returning `AD` quietly would be indistinguishable from a
typo.

**Always pass an I/O area** to `GU` / `GN` / `ISRT`. Without one it refuses by
name (it used to return success and advance the queue by one, which lost the
input).

## Running it

A working set is in `engine/examples/screen/`. It is an inquiry (an inventory
lookup) that takes an item number and prints a name, using the screen and the
database from one program.

```
engine/examples/screen/
  dbinq.pli    the program
  dbinq.mfs    the format definitions (MID / MOD / DIF / DOF)
  dbinq.keys   the terminal script
  INVPSB.psb   the I/O PCB first, the DB PCB for ITEM second
  ITEM.dbd     the hierarchy
  ITEM.dat     the data
```

### The browser version

Put the format definitions in the extra files under `::: name.mfs` and the PSB
under `::: name.psb`, then press Terminal in the header. Type the name of a
MOD into "First screen" and press Start. Input boxes sit on top of the fields
you can type into; type there and press ENTER. For a PF key, pick it from the
list on the right and press Send.

Picking the "Screen I/O (MFS) + IMS/DB" sample brings the whole set in and
opens the terminal.

### The CLI

Instead of a terminal, it plays a **script**.

```
npm run pli -- examples/screen/dbinq.pli --psb INVPSB --keys examples/screen/dbinq.keys
```

Every `*.mfs` in the same directory as the source is read as the format
definitions (`--mfs` can name them instead).

### VSCode

The command `PL/I: Drive the screen (MFS)`. The format definitions and the
script are read from the same place as the source, and the screen images come
out in the output panel. Anything you are editing and have not saved is used
as it is in the editor. The PSB is a `*.psb` from the same place (when there
is exactly one).

Open `engine/examples/screen/dbinq.pli`, run this command, and it works as it
is, with no settings to touch.

## The script (`*.keys`)

```
MOD   INVOUT                 the first screen to show (instead of typing /FORMAT at a terminal)
SPA   20                     the length of the SPA of a conversational transaction (5 or more)
LTERM TERM0001               the logical terminal name
USERID TSO0001               the user name (USER_ID of the I/O PCB)
NOW   2026-10-10T15:04:05    the time (without it nothing can be pinned)
ITEMIN=42                    type into a field
ENTER                        send
PF3                          send with a PF key (PF1 to PF24)
CLEAR                        send with the CLEAR key
NEXT                         show the next message that is queued
```

A `*` or a `#` at the start of a line is a comment. **Always write the time.**
`DATE2`, `TIME` and the date in the I/O PCB are made from the time you give,
so without it they change on every run.

## Rules that catch you out

- **The attribute byte eats the position just before `POS`.** `POS` and `LTH`
  do not count it. For a field that starts in column 1 the attribute byte
  lands on **the last byte of the previous row**, so **`POS=(1,1)` cannot be
  written** (it refuses, saying there is nowhere to put it). Leave at least
  one column between fields.
- **When two defined fields are two or more columns apart, MFS makes a field
  in the gap** (`NUM, PROT, NODISP`). That is why you cannot type into the
  space after a field you can type into.
- **The fill character comes from different places for input and output.** For
  input (device → segment) it is the `FILL=` of the `MFLD`; for output
  (segment → screen) it is the `FILL=` of the `DPAGE`, otherwise the `FILL=`
  of the `MSG`, and with neither it is a blank.
- **A field that was not modified does not come back from the device** (the
  MDT). A field that did not come back is filled with the `FILL=` of the
  `MFLD`, and with `FILL=NULL` it disappears from the segment. **The modified
  tag is dropped on every write**, so unless you type again it does not come
  back next time.
- **Trailing blanks are dropped when a field comes back from the device.**
  Type `42` into a 6-column field and `42` arrives; `JUST=R` and `FILL=C'0'`
  turn it into `000042`. Without dropping them those two would do nothing.
- **If the program ends abnormally, the output is thrown away.** Fall over
  after the `ISRT` and the screen does not change, because when a real MPP
  fails IMS backs out to the last sync point and discards the output message.
  **Database updates remain** (the same promise as files; the sync points of
  an MPP are not reproduced).
- **The transaction code goes in through the PF key mechanism.** Write
  `MFLD (field,'INVQ')` and the literal goes into that field when nothing came
  for it (that is, on ENTER). Write
  `DEV PFK=(field,3='/FOR MENU.')` and PF3 puts that literal in. **End a
  command with a period** (the contents of a field butt up against the next
  one inside the segment).
- **When the device already holds the same format, only the fields the MOD
  touches are rewritten** (a message write). The literals are laid out again
  only when the format changes, when `DSCA` asks for a forced write, or when
  `/FORMAT` is typed. That is why what you typed is still on the screen that
  comes back.
- **`FILL=NULL` differs slightly from a real system.** A real null means "do
  not send that column", leaving the display as it is; here it fills with a
  blank (on a format write the result is the same, because what was there was
  a blank; on a message write the rest of the field is cleared). On the input
  side too, **a field that came back with nothing** disappears from the
  segment, while **a field that came back short** is stretched with blanks (to
  keep the column layout fixed).
- **A field cannot straddle rows.** A real buffer is linear and could, but
  here it is refused at definition time (it is almost always a mistake in
  `LTH` or `POS`, and it reads badly in a design that shows the screen image
  row by row). Define one field per row.
- **A full-width character counts as one column.** DBCS is not reproduced, so
  the columns of the screen image are as defined, but shown in a monospaced
  font they look out of line.

## Checking a format definition

What is refused at load time is "a mistake that makes the screen
unbuildable" (overlapping fields, a reference to something that is not there,
something off the screen, a duplicate label and so on). Beyond that, things
that **pass as a definition but bite only when you run it** come out as
warnings. The CLI puts them on standard error, the browser version says "N
notes on the format", and VSCode prints them in the output panel with
`[format]`.

| Warning | How to fix it |
|------|-------|
| a format used for input has no field you can type into | drop `PROT` from `ATTR=`. Check that you have not given a headings-only format as the `SOR=` of a MID |
| `DPAGE CURSOR=` points where there is no field, or at a protected one | point at **the start** of a field. Make the field one you can type into |
| a `DFLD` no `MFLD` points at | check the spelling of the name. If the field is only for display, drop the label |
| `EATTR=` does not show in the screen image | colour and underline are not reproduced; use `HI` in `ATTR=` instead if you need it |

## Conversational programs (the SPA)

Give the length that `TRANSACT SPA=` would set and the program becomes
conversational (`SPA` in the script, on the CLI and in VSCode). On a real
system the system definition decides it, and it is written neither in the
program nor in the message, so it is given from this side.

**The browser terminal does not use a script, so a conversational program
cannot be run there**: there is nowhere to give the length of the SPA. Try it
on the CLI or in VSCode.

The shape of the SPA is **`LL`(2) + `ZZZZ`(4) + the transaction code(8) + your
work area**. The program must not touch the first 6 characters.

```pli
  dcl 1 spa,
        2 s_ll   fixed bin(15),
        2 s_zz   fixed bin(15),
        2 s_zz2  char(2),          /* the rest of ZZZZ */
        2 s_tran char(8),
        2 s_save char(6);          /* the work area */
```

A conversational program **takes the SPA with `GU`, takes the input with `GN`,
and inserts the SPA first** before inserting the segment for the screen.
**Return the transaction code as blanks and the conversation ends.**

If the first `ISRT` is not the shape of the SPA (the length given with `SPA`
minus 4), it refuses. Taking the first segment as the SPA quietly would turn
the segment meant for the screen into the SPA, and it would come back as the
next input.

## Where the expected values come from

For MFS and DL/I there is **no real system to compare against**. IMS runs on
z/OS only, and no implementation you can run at home is available (only
commercial migration products). So the same line is taken as for DL/I.

> The IBM specification documents are the truth, and the reason for each rule
> is quoted in the tests.

The golden screen images live in `engine/test/screen/`, and the first line of
their `.why` begins with **"based on the IBM specification (not the output of
a real implementation)"**. To keep them from mixing with
`engine/test/golden/`, which pins the output of a real implementation (its
first line begins with "the real thing: Iron Spring PL/I ..."), the place and
the wording are kept apart mechanically by a test.
