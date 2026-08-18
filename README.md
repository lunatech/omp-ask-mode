# pi-ask-mode-allowlist

An [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that adds a read-only ask mode.

Ask mode replaces the active tool set with a fixed allowlist:

- `read`
- `bash`
- `grep`
- `find`
- `ls`
- `subagent`

The extension also blocks non-allowlisted tool calls defensively. This includes tools registered by other extensions.

## Install with oh-my-pi

From a checkout of oh-my-pi, link this local package into the plugin set:

```sh
omp install /path/to/omp-ask-mode
```

When running oh-my-pi from source, use the source CLI instead:

```sh
cd /path/to/oh-my-pi
bun packages/coding-agent/src/cli.ts install /path/to/omp-ask-mode
```

The package manifest points oh-my-pi at `extensions/ask-mode.ts`.

## Install from GitHub

Install the repository directly through oh-my-pi's plugin manager:

```sh
omp install github:lunatech/omp-ask-mode
```

The equivalent explicit command is:

```sh
omp plugin install github:lunatech/omp-ask-mode
```

When running oh-my-pi from its source checkout:

```sh
cd /path/to/oh-my-pi
bun packages/coding-agent/src/cli.ts install github:lunatech/omp-ask-mode
```

To install a branch or tag, append `#<ref>`:

```sh
omp install github:lunatech/omp-ask-mode#main
```

oh-my-pi reads the package manifest and loads `extensions/ask-mode.ts`. Verify the plugin is installed with:

```sh
omp plugin list
```

## Load without installing

Load the extension for one session with `--extension` (or `-e`):

```sh
cd /path/to/oh-my-pi
bun packages/coding-agent/src/cli.ts \
  --extension /path/to/omp-ask-mode
```

You can also load the extension directly from the oh-my-pi source tree while starting in ask mode:

```sh
cd /path/to/oh-my-pi
bun packages/coding-agent/src/cli.ts \
  --ask \
  --extension /path/to/omp-ask-mode
```

To load it for every session, add the package directory to your oh-my-pi config:

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /path/to/omp-ask-mode
```

For a project-only installation, put the same setting in `.omp/config.yml` in that project.

## Use ask mode

Toggle it during a session:

```text
/ask

```

Or use an explicit action:

```text
/ask on
/ask off
/ask status
```

Start directly in ask mode with the `--ask` flag:

```sh
omp --ask
```

When ask mode is turned off, the tool set active before ask mode was enabled is restored.

## Safety behavior

Ask mode applies three checks:

1. The active tool list contains only available tools from the fixed allowlist.
2. Every tool call is rejected unless its name is on that allowlist.
3. `bash` and `subagent` inputs receive additional read-only checks.

Bash uses a fail-closed command allowlist. It accepts explicitly approved read-only commands and subcommands such as `git diff`, `grep`, `find`, `npm list`, `curl` GET requests, and `wget -O -` fetches. Unknown commands and unsupported forms are rejected.

The parsed command must be one simple command. Pipelines, command chaining, background jobs, redirects, heredocs, command substitution, subshells, wrappers, and environment assignments are rejected. Command-specific checks also reject write-capable options such as `git --ext-diff`, `curl --data`, `curl -o`, `find -exec`, `sed -i`, and `awk system(...)`.
Before applying the command allowlist, bash input is parsed with the Tree-sitter Bash grammar. Parse errors and ASTs containing multiple commands, pipelines, redirects, substitutions, subshells, loops, or other compound syntax are rejected. This avoids trying to reproduce shell parsing with a tokenizer.

Subagents may inspect, search, analyze, compare, explain, or summarize. Worktrees, output files, mutating tasks, and mutating management actions are blocked.

This is an extension-level policy, not an operating-system sandbox. Run oh-my-pi inside a container, VM, or other restricted environment when stronger isolation is required.

## Test

Run the package tests from this directory:

```sh
npm test
```
