import { createRequire } from "node:module";
import path from "node:path";
import { sanitizeEvidence, renderTemplate } from "./secretService.js";

const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const DEFAULT_WS_TIMEOUT_MS = 15000;
const MAX_HTTP_BODY_BYTES = 2_000_000;
const MAX_WS_MESSAGE_BYTES = 1_000_000;
const MAX_WS_MESSAGES = 10_000;

function nowMs() {
  return Date.now();
}

function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(
    String(hostname ?? "").toLowerCase()
  );
}

function assertAllowedHost(url, networkPolicy = {}) {
  const loopback = isLoopbackHostname(url.hostname);
  if (loopback && networkPolicy.allowLoopback !== false) {
    return;
  }

  const allowedHosts = new Set(
    (networkPolicy.allowedHosts ?? []).map((host) => String(host).toLowerCase())
  );
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`Network host khong nam trong allowlist: ${url.hostname}`);
  }
}

function assertHttpUrl(value, networkPolicy) {
  const url = new URL(value);
  assertAllowedHost(url, networkPolicy);
  if (url.protocol === "https:") {
    return url.href;
  }
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return url.href;
  }
  throw new Error("HTTP verifier chi cho phep HTTPS, tru loopback localhost.");
}

function assertWebSocketUrl(value, networkPolicy) {
  const url = new URL(value);
  assertAllowedHost(url, networkPolicy);
  if (url.protocol === "wss:") {
    return url.href;
  }
  if (url.protocol === "ws:" && isLoopbackHostname(url.hostname)) {
    return url.href;
  }
  throw new Error("WebSocket verifier chi cho phep WSS, tru loopback localhost.");
}

function responsePreview(data) {
  if (data === null || data === undefined) {
    return null;
  }
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...[truncated]` : text;
}

function tokenizeJsonPath(pathValue) {
  if (typeof pathValue !== "string" || !pathValue.trim()) {
    throw new Error("JSON path khong hop le.");
  }

  const normalized = pathValue.trim().replace(/^\$\.?/, "");
  if (!normalized) {
    return [];
  }

  const tokens = [];
  const matcher = /([^.[\]]+)|\[(\d+|\*)\]/g;
  let match;
  let consumed = "";

  while ((match = matcher.exec(normalized))) {
    tokens.push(match[1] ?? (match[2] === "*" ? "*" : Number(match[2])));
    consumed += match[0];
    if (normalized[matcher.lastIndex] === ".") {
      consumed += ".";
    }
  }

  if (tokens.length === 0 || consumed.replace(/\.$/, "") !== normalized) {
    throw new Error(`JSON path khong duoc ho tro: ${pathValue}`);
  }

  return tokens;
}

export function selectJsonPath(root, pathValue) {
  const tokens = tokenizeJsonPath(pathValue);
  let current = [root];
  let wildcardUsed = false;

  for (const token of tokens) {
    const next = [];

    for (const value of current) {
      if (token === "*") {
        wildcardUsed = true;
        if (Array.isArray(value)) {
          next.push(...value);
        } else if (value && typeof value === "object") {
          next.push(...Object.values(value));
        }
        continue;
      }

      if (value === null || value === undefined) {
        continue;
      }

      if (typeof token === "number") {
        if (Array.isArray(value) && token < value.length) {
          next.push(value[token]);
        }
        continue;
      }

      if (
        typeof value === "object" &&
        Object.prototype.hasOwnProperty.call(value, token)
      ) {
        next.push(value[token]);
      }
    }

    current = next;
  }

  return {
    found: current.length > 0,
    values: current,
    value: wildcardUsed ? current : current[0],
  };
}

function scalarSensitiveValues(value, output) {
  if (typeof value === "string" && value.length >= 4) {
    output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scalarSensitiveValues(item, output);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      scalarSensitiveValues(item, output);
    }
  }
}

async function readResponseBody(response, maxBytes = MAX_HTTP_BODY_BYTES) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`HTTP response vuot gioi han ${maxBytes} bytes.`);
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`HTTP response vuot gioi han ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`HTTP response vuot gioi han ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseResponse(text, contentType) {
  if (!text) {
    return null;
  }

  if (contentType.includes("json") || /^[\s]*[\[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function evaluateHttpExpectations(expect, status, data) {
  const assertions = [];
  const allowedStatuses = expect?.status ?? [200];
  const statusPassed = allowedStatuses.includes(status);
  assertions.push({
    type: "status",
    success: statusPassed,
    expected: allowedStatuses,
    actual: status,
  });

  for (const pathValue of expect?.jsonPathExists ?? []) {
    const selected = selectJsonPath(data, pathValue);
    assertions.push({
      type: "jsonPathExists",
      path: pathValue,
      success: selected.found,
    });
  }

  for (const rule of expect?.minArrayLength ?? []) {
    const selected = selectJsonPath(data, rule.path);
    const candidate = selected.value;
    assertions.push({
      type: "minArrayLength",
      path: rule.path,
      min: rule.min,
      actual: Array.isArray(candidate) ? candidate.length : null,
      success: Array.isArray(candidate) && candidate.length >= rule.min,
    });
  }

  for (const rule of expect?.uniqueBy ?? []) {
    const selected = selectJsonPath(data, rule.path);
    const candidate = selected.value;
    let success = false;
    let duplicates = [];

    if (Array.isArray(candidate)) {
      const seen = new Set();
      duplicates = [];
      success = true;
      for (const item of candidate) {
        const key = selectJsonPath(item, rule.key).value;
        const normalizedKey = JSON.stringify(key);
        if (key === undefined || seen.has(normalizedKey)) {
          success = false;
          duplicates.push(key ?? null);
        } else {
          seen.add(normalizedKey);
        }
      }
    }

    assertions.push({
      type: "uniqueBy",
      path: rule.path,
      key: rule.key,
      success,
      duplicateCount: duplicates.length,
    });
  }

  return assertions;
}

function httpFailureCode(assertions, status) {
  if ([401, 403].includes(status)) {
    return "AUTH_FAILED";
  }
  if (assertions.some((item) => item.type === "status" && !item.success)) {
    return "HTTP_STATUS_MISMATCH";
  }
  return "HTTP_SCHEMA_MISMATCH";
}

function captureValues(captureRules, data, context) {
  const captured = [];

  for (const rule of captureRules ?? []) {
    const selected = selectJsonPath(data, rule.path);
    if (!selected.found) {
      throw new Error(`Khong capture duoc ${rule.name} tu path ${rule.path}.`);
    }

    context.captures[rule.name] = selected.value;
    if (rule.sensitive !== false) {
      scalarSensitiveValues(selected.value, context.sensitiveValues);
    }
    captured.push({
      name: rule.name,
      path: rule.path,
      sensitive: rule.sensitive !== false,
      count: Array.isArray(selected.value) ? selected.value.length : 1,
    });
  }

  return captured;
}

export async function executeHttpApiVerifier(
  verifier,
  context,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== "function") {
    return {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success: false,
      failureCode: "HTTP_RUNTIME_UNAVAILABLE",
      summary: "Runtime khong co fetch().",
      steps: [],
    };
  }

  const results = [];

  for (const step of verifier.steps) {
    const started = nowMs();
    const controller = new AbortController();
    const timeoutMs = step.timeoutMs ?? verifier.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = assertHttpUrl(
        renderTemplate(step.url, context),
        context.networkPolicy
      );
      const headers = renderTemplate(step.headers ?? {}, context);
      const jsonBody = step.json === undefined
        ? undefined
        : renderTemplate(step.json, context);
      const requestHeaders = {
        accept: "application/json",
        ...headers,
      };

      let body;
      if (jsonBody !== undefined) {
        requestHeaders["content-type"] ??= "application/json";
        body = JSON.stringify(jsonBody);
      }

      const response = await fetchImpl(url, {
        method: step.method,
        headers: requestHeaders,
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      assertHttpUrl(response.url || url, context.networkPolicy);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          const redirectUrl = new URL(location, url).href;
          assertHttpUrl(redirectUrl, context.networkPolicy);
        }
        throw new Error("HTTP redirect bi chan; hay dung endpoint cuoi truc tiep.");
      }
      const text = await readResponseBody(response);
      const data = parseResponse(
        text,
        response.headers.get("content-type") ?? ""
      );
      const assertions = evaluateHttpExpectations(step.expect, response.status, data);
      const passed = assertions.every((item) => item.success);
      let captured = [];

      if (passed) {
        captured = captureValues(step.capture, data, context);
      }

      results.push({
        id: step.id,
        success: passed,
        failureCode: passed ? null : httpFailureCode(assertions, response.status),
        status: response.status,
        durationMs: nowMs() - started,
        assertions,
        captured,
        responsePreview: responsePreview(
          sanitizeEvidence(data, [...context.sensitiveValues])
        ),
      });

      if (!passed) {
        break;
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      const timedOut = error?.name === "AbortError";
      const failureCode = /Secret env chua duoc cau hinh/.test(message)
        ? "SECRET_MISSING"
        : /Capture chua ton tai|Khong capture duoc/.test(message)
          ? "CAPTURE_MISSING"
          : /Network host khong nam trong allowlist/.test(message)
            ? "NETWORK_HOST_BLOCKED"
            : /HTTP redirect bi chan/.test(message)
              ? "HTTP_REDIRECT_BLOCKED"
              : /chi cho phep HTTPS/.test(message)
                ? "INSECURE_HTTP_URL"
                : timedOut
                  ? "HTTP_TIMEOUT"
                  : "HTTP_NETWORK_ERROR";
      results.push({
        id: step.id,
        success: false,
        failureCode,
        durationMs: nowMs() - started,
        error: message,
      });
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  const success = results.length === verifier.steps.length && results.every((step) => step.success);
  const failure = results.find((step) => !step.success);
  return sanitizeEvidence(
    {
      id: verifier.id,
      type: verifier.type,
      required: verifier.required,
      success,
      failureCode: failure?.failureCode ?? null,
      summary: success
        ? `HTTP API verifier passed ${results.length}/${verifier.steps.length} step(s).`
        : `HTTP API verifier failed at ${failure?.id ?? "unknown"}: ${failure?.failureCode ?? "HTTP_FAILED"}.`,
      steps: results,
    },
    [...context.sensitiveValues]
  );
}

function decodeWebSocketData(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return String(data ?? "");
}

function parseWebSocketMessage(data) {
  const text = decodeWebSocketData(data);
  try {
    return { raw: text, json: JSON.parse(text) };
  } catch {
    return { raw: text, json: null };
  }
}

function messageMatches(message, rule) {
  if (!rule) {
    return true;
  }

  if (rule.contains !== undefined) {
    return message.raw.includes(String(rule.contains));
  }

  if (rule.jsonPath) {
    const selected = selectJsonPath(message.json, rule.jsonPath);
    if (!selected.found) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
      return selected.values.some(
        (value) => JSON.stringify(value) === JSON.stringify(rule.equals)
      );
    }
    return true;
  }

  return true;
}

function evaluateWsMatchRule(messages, rule, context) {
  let count = 0;
  let unknownCount = 0;
  const allowedValues = rule.inCapture
    ? context.captures[rule.inCapture]
    : null;
  const allowed = rule.inCapture
    ? new Set(
        (Array.isArray(allowedValues) ? allowedValues : [allowedValues]).map(
          (value) => JSON.stringify(value)
        )
      )
    : null;

  if (rule.inCapture && !Object.prototype.hasOwnProperty.call(context.captures, rule.inCapture)) {
    throw new Error(`Capture chua ton tai: ${rule.inCapture}`);
  }

  for (const message of messages) {
    if (rule.contains !== undefined) {
      if (message.raw.includes(String(rule.contains))) {
        count += 1;
      }
      continue;
    }

    const selected = selectJsonPath(message.json, rule.jsonPath);
    if (!selected.found) {
      continue;
    }

    let matched = true;
    if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
      matched = selected.values.some(
        (value) => JSON.stringify(value) === JSON.stringify(rule.equals)
      );
    }

    if (allowed) {
      const inAllowed = selected.values.some((value) =>
        allowed.has(JSON.stringify(value))
      );
      if (!inAllowed) {
        unknownCount += 1;
      }
      matched = matched && inAllowed;
    }

    if (matched) {
      count += 1;
    }
  }

  return { count, unknownCount };
}

function addSocketListener(socket, event, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, handler);
    return () => socket.removeEventListener?.(event, handler);
  }
  if (typeof socket.on === "function") {
    socket.on(event, handler);
    return () => socket.off?.(event, handler);
  }
  throw new Error("WebSocket implementation khong ho tro event listeners.");
}

function socketEventData(event) {
  return event?.data !== undefined ? event.data : event;
}

function waitForOpen(socket, timeoutMs) {
  if (
    typeof socket?.readyState === "number" &&
    (socket.readyState === 1 ||
      (typeof socket.OPEN === "number" && socket.readyState === socket.OPEN))
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("WebSocket open timeout.")), timeoutMs);
    const cleanup = [];

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const dispose of cleanup) dispose();
      error ? reject(error) : resolve();
    }

    cleanup.push(addSocketListener(socket, "open", () => finish()));
    cleanup.push(addSocketListener(socket, "error", () => finish(new Error("WebSocket connection error."))));
    cleanup.push(addSocketListener(socket, "close", () => finish(new Error("WebSocket closed before open."))));
  });
}

function createMessageCollector(socket) {
  const messages = [];
  const waiters = new Set();
  const closeWaiters = new Set();
  let closed = false;
  let collectorError = null;

  const disposeMessage = addSocketListener(socket, "message", (event) => {
    const parsed = parseWebSocketMessage(socketEventData(event));
    const messageBytes = Buffer.byteLength(parsed.raw, "utf8");

    if (messageBytes > MAX_WS_MESSAGE_BYTES) {
      collectorError = {
        code: "WS_MESSAGE_TOO_LARGE",
        message: `WebSocket message vuot ${MAX_WS_MESSAGE_BYTES} bytes.`,
      };
      socket.close?.();
      return;
    }

    if (messages.length >= MAX_WS_MESSAGES) {
      collectorError = {
        code: "WS_MESSAGE_LIMIT_EXCEEDED",
        message: `WebSocket vuot ${MAX_WS_MESSAGES} messages.`,
      };
      socket.close?.();
      return;
    }

    messages.push(parsed);
    for (const waiter of [...waiters]) {
      waiter(parsed);
    }
  });
  const disposeClose = addSocketListener(socket, "close", () => {
    closed = true;
    for (const waiter of [...closeWaiters]) {
      waiter();
    }
  });

  function waitFor(rule, timeoutMs) {
    const existing = messages.find((message) => messageMatches(message, rule));
    if (existing) {
      return Promise.resolve(existing);
    }
    if (closed) {
      return Promise.reject(new Error("WebSocket disconnected."));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("WebSocket expected message timeout.")), timeoutMs);

      function finish(error, message) {
        clearTimeout(timer);
        waiters.delete(onMessage);
        closeWaiters.delete(onClose);
        error ? reject(error) : resolve(message);
      }

      function onMessage(message) {
        if (!messageMatches(message, rule)) return;
        finish(null, message);
      }

      function onClose() {
        finish(new Error("WebSocket disconnected."));
      }

      waiters.add(onMessage);
      closeWaiters.add(onClose);
    });
  }

  async function waitForCount(minMessages, timeoutMs) {
    if (messages.length >= minMessages) {
      return;
    }

    const started = nowMs();
    while (messages.length < minMessages) {
      if (closed) {
        throw new Error("WebSocket disconnected.");
      }
      const remaining = timeoutMs - (nowMs() - started);
      if (remaining <= 0) {
        throw new Error("WebSocket minMessages timeout.");
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("WebSocket minMessages timeout.")), remaining);

        function finish(error) {
          clearTimeout(timer);
          waiters.delete(onMessage);
          closeWaiters.delete(onClose);
          error ? reject(error) : resolve();
        }

        function onMessage() {
          finish();
        }

        function onClose() {
          finish(new Error("WebSocket disconnected."));
        }

        waiters.add(onMessage);
        closeWaiters.add(onClose);
      });
    }
  }

  function dispose() {
    disposeMessage();
    disposeClose();
    waiters.clear();
    closeWaiters.clear();
  }

  return {
    messages,
    waitFor,
    waitForCount,
    dispose,
    get closed() {
      return closed;
    },
    get error() {
      return collectorError;
    },
  };
}

async function webSocketFactoryDefault(url, protocols) {
  let WebSocketClient = globalThis.WebSocket;

  if (typeof WebSocketClient !== "function") {
    try {
      const module = await import("ws");
      WebSocketClient = module.WebSocket ?? module.default;
    } catch {
      throw new Error(
        "Runtime khong co WebSocket client; can Node co WebSocket native hoac package ws."
      );
    }
  }

  return protocols?.length
    ? new WebSocketClient(url, protocols)
    : new WebSocketClient(url);
}

function sendSocketPayload(socket, payload) {
  const rendered = typeof payload === "string" ? payload : JSON.stringify(payload);
  socket.send(rendered);
}

function captureFromMessage(captureRules, message, context) {
  if (!captureRules?.length) return [];
  if (!message?.json) {
    throw new Error("Khong the capture JSON tu WebSocket message khong phai JSON.");
  }
  return captureValues(captureRules, message.json, context);
}

async function executeSequenceAction(action, socket, collector, context, defaultTimeoutMs) {
  const iterations = action.forEachCapture
    ? context.captures[action.forEachCapture]
    : [null];

  if (action.forEachCapture && !Array.isArray(iterations)) {
    throw new Error(`Capture ${action.forEachCapture} khong phai array.`);
  }

  const results = [];
  for (let index = 0; index < iterations.length; index += 1) {
    const previousItem = context.captures.__item;
    const previousIndex = context.captures.__index;
    if (action.forEachCapture) {
      context.captures.__item = iterations[index];
      context.captures.__index = index;
    }

    try {
      if (action.send !== undefined) {
        sendSocketPayload(socket, renderTemplate(action.send, context));
      }

      let matched = null;
      if (action.waitFor) {
        const renderedRule = renderTemplate(action.waitFor, context);
        matched = await collector.waitFor(
          renderedRule,
          action.timeoutMs ?? defaultTimeoutMs
        );
      }

      const captured = captureFromMessage(action.capture, matched, context);
      results.push({
        success: true,
        index,
        captured,
      });
    } finally {
      if (action.forEachCapture) {
        if (previousItem === undefined) delete context.captures.__item;
        else context.captures.__item = previousItem;
        if (previousIndex === undefined) delete context.captures.__index;
        else context.captures.__index = previousIndex;
      }
    }
  }

  return results;
}

export async function executeWebSocketProbeVerifier(
  verifier,
  context,
  { webSocketFactory = webSocketFactoryDefault } = {}
) {
  const timeoutMs = verifier.timeoutMs ?? DEFAULT_WS_TIMEOUT_MS;
  const started = nowMs();
  let socket;
  let collector;

  try {
    const url = assertWebSocketUrl(
      renderTemplate(verifier.url, context),
      context.networkPolicy
    );
    const protocols = renderTemplate(verifier.protocols ?? [], context);
    socket = await webSocketFactory(url, protocols);
    collector = createMessageCollector(socket);
    await waitForOpen(socket, timeoutMs);

    const sequenceResults = [];
    for (const action of verifier.sequence ?? []) {
      try {
        const results = await executeSequenceAction(
          action,
          socket,
          collector,
          context,
          timeoutMs
        );
        sequenceResults.push({
          id: action.id,
          success: true,
          iterations: results.length,
        });
      } catch (error) {
        const failureCode =
          collector.error?.code ??
          action.failureCode ??
          "WS_SEQUENCE_FAILED";
        sequenceResults.push({
          id: action.id,
          success: false,
          failureCode,
          error: collector.error?.message ?? error.message,
        });
        return sanitizeEvidence(
          {
            id: verifier.id,
            type: verifier.type,
            required: verifier.required,
            success: false,
            failureCode,
            summary: `WebSocket verifier failed at ${action.id}.`,
            durationMs: nowMs() - started,
            messagesReceived: collector.messages.length,
            sequence: sequenceResults,
          },
          [...context.sensitiveValues]
        );
      }
    }

    const minMessages = verifier.expect?.minMessages ?? 0;
    if (minMessages > 0) {
      try {
        await collector.waitForCount(minMessages, verifier.expect?.timeoutMs ?? timeoutMs);
      } catch (error) {
        return sanitizeEvidence(
          {
            id: verifier.id,
            type: verifier.type,
            required: verifier.required,
            success: false,
            failureCode:
              collector.error?.code ??
              (collector.closed ? "WS_DISCONNECTED" : "WS_NO_TELEMETRY"),
            summary:
              collector.error?.message ??
              (collector.closed
                ? `WebSocket disconnected after ${collector.messages.length} message(s).`
                : `WebSocket received ${collector.messages.length}/${minMessages} required message(s).`),
            durationMs: nowMs() - started,
            messagesReceived: collector.messages.length,
            sequence: sequenceResults,
          },
          [...context.sensitiveValues]
        );
      }
    }

    const matchEvidence = [];
    for (const rule of verifier.expect?.matches ?? []) {
      const ruleStarted = nowMs();
      let evaluation;

      try {
        evaluation = evaluateWsMatchRule(collector.messages, rule, context);
        while (
          evaluation.count < rule.minMatches &&
          !(rule.rejectUnknown && evaluation.unknownCount > 0)
        ) {
          const remaining =
            (verifier.expect?.timeoutMs ?? timeoutMs) -
            (nowMs() - ruleStarted);
          if (remaining <= 0) {
            break;
          }
          await collector.waitForCount(
            collector.messages.length + 1,
            remaining
          );
          evaluation = evaluateWsMatchRule(
            collector.messages,
            rule,
            context
          );
        }
      } catch (error) {
        const failureCode =
          collector.error?.code ??
          (/Capture chua ton tai/.test(error.message ?? "")
            ? "CAPTURE_MISSING"
            : collector.closed
              ? "WS_DISCONNECTED"
              : "WS_MESSAGE_MISMATCH");
        return sanitizeEvidence(
          {
            id: verifier.id,
            type: verifier.type,
            required: verifier.required,
            success: false,
            failureCode,
            summary: `WebSocket message rule failed: ${error.message}`,
            durationMs: nowMs() - started,
            messagesReceived: collector.messages.length,
            sequence: sequenceResults,
            matches: matchEvidence,
          },
          [...context.sensitiveValues]
        );
      }

      const passed =
        evaluation.count >= rule.minMatches &&
        !(rule.rejectUnknown && evaluation.unknownCount > 0);
      matchEvidence.push({
        jsonPath: rule.jsonPath ?? null,
        contains: rule.contains ?? null,
        inCapture: rule.inCapture ?? null,
        minMatches: rule.minMatches,
        matched: evaluation.count,
        unknownCount: evaluation.unknownCount,
        rejectUnknown: rule.rejectUnknown === true,
        success: passed,
      });

      if (!passed) {
        return sanitizeEvidence(
          {
            id: verifier.id,
            type: verifier.type,
            required: verifier.required,
            success: false,
            failureCode:
              collector.error?.code ??
              (rule.rejectUnknown && evaluation.unknownCount > 0
                ? "WS_UNKNOWN_DEVICE"
                : collector.closed
                  ? "WS_DISCONNECTED"
                  : "WS_MESSAGE_MISMATCH"),
            summary:
              rule.rejectUnknown && evaluation.unknownCount > 0
                ? `WebSocket received ${evaluation.unknownCount} out-of-scope message value(s).`
                : `WebSocket matched ${evaluation.count}/${rule.minMatches} required message(s).`,
            durationMs: nowMs() - started,
            messagesReceived: collector.messages.length,
            sequence: sequenceResults,
            matches: matchEvidence,
          },
          [...context.sensitiveValues]
        );
      }
    }

    return sanitizeEvidence(
      {
        id: verifier.id,
        type: verifier.type,
        required: verifier.required,
        success: true,
        failureCode: null,
        summary: `WebSocket verifier passed with ${collector.messages.length} message(s).`,
        durationMs: nowMs() - started,
        messagesReceived: collector.messages.length,
        sequence: sequenceResults,
        matches: matchEvidence,
      },
      [...context.sensitiveValues]
    );
  } catch (error) {
    const message = error?.message ?? String(error);
    const runtimeUnavailable = /Runtime khong co WebSocket/.test(message);
    const timeout = /timeout/i.test(message);
    const missingSecret = /Secret env chua duoc cau hinh/.test(message);
    const missingCapture = /Capture chua ton tai/.test(message);
    const blockedHost = /Network host khong nam trong allowlist/.test(message);
    const insecureUrl = /chi cho phep WSS/.test(message);
    return sanitizeEvidence(
      {
        id: verifier.id,
        type: verifier.type,
        required: verifier.required,
        success: false,
        failureCode: missingSecret
          ? "SECRET_MISSING"
          : missingCapture
            ? "CAPTURE_MISSING"
            : blockedHost
              ? "NETWORK_HOST_BLOCKED"
              : insecureUrl
                ? "INSECURE_WS_URL"
                : runtimeUnavailable
                  ? "WS_RUNTIME_UNAVAILABLE"
                  : timeout
                    ? "WS_CONNECT_TIMEOUT"
                    : "WS_CONNECT_FAILED",
        summary: `WebSocket connect failed: ${message}`,
        durationMs: nowMs() - started,
      },
      [...context.sensitiveValues]
    );
  } finally {
    collector?.dispose?.();
    try {
      socket?.close?.();
    } catch {
      // Ignore close failures after evidence is already collected.
    }
  }
}

function assertSocketIoUrl(value, networkPolicy) {
  const url = new URL(value);
  assertAllowedHost(url, networkPolicy);
  if (["https:", "wss:"].includes(url.protocol)) {
    return url.href;
  }
  if (["http:", "ws:"].includes(url.protocol) && isLoopbackHostname(url.hostname)) {
    return url.href;
  }
  throw new Error("Socket.IO verifier chi cho phep HTTPS/WSS, tru loopback localhost.");
}

function socketIoPayloadMatches(payload, rule) {
  if (!rule) return true;
  if (rule.contains !== undefined) {
    return JSON.stringify(payload).includes(String(rule.contains));
  }
  if (rule.jsonPath) {
    const selected = selectJsonPath(payload, rule.jsonPath);
    if (!selected.found) return false;
    if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
      return selected.values.some(
        (value) => JSON.stringify(value) === JSON.stringify(rule.equals)
      );
    }
    return true;
  }
  return true;
}

function createSocketIoCollector(socket, eventNames) {
  const events = [];
  const disposers = [];

  for (const eventName of new Set(eventNames.filter(Boolean))) {
    const handler = (payload) => {
      if (events.length >= MAX_WS_MESSAGES) return;
      const serialized = JSON.stringify(payload ?? null);
      if (Buffer.byteLength(serialized, "utf8") > MAX_WS_MESSAGE_BYTES) return;
      events.push({ event: eventName, payload });
    };
    socket.on(eventName, handler);
    disposers.push(() => socket.off?.(eventName, handler));
  }

  function waitFor(eventName, rule, timeoutMs) {
    const existing = events.find(
      (item) => item.event === eventName && socketIoPayloadMatches(item.payload, rule)
    );
    if (existing) return Promise.resolve(existing.payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Socket.IO event timeout: ${eventName}`)), timeoutMs);

      function finish(error, payload) {
        clearTimeout(timer);
        socket.off?.(eventName, onEvent);
        socket.off?.("disconnect", onDisconnect);
        error ? reject(error) : resolve(payload);
      }

      function onEvent(payload) {
        if (!socketIoPayloadMatches(payload, rule)) return;
        finish(null, payload);
      }

      function onDisconnect(reason) {
        finish(new Error(`Socket.IO disconnected: ${reason ?? "unknown"}`));
      }

      socket.on(eventName, onEvent);
      socket.on("disconnect", onDisconnect);
    });
  }

  function dispose() {
    for (const dispose of disposers) dispose();
  }

  return { events, waitFor, dispose };
}

function evaluateSocketIoRule(events, rule, context) {
  const selectedEvents = events.filter((item) => item.event === rule.event);
  const allowedValues = rule.inCapture
    ? context.captures[rule.inCapture]
    : null;
  if (
    rule.inCapture &&
    !Object.prototype.hasOwnProperty.call(context.captures, rule.inCapture)
  ) {
    throw new Error(`Capture chua ton tai: ${rule.inCapture}`);
  }
  const allowed = rule.inCapture
    ? new Set(
        (Array.isArray(allowedValues) ? allowedValues : [allowedValues]).map(
          (value) => JSON.stringify(value)
        )
      )
    : null;
  let matched = 0;
  let unknownCount = 0;

  for (const item of selectedEvents) {
    if (rule.contains !== undefined) {
      if (JSON.stringify(item.payload).includes(String(rule.contains))) matched += 1;
      continue;
    }
    const selected = selectJsonPath(item.payload, rule.jsonPath);
    if (!selected.found) continue;
    let success = true;
    if (Object.prototype.hasOwnProperty.call(rule, "equals")) {
      success = selected.values.some(
        (value) => JSON.stringify(value) === JSON.stringify(rule.equals)
      );
    }
    if (allowed) {
      const inAllowed = selected.values.some((value) =>
        allowed.has(JSON.stringify(value))
      );
      if (!inAllowed) unknownCount += 1;
      success = success && inAllowed;
    }
    if (success) matched += 1;
  }

  return { matched, unknownCount };
}

function waitForSocketIoRule(socket, collector, rule, context, timeoutMs) {
  const initial = evaluateSocketIoRule(collector.events, rule, context);
  if (
    initial.matched >= rule.minMatches ||
    (rule.rejectUnknown && initial.unknownCount > 0)
  ) {
    return Promise.resolve(initial);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(), timeoutMs);

    function finish() {
      clearTimeout(timer);
      socket.off?.(rule.event, onEvent);
      resolve(evaluateSocketIoRule(collector.events, rule, context));
    }

    function onEvent() {
      const current = evaluateSocketIoRule(collector.events, rule, context);
      if (
        current.matched >= rule.minMatches ||
        (rule.rejectUnknown && current.unknownCount > 0)
      ) {
        finish();
      }
    }

    socket.on(rule.event, onEvent);
  });
}

async function defaultSocketIoFactory(url, options, context) {
  try {
    const requireFromWorkspace = createRequire(
      path.join(context.verificationRoot, "package.json")
    );
    const socketIoModule = requireFromWorkspace("socket.io-client");
    const io = socketIoModule.io ?? socketIoModule.default ?? socketIoModule;
    if (typeof io !== "function") {
      throw new Error("socket.io-client khong export io().");
    }
    return io(url, options);
  } catch (error) {
    throw new Error(`Khong load duoc socket.io-client tu target workspace: ${error.message}`);
  }
}

function waitForSocketIoConnect(socket, timeoutMs) {
  if (socket.connected === true) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Socket.IO connect timeout.")),
      timeoutMs
    );

    function finish(error) {
      clearTimeout(timer);
      socket.off?.("connect", onConnect);
      socket.off?.("connect_error", onError);
      error ? reject(error) : resolve();
    }

    function onConnect() {
      finish();
    }

    function onError(error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }

    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
  });
}

export async function executeSocketIoProbeVerifier(
  verifier,
  context,
  { socketIoFactory = defaultSocketIoFactory } = {}
) {
  const started = nowMs();
  const timeoutMs = verifier.timeoutMs ?? DEFAULT_WS_TIMEOUT_MS;
  let socket;
  let collector;

  try {
    const url = assertSocketIoUrl(
      renderTemplate(verifier.url, context),
      context.networkPolicy
    );
    const auth = renderTemplate(verifier.auth ?? {}, context);
    socket = await socketIoFactory(
      url,
      {
        transports: verifier.transports ?? ["websocket"],
        auth,
        reconnection: false,
        timeout: timeoutMs,
      },
      context
    );

    const eventNames = [
      ...(verifier.sequence ?? []).map((action) => action.waitFor?.event),
      ...(verifier.expect?.matches ?? []).map((rule) => rule.event),
    ];
    collector = createSocketIoCollector(socket, eventNames);
    await waitForSocketIoConnect(socket, timeoutMs);

    const sequenceEvidence = [];
    for (const action of verifier.sequence ?? []) {
      try {
        if (action.emit) {
          socket.emit(
            action.emit.event,
            renderTemplate(action.emit.payload ?? {}, context)
          );
        }
        let payload = null;
        if (action.waitFor) {
          const renderedRule = renderTemplate(action.waitFor, context);
          payload = await collector.waitFor(
            renderedRule.event,
            renderedRule,
            action.timeoutMs ?? timeoutMs
          );
        }
        const captured = captureValues(action.capture, payload, context);
        sequenceEvidence.push({
          id: action.id,
          success: true,
          captured,
        });
      } catch (error) {
        const failureCode = action.failureCode ?? "SOCKETIO_SEQUENCE_FAILED";
        return sanitizeEvidence(
          {
            id: verifier.id,
            type: verifier.type,
            required: verifier.required,
            success: false,
            failureCode,
            summary: `Socket.IO verifier failed at ${action.id}: ${error.message}`,
            durationMs: nowMs() - started,
            sequence: sequenceEvidence,
          },
          [...context.sensitiveValues]
        );
      }
    }

    const matchEvidence = [];
    for (const rule of verifier.expect?.matches ?? []) {
      const evaluation = await waitForSocketIoRule(
        socket,
        collector,
        rule,
        context,
        verifier.expect?.timeoutMs ?? timeoutMs
      );
      const success =
        evaluation.matched >= rule.minMatches &&
        !(rule.rejectUnknown && evaluation.unknownCount > 0);
      matchEvidence.push({
        event: rule.event,
        jsonPath: rule.jsonPath ?? null,
        inCapture: rule.inCapture ?? null,
        matched: evaluation.matched,
        minMatches: rule.minMatches,
        unknownCount: evaluation.unknownCount,
        success,
      });
      if (!success) {
        const failureCode =
          rule.rejectUnknown && evaluation.unknownCount > 0
            ? "SOCKETIO_UNKNOWN_DEVICE"
            : "SOCKETIO_NO_TELEMETRY";
        return sanitizeEvidence(
          {
            id: verifier.id,
            type: verifier.type,
            required: verifier.required,
            success: false,
            failureCode,
            summary:
              failureCode === "SOCKETIO_UNKNOWN_DEVICE"
                ? `Socket.IO received ${evaluation.unknownCount} out-of-scope value(s).`
                : `Socket.IO matched ${evaluation.matched}/${rule.minMatches} required event(s).`,
            durationMs: nowMs() - started,
            sequence: sequenceEvidence,
            matches: matchEvidence,
          },
          [...context.sensitiveValues]
        );
      }
    }

    return sanitizeEvidence(
      {
        id: verifier.id,
        type: verifier.type,
        required: verifier.required,
        success: true,
        failureCode: null,
        summary: `Socket.IO verifier passed with ${collector.events.length} observed event(s).`,
        durationMs: nowMs() - started,
        sequence: sequenceEvidence,
        matches: matchEvidence,
      },
      [...context.sensitiveValues]
    );
  } catch (error) {
    const message = error?.message ?? String(error);
    return sanitizeEvidence(
      {
        id: verifier.id,
        type: verifier.type,
        required: verifier.required,
        success: false,
        failureCode: /Secret env chua duoc cau hinh/.test(message)
          ? "SECRET_MISSING"
          : /Capture chua ton tai/.test(message)
            ? "CAPTURE_MISSING"
            : /Network host khong nam trong allowlist/.test(message)
              ? "NETWORK_HOST_BLOCKED"
              : /Khong load duoc socket.io-client/.test(message)
                ? "SOCKETIO_RUNTIME_UNAVAILABLE"
                : /timeout/i.test(message)
                  ? "SOCKETIO_CONNECT_TIMEOUT"
                  : "SOCKETIO_CONNECT_FAILED",
        summary: `Socket.IO connect failed: ${message}`,
        durationMs: nowMs() - started,
      },
      [...context.sensitiveValues]
    );
  } finally {
    collector?.dispose?.();
    try {
      socket?.disconnect?.();
    } catch {
      // Ignore disconnect failures after evidence collection.
    }
  }
}
