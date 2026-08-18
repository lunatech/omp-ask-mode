import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	ASK_MODE_TOOL_ALLOWLIST,
	isAskModeToolAllowed,
	isSafeCommand,
} from "./utils.js";

const DEFAULT_RESTORE_TOOL_ORDER = ["read", "bash", "edit", "write"] as const;
const READ_ONLY_SUBAGENT_PREFIX =
	"READ-ONLY TASK ONLY. Gather context, inspect, search, summarize, or analyze. Do NOT edit files, write files, install packages, commit changes, or make any other mutations.\n\n";
const READ_ONLY_SUBAGENT_VERBS =
	/\b(read|review|inspect|investigate|analy[sz]e|summari[sz]e|gather|context|explore|search|look|understand|audit|trace|compare|check|explain|report)\b/i;
const MUTATING_SUBAGENT_VERBS =
	/\b(edit|write|rewrite|modify|change|implement|fix|refactor|create|delete|remove|rename|move|apply|patch|update|upgrade|downgrade|install|commit|push|merge|rebase|reset|checkout|switch|format|lint|build|deploy|migrate)\b/i;
const ASK_MODE_STATE = "ask-mode-state";
const ASK_MODE_CONTEXT = "ask-mode-context";

type InterruptedMode = "plan" | null;

interface AskModeState {
	enabled: boolean;
	previousActiveTools?: string[];
	interruptedMode?: InterruptedMode;
}

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const leftSorted = [...left].sort();
	const rightSorted = [...right].sort();
	return leftSorted.every((tool, index) => tool === rightSorted[index]);
}

function getLatestCustomData<T>(ctx: ExtensionContext, customType: string): T | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: T };
		if (entry.type === "custom" && entry.customType === customType) return entry.data;
	}
	return undefined;
}

function getAvailableToolNames(pi: ExtensionAPI): Set<string> {
	return new Set(pi.getAllTools().map((tool) => tool.name));
}

function getAskModeTools(pi: ExtensionAPI): string[] {
	const available = getAvailableToolNames(pi);
	return ASK_MODE_TOOL_ALLOWLIST.filter((tool) => available.has(tool));
}

function getFallbackRestoreTools(pi: ExtensionAPI): string[] {
	const available = getAvailableToolNames(pi);
	const fallback = DEFAULT_RESTORE_TOOL_ORDER.filter((tool) => available.has(tool));
	if (fallback.length > 0) return fallback;

	const activeTools = pi.getActiveTools().filter((tool) => available.has(tool));
	return activeTools.length > 0 ? activeTools : [...DEFAULT_RESTORE_TOOL_ORDER];
}

function resolveRestoreTools(pi: ExtensionAPI, preferredTools?: readonly string[]): string[] {
	if (preferredTools && preferredTools.length > 0) {
		const available = getAvailableToolNames(pi);
		const restored = preferredTools.filter((tool) => available.has(tool));
		if (restored.length > 0) return restored;
	}
	return getFallbackRestoreTools(pi);
}

function collectSubagentTasks(input: unknown): string[] {
	const candidate = input as {
		task?: unknown;
		tasks?: Array<{ task?: unknown }>;
		chain?: Array<{ task?: unknown; parallel?: Array<{ task?: unknown }> }>;
	};
	const tasks: string[] = [];

	if (typeof candidate.task === "string") tasks.push(candidate.task);
	if (Array.isArray(candidate.tasks)) {
		for (const item of candidate.tasks) {
			if (typeof item?.task === "string") tasks.push(item.task);
		}
	}
	if (Array.isArray(candidate.chain)) {
		for (const step of candidate.chain) {
			if (typeof step?.task === "string") tasks.push(step.task);
			if (Array.isArray(step?.parallel)) {
				for (const item of step.parallel) {
					if (typeof item?.task === "string") tasks.push(item.task);
				}
			}
		}
	}
	return tasks;
}

function isReadOnlySubagentTask(task: string): boolean {
	const normalized = task.trim();
	return normalized.length > 0 && !MUTATING_SUBAGENT_VERBS.test(normalized) && READ_ONLY_SUBAGENT_VERBS.test(normalized);
}

function prefixReadOnlySubagentTask(task: string): string {
	return task.startsWith(READ_ONLY_SUBAGENT_PREFIX) ? task : `${READ_ONLY_SUBAGENT_PREFIX}${task}`;
}

function enforceReadOnlySubagentInput(input: unknown): { ok: boolean; reason?: string } {
	const candidate = input as {
		action?: unknown;
		worktree?: unknown;
		output?: unknown;
		task?: unknown;
		tasks?: Array<{ task?: unknown }>;
		chain?: Array<{ task?: unknown; parallel?: Array<{ task?: unknown }> }>;
	};

	if (typeof candidate.action === "string") {
		return candidate.action === "list" || candidate.action === "get"
			? { ok: true }
			: {
					ok: false,
					reason: `Ask mode only allows read-only subagent usage. Management action \"${candidate.action}\" is blocked.`,
			  };
	}
	if (candidate.worktree === true) {
		return { ok: false, reason: "Ask mode blocks subagent worktrees because they mutate git state." };
	}
	if (typeof candidate.output === "string" && candidate.output.trim().length > 0) {
		return { ok: false, reason: "Ask mode blocks subagent output files. Keep subagent work read-only and in-memory." };
	}

	const tasks = collectSubagentTasks(input);
	if (tasks.length === 0 || tasks.some((task) => !isReadOnlySubagentTask(task))) {
		return {
			ok: false,
			reason:
				"Ask mode only allows subagents for read-only context gathering. Rephrase the subagent task as inspection, search, analysis, or summarization only.",
		};
	}

	if (typeof candidate.task === "string") candidate.task = prefixReadOnlySubagentTask(candidate.task);
	if (Array.isArray(candidate.tasks)) {
		for (const item of candidate.tasks) {
			if (typeof item?.task === "string") item.task = prefixReadOnlySubagentTask(item.task);
		}
	}
	if (Array.isArray(candidate.chain)) {
		for (const step of candidate.chain) {
			if (typeof step?.task === "string") step.task = prefixReadOnlySubagentTask(step.task);
			if (Array.isArray(step?.parallel)) {
				for (const item of step.parallel) {
					if (typeof item?.task === "string") item.task = prefixReadOnlySubagentTask(item.task);
				}
			}
		}
	}
	return { ok: true };
}

export default function askModeExtension(pi: ExtensionAPI): void {
	let askModeEnabled = false;
	let previousActiveTools: string[] | undefined;
	let interruptedMode: InterruptedMode = null;

	function persistState(): void {
		pi.appendEntry<AskModeState>(ASK_MODE_STATE, {
			enabled: askModeEnabled,
			previousActiveTools,
			interruptedMode,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("ask-mode", askModeEnabled ? ctx.ui.theme.fg("accent", "ask") : undefined);
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		const wasAskEnabled = askModeEnabled;
		const oldPreviousActiveTools = previousActiveTools;
		const oldInterruptedMode = interruptedMode;
		const oldAskTools = getAskModeTools(pi);
		const currentActiveTools = pi.getActiveTools();
		const saved = getLatestCustomData<AskModeState>(ctx, ASK_MODE_STATE);

		askModeEnabled = saved?.enabled ?? false;
		previousActiveTools = saved?.previousActiveTools;
		interruptedMode = saved?.interruptedMode ?? null;

		if (pi.getFlag("ask") === true) {
			if (!askModeEnabled && !sameToolSet(currentActiveTools, oldAskTools) && currentActiveTools.length > 0) {
				previousActiveTools = [...currentActiveTools];
				interruptedMode = null;
			}
			askModeEnabled = true;
		}

		const askTools = getAskModeTools(pi);
		if (askModeEnabled && askTools.length > 0) {
			pi.setActiveTools(askTools);
		} else if (wasAskEnabled && oldAskTools.length > 0 && sameToolSet(currentActiveTools, oldAskTools)) {
			const toolsToRestore = oldInterruptedMode === "plan" ? getFallbackRestoreTools(pi) : resolveRestoreTools(pi, oldPreviousActiveTools);
			pi.setActiveTools(toolsToRestore);
		}
		updateStatus(ctx);
	}

	function syncExternalModeState(ctx: ExtensionContext): void {
		if (!askModeEnabled) return;
		const askTools = getAskModeTools(pi);
		if (askTools.length > 0 && sameToolSet(pi.getActiveTools(), askTools)) return;

		askModeEnabled = false;
		previousActiveTools = undefined;
		interruptedMode = null;
		persistState();
		updateStatus(ctx);
	}

	async function enableAskMode(ctx: ExtensionCommandContext): Promise<void> {
		const askTools = getAskModeTools(pi);
		if (askTools.length === 0) {
			ctx.ui.notify("Ask mode could not be enabled because no allowlisted tools are available.", "error");
			return;
		}

		const currentActiveTools = pi.getActiveTools();
		askModeEnabled = true;
		previousActiveTools = [...currentActiveTools];
		interruptedMode = null;
		pi.setActiveTools(askTools);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(`Ask mode enabled. Allowlisted tools: ${askTools.join(", ")}`, "info");
	}

	function disableAskMode(ctx: ExtensionCommandContext): void {
		askModeEnabled = false;
		const toolsToRestore = interruptedMode === "plan" ? getFallbackRestoreTools(pi) : resolveRestoreTools(pi, previousActiveTools);
		previousActiveTools = undefined;
		interruptedMode = null;
		pi.setActiveTools(toolsToRestore);
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Ask mode disabled.", "info");
	}

	pi.registerFlag("ask", {
		description: "Start in ask mode (allowlisted read-only tools only)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("ask", {
		description: "Toggle ask mode (/ask on|off|status)",
		handler: async (args, ctx) => {
			syncExternalModeState(ctx);
			const action = (args ?? "").trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(askModeEnabled ? `Ask mode is ON. Allowlisted tools: ${getAskModeTools(pi).join(", ")}` : "Ask mode is OFF.", "info");
				return;
			}
			if (action === "on") {
				if (askModeEnabled) ctx.ui.notify("Ask mode is already enabled.", "info");
				else await enableAskMode(ctx);
				return;
			}
			if (action === "off") {
				if (askModeEnabled) disableAskMode(ctx);
				else ctx.ui.notify("Ask mode is already disabled.", "info");
				return;
			}
			if (askModeEnabled) disableAskMode(ctx);
			else await enableAskMode(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => restoreFromBranch(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreFromBranch(ctx));

	pi.on("context", async (event) => {
		if (askModeEnabled) return;
		return {
			messages: event.messages.filter((message) => (message as { customType?: string }).customType !== ASK_MODE_CONTEXT),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		syncExternalModeState(ctx);
		if (!askModeEnabled) return;
		return {
			message: {
				customType: ASK_MODE_CONTEXT,
				content: `[ASK MODE ACTIVE]\nYou are in ask mode: a read-only investigative mode.\n\nRules:\n- You may use only these allowlisted tools: ${getAskModeTools(pi).join(", ")}\n- Any tool not on the allowlist is blocked, even if another extension registers it\n- Ask the user directly in normal chat when you need clarification\n- Use bash only for read-only or investigative commands\n- If you use subagent, it must be only for read-only context gathering, inspection, search, analysis, or summarization\n- Do not modify files, install packages, commit changes, or run destructive commands`,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		syncExternalModeState(ctx);
		if (!askModeEnabled) return;

		if (!isAskModeToolAllowed(event.toolName)) {
			return {
				block: true,
				reason: `Ask mode allows only these tools: ${ASK_MODE_TOOL_ALLOWLIST.join(", ")}. The ${event.toolName} tool is not allowlisted.`,
			};
		}
		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Ask mode only allows read-only investigative bash commands. Use read, grep, find, ls, or a read-only shell command instead.\nCommand: ${command}`,
				};
			}
		}
		if (event.toolName === "subagent") {
			const result = enforceReadOnlySubagentInput(event.input);
			if (!result.ok) return { block: true, reason: result.reason };
		}
	});
}
