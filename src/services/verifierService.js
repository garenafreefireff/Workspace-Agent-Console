import { promises as fs } from "node:fs";
import path from "node:path";
import { SAFE_RUNNERS } from "../config.js";
import { runConfiguredRunner } from "../utils/command.js";
import { resolveExistingPath } from "../utils/paths.js";
import {
  executeHttpApiVerifier,
  executeSocketIoProbeVerifier,
  executeWebSocketProbeVerifier,
} from "./networkVerifierService.js";
import {
  collectSecretRefs,
  resolveSecret,
  sanitizeEvidence,
} from "./secretService.js";
import { getWorkspace } from "./workspaceRegistry.js";

const VERIFIER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const CAPTURE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const VERIFIER_TYPES = new Set([
  "browser_runner",
  "sld_geometry",
  "http_api",
  "websocket_probe",
  "socketio_probe",
]);
const SENSITIVE_CONFIG_KEY_PATTERN = /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|client[_-]?secret)/i;
const TEMPLATE_SECRET_OR_CAPTURE_PATTERN = /\{\{(?:secret|capture):[A-Za-z_][A-Za-z0-9_]*\}\}/;
const WHOLE_SECRET_OR_CAPTURE_PATTERN = /^\{\{(?:secret|capture):[A-Za-z_][A-Za-z0-9_]*\}\}$/;
const AUTH_SECRET_OR_CAPTURE_PATTERN = /^(?:Bearer\s+)?\{\{(?:secret|capture):[A-Za-z_][A-Za-z0-9_]*\}\}$/i;
const INLINE_BEARER_PATTERN = /Bearer\s+(?!\{\{(?:secret|capture):)[A-Za-z0-9._~+\/-]+/i;

function assertNoInlineSecrets(value, location = "verifier") {
  if (typeof value === "string") {
    if (INLINE_BEARER_PATTERN.test(value)) {
      throw new Error(`${location} chua Bearer token literal; hay dung secret/capture template.`);
    }
    if (
      /[?&](?:token|access_token|api[_-]?key|password|secret)=([^&]+)/i.test(value) &&
      !TEMPLATE_SECRET_OR_CAPTURE_PATTERN.test(value)
    ) {
      throw new Error(`${location} chua secret trong URL literal; hay dung secret/capture template.`);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoInlineSecrets(item, `${location}[${index}]`)
    );
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (SENSITIVE_CONFIG_KEY_PATTERN.test(key)) {
      const pattern = /authorization/i.test(key)
        ? AUTH_SECRET_OR_CAPTURE_PATTERN
        : WHOLE_SECRET_OR_CAPTURE_PATTERN;
      if (typeof child !== "string" || !pattern.test(child)) {
        throw new Error(
          `${childLocation} la field nhay cam va bat buoc dung secret/capture template thuần, khong duoc tron literal.`
        );
      }
      continue;
    }
    assertNoInlineSecrets(child, childLocation);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function finitePoint(value) {
  return (
    value &&
    typeof value === "object" &&
    finiteNumber(value.x) &&
    finiteNumber(value.y)
  );
}

function pointDelta(left, right) {
  return {
    dx: Math.abs(left.x - right.x),
    dy: Math.abs(left.y - right.y),
  };
}

function centeredPoint(bounds) {
  if (
    !bounds ||
    !finiteNumber(bounds.x) ||
    !finiteNumber(bounds.y) ||
    !finiteNumber(bounds.width) ||
    !finiteNumber(bounds.height)
  ) {
    return null;
  }

  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function edgePoints(edge) {
  if (Array.isArray(edge?.points)) {
    return edge.points.filter(finitePoint);
  }

  if (Array.isArray(edge?.segments)) {
    const points = [];

    for (const segment of edge.segments) {
      if (finitePoint(segment?.from)) {
        points.push(segment.from);
      }

      if (finitePoint(segment?.to)) {
        const last = points.at(-1);
        if (!last || last.x !== segment.to.x || last.y !== segment.to.y) {
          points.push(segment.to);
        }
      }
    }

    return points;
  }

  return [];
}

export function evaluateSldGeometry(snapshot, options = {}) {
  const tolerancePx = finiteNumber(options.tolerancePx)
    ? Math.max(0, options.tolerancePx)
    : 0.25;
  const requireEndpointAlignment = options.requireEndpointAlignment !== false;
  const requireOrthogonal = options.requireOrthogonal !== false;
  const requireSymbolCentering = options.requireSymbolCentering === true;
  const minEdges = Number.isInteger(options.minEdges) ? Math.max(0, options.minEdges) : 1;
  const minNodes = Number.isInteger(options.minNodes) ? Math.max(0, options.minNodes) : 0;
  const edges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const failures = [];
  let alignedEndpoints = 0;
  let checkedEndpoints = 0;
  let orthogonalSegments = 0;
  let checkedSegments = 0;
  let centeredSymbols = 0;
  let checkedSymbols = 0;

  if (edges.length < minEdges) {
    failures.push({
      code: "INSUFFICIENT_EDGES",
      expected: minEdges,
      actual: edges.length,
    });
  }

  if (nodes.length < minNodes) {
    failures.push({
      code: "INSUFFICIENT_NODES",
      expected: minNodes,
      actual: nodes.length,
    });
  }

  for (const edge of edges) {
    const edgeId = String(edge?.id ?? "unknown-edge");

    if (requireEndpointAlignment) {
      for (const side of ["source", "target"]) {
        const point = edge?.[`${side}Point`];
        const anchor = edge?.[`${side}Anchor`];

        if (!finitePoint(point) || !finitePoint(anchor)) {
          failures.push({
            code: "MISSING_ENDPOINT_EVIDENCE",
            edgeId,
            side,
          });
          continue;
        }

        checkedEndpoints += 1;
        const delta = pointDelta(point, anchor);

        if (delta.dx <= tolerancePx && delta.dy <= tolerancePx) {
          alignedEndpoints += 1;
        } else {
          failures.push({
            code: "ENDPOINT_MISALIGNED",
            edgeId,
            side,
            tolerancePx,
            dx: delta.dx,
            dy: delta.dy,
            point,
            anchor,
          });
        }
      }
    }

    if (requireOrthogonal) {
      const points = edgePoints(edge);

      if (points.length < 2) {
        failures.push({
          code: "MISSING_EDGE_PATH",
          edgeId,
        });
      }

      for (let index = 1; index < points.length; index += 1) {
        const from = points[index - 1];
        const to = points[index];
        const delta = pointDelta(from, to);
        checkedSegments += 1;

        if (delta.dx <= tolerancePx || delta.dy <= tolerancePx) {
          orthogonalSegments += 1;
        } else {
          failures.push({
            code: "NON_ORTHOGONAL_SEGMENT",
            edgeId,
            segmentIndex: index - 1,
            tolerancePx,
            dx: delta.dx,
            dy: delta.dy,
            from,
            to,
          });
        }
      }
    }
  }

  if (requireSymbolCentering) {
    for (const node of nodes) {
      const nodeId = String(node?.id ?? "unknown-node");
      const nodeCenter = node?.center;
      const symbolCenter = centeredPoint(node?.symbolBounds);

      if (!finitePoint(nodeCenter) || !symbolCenter) {
        failures.push({
          code: "MISSING_SYMBOL_CENTER_EVIDENCE",
          nodeId,
        });
        continue;
      }

      checkedSymbols += 1;
      const delta = pointDelta(nodeCenter, symbolCenter);

      if (delta.dx <= tolerancePx && delta.dy <= tolerancePx) {
        centeredSymbols += 1;
      } else {
        failures.push({
          code: "SYMBOL_NOT_CENTERED",
          nodeId,
          tolerancePx,
          dx: delta.dx,
          dy: delta.dy,
          nodeCenter,
          symbolCenter,
        });
      }
    }
  }

  return {
    success: failures.length === 0,
    summary: failures.length === 0
      ? `SLD geometry passed: ${edges.length} edges, ${nodes.length} nodes.`
      : `SLD geometry failed with ${failures.length} issue(s).`,
    tolerancePx,
    metrics: {
      edges: edges.length,
      nodes: nodes.length,
      alignedEndpoints,
      checkedEndpoints,
      orthogonalSegments,
      checkedSegments,
      centeredSymbols,
      checkedSymbols,
    },
    failures: failures.slice(0, 200),
  };
}

function normalizeCaptureRules(rules, verifierId) {
  if (rules === undefined) return [];
  if (!Array.isArray(rules) || rules.length > 20) {
    throw new Error(`Verifier ${verifierId} capture phai la array toi da 20 muc.`);
  }

  return rules.map((rule) => {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof rule.name !== "string" ||
      !CAPTURE_NAME_PATTERN.test(rule.name) ||
      typeof rule.path !== "string" ||
      !rule.path.trim() ||
      rule.path.length > 300
    ) {
      throw new Error(`Verifier ${verifierId} capture rule khong hop le.`);
    }

    return {
      name: rule.name,
      path: rule.path.trim(),
      sensitive: rule.sensitive !== false,
    };
  });
}

function normalizeHttpExpect(raw, verifierId) {
  const expect = raw ?? {};
  const statuses = Array.isArray(expect.status)
    ? expect.status
    : expect.status === undefined
      ? [200]
      : [expect.status];

  if (
    statuses.length < 1 ||
    statuses.length > 20 ||
    statuses.some(
      (status) => !Number.isInteger(status) || status < 100 || status > 599
    )
  ) {
    throw new Error(`HTTP verifier ${verifierId} status expectation khong hop le.`);
  }

  const jsonPathExists = expect.jsonPathExists ?? [];
  if (
    !Array.isArray(jsonPathExists) ||
    jsonPathExists.length > 30 ||
    jsonPathExists.some(
      (item) => typeof item !== "string" || !item.trim() || item.length > 300
    )
  ) {
    throw new Error(`HTTP verifier ${verifierId} jsonPathExists khong hop le.`);
  }

  const minArrayLength = expect.minArrayLength ?? [];
  if (!Array.isArray(minArrayLength) || minArrayLength.length > 20) {
    throw new Error(`HTTP verifier ${verifierId} minArrayLength khong hop le.`);
  }

  const uniqueBy = expect.uniqueBy ?? [];
  if (!Array.isArray(uniqueBy) || uniqueBy.length > 20) {
    throw new Error(`HTTP verifier ${verifierId} uniqueBy khong hop le.`);
  }

  return {
    status: [...new Set(statuses)],
    jsonPathExists: jsonPathExists.map((item) => item.trim()),
    minArrayLength: minArrayLength.map((rule) => {
      if (
        !rule ||
        typeof rule.path !== "string" ||
        !rule.path.trim() ||
        rule.path.length > 300 ||
        !Number.isInteger(rule.min) ||
        rule.min < 0 ||
        rule.min > 100000
      ) {
        throw new Error(`HTTP verifier ${verifierId} minArrayLength rule khong hop le.`);
      }
      return { path: rule.path.trim(), min: rule.min };
    }),
    uniqueBy: uniqueBy.map((rule) => {
      if (
        !rule ||
        typeof rule.path !== "string" ||
        !rule.path.trim() ||
        rule.path.length > 300 ||
        typeof rule.key !== "string" ||
        !rule.key.trim() ||
        rule.key.length > 300
      ) {
        throw new Error(`HTTP verifier ${verifierId} uniqueBy rule khong hop le.`);
      }
      return { path: rule.path.trim(), key: rule.key.trim() };
    }),
  };
}

function normalizeHttpVerifier(raw) {
  assertNoInlineSecrets(raw.steps, `http_api.${raw.id}.steps`);

  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 20) {
    throw new Error(`HTTP verifier ${raw.id} can 1-20 steps.`);
  }

  const timeoutMs = raw.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new Error(`HTTP verifier ${raw.id} timeoutMs khong hop le.`);
  }

  const stepIds = new Set();
  const steps = raw.steps.map((step) => {
    if (
      !step ||
      typeof step.id !== "string" ||
      !VERIFIER_ID_PATTERN.test(step.id) ||
      stepIds.has(step.id)
    ) {
      throw new Error(`HTTP verifier ${raw.id} step id khong hop le hoac bi trung.`);
    }
    stepIds.add(step.id);

    const method = String(step.method ?? "GET").toUpperCase();
    if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).has(method)) {
      throw new Error(`HTTP verifier ${raw.id} method khong duoc ho tro: ${method}`);
    }
    if (["GET", "HEAD"].includes(method) && step.json !== undefined) {
      throw new Error(`HTTP verifier ${raw.id} ${method} khong duoc mang JSON body.`);
    }
    if (step.json !== undefined) {
      let serialized;
      try {
        serialized = JSON.stringify(step.json);
      } catch {
        throw new Error(`HTTP verifier ${raw.id} JSON body khong serializable.`);
      }
      if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
        throw new Error(`HTTP verifier ${raw.id} JSON body vuot 64 KB.`);
      }
    }

    if (typeof step.url !== "string" || !step.url.trim() || step.url.length > 2000) {
      throw new Error(`HTTP verifier ${raw.id} step ${step.id} URL khong hop le.`);
    }

    if (
      step.headers !== undefined &&
      (!step.headers || typeof step.headers !== "object" || Array.isArray(step.headers))
    ) {
      throw new Error(`HTTP verifier ${raw.id} step ${step.id} headers khong hop le.`);
    }
    const blockedHeaders = new Set([
      "host",
      "content-length",
      "transfer-encoding",
      "connection",
    ]);
    for (const [headerName, headerValue] of Object.entries(step.headers ?? {})) {
      if (
        typeof headerValue !== "string" ||
        headerName.length < 1 ||
        headerName.length > 200 ||
        headerValue.length > 4000 ||
        blockedHeaders.has(headerName.toLowerCase())
      ) {
        throw new Error(
          `HTTP verifier ${raw.id} step ${step.id} header khong hop le: ${headerName}`
        );
      }
    }

    const stepTimeoutMs = step.timeoutMs ?? timeoutMs;
    if (
      !Number.isInteger(stepTimeoutMs) ||
      stepTimeoutMs < 100 ||
      stepTimeoutMs > 120000
    ) {
      throw new Error(`HTTP verifier ${raw.id} step ${step.id} timeoutMs khong hop le.`);
    }

    return {
      id: step.id,
      method,
      url: step.url.trim(),
      headers: step.headers ?? {},
      json: step.json,
      timeoutMs: stepTimeoutMs,
      expect: normalizeHttpExpect(step.expect, `${raw.id}/${step.id}`),
      capture: normalizeCaptureRules(step.capture, `${raw.id}/${step.id}`),
    };
  });

  return { timeoutMs, steps };
}

function normalizeWebSocketVerifier(raw) {
  assertNoInlineSecrets(
    {
      url: raw.url,
      protocols: raw.protocols,
      sequence: raw.sequence,
    },
    `websocket_probe.${raw.id}`
  );

  if (typeof raw.url !== "string" || !raw.url.trim() || raw.url.length > 2000) {
    throw new Error(`WebSocket verifier ${raw.id} URL khong hop le.`);
  }

  const timeoutMs = raw.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new Error(`WebSocket verifier ${raw.id} timeoutMs khong hop le.`);
  }

  const protocols = raw.protocols ?? [];
  if (
    !Array.isArray(protocols) ||
    protocols.length > 10 ||
    protocols.some((item) => typeof item !== "string" || item.length > 200)
  ) {
    throw new Error(`WebSocket verifier ${raw.id} protocols khong hop le.`);
  }

  const sequence = raw.sequence ?? [];
  if (!Array.isArray(sequence) || sequence.length > 30) {
    throw new Error(`WebSocket verifier ${raw.id} sequence khong hop le.`);
  }

  const actionIds = new Set();
  const normalizedSequence = sequence.map((action) => {
    if (
      !action ||
      typeof action.id !== "string" ||
      !VERIFIER_ID_PATTERN.test(action.id) ||
      actionIds.has(action.id)
    ) {
      throw new Error(`WebSocket verifier ${raw.id} action id khong hop le hoac bi trung.`);
    }
    actionIds.add(action.id);

    if (action.send !== undefined) {
      let serialized;
      try {
        serialized =
          typeof action.send === "string"
            ? action.send
            : JSON.stringify(action.send);
      } catch {
        throw new Error(`WebSocket verifier ${raw.id} send payload khong serializable.`);
      }
      if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
        throw new Error(`WebSocket verifier ${raw.id} send payload vuot 64 KB.`);
      }
    }

    if (
      action.forEachCapture !== undefined &&
      (typeof action.forEachCapture !== "string" ||
        !CAPTURE_NAME_PATTERN.test(action.forEachCapture))
    ) {
      throw new Error(`WebSocket verifier ${raw.id} forEachCapture khong hop le.`);
    }

    if (action.waitFor !== undefined) {
      const waitFor = action.waitFor;
      if (!waitFor || typeof waitFor !== "object" || Array.isArray(waitFor)) {
        throw new Error(`WebSocket verifier ${raw.id} waitFor khong hop le.`);
      }
      if (
        waitFor.jsonPath !== undefined &&
        (typeof waitFor.jsonPath !== "string" ||
          !waitFor.jsonPath.trim() ||
          waitFor.jsonPath.length > 300)
      ) {
        throw new Error(`WebSocket verifier ${raw.id} waitFor.jsonPath khong hop le.`);
      }
      if (
        waitFor.contains !== undefined &&
        (typeof waitFor.contains !== "string" || waitFor.contains.length > 1000)
      ) {
        throw new Error(`WebSocket verifier ${raw.id} waitFor.contains khong hop le.`);
      }
    }

    const actionTimeoutMs = action.timeoutMs ?? timeoutMs;
    if (
      !Number.isInteger(actionTimeoutMs) ||
      actionTimeoutMs < 100 ||
      actionTimeoutMs > 120000
    ) {
      throw new Error(`WebSocket verifier ${raw.id} action timeoutMs khong hop le.`);
    }

    return {
      id: action.id,
      send: action.send,
      waitFor: action.waitFor,
      timeoutMs: actionTimeoutMs,
      forEachCapture: action.forEachCapture ?? null,
      capture: normalizeCaptureRules(action.capture, `${raw.id}/${action.id}`),
      failureCode:
        typeof action.failureCode === "string" && action.failureCode.trim()
          ? action.failureCode.trim().slice(0, 80)
          : "WS_SEQUENCE_FAILED",
    };
  });

  const expect = raw.expect ?? {};
  const minMessages = expect.minMessages ?? 0;
  const expectTimeoutMs = expect.timeoutMs ?? timeoutMs;
  const matchRules = expect.matches ?? [];
  if (!Number.isInteger(minMessages) || minMessages < 0 || minMessages > 100000) {
    throw new Error(`WebSocket verifier ${raw.id} minMessages khong hop le.`);
  }
  if (
    !Number.isInteger(expectTimeoutMs) ||
    expectTimeoutMs < 100 ||
    expectTimeoutMs > 120000
  ) {
    throw new Error(`WebSocket verifier ${raw.id} expect.timeoutMs khong hop le.`);
  }
  if (!Array.isArray(matchRules) || matchRules.length > 20) {
    throw new Error(`WebSocket verifier ${raw.id} expect.matches khong hop le.`);
  }

  const normalizedMatches = matchRules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`WebSocket verifier ${raw.id} match rule ${index} khong hop le.`);
    }
    if (
      rule.jsonPath !== undefined &&
      (typeof rule.jsonPath !== "string" ||
        !rule.jsonPath.trim() ||
        rule.jsonPath.length > 300)
    ) {
      throw new Error(`WebSocket verifier ${raw.id} match jsonPath khong hop le.`);
    }
    if (
      rule.contains !== undefined &&
      (typeof rule.contains !== "string" || rule.contains.length > 1000)
    ) {
      throw new Error(`WebSocket verifier ${raw.id} match contains khong hop le.`);
    }
    if (
      rule.inCapture !== undefined &&
      (typeof rule.inCapture !== "string" ||
        !CAPTURE_NAME_PATTERN.test(rule.inCapture))
    ) {
      throw new Error(`WebSocket verifier ${raw.id} match inCapture khong hop le.`);
    }
    const minMatches = rule.minMatches ?? 1;
    if (!Number.isInteger(minMatches) || minMatches < 1 || minMatches > 100000) {
      throw new Error(`WebSocket verifier ${raw.id} minMatches khong hop le.`);
    }
    if (!rule.jsonPath && rule.contains === undefined) {
      throw new Error(`WebSocket verifier ${raw.id} match rule can jsonPath hoac contains.`);
    }
    const normalizedRule = {
      jsonPath: rule.jsonPath?.trim(),
      contains: rule.contains,
      inCapture: rule.inCapture ?? null,
      minMatches,
      rejectUnknown: rule.rejectUnknown === true,
    };
    if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
      normalizedRule.equals = rule.equals;
    }
    return normalizedRule;
  });

  return {
    url: raw.url.trim(),
    protocols,
    timeoutMs,
    sequence: normalizedSequence,
    expect: {
      minMessages,
      timeoutMs: expectTimeoutMs,
      matches: normalizedMatches,
    },
  };
}

function normalizeSocketIoVerifier(raw) {
  assertNoInlineSecrets(
    {
      url: raw.url,
      auth: raw.auth,
      sequence: raw.sequence,
    },
    `socketio_probe.${raw.id}`
  );

  if (typeof raw.url !== "string" || !raw.url.trim() || raw.url.length > 2000) {
    throw new Error(`Socket.IO verifier ${raw.id} URL khong hop le.`);
  }

  const timeoutMs = raw.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new Error(`Socket.IO verifier ${raw.id} timeoutMs khong hop le.`);
  }

  const transports = raw.transports ?? ["websocket"];
  if (
    !Array.isArray(transports) ||
    transports.length < 1 ||
    transports.length > 2 ||
    transports.some((item) => !["websocket", "polling"].includes(item))
  ) {
    throw new Error(`Socket.IO verifier ${raw.id} transports khong hop le.`);
  }

  const auth = raw.auth ?? {};
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error(`Socket.IO verifier ${raw.id} auth khong hop le.`);
  }

  const sequence = raw.sequence ?? [];
  if (!Array.isArray(sequence) || sequence.length > 30) {
    throw new Error(`Socket.IO verifier ${raw.id} sequence khong hop le.`);
  }
  const actionIds = new Set();
  const normalizedSequence = sequence.map((action) => {
    if (
      !action ||
      typeof action.id !== "string" ||
      !VERIFIER_ID_PATTERN.test(action.id) ||
      actionIds.has(action.id)
    ) {
      throw new Error(`Socket.IO verifier ${raw.id} action id khong hop le hoac bi trung.`);
    }
    actionIds.add(action.id);

    if (action.emit !== undefined) {
      if (
        !action.emit ||
        typeof action.emit !== "object" ||
        Array.isArray(action.emit) ||
        typeof action.emit.event !== "string" ||
        !action.emit.event.trim() ||
        action.emit.event.length > 120
      ) {
        throw new Error(`Socket.IO verifier ${raw.id} emit khong hop le.`);
      }
      const serialized = JSON.stringify(action.emit.payload ?? {});
      if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
        throw new Error(`Socket.IO verifier ${raw.id} emit payload vuot 64 KB.`);
      }
    }

    let waitFor = null;
    if (action.waitFor !== undefined) {
      if (
        !action.waitFor ||
        typeof action.waitFor !== "object" ||
        Array.isArray(action.waitFor) ||
        typeof action.waitFor.event !== "string" ||
        !action.waitFor.event.trim() ||
        action.waitFor.event.length > 120
      ) {
        throw new Error(`Socket.IO verifier ${raw.id} waitFor khong hop le.`);
      }
      if (
        action.waitFor.jsonPath !== undefined &&
        (typeof action.waitFor.jsonPath !== "string" ||
          !action.waitFor.jsonPath.trim() ||
          action.waitFor.jsonPath.length > 300)
      ) {
        throw new Error(`Socket.IO verifier ${raw.id} waitFor.jsonPath khong hop le.`);
      }
      waitFor = {
        event: action.waitFor.event.trim(),
        jsonPath: action.waitFor.jsonPath?.trim(),
        contains: action.waitFor.contains,
      };
      if (Object.prototype.hasOwnProperty.call(action.waitFor, "equals")) {
        waitFor.equals = action.waitFor.equals;
      }
    }

    const actionTimeoutMs = action.timeoutMs ?? timeoutMs;
    if (!Number.isInteger(actionTimeoutMs) || actionTimeoutMs < 100 || actionTimeoutMs > 120000) {
      throw new Error(`Socket.IO verifier ${raw.id} action timeoutMs khong hop le.`);
    }

    return {
      id: action.id,
      emit: action.emit
        ? {
            event: action.emit.event.trim(),
            payload: action.emit.payload ?? {},
          }
        : null,
      waitFor,
      timeoutMs: actionTimeoutMs,
      capture: normalizeCaptureRules(action.capture, `${raw.id}/${action.id}`),
      failureCode:
        typeof action.failureCode === "string" && action.failureCode.trim()
          ? action.failureCode.trim().slice(0, 80)
          : "SOCKETIO_SEQUENCE_FAILED",
    };
  });

  const expect = raw.expect ?? {};
  const expectTimeoutMs = expect.timeoutMs ?? timeoutMs;
  const matchRules = expect.matches ?? [];
  if (!Number.isInteger(expectTimeoutMs) || expectTimeoutMs < 100 || expectTimeoutMs > 120000) {
    throw new Error(`Socket.IO verifier ${raw.id} expect.timeoutMs khong hop le.`);
  }
  if (!Array.isArray(matchRules) || matchRules.length > 20) {
    throw new Error(`Socket.IO verifier ${raw.id} expect.matches khong hop le.`);
  }

  const matches = matchRules.map((rule, index) => {
    if (
      !rule ||
      typeof rule !== "object" ||
      Array.isArray(rule) ||
      typeof rule.event !== "string" ||
      !rule.event.trim() ||
      rule.event.length > 120
    ) {
      throw new Error(`Socket.IO verifier ${raw.id} match ${index} khong hop le.`);
    }
    if (
      rule.jsonPath !== undefined &&
      (typeof rule.jsonPath !== "string" || !rule.jsonPath.trim() || rule.jsonPath.length > 300)
    ) {
      throw new Error(`Socket.IO verifier ${raw.id} match jsonPath khong hop le.`);
    }
    if (
      rule.inCapture !== undefined &&
      (typeof rule.inCapture !== "string" || !CAPTURE_NAME_PATTERN.test(rule.inCapture))
    ) {
      throw new Error(`Socket.IO verifier ${raw.id} match inCapture khong hop le.`);
    }
    const minMatches = rule.minMatches ?? 1;
    if (!Number.isInteger(minMatches) || minMatches < 1 || minMatches > 100000) {
      throw new Error(`Socket.IO verifier ${raw.id} minMatches khong hop le.`);
    }
    if (!rule.jsonPath && rule.contains === undefined) {
      throw new Error(`Socket.IO verifier ${raw.id} match can jsonPath hoac contains.`);
    }
    const normalized = {
      event: rule.event.trim(),
      jsonPath: rule.jsonPath?.trim(),
      contains: rule.contains,
      inCapture: rule.inCapture ?? null,
      minMatches,
      rejectUnknown: rule.rejectUnknown === true,
    };
    if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
      normalized.equals = rule.equals;
    }
    return normalized;
  });

  return {
    url: raw.url.trim(),
    auth,
    transports,
    timeoutMs,
    sequence: normalizedSequence,
    expect: { timeoutMs: expectTimeoutMs, matches },
  };
}

function normalizeVerifier(raw, workspaceId) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Verifier khong hop le.");
  }

  if (typeof raw.id !== "string" || !VERIFIER_ID_PATTERN.test(raw.id)) {
    throw new Error("Verifier id khong hop le.");
  }

  if (!VERIFIER_TYPES.has(raw.type)) {
    throw new Error(`Verifier type khong duoc ho tro: ${raw.type}`);
  }

  if (
    raw.description !== undefined &&
    (typeof raw.description !== "string" || raw.description.length > 1000)
  ) {
    throw new Error(`Verifier ${raw.id} description khong hop le.`);
  }

  if (raw.type === "browser_runner") {
    const runner = SAFE_RUNNERS[raw.runner];

    if (!runner) {
      throw new Error(`Browser verifier runner khong hop le: ${raw.runner}`);
    }

    if (runner.workspace !== workspaceId) {
      throw new Error(
        `Browser verifier ${raw.id} dung runner cua workspace ${runner.workspace}, khong phai ${workspaceId}.`
      );
    }

    if (
      typeof raw.artifactFile !== "string" ||
      !raw.artifactFile.trim() ||
      raw.artifactFile.length > 500
    ) {
      throw new Error(`Browser verifier ${raw.id} artifactFile khong hop le.`);
    }

    return {
      id: raw.id,
      type: raw.type,
      description: raw.description?.trim() || raw.id,
      required: raw.required !== false,
      runner: raw.runner,
      artifactFile: raw.artifactFile.trim(),
    };
  }

  if (raw.type === "http_api") {
    const network = normalizeHttpVerifier(raw);
    return {
      id: raw.id,
      type: raw.type,
      description: raw.description?.trim() || raw.id,
      required: raw.required !== false,
      ...network,
    };
  }

  if (raw.type === "websocket_probe") {
    const network = normalizeWebSocketVerifier(raw);
    return {
      id: raw.id,
      type: raw.type,
      description: raw.description?.trim() || raw.id,
      required: raw.required !== false,
      ...network,
    };
  }

  if (raw.type === "socketio_probe") {
    const network = normalizeSocketIoVerifier(raw);
    return {
      id: raw.id,
      type: raw.type,
      description: raw.description?.trim() || raw.id,
      required: raw.required !== false,
      ...network,
    };
  }

  if (
    typeof raw.snapshotFile !== "string" ||
    !raw.snapshotFile.trim() ||
    raw.snapshotFile.length > 500
  ) {
    throw new Error(`SLD geometry verifier ${raw.id} snapshotFile khong hop le.`);
  }

  if (
    raw.tolerancePx !== undefined &&
    (!finiteNumber(raw.tolerancePx) || raw.tolerancePx < 0 || raw.tolerancePx > 20)
  ) {
    throw new Error(`SLD geometry verifier ${raw.id} tolerancePx phai trong khoang 0-20.`);
  }

  for (const [key, value] of [
    ["minEdges", raw.minEdges],
    ["minNodes", raw.minNodes],
  ]) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 0 || value > 10000)
    ) {
      throw new Error(`SLD geometry verifier ${raw.id} ${key} khong hop le.`);
    }
  }

  return {
    id: raw.id,
    type: raw.type,
    description: raw.description?.trim() || raw.id,
    required: raw.required !== false,
    snapshotFile: raw.snapshotFile.trim(),
    tolerancePx: finiteNumber(raw.tolerancePx) ? raw.tolerancePx : 0.25,
    requireEndpointAlignment: raw.requireEndpointAlignment !== false,
    requireOrthogonal: raw.requireOrthogonal !== false,
    requireSymbolCentering: raw.requireSymbolCentering === true,
    minEdges: Number.isInteger(raw.minEdges) ? raw.minEdges : 1,
    minNodes: Number.isInteger(raw.minNodes) ? raw.minNodes : 0,
    requireFresh: raw.requireFresh !== false,
  };
}

export function normalizeVerifierSpecs(verifiers, workspaceId) {
  const normalized = (verifiers ?? []).map((verifier) =>
    normalizeVerifier(verifier, workspaceId)
  );
  const seen = new Set();

  for (const verifier of normalized) {
    if (seen.has(verifier.id)) {
      throw new Error(`Verifier id bi trung: ${verifier.id}`);
    }
    seen.add(verifier.id);
  }

  return normalized;
}

async function readJsonEvidence(root, relativeFile) {
  const absoluteFile = await resolveExistingPath(root, relativeFile);
  const stat = await fs.stat(absoluteFile);

  if (!stat.isFile()) {
    throw new Error(`Evidence khong phai file: ${relativeFile}`);
  }

  if (stat.size > 5_000_000) {
    throw new Error(`Evidence file qua lon: ${relativeFile}`);
  }

  return {
    absoluteFile,
    mtimeMs: stat.mtimeMs,
    data: JSON.parse(await fs.readFile(absoluteFile, "utf8")),
  };
}

function resolveEvidenceTarget(root, relativeFile) {
  if (typeof relativeFile !== "string" || !relativeFile.trim() || path.isAbsolute(relativeFile)) {
    throw new Error("Evidence path phai la relative path.");
  }

  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(absoluteRoot, relativeFile);
  const relative = path.relative(absoluteRoot, absoluteFile).replaceAll("\\", "/");

  if (
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("/../") ||
    relative === ".git" ||
    relative.startsWith(".git/")
  ) {
    throw new Error("Evidence path nam ngoai verification root.");
  }

  return absoluteFile;
}

async function runBrowserVerifier(verifier, context) {
  try {
    const staleArtifact = resolveEvidenceTarget(
      context.verificationRoot,
      verifier.artifactFile
    );
    await fs.unlink(staleArtifact).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  } catch (error) {
    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: false,
      summary: `Browser artifact path invalid: ${error.message}`,
      runner: verifier.runner,
      artifactFile: verifier.artifactFile,
    };
  }

  let result;

  try {
    result = await runConfiguredRunner(verifier.runner, {
      workspaceRoot: context.verificationRoot,
      workspaceName: `${context.workspaceName} [verifier]`,
    });
  } catch (error) {
    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: false,
      summary: `Browser runner setup failed: ${error.message}`,
      runner: verifier.runner,
      code: "RUNNER_SETUP_FAILED",
      stdout: "",
      stderr: error.message,
      artifactFile: verifier.artifactFile,
    };
  }

  if (!result.success) {
    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: false,
      summary: `Browser runner ${verifier.runner} failed.`,
      runner: verifier.runner,
      code: result.code ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      artifactFile: verifier.artifactFile,
    };
  }

  try {
    const evidence = await readJsonEvidence(
      context.verificationRoot,
      verifier.artifactFile
    );
    const artifact = evidence.data;
    const success = artifact?.success === true;

    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success,
      summary:
        typeof artifact?.summary === "string"
          ? artifact.summary
          : success
            ? "Browser evidence passed."
            : "Browser evidence did not declare success=true.",
      runner: verifier.runner,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      artifactFile: verifier.artifactFile,
      artifact,
    };
  } catch (error) {
    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: false,
      summary: `Browser evidence invalid: ${error.message}`,
      runner: verifier.runner,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      artifactFile: verifier.artifactFile,
    };
  }
}

async function runGeometryVerifier(verifier, context) {
  try {
    const evidence = await readJsonEvidence(
      context.verificationRoot,
      verifier.snapshotFile
    );

    if (
      verifier.requireFresh !== false &&
      Number.isFinite(context.startedAtMs) &&
      evidence.mtimeMs + 1000 < context.startedAtMs
    ) {
      throw new Error(
        `Geometry snapshot is stale (mtime ${new Date(evidence.mtimeMs).toISOString()}).`
      );
    }

    const evaluation = evaluateSldGeometry(evidence.data, verifier);

    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: evaluation.success,
      summary: evaluation.summary,
      snapshotFile: verifier.snapshotFile,
      evaluation,
    };
  } catch (error) {
    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: false,
      summary: `SLD geometry evidence invalid: ${error.message}`,
      snapshotFile: verifier.snapshotFile,
    };
  }
}

export async function runIndependentVerifiers({
  workspaceId,
  verificationRoot,
  verifiers,
  startedAt,
  networkPolicy,
}) {
  const workspace = getWorkspace(workspaceId);
  const results = [];
  const captures = {};
  const sensitiveValues = new Set();
  const secretRefs = collectSecretRefs(verifiers ?? []);

  for (const secretRef of secretRefs) {
    try {
      sensitiveValues.add(resolveSecret(secretRef));
    } catch {
      // Missing secrets are reported by the network verifier that needs them.
    }
  }

  const context = {
    workspaceId,
    workspaceName: workspace.name,
    verificationRoot: path.resolve(verificationRoot ?? workspace.root),
    startedAtMs:
      typeof startedAt === "string" ? Date.parse(startedAt) : Number(startedAt),
    env: process.env,
    captures,
    sensitiveValues,
    networkPolicy: networkPolicy ?? {
      allowedHosts: [],
      allowLoopback: true,
    },
  };

  for (const verifier of verifiers ?? []) {
    let result;

    if (verifier.type === "browser_runner") {
      result = await runBrowserVerifier(verifier, context);
    } else if (verifier.type === "sld_geometry") {
      result = await runGeometryVerifier(verifier, context);
    } else if (verifier.type === "http_api") {
      result = await executeHttpApiVerifier(verifier, context);
    } else if (verifier.type === "websocket_probe") {
      result = await executeWebSocketProbeVerifier(verifier, context);
    } else if (verifier.type === "socketio_probe") {
      result = await executeSocketIoProbeVerifier(verifier, context);
    } else {
      result = {
        id: verifier.id,
        type: verifier.type,
        required: verifier.required,
        success: false,
        failureCode: "VERIFIER_TYPE_UNSUPPORTED",
        summary: `Verifier type khong duoc ho tro: ${verifier.type}`,
      };
    }

    results.push(sanitizeEvidence(result, [...sensitiveValues]));
  }

  return {
    results,
    sensitiveValues: [...sensitiveValues],
    captureNames: Object.keys(captures),
  };
}
