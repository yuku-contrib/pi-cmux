---
template_version: 1
date: 2026-06-03T01:20:01+0900
author: Yuku Kotani
commit: c8ff70f
branch: main
repository: pi-cmux
topic: "Validation of tool-notifications-config"
status: complete
parent: ".rpiv/artifacts/plans/2026-06-02_23-36-42_tool-notifications-config.md"
tags: [validation, blueprint, cmux-notify, settings]
last_updated: 2026-06-03T01:20:01+0900
---

## Validation Report: tool-notifications-config

### Implementation Status

- ✓ Phase 1: Notify settings + tool-start event — Fully implemented
- ✓ Phase 2: Documentation — Fully implemented

### Automated Verification Results

- ✓ Notify source still imports and uses existing Pi tool-result type guards: `grep -n "isBashToolResult" extensions/cmux-notify.ts` — found import and usages for error/success run summaries.
- ✓ Tool settings loader targets the chosen JSON path: `grep -n "notify.*tools\|readPiCmuxNotifyTools\|loadConfiguredNotifyTools" extensions/cmux-notify.ts` — found nested `notify.tools` parsing and loader wiring.
- ✓ Tool-start handler is registered in notify: `grep -n "tool_execution_start" extensions/cmux-notify.ts` — found handler in `extensions/cmux-notify.ts`.
- ✓ Disabled notify level gates tool-start notifications: `grep -n "shouldNotifyToolStart" extensions/cmux-notify.ts` — found disabled-level helper and handler guard.
- ✓ README mentions the chosen JSON setting: `grep -n "pi-cmux.notify.tools" README.md` — found setting and docs links.
- ✓ Usage docs include the tool notification settings section: `grep -n "Tool notification settings" docs/usage.md` — found section heading.
- ✓ Usage docs document disabled override: `grep -n '"disabled": true' docs/usage.md` — found prose and JSON example.
- ✓ Usage docs document reload after settings changes: `grep -n "/reload" docs/usage.md` — found reload instruction.
- ✓ No TypeScript regressions detected: `npm run typecheck` — `tsc --strict` completed successfully.

### Code Review Findings

#### Matches Plan:

- `extensions/cmux-notify.ts:46` — settings files are read defensively with missing-file skip, JSON parse error warning, and non-object warning behavior.
- `extensions/cmux-notify.ts:65` — `pi-cmux.notify.tools` is extracted through the planned nested settings path, warning and skipping invalid `pi-cmux`, `notify`, or `tools` shapes.
- `extensions/cmux-notify.ts:101` — tool entries accept `true` or `{ "disabled": true }`; invalid tool names and invalid entry shapes warn and skip.
- `extensions/cmux-notify.ts:133` — global settings load before project `.pi/settings.json`, and disabled project entries delete earlier configured tools.
- `extensions/cmux-notify.ts:224` — tool-start body text matches the planned `Using <tool>` / `Using <tool> on <basename>` form.
- `extensions/cmux-notify.ts:344` — `PI_CMUX_NOTIFY_LEVEL=disabled` gates tool-start notifications.
- `extensions/cmux-notify.ts:372` — tool-start notifications reuse the existing `sendNotification()` path, preserving title, debounce, timeout, and cmux-unavailable handling.
- `extensions/cmux-notify.ts:405` — `tool_execution_start` is handled in `cmux-notify.ts`, with exact configured `event.toolName` matching before sending `Tool: <name>`.
- `extensions/cmux-notify.ts:443` — final `agent_end` notification behavior remains present and continues to use `shouldNotify()`.
- `README.md:76` — README links both pluggable command settings and tool notification settings, and names `pi-cmux.notify.tools`.
- `README.md:78` — README includes the planned JSON example and disabled-level note.
- `docs/usage.md:32` — usage docs include the new tool notification settings section.
- `docs/usage.md:49` — usage docs list global and project settings locations.
- `docs/usage.md:53` — usage docs state exact notification subtitle/body behavior and disabled-level gating.
- `docs/usage.md:55` — usage docs explain project-over-global precedence and `{ "disabled": true }` override.
- `docs/usage.md:70` — usage docs instruct users to run `/reload` after settings changes.

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ Settings parsing and warn-and-skip behavior follow `extensions/cmux-open.ts` conventions for `existsSync`, `readFileSync`, `JSON.parse`, top-level object validation, and `[pi-cmux]` warnings.
- ✓ Global-then-project merge semantics match configured split command behavior: later project settings can remove prior global entries.
- ✓ Broader tool-name validation is an acceptable variation from slash-command-name validation because Pi tool names can include underscores, dots, colons, or dashes.
- ✓ Tool-start summary wording matches the existing sidebar helper shape.
- ✓ README and `docs/usage.md` style matches the repository’s concise configuration docs and JSON examples.

### Manual Testing Required:

1. Runtime notification smoke test:
   - [ ] Add `"bash": true` under `pi-cmux.notify.tools` in `~/.pi/agent/settings.json` or project `.pi/settings.json`.
   - [ ] Run `/reload` in Pi, then start a `bash` tool and confirm a `Tool: bash` cmux notification appears.
   - [ ] Start an unconfigured tool and confirm no tool-start notification appears.
2. Override and disabled checks:
   - [ ] Configure a global tool, then set the same project tool to `{ "disabled": true }` and confirm the project disables it.
   - [ ] Set `PI_CMUX_NOTIFY_LEVEL=disabled` and confirm both final-run and configured tool-start notifications are suppressed.
3. Invalid settings checks:
   - [ ] Temporarily use invalid `pi-cmux.notify` or `pi-cmux.notify.tools` shapes and confirm Pi warns and continues without throwing.

### Recommendations:

- Ready to commit — implementation is complete and validated.
