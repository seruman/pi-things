# pstack in pi

pstack skills use Cursor names. In pi, read this file once per session, then map each Cursor name in a skill with the tables below. `<pstack>` means the folder that holds this file. If a Cursor field has no row, drop it and say so. Never pass a field or value the tool schema rejects.

This file is local to pi-things. `tools/sync-pstack.ts` regenerates everything else in `<pstack>`.

## Tools

| Cursor | pi |
| --- | --- |
| `Task` | `agent_spawn` (from codemode: `tools.agent_spawn`). Collect results with `agent_wait`, follow up with `agent_send`, and `agent_stop` every child when its work is done. |
| `AskQuestion` | Ask in plain text, one question at a time, with your recommended answer and the options. Wait for the reply. |
| Open a todolist | Keep the list in `${TMPDIR:-/tmp}/pstack/$PI_SESSION_ID/todo.md`. Create it at the start, update it at each step, and quote the open items in your reply when the user needs them. |
| Run another pstack skill (`/name` or "the **name** skill") | Read `<pstack>/skills/<name>/SKILL.md` and follow it. When you tell the user to type it, write `/skill:<name>`. |
| `Grep`, `Glob` | `bash` with `rg` and `fd`. |
| Cursor's built-in `create-skill` | The `writing-great-skills` skill (`/skill:writing-great-skills`). |
| `/deslop` from `cursor-team-kit` | `<pstack>/skills/deslop/SKILL.md`. |

## Subagent fields

| Cursor | pi `agent_spawn` |
| --- | --- |
| `subagent_type: generalPurpose` | Default spawn. Pass the brief as `prompt`. |
| `subagent_type: "poteto-agent"` | Default spawn. Start the prompt with: "Read `<pstack>/agents/poteto-agent.md`, then `<pstack>/skills/poteto-mode/SKILL.md` and `<pstack>/ADAPTER.md`, before any work." Use absolute paths. |
| `subagent_type: "comment-sicko"` | Default spawn. Start the prompt with: "Read `<pstack>/agents/comment-sicko.md` and act as that agent." |
| `readonly: true` | Keep the default tools and add "Do not edit files, commit, or push." to the brief. Check `git status` afterward. `tools: "readonly"` removes `bash`, so use it only when the agent needs no shell, git, or `gh`. |
| `readonly: false` | Default spawn. |
| `environment: "cloud"` | Create a worktree with the `git-wt` skill and pass it as `cwd`. Name the branch or commit the worker checks out. |
| `environment: "local"` | Omit. |
| `cloud_base_branch: <b>` | Create the worktree from `<b>` (`git wt new <name> --base <b>`). |
| `run_in_background: true` | `background: true`. |
| `resume` | `agent_send` to the existing handle when the work needs that child's state. Otherwise spawn a fresh child and paste the earlier result into its brief. |
| `file_attachments` | List the absolute paths in the brief. |

## Models

Every role runs on the parent model.

| Cursor | pi |
| --- | --- |
| Any model slug (`claude-*`, `grok-*`, `gpt-*`), a role line, or a panel of models | Omit `provider` and `model`. A "different model" second opinion or panel becomes independent fresh children on the parent model, each with its own brief. Say so once in the reply. |
| `auto` or `inherit-parent` | Omit `provider` and `model`. |
| Reasoning level (`-high`, `-xhigh`, `-max`) | `thinkingLevel`: `high`, `xhigh`, or `max`. Omit it to inherit the parent level. |
| `-fast` | Drop it. |
| The `pstack-models.mdc` rule, `~/.cursor/rules/pstack-models.mdc`, `/setup-pstack` | None. Use the parent model for every role and skip any step that reads or writes the rule. |

## Paths

pi may run under another name with its own config directory, so never hardcode `~/.pi`. Resolve these once per session with `bash`:

- `<session-dir>`: `dirname "$PI_SESSION_FILE"`. It holds this workspace's sessions. Unset `PI_SESSION_FILE` means an ephemeral session with no transcripts.
- `<agent-dir>`: the `*_CODING_AGENT_DIR` environment variable when one is set (`env | grep _CODING_AGENT_DIR=`). Otherwise two levels above `<session-dir>`, which is the default layout `<agent-dir>/sessions/<slug>/`.
- `<config-dir>`: the project config folder name, which is the name of the folder that holds `<agent-dir>`, such as `.pi`.

| Cursor | pi |
| --- | --- |
| `.cursor/skills/`, `~/.cursor/skills/` | `<config-dir>/skills/` in the project, or `<agent-dir>/skills/` for the user. |
| `~/.cursor/plugins/`, `.cursor-plugin/plugin.json` | `<pstack>`. |
| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` in the project, or `<agent-dir>/AGENTS.md` for the user. |
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | `<pstack>/<path>` when that file exists. Read the local copy. Give the user the URL when they need a link. |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | `<session-dir>/*.jsonl`. File names start with an ISO timestamp, so sort by name or by modification time. `$PI_SESSION_FILE` is the current session. For subagent transcripts, call `agent_list` with `includeStopped: true` and read each run's `sessionFile`. Read only this workspace's sessions. |

## Control skills

| Cursor | pi |
| --- | --- |
| `control-cli` (CLIs and TUIs) | The `rex` skill. Run the CLI or TUI in a Rex block and read its screen. |
| `control-ui` (browser, Electron, web UIs) | `agent-browser`. Run `agent-browser skills get core` once for its guide, and `agent-browser skills get electron` for Electron apps. |

## Evidence sources for `why`

Map the seven categories to what this environment has. Record the rest as gaps, not choices.

| Category | pi |
| --- | --- |
| Source control | `git` and `gh`. |
| Issue / ticket tracker | GitHub Issues and PRs through `gh issue` and `gh search`. No Jira or Linear. |
| Infrastructure observability | Sumo Logic through the `sumocli` skill. |
| Long-form documents, real-time team chat, error tracking, product analytics | No source. Record each as a gap. |

"List the available MCPs" means: check the tools in this session (including codemode MCP servers) and this table.

## Tooling

| Cursor | pi |
| --- | --- |
| `mise install` for TLC and Java (`statechart`) | Set `TLA2TOOLS` and `JAVA` before running the script. Get both from nix: `TLA2TOOLS=$(nix build --no-link --print-out-paths nixpkgs#tlaplus)/share/java/tla2tools.jar` and `JAVA=$(nix build --no-link --print-out-paths nixpkgs#jdk)/bin/java`. Other tools a skill installs come from `nix shell nixpkgs#<pkg>` too. |
| Script paths such as `pstack/skills/poteto-mode/scripts/...` | `<pstack>/skills/poteto-mode/scripts/...`. |

## Cursor-only features

pi has no Cursor Automations, Bugbot, Cursor cloud agents, Custom Modes, Origin, or built-in PR tool. When a step needs one, put one line in your reply, `Skipped in pi: <step>. <reason>.`, then go on to the next step. Do not stop, ask, or retry. When a later step needs what the skipped step made, leave a placeholder and name it in the line.

| Cursor | pi |
| --- | --- |
| Cursor Automations: routines, `update_state` calls, webhooks, routine wakes, `SendToUser` secret requests | Skip with the line. |
| Bugbot, agentic security review | Their comments on a GitHub PR are ordinary review threads, so triage them with `gh`. Skip a step that starts, waits for, or configures Bugbot. |
| Cursor cloud agents | `environment: "cloud"` maps to a worktree, as in Subagent fields. Skip a step that needs the cloud agent itself. |
| Origin (`origin pr ...`) | Use the `gh` form the step gives. That is not a skip. |
| A built-in PR tool | Use `gh pr create` and the other `gh` commands the step gives. That is not a skip. |
| Custom Mode, "Use as Mode" | Start each task with `/skill:poteto-mode`. |
| Skills excluded from this copy: `setup-pstack`, `make-bot-ui`, `ketchup-video` | Skip any step that runs them. Use `/skill:ketchup` in place of `ketchup-video`. |
