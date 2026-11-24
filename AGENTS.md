# apw

apw is a macOS CLI for Apple Passwords and verification codes. It uses a local daemon and a separate Chromium profile
with Apple's iCloud Passwords extension. Start it with `deno task dev start` after setting up a supported browser as
described in the README. Build the CLI with `deno task compile`.

Run `deno fmt --check`, `deno lint`, and `deno check --frozen src/cli.ts` before submitting changes. The
development-only approval prototype builds and tests with `deno task approval:test` on macOS with Swift installed.

To try the native approval prompt with a fictitious request, run:

```sh
printf '%s\n' '{"origin":"https://login.example.test","account":"demo@example.test"}' | deno task approval:demo
```

Send exactly one JSON object on standard input. Use a serialized HTTPS origin with a lowercase ASCII DNS host, no path,
and no explicit default port. The account identifier is visible ASCII without spaces. The executable returns a single
JSON outcome and exits with `0` for approval, `1` for denial, `2` for invalid input, or `3` for unavailable biometrics.
Tests use a fake approver and require neither Touch ID nor a real credential.

Run `deno task approval:mcp:test` for the stdio tool tests. The Chrome handoff uses `--open-chrome` with the native
helper and returns `browser_opened` or `browser_unavailable` in addition to the shared failure outcomes. The user
completes sign-in in Chrome. The tool never reads credentials and never connects to the regular daemon. An automated
credential consumer must verify the actual tab origin and the selected account inside a component isolated from the
requester.
