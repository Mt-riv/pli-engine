# pli-engine — write PL/I and run it

[日本語](README.md) | **English**

Write and run programs in the old language PL/I **in a browser alone**, or
**inside VSCode**. You do not have to install a compiler: the implementation
(an interpreter) is written from scratch in TypeScript and ships with the tool.

```pli
hello: proc options(main);
  put list('HELLO, PL/I');
end hello;
```

## What this project is for

**To let you get your hands on the procedural language PL/I and the
hierarchical database IMS without a mainframe.**

PL/I and IMS/DB were born in the 1960s (PL/I in 1964, IMS in 1968), and yet
there is almost no way for one person to touch them. z/OS is not something an
individual can rent, and both the PL/I compiler and IMS are commercial
products. The result is a technology people have heard of but never written or
run.

This set of tools brings those two down to **a single browser page**. Double
click one file and you can write PL/I and read and write a hierarchical
database on the spot. No install, no server.

| Why it matters | What it gives you |
|------|------|
| **Teaching** | You can learn "the way that is neither COBOL nor SQL" by running it: fixed-point decimal, column editing with `PICTURE`, `ON` conditions, positioning with `GU` / `GN` — every one of them is faster to run than to read about |
| **History** | A technology that does not run survives only as prose. Keep it running and you can check by hand why it was designed that way (why there are no reserved words, why there is no `JOIN`) |
| **A way into maintenance** | Someone who has to read PL/I or IMS code can try the grammar and the behaviour at home, and step on the traps (not reading the status code, mixing bases) safely before touching production |

This is a mock environment. It does not guarantee every behaviour, and it does
not replace a commercial product in performance or compatibility. It is a
**subset**. It never runs something it cannot do quietly: it names what is not
implemented and refuses.

## What PL/I is

A general-purpose programming language IBM announced in 1964 (Programming
Language One). It was meant to bring FORTRAN, for science and engineering, and
COBOL, for business, together into **one language**.

What stands out:

- **No reserved words.** `IF` and `THEN` can be variable names. Everything is
  decided by context, so this program is legal (and it runs here)

  ```pli
  dcl (if, then, else) fixed bin(31);
  if = 1; then = 2; else = 3;
  if if = then then then = else;
  ```

- **Fixed-point decimal is a type in the language.** Money arithmetic does not
  drift: `123.45 * 6.7` is exactly `827.115` (binary floating point would be
  off)
- **`PICTURE` edits the columns.** Put `1234.5` into
  `dcl amt pic'$$$,$$9V.99';` and you get ` $1,234.50`, leading blank and all,
  exactly as the standard says. The language itself has what you need to print
  a report
- **`ON` conditions catch failures.** You write exception handling
  declaratively, as in `on zerodivide ...` / `on endfile(f) ...` (a generation
  older than today's `try`)
- **Structures and arrays** were there from the start, and **pointers and
  `BASED` storage** came in a later version

It sits at a higher level than COBOL, and yet it had pointers and overlaid
storage before C spread. Of those, this implementation does not have
overlaying through `UNION` (see [Limits of the implementation](#limits-of-the-implementation)).

## What IMS/DB is

A **hierarchical database** IBM shipped in 1968 (IMS = Information Management
System). It was originally built to manage the bill of materials for the Apollo
program, which puts it **before** the relational generation.

It keeps data as a **tree**, not as tables.

```
STUDENT
  └ COURSE
      └ GRADE
```

The difference from an RDB is exactly the difference in how you write the
program.

| | Relational (SQL) | Hierarchical (IMS/DB) |
|---|---|---|
| Shape of the data | Tables and foreign keys | A tree of parents and children |
| Getting related data | `JOIN` | **Walk** the tree (parent to child) |
| Queries | You write what you want (declarative) | You write how to move (procedural) |
| Current position | None, unless you use a cursor | **Always there.** Where you were last changes what the next call returns |
| How failure is told | Exceptions and errors | **A status code** (no exception is raised) |

From PL/I you call it with `CALL PLITDLI`. DL/I (Data Language/I) is that
interface.

```pli
/* fetch student S0002 */
dcl ssa char(25) init('STUDENT (STUDNO   =S0002)');
call plitdli(four, func_gu, db_pcb, seg_io, ssa);
if db_pcb.stat_code = '  ' then put list(seg_io);
```

- `GU` (Get Unique) fetches one segment; `GN` (Get Next) walks the tree in
  hierarchical order
- The **DBD** (the database definition) decides what is where, and the **PSB**
  decides what the program may see. Both are text files
- **Failure raises no exception.** Unless you read the status code in the
  `PCB`, you process a segment that was never fetched as if it had been (the
  classic IMS mistake; the linter here reports it as
  `dli-status-unchecked`)

For the details, see [`docs/en/dli.md`](docs/en/dli.md).

## What you can do

| What | Where |
|-----------|------|
| Write PL/I and run it right away | [the browser version (one HTML file)](docs/en/browser-manual.md) / [the VSCode extension](docs/en/vscode-manual.md) |
| **Test** what you wrote (a test framework written in PL/I) | both + the CLI `npm run plitest` |
| Read and write a **hierarchical database (IMS/DB)** | both + the CLI `npm run pli -- x.pli --psb NAME` |
| Read and write a **3270 screen (MFS)** | the Terminal in the browser version + the CLI `npm run pli -- x.pli --psb NAME --keys x.keys` + VSCode |
| **Check** questionable code (a linter with 16 rules) | both + the CLI `npm run plilint` |
| Insert the shapes you write often from a **snippet** (43 of them) | both |

The part of PL/I that is covered (how it is built inside:
[`engine/README.en.md`](engine/README.en.md)):

- Declarations, expressions, assignment, `IF` / `DO` (`DO;` / `DO WHILE` /
  `DO UNTIL` / iterative, and several specifications) / `SELECT` / `GOTO` /
  `LEAVE` / `ITERATE`
- Procedures (nested, recursive, returning values), `BEGIN` blocks,
  structures, arrays, `DEFINED` + iSUB. Arguments are passed **by reference**
  as the standard says, and a temporary (a dummy argument) is made only when
  the declared attributes differ from what was passed
- `PUT LIST` / `PUT EDIT` / `GET LIST` / `GET EDIT` (with the column alignment
  the standard describes)
- **Exact fixed-point decimal arithmetic** (`123.45 * 6.7 = 827.115` with no
  drift)
- `ON` units and conditions. The eight that are raised are `ERROR` /
  `ZERODIVIDE` / `FIXEDOVERFLOW` / `SIZE` / `SUBSCRIPTRANGE` / `CONVERSION` /
  `ENDFILE(f)` / `UNDEFINEDFILE(f)` (`SIGNAL` can raise any name).
  `ON ... SYSTEM;` goes back to the default action. An `ON` unit for any other
  condition name parses, but never runs, because the implementation never
  raises that condition
- **Stream I/O** (`OPEN` / `CLOSE` / `GET FILE` / `PUT FILE` / `LINESIZE`)
- **`%INCLUDE`** (a mistake inside an included file is reported with the file
  name and the original line)
- **`PICTURE`** (numeric editing such as `$$$,$$9V.99`)
- **`BASED` storage and pointers** (`ALLOCATE` / `FREE` / `->` / `ADDR` /
  `NULL`)
- **Record I/O** (`READ` / `WRITE` / `REWRITE`, `ENVIRONMENT(F RECSIZE(n))`)
- **IMS/DB (DL/I)** (read and write a hierarchical database with
  `CALL PLITDLI`; DBD / PSB / SSA and the status code in the PCB. Details in
  [`docs/en/dli.md`](docs/en/dli.md))
- **Screen I/O (MFS) and IMS TM** (build MID / MOD / DIF / DOF from `FMT` /
  `MSG` definitions and lay out a 3270 screen; `GU` / `GN` / `ISRT` / `PURG`
  on the I/O PCB, the SPA of a conversational program, `/FORMAT`. Details in
  [`docs/en/mfs.md`](docs/en/mfs.md))
- 21 built-in functions, `%REPLACE`

The output formats and the precision rules were decided by comparing with the
output of a real PL/I implementation. The handling of conditions was compared
too, but **retrying a computational condition was deliberately left outside
the standard** (so that you cannot write a program that never stops; the
reason is under "Moving the handling of ON conditions away from the
standard" in
[`engine/README.en.md`](engine/README.en.md)). Nothing in the formats or the
precision was filled in by guessing. The three points that were left open
(rounding when bases are mixed, rounding in `F(w,d)`, overflow in the `F`
format) were checked on a real implementation as well, and **two of them led
to a fix** (see "What was settled against a real implementation" in the
same README).

There are five places where this **deliberately differs** from the real
implementation, with the reasons under "Where this deliberately differs from
the real implementation" in the same README
(the maximum decimal precision is kept at the 15 digits of IBM PL/I for MVS
and VM 1.1; a record is delimited by a line; `GET LIST` treats a record
boundary as a delimiter; `%INCLUDE 'filename'` is accepted; the n of
`ROUND(x,n)` does not take a negative scale).

**For the IMS parts (DL/I and MFS) there is nothing to compare against**: IMS
runs on z/OS only, and no implementation you can run at home is available. For
those two, the IBM specification documents are taken as the truth, and the
reason for each rule is quoted in the tests. The golden screen images are kept
somewhere else (`engine/test/screen/`) so that they never mix with the ones
that came from a real implementation, and a test checks mechanically that the
first line of their provenance begins with "based on the IBM specification
(not the output of a real implementation)".

## The language of the messages (Japanese / English)

Messages, diagnostics, linter findings, test reports and the text on the
screen come out in either Japanese or English. **Japanese is the default**, and
you switch explicitly. Neither the `LANG` environment variable nor the
browser's language setting is followed: if the same command or the same URL
spoke a different language depending on the machine, no test that pins the
output and no explanation of it would hold.

| Entry point | How to switch |
|------|-----------|
| The browser version | The language selector at the top (choosing one reloads the page with `?lang=en`; what you wrote is kept) |
| VSCode | The `pli.language` setting (`auto` / `ja` / `en`; the default `auto` follows the display language of VSCode) |
| The CLI | `--lang ja|en`, or the `PLI_LANG` environment variable |
| As a library | `setLocale("en")` / `withLocale("en", fn)` / `runProgram(src, { locale: "en" })` |

```bash
npm run pli -- examples/tests/arith_test.pli --lang en
PLI_LANG=en npm run plitest -- examples/tests
```

Only the command titles and the setting descriptions in VSCode are decided by
VSCode itself (`package.nls.*.json`), so they follow **the display language of
VSCode**. You can make the two disagree with `pli.language`, but with the
default `auto` they line up.

The translations live in `engine/src/i18n/en.ts`, keyed by the Japanese text
itself. `engine/test/i18n.test.ts` collects the keys from the syntax tree and
fails on anything that is missing.

## What you need

| | Version | For |
|--|----|------|
| Node.js | 20 or later | the build and the CLI. [nodejs.org](https://nodejs.org/) |
| git | optional | getting the source |
| VSCode | 1.90 or later | only if you use the extension |

To run it in a browser you do not even need Node.js after the build (what it
produces is a single HTML file).

## Setup

The commands below are written as paths relative to **the place you land after
the common steps (inside `pli-engine/engine`)**.

### Common (clone and build)

```bash
git clone https://github.com/Mt-riv/pli-engine.git
cd pli-engine/engine
npm ci
npm run web:build      # produces dist-web/index.html (one file)
```

#### macOS

```bash
open dist-web/index.html
```

To install Node.js with Homebrew: `brew install node`.

#### Windows

In PowerShell:

```powershell
git clone https://github.com/Mt-riv/pli-engine.git
cd pli-engine\engine
npm ci
npm run web:build
start dist-web\index.html
```

Node.js comes from the LTS installer at [nodejs.org](https://nodejs.org/) or
from `winget install OpenJS.NodeJS.LTS`. If the PowerShell execution policy
stops `npm`, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

#### Linux

```bash
xdg-open dist-web/index.html
```

The Node.js your distribution ships can be old. If it is below 20, use
[nodesource](https://github.com/nodesource/distributions) or
[nvm](https://github.com/nvm-sh/nvm).

### Installing the VSCode extension

#### From a release (the easy way)

Download `pli-lang-0.4.2.vsix` from
[Releases](https://github.com/Mt-riv/pli-engine/releases). No build needed.

With `gh`:

```bash
gh release download vscode-v0.4.2 --repo Mt-riv/pli-engine
```

#### Building it yourself

```bash
cd ../vscode-pli        # from pli-engine/engine
npm ci
npm run build
npx @vscode/vsce package      # produces pli-lang-0.4.2.vsix
```

#### Installing

In the extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) → the `…` at the top
right → **Install from VSIX** → pick `pli-lang-0.4.2.vsix`. With the `code`
command, `code --install-extension pli-lang-0.4.2.vsix` works too.

How to use it: [`docs/en/vscode-manual.md`](docs/en/vscode-manual.md).

### The CLI (tests and the linter)

```bash
cd ../engine            # if you skipped the VSCode steps you are already here
npm run pli -- examples/dli/stuprt.pli --psb STUPSB   # run one program
npm run plitest -- examples/tests    # run the tests written in PL/I (the PSB is found automatically)
npm run pli -- examples/screen/dbinq.pli --psb INVPSB --keys examples/screen/dbinq.keys  # the screen (MFS)
npm run plilint -- examples          # check for questionable code
npm run plilint -- --list-rules      # the rules and why each one is there
npm run pli -- --help                # the options
```

The same commands work on Windows (everything goes through `npm run`, so the
path separator does not matter).

`--help` lists the options. The main ones:

| Option | For | What it does |
|-----------|------|------|
| `--psb <name>` | `pli` / `plitest` | use IMS/DB (DL/I). Left out, `plitest` picks up a `*.psb` beside the source |
| `--keys <file>` | `pli` | play a terminal script and show the screens (MFS); the `*.mfs` beside the source are read as the format definitions |
| `--stdin <file>` | `pli` | feed SYSIN |
| `--max-steps N` / `--max-output N` | `pli` | limits on the run (an integer of 1 or more; a bad value exits with code 2) |
| `-I <directory>` | `pli` | add a search path for `%INCLUDE` and for files |
| `--allow-outside` | `pli` | allow reading and writing outside the source directory |
| `--write` | `plitest` | let writes from the tests reach real files (by default they do not) |
| `--all` | `plitest` | judge by content even when the file name breaks the convention |
| `--strict` | `plilint` | treat warnings as failures too |
| `--lang ja\|en` | all three | the language of the messages (default `ja`; `PLI_LANG` works too) |

**How far file I/O reaches.** By default `pli` reads and writes only the
directory the source is in and whatever `-I` adds. It cannot get out with
`../` or an absolute path, and a symbolic link is judged by where it really
points. Say `--allow-outside` when you mean to touch the outside.

## Manuals

| Document | What is in it |
|------|------|
| [`docs/en/browser-manual.md`](docs/en/browser-manual.md) | **the browser version**: running, testing, checking, snippets, files, sharing |
| [`docs/en/vscode-manual.md`](docs/en/vscode-manual.md) | **the VSCode extension**: commands, settings, troubleshooting |
| [`docs/en/test.md`](docs/en/test.md) | the design of the test framework and how to write tests |
| [`docs/en/lint.md`](docs/en/lint.md) | the linter rules and why each one is there |
| [`docs/en/dli.md`](docs/en/dli.md) | **IMS/DB (DL/I)**: writing the DBD, the PSB and the data, SSAs, status codes |
| [`docs/en/mfs.md`](docs/en/mfs.md) | **screen I/O (MFS)**: format definitions, the I/O PCB, scripts, conversational programs |
| [`engine/README.en.md`](engine/README.en.md) | inside the implementation: lexing, parsing, evaluation, formats |

The Japanese originals are in [`docs/`](docs/).

## Layout of the repository

```
engine/        the implementation (TypeScript, no dependency on Node)
  src/           lexing, parsing, evaluation, the linter, the test framework, PICTURE, I/O
  src/i18n/      the language of the messages (Japanese as the key, the English table)
  src/dli/       IMS/DB (DL/I)
  src/mfs/       screen I/O (MFS)
  src/tm/        IMS TM (the message queue and the round trip with the screen)
  web/           the browser version (built into one HTML file)
  examples/      tests written in PL/I (tests/) and working IMS/DB examples (dli/)
  scripts/       the CLI (pli / plitest / plilint / snippet generation) and the host for real files
  test/golden/   expected output pinned from a real implementation
  test/screen/   expected screen images (from the specification)
vscode-pli/    the VSCode extension (the implementation ships inside it)
docs/          documents (English under en/)
  browser-manual.md  the browser version
  vscode-manual.md   the VSCode extension
  test.md            the test framework
  lint.md            the linter rules and why
  dli.md             IMS/DB (DL/I)
  mfs.md             screen I/O (MFS)
```

## Limits of the implementation

This is a subset of PL/I. It is enough to learn and to check things, but the
following are not implemented.

- Indexed and direct-access files (`KEYED` / `REGIONAL`)
- The physical layer of IMS (the difference between HDAM, HIDAM and so on),
  secondary indexes, logical relationships, `EXEC DLI`, the AIB interface,
  sync points (`CHKP` / `ROLB`)
- A real 3270 data stream (the `SBA` / `SF` / `IC` orders), talking to tn3270,
  DBCS / EGCS, logical and physical paging, split screens,
  `MSG OPT=2` / `OPT=3`, `PASSWORD`, alternate PCBs (`CHNG`), MFS exit
  routines (details under "What is reproduced and what is not" in
  [`docs/en/mfs.md`](docs/en/mfs.md))
- `AREA` / `OFFSET`, self-defining structures (`REFER`), `UNION`, `LABEL`
  variables
- Arrays of structures (`dcl 1 tbl(3), 2 nm char(4);`). Put the dimension on
  the leaves (`dcl 1 rec, 2 nm(3) char(4);`)
- A repetition factor in `INITIAL` (`init((5) 0)`), variable array bounds
  (`dcl a(n)`)
- Multitasking (`TASK` / `WAIT` / `EVENT`)
- Floating point is the JavaScript number (shown with the digits of
  `FLOAT DEC(6)`)
- Pointers **hold no address value.** They are references to storage that was
  allocated, so there is no pointer arithmetic and no reinterpreting as
  another type (in exchange, NULL, freed and double-freed are always caught)
- There are only 21 built-in functions. The 99 names used in practice, such as
  `CHAR` / `SQRT` / `DATE` / `ONCODE`, are **known by name and refused as "not
  implemented"** (a name that is not known is an "unknown function", so a
  misspelling is distinguishable)

When you hit something that is not implemented, it says what by name.
Attributes (`KEYED` / `REGIONAL` / `AREA` / `UNION` / `LIKE` / `EVENT` and so
on), statements (`WAIT` / `DISPLAY` / `REVERT` / `DELETE` and so on), ways of
writing (a repetition factor in `INITIAL`, variable array bounds, an array of
structures), built-in functions and IMS calls (`CHKP` / `ROLB` / `CHNG` and so
on) are all told apart by name and answered with "not implemented". A word it
does not know is answered with "cannot read this", so a misspelling and
something unimplemented are distinguishable.

## Decisions in the design

- **The lexer does not decide keywords.** PL/I has no reserved words, and
  `IF IF = THEN THEN THEN = ELSE;` is legal. Whether a word is a keyword or an
  identifier can only be decided by context, so the decision is left to the
  parser
- **FIXED DECIMAL is a scaled BigInt.** Standing in a JavaScript number for it
  does not add up in decimal
- **A browser has no second process.** A runaway program is stopped by limits
  inside the implementation. The number of statements (5 million by default)
  and the output (1 million characters by default) are not enough on their
  own, because **a single statement** such as `dcl a(200000000)` can exhaust
  the memory, so there are limits on the number of array elements, on the
  length of a string and on the number of `ALLOCATE`s as well
- **Everything that touches the outside world goes through one place.**
  `%INCLUDE` and file I/O go through a seam called `PliHost`. Bringing
  `node:fs` into `src/` would break the shape where one HTML file can be
  handed to anyone

## Development

```bash
cd engine && npm ci && npm test         # the TypeScript side
cd ../vscode-pli && npm ci && npm test  # runs without starting VSCode
```

The output formats and the precision rules are pinned **byte for byte** in
`engine/test/golden/`. The tool that regenerates them lives in another
repository (`pli-oracle`, private), and the tests here run without it (see
[`engine/test/golden/README.en.md`](engine/test/golden/README.en.md)).

GitHub Actions runs the same things on every push to main and every pull
request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): type
checking, the tests, the tests written in PL/I, the linter, the browser build
and packaging the vsix, and it watches for vulnerabilities in the dependencies
that ship.

## Licence

[MIT License](LICENSE)
