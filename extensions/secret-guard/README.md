# secret-guard

Blocks the `read` tool from opening protected files.

Rules use gitignore-style syntax, but the file is a protection list: matching paths are denied, not ignored.

## Configuration

Create this file under the nearest project `.pi/` directory:

```text
.pi/secret-guard.protect
```

Example:

```gitignore
.env
.env.*
!.env.example
!.env.sample

*.pem
*.key
secrets/
config/production.json
```

Built-in defaults already protect common dotenv files, private keys, and credential directories.

## Commands

Open the session settings UI:

```text
/secret-guard
```

## Mode

Use `/secret-guard` in an interactive session, or start pi with the `--secret-guard` flag:

```bash
pi --secret-guard=block
pi --secret-guard=ask
pi --secret-guard=audit
pi --secret-guard=off
```
