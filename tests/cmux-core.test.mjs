import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { buildPiCommand, buildShellCommand, shellEscape } from "../extensions/cmux-core.ts";

// Test the installed Pi parser, not a copy, so dependency updates exercise the CLI contract.
const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { parseArgs } = await import(new URL("./cli/args.js", piEntry).href);

function withPath(path, callback) {
	const previousPath = process.env.PATH;
	try {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		return callback();
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
}

function captureCommand(t, buildCommand, terminalPath = "/usr/bin:/bin") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cmux-command-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project's $HOME $(printf wrong) `printf wrong`; files");
	const bin = join(root, "bin's $HOME $(printf wrong) `printf wrong`; tools");
	mkdirSync(cwd);
	mkdirSync(bin);
	writeFileSync(join(cwd, "glob.txt"), "");
	symlinkSync(process.execPath, join(bin, "node"));
	for (const name of ["pi", "cmux-test-tool"]) {
		writeFileSync(join(bin, name), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), path: process.env.PATH }));\n', { mode: 0o755 });
	}
	const callerPath = [bin, "/usr/bin", "/bin"].join(delimiter);
	const command = withPath(callerPath, () => buildCommand(cwd));

	// cmux's app environment can have a different PATH from the invoking Pi process.
	// Test our command and Node shebang, not cmux's outer login shell.
	// The optional installed-CLI contract test checks that wrapper without executing it.
	const result = spawnSync("/bin/sh", ["-c", command], {
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			HOME: root,
			PATH: terminalPath,
		},
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const captured = JSON.parse(result.stdout);
	assert.equal(captured.cwd, cwd);
	assert.equal(captured.path, callerPath);
	return captured;
}

function captureLaunch(t, options, terminalPath) {
	const captured = captureCommand(t, (cwd) => buildPiCommand(cwd, options), terminalPath);
	const parsed = parseArgs(captured.args);
	assert.deepEqual(parsed.diagnostics, []);
	assert.equal(parsed.unknownFlags.size, 0);
	return { args: captured.args, parsed };
}

test("preserve caller PATH for Pi and Node when the terminal PATH is empty", (t) => {
	const { args } = captureLaunch(t, { prompt: "--help" }, "");
	assert.deepEqual(args, ["--", "--help"]);
});

test("launch without options stays fresh and uses Pi defaults", (t) => {
	const { args, parsed } = captureLaunch(t);
	assert.deepEqual(args, []);
	assert.deepEqual(parsed.messages, []);
	assert.equal(parsed.session, undefined);
	assert.equal(parsed.continue, undefined);
	assert.equal(parsed.resume, undefined);
	assert.equal(parsed.provider, undefined);
	assert.equal(parsed.model, undefined);
	assert.equal(parsed.thinking, undefined);
});

for (const prompt of ["", " \n\t "]) {
	test(`omit empty prompt ${JSON.stringify(prompt)}`, (t) => {
		const { args, parsed } = captureLaunch(t, { prompt });
		assert.deepEqual(args, []);
		assert.deepEqual(parsed.messages, []);
	});
}

for (const prompt of [
	"Review the auth flow",
	"--help",
	"--continue",
	"--model=unintended-model",
	"--",
	"- Review these points",
	"  First line\nSecond line  ",
	'Bob\'s "quoted" task: $HOME $(printf wrong) `printf wrong`; *.txt | cat > output',
]) {
	test(`preserve prompt ${JSON.stringify(prompt)}`, (t) => {
		const { args, parsed } = captureLaunch(t, { prompt });
		assert.deepEqual(args, ["--", prompt.trim()]);
		assert.deepEqual(parsed.messages, [prompt.trim()]);
		assert.deepEqual(parsed.fileArgs, []);
		assert.equal(parsed.help, undefined);
		assert.equal(parsed.continue, undefined);
		assert.equal(parsed.model, undefined);
	});
}

test("quote session and model settings before the prompt separator", (t) => {
	const options = {
		sessionFile: "/tmp/session's $HOME $(printf wrong).jsonl",
		provider: "provider's $(printf wrong)",
		model: 'model/with "quotes"; `printf wrong` *',
		thinking: "max",
		prompt: "--help",
	};
	const { args, parsed } = captureLaunch(t, options);
	assert.deepEqual(args, [
		"--session", options.sessionFile,
		"--provider", options.provider,
		"--model", options.model,
		"--thinking", options.thinking,
		"--", options.prompt,
	]);
	assert.equal(parsed.session, options.sessionFile);
	assert.equal(parsed.provider, options.provider);
	assert.equal(parsed.model, options.model);
	assert.equal(parsed.thinking, options.thinking);
	assert.deepEqual(parsed.messages, [options.prompt]);
	assert.equal(parsed.help, undefined);
});

for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
	test(`accept thinking level ${thinking} without a prompt`, (t) => {
		const { args, parsed } = captureLaunch(t, { thinking });
		assert.deepEqual(args, ["--thinking", thinking]);
		assert.equal(parsed.thinking, thinking);
		assert.deepEqual(parsed.messages, []);
	});
}

test("preserve provider/model and model:thinking shorthand", (t) => {
	const model = "openai/example:high";
	const { args, parsed } = captureLaunch(t, { model });
	assert.deepEqual(args, ["--model", model]);
	assert.equal(parsed.model, model);
	assert.equal(parsed.provider, undefined);
});

test("retain Pi's @file input behavior after the separator", (t) => {
	const { args, parsed } = captureLaunch(t, { prompt: "@prompt file.md" });
	assert.deepEqual(args, ["--", "@prompt file.md"]);
	assert.deepEqual(parsed.fileArgs, ["prompt file.md"]);
	assert.deepEqual(parsed.messages, []);
});

for (const terminalPath of ["/usr/bin:/bin", ""]) {
	test(`shell command: preserve caller PATH and quoted patch arguments with terminal PATH=${JSON.stringify(terminalPath)}`, (t) => {
		const args = [
			"patch", "/tmp/review's $HOME $(printf wrong) `printf wrong`; patch",
			"--agent-context", "/tmp/context with\nnewline.json", "--agent-notes",
		];
		const captured = captureCommand(t, (cwd) => buildShellCommand(cwd,
			`cmux-test-tool ${args.map(shellEscape).join(" ")}`), terminalPath);
		assert.deepEqual(captured.args, args);
	});
}

test("shell command: preserve expansions, pipes, redirection, and command chaining", (t) => {
	const captured = captureCommand(t, (cwd) => buildShellCommand(cwd,
		`printf 'piped value\\n' | { read -r value; cmux-test-tool "$value" "$(printf substitution)" "$PWD" *.txt; } > capture.json && /bin/cat capture.json`));
	assert.deepEqual(captured.args, ["piped value", "substitution", captured.cwd, "glob.txt"]);
});

for (const callerPath of ["", undefined]) {
	test(`shell command: handle ${callerPath === "" ? "empty" : "unset"} caller PATH without looking up sh`, () => {
		const command = withPath(callerPath, () => buildShellCommand(process.cwd(), 'printf "%s" "$PATH"'));
		const result = spawnSync("/bin/sh", ["-c", command], {
			encoding: "utf8",
			timeout: 10_000,
			env: { PATH: "/cmux-test-terminal-path" },
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, callerPath ?? "/cmux-test-terminal-path");
	});
}

test("shell command: preserve the command exit status", () => {
	const result = spawnSync("/bin/sh", ["-c", buildShellCommand(process.cwd(), "exit 23")], {
		timeout: 10_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 23);
});
