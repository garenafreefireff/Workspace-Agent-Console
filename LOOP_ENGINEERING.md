# Loop Engineering P0 + P1 + P1.5

This repository exposes a Loop Engineering control plane on top of the existing workspace MCP tools.

## P0 responsibilities

- A builder (ChatGPT, Codex, or another coding agent) still performs discovery, planning, and source edits through the existing workspace tools.
- `loop_run` creates or resumes one verification iteration after a builder change.
- Deterministic runners verify the current workspace state.
- Git status/diff, runner stdout/stderr, acceptance-criterion state, failure fingerprints, and transitions are persisted under `data/loops/<runId>/`.
- `loop_status` reads one run or lists recent runs.
- `loop_stop` explicitly stops a non-terminal run.

## P1 responsibilities

- Independent verifiers are separate from the builder decision path.
- `browser_runner` runs an allowlisted project-owned browser/E2E command and requires a structured JSON evidence artifact.
- `sld_geometry` independently evaluates endpoint-to-anchor alignment, orthogonal routing, and optional symbol centering from a geometry snapshot.
- `isolation: "worktree"` verifies `HEAD + current tracked diff + untracked files` in a managed Git worktree instead of running project checks in the main workspace.
- Loop memory persists notes, lessons, attempted strategies, failure history, and the last verifier summary.
- `loop_memory` reads or appends durable memory without replaying the whole chat history.

## States

`CREATED -> VERIFYING -> DONE | REVIEWING | RETRYING | BLOCKED | FAILED`

A `REVIEWING`, `RETRYING`, or `BLOCKED` run can be resumed with another `loop_run`. `DONE`, `FAILED`, and `STOPPED` are terminal.

`BLOCKED` is entered when the same failure fingerprint reaches `maxRepeatedFailures`. `FAILED` is entered when `maxIterations` is exhausted.

## Example new run

```json
{
  "spec": {
    "name": "SLD anchor alignment",
    "workspace": "bess",
    "goal": "Keep SLD edge endpoints aligned with their target anchors after drag release.",
    "acceptanceCriteria": [
      {
        "id": "typecheck",
        "description": "Frontend typecheck passes.",
        "check": "bess_root_typecheck"
      },
      {
        "id": "tests",
        "description": "Frontend tests pass.",
        "check": "bess_root_test"
      },
      {
        "id": "visual-behavior",
        "description": "Manual/browser evidence confirms no post-release alignment jump."
      }
    ],
    "requiredChecks": [],
    "boundaries": [
      "Do not replace React Flow.",
      "Do not disable snapping to make tests pass."
    ],
    "maxIterations": 5,
    "maxRepeatedFailures": 2
  },
  "criterionResults": []
}
```

The two check-backed criteria are updated automatically. The manual criterion remains `PENDING`, so the run moves to `REVIEWING` after deterministic checks pass.

## Resume with criterion evidence

```json
{
  "runId": "<run-id>",
  "criterionResults": [
    {
      "id": "visual-behavior",
      "status": "PASS",
      "evidence": "Drag/release behavior verified by the external builder/reviewer."
    }
  ]
}
```

`loop_run` reruns deterministic checks before a run can become `DONE`.

## Evidence layout

```text
data/loops/<runId>/
  state.json
  attempt-001/
    attempt.json
    git-status.txt
    git-diff.patch
    checks/
      <runner>.json
    verifiers/
      <verifier-id>.json
    isolation.json
    screenshots.json
    screenshots/
      <copied-playwright-screenshot>
```

`state.json` also persists loop memory (notes, lessons, strategies, failure history and the last verifier summary). `data/loops/` and managed verification worktrees are intentionally git-ignored because they are runtime state, not source code.

## Windows runner fix

On Windows, `.cmd` and `.bat` commands cannot be executed directly with Node `execFile`. P0 routes only those allowlisted batch commands through `cmd.exe`; batch tokens are restricted before execution instead of enabling `shell: true` globally.

## P1 SLD example

A project-owned Playwright test can run through the fixed `bess_root_e2e` runner (`npm run test:e2e:loop`). The test should write two runtime artifacts, for example:

```text
.loop-evidence/browser.json
.loop-evidence/sld-geometry.json
```

Example Loop Spec additions:

```json
{
  "isolation": "worktree",
  "verifiers": [
    {
      "id": "browser-release-behavior",
      "type": "browser_runner",
      "runner": "bess_root_e2e",
      "artifactFile": ".loop-evidence/browser.json"
    },
    {
      "id": "sld-geometry",
      "type": "sld_geometry",
      "snapshotFile": ".loop-evidence/sld-geometry.json",
      "tolerancePx": 0.1,
      "requireEndpointAlignment": true,
      "requireOrthogonal": true,
      "requireSymbolCentering": true,
      "requireFresh": true,
      "minEdges": 1,
      "minNodes": 1
    }
  ]
}
```

A criterion can be bound directly to a verifier:

```json
{
  "id": "geometry",
  "description": "SLD geometry remains exact after drag release.",
  "verifier": "sld-geometry"
}
```

### Browser evidence contract

`.loop-evidence/browser.json` must be JSON and declare success explicitly:

```json
{
  "success": true,
  "summary": "Drag, release, rotate and telemetry-card interactions passed.",
  "assertions": [
    { "name": "drag-release-no-jump", "status": "PASS" }
  ],
  "screenshots": ["test-results/sld-after-release.png"]
}
```

The browser runner itself passing is not enough; missing/invalid evidence or `success !== true` fails the verifier.

### SLD geometry snapshot contract

```json
{
  "nodes": [
    {
      "id": "cb-1",
      "center": { "x": 100, "y": 100 },
      "symbolBounds": { "x": 90, "y": 90, "width": 20, "height": 20 }
    }
  ],
  "edges": [
    {
      "id": "edge-1",
      "sourcePoint": { "x": 100, "y": 120 },
      "sourceAnchor": { "x": 100, "y": 120 },
      "targetPoint": { "x": 200, "y": 220 },
      "targetAnchor": { "x": 200, "y": 220 },
      "points": [
        { "x": 100, "y": 120 },
        { "x": 100, "y": 220 },
        { "x": 200, "y": 220 }
      ]
    }
  ]
}
```

With `tolerancePx: 0.1`, a one-pixel endpoint drift fails verification.

## Durable loop memory

`loop_run` accepts optional iteration context:

```json
{
  "runId": "<run-id>",
  "iterationContext": {
    "strategy": "Normalize React Flow coordinates on dragStop instead of mouseMove.",
    "note": "Previous attempt still jumped after release.",
    "lessons": [
      "Do not round only during mouseMove; persisted coordinates must be normalized too."
    ]
  }
}
```

The state file retains strategies, notes, lessons, failure fingerprints, and verifier summaries across backend restarts.

## P1.5 network and secret verification

P1.5 adds first-class `http_api` and `websocket_probe` verifiers plus secret-aware evidence redaction. Remote network probes require HTTPS/WSS; plain HTTP/WS is accepted only for loopback test servers. Remote hosts must also be explicitly allowlisted in the Loop Spec:

```json
{
  "networkPolicy": {
    "allowedHosts": ["edge.energyinsight.vn"],
    "allowLoopback": true
  }
}
```

Secrets are referenced from environment variables and rendered only in memory:

```text
{{secret:ENERGYINSIGHT_EMAIL}}
{{secret:ENERGYINSIGHT_PASSWORD}}
```

Values captured from one verifier step are available to later steps/verifiers in the same iteration without being persisted in plaintext:

```text
{{capture:accessToken}}
{{capture:deviceIds}}
```

Example authentication -> device discovery verifier:

```json
{
  "id": "energyinsight-api",
  "type": "http_api",
  "steps": [
    {
      "id": "login",
      "method": "POST",
      "url": "https://edge.energyinsight.vn/api/auth/login",
      "json": {
        "email": "{{secret:ENERGYINSIGHT_EMAIL}}",
        "password": "{{secret:ENERGYINSIGHT_PASSWORD}}"
      },
      "expect": {
        "status": [200],
        "jsonPathExists": ["accessToken"]
      },
      "capture": [
        {
          "name": "accessToken",
          "path": "accessToken",
          "sensitive": true
        }
      ]
    },
    {
      "id": "devices",
      "method": "GET",
      "url": "https://edge.energyinsight.vn/api/devices/69b277b69de990c043932260?recursive=true",
      "headers": {
        "authorization": "Bearer {{capture:accessToken}}"
      },
      "expect": {
        "status": [200]
      }
    }
  ]
}
```

The exact access-token response path and the device-tree paths must be adjusted to the real API contract before production use; the example intentionally does not guess undocumented field names beyond the provided login concept.

Example WebSocket verifier shape:

```json
{
  "id": "energyinsight-ws",
  "type": "websocket_probe",
  "url": "wss://<actual-energyinsight-websocket-url>",
  "sequence": [
    {
      "id": "auth",
      "send": {
        "type": "auth",
        "token": "{{capture:accessToken}}"
      },
      "waitFor": {
        "jsonPath": "type",
        "equals": "auth_ok"
      },
      "failureCode": "WS_AUTH_FAILED"
    }
  ],
  "expect": {
    "minMessages": 1
  }
}
```

The WebSocket URL, auth message, acknowledgement shape, and subscribe payload are protocol-specific and must come from the real service contract rather than being inferred.

For device telemetry, `expect.matches` can prove that telemetry belongs to the device IDs discovered by the HTTP verifier instead of merely counting arbitrary WebSocket messages:

```json
{
  "expect": {
    "minMessages": 1,
    "matches": [
      {
        "jsonPath": "type",
        "equals": "telemetry",
        "minMatches": 1
      },
      {
        "jsonPath": "deviceId",
        "inCapture": "deviceIds",
        "minMatches": 1,
        "rejectUnknown": true
      }
    ]
  }
}
```

This can distinguish `WS_AUTH_FAILED`, `WS_SUBSCRIBE_FAILED`, `WS_NO_TELEMETRY`, `WS_DISCONNECTED`, `WS_UNKNOWN_DEVICE`, `WS_MESSAGE_MISMATCH`, and network/secret failures in the failure fingerprint.

Before evidence is written, the loop store sanitizes known environment secrets, captured sensitive values, Bearer tokens, JWT-looking values, deterministic-runner stdout/stderr, criterion evidence, iteration memory, and Git diff text. Sensitive response keys such as `password`, `token`, `authorization`, cookies, and API keys are also replaced with `[REDACTED]`.

If a loop references any secret, automatic screenshot copying is disabled (`disabled_due_to_secret_refs`) because binary images cannot be reliably redacted. The WebSocket verifier prefers the runtime's native `WebSocket` client and falls back to the `ws` package if it is already installed; otherwise it returns `WS_RUNTIME_UNAVAILABLE` instead of silently skipping verification.
