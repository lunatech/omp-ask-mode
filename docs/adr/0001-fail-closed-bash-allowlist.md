# Fail closed for ask-mode bash commands

Ask-mode bash now uses a strict command and subcommand allowlist instead of relying on a denylist of destructive patterns. Unknown commands and unsupported shell syntax are rejected because denylist matching can miss new tools, aliases, wrappers, and equivalent mutation forms; the trade-off is that legitimate investigative commands must be added explicitly.
