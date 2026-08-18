import assert from "node:assert/strict";
import test from "node:test";
import askModeExtension from "../extensions/ask-mode.ts";

const ASK_TOOLS = ["read", "bash", "grep", "find", "ls", "subagent"];
const HOST_TOOLS = [...ASK_TOOLS, "edit", "write"].map((name) => ({
	name,
	description: `${name} tool`,
	parameters: {},
	promptGuidelines: undefined,
	sourceInfo: { source: "builtin" },
}));


function createExtensionHarness() {
	let activeTools = ["read", "bash", "edit"];
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const notifications: string[] = [];

	const pi = {
		getAllTools: () => HOST_TOOLS,
		getActiveTools: () => activeTools,
		setActiveTools: async (tools: string[]) => {
			await Promise.resolve();
			activeTools = [...tools];
		},
		registerFlag: () => {},
		registerCommand: (_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			command = options.handler;
		},
		appendEntry: () => {},
		on: () => {},
		getFlag: () => false,
	};

	askModeExtension(pi as never);

	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: { getBranch: () => [] },
	};

	assert.ok(command);
	return { command, ctx, getActiveTools: () => activeTools, notifications };
}

test("/ask enables allowlisted ToolInfo records returned by the host", async () => {
	const harness = createExtensionHarness();

	await harness.command("on", harness.ctx);

	assert.deepEqual(harness.getActiveTools(), ASK_TOOLS);
	assert.equal(harness.notifications[0], "Ask mode enabled. Allowlisted tools: read, bash, grep, find, ls, subagent");
});

test("/ask off restores the tools that were active before enabling", async () => {
	const harness = createExtensionHarness();

	await harness.command("on", harness.ctx);
	await harness.command("off", harness.ctx);

	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit"]);
});
