import assert from "node:assert/strict";
import { test } from "node:test";
import cmuxBrowserExtension, { parseBrowserCommand } from "../extensions/cmux-browser.ts";
import { normalizeBrowserOptions, openBrowserSplit } from "../lib/browser/client.ts";
import { BrowserBindings } from "../lib/browser/bindings.ts";

const WINDOW = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";
const SOURCE_PANE = "44444444-4444-4444-8444-444444444444";
const SURFACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PANE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const URL = "http://localhost:3000/";
const CALLER = { window_id: WINDOW, workspace_id: WORKSPACE, surface_id: SOURCE, pane_id: SOURCE_PANE, surface_type: "terminal" };
const CREATED = { window_id: WINDOW, workspace_id: WORKSPACE, surface_id: SURFACE, pane_id: PANE, surface_ref: "surface:2", type: "browser" };
const result = (value) => ({ code: 0, killed: false, stdout: JSON.stringify(value), stderr: "" });

function harness(options = {}) {
	const calls = [];
	const pi = {
		async exec(command, args, execOptions) {
			assert.equal(command, "cmux");
			assert.ok(execOptions.timeout > 0 && execOptions.timeout <= 10000);
			const kind = args.includes("identify") ? "identify" : args.includes("pane.create") ? "create" : "unexpected";
			if (kind === "unexpected" && options.other) {
				calls.push({ args, options: execOptions, kind });
				return options.other(args, execOptions);
			}
			assert.notEqual(kind, "unexpected", `Unexpected command: ${args.join(" ")}`);
			calls.push({ args, options: execOptions, kind });
			if (kind === "identify") {
				if (options.identify) return options.identify(execOptions);
				return options.identifyResult ?? result({ caller: CALLER, focused: { ...CALLER, surface_id: OTHER } });
			}
			if (options.create) return options.create(JSON.parse(args.at(-1)), execOptions);
			return options.createResult ?? result(CREATED);
		},
	};
	return { pi, calls, callsFor: (kind) => calls.filter((call) => call.kind === kind) };
}

function extensionHarness(options = {}) {
	const h = harness(options);
	const commands = new Map();
	const tools = new Map();
	const events = new Map();
	const notifications = [];
	const ctx = { hasUI: options.hasUI ?? false, sessionManager: { getSessionId: () => "session-one" }, ui: { notify: (...args) => notifications.push(args) } };
	Object.assign(h.pi, {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
	});
	const tracked = [];
	let removed;
	const lifecycle = { track: binding => tracked.push(binding), forget() {}, stop() { tracked.length = 0; } };
	cmuxBrowserExtension(h.pi, (_pi, onRemoved) => { removed = onRemoved; return lifecycle; });
	return {
		...h, commands, tools, events, notifications, ctx, tracked, closed: binding => removed(binding),
		start: () => events.get("session_start")({ type: "session_start", reason: "startup" }, ctx),
		stop: () => events.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx),
		invoke: (params = { url: URL }, signal) => tools.get("cmux_open_browser").execute("open", params, signal, undefined, ctx),
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

for (const placement of [undefined, "right", "down"]) {
	for (const focus of [undefined, false, true]) {
		test(`browser opens an explicit caller-relative split: placement=${placement}, focus=${focus}`, async () => {
			const h = harness();
			const opened = await openBrowserSplit(h.pi, { url: URL, placement, focus });
			assert.deepEqual(h.calls[0].args, ["--json", "--id-format", "both", "identify"]);
			assert.deepEqual(h.calls[1].args.slice(0, 3), ["--json", "rpc", "pane.create"]);
			assert.deepEqual(JSON.parse(h.calls[1].args[3]), {
				window_id: WINDOW, workspace_id: WORKSPACE, surface_id: SOURCE,
				type: "browser", direction: placement ?? "right", url: URL, focus: focus ?? false,
			});
			assert.deepEqual(opened, {
				windowId: WINDOW, workspaceId: WORKSPACE, sourceSurfaceId: SOURCE,
				surfaceId: SURFACE, paneId: PANE, surfaceRef: "surface:2",
				url: URL, placement: placement ?? "right", focus: focus ?? false,
			});
			assert.deepEqual(h.calls.map((call) => call.options.timeout), [5000, 10000]);
			assert.equal(h.calls.length, 2, "no shell terminal, readiness polling, injection, or Design Mode calls");
		});
	}
}

test("UUID casing is normalized and display refs are optional", async () => {
	const h = harness({ createResult: result({ ...CREATED, surface_id: SURFACE.toUpperCase(), pane_id: PANE.toUpperCase(), surface_ref: undefined }) });
	const opened = await openBrowserSplit(h.pi, { url: URL });
	assert.equal(opened.surfaceId, SURFACE);
	assert.equal(opened.paneId, PANE);
	assert.equal(opened.surfaceRef, undefined);
});

for (const url of ["https://example.test/a?x=1&y=2#target", "file:///tmp/a%20file.html", "https://example.test/?q='$(whoami)';`echo`", "http://127.0.0.1:3000/"]) {
	test(`URL is passed as JSON data, not a shell command: ${url}`, async () => {
		const h = harness();
		await openBrowserSplit(h.pi, { url });
		assert.equal(JSON.parse(h.calls[1].args[3]).url, normalizeBrowserOptions({ url }).url);
	});
}

for (const params of [
	{}, null, { url: "" }, { url: 12 }, { url: "localhost:3000" }, { url: "/tmp/index.html" },
	{ url: "javascript:alert(1)" }, { url: "data:text/html,hi" }, { url: "ftp://example.test" },
	{ url: "https:/example.test" }, { url: "https://a.test/has space" }, { url: "https://a.test/\u0000" },
	{ url: `https://a.test/${"a".repeat(8192)}` }, { url: "file://remote/tmp/a" },
	{ url: "https://user:pass@example.test" }, { url: "https://user@example.test" },
	{ url: URL, placement: "tab" }, { url: URL, focus: "false" },
]) {
	test(`invalid browser options have no side effects: ${JSON.stringify(params)?.slice(0, 100)}`, async () => {
		const h = harness();
		await assert.rejects(() => openBrowserSplit(h.pi, params));
		assert.equal(h.calls.length, 0);
	});
}

for (const identified of [
	null, [], {}, { caller: null, focused: CALLER },
	{ caller: { ...CALLER, surface_type: "browser" } },
	{ caller: { ...CALLER, window_id: undefined } },
	{ caller: { ...CALLER, workspace_id: "workspace:1" } },
	{ caller: { ...CALLER, surface_id: "surface:1" } },
	{ caller: { ...CALLER, pane_id: undefined } },
]) {
	test(`unsafe caller never creates a browser: ${JSON.stringify(identified)}`, async () => {
		const h = harness({ identifyResult: result(identified) });
		await assert.rejects(() => openBrowserSplit(h.pi, { url: URL }));
		assert.equal(h.callsFor("create").length, 0);
	});
}

for (const created of [
	null, [], {}, { ...CREATED, surface_id: undefined }, { ...CREATED, pane_id: undefined },
	{ ...CREATED, workspace_id: OTHER }, { ...CREATED, window_id: OTHER },
	{ ...CREATED, surface_id: SOURCE }, { ...CREATED, pane_id: SOURCE_PANE },
	{ ...CREATED, type: "terminal" }, { ...CREATED, surface_id: "surface:2" },
]) {
	test(`unsafe creation response is not retried or adopted: ${JSON.stringify(created)}`, async () => {
		const h = harness({ createResult: result(created) });
		await assert.rejects(() => openBrowserSplit(h.pi, { url: URL }), /not confirmed.*may already exist/s);
		assert.equal(h.callsFor("create").length, 1);
		assert.equal(h.calls.length, 2);
	});
}

for (const stage of ["identify", "create"]) {
	for (const [label, response, pattern] of [
		["failure", { ...result({}), code: 1, stderr: "Browser disabled" }, /Browser disabled/],
		["timeout", { ...result(CREATED), killed: true }, /timed out/],
		["bad JSON", { ...result({}), stdout: "OK" }, /Invalid cmux JSON/],
		["empty failure", { ...result({}), code: 1, stdout: "" }, /exited with code 1/],
	]) {
		test(`${stage} ${label} is reported without retry`, async () => {
			const h = harness({ [`${stage}Result`]: response });
			await assert.rejects(() => openBrowserSplit(h.pi, { url: URL }), pattern);
			assert.equal(h.callsFor("create").length, stage === "identify" ? 0 : 1);
		});
	}
}

test("missing cmux executable produces a failure without creation", async () => {
	const h = harness({ identify: () => { throw new Error("spawn cmux ENOENT"); } });
	await assert.rejects(() => openBrowserSplit(h.pi, { url: URL }), /ENOENT/);
	assert.equal(h.callsFor("create").length, 0);
});

test("cancellation is forwarded and never retried", async () => {
	const before = harness();
	await assert.rejects(() => openBrowserSplit(before.pi, { url: URL }, AbortSignal.abort()), /abort/i);
	assert.equal(before.calls.length, 0);
	const controller = new AbortController();
	const h = harness({ create: (_params, options) => {
		assert.equal(options.signal, controller.signal);
		controller.abort();
		return result(CREATED);
	} });
	await assert.rejects(() => openBrowserSplit(h.pi, { url: URL }, controller.signal), /not confirmed.*abort.*may already exist/is);
	assert.equal(h.callsFor("create").length, 1);
});

test("cancellation after identify stops before creation", async () => {
	const controller = new AbortController();
	const h = harness({ identify: () => { controller.abort(); return result({ caller: CALLER }); } });
	await assert.rejects(() => openBrowserSplit(h.pi, { url: URL }, controller.signal), /abort/i);
	assert.equal(h.callsFor("create").length, 0);
});

test("bindings are session-scoped, immutable, and cleared without closing the browser", async () => {
	const h = harness();
	const bindings = new BrowserBindings();
	await assert.rejects(() => bindings.open(h.pi, "one", { url: URL }), /not active/);
	bindings.start("one");
	const binding = await bindings.open(h.pi, "one", { url: URL });
	assert.equal(binding.sessionId, "one");
	assert.equal(Object.isFrozen(binding), true);
	assert.deepEqual(bindings.list("one"), [binding]);
	assert.deepEqual(bindings.list("other"), []);
	bindings.list("one").pop();
	assert.equal(bindings.list("one").length, 1);
	await assert.rejects(() => bindings.open(h.pi, "other", { url: URL }), /not active/);
	bindings.stop();
	bindings.stop();
	assert.deepEqual(bindings.list("one"), []);
	assert.equal(h.calls.length, 2, "cleanup must not close a user-visible browser");
	assert.ok(h.calls.every((call) => call.options.signal.aborted));
});

test("closed browser bindings cannot be retried or silently adopted", async () => {
	const h = extensionHarness(); h.start(); await h.invoke();
	const binding = h.tracked[0];
	assert.equal(binding.surfaceId, SURFACE);
	h.closed(binding);
	await assert.rejects(() => h.tools.get("cmux_annotate_browser").execute("retry", {surface: SURFACE}, undefined, undefined, h.ctx), /Specify one browser/);
	assert.equal(h.notifications.length, 0, "normal closure is quiet");
	h.stop();
});

test("a stale removal cannot erase a new session's binding with the same UUID", async () => {
	const h = harness(), bindings = new BrowserBindings();
	bindings.start("one"); const old = await bindings.open(h.pi, "one", {url: URL});
	bindings.start("one"); const current = await bindings.open(h.pi, "one", {url: URL});
	assert.equal(bindings.remove(old), false);
	assert.deepEqual(bindings.list("one"), [current]);
	assert.equal(bindings.remove(current), true);
	assert.deepEqual(bindings.list("one"), []);
});

test("failed opens do not create bindings", async () => {
	const h = harness({ createResult: result({ ...CREATED, workspace_id: OTHER }) });
	const bindings = new BrowserBindings();
	bindings.start("one");
	await assert.rejects(() => bindings.open(h.pi, "one", { url: URL }));
	assert.deepEqual(bindings.list("one"), []);
});

for (const restartId of [undefined, "one", "two"]) {
	test(`shutdown/reload/switch cancels in-flight creation and rejects late results: ${restartId}`, async () => {
		const entered = deferred();
		const response = deferred();
		const h = harness({ create: (_params, options) => { entered.resolve(options.signal); return response.promise; } });
		const bindings = new BrowserBindings();
		bindings.start("one");
		const pending = bindings.open(h.pi, "one", { url: URL });
		const signal = await entered.promise;
		if (restartId) bindings.start(restartId);
		else bindings.stop();
		assert.equal(signal.aborted, true);
		response.resolve(result(CREATED));
		await assert.rejects(() => pending, /session ended/);
		assert.deepEqual(bindings.list("one"), []);
		assert.deepEqual(bindings.list("two"), []);
	});
}

test("concurrent opens keep their own returned surfaces", async () => {
	let index = 0;
	const h = harness({ create: () => result({ ...CREATED, surface_id: index++ === 0 ? SURFACE : OTHER }) });
	const bindings = new BrowserBindings();
	bindings.start("one");
	const opened = await Promise.all([bindings.open(h.pi, "one", { url: URL }), bindings.open(h.pi, "one", { url: URL })]);
	assert.deepEqual(opened.map((binding) => binding.surfaceId), [SURFACE, OTHER]);
	assert.equal(bindings.list("one").length, 2);
});

test("an already-bound surface cannot be replaced by another creation response", async () => {
	const h = harness();
	const bindings = new BrowserBindings();
	bindings.start("one");
	await bindings.open(h.pi, "one", { url: URL });
	await assert.rejects(() => bindings.open(h.pi, "one", { url: "https://example.test/" }), /already-bound/);
	assert.equal(bindings.list("one")[0].url, URL);
});

for (const [args, expected] of [
	[URL, { url: URL, placement: "right", focus: false }],
	[`--down ${URL}`, { url: URL, placement: "down", focus: false }],
	[` --focus --down ${URL} `, { url: URL, placement: "down", focus: true }],
]) {
	test(`parse /cmb ${args}`, () => assert.deepEqual(parseBrowserCommand(args), expected));
}
for (const args of ["", "--down", "--tab https://example.test", `--down --down ${URL}`, `--focus --focus ${URL}`, `${URL} --down`, `${URL} extra`]) {
	test(`invalid /cmb syntax: ${args}`, () => assert.throws(() => parseBrowserCommand(args), /Usage/));
}

test("registration and session lifecycle are inert until an explicit open", () => {
	const h = extensionHarness();
	assert.deepEqual([...h.commands.keys()].sort(), ["cmb", "cmba"]);
	assert.deepEqual([...h.tools.keys()].sort(), ["cmux_annotate_browser", "cmux_open_browser"]);
	h.start();
	h.stop();
	assert.equal(h.calls.length, 0);
	const tool = h.tools.get("cmux_open_browser");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.parameters.properties.focus.default, false);
	assert.deepEqual(tool.parameters.properties.placement.enum, ["right", "down"]);
	assert.ok(tool.promptGuidelines.some((text) => text.includes("explicitly")));
});

test("/cmb and model tool share opening behavior and return session binding details", async () => {
	let index = 0;
	const h = extensionHarness({ create: () => result({ ...CREATED, surface_id: index++ === 0 ? SURFACE : OTHER }) });
	h.start();
	await h.commands.get("cmb").handler(`--down ${URL}`, h.ctx);
	assert.equal(h.notifications.at(-1)[1], "info");
	assert.equal(JSON.parse(h.callsFor("create")[0].args[3]).direction, "down");
	const opened = await h.invoke({ url: URL, placement: "right", focus: true });
	assert.equal(opened.details.sessionId, "session-one");
	assert.equal(opened.details.surfaceId, OTHER);
	assert.equal(opened.details.focus, true);
	assert.match(opened.content[0].text, /not implemented yet/);
	h.stop();
	await assert.rejects(() => h.invoke(), /not active/);
	assert.equal(h.callsFor("create").length, 2);
});

test("browser creation succeeds without waiting for annotation readiness, and shutdown cancels late injection", async () => {
	const response = deferred();
	let injectionSignal;
	const h = extensionHarness({ hasUI: true, other: (_args, options) => { injectionSignal = options.signal; return response.promise; } });
	h.start();
	const opened = await h.invoke();
	assert.equal(opened.details.surfaceId, SURFACE);
	assert.equal(h.callsFor("create").length, 1);
	assert.match(opened.content[0].text, /off by default/);
	assert.equal(injectionSignal.aborted, false);
	h.stop();
	assert.equal(injectionSignal.aborted, true);
	response.resolve(result({}));
	await new Promise(setImmediate);
	assert.equal(h.callsFor("create").length, 1, "annotation failures never retry browser creation");
	assert.equal(h.notifications.length, 0, "late results cannot notify a replaced session");
});

for (const opener of ["command", "tool"]) {
	for (const teardown of ["shutdown", "reload", "switch"]) {
		test(`${teardown} between binding and ${opener} continuation cannot restart lifecycle tracking`, async t => {
			const h = extensionHarness({ hasUI: true });
			t.after(h.stop);
			h.start();
			const open = BrowserBindings.prototype.open;
			t.mock.method(BrowserBindings.prototype, "open", async function (...args) {
				const binding = await open.apply(this, args);
				assert.ok(this.list(binding.sessionId).includes(binding), "creation already bound its result");
				if (teardown === "shutdown") h.stop();
				else {
					if (teardown === "switch") h.ctx.sessionManager.getSessionId = () => "session-two";
					h.start();
				}
				return binding;
			});
			if (opener === "tool") await assert.rejects(() => h.invoke(), /no longer bound.*session ended or changed/);
			else {
				await h.commands.get("cmb").handler(URL, h.ctx);
				assert.match(h.notifications.at(-1)[0], /no longer bound.*session ended or changed/);
			}
			assert.deepEqual(h.tracked, [], "no obsolete binding may revive a stopped listener");
			assert.equal(h.calls.length, 2, "no annotation injection after session teardown");
		});
	}

	test(`tree navigation invalidates late annotation startup from a pending ${opener} open`, async () => {
		const response = deferred();
		const h = extensionHarness({ hasUI: true, create: () => response.promise });
		h.start();
		const pending = opener === "command" ? h.commands.get("cmb").handler(URL, h.ctx) : h.invoke();
		await new Promise(setImmediate);
		assert.equal(h.callsFor("create").length, 1);
		h.events.get("session_tree")({}, h.ctx);
		response.resolve(result(CREATED));
		const opened = await pending;
		await new Promise(setImmediate);
		assert.equal(h.calls.length, 2, "late creation must not inject or poll after navigation");
		assert.equal(h.tracked.length, 1, "tree navigation must still track a current session's browser");
		const text = opener === "tool" ? opened.content[0].text : h.notifications.at(-1)[0];
		assert.match(text, /Annotations were not started/);
		assert.match(text, /browser remains open/);
		h.stop();
	});
}

test("headless browser opening remains functional without injecting or polling", async () => {
	const h = extensionHarness({ hasUI: false }); h.start();
	const opened = await h.invoke();
	assert.equal(h.calls.length, 2);
	assert.match(opened.content[0].text, /confirmation-capable Pi UI/);
	h.stop();
});

test("/cmb invalid arguments warn without invoking cmux", async () => {
	const h = extensionHarness();
	h.start();
	await h.commands.get("cmb").handler("--bad", h.ctx);
	assert.equal(h.notifications.at(-1)[1], "warning");
	assert.equal(h.calls.length, 0);
});

test("command reports failures and model tool throws instead of returning success", async () => {
	const h = extensionHarness({ createResult: { ...result({}), code: 1, stderr: "Browser disabled" } });
	h.start();
	await h.commands.get("cmb").handler(URL, h.ctx);
	assert.equal(h.notifications.at(-1)[1], "error");
	assert.match(h.notifications.at(-1)[0], /Browser disabled/);
	await assert.rejects(() => h.invoke(), /Browser disabled/);
});

test("model cancellation aborts creation but leaves the session usable", async () => {
	const h = extensionHarness();
	h.start();
	await assert.rejects(() => h.invoke({ url: URL }, AbortSignal.abort()), /abort/i);
	assert.equal(h.calls.length, 0);
	assert.equal((await h.invoke()).details.surfaceId, SURFACE);
});
