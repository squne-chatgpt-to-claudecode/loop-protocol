#!/usr/bin/env bash
# worktree_scope_guard.sh — thin wrapper that delegates to
# scripts/agent-guards/worktree_scope_guard.py (Issue #1657: relocated to the
# AI-agent-independent shared core, mirroring local_main_branch_guard.sh).
#
# The decision logic (WORKTREE_SCOPE_RESOLUTION_V1 / MUTATING_BASH_CLASSIFIER_V1,
# realpath/commonpath path containment, porcelain -z parsing) lives in the Python
# module under scripts/agent-guards/. This wrapper only locates the interpreter
# and execs the module; it must never re-implement or duplicate the decision
# logic itself.
#
# Exit codes are passed through from the Python module:
#   0  — allow (no output)
#   2  — block (bounded stderr)
set -euo pipefail

# No external dirname: PreToolUse runs with intentionally restricted PATH in
# the git-unavailable fail-closed test. Resolve our path using Bash builtins.
case "${BASH_SOURCE[0]}" in
    */*) SOURCE_DIR="${BASH_SOURCE[0]%/*}" ;;
    *) SOURCE_DIR="." ;;
esac
if ! SCRIPT_DIR="$(cd -- "${SOURCE_DIR}" && pwd)"; then
    printf '[worktree_scope_guard] blocked: script directory unavailable — fail closed\n' >&2
    exit 2
fi
if ! REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"; then
    printf '[worktree_scope_guard] blocked: repository root unavailable — fail closed\n' >&2
    exit 2
fi

GUARD_SCRIPT="${REPO_ROOT}/scripts/agent-guards/worktree_scope_guard.py"

if [ ! -f "${GUARD_SCRIPT}" ]; then
    # Fail-closed: guard script missing
    printf '[worktree_scope_guard] ERROR: guard script not found: %s\n' "${GUARD_SCRIPT}" >&2
    exit 2
fi

if command -v python3 >/dev/null 2>&1; then
    exec python3 "${GUARD_SCRIPT}"
fi

# python3 unavailable: fail closed for matched mutation tools.
echo "[worktree_scope_guard] blocked: python3 not found — fail closed" >&2
exit 2
