# The golden tests for the screen (MFS)

[日本語](README.md) | **English**

The `*.screen` files here pin **screen images built with the IBM
specification documents as the truth** byte for byte. `screen.test.ts`
requires them to agree.

## The difference from `test/golden/` — where they come from

| | `test/golden/` | here (`test/screen/`) |
|---|---|---|
| What makes it true | **the output of a real PL/I implementation** | **the IBM specification documents** |
| How to regenerate | the other repository, `pli-oracle` | there is no way (read the specification again) |
| The first line of the `.why` | `実機: Iron Spring PL/I …` | `IBM 仕様に基づく（実機の出力ではない）` |

For MFS and DL/I there is no real system to compare against. **IMS runs on
z/OS only**, and no implementation you can run at home is available (there are
only commercial migration products). So, to keep the provenance from being
mixed up, the place and the first line of the `.why` are kept apart.
`screen.test.ts` checks even how that first line begins, mechanically.

## The set of files

| File | What it is for |
|---------|------|
| `<name>.pli` | the program to run |
| `<name>.mfs` | the format definitions (`FMT` … `FMTEND` / `MSG` … `MSGEND`) |
| `<name>.files` | the extra files: the PSB, the DBD and the data, separated by `::: name` |
| `<name>.keys` | the terminal script (how to write it is at the top of `src/tm/keys.ts`) |
| `<name>.screen` | the screen image expected (byte for byte) |
| `<name>.why` | **what it pins** (required; without it the test fails) |

The name of the PSB comes from the `*.psb` put in `<name>.files`. A PSB with
no I/O PCB (`PCB TYPE=TP` or `CMPAT=YES`) does not work.

## Regenerating them

```
npx tsx scripts/gen-screen.ts <name>
```

**Look at the output and work out which rule makes it so before putting it
in.** An expected value put in without that is nothing more than "what this
implementation prints today", and pinning it means nothing. Write the rule you
established in the `.why`, so that whoever reads it later knows where in the
specification to look.

## The sets that exist

| Name | What it pins |
|------|------------------|
| `inquiry` | positions and attributes, the one column of the attribute byte, `JUST` / `FILL`, the literal of a `PFK`, `DATE2`, `/FORMAT` |
| `dbinq` | using the screen (MFS) and the database (DL/I) from one program. The I/O PCB is first in the PSB and the DB PCB second. An item number lined up with `JUST=R` / `FILL=C'0'` is used as it is in the SSA of the sequence key |
| `conv` | the SPA of a conversational program (`LL` + `ZZZZ` + the code + the work area) and the promise that blanking the code ends it |
| `table` | the repetition and the serial numbers of `DO` / `ENDDO` (the names on the FMT side and the MSG side mesh) |
| `attrs` | the two bytes of `ATTR=YES` (replace, OR, cursor request) and `DSCA` |
