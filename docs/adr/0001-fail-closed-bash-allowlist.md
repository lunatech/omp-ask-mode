# Fail closed for ask-mode bash commands

Ask-mode bash first parses input with the Tree-sitter Bash grammar and rejects parse errors or compound syntax, then applies a strict command and subcommand allowlist. Unknown commands are rejected because denylist matching can miss new tools, aliases, wrappers, and equivalent mutation forms; Tree-sitter handles shell structure while the allowlist handles command semantics.
