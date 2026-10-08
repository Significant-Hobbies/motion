# Development-tool dependency repair

Tracked by [Motion #26](https://github.com/Significant-Hobbies/motion/issues/26).

The 8 October 2026 audit found critical shell-quote and high source-map-js
advisories in existing development tooling. The critical/high gate correctly
failed; an older green CI run did not cover the newer advisory database.

Vitest and its coverage provider now use 4.1.11, and the web build uses Vite
7.3.7. Scoped overrides resolve existing transitive dependencies to patched
versions without adding a production dependency:

| Parent | Dependency | Patched version |
| --- | --- | --- |
| concurrently | shell-quote | 1.11.0 |
| magicast, postcss | source-map-js | 1.2.2 |
| vite | postcss | 8.5.23 |
| knip | smol-toml | 1.9.0 |

Review these overrides when their parents change and remove them when the
parent's declared minimum excludes the affected versions. Keep the frozen
lockfile and the real resolved-dependency regression checks.

`scripts/development-command-quoting.test.mjs` exercises concurrently's actual
shell-quote dependency. It rejects four line terminators after a comment token
and preserves quoting of ordinary arguments. It never executes the generated
shell text. These cases failed before the update and pass afterward.

Local verification: 16 focused tests and all 42 tests pass; `pnpm check` and
`pnpm quality:swift-format` pass. The audit reports zero critical/high findings
and one moderate finding. PartyKit 0.0.115, its runtime patch, Miniflare and
resolved Undici 6.29.0 are unchanged. The patched executable/source-map hashes
match the baseline and the network-disabled runtime inspection passes. These
checks do not establish a new real-relay, login, camera or physical-device run.

The remaining moderate esbuild advisory is in PartyKit's 0.21.5 dependency.
An override across its declared minor range requires separate real-relay
compatibility qualification. No new exception or relaxed threshold hides it.
Coverage remains 6.43% lines, with three complexity violations, five duplication
groups and 4,553 Swift-format diagnostics. An iOS test target/coverage and the
remaining unused-code debt are still part of the open umbrella issue.

Primary advisories: [shell-quote](https://github.com/advisories/GHSA-pqg4-j6r4-53mv),
[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q),
[Vitest](https://github.com/advisories/GHSA-82fw-gwwq-j7x9),
[PostCSS](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp),
[smol-toml](https://github.com/advisories/GHSA-r4xh-jqrq-34v2),
[remaining esbuild finding](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
