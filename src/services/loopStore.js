import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAFE_RUNNERS } from "../config.js";
import {
  execFile,
  runConfiguredRunner,
} from "../utils/command.js";
import { limitOutput } from "../utils/result.js";
import {
  collectSecretRefs,
  resolveSecret,
  sanitizeEvidence,
  sanitizeText,
} from "./secretService.js";
import {
  normalizeVerifierSpecs,
  runIndependentVerifiers,
} from "./verifierService.js";
import {
  prepareVerificationWorktree,
  removeVerificationWorktree,
} from "./worktreeManager.js";
import { getWorkspace } from "./workspaceRegistry.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "..", "..");

export const LOOP_DATA_DIR = path.resolve(
  process.env.LOOP_DATA_DIR ?? path.join(projectRoot, "data", "loops")
);

export const LOOP_STATES = Object.freeze([
  "CREATED",
  "VERIFYING",
  "REVIEWING",
  "RETRYING",
  "BLOCKED",
  "DONE",
  "FAILED",
  "STOPPED",
]);

const TERMINAL_STATES = new Set(["DONE", "FAILED", "STOPPED"]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

const ALLOWED_TRANSITIONS = Object.freeze({
  CREATED: new Set(["VERIFYING", "STOPPED"]),
  VERIFYING: new Set([
    "REVIEWING",
    "RETRYING",
    "BLOCKED",
    "DONE",
    "FAILED",
    "STOPPED",
  ]),
  REVIEWING: new Set(["VERIFYING", "DONE", "FAILED", "STOPPED"]),
  RETRYING: new Set(["VERIFYING", "FAILED", "STOPPED"]),
  BLOCKED: new Set(["VERIFYING", "FAILED", "STOPPED"]),
  DONE: new Set(),
  FAILED: new Set(),
  STOPPED: new Set(),
});

function nowIso() {
  return new Date().toISOString();
}

function makeRunId() {
  const timestamp = nowIso().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("Loop runId khong hop le.");
  }
}

function runDirectory(runId) {
  assertRunId(runId);
  return path.join(LOOP_DATA_DIR, runId);
}

function stateFile(runId) {
  return path.join(runDirectory(runId), "state.json");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function knownSecretValuesForRun(run) {
  const values = [];
  const refs = collectSecretRefs(run?.spec?.verifiers ?? []);

  for (const ref of refs) {
    try {
      values.push(resolveSecret(ref));
    } catch {
      // A verifier that needs a missing secret will report the failure itself.
    }
  }

  return values;
}

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );

  try {
    await fs.rename(temporaryFile, file);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) {
      throw error;
    }

    await fs.copyFile(temporaryFile, file);
    await fs.unlink(temporaryFile).catch(() => {});
  }
}

async function writeText(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value ?? "", "utf8");
}

function transition(run, nextState) {
  if (run.state === nextState) {
    return;
  }

  const allowed = ALLOWED_TRANSITIONS[run.state];

  if (!allowed?.has(nextState)) {
    throw new Error(
      `Loop transition khong hop le: ${run.state} -> ${nextState}`
    );
  }

  run.state = nextState;
  run.updatedAt = nowIso();
}

function normalizeSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("Loop spec khong hop le.");
  }

  if (typeof spec.workspace !== "string" || !spec.workspace.trim()) {
    throw new Error("Loop spec thieu workspace.");
  }

  if (typeof spec.goal !== "string" || !spec.goal.trim()) {
    throw new Error("Loop spec thieu goal.");
  }

  if (spec.goal.length > 5000) {
    throw new Error("Loop goal vuot gioi han 5000 ky tu.");
  }

  if (
    !Array.isArray(spec.acceptanceCriteria) ||
    spec.acceptanceCriteria.length < 1 ||
    spec.acceptanceCriteria.length > 30
  ) {
    throw new Error("Loop spec can 1-30 acceptance criteria.");
  }

  const criterionIds = new Set();
  const acceptanceCriteria = spec.acceptanceCriteria.map((criterion) => {
    if (!criterion || typeof criterion !== "object") {
      throw new Error("Acceptance criterion khong hop le.");
    }

    if (
      typeof criterion.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(criterion.id)
    ) {
      throw new Error(`Acceptance criterion id khong hop le: ${String(criterion.id)}`);
    }

    if (criterionIds.has(criterion.id)) {
      throw new Error(`Acceptance criterion id bi trung: ${criterion.id}`);
    }
    criterionIds.add(criterion.id);

    if (
      typeof criterion.description !== "string" ||
      !criterion.description.trim() ||
      criterion.description.length > 1000
    ) {
      throw new Error(`Acceptance criterion ${criterion.id} thieu description hop le.`);
    }

    return {
      id: criterion.id,
      description: criterion.description.trim(),
      required: criterion.required !== false,
      check: criterion.check ?? null,
      verifier: criterion.verifier ?? null,
    };
  });

  if (
    spec.requiredChecks !== undefined &&
    (!Array.isArray(spec.requiredChecks) || spec.requiredChecks.length > 20)
  ) {
    throw new Error("requiredChecks phai la array toi da 20 runner.");
  }

  if (
    spec.boundaries !== undefined &&
    (!Array.isArray(spec.boundaries) || spec.boundaries.length > 30)
  ) {
    throw new Error("boundaries phai la array toi da 30 muc.");
  }

  const maxIterations = spec.maxIterations ?? 5;
  const maxRepeatedFailures = spec.maxRepeatedFailures ?? 2;
  const isolation = spec.isolation ?? "none";
  const rawNetworkPolicy = spec.networkPolicy ?? {};

  if (
    !rawNetworkPolicy ||
    typeof rawNetworkPolicy !== "object" ||
    Array.isArray(rawNetworkPolicy) ||
    (rawNetworkPolicy.allowLoopback !== undefined &&
      typeof rawNetworkPolicy.allowLoopback !== "boolean")
  ) {
    throw new Error("networkPolicy khong hop le.");
  }

  const networkPolicy = {
    allowedHosts: rawNetworkPolicy.allowedHosts ?? [],
    allowLoopback: rawNetworkPolicy.allowLoopback !== false,
  };

  if (!["none", "worktree"].includes(isolation)) {
    throw new Error("Loop isolation chi ho tro none hoac worktree.");
  }

  if (
    !Array.isArray(networkPolicy.allowedHosts) ||
    networkPolicy.allowedHosts.length > 30 ||
    networkPolicy.allowedHosts.some(
      (host) =>
        typeof host !== "string" ||
        !/^[A-Za-z0-9.-]{1,253}$/.test(host) ||
        host.startsWith(".") ||
        host.endsWith(".")
    )
  ) {
    throw new Error("networkPolicy.allowedHosts khong hop le.");
  }
  networkPolicy.allowedHosts = [
    ...new Set(networkPolicy.allowedHosts.map((host) => host.toLowerCase())),
  ];

  if (spec.verifiers !== undefined && (!Array.isArray(spec.verifiers) || spec.verifiers.length > 10)) {
    throw new Error("verifiers phai la array toi da 10 muc.");
  }

  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
    throw new Error("maxIterations phai trong khoang 1-20.");
  }

  if (
    !Number.isInteger(maxRepeatedFailures) ||
    maxRepeatedFailures < 1 ||
    maxRepeatedFailures > 5
  ) {
    throw new Error("maxRepeatedFailures phai trong khoang 1-5.");
  }

  const requiredChecks = [
    ...(spec.requiredChecks ?? []),
    ...acceptanceCriteria.map((criterion) => criterion.check).filter(Boolean),
  ];
  const uniqueChecks = [...new Set(requiredChecks)];
  const verifiers = normalizeVerifierSpecs(spec.verifiers ?? [], spec.workspace);
  const verifierIds = new Set(verifiers.map((verifier) => verifier.id));

  for (const criterion of acceptanceCriteria) {
    if (criterion.verifier && !verifierIds.has(criterion.verifier)) {
      throw new Error(
        `Acceptance criterion ${criterion.id} tham chieu verifier khong ton tai: ${criterion.verifier}`
      );
    }
  }

  if (uniqueChecks.length === 0 && verifiers.length === 0) {
    throw new Error(
      "Loop spec can co it nhat mot deterministic check hoac independent verifier."
    );
  }

  for (const runnerName of uniqueChecks) {
    const runner = SAFE_RUNNERS[runnerName];

    if (!runner) {
      throw new Error(`Loop runner khong hop le: ${runnerName}`);
    }

    if (runner.workspace !== spec.workspace) {
      throw new Error(
        `Runner ${runnerName} thuoc workspace ${runner.workspace}, khong phai ${spec.workspace}.`
      );
    }
  }

  for (const boundary of spec.boundaries ?? []) {
    if (typeof boundary !== "string" || !boundary.trim() || boundary.length > 1000) {
      throw new Error("Boundary khong hop le.");
    }
  }

  getWorkspace(spec.workspace);

  return {
    name:
      typeof spec.name === "string" && spec.name.trim()
        ? spec.name.trim().slice(0, 120)
        : spec.goal.trim().slice(0, 100),
    workspace: spec.workspace,
    goal: spec.goal.trim(),
    acceptanceCriteria,
    requiredChecks: uniqueChecks,
    verifiers,
    isolation,
    networkPolicy,
    boundaries: (spec.boundaries ?? []).map((boundary) => boundary.trim()),
    maxIterations,
    maxRepeatedFailures,
  };
}

function createCriteriaState(spec) {
  return spec.acceptanceCriteria.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    required: criterion.required,
    check: criterion.check,
    verifier: criterion.verifier,
    status: "PENDING",
    evidence: null,
    updatedAt: null,
  }));
}

export async function createLoopRun(spec) {
  const normalizedSpec = normalizeSpec(spec);
  const runId = makeRunId();
  const timestamp = nowIso();
  const run = {
    version: 3,
    runId,
    state: "CREATED",
    createdAt: timestamp,
    updatedAt: timestamp,
    stoppedAt: null,
    stopReason: null,
    iteration: 0,
    lastFailureFingerprint: null,
    repeatedFailureCount: 0,
    memory: {
      notes: [],
      lessons: [],
      strategies: [],
      failureHistory: [],
      lastVerifierSummary: null,
    },
    spec: normalizedSpec,
    criteria: createCriteriaState(normalizedSpec),
    attempts: [],
  };

  await atomicWriteJson(stateFile(runId), run);
  return clone(run);
}

export async function loadLoopRun(runId) {
  assertRunId(runId);

  try {
    const content = await fs.readFile(stateFile(runId), "utf8");
    const run = JSON.parse(content);
    run.memory ??= {
      notes: [],
      lessons: [],
      strategies: [],
      failureHistory: [],
      lastVerifierSummary: null,
    };
    run.spec.verifiers ??= [];
    run.spec.isolation ??= "none";
    run.spec.networkPolicy ??= {
      allowedHosts: [],
      allowLoopback: true,
    };
    run.criteria = (run.criteria ?? []).map((criterion) => ({
      verifier: null,
      ...criterion,
    }));
    return run;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Khong tim thay loop run: ${runId}`);
    }

    throw error;
  }
}

async function saveLoopRun(run) {
  run.updatedAt = nowIso();
  await atomicWriteJson(stateFile(run.runId), run);
}

function mergeCriterionResults(run, criterionResults) {
  if (!criterionResults?.length) {
    return;
  }

  const byId = new Map(run.criteria.map((criterion) => [criterion.id, criterion]));

  for (const result of criterionResults) {
    if (!result || typeof result !== "object") {
      throw new Error("Criterion result khong hop le.");
    }

    if (!['PASS', 'FAIL'].includes(result.status)) {
      throw new Error(`Criterion result status khong hop le: ${String(result.status)}`);
    }

    if (
      result.evidence !== undefined &&
      (typeof result.evidence !== "string" || result.evidence.length > 5000)
    ) {
      throw new Error(`Criterion evidence khong hop le: ${String(result.id)}`);
    }

    const criterion = byId.get(result.id);

    if (!criterion) {
      throw new Error(`Acceptance criterion khong ton tai: ${result.id}`);
    }

    criterion.status = result.status;
    criterion.evidence = result.evidence
      ? sanitizeText(result.evidence.trim(), knownSecretValuesForRun(run))
      : null;
    criterion.updatedAt = nowIso();
  }
}

async function captureGitEvidence(workspaceId) {
  const workspace = getWorkspace(workspaceId);

  try {
    const [statusResult, diffResult] = await Promise.all([
      execFile(
        "git",
        ["-C", workspace.root, "status", "--short", "--branch", "--untracked-files=all"],
        {
          cwd: workspace.root,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 2_000_000,
          encoding: "utf8",
        }
      ),
      execFile(
        "git",
        ["-C", workspace.root, "diff", "--no-ext-diff", "--"],
        {
          cwd: workspace.root,
          windowsHide: true,
          timeout: 30000,
          maxBuffer: 2_000_000,
          encoding: "utf8",
        }
      ),
    ]);

    return {
      available: true,
      status: limitOutput(statusResult.stdout || statusResult.stderr || ""),
      diff: limitOutput(diffResult.stdout || diffResult.stderr || ""),
    };
  } catch (error) {
    return {
      available: false,
      status: "",
      diff: "",
      error: limitOutput(error.message ?? String(error)),
    };
  }
}

function updateCheckBackedCriteria(run, checks) {
  const byRunner = new Map(checks.map((check) => [check.runner, check]));

  for (const criterion of run.criteria) {
    if (!criterion.check) {
      continue;
    }

    const check = byRunner.get(criterion.check);

    if (!check) {
      continue;
    }

    criterion.status = check.success ? "PASS" : "FAIL";
    criterion.evidence = check.success
      ? `Deterministic check ${criterion.check} passed.`
      : `Deterministic check ${criterion.check} failed.`;
    criterion.updatedAt = nowIso();
  }
}

function updateVerifierBackedCriteria(run, verifiers) {
  const byId = new Map(verifiers.map((verifier) => [verifier.id, verifier]));

  for (const criterion of run.criteria) {
    if (!criterion.verifier) {
      continue;
    }

    const verifier = byId.get(criterion.verifier);

    if (!verifier) {
      continue;
    }

    criterion.status = verifier.success ? "PASS" : "FAIL";
    criterion.evidence = verifier.summary ?? null;
    criterion.updatedAt = nowIso();
  }
}

function failureFingerprint(checks, verifiers, criteria) {
  const failedChecks = checks
    .filter((check) => !check.success)
    .map((check) => ({
      runner: check.runner,
      code: check.code ?? null,
      stderr: (check.stderr ?? "").slice(0, 2000),
    }));
  const failedVerifiers = verifiers
    .filter((verifier) => verifier.required !== false && !verifier.success)
    .map((verifier) => ({
      id: verifier.id,
      type: verifier.type,
      failureCode: verifier.failureCode ?? verifier.code ?? null,
      summary: (verifier.summary ?? "").slice(0, 1500),
    }));
  const failedCriteria = criteria
    .filter(
      (criterion) => criterion.required !== false && criterion.status === "FAIL"
    )
    .map((criterion) => ({
      id: criterion.id,
      evidence: (criterion.evidence ?? "").slice(0, 1000),
    }));

  if (
    failedChecks.length === 0 &&
    failedVerifiers.length === 0 &&
    failedCriteria.length === 0
  ) {
    return null;
  }

  return createHash("sha256")
    .update(JSON.stringify({ failedChecks, failedVerifiers, failedCriteria }))
    .digest("hex")
    .slice(0, 24);
}

function safeEvidenceRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    return false;
  }

  const normalized = value.replaceAll("\\", "/");
  return (
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    normalized !== ".git" &&
    !normalized.startsWith(".git/")
  );
}

async function copyBrowserScreenshots(
  attempt,
  directory,
  { disabledReason = null } = {}
) {
  const root = attempt.isolation?.root;
  const manifest = [];

  if (!root) {
    return manifest;
  }

  const screenshotsDirectory = path.join(directory, "screenshots");

  for (const verifier of attempt.verifiers ?? []) {
    const screenshots = Array.isArray(verifier?.artifact?.screenshots)
      ? verifier.artifact.screenshots
      : [];

    for (let index = 0; index < screenshots.length; index += 1) {
      const relativeFile = screenshots[index];

      if (disabledReason) {
        manifest.push({
          verifier: verifier.id,
          source: String(relativeFile),
          copied: false,
          error: disabledReason,
        });
        continue;
      }

      if (!safeEvidenceRelativePath(relativeFile)) {
        manifest.push({
          verifier: verifier.id,
          source: String(relativeFile),
          copied: false,
          error: "unsafe_relative_path",
        });
        continue;
      }

      try {
        const source = path.resolve(root, relativeFile);
        const relativeFromRoot = path.relative(path.resolve(root), source);

        if (!safeEvidenceRelativePath(relativeFromRoot)) {
          throw new Error("screenshot nam ngoai verification root");
        }

        const stat = await fs.stat(source);
        if (!stat.isFile() || stat.size > 25_000_000) {
          throw new Error("screenshot khong phai file hoac vuot 25 MB");
        }

        await fs.mkdir(screenshotsDirectory, { recursive: true });
        const targetName = `${verifier.id}-${String(index + 1).padStart(2, "0")}-${path.basename(source)}`;
        const target = path.join(screenshotsDirectory, targetName);
        await fs.copyFile(source, target);
        manifest.push({
          verifier: verifier.id,
          source: relativeFile,
          copied: true,
          evidenceFile: `screenshots/${targetName}`,
        });
      } catch (error) {
        manifest.push({
          verifier: verifier.id,
          source: relativeFile,
          copied: false,
          error: error.message,
        });
      }
    }
  }

  return manifest;
}

async function persistAttemptEvidence(run, attempt, gitEvidence) {
  const attemptName = `attempt-${String(attempt.iteration).padStart(3, "0")}`;
  const directory = path.join(runDirectory(run.runId), attemptName);
  const checksDirectory = path.join(directory, "checks");
  const verifiersDirectory = path.join(directory, "verifiers");

  await fs.mkdir(checksDirectory, { recursive: true });
  await fs.mkdir(verifiersDirectory, { recursive: true });
  const hasSecretRefs = collectSecretRefs(run.spec?.verifiers ?? []).size > 0;
  const screenshotManifest = await copyBrowserScreenshots(
    attempt,
    directory,
    {
      disabledReason: hasSecretRefs
        ? "disabled_due_to_secret_refs"
        : null,
    }
  );
  attempt.screenshots = screenshotManifest;
  await atomicWriteJson(path.join(directory, "attempt.json"), attempt);
  await writeText(path.join(directory, "git-status.txt"), gitEvidence.status);
  await writeText(path.join(directory, "git-diff.patch"), gitEvidence.diff);

  if (gitEvidence.error) {
    await writeText(path.join(directory, "git-error.txt"), gitEvidence.error);
  }

  for (const check of attempt.checks) {
    await atomicWriteJson(
      path.join(checksDirectory, `${check.runner}.json`),
      check
    );
  }

  for (const verifier of attempt.verifiers ?? []) {
    await atomicWriteJson(
      path.join(verifiersDirectory, `${verifier.id}.json`),
      verifier
    );
  }

  if (attempt.isolation) {
    await atomicWriteJson(
      path.join(directory, "isolation.json"),
      attempt.isolation
    );
  }

  if (screenshotManifest.length > 0) {
    await atomicWriteJson(
      path.join(directory, "screenshots.json"),
      screenshotManifest
    );
  }

  return directory;
}

function applyIterationContext(run, iterationContext) {
  if (!iterationContext) {
    return;
  }

  const secretValues = knownSecretValuesForRun(run);
  const strategy =
    typeof iterationContext.strategy === "string"
      ? sanitizeText(
          iterationContext.strategy.trim().slice(0, 2000),
          secretValues
        )
      : "";
  const note =
    typeof iterationContext.note === "string"
      ? sanitizeText(
          iterationContext.note.trim().slice(0, 5000),
          secretValues
        )
      : "";
  const lessons = Array.isArray(iterationContext.lessons)
    ? iterationContext.lessons
        .filter((lesson) => typeof lesson === "string" && lesson.trim())
        .map((lesson) =>
          sanitizeText(lesson.trim().slice(0, 2000), secretValues)
        )
        .slice(0, 20)
    : [];

  if (note) {
    run.memory.notes.push({
      iteration: run.iteration + 1,
      at: nowIso(),
      note,
    });
    run.memory.notes = run.memory.notes.slice(-100);
  }

  for (const lesson of lessons) {
    run.memory.lessons.push({
      iteration: run.iteration + 1,
      at: nowIso(),
      lesson,
    });
  }
  run.memory.lessons = run.memory.lessons.slice(-100);

  run.currentStrategy = strategy || null;
}

function updateMemoryAfterAttempt(run, attempt) {
  if (run.currentStrategy) {
    run.memory.strategies.push({
      iteration: attempt.iteration,
      at: attempt.completedAt,
      strategy: run.currentStrategy,
      stateAfter: attempt.stateAfter,
      failureFingerprint: attempt.failureFingerprint,
    });
    run.memory.strategies = run.memory.strategies.slice(-50);
  }

  if (attempt.failureFingerprint) {
    run.memory.failureHistory.push({
      iteration: attempt.iteration,
      at: attempt.completedAt,
      fingerprint: attempt.failureFingerprint,
      repeatedFailureCount: attempt.repeatedFailureCount,
      strategy: run.currentStrategy,
    });
    run.memory.failureHistory = run.memory.failureHistory.slice(-100);
  }

  run.memory.lastVerifierSummary = {
    iteration: attempt.iteration,
    at: attempt.completedAt,
    allChecksPassed: attempt.allChecksPassed,
    allVerifiersPassed: attempt.allVerifiersPassed,
    allCriteriaPassed: attempt.allCriteriaPassed,
    verifiers: (attempt.verifiers ?? []).map((verifier) => ({
      id: verifier.id,
      type: verifier.type,
      success: verifier.success,
      failureCode: verifier.failureCode ?? verifier.code ?? null,
      summary: verifier.summary,
    })),
  };
  run.currentStrategy = null;
}

export async function runLoopIteration({
  runId,
  spec,
  criterionResults = [],
  iterationContext,
}) {
  let run;

  if (runId) {
    run = await loadLoopRun(runId);

    if (spec) {
      throw new Error("Khong truyen spec khi resume loop bang runId.");
    }
  } else {
    if (!spec) {
      throw new Error("Can truyen spec khi tao loop run moi.");
    }

    run = await createLoopRun(spec);
  }

  if (TERMINAL_STATES.has(run.state)) {
    throw new Error(`Loop ${run.runId} da ket thuc voi state ${run.state}.`);
  }

  if (run.iteration >= run.spec.maxIterations) {
    transition(run, "FAILED");
    run.stopReason = "max_iterations_reached";

    if (run.spec.isolation === "worktree") {
      await removeVerificationWorktree({
        runId: run.runId,
        workspaceId: run.spec.workspace,
      }).catch((error) => {
        run.memory.notes.push({
          iteration: run.iteration,
          at: nowIso(),
          note: `Worktree cleanup warning: ${error.message}`,
        });
      });
      run.memory.notes = run.memory.notes.slice(-100);
    }

    await saveLoopRun(run);
    return clone(run);
  }

  mergeCriterionResults(run, criterionResults);
  applyIterationContext(run, iterationContext);
  transition(run, "VERIFYING");
  run.stopReason = null;
  run.iteration += 1;
  await saveLoopRun(run);

  const startedAt = nowIso();
  const gitEvidence = await captureGitEvidence(run.spec.workspace);
  const sourceWorkspace = getWorkspace(run.spec.workspace);
  let verificationRoot = sourceWorkspace.root;
  let isolation = {
    mode: "none",
    root: verificationRoot,
    warnings: [],
  };

  if (run.spec.isolation === "worktree") {
    try {
      isolation = await prepareVerificationWorktree({
        runId: run.runId,
        workspaceId: run.spec.workspace,
      });
      verificationRoot = isolation.root;
    } catch (error) {
      isolation = {
        mode: "worktree",
        root: null,
        error: error.message,
        warnings: [],
      };
    }
  }

  const checks = [];

  if (!isolation.error) {
    for (const runner of run.spec.requiredChecks) {
      try {
        const result = await runConfiguredRunner(runner, {
          workspaceRoot: verificationRoot,
          workspaceName:
            run.spec.isolation === "worktree"
              ? `${sourceWorkspace.name} [worktree]`
              : sourceWorkspace.name,
        });
        checks.push({
          runner,
          success: result.success,
          workspace: result.workspace,
          code: result.code ?? null,
          signal: result.signal ?? null,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        });
      } catch (error) {
        checks.push({
          runner,
          success: false,
          workspace: sourceWorkspace.name,
          code: "RUNNER_SETUP_FAILED",
          signal: null,
          stdout: "",
          stderr: error.message,
        });
      }
    }
  } else {
    checks.push({
      runner: "__isolation__",
      success: false,
      workspace: sourceWorkspace.name,
      code: "ISOLATION_FAILED",
      signal: null,
      stdout: "",
      stderr: isolation.error,
    });
  }

  const verifierExecution = isolation.error
    ? { results: [], sensitiveValues: [], captureNames: [] }
    : await runIndependentVerifiers({
        workspaceId: run.spec.workspace,
        verificationRoot,
        verifiers: run.spec.verifiers,
        startedAt,
        networkPolicy: run.spec.networkPolicy,
      });
  const evidenceSecrets = [
    ...knownSecretValuesForRun(run),
    ...(verifierExecution.sensitiveValues ?? []),
  ];
  const sanitizedChecks = checks.map((check) =>
    sanitizeEvidence(check, evidenceSecrets)
  );
  const verifiers = (verifierExecution.results ?? []).map((verifier) =>
    sanitizeEvidence(verifier, evidenceSecrets)
  );
  const sanitizedGitEvidence = sanitizeEvidence(gitEvidence, evidenceSecrets);

  updateCheckBackedCriteria(run, sanitizedChecks);
  updateVerifierBackedCriteria(run, verifiers);

  const allChecksPassed = sanitizedChecks.every((check) => check.success);
  const allVerifiersPassed = verifiers
    .filter((verifier) => verifier.required !== false)
    .every((verifier) => verifier.success);
  const requiredCriteria = run.criteria.filter((criterion) => criterion.required);
  const allCriteriaPassed = requiredCriteria.every(
    (criterion) => criterion.status === "PASS"
  );
  const hasPendingCriteria = requiredCriteria.some(
    (criterion) => criterion.status === "PENDING"
  );
  const fingerprint = failureFingerprint(
    sanitizedChecks,
    verifiers,
    run.criteria
  );

  if (fingerprint) {
    if (run.lastFailureFingerprint === fingerprint) {
      run.repeatedFailureCount += 1;
    } else {
      run.repeatedFailureCount = 1;
    }
    run.lastFailureFingerprint = fingerprint;
  } else {
    run.repeatedFailureCount = 0;
    run.lastFailureFingerprint = null;
  }

  let nextState;
  let stopReason = null;

  if (allChecksPassed && allVerifiersPassed && allCriteriaPassed) {
    nextState = "DONE";
    stopReason = "all_acceptance_criteria_checks_and_verifiers_passed";
  } else if (
    allChecksPassed &&
    allVerifiersPassed &&
    hasPendingCriteria &&
    !fingerprint
  ) {
    nextState = "REVIEWING";
  } else if (
    fingerprint &&
    run.repeatedFailureCount >= run.spec.maxRepeatedFailures
  ) {
    nextState = "BLOCKED";
    stopReason = "repeated_failure_detected";
  } else if (run.iteration >= run.spec.maxIterations) {
    nextState = "FAILED";
    stopReason = "max_iterations_reached";
  } else {
    nextState = "RETRYING";
  }

  transition(run, nextState);

  if (stopReason) {
    run.stopReason = stopReason;
  }

  const attempt = {
    iteration: run.iteration,
    startedAt,
    completedAt: nowIso(),
    stateAfter: run.state,
    allChecksPassed,
    allVerifiersPassed,
    allCriteriaPassed,
    failureFingerprint: fingerprint,
    repeatedFailureCount: run.repeatedFailureCount,
    strategy: run.currentStrategy ?? null,
    checks: sanitizedChecks,
    verifiers,
    criteria: sanitizeEvidence(clone(run.criteria), evidenceSecrets),
    isolation: sanitizeEvidence(isolation, evidenceSecrets),
    network: {
      captureNames: verifierExecution.captureNames ?? [],
    },
    git: {
      available: sanitizedGitEvidence.available,
      statusCaptured: Boolean(sanitizedGitEvidence.status),
      diffCaptured: Boolean(sanitizedGitEvidence.diff),
      error: sanitizedGitEvidence.error ?? null,
    },
  };

  const evidenceDirectory = await persistAttemptEvidence(
    run,
    attempt,
    sanitizedGitEvidence
  );

  run.attempts.push({
    iteration: attempt.iteration,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    stateAfter: attempt.stateAfter,
    failureFingerprint: attempt.failureFingerprint,
    repeatedFailureCount: attempt.repeatedFailureCount,
    evidenceDirectory,
  });
  updateMemoryAfterAttempt(run, attempt);

  if (TERMINAL_STATES.has(run.state) && run.spec.isolation === "worktree") {
    try {
      await removeVerificationWorktree({
        runId: run.runId,
        workspaceId: run.spec.workspace,
      });
    } catch (error) {
      run.memory.notes.push({
        iteration: run.iteration,
        at: nowIso(),
        note: `Worktree cleanup warning: ${error.message}`,
      });
      run.memory.notes = run.memory.notes.slice(-100);
    }
  }

  await saveLoopRun(run);

  return clone(run);
}

export async function stopLoopRun(runId, reason = "stopped_by_user") {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) {
    throw new Error("Loop stop reason khong hop le.");
  }

  const run = await loadLoopRun(runId);

  if (TERMINAL_STATES.has(run.state)) {
    return clone(run);
  }

  transition(run, "STOPPED");
  run.stoppedAt = nowIso();
  run.stopReason = sanitizeText(
    reason.trim() || "stopped_by_user",
    knownSecretValuesForRun(run)
  );

  if (run.spec.isolation === "worktree") {
    try {
      await removeVerificationWorktree({
        runId: run.runId,
        workspaceId: run.spec.workspace,
      });
    } catch (error) {
      run.memory.notes.push({
        iteration: run.iteration,
        at: nowIso(),
        note: `Worktree cleanup warning: ${error.message}`,
      });
      run.memory.notes = run.memory.notes.slice(-100);
    }
  }

  await saveLoopRun(run);
  return clone(run);
}

export async function updateLoopMemory(runId, { note, lesson } = {}) {
  const run = await loadLoopRun(runId);
  const secretValues = knownSecretValuesForRun(run);
  const normalizedNote =
    typeof note === "string"
      ? sanitizeText(note.trim().slice(0, 5000), secretValues)
      : "";
  const normalizedLesson =
    typeof lesson === "string"
      ? sanitizeText(lesson.trim().slice(0, 2000), secretValues)
      : "";

  if (!normalizedNote && !normalizedLesson) {
    return clone(run.memory);
  }

  if (normalizedNote) {
    run.memory.notes.push({
      iteration: run.iteration,
      at: nowIso(),
      note: normalizedNote,
    });
    run.memory.notes = run.memory.notes.slice(-100);
  }

  if (normalizedLesson) {
    run.memory.lessons.push({
      iteration: run.iteration,
      at: nowIso(),
      lesson: normalizedLesson,
    });
    run.memory.lessons = run.memory.lessons.slice(-100);
  }

  await saveLoopRun(run);
  return clone(run.memory);
}

function runSummary(run) {
  return {
    runId: run.runId,
    name: run.spec?.name ?? run.runId,
    workspace: run.spec?.workspace ?? null,
    goal: run.spec?.goal ?? null,
    state: run.state,
    iteration: run.iteration,
    maxIterations: run.spec?.maxIterations ?? null,
    isolation: run.spec?.isolation ?? "none",
    verifierCount: run.spec?.verifiers?.length ?? 0,
    repeatedFailureCount: run.repeatedFailureCount ?? 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    stopReason: run.stopReason ?? null,
  };
}

export async function getLoopStatus(runId) {
  if (runId) {
    return clone(await loadLoopRun(runId));
  }

  await fs.mkdir(LOOP_DATA_DIR, { recursive: true });
  const entries = await fs.readdir(LOOP_DATA_DIR, { withFileTypes: true });
  const runs = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) {
      continue;
    }

    try {
      const run = await loadLoopRun(entry.name);
      runs.push(runSummary(run));
    } catch {
      // Ignore incomplete/corrupt directories in list mode; direct status still errors.
    }
  }

  return runs
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 50);
}
