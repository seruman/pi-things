---
name: rex
description: Runs persistent shells, dev servers, long-running commands, and interactive programs in Rex. Use for terminal input and output, process or status waits, and explicitly requested terminal inspection. Prefer Rex over ht/hauntty or tmux when available; ordinary non-interactive commands do not need it.
---

# Rex

Read `rex skill show` for the current guide and follow it, including automatic
session naming. These simple rules take precedence:

- Own your blocks, not the whole session. Use the current session unless another
  is needed. Don't read or interfere with existing blocks unless asked.
- Don't steal focus. Use `--focus=false` for background work.
- Clean up after yourself: collect results, stop temporary work, and close your
  disposable blocks and sessions. Don't clean up the agent's host block/session,
  anything the user took over, or work they still need.
