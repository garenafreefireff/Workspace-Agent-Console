import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  executeHttpApiVerifier,
  executeWebSocketProbeVerifier,
  selectJsonPath,
} from "../src/services/networkVerifierService.js";
import {
  renderTemplate,
  sanitizeEvidence,
} from "../src/services/secretService.js";
import { normalizeVerifierSpecs } from "../src/services/verifierService.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test("secret templates resolve in memory and evidence is redacted", () => {
  const sensitiveValues = new Set();
  const rendered = renderTemplate(
    {
      email: "{{secret:TEST_EMAIL}}",
      auth: "Bearer {{capture:accessToken}}",
    },
    {
      env: { TEST_EMAIL: "person@example.com" },
      captures: { accessToken: "secret-token-12345" },
      sensitiveValues,
    }
  );

  assert.equal(rendered.email, "person@example.com");
  assert.equal(rendered.auth, "Bearer secret-token-12345");
  assert.ok(sensitiveValues.has("person@example.com"));

  const sanitized = sanitizeEvidence(
    {
      password: "plain-password",
      log: "Authorization: Bearer secret-token-12345 for person@example.com",
    },
    ["secret-token-12345", "person@example.com"]
  );

  assert.equal(sanitized.password, "[REDACTED]");
  assert.equal(
    sanitized.log,
    "Authorization: Bearer [REDACTED] for [REDACTED]"
  );
  const assignment = sanitizeEvidence({
    diff: '+ const accessToken = "opaque-token-value"; password=plainpass',
  });
  assert.equal(assignment.diff.includes("opaque-token-value"), false);
  assert.equal(assignment.diff.includes("plainpass"), false);
});

test("JSON path selection supports array wildcards", () => {
  const selected = selectJsonPath(
    { devices: [{ id: "a" }, { id: "b" }] },
    "devices[*].id"
  );
  assert.equal(selected.found, true);
  assert.deepEqual(selected.value, ["a", "b"]);
});

test("network verifier specs reject inline password/token literals", () => {
  assert.throws(
    () =>
      normalizeVerifierSpecs(
        [
          {
            id: "unsafe-login",
            type: "http_api",
            steps: [
              {
                id: "login",
                method: "POST",
                url: "https://example.com/login",
                json: {
                  email: "person@example.com",
                  password: "plain-password",
                },
              },
            ],
          },
        ],
        "bess"
      ),
    /bat buoc dung secret\/capture template/
  );
});

test("network verifier specs allow secret/capture templates", () => {
  assert.doesNotThrow(() =>
    normalizeVerifierSpecs(
      [
        {
          id: "safe-flow",
          type: "http_api",
          steps: [
            {
              id: "login",
              method: "POST",
              url: "https://edge.energyinsight.vn/api/auth/login",
              json: {
                email: "{{secret:ENERGYINSIGHT_EMAIL}}",
                password: "{{secret:ENERGYINSIGHT_PASSWORD}}",
              },
            },
            {
              id: "devices",
              method: "GET",
              url: "https://edge.energyinsight.vn/api/devices/root?recursive=true",
              headers: {
                authorization: "Bearer {{capture:accessToken}}",
              },
            },
          ],
        },
      ],
      "bess"
    )
  );
});

test("HTTP verifier blocks hosts outside network allowlist before fetch", async () => {
  let fetchCalled = false;
  const result = await executeHttpApiVerifier(
    {
      id: "blocked-host",
      type: "http_api",
      required: true,
      timeoutMs: 1000,
      steps: [
        {
          id: "request",
          method: "GET",
          url: "https://example.com/data",
          headers: {},
          timeoutMs: 1000,
          expect: {
            status: [200],
            jsonPathExists: [],
            minArrayLength: [],
            uniqueBy: [],
          },
          capture: [],
        },
      ],
    },
    {
      env: {},
      captures: {},
      sensitiveValues: new Set(),
      networkPolicy: {
        allowedHosts: ["edge.energyinsight.vn"],
        allowLoopback: true,
      },
    },
    {
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not run");
      },
    }
  );

  assert.equal(fetchCalled, false);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "NETWORK_HOST_BLOCKED");
});

test("HTTP verifier captures token, reuses it, and redacts evidence", async () => {
  const token = "test-access-token-123456";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/login") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.email, "person@example.com");
      assert.equal(body.password, "correct-password");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accessToken: token }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          devices: [
            { id: "device-a", name: "A" },
            { id: "device-b", name: "B" },
          ],
        })
      );
      return;
    }

    response.writeHead(404).end();
  });
  const port = await listen(server);

  try {
    const context = {
      env: {
        TEST_EMAIL: "person@example.com",
        TEST_PASSWORD: "correct-password",
      },
      captures: {},
      sensitiveValues: new Set(),
    };
    const result = await executeHttpApiVerifier(
      {
        id: "api-flow",
        type: "http_api",
        required: true,
        timeoutMs: 5000,
        steps: [
          {
            id: "login",
            method: "POST",
            url: `http://127.0.0.1:${port}/login`,
            headers: {},
            json: {
              email: "{{secret:TEST_EMAIL}}",
              password: "{{secret:TEST_PASSWORD}}",
            },
            timeoutMs: 5000,
            expect: {
              status: [200],
              jsonPathExists: ["accessToken"],
              minArrayLength: [],
              uniqueBy: [],
            },
            capture: [
              {
                name: "accessToken",
                path: "accessToken",
                sensitive: true,
              },
            ],
          },
          {
            id: "devices",
            method: "GET",
            url: `http://127.0.0.1:${port}/devices`,
            headers: {
              authorization: "Bearer {{capture:accessToken}}",
            },
            timeoutMs: 5000,
            expect: {
              status: [200],
              jsonPathExists: ["devices"],
              minArrayLength: [{ path: "devices", min: 2 }],
              uniqueBy: [{ path: "devices", key: "id" }],
            },
            capture: [
              {
                name: "deviceIds",
                path: "devices[*].id",
                sensitive: false,
              },
            ],
          },
        ],
      },
      context
    );

    assert.equal(result.success, true);
    assert.equal(context.captures.accessToken, token);
    assert.deepEqual(context.captures.deviceIds, ["device-a", "device-b"]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("correct-password"), false);
  } finally {
    await close(server);
  }
});

class FakeWebSocket {
  constructor({ forceDeviceId = null } = {}) {
    this.listeners = new Map();
    this.sent = [];
    this.forceDeviceId = forceDeviceId;
    this.readyState = 0;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(event, handler) {
    const list = this.listeners.get(event) ?? new Set();
    list.add(handler);
    this.listeners.set(event, list);
  }

  removeEventListener(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    if (event === "open") this.readyState = 1;
    if (event === "close") this.readyState = 3;
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }

  send(payload) {
    this.sent.push(payload);
    const message = JSON.parse(payload);

    if (message.type === "auth") {
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({ type: "auth_ok" }),
        })
      );
      return;
    }

    if (message.type === "subscribe") {
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            type: "telemetry",
            deviceId: this.forceDeviceId ?? message.deviceId,
            value: 123,
          }),
        })
      );
    }
  }

  close() {}
}

test("WebSocket probe authenticates, subscribes per device, and receives telemetry", async () => {
  const token = "ws-secret-token-123456";
  let socket;
  const context = {
    env: {},
    captures: {
      accessToken: token,
      deviceIds: ["device-a", "device-b"],
    },
    sensitiveValues: new Set([token]),
  };

  const result = await executeWebSocketProbeVerifier(
    {
      id: "ws-flow",
      type: "websocket_probe",
      required: true,
      url: "ws://127.0.0.1:9999/socket",
      protocols: [],
      timeoutMs: 1000,
      sequence: [
        {
          id: "auth",
          send: {
            type: "auth",
            token: "{{capture:accessToken}}",
          },
          waitFor: { jsonPath: "type", equals: "auth_ok" },
          timeoutMs: 1000,
          forEachCapture: null,
          capture: [],
          failureCode: "WS_AUTH_FAILED",
        },
        {
          id: "subscribe",
          send: {
            type: "subscribe",
            deviceId: "{{capture:__item}}",
          },
          timeoutMs: 1000,
          forEachCapture: "deviceIds",
          capture: [],
          failureCode: "WS_SUBSCRIBE_FAILED",
        },
      ],
      expect: {
        minMessages: 3,
        timeoutMs: 1000,
        matches: [
          {
            jsonPath: "type",
            equals: "telemetry",
            inCapture: null,
            minMatches: 2,
            rejectUnknown: false,
          },
          {
            jsonPath: "deviceId",
            inCapture: "deviceIds",
            minMatches: 2,
            rejectUnknown: true,
          },
        ],
      },
    },
    context,
    {
      webSocketFactory: () => {
        socket = new FakeWebSocket();
        return socket;
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.messagesReceived, 3);
  assert.equal(socket.sent.length, 3);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
});

test("WebSocket probe rejects telemetry from unknown device IDs", async () => {
  const context = {
    env: {},
    captures: {
      deviceIds: ["device-a"],
    },
    sensitiveValues: new Set(),
  };

  const result = await executeWebSocketProbeVerifier(
    {
      id: "ws-unknown-device",
      type: "websocket_probe",
      required: true,
      url: "ws://127.0.0.1:9999/socket",
      protocols: [],
      timeoutMs: 1000,
      sequence: [
        {
          id: "subscribe",
          send: {
            type: "subscribe",
            deviceId: "device-a",
          },
          timeoutMs: 1000,
          forEachCapture: null,
          capture: [],
          failureCode: "WS_SUBSCRIBE_FAILED",
        },
      ],
      expect: {
        minMessages: 1,
        timeoutMs: 1000,
        matches: [
          {
            jsonPath: "deviceId",
            inCapture: "deviceIds",
            minMatches: 1,
            rejectUnknown: true,
          },
        ],
      },
    },
    context,
    {
      webSocketFactory: () =>
        new FakeWebSocket({ forceDeviceId: "device-outside-scope" }),
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.failureCode, "WS_UNKNOWN_DEVICE");
});
