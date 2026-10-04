import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { AnnotationManager } from "../lib/browser/annotation-manager.ts";
import { annotationInstallScript } from "../lib/browser/transport.ts";
import { annotationPage } from "./helpers/annotation-page.mjs";
import { reviewSelect } from "./helpers/annotation-dialogs.mjs";

const flush = async () => { await immediate(); await immediate(); };
const binding = index => ({ sessionId: "one", surfaceId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, surfaceRef: `surface:${index}`, url: "https://example.test/" });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

function harness(t) {
	const jobs = [], confirmations = [], sent = [], disconnected = [], pages = new Map();
	t.mock.method(globalThis, "setTimeout", callback => { const job = { callback, unref() {} }; jobs.push(job); return job; });
	t.mock.method(globalThis, "clearTimeout", job => { if (job) job.cancelled = true; });
	const ctx = { mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "one" }, ui: {
		notify() {},
		select: reviewSelect((message, choices, { signal }) => {
			const decision = deferred(); confirmations.push({ message, choices, decision, signal });
			signal.addEventListener("abort", () => decision.resolve(undefined), { once: true });
			return decision.promise;
		}),
	} };
	const transport = {
		async install(target, config, signal) {
			signal.throwIfAborted();
			let page = pages.get(target.surfaceId);
			if (!page) { page = annotationPage(); pages.set(target.surfaceId, page); }
			return page.eval(annotationInstallScript(config));
		},
		async read(target, owner, acks, signal) {
			signal.throwIfAborted();
			return pages.get(target.surfaceId).eval(`globalThis.__piCmuxAnnotationsV1.poll(${JSON.stringify(owner)}, ${JSON.stringify(acks)})`);
		},
		async disconnect(target, owner) {
			disconnected.push(target.surfaceId);
			pages.get(target.surfaceId).eval(`globalThis.__piCmuxAnnotationsV1.disconnect(${JSON.stringify(owner)}); null`);
		},
	};
	const manager = new AnnotationManager({ sendUserMessage(...args) { sent.push(args); } }, transport);
	t.after(() => manager.stop());
	return {
		manager, ctx, transport, pages, confirmations, sent, disconnected,
		start: target => manager.start(target, ctx),
		submit(target, comment) {
			const page = pages.get(target.surfaceId);
			page.q(".launcher").click(); page.select(); page.type(comment); page.q(".send").click();
		},
		async tick() {
			while (jobs.length) { const job = jobs.shift(); if (!job.cancelled) { job.callback(); break; } }
			await flush();
		},
		async decide(index, choice) { confirmations[index].decision.resolve(choice); await flush(); },
	};
}

test("each browser gets its own off-by-default toggle and draft, with serialized Pi confirmations", async t => {
	const h = harness(t), first = binding(1), second = binding(2);
	await Promise.all([h.start(first), h.start(second)]);
	for (const page of h.pages.values()) assert.equal(page.q(".launcher").attributes["aria-checked"], "false");
	h.submit(first, "First note"); h.submit(second, "Second note");
	await h.tick(); await h.tick();
	assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0].message, /First note/);
	await h.decide(0, "Cancel");
	assert.equal(h.confirmations.length, 2); assert.match(h.confirmations[1].message, /Second note/);
	await h.decide(1, "Send to Pi");
	assert.equal(h.sent.length, 1); assert.match(h.sent[0][0], /Second note/); assert.match(h.sent[0][0], /surface:2/);
	await h.tick(); await h.tick();
	assert.equal(h.pages.get(first.surfaceId).q("textarea").value, "First note");
	assert.equal(h.pages.get(second.surfaceId).q("textarea").value, "");
});

test("switching a queued browser off cancels its submission without opening another Pi dialog", async t => {
	const h = harness(t), first = binding(1), second = binding(2);
	await h.start(first); await h.start(second);
	h.submit(first, "First note"); h.submit(second, "Second note");
	await h.tick(); await h.tick();
	h.pages.get(second.surfaceId).q(".launcher").click();
	await h.tick(); await h.tick();
	await h.decide(0, "Cancel");
	assert.equal(h.confirmations.length, 1); assert.equal(h.sent.length, 0);
	assert.equal(h.pages.get(second.surfaceId).q("textarea").value, "Second note");
});

test("stopping one bridge leaves another browser and its draft intact", async t => {
	const h = harness(t), first = binding(1), second = binding(2);
	await h.start(first); await h.start(second);
	h.submit(first, "First note"); h.submit(second, "Second note");
	await h.manager.disable(first.surfaceId);
	assert.deepEqual(h.disconnected, [first.surfaceId]);
	assert.equal(h.pages.get(second.surfaceId).q(".launcher").attributes["aria-checked"], "true");
	assert.equal(h.pages.get(second.surfaceId).q("textarea").value, "Second note");
	await h.tick(); assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0].message, /Second note/);
	await h.decide(0, "Cancel");
});

test("stopping the session aborts active and queued dialogs without sending or further polling", async t => {
	const h = harness(t);
	await h.start(binding(1)); await h.start(binding(2));
	h.submit(binding(1), "First note"); h.submit(binding(2), "Second note");
	await h.tick(); await h.tick(); h.manager.stop(); await flush();
	await h.decide(0, "Send to Pi"); await h.tick();
	assert.equal(h.confirmations.length, 1); assert.equal(h.confirmations[0].signal.aborted, true); assert.equal(h.sent.length, 0);
});

test("closed browsers cancel approval without page I/O and leave other bridges working", async t => {
	const h = harness(t), first = binding(1), second = binding(2);
	await h.start(first); await h.start(second);
	h.submit(first, "First note"); h.submit(second, "Second note");
	await h.tick(); await h.tick();
	h.manager.forget(first.surfaceId); await flush();
	assert.equal(h.confirmations[0].signal.aborted, true);
	assert.deepEqual(h.disconnected, [], "never evaluate a closed browser to disconnect it");
	assert.equal(h.confirmations.length, 2);
	await h.decide(0, "Send to Pi"); assert.equal(h.sent.length, 0);
	await h.decide(1, "Send to Pi"); assert.equal(h.sent.length, 1);
	assert.match(h.sent[0][0], /Second note/);
});

test("polling is capped at four browsers and disabling one frees its slot", async t => {
	const h = harness(t);
	for (let i = 1; i <= 4; i++) await h.start(binding(i));
	await assert.rejects(() => h.start(binding(5)), /4 browsers/);
	await h.manager.disable(binding(1).surfaceId);
	await h.start(binding(5));
	assert.equal(h.pages.size, 5);
});

test("concurrent activation of one browser shares its pending installation", async t => {
	const h = harness(t), gate = deferred();
	const install = h.transport.install;
	let calls = 0;
	h.transport.install = async (...args) => { calls++; await gate.promise; return install(...args); };
	const first = h.start(binding(1)), second = h.start(binding(1));
	assert.equal(first, second); assert.equal(calls, 1);
	gate.resolve(); await Promise.all([first, second]);
	assert.equal(h.pages.size, 1);
});

test("late startup after session stop cannot reactivate polling", async t => {
	const h = harness(t), gate = deferred();
	const install = h.transport.install;
	h.transport.install = async (...args) => { await gate.promise; return install(...args); };
	const pending = h.start(binding(1));
	h.manager.stop(); gate.resolve();
	await assert.rejects(() => pending, /abort/i);
	await h.tick(); assert.equal(h.pages.size, 0); assert.equal(h.confirmations.length, 0);
});
