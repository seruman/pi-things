# rex

Typed client for the Rex control API, shared by extensions in this repo.

- `rex-api.d.ts` is generated from `rex api list --json`. Do not edit it by hand.
- `client.ts` wraps `rex api call -s <session> <method> <json>` through an injected `exec`. Every call takes an explicit Rex session id; nothing is read from the environment.

Helpers: `newWindow`, `newSplit`, `listBlocks`, `describeBlock`, `closeBlock`. Anything else goes through the typed `call(sessionId, method, args)`.

Terminal blocks get only `cwd` and `command`, so Rex runs the command through the user's default login shell.

## Regenerating types

After a Rex update:

```bash
bun run generate:rex                                  # reads `rex api list --json`
bun extensions/rex/generate.ts api.json && bunx oxfmt extensions/rex/rex-api.d.ts  # or from a saved list
```
