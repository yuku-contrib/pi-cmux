import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cmuxAutotitleExtension from "../extensions/cmux-autotitle.ts";

const currentModel = { provider: "test", id: "current", maxTokens: 4096 };
const otherModel = { provider: "other", id: "small", maxTokens: 4096 };
const result = (text = "Fix login flow", stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }] });
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
};
async function drain() {
	for (let i = 0; i < 4; i++) await immediate();
}

async function harness(t, { global = {}, project = {}, env = {}, mode = "tui", complete, exec, name, saved, entries } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-cmux-autotitle-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agentDir);
	for (const [path, settings] of [[join(agentDir, "settings.json"), global], [join(cwd, ".pi", "settings.json"), project]]) {
		writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings));
	}
	for (const [key, value] of Object.entries({
		PI_CODING_AGENT_DIR: agentDir, PI_CMUX_AUTOTITLE: "1", PI_CMUX_AUTOTITLE_DISABLED: undefined,
		PI_CMUX_AUTOTITLE_MODEL: undefined, CMUX_SURFACE_ID: "surface:test", CMUX_PANEL_ID: undefined, ...env,
	})) {
		const previous = process.env[key];
		t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const calls = [];
	const requests = [];
	const handlers = new Map();
	const ctx = {
		cwd, mode, model: currentModel, isIdle: () => true,
		sessionManager: SessionManager.inMemory(cwd),
		modelRegistry: {
			find: (provider, id) => provider === otherModel.provider && id === otherModel.id ? otherModel : undefined,
			getAvailable: () => [currentModel, otherModel],
			complete: async (model, context, options) => {
				requests.push({ model, context, options });
				return complete ? complete(model, context, options) : result();
			},
		},
	};
	const seed = (prompt = "Fix login", reply = "Fixed", stopReason = "stop") => {
		ctx.sessionManager.appendMessage({ role: "user", content: prompt, timestamp: 1 });
		ctx.sessionManager.appendMessage({ role: "assistant", ...result(reply, stopReason), timestamp: 2 });
	};
	if (entries) for (const message of entries) ctx.sessionManager.appendMessage(message);
	else seed();
	if (name) ctx.sessionManager.appendSessionInfo(name);
	if (saved) ctx.sessionManager.appendCustomEntry("pi-cmux.autotitle", { title: saved });
	cmuxAutotitleExtension({
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (type, data) => ctx.sessionManager.appendCustomEntry(type, data),
		exec: async (command, args, options) => {
			calls.push({ command, args, options });
			if (exec) {
				const response = await exec(command, args, options);
				if (response) return response;
			}
			return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ caller: { workspace_ref: "workspace:1", surface_ref: "surface:1" } }) };
		},
	});
	const emit = (event, data = {}) => handlers.get(event)?.({ type: event, ...data }, ctx);
	t.after(() => emit("session_shutdown"));
	await emit("session_start", { reason: "startup" });
	return { ctx, calls, requests, emit, seed, renames: () => calls.filter(({ args }) => args[0] === "rename-tab") };
}

for (const [label, global, project, env, enabled] of [
	["default off", {}, {}, { PI_CMUX_AUTOTITLE: undefined }, false],
	["global opt-in", { "pi-cmux": { autotitle: true } }, {}, { PI_CMUX_AUTOTITLE: undefined }, true],
	["project disables global", { "pi-cmux": { autotitle: true } }, { "pi-cmux": { autotitle: false } }, { PI_CMUX_AUTOTITLE: undefined }, false],
	["project enables global", { "pi-cmux": { autotitle: false } }, { "pi-cmux": { autotitle: true } }, { PI_CMUX_AUTOTITLE: undefined }, true],
	["env opts out", { "pi-cmux": { autotitle: true } }, {}, { PI_CMUX_AUTOTITLE: "0" }, false],
	["disable wins over force-on", {}, {}, { PI_CMUX_AUTOTITLE_DISABLED: "1" }, false],
	["env opts in", {}, { "pi-cmux": { autotitle: false } }, {}, true],
	["malformed JSON", "{", "null", { PI_CMUX_AUTOTITLE: undefined }, false],
	["invalid section", { "pi-cmux": null }, { "pi-cmux": { autotitle: "true" } }, { PI_CMUX_AUTOTITLE: undefined }, false],
]) {
	test(`configuration: ${label}`, async (t) => {
		const h = await harness(t, { global, project, env });
		await h.emit("agent_settled"); await drain();
		assert.equal(h.requests.length, enabled ? 1 : 0);
		assert.equal(h.renames().length, enabled ? 1 : 0);
	});
}

for (const mode of ["print", "json", "rpc", "sdk"]) {
	test(`${mode} stays silent with inherited cmux environment`, async (t) => {
		const h = await harness(t, { mode });
		await h.emit("agent_settled"); await drain();
		assert.equal(h.calls.length, 0);
		assert.equal(h.requests.length, 0);
	});
}

for (const panel of [undefined, "panel:test"]) {
	test(`surface/panel gate: ${String(panel)}`, async (t) => {
		const h = await harness(t, { env: { CMUX_SURFACE_ID: undefined, CMUX_PANEL_ID: panel } });
		await h.emit("agent_settled"); await drain();
		assert.equal(h.requests.length, panel ? 1 : 0);
	});
}

test("identification failure prevents a provider request", async (t) => {
	const h = await harness(t, { exec: () => ({ code: 0, killed: false, stdout: "{}", stderr: "" }) });
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 0);
	assert.equal(h.renames().length, 0);
});

test("shutdown during caller identification prevents a provider request", async (t) => {
	const pending = deferred();
	const h = await harness(t, { exec: () => pending.promise });
	await h.emit("agent_settled"); await drain();
	await h.emit("session_shutdown");
	assert.equal(h.calls[0].options.signal.aborted, true);
	pending.resolve({ code: 0, killed: false, stderr: "", stdout: JSON.stringify({ caller: { workspace_ref: "workspace:1", surface_ref: "surface:1" } }) });
	await drain();
	assert.equal(h.requests.length, 0);
});

test("model resolution failures stay silent and retryable", async (t) => {
	const h = await harness(t, { env: { PI_CMUX_AUTOTITLE_MODEL: "small" } });
	h.ctx.modelRegistry.getAvailable = () => { throw new Error("registry unavailable"); };
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 0);
	h.ctx.modelRegistry.getAvailable = () => [otherModel];
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 1);
});

test("extension instances do not share naming state", async (t) => {
	const first = await harness(t);
	await first.emit("agent_settled"); await drain();
	await t.test("second runtime", async (child) => {
		const second = await harness(child);
		await second.emit("agent_settled"); await drain();
		assert.equal(first.requests.length, 1);
		assert.equal(second.requests.length, 1);
	});
});

test("waits for idle settlement, does not block dispatch, and titles only once", async (t) => {
	const pending = deferred();
	const h = await harness(t, { complete: () => pending.promise });
	await h.emit("agent_start"); await h.emit("agent_end"); await drain();
	assert.equal(h.requests.length, 0);
	h.ctx.isIdle = () => false;
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 0);
	h.ctx.isIdle = () => true;
	assert.equal(h.emit("agent_settled"), undefined, "settlement must not await the LLM");
	await drain();
	assert.equal(h.requests.length, 1);
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 1, "do not duplicate an in-flight request");
	pending.resolve(result()); await drain();
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 1);
	assert.deepEqual(h.renames()[0].args, ["rename-tab", "--workspace", "workspace:1", "--surface", "surface:1", "--title", "Fix login flow"]);
	assert.equal(h.ctx.sessionManager.getBranch().at(-1).customType, "pi-cmux.autotitle");
});

for (const event of ["before_agent_start", "agent_start", "session_shutdown", "session_tree", "session_start"]) {
	test(`${event} aborts and discards a late provider result`, async (t) => {
		const pending = deferred();
		const h = await harness(t, { complete: () => pending.promise });
		await h.emit("agent_settled"); await drain();
		const signal = h.requests[0].options.signal;
		await h.emit(event, { reason: "new" });
		assert.equal(signal.aborted, true);
		pending.resolve(result("Stale title")); await drain();
		assert.equal(h.renames().length, 0);
		assert.equal(h.ctx.sessionManager.getBranch().filter((e) => e.type === "custom").length, 0);
	});
}

test("/name cancels an in-flight request and wins even if the provider ignores abort", async (t) => {
	const pending = deferred();
	const h = await harness(t, { complete: () => pending.promise });
	await h.emit("agent_settled"); await drain();
	await h.emit("session_info_changed", { name: "Manual name" }); await drain();
	pending.resolve(result("Stale automatic name")); await drain();
	assert.equal(h.requests[0].options.signal.aborted, true);
	assert.deepEqual(h.renames().map(({ args }) => args.at(-1)), ["Manual name"]);
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 1);
});

test("/name is applied after an already-dispatched automatic rename", async (t) => {
	const pending = deferred();
	const h = await harness(t, { exec: (_command, args) => args[0] === "rename-tab" && args.at(-1) !== "Manual" ? pending.promise : undefined });
	await h.emit("agent_settled"); await drain();
	assert.equal(h.renames().length, 1);
	await h.emit("session_info_changed", { name: "Manual" }); await drain();
	assert.equal(h.renames().length, 1, "manual rename queues behind the old command");
	pending.resolve({ code: 0, killed: false, stdout: "", stderr: "" }); await drain();
	assert.deepEqual(h.renames().map(({ args }) => args.at(-1)), ["Fix login flow", "Manual"]);
	assert.equal(h.ctx.sessionManager.getBranch().filter((e) => e.type === "custom").length, 0);
});

for (const reason of ["new", "resume", "fork"]) {
	test(`${reason} resets old conversation state`, async (t) => {
		const h = await harness(t);
		await h.emit("agent_settled"); await drain();
		h.ctx.sessionManager = SessionManager.inMemory(h.ctx.cwd);
		h.seed("Different task", "Different result");
		await h.emit("session_start", { reason });
		await h.emit("agent_settled"); await drain();
		assert.equal(h.requests.length, 2);
		assert.match(h.requests[1].context.messages[0].content, /Different task/);
	});
}

test("existing session names take priority over saved automatic names without a request", async (t) => {
	const h = await harness(t, { name: "User-owned name", saved: "Old automatic title" });
	await drain(); await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 0);
	assert.deepEqual(h.renames().map(({ args }) => args.at(-1)), ["User-owned name"]);
});

test("saved titles survive reload without another provider request; clearing /name permits naming", async (t) => {
	const h = await harness(t);
	await h.emit("agent_settled"); await drain();
	await h.emit("session_start", { reason: "reload" }); await drain();
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 1);
	await h.emit("session_info_changed", { name: undefined });
	await h.emit("session_start", { reason: "reload" });
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 2);
});

test("bounds the transcript to four text messages, preserving head and tail", async (t) => {
	const h = await harness(t);
	for (let i = 0; i < 10; i++) h.seed(`request-${i} ${"x".repeat(1000)} end-${i}`, `reply-${i} ${"y".repeat(1000)} final-${i}`);
	await h.emit("agent_settled"); await drain();
	const transcript = h.requests[0].context.messages[0].content;
	assert.equal(transcript.split("\n").length, 4);
	assert.ok(transcript.length <= 4 * 311);
	assert.match(transcript, /request-8.*end-8/);
	assert.match(transcript, /reply-9.*final-9/);
	assert.doesNotMatch(transcript, /request-7/);
	assert.equal(h.requests[0].options.cacheRetention, "none");
});

for (const [requested, expected] of [[undefined, currentModel], ["other/small", otherModel], ["small", otherModel], ["missing", undefined]]) {
	test(`model selection: ${String(requested)}`, async (t) => {
		const h = await harness(t, { env: { PI_CMUX_AUTOTITLE_MODEL: requested } });
		await h.emit("agent_settled"); await drain();
		assert.equal(h.requests.length, expected ? 1 : 0);
		if (expected) assert.equal(h.requests[0].model, expected);
	});
}

for (const failure of [() => { throw new Error("auth unavailable"); }, () => result("", "stop"), () => result("Partial", "error"), () => result("Partial", "aborted")]) {
	test(`failed naming can retry: ${String(failure)}`, async (t) => {
		let fail = true;
		const h = await harness(t, { complete: () => fail ? failure() : result() });
		await h.emit("agent_settled"); await drain();
		assert.equal(h.renames().length, 0);
		fail = false;
		await h.emit("agent_settled"); await drain();
		assert.equal(h.requests.length, 2);
		assert.equal(h.renames().length, 1);
	});
}

test("failed rename leaves naming retryable", async (t) => {
	let fail = true;
	const h = await harness(t, { exec: (_command, args) => fail && args[0] === "rename-tab" ? { code: 1, killed: false, stderr: "closed", stdout: "" } : undefined });
	await h.emit("agent_settled"); await drain();
	assert.equal(h.ctx.sessionManager.getBranch().filter((e) => e.type === "custom").length, 0);
	fail = false;
	await h.emit("agent_settled"); await drain();
	assert.equal(h.requests.length, 2);
	assert.equal(h.ctx.sessionManager.getBranch().at(-1).customType, "pi-cmux.autotitle");
});

test("timeout discards stale results and allows a later request", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const pending = deferred();
	let first = true;
	const h = await harness(t, { complete: () => first ? pending.promise : result("Fresh title") });
	await h.emit("agent_settled"); await drain();
	t.mock.timers.tick(60_000);
	assert.equal(h.requests[0].options.signal.aborted, true);
	first = false;
	await h.emit("agent_settled"); await drain();
	pending.resolve(result("Stale")); await drain();
	assert.deepEqual(h.renames().map(({ args }) => args.at(-1)), ["Fresh title"]);
});

test("sanitizes and bounds model output", async (t) => {
	const h = await harness(t, { complete: () => result(`Title: "Fix\u0000 login ${"flow ".repeat(30)}"`) });
	await h.emit("agent_settled"); await drain();
	const title = h.renames()[0].args.at(-1);
	assert.ok(title.length <= 48);
	assert.doesNotMatch(title, /[\u0000-\u001f\u007f-\u009f]/);
	assert.match(title, /^Fix login/);
});

for (const stopReason of ["error", "aborted"]) {
	test(`does not name a ${stopReason} run`, async (t) => {
		const h = await harness(t);
		h.seed("Retry", "Failed", stopReason);
		await h.emit("agent_settled"); await drain();
		assert.equal(h.requests.length, 0);
	});
}
