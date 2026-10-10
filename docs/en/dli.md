# IMS/DB (DL/I)

[日本語](../dli.md) | **English**

From PL/I you can read and write a **hierarchical database** with
`CALL PLITDLI`. You do not have to install IMS. The DBD, the PSB and the data
are text files; in the browser version you only write them in the Files box.

```pli
stuprt: proc(io_ptr, db_ptr) options(main);
  dcl plitdli entry;
  dcl (io_ptr, db_ptr) pointer;
  %include dlipcb;                      /* the PCB mask */
  dcl three fixed bin(31) init(3);
  dcl func_gn char(4) init('GN  ');
  dcl seg_io char(13);

  do while (db_pcb.stat_code ^= 'GB');
    call plitdli(three, func_gn, db_pcb, seg_io);
    if db_pcb.stat_code ^= 'GB' then
      put skip list(db_pcb.seg_name, seg_io);
  end;
end stuprt;
```

## What is reproduced and what is not

Only the **logical layer** is reproduced.

| Reproduced | Not reproduced |
|---------|-----------|
| The hierarchy and hierarchic sequence | The physical layout (the RAPs of HDAM, pointers, OSAM data sets) |
| Sequence keys and concatenated keys | The difference between access methods (HDAM / HIDAM / HISAM / HSAM / DEDB) |
| The current position and parentage | Secondary indexes (`LCHILD` / `XDFLD`), logical relationships |
| Status codes | `EXEC DLI`, the AIB interface |
| Enforcing `PROCOPT`, load mode | Locking (the `Q` command code), sync points such as `CHKP` / `ROLB` |

**IMS TM (the message queue) and the screen (MFS) are a separate layer.**
`GU` / `GN` / `ISRT` / `PURG` on the I/O PCB and the 3270 screen are in
[`mfs.md`](mfs.md). This document is about the database only.

`ACCESS=HDAM` and `ACCESS=HIDAM` behave the same. What a business program can
see is decided by the hierarchic sequence and the sequence keys alone, so this
is enough to learn and to check things with. When you hit something that is
not reproduced, **it says what is not implemented by name** (it never quietly
returns a different answer).

> **About the basis for the status codes.** The output formats and the
> precision rules were decided by comparing with a real PL/I implementation,
> but that cannot be done for DL/I (IMS runs on z/OS only, and the reference
> implementation at hand has no DL/I). So for DL/I the IBM specification
> documents are taken as the truth, and the meaning of each code is quoted in
> the comments of `engine/test/dli-engine.test.ts`. MFS is in the same
> position and takes the same line ([`mfs.md`](mfs.md)).

## The three files

### The DBD — defining the hierarchy

Write the input to DBDGEN as it is. The format is assembler macro statements;
a `*` in column 1 is a comment. **A non-blank column 1 is read as a label, so
always leave column 1 blank for a statement.** A non-blank column 72 continues
onto the next line (which resumes at column 16). Everything after the blank
that follows the operands is a comment.

Because of that, putting a blank after a comma, as in
`SEGM NAME=STUDENT,PARENT=0, BYTES=40`, turns the rest into a comment and
`BYTES=` disappears. Disappearing quietly is impossible to notice, so **this
shape is refused as a mistake**. Either continue right after the comma with no
blank, or put the continuation mark in column 72. The indentation at the start
of a line may be any number of blanks, as long as there is at least one (you
do not have to line up on column 10 as on a real system).

```
         DBD  NAME=STUDENT,ACCESS=HDAM
         DATASET DD1=STUDDB,DEVICE=3390
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         SEGM NAME=COURSE,PARENT=STUDENT,BYTES=8
         FIELD NAME=(COURSEID,SEQ,U),BYTES=4,START=1,TYPE=C
         FIELD NAME=TITLE,BYTES=4,START=5,TYPE=C
         DBDGEN
         FINISH
         END
```

| Statement | Operands it needs | Notes |
|----|----------------|------|
| `DBD` | `NAME=` | `ACCESS=` is only recorded |
| `DATASET` / `AREA` | — | accepted but unused |
| `SEGM` | `NAME=` `BYTES=` | `PARENT=0` makes it the root. There is only one root |
| `FIELD` | `NAME=` `BYTES=` `START=` | `NAME=(name,SEQ,U)` makes it the sequence key. `U` is unique, `M` allows duplicates |
| `DBDGEN` | — | required |

`START=` is a 1-based column. A field that does not fit in the segment length
is a mistake. A segment with no sequence key is allowed (an insert goes to the
end of the siblings).

### The PSB — which segments, and what for

```
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=9
         SENSEG NAME=STUDENT,PARENT=0
         SENSEG NAME=COURSE,PARENT=STUDENT
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
```

- Leaving out `PROCOPT=` gives `A` (everything). Leaving out `KEYLEN=` gives
  the longest concatenated key
- With no `SENSEG` at all, every segment in the DBD is sensitive (a
  convenience for hand-written exercises; a real system requires them)
- `CMPAT=YES` **adds one I/O PCB at the front**. Writing `PCB TYPE=TP` takes
  the same place
- Naming a segment you are not sensitive to in an SSA gives `AM`

The `PROCOPT` letters and the calls they allow:

| Letter | Calls allowed |
|------|------------|
| `A` | everything |
| `G` / `O` | retrieval |
| `I` | insert |
| `R` | replace (which includes retrieval) |
| `D` | delete (which includes retrieval) |
| `L` | **insert only** (load mode; retrieval is not possible) |

`P` (path calls), `E` (exclusive) and `S` are accepted as text but have no
effect here. A path call with the `D` command code goes through even without
`P` in the `PROCOPT`. A `PROCOPT=` on a `SENSEG` is read but not enforced;
only the one on the PCB is.

### The parent on an insert

`ISRT` names the path from the parent down to the segment being inserted with
SSAs. **Leave the parent's SSA out and the parent comes from the position the
last `GU` or `GN` established.**

```pli
/* the shape written most often in IMS */
call plitdli(4, func_gu,   db_pcb, io, 'STUDENT (STUDNO   =S0001)');
call plitdli(4, func_isrt, db_pcb, io, 'COURSE  ');   /* the parent is S0001 */
```

With no position (nothing fetched yet) it is `GE`; in load mode
(`PROCOPT=L`) it is `LD`, "no parent".

**The SSA of the segment being inserted (the lowest one) must not be
qualified.** The condition would never be used, so a qualification there is
refused with `AJ`.

### A segment you are not sensitive to is invisible

A segment not declared with `SENSEG` is not returned, not even by an
unqualified `GN`. That is the same as a real PCB being "a hierarchy of what
you are sensitive to". A `PROCOPT=` on a `SENSEG` applies as well (**both**
it and the `PROCOPT` on the PCB have to allow the call).

### The data — line-oriented text

Write one segment occurrence per line in `<DBD name>.dat`. **The first 8
columns are the segment name**, and the rest is the segment data, `BYTES=`
long. The newline may be LF or CRLF. Anything past `BYTES=` is cut off.

```
STUDENT S0001YAMAKAWA
COURSE  C001MATH
COURSE  C002PHYS
STUDENT S0002TSUKIMI
COURSE  C001MATH
```

**The hierarchy is decided by the order of the lines.** The parent of a line
is the occurrence of the parent type that appeared most recently. That is the
hierarchic sequence of IMS itself, so no new rule was invented for the format.
People can read it and diff it, so it can be edited as a virtual file in the
browser.

Siblings must be in ascending order of the sequence key. If that is broken,
loading stops (sorting them quietly would disagree with the order the program
sees).

Updates (`ISRT` / `REPL` / `DLET`) are written back to this file at the end of
the run. Even after an abnormal end, the updates made up to that point remain
(the same promise as file I/O).

## Calling it

### Naming the PSB

Which PSB to use is not written in the program (on a real system the JCL
decides).

| Entry point | How you name it |
|------|-----------|
| The browser version | put a `<name>.psb` in the Files box (exactly one). Having it there turns DL/I on |
| The CLI | `npm run pli -- prog.pli --psb STUPSB` |
| The test CLI | `npm run plitest -- examples/tests --psb STUPSB`. Left out, a `*.psb` beside the source is used |
| VSCode | the `pli.dli.psb` setting. Empty means a `*.psb` beside the source |
| From a program | `runProgram(source, { host, psb: "STUPSB" })` |

Picking one up from beside the source happens only when there is **exactly
one** `*.psb`. With two or more there is no way to choose, so none is used.
When VSCode used a PSB that did not come from the setting, it says so at the
top of the output panel (so that you can see why the behaviour depends on
where the file sits).

Reaching `CALL PLITDLI` with no PSB named stops the program, saying there is
no PSB. When the main procedure declares its parameters as pointers (that is,
it receives PCBs) and there is no PSB, it refuses there and then, without
waiting for the `CALL`.

### The PCB mask

As on a real system, lay it over a pointer received as a parameter of the main
procedure with `BASED`. **The names of the items are yours to choose**, but
**the order and the widths must be as the standard says.**

```pli
dcl 1 db_pcb based(db_ptr),
      2 dbname     char(8),
      2 seg_level  char(2),
      2 stat_code  char(2),
      2 proc_opt   char(4),
      2 reserved   fixed bin(31),
      2 seg_name   char(8),
      2 len_kfb    fixed bin(31),
      2 no_senseg  fixed bin(31),
      2 key_fb     char(9);      /* match KEYLEN (the PSB example here is KEYLEN=9) */
```

The order of the parameters of the main procedure is the order of the PCBs in
the PSB. With `CMPAT=YES` the first one is the I/O PCB, so it becomes
`proc(io_ptr, db_ptr)`.

The items are tied **by declaration order, not by name**. The names in a PCB
mask differ from program to program, so a name is no way to find them (the
same arrangement as a real system laying them out by offset). If the order is
too short, it stops and says how many are needed.

> If the PSB has only one DB PCB, passing the structure directly, without
> `BASED`, is accepted too. That is a convenience for short exercises; a real
> system has no such shape. `CHAR(*)` cannot be written, so give the length of
> `KEY_FB` explicitly.

### The shape of the CALL

```pli
call plitdli(argument count, function code, PCB, segment I/O area, SSA...);
```

The first argument is **the number of arguments that follow**. Pass it as a
`FIXED BIN(31)` variable. If it disagrees, it stops and tells you the declared
number and the real one (on a real system it just falls over with no sign of
why: one of the most common mistakes in IMS).

The segment I/O area may be a `CHAR(n)` or a structure. The widths of the
items in a structure follow the same rule as record I/O (`CHAR` and `PICTURE`
only).

### The function codes

| Code | What it means |
|--------|------|
| `GU` / `GHU` | search from the top and fetch one (Get Unique) |
| `GN` / `GHN` | fetch the next one in hierarchic sequence (Get Next) |
| `GNP` / `GHNP` | fetch in order, but only under the established parent (Get Next in Parent) |
| `ISRT` | insert |
| `REPL` | replace; a `GH` call must have fetched it first |
| `DLET` | delete; the children below go with it |

Only a segment fetched with a `GH` call (with hold) can be the target of
`REPL` or `DLET`. The hold is used up once.

### The SSA (segment search argument)

A format fixed by column. **Columns 1 to 8 are the segment name**, and the
qualification starts at column 9.

```pli
dcl ssa char(25) init('STUDENT (STUDNO   =S0001)');
/*                     ^^^^^^^^ ^^^^^^^^^^^^^^^      */
/*                     name, 8  field 8 + operator 2 + value */
```

The rule is **exactly 8 columns for the field name and exactly 2 for the
relational operator**. `STUDNO` is 6 characters, so lining it up to 8 leaves
two blanks, and right-justifying the operator makes **three blanks in all**
before the `=`. Get the columns wrong and you get `AJ` (with two blanks, the
operator field reads as `=S`).

| What you can write | Example |
|-----------|-----|
| Unqualified | `'STUDENT '` |
| Relational operators | `=` `EQ` `>` `GT` `<` `LT` `>=` (`=>`) `GE` `<=` (`=<`) `LE` `!=` (`=!`) `NE` `^=` (`=^`) `¬=` (fit it in the 2-column field; left or right justified, either is fine) |
| Several conditions | `'...&...'` (AND), `'...|...'` (OR). `*` is AND too. `#` is accepted as syntax but is given no independent-AND meaning and is treated as AND (independent AND matters for SSAs that use a secondary index, and secondary indexes are not implemented) |
| Several levels | pass several SSAs to narrow a path down the hierarchy. If a higher one is unqualified, the search goes in hierarchic sequence until a path satisfies every SSA. Out of hierarchic sequence it is `AC` |
| Command codes | follow a `*` with them, as in `'COURSE  *F'` |

The length of a value should properly equal the field length in the DBD, but
this implementation takes **everything up to the closing parenthesis or a
boolean operator, with the field length as the limit**, so that by hand you
can write `(STUDNO   =S1)`, shorter than the field. The comparison, however,
is **an exact match after padding the value with blanks**, so a short value
only matches when the field itself is blank-padded: it is not a prefix match.
A value that is too long is a column mistake and is refused.

The command codes:

| Code | What it means |
|--------|------|
| `F` | go back to the first occurrence under the parent |
| `L` | fetch the last occurrence (it applies to `GU` / `GHU` and to narrowing the parent on `ISRT`; a `GN` call ignores it) |
| `D` | a path call: put that level and everything below into the I/O area in one go |
| `P` | establish parentage at that level (the default is the lowest) |
| `U` / `V` | narrow that level by the current position |
| `C` | take what is in the parentheses as a concatenated key (`'GRADE   *C(S0001C0012A)'`) |
| `-` | do nothing |

`A` `G` `M` `N` `Q` are accepted as syntax, but using one is refused as not
implemented.

### The status codes

Two characters come back in `STAT_CODE` of the PCB. **DL/I raises no exception
when it fails.** If you do not read it, you process a segment that was never
fetched as if it had been. The linter rule `dli-status-unchecked` reports it
when the code is never read.

| Code | What it means | When it comes back |
|--------|------|---------|
| blank | fine | — |
| `GA` | moved up a level (**the segment is still returned**) | an unqualified `GN` |
| `GK` | moved to another type on the same level (**the segment is still returned**) | an unqualified `GN` |
| `GB` | the end of the database. **A qualified `GN` with no match gives this too** (not `GE`) | `GN` |
| `GE` | not found | `GU` / `GNP`, and an `ISRT` whose parent SSA does not match |
| `GP` | no parentage is established | `GNP` |
| `II` | it is already there (a duplicate unique key) | `ISRT` |
| `DJ` | no `GH` call came before it | `REPL` / `DLET` |
| `DA` | the sequence key was changed | `REPL` |
| `AC` | the hierarchy in the SSAs does not match the DBD | any |
| `AD` | the function code is wrong; an `ISRT` with no SSA at all | any |
| `AJ` | the SSA format is wrong (any call); the SSA of the segment being inserted is qualified (`ISRT` / `REPL`) | any |
| `AM` | outside the `PROCOPT` or outside what you are sensitive to | any |
| `LB` `LC` `LD` `LE` | a load-mode order violation (already there / key order / no parent / sibling order) | `ISRT` |

**`GA` and `GK` are warnings, and the segment is returned.** Make
`stat_code = '  '` the condition of your loop and you drop a segment wherever
the hierarchy changes level. To walk everything, make the condition
`stat_code ^= 'GB'`.

## Examples

- `engine/examples/tests/dli_test.pli` — 12 tests written in PL/I, with
  `STUDENT.dbd` / `STUPSB.psb` / `STUDENT.dat` / `dlipcb.inc` in the same
  place
- `engine/examples/dli/stuprt.pli` — lists everything in hierarchic sequence;
  the main procedure receives pointers to PCBs
- `engine/examples/screen/dbinq.pli` — using it together with the screen (MFS)
  ([`mfs.md`](mfs.md))
- The "IMS/DB (DL/I)" sample in the browser version — picking it brings the
  DBD, the PSB and the data along

```bash
cd engine
npm run plitest -- examples/tests    # nothing is written back; the PSB beside the source is used
npm run pli -- examples/dli/stuprt.pli --psb STUPSB
npm run pli -- examples/screen/dbinq.pli --psb INVPSB --keys examples/screen/dbinq.keys
```

`examples/dli/STUPSB.psb` has `CMPAT=YES` (so an I/O PCB is added at the
front) and `examples/tests/STUPSB.psb` does not. The number of pointers the
main procedure receives changes with it, so do not mix the two PSBs up.

By default `plitest` **writes back to no file at all** (neither the DL/I data
file nor a file made with `PUT FILE`), because if the data changed every time
you ran the tests, the second run would give a different result (which really
happened with a `DLET` test). Use `--write` when you want them to land.

## Snippets

| Type this | What you get |
|------|---------|
| `pcb` | the declaration of a PCB mask |
| `dlifunc` | the declaration of `PLITDLI` and the function codes |
| `dligu` | `GU` + a qualified SSA + branching on the status code |
| `dlign` | a `GN` loop (until `GB`) |
| `dlirepl` | `GHU` + `REPL` |
