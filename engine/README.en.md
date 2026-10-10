# engine — inside the implementation

[日本語](README.md) | **English**

A TypeScript implementation that runs in a browser and under Node. It depends
on nothing from Node.

This document is about **how it is built inside**. For how to use it, see
[`../docs/en/browser-manual.md`](../docs/en/browser-manual.md) and
[`../docs/en/vscode-manual.md`](../docs/en/vscode-manual.md).

## Where it stands

| Layer | State |
|----|------|
| Lexer `src/lexer.ts` | done |
| Preprocessor `src/preprocess.ts` | `%REPLACE` / listing control |
| Output formats `src/format.ts` | done |
| Parser `src/parser.ts` | done |
| Values and arithmetic `src/value.ts` | done |
| Evaluator `src/interp.ts` | done |
| The run API `src/run.ts` | structured diagnostics |
| Linter `src/lint.ts` | 16 rules, with a CLI |
| Stream I/O `src/streamio.ts` | the file table and the input cursor |
| `PICTURE` `src/picture.ts` | numeric editing |
| `BASED` storage | `interp.ts` / `value.ts` |
| Record I/O | `streamio.ts` / `interp.ts` |
| `%INCLUDE` and the host | `src/host.ts` / `preprocess.ts` |
| **IMS/DB (DL/I)** `src/dli/` | the logical layer only, with a CLI |
| **Screen I/O (MFS)** `src/mfs/` | MID / MOD / DIF / DOF and the 3270 screen |
| **IMS TM** `src/tm/` | the message queue, sessions, terminal scripts |
| Golden screens `test/screen/` | screen images pinned byte for byte (from the specification) |
| Snippets `src/snippets.ts` | 43 of them (the single source) |
| Test framework `src/testing.ts` | with a CLI |
| The browser version `web/` | runs as one HTML file |
| The language of the messages `src/i18n/` | Japanese (the default) and English; the key is the Japanese text itself |

`npm test` prints the counts (with a breakdown per layer). The tests written
in PL/I run separately with
`npm run plitest -- examples/tests --psb STUPSB`.

The tests come in three layers.

| Layer | Where | What it guarantees |
|----|---------|--------------|
| Unit and integration | `test/*.test.ts` | pins one example |
| Invariants | `test/invariants.test.ts` | **two paths always agree** (randomised from a fixed seed) |
| Golden | `test/golden/` (from a real implementation) / `test/screen/` (from the specification) | pins the output byte for byte |

**The invariant layer was added because disagreements between paths were
getting through even past a thousand tests.** A FLOAT that printed correctly
but compared as 0, a `MOD` that did not go through `unifyBase`, a `TRUNC` that
returned a different precision from `CEIL` and `FLOOR`, a mix-up between the
path to the screen and the path back — every one of them sat there with all
the tests green. What this layer watches is **internal consistency**, not
"does it agree with the real thing" (that is what golden is for). So it runs
with no real implementation at hand.

**The counts are not written here, because they used to be listed per layer,
drifted on every change, and once had a sum that was 219 off the total.**

It was built while comparing against the output of a real PL/I
implementation, and the output formats and the precision rules reflect the
result (the handling of conditions was deliberately moved away in one place;
see "Moving the handling of ON conditions away from the standard"). The
expected values that were settled that way are pinned **byte for byte** in
`test/golden/` (unit tests such as `test/format.test.ts` look at parts of them
in detail). Even without the implementation at hand, you can follow what was
taken as the truth. Every expected value must come with a `.why` (why that
output was judged correct), and `golden.test.ts` checks that it is there.

**The tool that regenerates them is in another repository (`pli-oracle`,
private).** The implementation used for comparison is a 32-bit x86 binary and
needs an environment set up to run it, so it is not brought into this
repository, whose premise is "it runs as one browser page". The steps for the
next time a real implementation is needed are in that README; what is needed
here is only the pinned expected values and where they came from. Details in
`test/golden/README.en.md`.

Material like the following goes through.

- **The Towers of Hanoi** — recursion, nested procedures, the implicit
  number-to-character conversion of `||` (it ships as a sample in the browser
  version)
- **An alias for the diagonal** — a two-dimensional array, `DEFINED` + iSUB,
  `PUT EDIT`, `GET STRING EDIT` (also a sample)
- **Spelling out numbers** — 115 lines: command-line arguments, `PUT EDIT`,
  arrays with a lower bound, string handling. **This is an outside reference
  program and is not in the repository for licence reasons** (`numwrd.pli`;
  it is the file the comments in `src/` refer to)

## The most important decision: the lexer does not decide keywords

PL/I has no reserved words, and this is legal code.

```pli
IF IF = THEN THEN THEN = ELSE;
```

It means "if IF equals THEN, assign ELSE to THEN". So whether a word is a
keyword or an identifier **can only be decided by context**. The lexer returns
`word` for all of them and leaves the decision to the parser.

That property is the first test, which makes it structurally impossible to
fall back to a naive keyword table.

## The output format of PUT LIST

Not guessed: derived by comparing with the output of a real PL/I
implementation.

| Element | The rule |
|------|------|
| The field width of `FIXED DEC(p,q)` | **p + 3** |
| The field width of `FIXED BIN(p,q)` | the decimal digits `ceil(p·log10 2) + 1`, **plus 3** (BIN(31) → 14, BIN(15) → 9) |
| Placement of items | **a tab stop every 24 columns**. Numbers are right justified, characters left |
| Line width | **120 columns**. If the next item does not fit, the current line is padded with blanks to 120 and a newline follows |
| After an item | one blank |

One piece of evidence: the multiplication table (`put list` nine times)
produces a first line of **120 columns (5 items = 5×24)** and a second line of
**87 columns (= 3×24 + 14 + 1, 4 items)**.

## Deciding the kind of a statement (the core of parsing)

With no reserved words, the kind of a statement can only be decided by
context. The rule adopted:

> If the head is a reference (a word with optional subscripts) followed by
> `=`, it is an **assignment**. Otherwise the leading word is read as a
> **statement keyword**.

That reads all of these correctly.

| Input | How it reads |
|------|------|
| `IF IF = THEN THEN THEN = ELSE;` | an IF statement (condition `IF=THEN`, body `THEN=ELSE`) |
| `THEN = ELSE;` | an assignment |
| `do = 5;` | an assignment (to a variable called `do`) |
| `do i = 1 to 9;` | an iterative DO |
| `a(2,3) = 7;` | an assignment (with subscripts) |
| `put list(1);` | a PUT statement (it starts with `(` but no `=` follows) |

## What the real thing taught

Points no specification would have shown, found by really parsing an outside
reference program (the `numwrd.pli` above; it is not in the repository).

1. **Control characters below 0x20, other than a newline, must be ignored** —
   an old source can carry a trailing 0x1A (the DOS EOF marker). The
   specification says so too: "Other than newlines, characters lower in the
   collating-sequence than spaces ('20'x) are ignored."
2. **`OPTIONS` is separated by blanks** — `options(main reentrant)`, not by
   commas
3. **An array can state its lower bound** — `dcl ones(0:9) char(8)` is the 10
   elements 0 to 9
4. **There are two kinds of parentheses in a declaration** — right after a
   name it is a dimension, `b(3,3)`; after an attribute word it is precision,
   `bin(31)`
5. **`INITIAL` takes a list of values** — `init(1,2,3)`

## How the arithmetic is implemented

**FIXED DECIMAL is handled exactly, as fixed-point decimal.** A value is kept
as a "scaled BigInt" (for DECIMAL the real value is v / 10^q, for BINARY
v / 2^q). Standing in a JS number (binary floating point) does not make
`123.45 * 6.7 = 827.115` come out right.

The precision rules are implemented as the standard describes. Every one of
them is backed by an output width.

| Operation | The rule |
|------|------|
| Add and subtract | p = max(p1-q1, p2-q2) + max(q1,q2) + 1, q = max(q1,q2) |
| Multiply | p = p1+p2+1, q = q1+q2 |
| Divide | p = N, q = N - ((p1-q1) + q2) (N is the maximum precision: DEC 15 / BIN 31. The real implementation has DEC 18; this differs deliberately) |
| Mixed bases | **convert to BINARY** (the scale moves too; one decimal digit is about 3.32 binary digits. The remainder is **truncated towards 0**. Checked on the real thing) |
| `ROUND` | the result precision is "integer digits + n + 1" and the scale is n. Rounded directly in BigInt (away from 0). Checked on the real thing. With a negative n it rounds to the integer position and **the scale becomes 0** (a negative scale makes `render` lose digits) |
| `**` | with an integer exponent of 0 or more it is FIXED (p = (p1+1)*y - 1, q = q1*y). Fractional, negative, or **when the precision would exceed the maximum**, it is FLOAT. Checked on the real thing |
| `MOD` | p = min(N, p2-q2+max(q1,q2)) (the result is smaller than the second argument). **The bases are lined up with `unifyBase`** (the same path as every other operation) |
| `DIVIDE(a,b,p,q)` | builds the quotient directly at the given precision. Going through the default division precision first turns it into integer division with q=0 when the dividend is wide, and the information never comes back |
| Mixed with FLOAT | **FLOAT wins.** The result precision is the larger of the two sides (the FIXED side counts). Checked on the real thing |
| A comparison involving FLOAT | **compared as JS numbers.** Converting to FIXED first rounds anything finer than 15 decimal digits, which made `1e-9 > 0` false |
| A constant with an exponent (`1.5E3`) | **a floating-point constant**, as the standard says. Read as `FLOAT DEC(6)` (the same as input to `GET`). A magnitude that cannot be represented is `CONVERSION` |

That "mixed bases go to BINARY" is right can be seen from 13 factorial
overflowing exactly (13! = 6,227,020,800 > 2³¹−1). Left in DECIMAL it fits in
15 digits and does not overflow.

## Things that tripped me up while building it

The gap where the unit tests pass but a whole program does not agree was the
useful one.

1. **End the last line with a newline when the program ends** — that one fix
   moved the agreement of the output a long way
2. **A `DECLARE` of a parameter name is an attribute declaration, not a new
   variable** — treating `dcl n fixed bin(31);` in the body of `proc(n)` as a
   new variable and initialising it to 0 loses the argument. Recursion and
   nested procedures depend on this
3. **`LENGTH` and `INDEX` return `FIXED BIN(15,0)`** — you can tell from the
   output width of 9
4. **`MOD` is an integer remainder** — using the division precision rule makes
   `MOD(17,5)` come out as 0
5. **The field width of `FLOAT DEC(6)` is p+8** — ` 3.50000E+0000` is 14
   columns
6. **Never go through a string when turning a FLOAT into a FIXED** — JS
   stringifies `|x| < 1e-6` and `|x| >= 1e21` in exponent notation, so
   `fixedFromLiteral(String(v))` **loses the digits entirely and gives 0**.
   With `a = 0.001`, `a*a*a` printed as `1.00000E-0009` but compared as 0, and
   `a*a*a > 0` was false. Build it from the mantissa and the exponent
   separately (`fixedFromFloat` in `value.ts`)

## Formatted I/O and alias definitions

| Feature | The material that called for it |
|------|----------------|
| `PUT EDIT` and the format items (`A` / `F(w,d)` / `E` / `B` / `X` / `COLUMN` / `SKIP` / repetition factors) | the `PUT EDIT` example, spelling out numbers |
| **Automatic expansion of an array** in a data list | the alias for the diagonal |
| `GET STRING ... EDIT` / `... LIST` | the `PUT EDIT` example, spelling out numbers |
| `DEFINED` + iSUB (alias definitions) | the alias for the diagonal |
| File declarations (`dcl sysprint print;`), accepted as standard output | spelling out numbers |
| Arguments of the main procedure (command-line arguments) | spelling out numbers |
| Evaluating arrays (multi-dimensional, with a lower bound, an `INIT` list) | the `PUT EDIT` example, spelling out numbers |

### The difference between EDIT and LIST

They share the same line and column state but are written differently.

| | Tab stops | Trailing blank |
|--|------------|-----------|
| `PUT LIST` | every 24 columns | one per item |
| `PUT EDIT` | none (as the format says) | none |

The evidence: the output of `put skip edit('b: ',b)(a,(9)f(4))` is exactly
`3 + 9×4 = 39` columns with no trailing blank.

### The alias semantics of DEFINED

```pli
dcl b(3,3) bin fixed init(1,2,3, 4,5,6, 7,8,9);
dcl d(3)   bin fixed def (b(1sub,1sub));
```

`d` holds no storage; it is an alias for the diagonal of `b`. `1sub` is a
dummy variable meaning "the subscript of the first dimension on the alias
side", so `d(i)` is `b(i,i)`. Both reading and writing have to be forwarded to
the base variable, and the diagonal example writes into `d` with
`get string(t) edit(d)(f(5))` and prints the change in `b`.

## Control structures, structures and conditions

| Feature | Notes |
|------|------|
| `SELECT` / `WHEN` / `OTHERWISE` | both the `SELECT(expr)` and the `SELECT;` forms |
| `LEAVE` / `ITERATE` | controlled by an internal exception. **With a label** (`leave outer;`), only the `DO` carrying that label catches it and the others throw it outwards again. Without giving the loop its own label, the innermost one would always catch it |
| Several specifications on `DO` | `do i = 1 to 3, 7 to 9;` / `do i = 1, 5, 10;` |
| `GOTO` and statement labels | the label is looked for among the statements and jumped to; if it is not found it propagates outwards |
| The control variable of a `DO` | both the write and the read-back go through the reference path (`evalRef`). Reading back through a path that does not resolve aliases makes the end test never hold for a `DEFINED` control variable |
| Structures | the qualified names (`REC.ADDR.CITY`) are built from the level numbers and the leaves are registered. A dimension goes **on a leaf** (`2 a(3) fixed bin(15)`). A dimension on the structure itself (`1 tbl(3)`) is refused at declaration time |
| `ON` conditions / `SIGNAL` | ERROR is treated as not resumable |
| `BEGIN` blocks | they have a scope of their own |
| Array expressions | `c = a + b` / `c = a * 2` computed element by element |
| The `SUBSTR` pseudo-variable | `substr(s,3,2) = 'XY'` |
| `%REPLACE` and listing control | handled at the token level (a string literal is never replaced by mistake) |
| Defaults in a declaration | with not one type word, as in `dcl x;`, **the same rule as an implicit declaration** applies (by the first letter of the name: FIXED BIN(15,0) for I to N, FLOAT DEC(6) otherwise). Write `FIXED`, a base or a precision and the FIXED defaults apply |
| Arguments | **by reference.** A temporary (a dummy argument) is made only when the declared attributes differ from what was passed |
| `RETURNS` | the value of `RETURN` is fitted to the declared type |
| Built-in functions (21) | arithmetic `ABS` `CEIL` `FLOOR` `ROUND` `TRUNC` `SIGN` `MOD` `DIVIDE` `MAX` `MIN`; strings `LENGTH` `INDEX` `SUBSTR` `REPEAT` `TRANSLATE` `VERIFY`; arrays `LBOUND` `HBOUND` `DIM`; pointers `ADDR` `NULL`. Anything else is **refused by name** (the 99 words of `UNIMPLEMENTED_BUILTINS`). A name missing from the table becomes "not a known function", which would be indistinguishable from a misspelling, so a test binds every name used in practice to appear in one of the two tables |

### Return types and precision

Worked backwards from the output field widths.

| Built-in | Result type | Width |
|---------|---------|-----|
| `LENGTH` / `INDEX` / `VERIFY` / `SIGN` | `FIXED BIN(15,0)` | 9 |
| `LBOUND` / `HBOUND` / `DIM` | `FIXED BIN(31,0)` | 14 |
| `CEIL` / `FLOOR` | `FIXED(min(N, max(p-q,1)+1), 0)` | 5 for `ceil(2.1)` |
| `DIVIDE(a,b,p,q)` | `FIXED DEC(p,q)` | p+3 |
| `MOD` | `p = min(N, p2-q2+max(q1,q2))` | 4 for `mod(17,5)` |

Implementing `CEIL` as "truncate, then add 1" widens p through the addition
precision rule and the output width no longer agrees. The result precision has
to be constructed directly.

### Characters compare by collating sequence (character code)

`'Z' < 'a'` is true (0x5A < 0x61). JS `localeCompare` depends on the locale
and can make that false, so it cannot be used. The shorter side is padded with
blanks before comparing.

### The comparison operators

`=` `¬=` `<` `<=` `>` `>=`, and **the negated `¬<` and `¬>`** (`^<` / `^>`).
The last two were accepted by the lexer and the parser but missing from the
evaluator's table, so **the syntax passed and it fell over at run time with
"the operator ¬< (not implemented)"**. That is the worst shape there is, since
it makes a misspelling indistinguishable from something unimplemented, so both
now read from the same table.

### Moving the handling of ON conditions away from the standard

Measured on **the implementation used for comparison**, this is what happens.

- Returning normally from an `ON ZERODIVIDE` unit retries the operation, which
  loops forever unless the condition is fixed (measured: 180,000 lines of
  output, cut off after 60 seconds)
- Returning normally from an `ON ERROR` unit ends the program (ERROR is not
  resumable)

**This implementation does not follow the standard on the first one.** After
running the ON unit of a computational condition (`ZERODIVIDE` /
`FIXEDOVERFLOW` / `SIZE`), it does not retry the operation but goes on to
`ERROR` and ends (`raise` in `interp.ts`). Stopping and reporting was judged
more useful for learning than producing a program that never stops. This is a
**deliberate incompatibility**, so it is written down (the exit code is 1).

Because of that, the tests use `SIGNAL` and raise `expectRuntimeError` in the
manifest, requiring only that the standard output agrees.

**An I/O condition raised with `SIGNAL` does resume.** `SIGNAL ENDFILE(f)`
goes down the same path (`raiseIo`) as an `ENDFILE` raised by `GET`. It used
to use `raise`, the one for computational conditions, which made the same
condition "resume from `GET` but end from `SIGNAL`", and the diagnostic lied
about it, saying "add an `ON ENDFILE(f)`" when one was there.

### These eight conditions are all that are raised

`ON` takes any condition name as far as the syntax goes, but the
implementation raises these eight.

| Condition | Where it is raised |
|------|-----------|
| `ERROR` | chained from another condition, `SIGNAL ERROR`, a `SELECT` that matches nothing |
| `ZERODIVIDE` | division by zero (`/`, `MOD`, `DIVIDE`, in both FIXED and FLOAT) |
| `FIXEDOVERFLOW` | fixed-point overflow |
| `SIZE` | it does not fit in the target |
| `SUBSCRIPTRANGE` | a subscript outside the declared bounds |
| `CONVERSION` | a character-to-number conversion failed |
| `ENDFILE(f)` | the input ran out |
| `UNDEFINEDFILE(f)` | the file could not be opened |

An `ON` unit for any other condition name (`OVERFLOW` / `UNDERFLOW` /
`STRINGRANGE` / `ENDPAGE`) parses, but since the implementation never raises
that condition it **never runs**. That is unimplemented. Saying so in a README
is not visible from the source, so the linter rule `on-never-raised` reports
it (it does not report one you raise yourself with `SIGNAL`).

`ON ... SYSTEM;` goes back to the default action (dropping the ON units set so
far). Unlike an empty ON unit, it **does not resume and carry on**.

`SUBSCRIPTRANGE` and `CONVERSION`, with no ON unit set, become the ordinary
run-time errors they always were ("the subscript is out of range" and so on),
because the name of the condition alone does not say what happened.

## What is not implemented

| Feature | Why |
|------|------|
| Indexed and direct-access files (`KEYED` / `REGIONAL`) | rare as teaching material and a lot to implement |
| `AREA` / `OFFSET` | with `BASED` most of the material can be written |
| Multitasking (`TASK` / `WAIT` / `EVENT`) | there is no point on a single-threaded implementation |
| `UNION` | overlaying storage; it sits badly with a design that has no addresses |
| `LABEL` variables / `REFER` | little demand for how heavy the scope handling is |
| Arrays of structures (`1 tbl(3), 2 nm ...`) | flattening does not pass a dimension on an intermediate level down to the leaves. Accepting it would make the leaf a box of one and return a quiet lie, so it is refused at declaration time |
| The physical layer of IMS, secondary indexes, logical relationships | see "IMS/DB (DL/I)" below |
| The 3270 data stream, DBCS, paging | see "Screen I/O (MFS)" below |

When you hit an attribute or a statement that is not implemented, it reports
what by name.

## What was settled against a real implementation

The output formats and the precision rules are derived from the output of a
real PL/I implementation (**Iron Spring PL/I 1.4.1** / Linux i386). The pinned
expected values are in `test/golden/` (with a `.why` giving the provenance, by
convention; the tool that regenerates them is in the other repository,
pli-oracle).

Three points had long been left open under "do not fill it in by guessing".
They were checked on the real thing on 2026-10-10. **Two of them were
implemented wrongly.**

| | The real thing | Here (after the fix) |
|---|---|---|
| The remainder when bases are mixed | **truncated towards 0.** `(i*0.1)*16` is 1 (2 if rounded), and negatively `(i*(-0.1))*16` is -1 (-2 with a floor) | made the same (it used to round) |
| Rounding in `F(w,d)` | **rounds away from 0.** 1.26→1.3, **1.25→1.3** (not to even), -1.25→-1.3. `F(w)` rounds to 0 places (1.99→2) | made the same (it used to truncate, and `F(w)` printed the value as it was) |
| Overflow in the `F` format | **keeps the rightmost w characters.** The high digits and the sign are dropped quietly (-12345 in `f(4)` gives `2345`). No condition is raised and it carries on | it already agreed |

**Rounding is a property of the format, not of assignment.** The same 1.26
becomes 1.2 (truncated) when assigned to `dcl y fixed dec(5,1)` and 1.3 when
printed with `f(6,1)`. This implementation did both through `assignTo`, which
made the F format truncate (now split out into `roundForFormat`).

On the same occasion the surroundings were checked, and **four more mistakes
turned up**. Every one of them was somewhere that had been decided by
guessing.

| | The real thing | Here (after the fix) |
|---|---|---|
| How often `ENDFILE` is raised | with the input `"12 34"` and `get list(a,b)`, **once** (raised by the read that reached the end). With the input `"12"`, **twice** (that, plus the b with no data) | made the same (it used to be once only) |
| The values that were read | with `"12"`, **a=12 / b=0**. Whatever was read is assigned | made the same (it used to **throw away the a that was read** and give 0) |
| The result precision of `ROUND` | **integer digits + n + 1.** With `dcl x fixed dec(5,1)`, the output width of `round(x,3)` is 11 (p=8, q=3). The extra digit is because rounding can carry (`round(9.9,0)` is 10) | made the same (it had no +1, and the scale was not set to n, so `round(x,3)` gave `12.5`) |
| When `**` falls back to FLOAT | **when the standard precision p = (p1+1)*y - 1 exceeds the maximum.** `2**9` is FIXED 512, `2**10` is FLOAT `1.0E+0003` | the same rule now (it used to be FIXED for any integer exponent, rounding the precision quietly). The boundary comes earlier here by the difference in maximum precision |
| The result precision with FLOAT | **the larger** of the two precisions. The FIXED side counts (`4**1.5` is FLOAT DEC(2), width 10) | made the same (it used to look only at the FLOAT side, giving width 9) |

**What was checked and found to agree** is recorded too (because those places
had been fixed by guessing): the direction `ROUND` rounds (away from 0), the
bit operations (bit by bit, the shorter side padded with `'0'B`, the result
length = max), a fractional exponent on `**` (FLOAT), the precision of
`2.0**3` (p=8, q=3), and division in `FIXED BIN` (`bin(31)/3` is **the integer
2** — a review said it "should be 2.33", but the real thing returns 2 as
well).

The golden cases `mixed-radix` / `mixed-radix-neg` / `fmt-round` /
`fmt-noprec` / `fmt-overflow` / `dec-assign` / `getlist-exhausted` /
`getlist-short` / `round-scale` / `power` / `bin-division` pin all of this
byte for byte.

### What was checked after the full review (2026-10-10, the second round)

Points left open as "do not fill it in by guessing" during the full review of
the code, the security and the documents were put to the real thing again.
**Two were wrong and three agreed.**

| | The real thing | Here |
|---|---|---|
| Comparing arithmetic with characters | **the character is converted to arithmetic and compared algebraically.** Against `i = 12`, `'12'`, `'012'` and `' 12'` are all true | made the same. It used to turn the number into characters and compare by collating sequence, which made all of them false, and left the disagreement that `i + 0 = 12` was true (because `asText` right justifies a number into its output field width, so the comparison was `"       12"` against `"12       "` and never matched) |
| Suppression in a `PICTURE` when the value is 0 | **if every digit can be suppressed (there is no `9` at all), the whole field, including the decimal point and the insertion characters**, becomes the fill character. `ZZV.ZZ` → five blanks, `ZZ,ZZZ` → the comma goes too, `**V.**` → five stars. With a `9` mixed in, only the usual leading-zero suppression applies (`ZZV.Z9` → `"  .00"`) | made the same. It used to suppress only the integer part |
| A decimal assignment into `FIXED BIN(p,q)` | **two conversions.** One decimal digit moves to four binary digits, so `0.1` becomes 1/16 = 0.0625, and going back to the declared scale of 10 does not bring the information back | it already agreed → **no change** (exactly as the standard's precision conversion says) |
| The result precision of `TRUNC` | **the same** as `CEIL` and `FLOOR`: `min(N, max(p-q,1)+1)` | lined up with the standard during the review; agreement confirmed |
| `DIVIDE(a,b,p,q)` | **builds the quotient at the given precision.** Even with a dividend of `DEC(15,0)`, `divide(a,b,5,4)` is 0.5000 | fixed during the review; agreement confirmed |

The golden cases `char-compare` / `pic-zero` / `bin-scale` /
`trunc-precision` / `divide-precision` pin these byte for byte (20 in all).

### Where the real implementation itself was broken

The thing being compared against is not perfect either. **The real thing was
not followed** on these.

| | The real thing | Here |
|---|---|---|
| `^` (NOT) | **does nothing.** `^'1100'B` is `'1100'B`, and `if ^('1'b)` is true | inverts, as the standard says (`'0011'B`) |
| `2**(-1)` | fails with an `ERROR` inside `_pli_EXP` | returns 0.5 (computed in FLOAT, as the standard says) |
| Input with no trailing newline | stream input fails with an `ERROR` inside `_pli_BufI` | reads to the last item |
| `MOD` with a fractional divisor | **the value is wrong.** `mod(7, 2.5)` is 0.7 (it should be 2.0), `mod(1, 0.5)` is 0.06 (it should be 0) | follows the IBM definition `x - y*floor(x/y)` |
| `MOD` with a negative divisor | `mod(7,-3)` is 1. The result of `MOD` has the sign of the second argument, so it should be -2 | -2 |

Every one of them was judged a mistake on the real side against the IBM
standard. `^` is the standard NOT operator, and if it does nothing then every
conditional expression is broken. For `MOD`, `mod(17,5)` and `mod(-7,3)` do
agree, so it is enough not to put the broken combinations into the goldens
(`mod(17,5)` in `decimal.pli` goes through as it is).

## Where this deliberately differs from the real implementation

Places where this **deliberately differs** from the thing compared against
(Iron Spring). Both were judged after looking at the real thing, and the
reasons are written down.

| | The real thing | Here | Why |
|---|---|---|---|
| The maximum decimal precision | **18 digits.** `put list(1/3)` gives `0.33333333333333333`, and `dcl b fixed dec(18)` goes through | **15 digits.** `1/3` is `0.33333333333333` | the compatibility target is IBM PL/I for MVS and VM 1.1, where the limit is 15. The 18 on the real side is its extension. The assertion window `FIXED DEC(15,5)` and the "15 digits" in the documents are lined up with this |
| How a record is delimited | **`RECSIZE` bytes at a time.** A newline is one byte of data (reading `"ab\ncdef\n"` with `RECSIZE(4)` gives `"ab\nc"` and `"def\n"`) | **one line, one record.** A line longer than `RECSIZE` is cut every `RECSIZE` characters, though | a virtual file is something you type and edit in a browser text box, and making the newline data would disagree with what the user meant. The same line as the storage format of DL/I. Since a long line is not thrown away, **a file with no newlines agrees with the real thing** |
| A record boundary for `GET LIST` | **not a delimiter.** Reading `"12\n34\n"` with `get list(a,b)` puts `1234` into a and 0 into b (the digits run together across the newline) | **a delimiter.** a=12 / b=34 | the standard says "the start of a new record is equivalent to a blank". The behaviour on the real side is outside the standard, and copying it would make newline-separated data unreadable |
| `%INCLUDE 'filename'` (the string form) | **not resolved** (nothing is included and the identifier becomes an undeclared variable with the default attributes; there is no diagnostic either) | accepted | in a browser and in VSCode, pointing with "a file name" is the natural thing, and the identifier form (`%INCLUDE decls;`) cannot point at a file you have. **This is an extension of this implementation**; the real thing has no such form |
| A negative n in `ROUND(x,n)` | takes **a negative scale** and prints in `F` notation (`round(15,-1)` gives `2F+1` = 20) | prints as an integer (`20`). The value is the same | the value model here assumes "the scale is 0 or more", and `render` treats `q <= 0` as an integer. Bringing in negative scales and `F` notation would ripple through the whole value model. **No digits are lost**, so it stays as a difference in presentation only |

The number of digits in the result of a division is decided by the maximum
precision, so **no division agrees byte for byte in the goldens**. That is why
`test/golden/decimal.pli` has no division in it.

The negative-n case of `ROUND(x,n)` is left out of the goldens for the same
reason (the value agrees but the presentation differs).

What could not be checked because of a limit on the real side: **input with no
trailing newline** fails there with an `ERROR` in stream input (raised inside
`_pli_BufI`). This implementation reads to the last item, so that is not
compared. **A fractional or negative divisor on `MOD`** is not compared
either, because the real thing is broken.

## `%INCLUDE` and the host abstraction

The one seam to the outside world (the files included from, the files read and
written) is `PliHost` in `src/host.ts`. Bringing `node:fs` into `src/` would
break the shape where one HTML file can be handed to anyone.

| The caller | What it passes |
|--------|---------|
| The browser version | the virtual files written in the Files box (`MemoryHost`) |
| The CLI | real files (`scripts/node-host.ts`; `node:fs` lives only there) |
| The VSCode extension | what is beside the open file and at the top of the workspace |
| The tests | an object made on the spot |

```pli
%include 'DECLS.inc';      /* a string */
%include decls;            /* a name (the extensions .inc, .pli and so on are tried in order) */
%include syslib(dsa);      /* a library reference; the name in the parentheses is used */
%include a, b;             /* several at once */
```

**An included token carries the name it came from.** Without it, a mistake in
an included file would be reported as a line of the main file and the
diagnostic would be a lie. It goes into `file` of the diagnostic, and both
VSCode and the browser version show it as `DECLS.inc line 2, col 5: ...`.

A circular include and nesting that is too deep (16 levels) are stopped as
mistakes. Left alone they never stop, so they are always stopped as mistakes.

`DCL f ENTRY;` is accepted too. A user-defined body in another file cannot be
called, but it keeps the linter from a false positive when a set of included
declarations contains an external procedure.

## Stream I/O

```pli
dcl inp file stream input;
dcl rep file stream output print;
dcl done bit(1);
dcl value fixed bin(31);

done = '0'b;
on endfile(inp) done = '1'b;
open file(inp) input, file(rep) output linesize(80);

do while(^done);
  get file(inp) list(value);
  put file(rep) skip list(value);   /* always print what was read */
end;

close file(inp), file(rep);
```

| Covered | What |
|------|------|
| Statements | `OPEN` / `CLOSE` / `GET` / `PUT` (with `FILE`; without it, SYSIN / SYSPRINT) |
| Options | `SKIP` / `PAGE` / `LINE(n)` / `LINESIZE` / `PAGESIZE` / `TITLE` |
| Conditions | `ENDFILE(f)` / `UNDEFINEDFILE(f)` (an ON unit per file) |
| Declarations | `FILE` `STREAM` `RECORD` `INPUT` `OUTPUT` `UPDATE` `PRINT` `ENVIRONMENT` |

The points in the design:

- **`ENDFILE` resumes from the ON unit and carries on.** That is different
  from the computational conditions (FIXEDOVERFLOW and the rest). Writing
  `on endfile(sysin) done = '1'b;` and using it as the loop test depends on
  it. **`UNDEFINEDFILE`, on the other hand, stops after running the ON
  unit.** Resuming would carry on with the file still not open, which would
  give a false result (`openFile` in `interp.ts`)
- **The declared use (`INPUT` / `OUTPUT`) is the stronger one.** An implicit
  OPEN passes "how it is being used now" (output for a `PUT`), and letting
  that win over the declaration would turn a `PUT` to a file declared `INPUT`
  into "open for output", **quietly destroying what is in a real file**. A
  disagreement becomes `UNDEFINEDFILE`, with the diagnostic naming which two
  disagreed. `UPDATE` accepts both reading and writing (`READ` and
  `REWRITE`). For the other attributes, such as `TITLE` and `PRINT`, what is
  written on the `OPEN` wins (`modeConflict` in `streamio.ts`)
- **`ENDFILE` is raised by "the `GET` that read the last item".** The value
  has been assigned by then, so writing `if ^done then put ...` **throws the
  last item away**. Always use the value that was read and use `done` only to
  decide whether to go round again (`InputCursor.atLastItem()`). **This rule
  was checked on the real thing**: when there is less input than there are
  items, it is raised **twice** ("the read that reached the end" and "the item
  with no data"), and whatever was read is assigned (the goldens
  `getlist-exhausted` / `getlist-short`)
- **The format depends on whether it is PRINT.** PRINT has the 24-column tab
  stops and page breaks; non-PRINT stream output only separates items with one
  blank
- **The line and column state is per file.** `LINESIZE` is per file, so a
  design sharing one `ListWriter` does not hold up
- A file name is an identifier, so it cannot contain a `.`. The host tries
  `data.txt` / `data.dat` / `data.csv` for `data`, in that order
- A file left unclosed is written back when the program ends

## PICTURE

```pli
dcl amount pic'$$$,$$9V.99';
dcl count  pic'ZZZZ9';
dcl rate   pic'S9V.999';

amount = 1234.5;     /* prints as " $1,234.50" */
amount = amount * 2; /* it works in arithmetic too; assignment edits it again */
```

| Character | What it means |
|------|------|
| `9` | a digit (zeros shown) |
| `V` | where the decimal point is (no character is printed) |
| `Z` `*` | zero suppression (filled with blanks / asterisks) |
| `$` `+` `-` `S` | the currency sign and the sign. Two or more in a row make it **drift** |
| `.` `,` `/` `B` | insertion characters (they become the fill character inside a suppressed range) |
| `CR` `DB` | at the end; printed only when the value is negative |

- Inside it is fixed-point decimal. The editing happens **only when
  printing**, so the arithmetic is written the same as an ordinary
  `FIXED DEC`. The picture does not travel to the result
- The comma in `$$$,$$9` is **part of the drifting string**. The sign goes
  just before the first significant digit (at the position of the comma in
  that example)
- An assignment that does not fit raises the **SIZE condition** (not
  `FIXEDOVERFLOW`)
- Concatenating with a string or assigning to a `CHAR` also gives the edited
  form
- The specifications that are not covered (`A` `X` `E` `K` `T` `I` `R` `G`
  `M`) are reported at declaration time as "a character that cannot be used"

## BASED storage and pointers

```pli
dcl (head, cur) pointer;
dcl 1 node based(cur),
      2 value fixed bin(31),
      2 next  pointer;

head = null();
allocate node set(cur);
cur -> node.value = 10;
cur -> node.next = head;
head = cur;
/* ... */
free cur -> node;
```

| Covered | What |
|------|------|
| Declarations | `POINTER` / `PTR`, `BASED(p)` / `BASED`, whole structures |
| Statements | `ALLOCATE x SET(p)` / `ALLOCATE x`, `FREE p -> x` |
| References | `p -> x`, `p -> rec.field` |
| Built-ins | `ADDR(x)`, `NULL()` |

**There is no address value.** A pointer is "a reference to storage that was
allocated"; there is no arithmetic (`p + 1`) and no reinterpreting as another
type. Imitating a real address space would mean writing an emulator, and the
cost does not match the goal of learning and checking. Refusing plainly is
better than half working and returning a lie.

Instead, **everything that would be undefined behaviour is always caught**.

| The operation | What PL/I says | Here |
|------|------|-----------|
| Following NULL | undefined behaviour | stopped as a mistake |
| Following freed storage | undefined behaviour (it sometimes appears to work) | stopped as a mistake |
| A double FREE | undefined behaviour | stopped as a mistake |

`ADDR(x)` returns a pointer that shares the cell of the variable, so a write
through the alias shows up in the original. When a pointer taken with `ADDR`
is looked at through another `BASED` declaration, and the storage holds only
one thing, it is taken to point at that (a simple form of overlaying types).

## Record I/O

```pli
dcl inp file record input env(f recsize(13));
dcl 1 rec,
      2 name char(10),
      2 age  pic'999';
dcl done bit(1) init('0'b);

on endfile(inp) done = '1'b;
open file(inp) input title('IN.TXT');
read file(inp) into(rec);
```

| Statement | What it does |
|----|------|
| `READ FILE(f) INTO(rec)` | read one record and spread it into the variable or structure |
| `READ FILE(f) SET(p)` | set a pointer at the record that was read |
| `WRITE FILE(f) FROM(rec)` | write one record |
| `REWRITE FILE(f) FROM(rec)` | replace the record just read (UPDATE) |

**Only items that can be represented as characters are handled.** A real
record holds storage itself (packed decimal and so on), which a virtual file,
being a string, cannot reproduce. Keep numbers in a `PICTURE` or in
characters. An item that cannot be handled is not quietly broken; it says
`cannot be used in record I/O` (the same check serves the segment I/O area of
DL/I and the message area of IMS, so the wording names which use it is).

**A `BASED` structure can go in `INTO` / `FROM` too.** Reading and writing the
leaves goes through `leafCells`, so it reaches a leaf whose storage lives
behind a pointer (`gatherLeaves` / `scatterLeaves`; see "Things that tripped
me up while building it").

The fixed length of `ENVIRONMENT(F RECSIZE(n))` pads with blanks when reading
and cuts when writing. A `KEY` option (an indexed file) is reported as not
implemented.

**A record is delimited by a line.** The real thing cuts every `RECSIZE` bytes
and treats a newline as data; here one line is one record (the reason is under
"Where this deliberately differs from the real implementation"). A line longer
than `RECSIZE` is not thrown away, though: it is cut every `RECSIZE`
characters. Throwing it away would make the rest disappear quietly, and with
this rule **a file with no newlines gives the same result as the real thing**
(reading `"abcdefgh"` with `RECSIZE(4)` gives `abcd` and `efgh`).

## IMS/DB (DL/I)

How to use it: [`../docs/en/dli.md`](../docs/en/dli.md). Here is how it is
built inside, and why it is shaped that way.

```
src/macro.ts reads assembler macro statements (shared by DBDGEN / PSBGEN / MFS)
src/dli/
  types.ts   the types and DliDefError
  dbd.ts     DBD → the hierarchy
  psb.ts     PSB → the order of the PCBs and the sensitive segments
  ssa.ts     parsing an SSA (a mistake comes back as a value, not an exception)
  store.ts   hierarchical segment storage (a tree + a hierarchic walk + the unload format)
  dli.ts     the engine itself (positioning and the status codes)
```

### Only the logical layer is reproduced

The hierarchic sequence, the sequence keys, positioning and the status codes
are handled as on a real system; the physical layer (the RAPs of HDAM,
pointers, OSAM data sets) is not. `ACCESS=HDAM` and `HIDAM` behave the same.
Everything a business program can see is decided in the logical layer, so this
is enough to learn and to check things with.

**Secondary indexes (`LCHILD` / `XDFLD`), logical relationships, `EXEC DLI`,
the AIB interface and sync points (`CHKP` / `ROLB`) are not implemented**, and
hitting one is refused by name. IMS TM (the message queue) and the screen are
taken by a separate layer (`src/tm/` and `src/mfs/`); see "Screen I/O (MFS)
and IMS TM" below.

### There is nothing to compare against

The output formats and the precision rules are derived from the output of a
real PL/I implementation, but that cannot be done for DL/I (IMS runs on z/OS
only, and the reference implementation at hand has no DL/I). So for DL/I the
IBM specification documents are the truth, and **the meaning of each status
code is quoted in the comments of `test/dli-engine.test.ts`**. That the
guarantee works differently here from the rest of the implementation is
written down rather than hidden.

### `BY ADDR` is not implemented in general

Output parameters are the essence of DL/I: the callee writes the status code
in the PCB and the segment I/O area.

Arguments of a user-defined procedure are passed **by reference** (as the
standard says), but only when "the variable itself was passed". DL/I passes
the PCB mask and the I/O area **as structures**, and the callee writes back
leaf by leaf. Implementing `BY ADDR` in general here would mean touching the
semantics of procedures, down to how dummy arguments are made. So **only calls
to built-in subroutines are special-cased.** `case "call"` in `interp.ts`
looks at `BUILTIN_SUBROUTINE_NAMES` only when resolving a user definition came
up empty, and passes the arguments to `plitdli()` **as expressions rather than
values**. The write-back goes through `assign` / `leafCells`, so the `SUBSTR`
pseudo-variable, `DEFINED`, `BASED` and array elements all work as they are.

The order is "user-defined, then the implementation" because being able to
write your own `PLITDLI` procedure and substitute it makes trying things
easier (it is also the usual technique for unit testing an IMS program).

### The PCB mask is tied by position, not by name

The item names in a PCB mask are the program's to choose (`STAT_CODE` or
`HOW_IT_WENT`, either is fine). `basedCells`, on the other hand, finds storage
**by the qualified name of the leaf**, so even if the implementation creates
the storage for the PCB first, the names do not match.

So `Storage` gained a mark called `pcbIndex`, and storage carrying that mark
ties its items **by the declaration order of the leaves** (`basedCells` in
`interp.ts`, placed after the `cells.size === 1` shortcut; before it, `ADDR`
plus an aliasing `BASED` would break). That is the same arrangement as a real
system laying them out by offset, and it holds up with the existing design
where a pointer has no address.

If the order is shorter than the standard says, it refuses and says how many
are needed. Accepting a short declaration quietly would send a non-structure
declaration down the implicit-declaration path, return 0, and produce a lie.

### The data is line-oriented text

`<DBD name>.dat` holds one segment occurrence per line, with the segment name
in the first 8 columns. **The hierarchy is decided by the order of the lines**
(the parent of a child is the occurrence of the parent type that appeared most
recently). That is the hierarchic sequence of IMS itself, so no new rule had
to be invented for the format. People can read it and diff it, and it can be
edited as a virtual file in the browser. It also lines up with the existing
I/O line that "a record is a line".

JSON was not chosen because every file of this implementation is plain text,
to match the file editing screen of the browser version and the style of the
linter and the tests.

### Things that tripped me up while building it

- **GNP must not move parentage.** Moving it makes the walk below dive one
  level per call and stop at the second one. The parent is established by `GU`
  and `GN`
- **`GA` and `GK` are warnings, and the segment is returned.** Making
  `stat_code = '  '` the loop test drops a segment wherever the hierarchy
  changes level. Both the samples and the examples use
  `stat_code ^= 'GB'`
- **The columns of an SSA.** The field name takes 8 columns and the relational
  operator 2, so there are three blanks between `STUDNO` (6 characters) and
  the `=`. Make it two and the operator reads as `=S` and you get `AJ`. The
  very first test stepped on this
- **Spreading into the leaves has to go through `leafCells`, or `BASED` is
  ignored.** Writing straight into `v.cells[0]` loses the write silently for a
  `BASED` leaf whose storage is behind a pointer, because its `cells` is
  empty. At first the record I/O side (`scatterRecord` / `gatherRecord`) wrote
  directly, and **`READ ... INTO(a BASED structure)` read nothing while
  throwing one record away**. The two were merged into one pair
  (`gatherLeaves` / `scatterLeaves`) so that record I/O, the segment I/O area
  and the message I/O area all go down the same road. Writing the same rule in
  two places means only one of them gets fixed
- **The linter has to be told the direction of the arguments.** The PCB is
  output, the segment I/O area is both, and the function code and the SSAs are
  input. Ignoring the direction produces false "never assigned" and "assigned
  but never read"
- **The test runner destroyed the data.** `plitest` wrote the updates of a
  `DLET` back to the real file, `examples/tests/STUDENT.dat` really was
  emptied, and the result changed from the second run on. It now writes
  nothing back by default (`--write` lets it land)

## Screen I/O (MFS) and IMS TM

How to use it: [`../docs/en/mfs.md`](../docs/en/mfs.md). Here is how it is
built inside, and why.

```
src/mfs/
  blocks.ts  the types of MID / MOD / DIF / DOF and the tables to find them by name
  source.ts  reads the format definitions (FMT / MSG)
  device.ts  the vessel of a 3270 screen (positions, attributes, the gap fields)
  output.ts  MOD + DOF → the screen
  input.ts   DIF + MID → a segment
  render.ts  the screen → text (for the tests and the CLI)
  check.ts   checks for what is probably a mistake but not worth stopping for
src/tm/
  tm.ts      the message queue (GU / GN / ISRT / PURG and the status codes)
  session.ts the round trip with the screen (one input = one run)
  keys.ts    the terminal script and the record of what it did
```

### One input = one run of the program

Screen I/O is "show it → a person types → carry on", which, built the obvious
way, means stopping the interpreter. Of the four options, **D** was taken.

| Option | What | The verdict |
|----|------|------|
| A | make the interpreter a generator / async | rejected: `yield` propagates through every evaluation path in `interp.ts` |
| B | wait with a Worker and `SharedArrayBuffer` | rejected: the COOP/COEP headers are needed, which means a server, which breaks "it runs as one HTML file" |
| C | re-run from the top every time an input arrives | rejected: database updates would be applied twice |
| D | **one input = one run** | taken |

**D is right because that is how a real MPP works.** `GU` takes one message
off the queue, the program processes it, returns it with `ISRT`, and when the
queue is empty `QC` ends it. The program is not alive between screens, and it
is IMS that holds the state of the conversation (the SPA). So a synchronous
interpreter is enough. **What a real system cannot do either** (going back and
forth with a person inside one run) cannot be done here.

### The screen goes down to the field; no data stream is produced

A real 3270 data stream (the `SBA` / `SF` / `IC` orders, the AID and the bytes
of read modified) is not produced. **Because there is no way to check it.**
IMS runs on z/OS only and there is no implementation to run at home. Pinning
something byte for byte when it cannot be checked means pinning a wrong value
with nothing to notice. What a business program sees is a segment, not a data
stream, so reproducing down to the field is enough.

It is shaped so that it can be added later, though: a screen is "a list of
fields with a position, attributes and contents", so one serialiser would turn
it into a data stream.

### Rules of the real thing that are easy to miss

- The attribute byte eats the position just before `POS`. For a field starting
  in column 1 it lands at the end of the previous row (which is why positions
  are counted linearly)
- A gap of two or more columns between defined fields gets a field of
  `NUM, PROT, NODISP`
- When the device already holds the same format, only the fields the MOD
  touches are rewritten (a message write). That is why what you typed is still
  on the screen that comes back
- The modified tag (MDT) is dropped on every write. Unless you type again it
  does not come back
- Only the fields with the modified tag are read, and trailing blanks are
  dropped. Without dropping them, `JUST=R` and `FILL=` would do nothing
- **The fill character comes from different places for input and output.**
  Input takes `MFLD FILL=`; output takes `DPAGE FILL=`, then `MSG FILL=`, then
  a blank. It is asymmetric, so which path looks at which is pinned by an
  invariant test
- **A key other than ENTER or PF is not treated like ENTER.** `CLEAR` wipes
  the device buffer and sends only an AID with no data (not one field comes
  back). `PA1` to `PA3` are what IMS uses for physical paging, which is not
  reproduced, so they are refused. `Aid` had the types and the script accepted
  them, but `formatInput` looked only at `pf`, so **both behaved exactly like
  ENTER**
- **Throw the output message away on an abnormal end.** When a real MPP
  fails, IMS backs out to the last sync point and sends DFS555I to the
  terminal. Updating the screen without looking at `result.ok` would show "a
  screen IMS would never send". Database updates stay, on the same promise as
  files (the sync points of an MPP are not reproduced)
- **In a conversational program, check the shape of the first `ISRT`.** Taking
  the first segment as the SPA unconditionally would turn the segment meant
  for the screen into the SPA, and it would come back as the next input
- **Keep the day-of-year formula in one place** (`src/datetime.ts`). Working
  it out from the floor of elapsed milliseconds is a day off in places with
  daylight saving, and then `DATE1` and `DATE2` on the same screen disagree

### Where the expected values come from

The same as DL/I: there is no real system to compare against. The IBM
specification documents are the truth and the reasons are quoted in the tests.
The golden screen images are kept in `test/screen/`, apart from the ones that
came from a real implementation (`test/golden/`), and a test checks that the
first line of their `.why` begins with "based on the IBM specification (not
the output of a real implementation)".

## The linter

It reports code that parses but is questionable. Details in
[`../docs/en/lint.md`](../docs/en/lint.md).

```bash
npm run plilint -- examples/tests       # a directory, recursively
npm run plilint -- --list-rules         # the rules and why
```

The main purpose is **`implicit-declaration`**. PL/I declares an undeclared
name implicitly (`FIXED BIN(15,0)` for `I` to `N`, `FLOAT DEC(6)` otherwise),
so a misspelling quietly becomes another variable and the program keeps
running on wrong values. In a language with no reserved words, having a
machine catch this kind of mistake is worth a great deal.

A linter is switched off the moment it cries wolf. Tests pin that the 14
samples of the browser version and `examples/tests` produce **0 findings**.

## Snippets

43 snippets are defined in `src/snippets.ts`. **That is the only source**;
`snippets/pli.json` for VSCode is generated.

```bash
npm run gen:snippets   # writes ../vscode-pli/snippets/pli.json
```

The same definitions can be inserted from "Snippet…" in the header of the
browser version. The VSCode snippet notation (`${1:name}`) is stripped by
`plainText()` before inserting, and from the second line on it lines up with
the indentation where it is inserted.

Tests check that every snippet **parses**, and that the ones marked
`standalone` **run as soon as they are inserted** (43 of them), so that a
snippet broken as PL/I cannot sit there unnoticed.

## The test framework

Tests written in PL/I, run by PL/I. Details in
[`../docs/en/test.md`](../docs/en/test.md).

```pli
/* math_test.pli — no main procedure */
SETUP: proc;
  /* runs before each test */
end SETUP;

TEST_DECIMAL_IS_EXACT: proc;
  dcl x fixed dec(5,2);
  x = 0.1;
  x = x + 0.2;
  call ASSERT_EQUALS(0.3, x, 'decimal is exact');
end TEST_DECIMAL_IS_EXACT;
```

```bash
npm run plitest -- examples/tests            # a whole directory
npm run plitest -- math_test.pli --xml out   # with XML for CI
```

One failure or error exits with code 1, so it goes into CI as it is.

The decisions are: the argument order of
`ASSERT_EQUALS(expected, actual, description)`, stopping at once when an
assertion fails, keeping failure (an assertion) apart from error (an
unexpected failure), `SETUP` / `TEARDOWN`, the `DISABLED_` prefix, and the XML
output for CI.

**There is deliberately no hook that runs once around the whole run.** Each
test runs as a separate program, so no state spans several tests and the
promise of "once" cannot be kept. Offering an API that cannot keep its promise
was judged the greater harm.

## The language of the messages

Everything shown to the user goes through one place
(`src/i18n/index.ts`).

```ts
throw new RuntimeError(m`PSB 名 ${name} は IMS の名前として使えません`, line);
// the key: "PSB 名 {0} は IMS の名前として使えません"
```

**The Japanese text itself is the key.** For two reasons.

1. The Japanese stays visible at the call site. With a separate key you would
   have to look the table up to know what comes out
2. **When the locale is `ja`, `m` returns exactly what plain concatenation
   would.** No existing output changes by one character, so the 160-odd
   assertions that look at the Japanese become the safety net as they are.
   Wrap something wrongly and the Japanese output changes and a test fails

There are three tools.

| | Where it is used |
|--|-----------|
| `` m`…` `` | translate now; the ordinary message inside an expression |
| `msg("…")` | the identity function; the mark for Japanese that sits in **a table at module level** (it is evaluated at import, so translating there would freeze it) |
| `tr(text, …)` | translate the Japanese marked with `msg` at the point of use |

The translations are in `src/i18n/en.ts`. `npm run gen:i18n` collects the keys
from the TypeScript syntax tree and lays the file out again (**never add a key
by hand**; regenerate after changing the Japanese).

What `test/i18n.test.ts` catches:

- Japanese that was never wrapped in `m` (it would come out in Japanese even
  in English; a bare string inside a `${...}` is caught too)
- a key whose translation is still empty, and a key that is no longer used
- a mismatch in the number of `{0}` placeholders between the key and the
  translation, and Japanese left in a translation
- that running in English really does come out in English (having it in the
  table and having it come out are two different things; a forgotten `tr` sits
  in between)

The language is decided with `setLocale`, `withLocale` or `RunOptions.locale`.
How each entry point (the CLI, the browser, VSCode) decides is in the root
README.

## The consumers

| Layer | What it does |
|------|------|
| `src/run.ts` | runs a source and returns diagnostics |
| `src/host.ts` | the seam to the outside world (`%INCLUDE` and files) |
| `src/lint.ts` | reports code that parses but is questionable |
| `src/snippets.ts` | the snippet definitions (the single source) |
| `src/testing.ts` | the test framework |
| `src/mfs/` | the screen formats (MID / MOD / DIF / DOF) and the screen itself |
| `src/tm/` | the message queue and the round trip with the screen |

`testing.ts` uses `run.ts`, so the run layer is kept out of `index.ts` to
avoid a circular import.

| Entry point | Where | What |
|------|------|------|
| The browser version | [`web/`](web/README.en.md) | **one HTML file.** Double click it; no server, works offline |
| The VSCode extension | [`../vscode-pli/`](../vscode-pli/README.en.md) | highlighting, diagnostics, running, tests, snippets. The implementation ships inside |
| The test CLI | `scripts/plitest.ts` | `npm run plitest -- <file/directory>` |
| The linter CLI | `scripts/plilint.ts` | `npm run plilint -- <file/directory>` |
| The screen CLI | `scripts/pli.ts --keys` | `npm run pli -- <file> --psb <name> --keys <script>` |

### The public API

```ts
// Not published to npm (package.json is private).
// Consumers import it relatively from inside the repository
import { runProgram } from "../engine/src/index.js";

const r = runProgram(source, {
  args: ["123"],           // the arguments of the main procedure
  maxSteps: 5_000_000,     // against infinite loops
  maxOutputBytes: 1_000_000,
  locale: "en",            // the language of the messages (the default is Japanese)
});
// r.ok / r.stdout / r.diagnostics[] / r.truncated / r.durationMs
```

Diagnostics come back as an array of
`{ severity, phase, line, col?, file?, callerLines?, message }`. `phase` is
one of `preprocess` / `lex` / `parse` / `runtime`. `file` is set only for a
mistake inside an `%INCLUDE`, and `callerLines` only for a run-time mistake
that happened inside a procedure.

**`runProgram` throws no exception.** It always returns a result object (in a
browser an exception would become an unhandled error in the UI).

A browser has no second process, so **infinite loops are stopped by the
engine**. It does not only count statements: it counts the turns of a loop as
well, so that a loop with an empty body (`do while('1'b); end;`) stops too.

**Limits apply inside a single statement as well.** `maxSteps` counts only
statements, so it does nothing about `put skip(1000000000)` or
`put edit(x)(x(200000000),f(1))`, and `maxOutputBytes` only applies at the
output stage, after the allocation. So the line counts of `SKIP` and `LINE`,
the widths of `X` / `COLUMN` / `E`, the repetition factors of a format and the
number of items after expansion are all checked against `maxStringLength`
**before anything is allocated** (`checkSpan`). `RECSIZE(0)` makes
`splitRecord` take no step at all and loop forever, so it is refused at parse
time.
