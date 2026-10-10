# PL/I VSCode Extension

[日本語](README.md) | **English**

Brings PL/I syntax highlighting, diagnostics, running, testing, snippets and
linting into VSCode. **The implementation (`pli-engine`) ships inside it**, so
no external compiler is needed.

> **The guide to using it is `docs/en/vscode-manual.md` in the repository.**
> This document is about how it is built and how to develop it.
> (Only the extension folder goes into the vsix, so there are no links
> pointing outside it.)

## What it does

| Feature | What |
|------|------|
| Syntax highlighting | a TextMate grammar: 133 keywords and 120 built-in functions (the 21 that are implemented and the 99 known only by name, coloured in separate scopes) |
| Diagnostics | checks the syntax while typing and shows it in the Problems tab with the line and column |
| Run | `PL/I: Run` (`Cmd/Ctrl+Alt+R`) shows the result in the output panel |
| Run with arguments | `PL/I: Run with arguments` passes arguments to the main procedure |
| Tests | `PL/I: Run tests` (`Cmd/Ctrl+Alt+T`) |
| The screen (MFS) | `PL/I: Drive the screen (MFS)` drives a 3270 screen through a script and prints the screen images in the output panel. The format definitions `*.mfs` and the script `*.keys` are read from the same place as the source |
| Snippets | 43 of them. Type `main`, `proc`, `dowhile`, `sel`, `onerr` and expand |
| Linter | checks against 16 rules while typing; the findings appear in the Problems tab with the rule id |
| IMS/DB (DL/I) | read and write a hierarchical database with `CALL PLITDLI`. Putting the name of a PSB in the `pli.dli.psb` setting turns it on |

Extensions it handles: `.pli` `.pl1` `.plinc` `.inc` `.cpy`

### Tests

A file with no main procedure that lists procedures whose names start with
`TEST_` runs as a test. How to write them and the list of assertions are in
`docs/en/test.md` in the repository.

```pli
TEST_MOD: proc;
  call ASSERT_EQUALS(2, mod(17, 5), '17 mod 5');
end TEST_MOD;
```

With a name such as `*_test.pli`, or when **there is no main procedure and
there are `TEST_` procedures**, `PL/I: Run` runs it as a test as well.
Running a test file as a program would only end with "there is no main
procedure", so it is redirected. It is not redirected when you ran it with
arguments, because then what you meant is clear.

### The linter

It works only while the syntax is valid, and reports undeclared names, unused
variables, mixed bases and the like. The rules and the reasons are in
`docs/en/lint.md` in the repository.

The Problems tab carries the rule id (`implicit-declaration`, for example), so
a finding that is in your way can be turned off in the settings as it is.

```jsonc
{
  "pli.lint.rules": { "goto-outside-on-unit": "off" },
}
```

### Snippets

The single source is `../engine/src/snippets.ts`, and `snippets/pli.json` is
generated with `npm run gen:snippets` (on the engine side). The browser
version uses the same definitions, so the two cannot drift apart.

## Settings

| Setting | Default | What it does |
|------|------|------|
| `pli.diagnostics.enabled` | `true` | check the syntax while typing |
| `pli.run.maxSteps` | `5000000` | limit on the number of statements (against infinite loops) |
| `pli.run.maxOutputBytes` | `1000000` | limit on the output (characters) |
| `pli.lint.enabled` | `true` | run the linter while typing |
| `pli.lint.rules` | `{}` | overrides per rule (`off` / `info` / `warning` / `error`) |
| `pli.dli.psb` | `""` | the name of the PSB for IMS/DB (DL/I). With a name, `<name>.psb` is read and the parameters of the main procedure become pointers to PCBs. Empty means DL/I is not used |
| `pli.language` | `"auto"` | the language of the messages and diagnostics (`auto` / `ja` / `en`). `auto` follows the display language of VSCode. The command titles and the setting descriptions are decided by the display language of VSCode |

## IMS/DB (DL/I)

Put the name of a PSB (without the extension) in the `pli.dli.psb` setting and
`CALL PLITDLI` can read and write a hierarchical database. Put
`<PSB name>.psb` / `<DBD name>.dbd` / `<DBD name>.dat` beside the open file or
at the top of the workspace. Left empty, DL/I is not used (`CALL PLITDLI`
stops, saying no PSB was given).

A PSB name is accepted only in the IMS form: 1 to 8 characters of A-Z, 0-9,
`$`, `#` and `@`. It becomes a file name as it is, so a value of any other
shape is ignored with a warning.

The details of how to write it are in `docs/en/dli.md` in the repository.

## How far file access reaches

`%INCLUDE` and file I/O read and write **only the directory of the open file
and the workspace folders**. They cannot get out with `../` or an absolute
path, and a symbolic link is judged by where it really points.

`PL/I: Run tests` writes nothing back to real files, so that a file a test
wrote does not change the next result. That is the same promise as `plitest`
on the CLI.

This extension **works only in a trusted workspace**
(`capabilities.untrustedWorkspaces: false`), because it reads the workspace
settings and the sources and parses them.

## Limits of the syntax highlighting

**PL/I has no reserved words.** This is legal code, and it means "if `IF`
equals `THEN`, assign `ELSE` to `THEN`".

```pli
IF IF = THEN THEN THEN = ELSE;
```

Whether a word is a keyword or a variable **can only be decided by context**,
so colouring from a TextMate grammar is an approximation in principle. In the
example above, the second `IF` is a variable but is coloured as a keyword.

When you need the strict answer, use the **diagnostics**: there the bundled
implementation really parses the source, so it resolves the context correctly.

## Layout

```
vscode-pli/
  package.json              the extension manifest (languages, grammar, commands, settings)
  package.nls.json          the Japanese text of the manifest (the fallback)
  package.nls.en.json       the English text of the manifest
  language-configuration.json  comments, brackets, indentation
  syntaxes/pli.tmLanguage.json the syntax highlighting
  snippets/pli.json         the snippets (generated from engine; never edited by hand)
  src/core.ts               everything that does not depend on VSCode (what the tests cover)
  src/extension.ts          the connection to VSCode
  src/i18n.en.ts            the English translations of the strings defined here
  .vscode/launch.json       the configuration F5 uses to start the extension development host
  test/                     checks on core.ts, the grammar file and package.json
```

Everything that does not depend on the VSCode API is kept in `core.ts`, so it
can be tested without starting VSCode.

## Development

```bash
npm ci
npm test        # runs without starting VSCode
npm run typecheck
npm run build   # esbuild bundles it into dist/extension.js (with the engine inside)
```

### Trying it

1. **Open this folder (`vscode-pli/`) in VSCode.** If you open the parent
   `pli-engine/`, `.vscode/launch.json` is not found and `F5` does nothing
2. `F5` starts the extension development host (`npm run build` runs first). It
   comes up with `../engine/examples/tests/arith_test.pli` open
3. `Cmd/Ctrl+Alt+T` for the tests, `Cmd/Ctrl+Alt+R` to run
4. If the keys do nothing, pick `PL/I: Run tests` from
   `Cmd/Ctrl+Shift+P`. If the command is not there, either the extension did
   not load or the file opened as another language id (check the language mode
   at the bottom right)

The extension development host starts with `--disable-extensions`. It loads no
other extension, so you can try things with no language id conflicts and no
noise in the log.

### Packaging

You need `vsce`.

```bash
npx @vscode/vsce package
```

The `.vsix` it produces can be installed with
`code --install-extension pli-lang-0.4.2.vsix`.

## Licence

MIT License (Copyright (c) 2026 Mt-riv). See the bundled `LICENSE`.
