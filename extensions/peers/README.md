# peers

Lets independent pi sessions message each other. Either side can wake the other, steer it, or leave it a note. Each session stays an ordinary pi session with its own transcript, cost and lifecycle.

Unlike [subagents](../subagents/README.md), nobody owns anybody. Every session with this extension loaded is a peer. The exception is subagent children (`PI_SUBAGENT_RUN_DIR` set): they belong to their parent, so peers does nothing in them.

Requirements:

- `peer_spawn` needs `rex` in `PATH`, plus `REX_SESSION` or `placement.rexSession`. The other tools work without Rex.

## Concepts

- **Peer id**: the pi session id.
- **Label**: optional display name. Defaults to the session name.
- **Namespace**: optional, set only by the session itself. Sessions without one form the open pool. A session sees and reaches only peers in its own namespace.
- **Targets**: a peer id, a unique label, or the peer's Rex block id.

## Tools

### `peer_list`

List live peers in this session's namespace, with id, label, namespace, state, cwd and Rex block.

```ts
peer_list({})
```

### `peer_send`

Write a message to a peer's inbox. Returns the message id.

- `request` wakes an idle peer. A busy peer gets it once its current turn ends, or at once with `steer: true`.
- `note` never starts a turn. It reaches the peer on its next turn.

Messages that arrive while a peer is busy wait in its inbox. When the peer goes idle, they all arrive together as one message, oldest first, starting one turn if any of them is a request. Steers that are pending at the same moment are also combined into one.

```ts
peer_send({
  to: string,
  text: string,
  kind: "request" | "note",
  steer?: boolean,               // requests only
  replyTo?: string,              // id of the message this answers
})
```

There is no wait. Answers arrive as peer messages.

### `peer_spawn`

Start a new pi session in Rex and send it `prompt` as a request. By default it opens in a new, unfocused window of the current Rex session. Returns `{ peerId, blockId, windowId?, label?, namespace? }`.

```ts
peer_spawn({
  prompt: string,
  label?: string,
  namespace?: string | null,     // defaults to this session's; null means the open pool
  cwd?: string,
  model?: string,
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  placement?: {
    rexSession?: string,
    window?: "new" | string,     // a window id splits that window
    splitBeside?: string,        // block id
  },
})
```

The new session runs through the same pi executable as this one (`piw` stays `piw`) with `--session-id`, inside Rex's default login shell. Like any session the user starts, it does not inherit this session's shell-leash policy.

### `peer_set`

Change this session's own label or namespace. `null` clears a value.

```ts
peer_set({ label?: string | null, namespace?: string | null })
```

## Storage

- Label and namespace are saved in the session file as a `peers` custom entry, so `/resume` keeps them.
- The live registry is `<agentDir>/peers/<peerId>/`: `peer.json` (written only by its owner) and `inbox/` (one file per message). Each peer polls its own inbox every 250 ms.
- On shutdown a peer removes its registry entry. Undelivered messages stay and are delivered when the session resumes.
- When a peer starts, it removes records of dead peers. A dead peer's leftover directory is deleted once its newest message (or `peer.json`) is older than 7 days.

## Extension API

Other extensions use the same operations over `pi.events`, without importing peers:

- `peers:list`, `peers:send`, `peers:spawn`: emit `{ params, reply }`. `reply` receives `{ result }` or `{ error }`. `params` match the tool parameters.
- `peers:message`: emitted for every incoming message with `{ message, claim }`. Calling `claim()` synchronously keeps the message away from the model. Each message is offered once, as soon as it is seen, before it is combined with others.

`requestPeers` in `api.ts` wraps the request side for extensions in this repo.
