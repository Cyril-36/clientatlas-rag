# Agent Workflow

## Skills and Plugins

- Before starting any non-trivial task, inspect the available project skills, personal skills, plugin skills, MCP tools, and specialised agents.
- Select and use only the skills, plugins, tools, and agents that are relevant to the current step.
- Do not perform specialised work manually when an appropriate installed skill or plugin is available.
- Read the complete instructions of a relevant skill before using it.
- Match skills using their documented descriptions rather than their names alone.
- For multi-step tasks, reconsider the appropriate skills and tools at each major step instead of choosing them only once at the beginning.
- Do not invoke unnecessary skills merely because they are available.
- If an important capability is unavailable or disabled, state that clearly instead of pretending it was used.

## Execution Process

For substantial tasks:

1. Understand the request and inspect the relevant project files.
2. Identify the appropriate skills, plugins, tools, or specialised agents.
3. Create a concise implementation plan.
4. Implement the smallest correct change.
5. Run the relevant formatting, linting, type-checking, and tests.
6. Inspect the resulting diff for regressions, security issues, and unnecessary changes.
7. Summarise what changed, what was verified, and any remaining limitations.

## Quality Rules

- Follow the existing architecture and coding conventions.
- Prefer modifying existing abstractions over adding unnecessary new ones.
- Do not claim that a command, test, build, plugin, or skill was used unless it was actually executed successfully.
- Do not silently skip failing tests or validation.
- Preserve unrelated user changes.
- Never commit, push, deploy, delete data, or modify production systems unless explicitly requested.
