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

## PartyKit/Miniflare recheck after the recording-transfer slice

The historical checkpoint above is not the current dependency or coverage
measurement. At frozen source `eb615b43db1ec9be1c3ff904b107a8680b1e27d6`,
an unfiltered `pnpm audit --json` reports 323 dependencies and zero findings
at **all** severities. The audit summarizer validates the report and selects
critical/high findings; it has no advisory allowlist. The expired risk exception
has already been removed. Do not confuse that with removal of the scoped
overrides or the executable patch documented in [patches/README.md](../../patches/README.md).

Official registry evidence still reports:

- [PartyKit latest](https://registry.npmjs.org/partykit/latest): 0.0.115,
  declaring exactly Miniflare 3.20240718.0 and esbuild 0.21.5.
- [Pinned Miniflare](https://registry.npmjs.org/miniflare/3.20240718.0):
  Undici `^5.28.4`. The latest stable Undici 5.x in the
  [registry manifest](https://registry.npmjs.org/undici) is 5.29.0, which still
  depends on `@fastify/busboy ^2.0.0`.
- [Miniflare latest](https://registry.npmjs.org/miniflare/latest):
  4.20260730.0, declaring Undici 7.28.0. This is outside PartyKit's exact pin;
  registry availability is not compatibility evidence for replacing that runtime.

An isolated lockfile-only fixture containing only PartyKit 0.0.115, with no
Motion overrides or patch and with scripts disabled, resolves Undici 5.29.0
and busboy 2.1.1. Its unfiltered audit reports 4 high, 9 moderate and 3 low
findings across 95 dependencies. The high findings are
[GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q),
[GHSA-v9p9-hfj2-hcw8](https://github.com/advisories/GHSA-v9p9-hfj2-hcw8),
[GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q)
on `partykit > miniflare > undici`, and
[GHSA-x8mw-p69m-v3mx](https://github.com/advisories/GHSA-x8mw-p69m-v3mx)
on its busboy child. These are actual unsuppressed findings, not inferred from
the repository's filtered gate output.

The official PartyKit 0.0.115 tarball was checked against the registry's SHA512
integrity. Its executable retains the original bundled Undici factory and has
no Motion delegation. A registry audit of dependency edges does not inspect
those embedded bytes. There is no evidenced patched replacement inside the
currently declared Miniflare/Undici ranges, nor a new published PartyKit release
removing this boundary. Keep the already-qualified Undici 6.29.0 override,
PartyKit executable patch and esbuild override unchanged. No dependency or
lockfile update is justified by this recheck. Login, deployment and native/device
behavior remain separate gates; no new real-relay qualification is claimed here.
