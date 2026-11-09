"""Explicit sealed-host READ capability in the canonical workflow preflight.

All GitHub reads are fixture responses, never tokens or live mutations.
Legacy direct-gh semantics and the output schema must remain unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "scripts/claude-gpt"))
sys.path.insert(0, str(_REPO_ROOT / ".claude/skills/issue-refinement-loop/scripts"))
import workflow_capability_preflight as preflight  # noqa: E402
import root_entry_router as router  # noqa: E402

REPO = "squne121/loop-protocol"
GOOD_MAIN = "a" * 40


def _ok(stdout=""):
    return preflight.ProbeOutcome(
        preflight.PROBE_COMPLETED,
        stdout=stdout,
        returncode=0,
    )


def _assess(**changes):
    params = {
        "project_root": str(_REPO_ROOT),
        "profile": "issue-to-impl",
        "repo": REPO,
        "spark_mode": None,
        "spark_fallback": None,
        "planned_operations": [],
        "github_transport": "sealed-host-read",
    }
    params.update(changes)
    return preflight.assess(**params)


@pytest.fixture
def sealed_reads(monkeypatch):
    calls = []

    monkeypatch.setattr(
        preflight.trusted_uv_mod,
        "check_trusted_uv",
        lambda _: {"status": "ok", "reason": "resolved", "diagnostic": None},
    )

    def check(name, argv, **kwargs):
        calls.append((name, argv, kwargs))
        if name == "sealed_host_repository_identity":
            return _ok(REPO + "\n")
        if name == "sealed_host_main_ref":
            return _ok(json.dumps({"ref": "refs/heads/main", "object": {"sha": GOOD_MAIN}}))
        raise AssertionError("unapproved probe: " + name)

    monkeypatch.setattr(preflight, "_run_probe_with_deadline", check)
    monkeypatch.setattr(
        preflight,
        "_github_auth_probe",
        lambda *_: pytest.fail("sealed mode must never call gh auth status"),
    )
    monkeypatch.setattr(
        preflight,
        "_controlled_github_read_probe",
        lambda *_: pytest.fail("sealed mode must not use native direct GitHub auth"),
    )
    return calls


def test_tokenless_sealed_mode_degraded_not_authentication(sealed_reads):
    observed = _assess()
    assert observed["decision"] == "degraded"
    assert observed["checks"]["github"] == {
        "auth": False,
        "repo_read": True,
        "operations": {},
    }
    assert observed["actor_capabilities"]["root_github_read"]["status"] == "degraded"
    assert observed["actor_capabilities"]["controlled_github_read"]["status"] == "unavailable"
    assert observed["actor_capabilities"]["controlled_github_read"]["fallback_route"] is None
    assert "sealed_host_read_only_no_docker_auth" in observed["reasons"]
    assert len(sealed_reads) == 2
    assert sealed_reads[0][1] == [
        "gh",
        "repo",
        "view",
        REPO,
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
    ]
    assert sealed_reads[1][1] == [
        "gh",
        "api",
        "--method",
        "GET",
        f"repos/{REPO}/git/refs/heads/main",
    ]
    for _, _, kwargs in sealed_reads:
        env = kwargs["env"]
        assert env["HOME"] == "/nonexistent"
        for key in ("GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "LD_PRELOAD", "PYTHONPATH"):
            assert key not in env


@pytest.mark.parametrize(
    "operation",
    [
        "issue_comment",
        "pr_create",
        "pr_edit",
        "pr_update_branch",
        "issue_edit",
        "fake_write",
        "graphQL_arbitrary_route",
    ],
)
def test_mutation_or_unknown_route_denied_even_with_false_boolean(sealed_reads, operation):
    observation = _assess(
        planned_operations=[
            {
                "operation": operation,
                "phase": "implementation",
                "actor_role": "worker",
                "requires_mutation": False,
            }
        ]
    )
    assert observation["decision"] == "blocked"
    assert observation["checks"]["github"]["auth"] is False
    assert observation["checks"]["github"]["operations"][operation]["route"] == "unavailable"
    assert any(x.startswith("sealed_host_mutation_or_unknown_route:") for x in observation["reasons"])


def test_genuine_read_operation_only_is_observational(sealed_reads):
    observed = _assess(
        planned_operations=[
            {
                "operation": "issue_get",
                "phase": "current-run-contract-review",
                "actor_role": "root",
                "requires_mutation": False,
            }
        ]
    )
    assert observed["decision"] == "degraded"
    assert observed["checks"]["github"]["operations"]["issue_get"] == {
        "route": "sealed_host_read_only",
        "permission": "unverified",
    }
    assert observed["checks"]["github"]["auth"] is False


def test_read_op_misdeclared_as_mutation_is_denied(sealed_reads):
    value = _assess(
        planned_operations=[
            {
                "operation": "issue_get",
                "phase": "root",
                "actor_role": "root",
                "requires_mutation": True,
            }
        ]
    )
    assert value["decision"] == "blocked"


@pytest.mark.parametrize(
    "bad_json",
    [
        "not json",
        json.dumps({"ref": "refs/heads/dev", "object": {"sha": GOOD_MAIN}}),
        json.dumps({"ref": "refs/heads/main", "object": {"sha": "not-oid"}}),
        json.dumps({"ref": "refs/heads/main", "object": {}}),
    ],
)
def test_malformed_host_main_result_never_becomes_degraded(sealed_reads, monkeypatch, bad_json):
    def bad(name, argv, **kwargs):
        if name == "sealed_host_repository_identity":
            return _ok(REPO)
        return _ok(bad_json)

    monkeypatch.setattr(preflight, "_run_probe_with_deadline", bad)
    value = _assess()
    assert value["decision"] == "blocked"
    assert value["checks"]["github"]["repo_read"] is False


def test_foreign_repo_never_calls_host_socket(sealed_reads, monkeypatch):
    invoked = []
    monkeypatch.setattr(preflight, "_run_probe_with_deadline", lambda *args, **kw: invoked.append(args))
    value = _assess(repo="other/repo")
    assert value["decision"] == "blocked"
    assert invoked == []


def test_missing_trusted_uv_keeps_sealed_transport_blocked(sealed_reads, monkeypatch):
    monkeypatch.setattr(
        preflight.trusted_uv_mod,
        "check_trusted_uv",
        lambda _: {"status": "trusted_uv_missing", "reason": "uv_not_found"},
    )
    value = _assess()
    assert value["decision"] == "blocked"
    assert value["checks"]["uv"]["status"] == "trusted_uv_missing"


def test_output_schema_remains_unmodified_in_sealed_mode(sealed_reads):
    value = _assess()
    assert set(value) == {
        "schema",
        "profile",
        "decision",
        "checks",
        "actor_capabilities",
        "reasons",
    }
    assert set(value["actor_capabilities"]) == {
        "root_github_read",
        "controlled_github_read",
        "delegated_research_agy",
        "spark_delegation",
    }
    assert set(value["checks"]) == {"uv", "spark", "github"}


def test_root_bridge_explicitly_forwards_mode_without_replay_token(monkeypatch):
    observed = []
    preflight_result = json.dumps(
        {
            "schema": "CLAUDE_GPT_WORKFLOW_CAPABILITIES_V1",
            "decision": "degraded",
            "checks": {},
            "actor_capabilities": {},
            "reasons": [],
        }
    )

    def fake_run(argv, **kw):
        observed.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=preflight_result, stderr="")

    monkeypatch.setattr(router.subprocess, "run", fake_run)
    result = router.capability_preflight_result(
        REPO,
        github_transport="sealed-host-read",
    )
    assert result["decision"] == "degraded"
    assert observed[0][-2:] == ["--github-transport", "sealed-host-read"]
    assert "--github-transport" not in router.capability_preflight_result(REPO).get("reasons", [])
    assert len(observed) == 2
    assert "--github-transport" not in observed[1]


@pytest.mark.github_live
def test_live_external_subprocess_sealed_read_bridge_and_auth_denied():
    """AC6 independent live evidence: real subprocesses, no monkeypatching.

    Runs the canonical preflight as an external process against the tokenless
    WSL GH read bridge, then confirms the external read shim denies
    authentication-state subcommands (negative case, expressed as data only).
    """
    gh = shutil.which("gh")
    if gh is None:
        pytest.skip("external gh read shim not present on PATH")

    preflight_run = subprocess.run(
        [
            sys.executable,
            str(_REPO_ROOT / "scripts/claude-gpt/workflow_capability_preflight.py"),
            "--profile",
            "issue-to-impl",
            "--repo",
            REPO,
            "--github-transport",
            "sealed-host-read",
        ],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert preflight_run.returncode == 0, preflight_run.stderr
    observed = json.loads(preflight_run.stdout)
    assert observed["decision"] == "degraded"
    assert observed["checks"]["uv"]["status"] == "ok"
    assert observed["checks"]["github"]["auth"] is False
    assert observed["checks"]["github"]["repo_read"] is True
    assert observed["actor_capabilities"]["controlled_github_read"]["status"] == "unavailable"
    assert "sealed_host_read_only_no_docker_auth" in observed["reasons"]

    # Independent read of repo/main SHA through the same external shim.
    main_ref = subprocess.run(
        [gh, "api", "--method", "GET", f"repos/{REPO}/git/refs/heads/main"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert main_ref.returncode == 0, main_ref.stderr
    payload = json.loads(main_ref.stdout)
    assert payload["ref"] == "refs/heads/main"
    assert re.fullmatch(r"[a-f0-9]{40}", payload["object"]["sha"])

    # Negative cases: auth-state subcommands must be rejected by the shim.
    denied_commands = [["gh", "auth", "status"]]
    for argv in denied_commands:
        denied = subprocess.run(
            [gh, *argv[1:]],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert denied.returncode != 0
        assert denied.stderr.strip() != ""


def test_unsupported_transport_fails_before_producer_call(monkeypatch):
    monkeypatch.setattr(
        router.subprocess,
        "run",
        lambda *_a, **_k: pytest.fail("should never call subprocess"),
    )
    result = router.capability_preflight_result(
        REPO,
        github_transport="unexpected-provider",
    )
    assert result["decision"] == "blocked"
    assert "unsupported_github_transport" in result["reasons"]
