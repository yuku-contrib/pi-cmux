---
date: 2026-06-02T23:36:42+0900
author: Yuku Kotani
commit: c8ff70f
branch: main
repository: pi-cmux
topic: tool-notifications-config
tags: [plan, blueprint, cmux-notify, settings]
status: ready
parent: .rpiv/artifacts/research/2026-06-02_23-27-46_tool-notifications-config.md
phase_count: 2
unresolved_phase_count: 0
last_updated: 2026-06-02T23:36:42+0900
last_updated_by: Yuku Kotani
---

# Configurable Tool-start Notifications Implementation Plan

## Overview
Build opt-in cmux notifications for configured Pi tool names. The implementation keeps notification delivery in `extensions/cmux-notify.ts`, reads `pi-cmux.notify.tools` from the same global/project JSON settings surface used by configured split commands, and emits only `tool_execution_start` notifications through the existing `sendNotification()` primitive.

## Requirements
- Send `cmux notify` when a configured tool starts executing.
- Allow users to configure which tool names notify via JSON settings.
- Use `pi-cmux.notify.tools` in `~/.pi/agent/settings.json` and project `.pi/settings.json`.
- Preserve project-over-global precedence and explicit project-level disable behavior.
- Keep `PI_CMUX_NOTIFY_LEVEL=disabled` as a global notify-off switch.
- Do not couple notify behavior to sidebar activation or sidebar state.
- Update README and usage docs for the new JSON setting.

## Current State Analysis
`cmux-notify.ts` already owns `cmux notify` execution and final-run notifications, but does not listen to `tool_execution_start`. Sidebar already listens to tool start/result events and has a small start-summary helper, but sidebar is gated by cmux workspace/sidebar env and should not own notification behavior.

### Key Discoveries
- `extensions/cmux-notify.ts:226-264` initializes notify env config and defines the canonical `sendNotification()` primitive with debounce, timeout, and cmux-unavailable handling.
- `extensions/cmux-notify.ts:207-213` defines `shouldNotify()`, where `PI_CMUX_NOTIFY_LEVEL=disabled` suppresses notifications.
- `extensions/cmux-sidebar.ts:660-666` shows the `tool_execution_start` seam with `event.toolName` and `event.args`.
- `extensions/cmux-sidebar.ts:149-153` and `extensions/cmux-sidebar.ts:191-194` show how to extract a path from tool start args and summarize start text.
- `extensions/cmux-open.ts:188-228` shows JSON settings parsing and nested `pi-cmux.commands` extraction with warn-and-skip invalid-shape behavior.
- `extensions/cmux-open.ts:315-334` shows global settings loaded before project settings, with `disabled: true` deleting a previously configured entry.
- `README.md:62-76` and `docs/usage.md:5-30` document current notification config; `docs/usage.md:123-129` documents JSON settings locations.

## Desired End State
Users opt in to tool-start notifications with JSON settings:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "bash": true,
        "cmux_open_terminal": true
      }
    }
  }
}
```

A project can override or remove a global tool notification:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "bash": { "disabled": true },
        "read": true
      }
    }
  }
}
```

When `bash` starts, Pi sends a cmux notification with title from `PI_CMUX_NOTIFY_TITLE`, subtitle `Tool: bash`, and body like `Using bash` or `Using read on README.md`.

## What We're NOT Doing
- Not sending tool success or tool error notifications; the developer selected start-only semantics.
- Not adding phase/mode configuration such as `start`, `success`, or `error`.
- Not moving sidebar helpers into a shared utility; this small feature can duplicate start summary logic in notify.
- Not changing sidebar status/progress/log behavior.
- Not adding new npm dependencies or a build system.
- Not changing final-run notification semantics except that `disabled` also gates tool-start notifications.

## Decisions

### Decision 1: Notify on tool start only
Ambiguity: Tool notifications could use `tool_execution_start`, `tool_result` success, `tool_result` error, or configurable phases.
Explored:
- Start: `extensions/cmux-sidebar.ts:660-666` exposes `event.toolName` immediately and matches “tool execution” timing; does not wait for result semantics.
- Result: `extensions/cmux-notify.ts:271-295` sees `event.isError` and summary data, but would notify after execution and increase noise/semantics surface.
Decision: Use start only. Subscribe in `cmux-notify.ts` and call `sendNotification()` for configured `event.toolName`.

### Decision 2: Use `pi-cmux.notify.tools`
Ambiguity: New JSON settings could be `toolNotifications`, `notify.tools`, or `notifyTools`.
Explored:
- `pi-cmux.notify.tools`: groups the feature under notification settings and leaves room for future notify JSON options.
- `pi-cmux.toolNotifications`: explicit but separate from notify naming.
- `pi-cmux.notifyTools`: concise but less extensible.
Decision: Use `pi-cmux.notify.tools`.

### Decision 3: Global notify disabled stops tool-start notifications
Ambiguity: Tool JSON config could override `PI_CMUX_NOTIFY_LEVEL=disabled`, or disabled could stop all notify output.
Explored:
- `disabled` stops all: follows `shouldNotify()` semantics at `extensions/cmux-notify.ts:207-213`.
- Tools separate: gives JSON config independent power but weakens the existing env switch.
Decision: `PI_CMUX_NOTIFY_LEVEL=disabled` suppresses tool-start notifications.

### Decision 4: JSON loading follows configured-command precedence
Simple decision: Model settings parsing after `extensions/cmux-open.ts:188-228` and merge after `extensions/cmux-open.ts:315-334`: global first, project second, invalid shapes warn and skip, `{ "disabled": true }` deletes a global tool entry.

## Phase 1: Notify settings + tool-start event

### Overview
Adds the settings parser, configured tool-name set, start summarizer, and `tool_execution_start` handler in notify. Depends on nothing; documentation follows in Phase 2.

### Changes Required:

#### 1. extensions/cmux-notify.ts:1-330
**File**: extensions/cmux-notify.ts
**Changes**: MODIFY — add JSON settings loading and tool-start notification handler

```ts
// Replace the existing imports with these imports.
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Add near the existing constants.
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_SECTION_NAME = "pi-cmux";
const TOOL_NOTIFICATION_SUBTITLE_PREFIX = "Tool";

// Add after AssistantMessageLike.
interface ToolNotificationInput {
	disabled?: boolean;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn(`[pi-cmux] Ignoring non-object settings file: ${path}`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-cmux] Failed to read settings from ${path}: ${message}`);
		return undefined;
	}
}

function readPiCmuxNotifyTools(settingsPath: string): Record<string, unknown> {
	const settings = readJsonFile(settingsPath);
	const section = settings?.[SETTINGS_SECTION_NAME];
	if (!section) {
		return {};
	}
	if (typeof section !== "object" || Array.isArray(section)) {
		console.warn(`[pi-cmux] Ignoring invalid "${SETTINGS_SECTION_NAME}" settings in ${settingsPath}`);
		return {};
	}

	const notify = (section as { notify?: unknown }).notify;
	if (notify === undefined) {
		return {};
	}
	if (typeof notify !== "object" || Array.isArray(notify)) {
		console.warn(`[pi-cmux] Ignoring invalid "${SETTINGS_SECTION_NAME}.notify" settings in ${settingsPath}`);
		return {};
	}

	const tools = (notify as { tools?: unknown }).tools;
	if (tools === undefined) {
		return {};
	}
	if (typeof tools !== "object" || Array.isArray(tools)) {
		console.warn(`[pi-cmux] Ignoring invalid "${SETTINGS_SECTION_NAME}.notify.tools" settings in ${settingsPath}`);
		return {};
	}

	return tools as Record<string, unknown>;
}

function isValidToolName(value: string): boolean {
	return /^[A-Za-z0-9_.:-]+$/.test(value);
}

function normalizeToolNotification(
	toolName: string,
	value: unknown,
	settingsPath: string,
): true | null | undefined {
	if (!toolName || !isValidToolName(toolName)) {
		console.warn(`[pi-cmux] Skipping invalid notify tool name "${toolName}" from ${settingsPath}`);
		return undefined;
	}

	if (value === true) {
		return true;
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(`[pi-cmux] Skipping invalid notify tool "${toolName}" from ${settingsPath}; expected true or { "disabled": true }`);
		return undefined;
	}

	const config = value as ToolNotificationInput;
	if (config.disabled) {
		return null;
	}

	console.warn(`[pi-cmux] Skipping invalid notify tool "${toolName}" from ${settingsPath}; expected true or { "disabled": true }`);
	return undefined;
}

function loadConfiguredNotifyTools(cwd: string): Set<string> {
	const configuredTools = new Set<string>();
	const settingsPaths = [GLOBAL_SETTINGS_PATH, join(cwd, ".pi", "settings.json")];

	for (const settingsPath of settingsPaths) {
		const tools = readPiCmuxNotifyTools(settingsPath);
		for (const [toolName, value] of Object.entries(tools)) {
			const normalized = normalizeToolNotification(toolName, value, settingsPath);
			if (normalized === null) {
				configuredTools.delete(toolName);
				continue;
			}
			if (!normalized) {
				continue;
			}
			configuredTools.add(toolName);
		}
	}

	return configuredTools;
}

// Add near getPathFromInput.
function getPathFromArgs(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as { path?: unknown }).path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Add near summarizeError.
function summarizeToolStart(toolName: string, args: unknown): string {
	const path = getPathFromArgs(args);
	return path ? `Using ${toolName} on ${basename(path)}` : `Using ${toolName}`;
}

function shouldNotifyToolStart(level: NotifyLevel): boolean {
	return level !== "disabled";
}

// Add inside cmuxNotifyExtension after title initialization.
const notifyTools = loadConfiguredNotifyTools(process.cwd());

// Add inside cmuxNotifyExtension before the existing tool_result handler.
pi.on("tool_execution_start", async (event) => {
	if (!shouldNotifyToolStart(notifyLevel) || !notifyTools.has(event.toolName)) {
		return;
	}

	await sendNotification(
		`${TOOL_NOTIFICATION_SUBTITLE_PREFIX}: ${event.toolName}`,
		summarizeToolStart(event.toolName, event.args),
	);
});
```

### Success Criteria:

#### Automated Verification:
- [x] Notify source still imports and uses the existing Pi tool-result type guards: `grep -n "isBashToolResult" extensions/cmux-notify.ts`
- [x] Tool settings loader targets the chosen JSON path: `grep -n "notify.*tools\|readPiCmuxNotifyTools\|loadConfiguredNotifyTools" extensions/cmux-notify.ts`
- [x] Tool-start handler is registered in notify, not sidebar: `grep -n "tool_execution_start" extensions/cmux-notify.ts`
- [x] Disabled notify level gates tool-start notifications: `grep -n "shouldNotifyToolStart" extensions/cmux-notify.ts`

#### Manual Verification:
- [x] Confirm invalid `pi-cmux.notify` or `pi-cmux.notify.tools` shapes warn and skip without throwing, matching `extensions/cmux-open.ts:188-228`.
- [x] Confirm global settings are read before project settings and project `{ "disabled": true }` removes a global configured tool, matching `extensions/cmux-open.ts:315-334`.
- [x] Confirm only exact configured `event.toolName` values trigger a `Tool: <name>` notification on start, and unconfigured tools do not notify.
- [x] Confirm existing final `agent_end` notifications are still gated by `shouldNotify()` and use the same `sendNotification()` path.

## Phase 2: Documentation

### Overview
Documents the new `pi-cmux.notify.tools` settings shape and precedence. Depends on Phase 1 so docs match the finalized code surface.

### Changes Required:

#### 1. README.md:62-96
**File**: README.md
**Changes**: MODIFY — add concise JSON tool notification example and pointer

```md
<!-- Replace the single sentence at README.md:76 with the following paragraphs. -->
Custom split shortcuts can be registered under `pi-cmux.commands`, and tool-start notifications can be enabled under `pi-cmux.notify.tools`, in `~/.pi/agent/settings.json` or `.pi/settings.json`; see [docs/usage.md](docs/usage.md#pluggable-tool-commands) and [tool notification settings](docs/usage.md#tool-notification-settings).

Example tool notification settings:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "bash": true,
        "cmux_open_terminal": true
      }
    }
  }
}
```

Configured tools send `cmux notify` when they start. `PI_CMUX_NOTIFY_LEVEL=disabled` disables both final-run and tool-start notifications.
```

#### 2. docs/usage.md:5-32
**File**: docs/usage.md
**Changes**: MODIFY — document tool-start notifications, settings locations, precedence, disabled override, reload

```md
<!-- Insert after the notification noise-controls block, before `## Sidebar status/log`. -->
### Tool notification settings

Tool-start notifications are opt-in. Configure exact Pi tool names under `pi-cmux.notify.tools`:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "bash": true,
        "cmux_open_terminal": true
      }
    }
  }
}
```

Supported locations:
- `~/.pi/agent/settings.json` for global tool notifications
- `.pi/settings.json` for project-local tool notifications

When a configured tool starts, `cmux-notify` sends a notification with subtitle `Tool: <name>` and a short body such as `Using bash` or `Using read on README.md`. Tool-start notifications use the same `cmux notify` title, debounce, timeout, and cmux-unavailable handling as final-run notifications. `PI_CMUX_NOTIFY_LEVEL=disabled` disables both final-run notifications and configured tool-start notifications.

Project settings load after global settings. Set a project entry to `{ "disabled": true }` to remove a global tool notification:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "bash": { "disabled": true },
        "read": true
      }
    }
  }
}
```

After changing settings, run `/reload` in Pi.
```

### Success Criteria:

#### Automated Verification:
- [x] README mentions the chosen JSON setting: `grep -n "pi-cmux.notify.tools" README.md`
- [x] Usage docs include the tool notification settings section: `grep -n "Tool notification settings" docs/usage.md`
- [x] Usage docs document disabled override: `grep -n '"disabled": true' docs/usage.md`
- [x] Usage docs document reload after settings changes: `grep -n "/reload" docs/usage.md`

#### Manual Verification:
- [x] Confirm README links to both pluggable command settings and tool notification settings.
- [x] Confirm docs state that tool-start notifications are opt-in and match exact Pi tool names.
- [x] Confirm docs state `PI_CMUX_NOTIFY_LEVEL=disabled` disables final-run and tool-start notifications.
- [x] Confirm docs describe global/project precedence and project-local disabled override.

## Ordering Constraints
- Phase 1 must run before Phase 2 because documentation must match the exact settings shape and runtime behavior.
- Phases are sequential; there is no safe parallelism because Phase 2 references Phase 1 behavior.

## Verification Notes
- Verify invalid JSON/settings shapes warn and skip rather than crashing, mirroring `extensions/cmux-open.ts:188-228`.
- Verify project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`, and `{ "disabled": true }` removes a global tool notification, mirroring `extensions/cmux-open.ts:315-334`.
- Verify `PI_CMUX_NOTIFY_LEVEL=disabled` suppresses tool-start notifications.
- Verify only configured `event.toolName` values trigger notifications on `tool_execution_start`.
- Verify final-run notification behavior remains intact and still uses `agent_end` logic.
- Verify docs mention reload after changing settings.

## Performance Considerations
Settings are loaded once at extension startup, matching existing configured-command behavior. Tool-start matching is an O(1) `Set.has()` check and only configured tools call the existing debounced `sendNotification()` path.

## Migration Notes
No persisted data or schema migration. Existing users see no new notifications until they opt in with JSON settings. Existing environment variables retain their behavior.

## Pattern References
- `extensions/cmux-open.ts:188-228` — JSON file parsing and nested `pi-cmux.commands` validation.
- `extensions/cmux-open.ts:315-334` — global/project merge order and disabled override deletion.
- `extensions/cmux-notify.ts:226-264` — notification primitive to reuse.
- `extensions/cmux-sidebar.ts:660-666` — tool-start event seam.
- `extensions/cmux-sidebar.ts:149-153`, `extensions/cmux-sidebar.ts:191-194` — path extraction and start summary style.
- `README.md:62-76`, `docs/usage.md:123-129` — documentation surfaces for env and JSON settings.

## Developer Context
- Q (`extensions/cmux-notify.ts:227-231`, `extensions/cmux-sidebar.ts:450-458`, `extensions/cmux-open.ts:315-330`): 通知対象ツール名の設定面をどれにしますか？既存は notify/sidebar が env、カスタムコマンドだけ JSON settings です。 A: JSON settings を採用する。
- Q (`extensions/cmux-sidebar.ts:660-666`, `extensions/cmux-notify.ts:271-295`, `extensions/cmux-notify.ts:85-98`): 通知はどのタイミングにしますか？ A: Start only.
- Q (`extensions/cmux-open.ts:207-228`, `docs/usage.md:123-129`): JSON設定形状はどれにしますか？ A: `notify.tools`.
- Q (`extensions/cmux-notify.ts:207-213`, `extensions/cmux-notify.ts:298-303`): `PI_CMUX_NOTIFY_LEVEL=disabled` はツール通知も止めますか？ A: Disabled stops all.
- Design checkpoint: Proceed.
- Decomposition checkpoint: 2 slices approved.
- Slice 1 micro-checkpoint: Approved as generated.
- Slice 2 micro-checkpoint: User briefly requested array tools, then reverted to original object form; approved as generated.

## Plan History
- Phase 1: Notify settings + tool-start event — approved as generated
- Phase 2: Documentation — approved as generated

## References
- `.rpiv/artifacts/research/2026-06-02_23-27-46_tool-notifications-config.md`

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 2 §1 (README.md) | <n/a> | blocker | actionability | The `md` code fence for the README replacement contains an inner `json` fence, which terminates the outer fence before the full proposed replacement is captured. | Wrap the README snippet in a longer outer fence such as ````md so the nested JSON fence remains inside it. | dismissed: developer chose to keep the generated fenced snippet as-is. |
| code | Phase 2 §2 (docs/usage.md) | <n/a> | blocker | actionability | The `md` code fence for the docs insertion contains inner `json` fences, which terminate the outer fence before the full proposed insertion is captured. | Wrap the docs snippet in a longer outer fence such as ````md so the nested JSON fences remain inside it. | dismissed: developer chose to keep the generated fenced snippet as-is. |
