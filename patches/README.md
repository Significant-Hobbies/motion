# PartyKit runtime patch

PartyKit 0.0.115 bundles its own Undici factories. An override for Miniflare does not update those embedded bytes. This patch delegates the single bundled Undici export to the already installed Miniflare Undici 6.29.0, with an exact version guard. It adds no dependency and preserves all generated line numbers outside the changed factory line.

The old factories and source map remain in the package. Qualification verifies that all six outside callers use this entry, that executable entry exports are the actual resolved Undici object, and that the real inspector request publishes from the resolved request implementation. Retained inert bytes are not proof of an upstream update. Login, deployment and physical-device behavior remain unqualified.

Review this patch whenever PartyKit or Miniflare changes. Remove it only after the replacement proves runtime parity and resolves the embedded-runtime boundary. Do not promote source-map observations into publisher proof.

Fixture-only switches bind Workerd to loopback, choose the inspector port independently of the relay port, and use the read-only source checkout as the module root. The config, generated files and persistence stay inside the owned temporary fixture. Using the fixture directory as the module root while its entry point lives in the checkout creates escaping `..` module names that Workerd rejects. Without the qualification environment, PartyKit keeps its original host, inspector selection and module root.

The inspector request supplies its own resolved Undici Agent and closes it after consuming the response, including failure paths. Node and installed Undici share a global-dispatcher symbol; an installed fetch function alone can otherwise dispatch through an agent created by Node’s internal Undici. The qualifier observed that internal publisher before this request-specific correction. It verifies the actual external publisher afterward; login and deployment request paths remain unqualified.
