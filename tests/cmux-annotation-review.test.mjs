import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { confirmAnnotation } from "../lib/browser/annotation-review.ts";

for (const mode of ["tui", "rpc"]) {
	test(`${mode}: one compact confirmation, Cancel first, no required paging`, async () => {
		let calls = 0;
		const ctx = { mode, ui: { async select(title, choices, options) {
			calls++;
			assert.deepEqual(choices, ["Cancel", "Send to Pi"]);
			assert.equal(title.split("\n").length, 3);
			assert.match(title, /full note \+ page context/);
			assert.match(title, /Page scripts can forge/);
			assert.match(title, /Preview: Make this larger/);
			assert.equal(options.timeout, 120000);
			assert.equal(options.signal.aborted, false);
			return "Send to Pi";
		} } };
		assert.equal(await confirmAnnotation(ctx, "Make this larger", new AbortController().signal), "Send to Pi");
		assert.equal(calls, 1);
	});
}

test("long, multiline, wide, and control-bearing previews remain bounded", async () => {
	for (const comment of ["wide 界 é 👩‍💻 ".repeat(200), "line\n".repeat(20), "\x1b[31m\r\u2028\u202eSend\u2069"] ) {
		const ctx = { ui: { async select(title) {
			const lines = title.split("\n");
			assert.equal(lines.length, 3);
			assert.ok(visibleWidth(lines[1]) <= 69);
			assert.doesNotMatch(title, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u202e\u2069]/u);
			return "Cancel";
		} } };
		assert.equal(await confirmAnnotation(ctx, comment, new AbortController().signal), undefined);
	}
});

test("only explicit Send to Pi approves; dismissal and unexpected choices cancel", async () => {
	for (const choice of [undefined, "Cancel", "Next page", "yes"]) {
		assert.equal(await confirmAnnotation({ ui: { select: async () => choice } }, "Note", new AbortController().signal), undefined);
	}
});

test("pre-aborted requests never open a dialog", async () => {
	assert.equal(await confirmAnnotation({ ui: { select() { assert.fail("opened dialog"); } } }, "Note", AbortSignal.abort()), undefined);
});

test("cancellation racing approval cannot approve", async () => {
	const controller = new AbortController();
	const ctx = { ui: { async select(_title, _choices, { signal }) {
		controller.abort();
		assert.equal(signal.aborted, true);
		return "Send to Pi";
	} } };
	assert.equal(await confirmAnnotation(ctx, "Note", controller.signal), undefined);
});

test("confirmation retains its two-minute deadline", async t => {
	const timeout = new AbortController();
	t.mock.method(AbortSignal, "timeout", ms => { assert.equal(ms, 120000); return timeout.signal; });
	let dialogSignal;
	const pending = confirmAnnotation({ ui: { select(_title, _choices, { signal }) {
		dialogSignal = signal;
		return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
	} } }, "Note", new AbortController().signal);
	timeout.abort();
	assert.equal(await pending, undefined);
	assert.equal(dialogSignal.aborted, true);
});
