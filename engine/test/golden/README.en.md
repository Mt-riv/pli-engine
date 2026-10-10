# The expected values of the golden tests

[日本語](README.md) | **English**

The `*.expected` files here pin **the output of a real PL/I implementation**
byte for byte. `golden.test.ts` requires them to agree.

## The set of files

| File | What it is for |
|---------|------|
| `<name>.pli` | the program to run |
| `<name>.expected` | the standard output expected (byte for byte) |
| `<name>.why` | **the provenance**: why that output was judged correct (required) |
| `<name>.in` | standard input (optional) |
| `<name>.args` | the arguments of the main procedure, one per line (optional; no set uses it at the moment) |

Without a `.why`, `golden.test.ts` fails. An expected value with no provenance
is nothing more than "what this implementation prints today", and pinning it
means nothing.

## Regenerating them

**Never write an `.expected` by guessing.**

The tool that regenerates them is in **another repository, `pli-oracle`
(private)**. The implementation used for comparison (Iron Spring PL/I) is a
32-bit x86 binary and does not run on an arm64 Mac. Setting up an environment
for it and handling what it ships are that repository's job, so none of it is
brought into this one, whose premise is "it runs as one browser page". **What
lives here is only the pinned expected values and where they came from.**

The steps (set the environment up → watch the behaviour → regenerate the
expected values → write the `.why` → `npm test` here → tear the environment
down) are under "next time a real implementation is needed" in the
`pli-oracle` README. How to use the tool is there too, and not here.

This test itself runs without `pli-oracle` (it only compares against the
pinned `.expected`). So does CI.

## No division in here

The number of digits in the result of a division is decided by **the maximum
precision**. The real thing (Iron Spring) has a maximum decimal precision of
18, and this implementation has 15, to match IBM PL/I for MVS and VM 1.1, so
no division agrees byte for byte. The difference is deliberate, and the reason
is under "Where this deliberately differs from the real implementation" in
`engine/README.en.md`.

## IMS/DB (DL/I) does not go in here

IMS runs on z/OS only and there is nothing to compare against. For DL/I the
IBM specification documents are the truth, and the meaning of each status code
is quoted in the comments of `dli-engine.test.ts` and `dli-fixes.test.ts`.
The guarantee works differently, so the two are not mixed.
