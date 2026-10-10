# The PL/I test framework

[日本語](../test.md) | **English**

Tests written in PL/I, run by PL/I.

A test is **just PL/I**; there is no special syntax for the framework. An
assertion is an ordinary procedure you reach with `CALL`. It is shaped this way
so that nothing has to be brought into the language.

## The shape of a test file

**Do not write a main procedure.** Just list procedures.

```pli
/* math_test.pli */

dcl counter fixed bin(31);

SETUP: proc;
  counter = 0;
end SETUP;

TEARDOWN: proc;
  /* cleaning up; it always runs, even when a test fails */
end TEARDOWN;

TEST_MOD: proc;
  call ASSERT_EQUALS(2, mod(17, 5), '17 mod 5');
end TEST_MOD;

DISABLED_TEST_NOT_READY: proc;
  call FAIL('not written yet');
end DISABLED_TEST_NOT_READY;
```

| Name | How it is treated |
|------|------|
| `TEST_*` | run as a test (only procedures with no arguments) |
| `DISABLED_TEST_*` | not run; reported as skipped |
| `SETUP` | run **before** each test |
| `TEARDOWN` | run **after** each test; it runs even when the test failed |
| Any other procedure | treated as a helper the tests can call |

Case does not matter (`test_mod` is fine). A procedure that takes arguments is
not taken as a test, because tests are called with none.

## Assertions

| Call | The condition |
|---------|------|
| `ASSERT_EQUALS(expected, actual, description)` | the numbers are equal (compared as `FIXED DEC(15,5)`) |
| `ASSERT_NEAR(expected, actual, tolerance, description)` | the difference is within the tolerance (when you want to see past the fifth decimal) |
| `ASSERT_NOT_EQUALS(unexpected, actual, description)` | the numbers differ |
| `ASSERT_EQUALS_CHAR(expected, actual, description)` | the strings are equal |
| `ASSERT_TRUE(condition, description)` | the condition is true |
| `ASSERT_FALSE(condition, description)` | the condition is false |
| `FAIL(description)` | fail unconditionally |
| `SKIP_TEST(description)` | mark this test skipped and stop it |

The argument order is **(expected, actual)**. Swap them and the
"expected / actual" in the report reads backwards, so it is worth keeping
straight.

Numeric assertions take `FIXED DEC(15,5)`. When they go into the report the
alignment blanks and the trailing zeros of the fraction are dropped, so it
comes out as `expected 10 / actual 9`.

### What happens when an assertion fails

1. A marked line is printed (for the framework to read later)
2. `SIGNAL ERROR` is raised
3. The `ON ERROR` unit the framework set up calls `TEARDOWN`
4. ERROR is not resumable, so the program ends there

So **the test stops the moment it fails, and `TEARDOWN` always runs.** A flag
guards against re-entering the `ON` unit if `TEARDOWN` itself fails.

## Each test runs as a program of its own

The framework builds and runs one driver program per test.

```
__PLITEST_RUNNER: proc options(main);
  <the assertions>
  <the contents of your test file>
  on error begin; call TEARDOWN; end;
  call SETUP;
  call TEST_MOD;      ← this one test only
  call TEARDOWN;
end __PLITEST_RUNNER;
```

What follows from that:

- **No state leaks between tests.** Even if a test overwrites a static
  variable, the next test starts from the initial state.
- **You cannot depend on the order.** Writing tests that depend on each other
  is not possible in the first place.
- **A hook that runs once around the whole run would mean nothing.** Each test
  is a separate run, so there is no such place as "once before everything".
  Offering an API that cannot keep its promise would do more harm, so there
  deliberately is none. If you have expensive preparation, put it in `SETUP`
  (which runs every time).

The price is speed: parsing and running are redone for every test. The engine
is fast enough that this measures 1 to 8 ms per test, so it does not matter.

## The CLI

```bash
npm run plitest -- examples/tests                  # a directory, recursively
npm run plitest -- a_test.pli b_test.pli           # files, listed
npm run plitest -- examples/tests --xml out/       # write out/<name>.xml per test file
npm run plitest -- examples/tests --quiet          # show only the files that failed
npm run plitest -- a_test.pli --max-steps 100000   # limit on the statements executed
npm run plitest -- examples/tests --psb STUPSB     # tests that use DL/I (IMS/DB)
npm run plitest -- a_test.pli --write              # let writes reach real files
npm run plitest -- examples/tests --lang en        # the report in English (PLI_LANG works too)
```

**By default writes do not reach real files.** If the data changed every time
you ran the tests, the second run would give a different result (which really
happened with a test that tried `DLET` in DL/I). Add `--write` only when you
want them to land.

How to write tests that use DL/I: [`dli.md`](dli.md). An example is
`engine/examples/tests/dli_test.pli`.

Given a directory, `*_test.pli` / `test_*.pli` / `*.test.pli` (with the
extension `.pli` or `.pl1`) are taken as test files. Given a file directly,
the name does not matter.

One failure or error is enough to **exit with code 1**, so you can put it in
CI as it is. A file where no test is found, or one that cannot be parsed, also
makes it 1 (with `--xml` that comes out as one error, so it does not vanish
from a JUnit-style summary).

```
--- arith_test.pli ---
  OK   TEST_DECIMAL_MULTIPLY_IS_EXACT (2ms)
  FAIL TEST_MOD (1ms)
       failed (line 12): 17 mod 5 : expected 3 / actual 2
  ERR  TEST_OVERFLOW (1ms)
       error (line 21): FIXEDOVERFLOW

tests 3 / passed 1 / failed 1 / errors 1 / skipped 0 / 4ms

--- output of TEST_MOD ---
[SETUP]
checking the remainder of 17 divided by 5
[TEARDOWN]
```

Whatever a test that failed or errored printed with `PUT` is appended to the
report (the output of the tests that passed is not, or the report would be
buried). It is also where you can see that `TEARDOWN` ran.

### The line number is "the line in the test file"

The line in the parentheses is **a line of the test file**, not of the driver
program.

The framework inserts the assertions (about 80 lines) before your source, so
printing the driver's line number would point at a line that is nowhere in the
test file. The number of inserted lines is counted from the string that was
built, so adding an assertion does not throw it off.

A mistake can happen **inside the inserted part** (a `FIXEDOVERFLOW` while
`ASSERT_EQUALS` converts to `FIXED DEC(15,5)`, for example). In that case the
chain of calls is followed to the innermost line that is in the test file —
that is, **the line where the assertion was written**. If following it finds
nothing, **no line is printed** (no made-up line).

## From an editor

| Entry point | How |
|------|------|
| The VSCode extension | `PL/I: Run tests` (`Cmd/Ctrl+Alt+T`) |
| The browser version | open the test file and press `Run`; it runs as a test automatically |

In both, a file with no main procedure that has `TEST_` procedures runs as a
test on `Run` too (running it as a program would only end with "there is no
main procedure", so redirecting it loses nothing of what you meant).

The decision itself lives in the engine (`testing.ts`) as `isTestFileName()`
and `isTestSource()`, and every entry point uses the same functions. What they
look at differs, though: the browser version has no file name, so only the
content (`isTestSource`); VSCode looks at both the name and the content
(either one is enough to redirect); and `plitest` walking a directory goes by
the naming convention (`--all` makes it look at the content as well).

## Using it from a program

```ts
import { runTestSource, formatReport, toXmlReport } from "../engine/src/index.js";

const report = runTestSource(source);
// failedOutput appends what the failed tests printed with PUT
console.log(formatReport(report, "math_test.pli", { failedOutput: true }));
writeFileSync("out.xml", toXmlReport(report, "math_test"));
```

A `TestReport` is
`{ results, total, passed, failures, errors, skipped, ok, durationMs, note? }`.
Each element of `results[]` is
`{ name, status, message?, line?, stdout, durationMs }`, where `status` is one
of `passed` / `failed` / `error` / `skipped`. `line` is the line of the test
file where the failure or the error happened (only when it is known).

```ts
// A CI annotation (GitHub Annotations and the like) needs both the file and the line.
// This is what plitest passes with --xml
writeFileSync("out.xml", toXmlReport(report, "math_test", { file: "test/math_test.pli" }));
```

`failures` (assertions that failed) and `errors` (unexpected failures) are
kept apart. The first is a test doing its job; the second means the test does
not hold together, and the reader has to do something different about it.

## Telling a failure from an error

The framework decides by whether the assertion marker was printed.

- With the marker it is a **failure** (an `ASSERT_*` or `FAIL` raised it)
- Without the marker but with an abnormal end it is an **error**
  (`FIXEDOVERFLOW`, `ZERODIVIDE`, going over the statement limit, a syntax
  error, and so on)

It does not go by the exit code alone, because implementations that report an
error and still exit successfully are not rare.

## Known limits

- `ASSERT_EQUALS` compares as `FIXED DEC(15,5)`. That is a window of **10
  integer digits and 5 fractional digits**: a difference past the fifth
  decimal is invisible, and 11 or more integer digits end the test with
  `FIXEDOVERFLOW`. If you hit either, use `ASSERT_NEAR` or
  `ASSERT_EQUALS_CHAR`
- An approximate comparison between floating-point numbers (the equivalent of
  `assertEquals(a, b, delta)`) is not implemented
- Asserting on an exception (the equivalent of `assertThrows`) is not
  implemented; use an `ON` unit and a flag instead
- Writing `OPTIONS(MAIN)` in a test file nests the procedures inside it, so
  the tests are no longer found. With a name such as `*_test.pli`, `plitest`
  and VSCode try to run it as a test and fail with "No tests found" (exit code
  1); in the browser version, where the name does not match, it runs as an
  ordinary program
