# Browser integration compatibility spike

Status: historical investigation, conducted before the browser-opening foundation was implemented. See [browser usage](usage.md#browser-splits) for current behavior.

The native handoff and upstream guard proposals below record the original investigation, not the current implementation plan. The implemented direction requires no cmux changes: an injected compact overlay and a polled submission/acknowledgement bridge replace native Design Mode. Every submission requires confirmation in Pi before steering. Model-facing page-control tools and an atomic interaction guard are not implemented; see [annotations](usage.md#browser-annotations).

## Tested baseline

- cmux **0.64.25 (106)**, revision **`b685a275c`**, macOS WKWebView.
- Native local Unix-socket CLI, running inside a cmux terminal.
- Disposable local HTML fixture; no authenticated pages, profile imports, clipboard access, or external application actions.
- Upstream source inspected at the installed revision, not `main`.

This is the initial verified baseline, **not evidence that older versions fail**. The earliest compatible release has not been established. The historical native handoff proposal below would require new cmux functionality. The injected annotation bridge instead uses existing RPCs and has also been tested on this baseline.

## Live results

| Operation | Result |
|---|---|
| Create right browser split with `new-pane --type browser` | Passed; returned pane and surface refs |
| Create lower browser split with `rpc pane.create` and explicit source UUID | Passed; split attached to the nonfocused source browser, not the focused terminal |
| Preserve terminal focus during creation and Design Mode activation | Passed in tested calls with `focus: false` |
| Wait for document readiness or selector | Passed |
| Enable/status/disable Design Mode | Passed |
| Interactive DOM snapshot | Passed; returned element refs |
| Click by element ref | Passed; while Design Mode was active it selected an annotation target |
| Click, double-click, hover by CSS selector | Passed with Design Mode off; fixture event counters verified behavior |
| Fill, select, press key | Passed; input value, selected value, and key events verified |
| Scroll and scroll element into view | Commands succeeded; screenshot verified final page rendering |
| Screenshot | Passed; PNGs inspected |
| Navigate, follow link, back, reload | Passed |
| Model click while Design Mode is active | **Intercepted for annotation selection**, not delivered as a page action |
| Disable then re-enable Design Mode | **Selection lost** |
| Navigate while a selection is pending | **Navigation allowed; selection lost and Design Mode disabled** |
| Read native Design Mode runtime through `browser eval` | Unavailable: `typeof globalThis.__cmuxDesignMode` returned `undefined` |
| `browser.input_mouse` RPC | `not_supported` on WKWebView |
| `mobile.browser.input.pointer` over local socket | `method_not_found`, despite appearing in advertised methods |

Capability lists alone do not prove a method is usable on this transport. Use behavioral checks and fail explicitly when unsupported. Do not expose coordinate mouse control based on the advertised mobile API.

## Creation and targeting contract

Obtain the caller's actual workspace and surface UUIDs:

```sh
cmux --json --id-format both identify
```

For deterministic split placement, use the tested RPC shape, substituting UUIDs from `caller`:

```sh
cmux --json rpc pane.create '{
  "workspace_id": "<caller-workspace-uuid>",
  "surface_id": "<caller-surface-uuid>",
  "type": "browser",
  "direction": "down",
  "url": "<requested-url>",
  "focus": false
}'
```

The lower split with an explicit nonfocused source was verified against the returned workspace tree. Right splitting was separately verified through `new-pane --type browser --direction right`. Test the right RPC variant when implementing the shared helper.

The native implementation accepts an explicit source surface but falls back to the workspace's focused panel if it is omitted. Do not rely on this fallback or the undocumented forwarding of source flags by `new-pane`.

Capture the creation response's `surface_id`/`surface_ref`, then target every browser operation explicitly:

```sh
cmux browser --surface "$SURFACE" wait --load-state complete --timeout-ms 10000
cmux --json browser --surface "$SURFACE" design-mode enable
cmux --json browser --surface "$SURFACE" design-mode status
cmux browser --surface "$SURFACE" snapshot --interactive
cmux browser --surface "$SURFACE" screenshot --out "$SCREENSHOT_PATH"
```

Validate the returned workspace/surface before binding it to the Pi session. Use stable UUIDs for bindings and refs for display. On readiness or Design Mode failure, report the partial creation rather than opening another browser automatically.

The current `pi-cmux` core command timeout is five seconds. Native Design Mode calls can wait up to ten seconds, and browser waits have their own deadlines. A browser helper needs operation-specific bounded timeouts and cancellation rather than reusing the terminal timeout unchanged.

## Draft protection is an upstream requirement

Current Design Mode status exposes only:

```text
handled, enabled, phase, selected, edit_count, error, surface_ref, workspace_ref
```

A selected element had `selected: true` and `edit_count: 0`; edit count is not an annotation count. The API does not report comment text, whether the prompt is dirty, whether a copy is in progress, or the drawing/capture subphase. `phase: active` collapses idle, drawing, and capture states.

Source inspection confirms:

- Comment text (`requestedChange`) and prompt token order (`promptRuns`) live in the native controller/composer.
- The page runtime runs in a separate `WKContentWorld` named `cmuxDesignMode`; ordinary page evaluation cannot read the controller state.
- Disabling Design Mode calls `resetNativeState()`, clearing selections and comment text.
- Navigation also resets native state. Neither operation currently provides the draft guard this integration needs.

**Do not automatically disable Design Mode to execute a model action.** Until guarded interaction exists, reject model mutations whenever Design Mode is active; observation can remain available. Arbitrary `eval` is also a mutation escape hatch and should not be exposed as an unrestricted model action.

For the complete workflow, add an upstream atomic interaction guard covering draft text, selections, drawing/capture, and in-flight handoff. A separate `status` check followed by navigation is insufficient: the user could begin annotating between those calls. Mode changes must either preserve drafts or fail safely; any discard must be explicit.

## Native handoff integration point

The existing exporter already does most of the capture work:

1. `BrowserDesignModeController.performCopySelection()` obtains a stable selection capture.
2. It builds `BrowserDesignModePromptContext` and writes structured JSON.
3. It formats a prompt with screenshot/context paths.
4. `deliverHandoff()` retains artifacts and writes the prompt to the clipboard.

The JSON contains page URL, requested change, revision, CSS edits/diff, selection context, screenshot paths, and prompt segments associating text with selections. Refactor capture/export into a reusable bundle operation; keep Copy and add a separate **Send to Pi** destination. Do not wrap the clipboard writer or scrape the page to recover the native comment.

The native composer already has an action button, copying state, and error display. Add explicit destination/session and queued/error feedback there. These are proposed changes, not existing bridge APIs.

### Artifact ownership

`BrowserDesignModeArtifactStore` supports handoff leases and pins files against pruning. The current clipboard handoff is retained by its browser panel; later handoffs replace that lease, and panel teardown releases it. Prunable files are bounded to a file-count budget, not durable session storage.

For bridge delivery:

- Retain each in-flight bundle until Pi confirms import, or the submission is explicitly abandoned under a bounded retention policy.
- Import validated artifacts into Pi-owned storage or message content before acknowledging success.
- Preserve retry identity and avoid delivering the same annotation twice.
- Keep the draft on failure; do not erase a newer draft when an older submission is acknowledged.
- Keep user-authored comments distinct from untrusted page content.

No native Copy operation was invoked in this spike. Export structure, native comment lifecycle, and lease behavior above are source-verified, not an end-to-end clipboard or bridge test.

## Required changes by repository

### cmux

1. Reusable capture/export bundle, separate from clipboard delivery.
2. Explicit browser-to-Pi binding and native Send action.
3. Transport delivery, acknowledgement/error UI, and bounded artifact retention.
4. Draft/capture status plus an atomic guard for model mutations and mode transitions.

### pi-cmux

1. Browser opening helper shared by `/cmb` and `cmux_open_browser`.
2. Session-scoped surface binding and lifecycle cleanup.
3. Bounded browser interaction tool with images returned as image content.
4. Private receiver, payload/path/size validation, duplicate detection, artifact import, and steering delivery.
5. Refuse mutating browser operations when the required upstream guard is unavailable and Design Mode is active.

## Evidence and remaining checks

Local scratch evidence from this run: `/tmp/pi-cmux-browser-spike.u7g5YB/`.

- `fixture.html`, `next.html`: local test pages.
- `probe.py`, `probe-results.json`: interaction, screenshot, and Design Mode conflict checks; all assertions passed.
- `extra-probe.py`, `extra-results.json`: lower split targeting/focus and unsupported input checks; all assertions passed. This script records run-specific source IDs and is not a reusable regression test yet.
- `fixture.png`, `design-mode.png`: inspected screenshots. Browser screenshots capture web content; the native composer is not present in these captures.
- `capabilities.json`: advertised methods, including methods unusable on the tested transport.
- `upstream/`: inspected source files at `b685a275c`.

Scratch artifacts are temporary and are not packaged. Disposable browser splits were closed after testing. No authenticated state or clipboard contents were read or changed.

Not tested: older cmux versions; remote workspaces; profile selection; HTTP/authenticated apps; native freehand drawing and comment entry by a human; native Copy export at runtime; concurrent user/model races; bridge delivery; Pi steering/image ingestion. Those remain integration tests, not established behavior.

## Pinned source references

All links target the installed revision:

- [Split creation and source targeting](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/TerminalController+ControlPaneContext.swift)
- [Design Mode status/set RPC](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/TerminalController+BrowserDesignMode.swift)
- [Controller, capture orchestration, and draft reset](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/Panels/BrowserDesignModeController.swift)
- [Clipboard delivery and lease ownership](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/Panels/BrowserDesignModeController+Handoff.swift)
- [Composer UI](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/Panels/BrowserDesignModePopover.swift)
- [Artifact store](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/Panels/BrowserDesignModeArtifactStore.swift)
- [Drawing/capture phases](https://github.com/manaflow-ai/cmux/blob/b685a275c/Sources/Panels/BrowserDesignModePhase.swift)
- [Structured export payload](https://github.com/manaflow-ai/cmux/blob/b685a275c/Packages/macOS/CmuxBrowser/Sources/CmuxBrowser/DesignMode/BrowserDesignModePromptPayload.swift)
