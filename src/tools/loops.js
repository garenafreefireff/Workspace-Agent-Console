import { z } from "zod";
import { SAFE_RUNNERS } from "../config.js";
import {
  getLoopStatus,
  runLoopIteration,
  stopLoopRun,
  updateLoopMemory,
} from "../services/loopStore.js";
import { textResult } from "../utils/result.js";
import { assertWriteEnabled } from "../utils/writeGuard.js";

const RUNNER_NAMES = Object.freeze(Object.keys(SAFE_RUNNERS));
const runnerSchema = z.enum(RUNNER_NAMES);
const verifierIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

const browserVerifierSchema = z.object({
  id: verifierIdSchema,
  type: z.literal("browser_runner"),
  description: z.string().min(1).max(1000).optional(),
  required: z.boolean().default(true),
  runner: runnerSchema,
  artifactFile: z.string().min(1).max(500),
});

const geometryVerifierSchema = z.object({
  id: verifierIdSchema,
  type: z.literal("sld_geometry"),
  description: z.string().min(1).max(1000).optional(),
  required: z.boolean().default(true),
  snapshotFile: z.string().min(1).max(500),
  tolerancePx: z.number().min(0).max(20).default(0.25),
  requireEndpointAlignment: z.boolean().default(true),
  requireOrthogonal: z.boolean().default(true),
  requireSymbolCentering: z.boolean().default(false),
  requireFresh: z.boolean().default(true),
  minEdges: z.number().int().min(0).max(10000).default(1),
  minNodes: z.number().int().min(0).max(10000).default(0),
});

const captureRuleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  path: z.string().min(1).max(300),
  sensitive: z.boolean().default(true),
});

const httpExpectSchema = z.object({
  status: z
    .union([
      z.number().int().min(100).max(599),
      z.array(z.number().int().min(100).max(599)).min(1).max(20),
    ])
    .optional(),
  jsonPathExists: z.array(z.string().min(1).max(300)).max(30).default([]),
  minArrayLength: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        min: z.number().int().min(0).max(100000),
      })
    )
    .max(20)
    .default([]),
  uniqueBy: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        key: z.string().min(1).max(300),
      })
    )
    .max(20)
    .default([]),
});

const httpStepSchema = z.object({
  id: verifierIdSchema,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  url: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).default({}),
  json: z.unknown().optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  expect: httpExpectSchema.default({}),
  capture: z.array(captureRuleSchema).max(20).default([]),
});

const httpApiVerifierSchema = z.object({
  id: verifierIdSchema,
  type: z.literal("http_api"),
  description: z.string().min(1).max(1000).optional(),
  required: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
  steps: z.array(httpStepSchema).min(1).max(20),
});

const wsWaitForSchema = z.object({
  contains: z.string().max(1000).optional(),
  jsonPath: z.string().min(1).max(300).optional(),
  equals: z.unknown().optional(),
});

const wsActionSchema = z.object({
  id: verifierIdSchema,
  send: z.unknown().optional(),
  waitFor: wsWaitForSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  forEachCapture: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  capture: z.array(captureRuleSchema).max(20).default([]),
  failureCode: z.string().min(1).max(80).optional(),
});

const websocketProbeVerifierSchema = z.object({
  id: verifierIdSchema,
  type: z.literal("websocket_probe"),
  description: z.string().min(1).max(1000).optional(),
  required: z.boolean().default(true),
  url: z.string().min(1).max(2000),
  protocols: z.array(z.string().max(200)).max(10).default([]),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
  sequence: z.array(wsActionSchema).max(30).default([]),
  expect: z
    .object({
      minMessages: z.number().int().min(0).max(100000).default(0),
      timeoutMs: z.number().int().min(100).max(120000).optional(),
      matches: z
        .array(
          z.object({
            jsonPath: z.string().min(1).max(300).optional(),
            contains: z.string().max(1000).optional(),
            equals: z.unknown().optional(),
            inCapture: z
              .string()
              .min(1)
              .max(80)
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
              .optional(),
            minMatches: z.number().int().min(1).max(100000).default(1),
            rejectUnknown: z.boolean().default(false),
          })
        )
        .max(20)
        .default([]),
    })
    .default({}),
});

const socketIoWaitForSchema = z.object({
  event: z.string().min(1).max(120),
  contains: z.string().max(1000).optional(),
  jsonPath: z.string().min(1).max(300).optional(),
  equals: z.unknown().optional(),
});

const socketIoActionSchema = z.object({
  id: verifierIdSchema,
  emit: z
    .object({
      event: z.string().min(1).max(120),
      payload: z.unknown().optional(),
    })
    .optional(),
  waitFor: socketIoWaitForSchema.optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  capture: z.array(captureRuleSchema).max(20).default([]),
  failureCode: z.string().min(1).max(80).optional(),
});

const socketIoMatchSchema = z.object({
  event: z.string().min(1).max(120),
  contains: z.string().max(1000).optional(),
  jsonPath: z.string().min(1).max(300).optional(),
  equals: z.unknown().optional(),
  inCapture: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  minMatches: z.number().int().min(1).max(100000).default(1),
  rejectUnknown: z.boolean().default(false),
});

const socketIoProbeVerifierSchema = z.object({
  id: verifierIdSchema,
  type: z.literal("socketio_probe"),
  description: z.string().min(1).max(1000).optional(),
  required: z.boolean().default(true),
  url: z.string().min(1).max(2000),
  auth: z.record(z.string(), z.unknown()).default({}),
  transports: z.array(z.enum(["websocket", "polling"])).min(1).max(2).default(["websocket"]),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
  sequence: z.array(socketIoActionSchema).max(30).default([]),
  expect: z
    .object({
      timeoutMs: z.number().int().min(100).max(120000).optional(),
      matches: z.array(socketIoMatchSchema).max(20).default([]),
    })
    .default({}),
});

const verifierSchema = z.discriminatedUnion("type", [
  browserVerifierSchema,
  geometryVerifierSchema,
  httpApiVerifierSchema,
  websocketProbeVerifierSchema,
  socketIoProbeVerifierSchema,
]);

const acceptanceCriterionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  description: z.string().min(1).max(1000),
  required: z.boolean().default(true),
  check: runnerSchema.optional(),
  verifier: verifierIdSchema.optional(),
});

const loopSpecSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  workspace: z.string().min(1).max(50),
  goal: z.string().min(1).max(5000),
  acceptanceCriteria: z
    .array(acceptanceCriterionSchema)
    .min(1)
    .max(30),
  requiredChecks: z.array(runnerSchema).max(20).default([]),
  verifiers: z.array(verifierSchema).max(10).default([]),
  isolation: z.enum(["none", "worktree"]).default("none"),
  networkPolicy: z
    .object({
      allowedHosts: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .regex(/^[A-Za-z0-9.-]+$/)
        )
        .max(30)
        .default([]),
      allowLoopback: z.boolean().default(true),
    })
    .default({}),
  boundaries: z.array(z.string().min(1).max(1000)).max(30).default([]),
  maxIterations: z.number().int().min(1).max(20).default(5),
  maxRepeatedFailures: z.number().int().min(1).max(5).default(2),
});

const criterionResultSchema = z.object({
  id: z.string().min(1).max(80),
  status: z.enum(["PASS", "FAIL"]),
  evidence: z.string().max(5000).optional(),
});

const iterationContextSchema = z.object({
  strategy: z.string().max(2000).optional(),
  note: z.string().max(5000).optional(),
  lessons: z.array(z.string().min(1).max(2000)).max(20).default([]),
});

function jsonResult(value) {
  return textResult(JSON.stringify(value, null, 2));
}

export function registerLoopTools(server) {
  server.registerTool(
    "loop_run",
    {
      title: "Run loop verification iteration",
      description:
        "Create or resume a Loop Engineering run after an external builder iteration. Runs deterministic checks plus browser, SLD geometry, allowlisted HTTP API, and WebSocket verifiers; supports Git-worktree isolation, secret-aware redaction, durable strategy memory, repeated-failure detection, and explicit terminal states.",
      inputSchema: {
        runId: z.string().min(1).max(120).optional(),
        spec: loopSpecSchema.optional(),
        criterionResults: z.array(criterionResultSchema).max(30).default([]),
        iterationContext: iterationContextSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({
      runId,
      spec,
      criterionResults = [],
      iterationContext,
    }) => {
      try {
        assertWriteEnabled();

        if (!runId && !spec) {
          throw new Error("Can truyen spec cho loop moi hoac runId de resume.");
        }

        if (runId && spec) {
          throw new Error("Chi truyen mot trong hai: runId hoac spec.");
        }

        const run = await runLoopIteration({
          runId,
          spec,
          criterionResults,
          iterationContext,
        });

        return jsonResult(run);
      } catch (error) {
        return textResult(`Loi loop_run: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "loop_status",
    {
      title: "Inspect loop status",
      description:
        "Read one Loop Engineering run with its spec, criteria, attempts, state, and evidence locations. Omit runId to list recent runs.",
      inputSchema: {
        runId: z.string().min(1).max(120).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ runId }) => {
      try {
        return jsonResult(await getLoopStatus(runId));
      } catch (error) {
        return textResult(`Loi loop_status: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "loop_memory",
    {
      title: "Read or append loop memory",
      description:
        "Read durable loop memory or append a concise note/lesson that future iterations can use without replaying the whole conversation.",
      inputSchema: {
        runId: z.string().min(1).max(120),
        action: z.enum(["get", "append"]).default("get"),
        note: z.string().max(5000).optional(),
        lesson: z.string().max(2000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async ({ runId, action = "get", note, lesson }) => {
      try {
        if (action === "get") {
          const run = await getLoopStatus(runId);
          return jsonResult(run.memory ?? {});
        }

        assertWriteEnabled();
        return jsonResult(await updateLoopMemory(runId, { note, lesson }));
      } catch (error) {
        return textResult(`Loi loop_memory: ${error.message}`);
      }
    }
  );

  server.registerTool(
    "loop_stop",
    {
      title: "Stop loop run",
      description:
        "Explicitly stop a non-terminal Loop Engineering run and persist the stop reason.",
      inputSchema: {
        runId: z.string().min(1).max(120),
        reason: z.string().min(1).max(1000).default("stopped_by_user"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ runId, reason = "stopped_by_user" }) => {
      try {
        return jsonResult(await stopLoopRun(runId, reason));
      } catch (error) {
        return textResult(`Loi loop_stop: ${error.message}`);
      }
    }
  );
}
