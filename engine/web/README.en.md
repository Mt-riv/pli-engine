# The browser version

[日本語](README.md) | **English**

**One HTML file** that runs `pli-engine` in a browser alone. No server and no
internet connection.

> **The guide to using it is
> [`../../docs/en/browser-manual.md`](../../docs/en/browser-manual.md).**
> This document is about how it is built (why it is one HTML file, and what is
> pinned).

## Handing it out and using it

The build produces exactly one `dist-web/index.html`. **Hand that file over,
have them double click it, and that is all it takes.**

```bash
cd ..                 # run this one level up from here (engine/)
npm ci
npm run web:build     # produces dist-web/index.html (one HTML file)
open dist-web/index.html   # macOS; start on Windows, xdg-open on Linux
```

Nothing to install, nothing to unpack. A browser is enough.

### If you want it on a local server

```bash
npm run web:dev       # the dev server (changes show up at once)
npm run web:preview   # check the build output
```

## Why one HTML file

Reading an external file with `<script type="module" src="...">` is blocked by
CORS when the page is opened over `file://`, and nothing works. So the output
is an IIFE embedded directly in the HTML (the `singleFile` plugin in
`vite.config.ts`).

Where it is embedded matters too: an inline classic script is not deferred the
way a module is, so putting it in `<head>` makes it run before the DOM exists
and nothing works. It goes just before `</body>`. Both of these are pinned by
tests.

## What it does

- **No external dependency** — it never reaches a CDN, so it works offline
- An editor with line numbers; click a diagnostic to jump to its line
- Share by putting the source in the hash of the URL
- Saves to `localStorage` automatically
- 14 samples (tests guarantee that all of them run)
- **43 snippets** — inserted from "Snippet…" in the header, lined up with the
  indentation where you insert them
- **Test mode** — a file with no main procedure that has `TEST_` procedures
  runs as a test on `Run` and lists what passed and failed
  ([`../../docs/en/test.md`](../../docs/en/test.md))
- **The files box** — where you write what `%INCLUDE` includes and what I/O
  reads and writes, separated by `::: name` lines. **A file the program wrote
  appears here too**
- **The standard input box** — what `GET LIST` and `GET EDIT` read (SYSIN)
- **The Lint button** — runs the linter without running the program
  ([`../../docs/en/lint.md`](../../docs/en/lint.md))
- **The terminal** — switches to the 3270 screen (MFS). Input boxes sit on top
  of the 24x80 screen image for the fields you can type into. The program runs
  from the top for every input
  ([`../../docs/en/mfs.md`](../../docs/en/mfs.md))

It is built on a `textarea` rather than an editor such as Monaco so that no
connection to a CDN is needed and it works offline.

## The language

The selector at the top switches between Japanese and English. Choosing one
reloads the page with `?lang=en`, so the text on the page, the messages, the
diagnostics and the comments in the samples all switch together (what you
were writing is kept, because it is saved before the reload). The language you
chose is remembered in `localStorage`.

**`navigator.language` is not consulted.** If it were, the same URL would
speak different languages to different people and this page could not be
described. The default is Japanese.

The English table (`../src/i18n/en.ts`) goes into the HTML as well, which adds
about 60KB to the single file. Loading per language would cut that, but it
would break the shape where one HTML file is complete in itself, so it stays
in (`test/web.test.ts` watches the limit at 350KB).

## Limits when opened over file://

A browser does not treat `file://` as a secure context, so some things are not
available. None of them get in the way.

| Feature | What happens over file:// |
|------|----------------|
| `localStorage` | it may be unavailable. Saving is given up and the page carries on |
| The clipboard | unavailable. The share button updates the hash of the URL instead, so you can copy it from the address bar |

That the share button does not go dead when there is no clipboard is pinned by
a test (there was a bug where optional chaining short-circuited the whole
chain and the fallback never ran).

## Stopping infinite loops

A browser has no second process, so the limits are inside the engine.

- Statements executed: 5 million
- Output: 1 million characters

A loop that never ends, such as `do while('1'b); end;`, stops in about 0.1
seconds. Counting statements alone would miss a loop with an empty body, so
the turns of a loop are counted too.
