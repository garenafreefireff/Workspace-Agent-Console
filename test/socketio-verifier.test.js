import assert from "node:assert/strict";
import test from "node:test";
import { executeSocketIoProbeVerifier } from "../src/services/networkVerifierService.js";
import { normalizeVerifierSpecs } from "../src/services/verifierService.js";

class FakeSocketIo {
  constructor(expectedToken, actualToken, { unknownDevice = false } = {}) {
    this.listeners = new Map();
    this.connected = false;
    this.expectedToken = expectedToken;
    this.actualToken = actualToken;
    this.unknownDevice = unknownDevice;
    queueMicrotask(() => {
      if (this.actualToken !== this.expectedToken) {
        this.serverEmit("connect_error", new Error("unauthorized"));
        return;
      }
      this.connected = true;
      this.serverEmit("connect");
    });
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  serverEmit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }

  emit(event, payload) {
    if (event === "subscribe_devices") {
      const deviceIds = Array.isArray(payload?.deviceIds) ? payload.deviceIds : [];
      queueMicrotask(() => {
        this.serverEmit("subscribed", {
          results: deviceIds.map((deviceId) => ({ deviceId, status: "ok" })),
        });
        for (const [index, deviceId] of deviceIds.entries()) {
          this.serverEmit("telemetry_live_value", {
            deviceId:
              this.unknownDevice && index === deviceIds.length - 1
                ? "device-outside-scope"
                : deviceId,
            values: { active_power: { value: 100 + index } },
          });
        }
      });
    }
    return this;
  }

  disconnect() {
    this.connected = false;
  }
}

function rawVerifier() {
  return {
    id: "energy-socketio",
    type: "socketio_probe",
    url: "ws://127.0.0.1:9999/realtime",
    auth: { token: "{{capture:accessToken}}" },
    transports: ["websocket"],
    timeoutMs: 1000,
    sequence: [
      {
        id: "subscribe",
        emit: {
          event: "subscribe_devices",
          payload: { deviceIds: "{{capture:deviceIds}}" },
        },
        waitFor: {
          event: "subscribed",
          jsonPath: "results[0].status",
          equals: "ok",
        },
        failureCode: "SOCKETIO_SUBSCRIBE_FAILED",
      },
    ],
    expect: {
      timeoutMs: 1000,
      matches: [
        {
          event: "telemetry_live_value",
          jsonPath: "deviceId",
          inCapture: "deviceIds",
          minMatches: 2,
          rejectUnknown: true,
        },
      ],
    },
  };
}

test("Socket.IO verifier follows EnergyInsight subscribe/telemetry contract", async () => {
  const verifier = normalizeVerifierSpecs([rawVerifier()], "bess")[0];
  const token = "runtime-token-123456";
  const context = {
    verificationRoot: process.cwd(),
    env: {},
    captures: {
      accessToken: token,
      deviceIds: ["device-a", "device-b"],
    },
    sensitiveValues: new Set([token]),
    networkPolicy: { allowedHosts: [], allowLoopback: true },
  };

  const result = await executeSocketIoProbeVerifier(verifier, context, {
    socketIoFactory: async (_url, options) =>
      new FakeSocketIo(token, options.auth.token),
  });

  assert.equal(result.success, true);
  assert.equal(result.failureCode, null);
  assert.equal(result.matches[0].matched, 2);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("Socket.IO verifier rejects telemetry outside fetched device list", async () => {
  const verifier = normalizeVerifierSpecs([rawVerifier()], "bess")[0];
  const token = "runtime-token-123456";
  const context = {
    verificationRoot: process.cwd(),
    env: {},
    captures: {
      accessToken: token,
      deviceIds: ["device-a", "device-b"],
    },
    sensitiveValues: new Set([token]),
    networkPolicy: { allowedHosts: [], allowLoopback: true },
  };

  const result = await executeSocketIoProbeVerifier(verifier, context, {
    socketIoFactory: async (_url, options) =>
      new FakeSocketIo(token, options.auth.token, { unknownDevice: true }),
  });

  assert.equal(result.success, false);
  assert.equal(result.failureCode, "SOCKETIO_UNKNOWN_DEVICE");
});
