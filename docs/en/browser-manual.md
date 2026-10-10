# The browser version

[日本語](../browser-manual.md) | **English**

How to use the page that lets you write and run PL/I in a browser alone.
It is **one HTML file**, complete in itself: no server and no internet
connection.

## Starting it

```bash
cd engine
npm ci
npm run web:build          # produces dist-web/index.html (one HTML file)
```

| OS | How to open it |
|----|--------|
| macOS | `open dist-web/index.html` |
| Windows | `start dist-web\index.html` |
| Linux | `xdg-open dist-web/index.html` |

Double clicking it in a file manager works too. **Hand that file to someone
and they can use it the same way** (no Node.js needed).

While developing, `npm run web:dev` starts a server that reloads on change.

## The screen

```
┌─────────────────────────────────────────────────────────────┐
│ PL/I Engine v0.4.2 [Sample▼][Snippet▼][Run][Files][Lint][Terminal][Share] [English▼] │
├──────────────────────────────┬──────────────────────────────┤
│ source                 1:1   │ Output                        │
│  1 │ hello: proc options(main);                             │
│  2 │   put list('HELLO');  │  HELLO                        │
│  3 │ end hello;            │                               │
│    │                       ├──────────────────────────────┤
│                            │ diagnostics (click to jump)   │
├──────────────────────────────┤──────────────────────────────┤
│ [Extra files][Standard input] │ ok / 2ms / 1 lines of output │
│ ::: data.txt                 │                              │
│ 1 2 3                        │                              │
└──────────────────────────────┴──────────────────────────────┘
```

| Part | What it is for |
|------|------|
| Sample | loads one of 14 examples. All of them run |
| Snippet | inserts one of 43 shapes, lined up with the indentation where you insert it |
| Run (Ctrl+Enter) | runs the program |
| Files | opens and closes the drawer below (extra files and standard input) |
| Lint | runs the linter without running the program |
| Terminal | switches to the 3270 screen (MFS; see "Driving the screen (MFS)" below) |
| Share by URL | embeds the source in a URL |
| Line numbers | the current line is blue, a line with an error is red |
| Diagnostics | click one to jump to its line |
| Japanese / English | the language of the page and the messages (see "Changing the language" below) |

## Running

The `Run` button or **`Ctrl+Enter`**. The result comes out on the right.

```pli
calc: proc options(main);
  dcl x fixed dec(5,2);
  dcl y fixed dec(3,1);
  x = 123.45;
  y = 6.7;
  put list(x * y);     /* 827.115 — binary floating point would give 827.11499... */
end calc;
```

Mistakes come out as diagnostics below. Click one and the cursor moves to that
line.

- **An infinite loop is stopped for you** (the limits are 5 million statements
  executed and 1 million characters of output). `do while('1'b); end;` stops
  in about 0.1 seconds
- A browser has no second process, so these limits are the only safety net

## Running it as a test

A file with no main procedure (`OPTIONS(MAIN)`) that has procedures whose
names start with `TEST_` runs as a **test** when you press `Run`.

```pli
SETUP: proc;            /* runs before each test */
  counter = 0;
end SETUP;

TEST_DECIMAL_IS_EXACT: proc;
  dcl x fixed dec(5,2);
  x = 0.1;
  x = x + 0.2;
  call ASSERT_EQUALS(0.3, x, 'decimal is exact');
end TEST_DECIMAL_IS_EXACT;

DISABLED_TEST_WIP: proc;   /* the DISABLED_TEST_ prefix makes it skipped */
  call FAIL('not written yet');
end DISABLED_TEST_WIP;
```

The result looks like this.

```
--- Tests ---
  SKIP DISABLED_TEST_WIP (0ms)
       skipped (line 12): Not run because of the DISABLED_ prefix
  OK   TEST_DECIMAL_IS_EXACT (8ms)
  FAIL TEST_THIS_ONE_FAILS (2ms)
       failed (line 20): wrong on purpose : expected 10 / actual 9

tests 3 / passed 1 / failed 1 / errors 0 / skipped 1 / 12ms
```

Whatever a failed test printed with `PUT` is appended at the end. The
assertions you can use, and the thinking behind the design, are in
[`test.md`](test.md).

Picking the "How to write tests" sample drops a working example straight in.

## Checking (the linter)

The `Lint` button reports questionable code **without running it**.

```
line 2: unused is declared but not used. [unused-variable]
line 9: i is not declared. It is declared implicitly as FIXED BIN(15,0). [implicit-declaration]
```

- Yellow is a warning, red an error, grey information
- What is in the square brackets is the name of the rule

`implicit-declaration` matters most. PL/I declares an undeclared name
implicitly (`FIXED BIN(15,0)` if it starts with `I` to `N`, `FLOAT DEC(6)`
otherwise), so a misspelling quietly becomes another variable. The rules are
listed in [`lint.md`](lint.md).

## Inserting a snippet

Pick one from "Snippet…" in the header and it is inserted at the cursor. From
the second line on, it lines up with the indentation where you insert it.

| The ones used most | What they are |
|-------------|------|
| Main procedure | the skeleton with `OPTIONS(MAIN)` |
| Read from standard input | a read loop with `ON ENDFILE` |
| Read / write a file | from `OPEN` to `CLOSE` |
| Linked-list node | a `BASED` structure and a pointer |
| PICTURE for money | `PIC'$$$,$$9V.99'` |
| Test procedure | the shape of a `TEST_` |

## Using files

The `Files` button opens the drawer below. It has two faces.

### Extra files

Write several files in one box, separated by a `::: name` line.

```
::: decls.inc
  dcl total fixed dec(7,2);
  dcl rate  fixed dec(3,2);
::: data.txt
10 20 30
```

These are what `%INCLUDE` includes and what I/O reads and writes.

```pli
p: proc options(main);
%include decls;                      /* includes decls.inc */
  dcl inp file stream input;
  dcl (a, b, c) fixed bin(31);
  on endfile(inp) ;
  open file(inp) input title('data.txt');
  get file(inp) list(a, b, c);
  put list(a + b + c);
end p;
```

- Names are not case sensitive
- `%INCLUDE decls;` looks for `decls` → `decls.inc` → `decls.pli` →
  `decls.pl1` → `decls.cpy` → `decls.plinc`, in that order
- For I/O, `data` also tries `data.txt` / `data.dat` / `data.csv` (a PL/I file
  name is an identifier, so it cannot contain a `.`)
- **A file the program wrote appears in this box after the run.** You can use
  it as the next input as it is
- A mistake inside an included file is reported at its own position, as in
  `decls.inc line 2, col 5: ...`

### Using IMS/DB (DL/I)

Put a `<name>.psb` in the extra files and DL/I is on. On a real system the JCL
decides the PSB, but a browser has no JCL. Deciding from the files you put
there leaves less room for doubt than one more settings box.

```
::: STUDENT.dbd
         DBD  NAME=STUDENT,ACCESS=HDAM
         SEGM NAME=STUDENT,PARENT=0,BYTES=13
         FIELD NAME=(STUDNO,SEQ,U),BYTES=5,START=1,TYPE=C
         FIELD NAME=STUDNAME,BYTES=8,START=6,TYPE=C
         DBDGEN
         END
::: STUPSB.psb
         PCB  TYPE=DB,DBDNAME=STUDENT,PROCOPT=A,KEYLEN=5
         SENSEG NAME=STUDENT,PARENT=0
         PSBGEN LANG=PLI,PSBNAME=STUPSB,CMPAT=YES
         END
::: STUDENT.dat
STUDENT S0001YAMAKAWA
STUDENT S0002TSUKIMI
```

- With two or more `.psb` there is no way to choose, so it says so and runs
  without DL/I
- Updates from `ISRT` / `REPL` / `DLET` come back into the `.dat` box after
  the run
- How to write them: [`dli.md`](dli.md). Picking the "IMS/DB (DL/I)" sample
  brings these three files along

### Standard input (SYSIN)

What `GET LIST` and `GET EDIT` read.

```
10 20 30
40 50
```

```pli
p: proc options(main);
  dcl (v, total) fixed bin(31);
  dcl done bit(1);
  total = 0;
  done = '0'b;
  on endfile(sysin) done = '1'b;
  do while(^done);
    get list(v);
    if ^done then total = total + v;
  end;
  put list(total);
end p;
```

**`ON ENDFILE` is required.** Without it, the moment the input runs out the
program goes on to `ERROR` and ends.

Note that `ENDFILE` is raised by **the very `GET` that read the last item**
(the value has already been assigned). Give the example above
`10 20 30\n40 50` and the total is 100, not 150. Add an empty line at the end
and it becomes 150.

## Driving the screen (MFS)

**Terminal** in the header switches to the 3270 screen.

1. Put the format definitions (`::: name.mfs`) and the PSB (`::: name.psb`) in
   the extra files. The PSB needs an I/O PCB (`PCB TYPE=TP`, or `CMPAT=YES`)
2. Type the name of a MOD into "First screen" and press **Start**
3. Input boxes sit on top of the fields you can type into. Type and press
   **ENTER** (pressing Enter inside a box does the same)
4. For a PF key, pick it from the list on the right and press **Send**. If
   output messages are queued, press **Next screen**

Picking the **"Screen I/O (MFS) + IMS/DB"** sample brings in the format
definitions, the PSB and the database together and opens the terminal.

**The program is run from the top for every input** (the same as a real MPP).
The program is not alive between screens; what carries over is only the
database, the state of the conversation (the SPA) and which format is read
next. Details in [`mfs.md`](mfs.md).

**A conversational program (with a SPA) does not work in the browser
terminal**, because there is nowhere to give the length of the SPA. Try it
with `--keys` on the CLI, or with "Drive the screen (MFS)" in VSCode, writing
`SPA` in the script.

## Sharing

`Share by URL` embeds the source in the hash of the URL.

```
file:///.../index.html#s=aGVsbG86IHByb2Mgb3B0aW9ucyhtYWluKTsK...
```

- Opened over `http(s)://`, it copies the URL to the clipboard
- Over `file://` the clipboard is not available, so it rewrites the address
  bar. Copy it from there
- Opening that URL restores the content. **The extra files and the standard
  input ride along, not only the source**, so a program that uses `%INCLUDE`,
  file I/O or DL/I runs on the other side too. On the receiving side it is
  **not run automatically**: read it, then press "Run it" (which takes
  precedence over what was saved)
- Base64 makes it about 1.33 times longer, so a long source hits the browser's
  limit on URL length. Hand over the file itself in that case

## Changing the language

The selector at the top switches between Japanese and English. Choosing one
reloads the page with `?lang=en`, so not only the text on the page but the
messages, the diagnostics, the linter findings and the comments in the samples
come out in English. **What you were writing is kept** (it is saved before the
reload).

The language you chose is remembered in `localStorage`, so the next time you
open the page it is the same. You can also open a URL with `?lang=ja` or
`?lang=en` directly. The URL wins, then what was remembered; with neither, it
is Japanese. **The browser's language setting is not followed** (if the words
changed with whoever opened the same URL, this page could not be described).

## Saving

The source, the extra files and the standard input you are editing are saved
to `localStorage` automatically and restored the next time you open the page.
If saving is not possible, for example in a private window, nothing else
changes (it gives up on saving and carries on).

## Things people trip over

| What you see | Why, and what to do |
|------|-----------|
| `UNDEFINEDFILE (file xxx)` | the PL/I file name and the name of the extra file differ. Tie them together with `OPEN ... TITLE('data.txt')` |
| `UNDEFINEDFILE …… the file is declared INPUT but used as OUTPUT` | the declaration and the use are the wrong way round. With `dcl f file stream input;` use `GET`; with `output`, `PUT` |
| reading the input ends early | there is no `ON ENDFILE`. Add one and it carries on |
| the last item is not processed | that is when ENDFILE comes. Add an empty line at the end of the input |
| `Cannot find xxx for %INCLUDE` | check the name of the extra file. What follows `::: ` is the name, spelling and all |
| `PA1 (physical paging) is not implemented` | PA keys are not reproduced. Send with ENTER or a PF key |
| the page is blank | the build may be old. Run `npm run web:build` again |
| the share button looks dead | over `file://` it changes the address bar instead of copying |
| part of the page stays Japanese after changing the language | the reload did not finish. Choose it again, or open the page with `?lang=en` |

## Limits

- This is a subset, in an implementation written from scratch. Anything not
  implemented is reported by name (the list is under "Limits of the
  implementation" in [`../../README.en.md`](../../README.en.md))
- Record I/O is delimited by **lines**. Some implementations read a
  fixed-length record as bytes with no newline in them, so check that point
  for data you carry to another implementation
