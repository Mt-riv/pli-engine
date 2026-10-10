# The PL/I linter

[日本語](../lint.md) | **English**

Once the source parses, it reports **code that runs but is questionable**.
Syntax errors are left to the diagnostics from the run, so the linter does not
deal with them. While the syntax is broken the linter returns nothing (so that
findings do not flicker while you type).

## Using it

```bash
npm run plilint -- examples/tests          # a directory, recursively
npm run plilint -- a.pli --strict          # treat warnings as failures too
npm run plilint -- a.pli --lang en         # findings in English (PLI_LANG works too)
npm run plilint -- a.pli --rule goto-outside-on-unit=off
npm run plilint -- --list-rules            # the rules (16 of them) and why
```

By default, **one error is enough to exit with code 1**; warnings alone exit
with 0. `--strict` makes warnings failures as well.

| Entry point | How |
|------|------|
| The VSCode extension | automatic while typing; shown in the Problems tab with the rule id |
| The browser version | the `Lint` button |
| The CLI | `npm run plilint` |
| From a program | `lint(source, opts)` |

## The rules

Three severities: `error` / `warning` / `info`. `off` turns one away. 16 in
all.

### correctness — either wrong, or where wrong comes from

| id | Default | What it is |
|----|------|------|
| `implicit-declaration` | warning | a name is used without being declared |
| `unqualified-member` | **error** | a structure item is referred to by its own name only |
| `undefined-procedure` | **error** | a procedure that is not defined is called |
| `unused-variable` | warning | declared but never used |
| `assigned-but-never-read` | warning | assigned but never read |
| `never-assigned` | warning | read before anything is put in it |
| `unused-procedure` | warning | defined but never called |
| `shadows-builtin` | warning | a name is declared that a built-in function already has |
| `missing-main` | warning | there is no procedure with `OPTIONS(MAIN)` |
| `mixed-base-arithmetic` | warning | FIXED DEC and FIXED BIN are mixed in one calculation |
| `file-not-declared` | warning | a file is used without being declared |
| `endfile-without-on` | warning | a file is read with no `ON ENDFILE` |
| `free-then-use` | warning | a pointer is used after being freed |
| `dli-status-unchecked` | warning | DL/I is called but the status code is never read |
| `on-never-raised` | warning | an `ON` unit is set for a condition this implementation never raises |

**`implicit-declaration` is what this linter is mainly for.** PL/I declares an
undeclared name implicitly (`FIXED BIN(15,0)` for names starting with `I` to
`N`, `FLOAT DEC(6)` otherwise). A misspelling quietly becomes another
variable, and the program keeps running on wrong values without an error. In a
language with no reserved words, having a machine catch this kind of mistake
is worth a great deal.

`unqualified-member` is a particularly nasty form of the same thing. This
implementation keeps structure items under the name "parent.item", so writing
the item alone **declares another variable implicitly**. Write
`out_attr = '00E8'X;` when you meant `msg_out.out_attr = '00E8'X;` and the
assignment goes to another variable with nothing to stop you. The finding
names the structure the item belongs to.

`mixed-base-arithmetic` answers a trap that was really stepped on. When the
bases are mixed, PL/I converts to BINARY and computes there, so digits held in
decimal are lost. 13 factorial raising FIXEDOVERFLOW is an example.

Only **a mix that involves a fraction** is reported.

```pli
dcl i fixed bin(15);
i = 1;
put list(i * 0.1);     /* reported: converting 0.1 to a binary scale leaves a remainder */
if i = 10.5 then ...;  /* reported: a comparison also lines up the bases first */
put list(i - 1);       /* not reported: an integer loses no digits in binary */
```

The operators watched are `+` `-` `*` `/` `**` and the eight comparisons. All
of them go through `unifyBase`, so they produce the same remainder.

`dli-status-unchecked` answers the most common mistake in IMS programs. DL/I
raises no exception when it fails; it tells you through the status code in the
PCB. If you do not read it, a segment that was never fetched is processed as if
it had been. The status code is the third item of the PCB mask and can be
given any name, so it is found by position rather than by name (the same rule
the implementation itself uses). The remaining items of the PCB mask are
filled in by DL/I, so not reading them does not count for
`assigned-but-never-read`.

### style

| id | Default | What it is |
|----|------|------|
| `goto-outside-on-unit` | info | GOTO is used outside an ON unit |

Leaving an ON unit needs GOTO, so the inside of an ON unit is not reported.

## About false positives

A linter is switched off the moment it cries wolf, so tests pin that known
good code produces no findings.

- the 14 samples in the browser version → 0 findings
- the 5 test files in `examples/tests` → 0 findings
- the examples in `examples/dli` and `examples/screen` → 0 findings (CI
  watches this with `npm run plilint -- examples --strict`; running them is
  `test/examples.test.ts`)

Points the checks are careful about:

- **The first argument of `LBOUND` / `HBOUND` / `DIM` does not read the
  value.** It only asks about the shape of the array, so it is not "read
  before anything was put in it"
- **Assigning to the `SUBSTR` pseudo-variable is a write to its first
  argument.** `substr(s,3,2) = 'XY'` is not mistaken for a call to `SUBSTR`
- **Parameters are never reported as unused.** Whether they are used is up to
  the caller
- **The main procedure and the test procedures (`TEST_` / `SETUP` /
  `TEARDOWN`) are never "never called".** They are the entry point, or the
  framework calls them
- **In a test file, `ASSERT_*` and the rest are taken as known.** The
  framework injects those procedures at run time, so the source has no
  declaration of them
- **A structure is not undeclared under its qualified name (`REC.NAME`) nor as
  itself (`REC`)**

## Using it from a program

```ts
import { lint, formatLint, RULES } from "../engine/src/index.js";

const messages = lint(source, {
  rules: { "goto-outside-on-unit": "off", "implicit-declaration": "error" },
});
console.log(formatLint(messages, "a.pli"));
```

A `LintMessage` is `{ rule, severity, line, col?, message }`. Expression nodes
carry no line, so a finding points at **the line of the statement**.

## The VSCode settings

| Setting | Default | What it does |
|------|------|------|
| `pli.lint.enabled` | `true` | run the linter while typing |
| `pli.lint.rules` | `{}` | overrides per rule |

```jsonc
{
  "pli.lint.rules": {
    "goto-outside-on-unit": "off",
    "implicit-declaration": "error"
  }
}
```

The Problems tab carries the rule id, so a finding you see can be turned off
in the settings as it is.
