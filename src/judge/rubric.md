# Severity rubric

Assign `finalSeverity` from this rubric, not from the agent's label. Judge the impact of the
issue as it exists in the code shown, on the path the change actually adds or modifies.
When two levels both seem to fit, pick the lower one unless the code shows the higher impact.

## critical: must fix before merge

An exploitable security hole, data loss or corruption, or a crash on the main path.
The code shown must make the impact concrete; speculation never reaches critical.

- security: request input concatenated into SQL, a shell command or `eval`; an auth or
  permission check removed or bypassable; a secret or private key committed in source;
  disabled TLS verification on a production client.
- style: almost never. Only when a "style" issue hides one of the above (e.g. a shadowed
  variable that makes an auth check compare the wrong value).
- coverage: almost never on its own. Missing tests are at most high.
- architecture: a migration or schema change that drops or rewrites data without a path
  back; a change that breaks every caller of a public API at runtime.

## high: likely bug or security weakness on a reachable path

A defect that will probably happen in normal use, a weakness an attacker can plausibly
reach, missing tests for risky new logic, or a contract break.

- security: user-controlled path joined without normalisation (path traversal); missing
  authorization on a new endpoint; secrets or tokens written to logs; SSRF via a
  user-supplied URL; weak or predictable token generation.
- style: an error swallowed in an empty `catch` on a path that must report failure;
  `await` missing on a promise whose rejection is then unhandled.
- coverage: new branching logic for money, auth, permissions, parsing or data migration
  with no test touching it; a test that asserts nothing or can never fail.
- architecture: a public function's signature or return shape changed while callers in
  the repo still use the old one; a new circular dependency between modules; a
  synchronous blocking call (sync file or network I/O) added on a request path.

## medium: real but bounded

A genuine issue with limited blast radius: an edge-case bug, or maintainability debt that
will cost someone time soon.

- security: missing input length limits on an internal endpoint; overly broad CORS on a
  non-credentialed route; a verbose error message leaking internal paths.
- style: inconsistent error handling within one module (throw vs return null); a
  function over ~60 lines doing several jobs; misleading names on a public API.
- coverage: tests for new logic cover the happy path only and skip an obvious error or
  empty-input case; a removed test with no replacement for still-present behaviour.
- architecture: business logic placed in a transport layer (route handler, React
  component) that other code will need; duplicated logic that already exists in a helper.

## low: minor improvement

Correct code that could be clearer, safer or cheaper with little effort. No user impact.

- security: defence-in-depth suggestions (add a `Content-Type` check, prefer a constant
  time compare where timing is not exploitable).
- style: a magic number that deserves a named constant; a comment that no longer matches
  the code; dead code left behind.
- coverage: a test name that does not describe the case; a missing assertion on a
  secondary field.
- architecture: a helper that would read better in an existing module; an import from a
  deep internal path where a public entry point exists.

## nit: taste or consistency

Formatting, naming preference, ordering, wording. Never blocks anything. Anything a linter
or formatter configured in the repo would catch is a nit at most, and usually low-value.

- security: none; security observations are at least low or they are dropped.
- style: quote style, trailing commas, import order, preferring `const` over `let` for an
  unreassigned local.
- coverage: test file naming, `it` vs `test`.
- architecture: file placement preferences with no dependency consequence.

## Dropping

- `not-supported-by-code`: the code shown does not contain what the finding claims, the
  evidence is absent or contradicts the claim, or the line points at unrelated code.
- `out-of-scope`: the issue is real but sits in code this PR did not add or change, or is
  outside what a PR review should cover (product decisions, roadmap).
- `low-value`: true but not worth a reviewer's attention (most nits, restating a linter
  rule, generic advice with no concrete change).
- `duplicate`: only when the finding restates another kept entry and cannot be merged into
  it cleanly. Prefer merging.
