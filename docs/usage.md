# pi-cmux usage

Detailed usage for the cmux integrations bundled with `pi-cmux`.

## Notifications

`cmux-notify` sends `cmux notify` alerts when Pi finishes a run.

Notification fields:
- title: `Pi` by default
- subtitle: `Waiting`, `Task Complete`, or `Error`
- body: short run summary

Notification bodies are summarized from:
- changed files from `edit` and `write`
- reviewed files from `read`
- searches from `grep` and `find`
- shell activity from `bash`
- final agent errors, with first tool failure as fallback

Set `PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1` to append up to 500 characters of the final assistant response to non-error notifications. This is disabled by default because assistant responses may contain sensitive text.

Noise controls:

```bash
PI_CMUX_NOTIFY_LEVEL=all       # Waiting, Task Complete, Error
PI_CMUX_NOTIFY_LEVEL=medium    # Task Complete, Error
PI_CMUX_NOTIFY_LEVEL=low       # Error only
PI_CMUX_NOTIFY_LEVEL=disabled  # off
```

## Sidebar status/log

`cmux-sidebar` updates the cmux right sidebar while Pi runs. It only activates inside a cmux workspace (`CMUX_WORKSPACE_ID` is present).

It uses:
- `cmux set-status` for a Pi status pill: idle, running, tool, waiting, done, or error
- `cmux set-progress` for coarse run progress while Pi is active
- `cmux log` for run starts, changed files, warnings, and final summaries
- `cmux trigger-flash` when a run finishes and the surface needs attention

Environment settings:

```bash
PI_CMUX_SIDEBAR=0                    # disable sidebar integration
PI_CMUX_SIDEBAR_FLASH=all            # all | error | disabled
PI_CMUX_SIDEBAR_LOG_TOOLS=1          # log every tool result
PI_CMUX_SIDEBAR_LOG_PROMPT=1         # include truncated prompt in start log
PI_CMUX_SIDEBAR_PROGRESS=0           # disable progress bar updates
PI_CMUX_SIDEBAR_STATUS_KEY=my-key    # override status key
```

## Split Pi sessions

```text
/cmv [initial prompt]
/cmh [initial prompt]
```

- `/cmv` opens a split to the right.
- `/cmh` opens a split below.
- Both start `pi` in the same working directory.

Examples:

```text
/cmv
/cmh
/cmv Review the auth flow in this repo
```

Legacy aliases:
- `/cmux-v` → `/cmv`
- `/cmux-h` → `/cmh`

## Tool splits

```text
/cmo <command...>
/cmoh <command...>
```

- `/cmo` opens a split to the right and runs a shell command.
- `/cmoh` opens a split below and runs a shell command.
- Commands run via `sh -lc` in the current project directory.

Examples:

```text
/cmo hx
/cmo lazygit
/cmo npm test
/cmoh npm run dev
/cmo watch -n 1 git status --short
```

Alias:
- `/cmov` → `/cmo`

## Zoxide directory jumps

```text
/cmz <query>
/cmzh <query>
```

- `/cmz` resolves a zoxide match or direct directory path, then starts Pi in a right split.
- `/cmzh` does the same in a lower split.

Examples:

```text
/cmz mono
/cmzh ~/src/project
```

Legacy aliases:
- `/z` → `/cmz`
- `/zh` → `/cmzh`

## Continuation and worktree handoff

```text
/cmcv [note]
/cmch [note]
/cmcv -c <branch> [--from <ref>] [note]
/cmch -c <branch> [--from <ref>] [note]
```

- `/cmcv` opens a continuation split to the right.
- `/cmch` opens a continuation split below.
- Notes are added as focus context.
- `-c <branch>` creates a new branch worktree and starts Pi there.
- `--from <ref>` chooses the base ref for the new worktree branch.

Examples:

```text
/cmcv
/cmcv focus on tests
/cmcv -c fix/notify-bug
/cmcv -c fix/notify-bug --from main
/cmcv -c fix/notify-bug --from main review the existing changes
/cmch -c feature/review-ui focus on edge cases
```

Same-checkout continuation creates a related handoff session and adds a summary of the current context. If the current Pi session is persisted, the new pane also inherits the current conversation path.

Worktree continuation starts a new session in the target worktree and seeds it with structured handoff context from the source pane.

## Review workflows

In-place prompt templates:

```text
/review <target>
/review-diff [focus-or-pr-url]
/skill:code-review
```

Split review commands:

```text
/cmrv
/cmrh
/cmrv [--bugs|--refactor|--tests] <target>
/cmrh [--bugs|--refactor|--tests] <target>
/cmrv --diff [focus]
/cmrh --diff [focus]
```

- `/cmrv` opens a review split to the right.
- `/cmrh` opens a review split below.
- With no arguments, both default to reviewing the current git diff.
- A GitHub PR URL switches the prompt to PR review and asks Pi to inspect it with `gh pr view` and `gh pr diff`.

Examples:

```text
/cmrv
/cmrh
/cmrv src/auth.ts
/cmrv --bugs src/auth.ts
/cmrh --refactor src/auth/
/cmrv --diff
/cmrh --diff focus on token refresh and retries
/cmrv https://github.com/owner/repo/pull/123
```

Legacy aliases:
- `/review-v` → `/cmrv`
- `/review-h` → `/cmrh`

## Environment variables

```bash
PI_CMUX_NOTIFY_LEVEL=all|medium|low|disabled
PI_CMUX_NOTIFY_THRESHOLD_MS=15000
PI_CMUX_NOTIFY_DEBOUNCE_MS=3000
PI_CMUX_NOTIFY_TITLE=Pi
PI_CMUX_NOTIFY_INCLUDE_RESPONSE=0|1

PI_CMUX_SIDEBAR=0|1
PI_CMUX_SIDEBAR_FLASH=all|error|disabled
PI_CMUX_SIDEBAR_LOG_TOOLS=0|1
PI_CMUX_SIDEBAR_LOG_PROMPT=0|1
PI_CMUX_SIDEBAR_PROGRESS=0|1
PI_CMUX_SIDEBAR_PROGRESS_CLEAR_MS=2500
PI_CMUX_SIDEBAR_STATUS_KEY=<key>
PI_CMUX_SIDEBAR_STATUS_PRIORITY=80
PI_CMUX_SIDEBAR_SOURCE=pi
```

cmux uses the current `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` automatically.
