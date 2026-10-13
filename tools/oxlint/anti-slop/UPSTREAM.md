# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/` at that commit, using its installer.
- Installed at: `tools/oxlint/anti-slop/`.
- Root `LICENSE` copied from the same commit; nested `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md` preserved.
- Local source changes: none. This provenance file and the root license are additions to the asset bundle.

All 18 generic rules are enabled in `.oxlintrc.json`, alongside native `oxc/no-accumulating-spread`.
The bundled Effect plugin is not registered: this repository does not depend on Effect.
Vendored code is excluded from linting and formatting to preserve a recoverable upstream snapshot.

Keep `oxlint` and `@oxlint/plugins` pinned to the same exact version when upgrading.
For updates, compare against this commit and preserve any later local changes rather than overwriting the directory.

## Scope limits

These rules use syntax and lexical scope, not the TypeScript checker. They do not prove that a `SAFETY:` comment is true,
resolve every imported type, or detect every filter/map pipeline or accumulator copy. The module-mocking rule recognizes
Jest/Vitest APIs, not Bun's `mock.module`. Continue running the repository's typechecks and tests.
