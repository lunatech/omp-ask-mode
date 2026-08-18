import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";

const BASH_PARSER = new Parser();
BASH_PARSER.setLanguage(Bash);

export const ASK_MODE_TOOL_ALLOWLIST = [
	"read",
	"bash",
	"grep",
	"find",
	"ls",
	"subagent",
] as const;

type CommandPolicy = (args: readonly string[]) => boolean;

const SIMPLE_READ_ONLY_COMMANDS = [
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"fd",
	"ls",
	"tree",
	"pwd",
	"wc",
	"sort",
	"uniq",
	"diff",
	"file",
	"stat",
	"du",
	"df",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"whoami",
	"id",
	"date",
	"cal",
	"uptime",
	"ps",
	"jq",
	"bat",
	"help",
	"man",
] as const;

const READ_ONLY_GIT_SUBCOMMANDS = [
	"status",
	"log",
	"diff",
	"show",
	"grep",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"describe",
] as const;

const READ_ONLY_NPM_SUBCOMMANDS = ["list", "ls", "view", "info", "search", "outdated"] as const;
const READ_ONLY_YARN_SUBCOMMANDS = ["list", "info", "why"] as const;
const READ_ONLY_PNPM_SUBCOMMANDS = ["list", "why"] as const;
const FORBIDDEN_WRITE_OPTIONS = [
	"--output",
	"-o",
	"--output-document",
	"--output-document=-",
	"--upload-file",
	"-T",
	"--data",
	"--data-raw",
	"--data-binary",
	"-d",
	"--form",
	"-F",
	"--post-data",
	"--body-data",
	"--method=POST",
	"--method=PUT",
	"--method=PATCH",
	"--method=DELETE",
] as const;

function hasForbiddenWriteOption(args: readonly string[]): boolean {
	return args.some((arg) => FORBIDDEN_WRITE_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`)));
}

function allowsSimpleReadOnlyCommand(args: readonly string[]): boolean {
	return !hasForbiddenWriteOption(args);
}

function allowsFind(args: readonly string[]): boolean {
	const forbiddenPredicates = [
		"-delete",
		"-exec",
		"-execdir",
		"-fls",
		"-fprint",
		"-fprint0",
		"-fprintf",
		"-ok",
		"-okdir",
	];
	return !args.some((arg) => forbiddenPredicates.some((predicate) => arg === predicate || arg.startsWith(`${predicate}=`)));
}

function allowsAwk(args: readonly string[]): boolean {
	if (hasForbiddenWriteOption(args)) return false;
	return !args.some((arg) => /\b(?:system|getline)\b|[|>]/i.test(arg));
}

function allowsSed(args: readonly string[]): boolean {
	if (!args.some((arg) => arg === "-n" || arg.startsWith("-n"))) return false;
	if (hasForbiddenWriteOption(args)) return false;
	return !args.some((arg) => /(?:^|[;\s])(?:e|w|W)(?:\s|$)|--in-place(?:=|$)|^-i(?:$|[^-])/i.test(arg));
}

function allowsCurl(args: readonly string[]): boolean {
	if (args.length === 0 || hasForbiddenWriteOption(args)) return false;
	if (args.some((arg) => arg === "--config" || arg === "-K" || arg === "--remote-name" || arg === "-O")) return false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-X" || arg === "--request") {
			const method = args[index + 1]?.toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
			index++;
			continue;
		}
		if (/^(?:-X|--request)=/i.test(arg) && !/=(?:GET|HEAD)$/i.test(arg)) return false;
	}
	return true;
}

function allowsWget(args: readonly string[]): boolean {
	if (args.length < 2 || hasForbiddenWriteOption(args)) return false;
	const outputIndex = args.findIndex((arg) => arg === "-O" || arg === "--output-document");
	return outputIndex >= 0 && args[outputIndex + 1] === "-";
}

function allowsGit(args: readonly string[]): boolean {
	const [subcommand, ...subcommandArgs] = args;
	if (!subcommand) return false;
	if ((READ_ONLY_GIT_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
		return !hasForbiddenWriteOption(subcommandArgs) && !subcommandArgs.includes("--ext-diff");
	}
	if (subcommand === "config") {
		return subcommandArgs[0] === "--get" || subcommandArgs[0] === "--get-all";
	}
	if (subcommand === "branch") {
		return subcommandArgs.length === 0 || subcommandArgs.every((arg) =>
			["--show-current", "-a", "-r", "--all", "--remotes", "--list"].includes(arg) ||
			/^(?:--contains|--no-contains|--merged|--no-merged|--points-at|--format|--sort)(?:=|$)/.test(arg),
		);
	}
	if (subcommand === "remote") {
		return (
			subcommandArgs.length === 0 ||
			(subcommandArgs.length === 1 && subcommandArgs[0] === "-v") ||
			(subcommandArgs[0] === "show" && subcommandArgs.length >= 2) ||
			(subcommandArgs[0] === "get-url" && subcommandArgs.length >= 2)
		);
	}
	return false;
}

function allowsPackageManagerQuery(args: readonly string[], allowedSubcommands: readonly string[]): boolean {
	return args.length > 0 && allowedSubcommands.includes(args[0]) && !hasForbiddenWriteOption(args.slice(1));
}

interface BashNode {
	type: string;
	text: string;
	namedChildren: BashNode[];
	namedChildCount: number;
	hasError: boolean;
	fieldNameForNamedChild(index: number): string | null;
}

function getShellArgumentText(node: BashNode): string | null {
	if (node.type === "word") return node.text;
	if (node.type === "string") {
		if (node.namedChildren.some((child) => child.type !== "string_content")) return null;
		return node.text.length >= 2 ? node.text.slice(1, -1) : null;
	}
	if (node.type === "raw_string") return node.text.length >= 2 ? node.text.slice(1, -1) : null;
	return null;
}

function parseAllowlistedSimpleCommand(command: string): { program: string; args: string[] } | null {
	const tree = BASH_PARSER.parse(command);
	const root = tree.rootNode as unknown as BashNode;
	if (root.hasError || root.namedChildren.length !== 1) return null;

	const statement = root.namedChildren[0];
	if (statement.type !== "command") return null;

	let program: string | null = null;
	const args: string[] = [];
	for (let index = 0; index < statement.namedChildCount; index++) {
		const child = statement.namedChildren[index];
		const field = statement.fieldNameForNamedChild(index);
		if (field === "name") {
			if (program !== null || child.type !== "command_name" || child.namedChildCount !== 1) return null;
			const commandWord = child.namedChildren[0];
			if (commandWord.type !== "word") return null;
			program = commandWord.text;
			continue;
		}
		if (field !== "argument") return null;
		const argument = getShellArgumentText(child);
		if (argument === null) return null;
		args.push(argument);
	}

	if (program === null || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(program)) return null;
	return { program, args };
}

const COMMAND_POLICIES: Record<string, CommandPolicy> = Object.fromEntries(
	SIMPLE_READ_ONLY_COMMANDS.map((command) => [command, allowsSimpleReadOnlyCommand]),
) as Record<string, CommandPolicy>;
COMMAND_POLICIES.find = allowsFind;
COMMAND_POLICIES.awk = allowsAwk;
COMMAND_POLICIES.sed = allowsSed;
COMMAND_POLICIES.curl = allowsCurl;
COMMAND_POLICIES.wget = allowsWget;
COMMAND_POLICIES.git = allowsGit;
COMMAND_POLICIES.npm = (args) => allowsPackageManagerQuery(args, READ_ONLY_NPM_SUBCOMMANDS);
COMMAND_POLICIES.yarn = (args) => allowsPackageManagerQuery(args, READ_ONLY_YARN_SUBCOMMANDS);
COMMAND_POLICIES.pnpm = (args) => allowsPackageManagerQuery(args, READ_ONLY_PNPM_SUBCOMMANDS);
COMMAND_POLICIES.node = (args) => args.length === 1 && ["--version", "-v"].includes(args[0]);
COMMAND_POLICIES.python = COMMAND_POLICIES.node;
COMMAND_POLICIES.python3 = COMMAND_POLICIES.node;


export function isAskModeToolAllowed(toolName: string): boolean {
	return (ASK_MODE_TOOL_ALLOWLIST as readonly string[]).includes(toolName);
}

export function isSafeCommand(command: string): boolean {
	const parsed = parseAllowlistedSimpleCommand(command.trim());
	if (parsed === null) return false;
	const policy = COMMAND_POLICIES[parsed.program];
	return policy !== undefined && policy(parsed.args);
}
