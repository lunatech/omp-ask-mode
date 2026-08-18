import assert from "node:assert/strict";
import test from "node:test";
import { ASK_MODE_TOOL_ALLOWLIST, isAskModeToolAllowed, isSafeCommand } from "../extensions/utils.ts";

test("ask mode exposes a fixed tool allowlist", () => {
	assert.deepEqual([...ASK_MODE_TOOL_ALLOWLIST], ["read", "bash", "grep", "find", "ls", "subagent"]);
	assert.equal(isAskModeToolAllowed("read"), true);
	assert.equal(isAskModeToolAllowed("edit"), false);
	assert.equal(isAskModeToolAllowed("question"), false);
	assert.equal(isAskModeToolAllowed("unknown-extension-tool"), false);
});

test("safe commands allow explicitly approved read-only forms", () => {
	for (const command of [
		"git diff",
		"git log --oneline",
		"grep -R ask .",
		"find . -type f",
		"find . -type f -print",
		"sed -n '1,20p' README.md",
		"awk '{print $1}' file.txt",
		"npm list",
		"curl https://example.com",
		"wget -O - https://example.com",
		"node --version",
	]) {
		assert.equal(isSafeCommand(command), true, command);
	}
});

test("unknown commands and unsupported shell syntax fail closed", () => {
	for (const command of [
		"rm -rf .",
		"echo ok",
		"python script.py",
		"git checkout main",
		"npm install",
		"curl -X POST https://example.com",
		"find . -exec rm {} \\",
		"awk '{system(\"rm -rf .\")}' file.txt",
		"sed -n '1p;w output.txt' file.txt",
		"git diff | cat",
		"git diff && echo done",
		"cat file.txt > output.txt",
		"cat $(printf file.txt)",
		"FOO=bar npm list",
	]) {
		assert.equal(isSafeCommand(command), false, command);
	}
});
