---
description: Automatic pull-request-style review of the new implementation (all analysis types, in parallel)
agent: build
---

# Automatic review of the new implementation

You are the orchestrator of the automatic review system. Goal: review the new implementation of the current project, launching **all** analysis types in parallel and consolidating a single report.

## Step 1 — Detect the base branch

- If the user provided a base branch as an argument (`$ARGUMENTS`), use it.
- Otherwise, detect it automatically: check in order `origin/main`, `main`, `master` (use `git show-ref` / `git branch -a` / `git remote`). Do not assume — confirm it exists.

## Step 2 — Compute the review scope

The scope is the set of files that make up the new implementation. Compute it by combining **all** sources of change:

- Committed changes against the base: `git diff --stat <base>...HEAD`
- Staged changes: `git diff --cached --stat`
- Unstaged changes: `git diff --stat`
- Untracked files: `git ls-files --others --exclude-standard`

Merge them into a single deduplicated list of file paths. This list is the **authoritative scope** of the review.

**Important**: if the combined scope is empty (no changes of any kind), report `No changes to review` and stop — do **not** review the whole application.

## Step 3 — Detect the project environment

- Identify the stack by reading the configuration files present at the **project root only** (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `requirements*.txt`, `mix.exs`, etc.) and the top-level directory structure.
- **Ignore** tooling/vendor directories when detecting the stack: `.opencode/`, `node_modules/`, `.venv/`, `vendor/`, cache dirs (`.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `__pycache__/`, `dist/`, `build/`). Files in those directories are **never** part of the project stack.
- Discover the available verification tools (lint, typecheck, test, build, format) by reading the `Makefile`, `AGENTS.md`, README, `package.json` scripts, tooling sections, `.pre-commit-config.yaml`, etc.
- **Do not assume** commands: use only the ones that actually exist in the project.

## Step 4 — Run automatic checks (only the orchestrator, and only the FAST ones)

- Run **only fast checks** detected in Step 3 (lint, typecheck, format/build), with a `timeout` so nothing hangs (e.g. `timeout 90 npm run lint`, `timeout 120 uv run mypy app`).
- **Never** run install/sync commands (`npm install`, `npm ci`, `bun install`, `pip install`, `uv sync`, `poetry install`, `go mod download`, etc.) — installing dependencies is not part of a review and can modify the workspace. If a check requires an install first, **skip it** and note it in the report.
- **Tests**: **do not run** suites that require external infrastructure (Docker, Testcontainers, real DBs, external services) nor suites that are clearly slow. Evaluate the command before running it; if it is heavy, **skip it** and note it in the report. Only run a suite if it is light and clearly fast (e.g. simple unit tests, no containers), with `timeout 120`.
- Capture the output (success/failure, error list) to pass it to the relevant subagents.
- Do not let subagents run commands: they are read-only.

## Step 5 — Dispatch all subagents in parallel

Launch **all** the subagents below **in the same response**, one `task` call for each (in parallel, never sequential). For each one, provide:
- The detected base branch.
- The **authoritative scope** (the deduplicated file list from Step 2). Instruct each subagent to review **only** these files and never the rest of the codebase.
- The stack and tools already detected in Step 3 (so they do **not** rediscover them).
- The relevant check output (lint/typecheck → `review-quality`; tests → `review-tests`).

Mandatory subagents:

1. `review-security`
2. `review-performance`
3. `review-correctness`
4. `review-quality` (pass the lint/typecheck output)
5. `review-tests`
6. `review-compat`

## Step 6 — Consolidate the final report

When all subagents respond, consolidate **a single report** in the chat, written like a **pull request review**:

- **Verdict**: `Approve` or `Request changes`, based on the critical/high findings.
- **Summary**: brief overall state of the implementation (1-2 sentences).
- **Section per review type** (one per subagent), with its findings.
- Each finding must keep `file:line`, severity (critical/high/medium/low) and suggestion.
- **Prioritized list of must-fix issues**: ordered by severity, grouping duplicates across analyses (like blocking PR comments).

## Efficiency (IMPORTANT)

- **Everything in parallel**: subagents are launched in the same response, never sequential.
- Do not run heavy checks (tests with Docker/containers, long suites). Skip them and document it.
- Use `timeout` on every command you run.
- If the review is taking too long, prioritize finishing and consolidating with what you have, instead of iterating indefinitely.