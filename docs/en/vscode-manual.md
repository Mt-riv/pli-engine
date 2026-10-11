# The VSCode extension

[日本語](../vscode-manual.md) | **English**

Brings PL/I syntax highlighting, diagnostics, running, testing, linting and
snippets into VSCode. **The implementation ships inside it**, so no external
compiler is needed.

Extensions it handles: `.pli` `.pl1` `.plinc` `.inc` `.cpy`

## Installing

### From a release (the easy way)

Download `pli-lang-0.5.0.vsix` from
[Releases](https://github.com/Mt-riv/pli-engine/releases). No build needed.

```bash
gh release download vscode-v0.5.0 --repo Mt-riv/pli-engine
```

### Making the `.vsix` yourself

```bash
cd pli-engine/vscode-pli
npm ci
npm run build
npx @vscode/vsce package      # produces pli-lang-0.5.0.vsix
```

In the extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) → the `…` at the top
right → **Install from VSIX** → pick `pli-lang-0.5.0.vsix`. Then
`Developer: Reload Window` to load it.

If the `code` command is on your PATH, this works too.

```bash
code --install-extension pli-lang-0.5.0.vsix
```

### Using it while developing it

To try the extension while changing it, **open the `vscode-pli/` folder in
VSCode** and press `F5`. It builds and opens another window (the extension
development host) with `--disable-extensions`.

If you open the parent `pli-engine/`, `.vscode/launch.json` is not found and
`F5` does nothing.

## What it does

| Feature | How |
|------|------|
| Syntax highlighting | automatic (a TextMate grammar: 133 keywords, 98 built-in functions) |
| Diagnostics | automatic while typing. Shown with line and column in the Problems tab (`Ctrl+Shift+M`) |
| Run | `PL/I: Run` (`Ctrl+Alt+R` / `Cmd+Alt+R`) |
| Run with arguments | `PL/I: Run with arguments` |
| Tests | `PL/I: Run tests` (`Ctrl+Alt+T` / `Cmd+Alt+T`) |
| The screen (MFS) | `PL/I: Drive the screen (MFS)`. Plays the script and prints the screen images |
| Linter | automatic while typing. 16 rules |
| Snippets | 43 of them. Type `main`, `dowhile`, `getlist` and press `Tab` |

Every command is reachable from the command palette
(`Ctrl+Shift+P` / `Cmd+Shift+P`) by typing `PL/I:`.

## Running

Open a `.pli` and press `Ctrl+Alt+R`. The result comes out in the output panel
(the `PL/I` channel).

```
--- /path/to/hello.pli ---
HELLO, PL/I

ok / 2ms
```

- A runtime error is shown as a diagnostic too, so you can jump to the line
  from the Problems tab
- An infinite loop is stopped by the limits (5 million statements, 1 million
  characters of output)
- To pass arguments to the main procedure, use `PL/I: Run with arguments`
- IMS/DB (DL/I) uses a `*.psb` in the same directory as the source (when there
  is exactly one). The `pli.dli.psb` setting wins. When the PSB did not come
  from the setting, the first line of the output panel says
  `DL/I PSB: STUPSB (found beside the source)`

## Testing

Press `Ctrl+Alt+T` on a file that has no main procedure and lists procedures
whose names start with `TEST_`.

```pli
SETUP: proc;
  /* runs before each test */
end SETUP;

TEST_MOD: proc;
  call ASSERT_EQUALS(2, mod(17, 5), '17 mod 5');
end TEST_MOD;
```

```
--- /path/to/math_test.pli ---
  OK   TEST_MOD (2ms)
  FAIL TEST_OTHER (1ms)
       failed (line 9): description : expected 10 / actual 9

tests 2 / passed 1 / failed 1 / errors 0 / skipped 0 / 3ms
```

With a name such as `*_test.pli`, or when **there is no main procedure and
there are `TEST_` procedures**, `PL/I: Run` runs it as a test as well.
Running a test file as a program would only end with "there is no main
procedure", so it is redirected. It is not redirected when you ran it with
arguments.

The assertions and the design: [`test.md`](test.md).
Working examples are in `engine/examples/tests/`.

## Driving the screen (MFS)

**`PL/I: Drive the screen (MFS)`** from the command palette.

| What it needs | Where it goes |
|---------|---------|
| The format definitions `*.mfs` | the same directory as the source (all of them are read) |
| The terminal script `*.keys` | the `.keys` with the same name; otherwise you pick one from the same place |
| A PSB | a `*.psb` in the same directory as the source (exactly one). The `pli.dli.psb` setting wins. Either way it must have an I/O PCB |

A working example is in `engine/examples/screen/`. Open `dbinq.pli`, run this
command, and it works as it is, with no settings to touch.

The screen images come out in the output panel. The extension has no terminal,
so **the keystrokes are written in the script** (how to write it:
[`mfs.md`](mfs.md)). An unsaved `.mfs` or `.keys` you are editing is used as
it is in the editor, so you can run with a definition you have just changed
without saving.

## Checking (the linter)

It runs automatically while the syntax is valid, and the findings appear in
the Problems tab. **Each one carries the name of its rule**, so a finding that
is in your way can be turned off in the settings as it is.

```
unused is declared but not used.                 pli-lint(unused-variable)
i is not declared. It is declared implicitly as FIXED BIN(15,0).
                                                 pli-lint(implicit-declaration)
```

The rules and why each one is there: [`lint.md`](lint.md).

## Settings

Change them in `settings.json` (`Ctrl+,` → the file icon at the top right).

| Setting | Default | What it does |
|------|------|------|
| `pli.diagnostics.enabled` | `true` | check the syntax while typing |
| `pli.lint.enabled` | `true` | run the linter while typing |
| `pli.lint.rules` | `{}` | overrides per rule |
| `pli.run.maxSteps` | `5000000` | limit on the number of statements (against infinite loops) |
| `pli.run.maxOutputBytes` | `1000000` | limit on the output (characters) |
| `pli.dli.psb` | `""` | the name of the PSB for IMS/DB (DL/I). Empty means a `*.psb` beside the source is used (when there is exactly one) |
| `pli.language` | `"auto"` | the language of the messages and diagnostics (`auto` / `ja` / `en`); see "The language" below |

```jsonc
{
  "pli.lint.rules": {
    "goto-outside-on-unit": "off",
    "implicit-declaration": "error"
  }
}
```

Change a setting and the diagnostics on the open files are refreshed right
away (no reload needed).

### The language

`pli.language` decides the language of the messages, the diagnostics, the
linter findings, the test reports and the text on the screen.

| Value | What happens |
|----|-------------|
| `auto` (default) | follow the display language of VSCode: Japanese for Japanese, English for English. **With any other display language (French, say) it is Japanese** |
| `ja` | always Japanese |
| `en` | always English |

**The command titles (`PL/I: Run` and the rest) and the setting descriptions
do not change with this setting.** They are decided by VSCode itself
(`package.nls.json` / `package.nls.en.json`), so they follow **the display
language of VSCode**. With the default `auto` the two line up, so there is no
reason to touch it unless you want them to differ. To change the display
language itself, use `Configure Display Language` (VSCode has to reload).

Changing this setting alone takes effect from the next run and the next
diagnostics (no reload needed).

## How `%INCLUDE` is resolved

Where it looks, in order:

1. **Open files that are not saved** (you can include before saving)
2. The same directory as the file you are editing
3. The top of a workspace folder

The extensions `.inc` `.pli` `.pl1` `.cpy` `.plinc` are tried in that order.

A mistake inside an included file is reported with **its own file and line**.
It never comes out as a line number in the main file.

## Limits of the syntax highlighting

**PL/I has no reserved words.** This is legal, and it means "if `IF` equals
`THEN`, assign `ELSE` to `THEN`".

```pli
IF IF = THEN THEN THEN = ELSE;
```

Whether a word is a keyword or a variable can only be decided by context, so
colouring from a TextMate grammar is an approximation in principle (in the
example above, the second `IF` is a variable but is coloured as a keyword).

When you need the strict answer, look at the **diagnostics**: there the
bundled implementation really parses the source, so it resolves the context
correctly.

## Things people trip over

| What you see | Why, and what to do |
|------|-----------|
| nothing happens when you press the key | check that the language mode (bottom right) is `PL/I`. If it opened as another language, click there and switch |
| running says "This file is open as language ..." | the same as above. `"*.pli": "pli"` in `files.associations` in `settings.json` pins it |
| `F5` does not start the extension development host | check that you opened the `vscode-pli/` folder (from the parent folder `launch.json` is not found) |
| a flood of warnings in the Problems tab | those are linter findings. `pli.lint.rules` can turn them off one by one |
| `%INCLUDE` is not found | put it beside the file you are editing or at the top of the workspace. The extensions such as `.inc` are tried for you |
| tests say "No tests found" | check that the procedure name starts with `TEST_` and that it takes no arguments |
| every DL/I test fails with "No PSB was given" | check that there is exactly one `*.psb` in the same directory as the source. With two or more there is no way to choose, so name one in `pli.dli.psb` |
| "The parameters ... of the main procedure are declared as pointers" | this is an IMS program that receives PCBs. As above, it needs a PSB |
| the messages are English and the command titles Japanese (or the other way round) | `pli.language` and the display language of VSCode disagree. Set `pli.language` back to `auto` |

## Development

```bash
cd vscode-pli
npm ci
npm test          # runs without starting VSCode
npm run typecheck
npm run build     # esbuild makes dist/extension.js (with the implementation inside)
```

Everything that does not depend on the VSCode API is kept in `src/core.ts`, so
it can be tested without starting VSCode.
