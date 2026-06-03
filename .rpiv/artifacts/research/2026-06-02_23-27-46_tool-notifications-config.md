---
date: 2026-06-02T23:27:46+0900
author: Yuku Kotani
commit: c8ff70f
branch: main
repository: pi-cmux
topic: "ツール実行時に、sidebarを更新するだけじゃなく、notify も出すようにしたい。どのツール名のときに通知するかはconfigで設定できるようにする。"
tags: [research, codebase, cmux-notify, cmux-sidebar, settings]
status: complete
last_updated: 2026-06-02T23:27:46+0900
last_updated_by: Yuku Kotani
---

# Research: ツール実行時に、sidebarを更新するだけじゃなく、notify も出すようにしたい。どのツール名のときに通知するかはconfigで設定できるようにする。

## Research Question
ツール実行時に、sidebarを更新するだけじゃなく、notify も出すようにしたい。どのツール名のときに通知するかはconfigで設定できるようにする。

## Summary
Tool lifecycle events already exist and are consumed by sidebar: `tool_execution_start` carries `event.toolName` and `event.args`, while `tool_result` carries `ToolResultEvent` result/error data. Notification delivery should live in `cmux-notify.ts`, not `cmux-sidebar.ts`, because notify already owns `cmux notify` execution, debounce, title, timeout, and cmux-unavailable handling. The requested tool-name configuration should use JSON settings under the existing `pi-cmux` settings surface, per developer decision, reusing the global/project precedence established by configured split commands. Documentation needs updates in both README and usage docs because current config docs split env-based notify/sidebar settings from JSON-based `pi-cmux.commands`.

## Detailed Findings

### Tool lifecycle seam
- Sidebar subscribes to `tool_execution_start` and immediately uses `event.toolName` for status/progress updates (`extensions/cmux-sidebar.ts:660-663`).
- The same start event exposes `event.args`, currently summarized only for sidebar logs when `PI_CMUX_SIDEBAR_LOG_TOOLS` is enabled (`extensions/cmux-sidebar.ts:664-666`).
- Sidebar subscribes to `tool_result`, increments `runState.toolCount`, and branches on `event.isError` before normal success classification (`extensions/cmux-sidebar.ts:669-702`).
- Sidebar uses `activeToolCount` only to restore status/progress after all active tools end; this is sidebar-only UI state and should not be copied into notification logic (`extensions/cmux-sidebar.ts:477`, `extensions/cmux-sidebar.ts:705-709`).

### Notification delivery primitive
- `cmuxNotifyExtension(pi)` reads notify env config at startup: threshold, debounce, level, include response, and title (`extensions/cmux-notify.ts:226-231`).
- `sendNotification()` centralizes cmux availability, duplicate debounce, `cmux notify` args, timeout handling, and non-zero exit handling (`extensions/cmux-notify.ts:238-264`).
- Existing final-run notifications build subtitle/body in `agent_end`, gate through `shouldNotify()`, and call `sendNotification()` (`extensions/cmux-notify.ts:298-315`).
- Tool notifications should reuse this primitive instead of creating a second `pi.exec("cmux", ...)` path.

### Tool summaries and result semantics
- Sidebar has start text via `summarizeToolStart(toolName, args)`, extracting `path` from args and falling back to `Using ${toolName}` (`extensions/cmux-sidebar.ts:149-153`, `extensions/cmux-sidebar.ts:191-194`).
- Sidebar has success text via `summarizeToolResult(event)`, with read/edit/write/search/list/bash-specific strings and a generic fallback (`extensions/cmux-sidebar.ts:181-188`).
- Sidebar has error text via `summarizeToolError(event)`, preferring input path, then bash special-case, then first text content or generic failure (`extensions/cmux-sidebar.ts:162-175`).
- Notify has a parallel error summarizer `summarizeError(event)` but no start/success tool summary helpers (`extensions/cmux-notify.ts:85-98`).
- Notify currently records first tool error and success counters during `tool_result`, but emits no per-tool notification (`extensions/cmux-notify.ts:271-295`).
- Notify counts read paths even for read errors because its read branch lacks a `!event.isError` check, whereas sidebar returns early on any error and does not update success counters (`extensions/cmux-notify.ts:276-280`, `extensions/cmux-sidebar.ts:672-679`).
- Notify has no `ls`/list counter, while sidebar tracks list operations through `event.toolName === "ls"` (`extensions/cmux-notify.ts:21-28`, `extensions/cmux-sidebar.ts:177-179`, `extensions/cmux-sidebar.ts:693-694`).

### JSON settings precedent
- Configured split commands read `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json` from the `pi-cmux` section (`extensions/cmux-open.ts:14-15`, `extensions/cmux-open.ts:315-320`).
- Settings file parse errors and invalid shapes warn and skip rather than breaking extension startup (`extensions/cmux-open.ts:188-204`, `extensions/cmux-open.ts:207-228`).
- Global settings are loaded first and project settings second, so project config overrides global config (`extensions/cmux-open.ts:315-330`).
- `disabled: true` in command config returns `null` and deletes a previously configured command, establishing a precedent for project-level disabling of global config (`extensions/cmux-open.ts:285-287`, `extensions/cmux-open.ts:323-325`).
- Current JSON reader is command-specific (`readPiCmuxCommands`), so tool notification config would need either a shared `pi-cmux` section reader or a separate settings reader (`extensions/cmux-open.ts:207-228`).

### Extension wiring and ownership
- The bundle registers notify before sidebar, but both attach independent event listeners to the same Pi event bus (`extensions/index.ts:11-19`).
- Sidebar early-returns when `PI_CMUX_SIDEBAR` is disabled or no `CMUX_WORKSPACE_ID` exists, so placing notifications in sidebar would unintentionally couple notify behavior to sidebar activation (`extensions/cmux-sidebar.ts:442-444`).
- Notify has independent cmux availability detection around `cmux notify`, so tool notifications belong in `cmux-notify.ts` or a helper called by it (`extensions/cmux-notify.ts:238-259`).

### Documentation surface
- README documents notify/sidebar env variables and separately points custom split shortcuts to `pi-cmux.commands` JSON settings (`README.md:62-76`).
- Usage docs list notify and sidebar env variables but no JSON notify settings (`docs/usage.md:285-308`).
- Usage docs already document custom split shortcuts under `pi-cmux.commands`, giving a natural place/pattern for new JSON tool notification docs (`docs/usage.md:123-129`).

## Code References
- `extensions/cmux-sidebar.ts:149-153` — Extracts a `path` from tool start args.
- `extensions/cmux-sidebar.ts:162-175` — Builds sidebar tool error summaries.
- `extensions/cmux-sidebar.ts:181-194` — Builds sidebar tool success/start summaries.
- `extensions/cmux-sidebar.ts:442-459` — Sidebar activation and env configuration gate.
- `extensions/cmux-sidebar.ts:660-707` — Sidebar tool start/result/end event handling.
- `extensions/cmux-notify.ts:52-58` — Parses `PI_CMUX_NOTIFY_LEVEL` with default `all`.
- `extensions/cmux-notify.ts:85-98` — Builds notify-side tool error summary.
- `extensions/cmux-notify.ts:207-213` — Gates final notifications by notify level.
- `extensions/cmux-notify.ts:226-264` — Initializes notify config and defines `sendNotification()`.
- `extensions/cmux-notify.ts:271-315` — Tracks tool result state and sends final agent-end notifications.
- `extensions/cmux-open.ts:14-15` — Defines global settings path and `pi-cmux` section name.
- `extensions/cmux-open.ts:188-228` — Reads JSON settings and extracts `pi-cmux.commands`.
- `extensions/cmux-open.ts:256-313` — Normalizes configured split commands.
- `extensions/cmux-open.ts:315-334` — Merges global and project configured commands.
- `extensions/index.ts:11-19` — Registers notify, split/open, and sidebar extensions.
- `README.md:62-76` — Documents config table and JSON command settings pointer.
- `docs/usage.md:285-308` — Documents environment variable config block.

## Integration Points

### Inbound References
- `extensions/index.ts:13` — Registers `cmuxNotifyExtension(pi)` with the Pi extension bundle.
- `extensions/index.ts:19` — Registers `cmuxSidebarExtension(pi)` independently from notify.
- `extensions/cmux-sidebar.ts:660` — Receives `tool_execution_start` for sidebar updates.
- `extensions/cmux-sidebar.ts:669` — Receives `tool_result` for sidebar tool state and logs.
- `extensions/cmux-notify.ts:271` — Receives `tool_result` for final notification summary state.
- `extensions/cmux-notify.ts:298` — Receives `agent_end` for final notifications.

### Outbound Dependencies
- `extensions/cmux-notify.ts:249-250` — Calls `pi.exec("cmux", ["notify", ...])` for notifications.
- `extensions/cmux-sidebar.ts:517-527` — Calls `cmux set-status` through sidebar command queue.
- `extensions/cmux-sidebar.ts:570` — Calls `cmux set-progress` through sidebar command queue.
- `extensions/cmux-sidebar.ts:535` — Calls `cmux log` through sidebar command queue.
- `extensions/cmux-open.ts:188-204` — Reads local JSON settings files via `fs` APIs.

### Infrastructure Wiring
- `extensions/index.ts:11-19` — Single extension bundle wires notify and sidebar into Pi.
- `extensions/cmux-open.ts:315-330` — Establishes global-to-project settings precedence for `pi-cmux` JSON config.
- `README.md:62-76` — User-facing root config documentation.
- `docs/usage.md:123-129` — Existing JSON settings documentation location for `pi-cmux.commands`.
- `docs/usage.md:285-308` — Existing env settings documentation location for notify/sidebar.

## Architecture Insights
- Notification behavior should remain owned by `cmux-notify.ts`; sidebar should remain status/progress/log-only.
- Tool notifications can attach to the same lifecycle seam as sidebar without sharing sidebar state.
- `sendNotification()` is the canonical notification primitive and should be reused to preserve debounce and cmux availability behavior.
- Existing history argues for notification gating: previous fixes moved away from noisy/imprecise tool-error notifications toward final-run semantics.
- JSON settings should follow the established `pi-cmux` global/project precedence and warn-and-skip invalid config rather than failing hard.
- If tool notification messages need start/success text, summary helpers should be shared or duplicated deliberately; notify currently only has error summary text.

## Precedents & Lessons
4 similar past changes analyzed.

### Precedent: cmux sidebar tool status + live token updates
**Commit(s)**: `009cfc9` — "feat: add cmux sidebar integration" (2026-05-27), `ec1567d` — "feat: show live cmux sidebar token usage" (2026-05-27)
**Blast radius**: 10 files across 3 layers
  extensions/ — added `cmux-sidebar.ts`, registered in `extensions/index.ts`, tracked agent/tool events
  docs/ — added usage docs for sidebar/status env vars
  package/ci — changelog, package metadata, CI updates

**Follow-up fixes**:
- `e9e89a5` — "fix: reset cmux sidebar tool status" (2026-05-27) — stale tool status required explicit active-tool/reset handling

**Lessons from docs**:
- No relevant `.rpiv/artifacts/` documents found.

**Takeaway**: Tool-execution UI state needs explicit lifecycle reset paths; avoid making notification behavior depend on sidebar-only state.

### Precedent: notification config / noise gating
**Commit(s)**: `ccd6fb5` — "feat: add notification level setting" (2026-03-07)
**Blast radius**: 4 files across 3 layers
  extensions/ — added `PI_CMUX_NOTIFY_LEVEL` parsing and `shouldNotify()` gating
  docs/ — documented `all`, `medium`, `low`, `disabled` levels
  package/ — changelog/version update

**Follow-up fixes**:
- `df72977` — "fix(notify): gate assistant response notifications" (2026-05-27) — response text needed explicit opt-in and final-message gating

**Lessons from docs**:
- No relevant `.rpiv/artifacts/` documents found.

**Takeaway**: New notifications should be opt-in/gated and documented, especially when they may expose tool names, command text, or assistant output.

### Precedent: notify only final run failures, not every tool error
**Commit(s)**: `ddcb5c5` — "fix: only notify error on final run failure" (2026-03-07)
**Blast radius**: 3 files across 2 layers
  extensions/ — changed notify logic away from immediate first-tool-error notification toward final assistant/run error
  docs/ — clarified error notification semantics

**Follow-up fixes**:
- `ccd6fb5` — "feat: add notification level setting" (2026-03-07) — added noise control after notification behavior changes
- `df72977` — "fix(notify): gate assistant response notifications" (2026-05-27) — further constrained notification content

**Lessons from docs**:
- No relevant `.rpiv/artifacts/` documents found.

**Takeaway**: Direct tool-event notifications can be noisy or misleading unless clearly scoped to configured tools and meaningful phases.

### Precedent: pluggable command config
**Commit(s)**: `6b91e12` — "feat: add pluggable cmux commands" (2026-05-27)
**Blast radius**: 6 files across 3 layers
  extensions/ — read `pi-cmux.commands` from global/project settings, validate names/options, register commands
  docs/ — documented settings shape, precedence, reload requirement
  package/ — changelog/version update

**Follow-up fixes**:
- No fix commits found in same path after this commit.

**Lessons from docs**:
- No relevant `.rpiv/artifacts/` documents found.

**Takeaway**: Reuse the existing JSON config pattern: validate settings, support global/project override, document reload behavior, and skip invalid entries with warnings.

### Composite Lessons
- Tool event features must define which lifecycle phase triggers behavior and avoid stale state by keeping sidebar and notify responsibilities separate.
- Notification additions should be gated by explicit config to prevent noise and accidental sensitive output.
- Config-driven behavior should validate option shapes and document global/project precedence and reload expectations.

## Historical Context (from `.rpiv/artifacts/`)
No relevant `.rpiv/artifacts/` documents were found during the sweep.

## Developer Context
**Q (`extensions/cmux-notify.ts:227-231`, `extensions/cmux-sidebar.ts:450-458`, `extensions/cmux-open.ts:315-330`): 通知対象ツール名の設定面をどれにしますか？既存は notify/sidebar が env、カスタムコマンドだけ JSON settings です。**
A: JSON settings を採用する。

**Q (`extensions/cmux-sidebar.ts:660-707`, `extensions/cmux-notify.ts:238-315`): Compiled scan を提示し、この内容で research artifact を作成してよいか確認。**
A: ok。

## Related Research
- None found.

## Open Questions
- Tool notification should fire on `tool_execution_start`, `tool_result` success, `tool_result` error, or a configurable phase. The current request says “ツール実行時” but does not explicitly resolve phase semantics.
- JSON setting shape is not yet finalized; likely candidates include `pi-cmux.toolNotifications.tools` or `pi-cmux.notifyTools`.
- Precedence between `PI_CMUX_NOTIFY_LEVEL=disabled` and configured tool notifications needs a product decision: global notify disabled may disable all notifications, or tool notifications may be separately gated.
