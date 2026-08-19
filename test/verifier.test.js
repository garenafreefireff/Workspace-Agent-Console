import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSldGeometry } from "../src/services/verifierService.js";

function validSnapshot() {
  return {
    nodes: [
      {
        id: "cb-1",
        center: { x: 100, y: 100 },
        symbolBounds: { x: 90, y: 90, width: 20, height: 20 },
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourcePoint: { x: 100, y: 120 },
        sourceAnchor: { x: 100, y: 120 },
        targetPoint: { x: 200, y: 220 },
        targetAnchor: { x: 200, y: 220 },
        points: [
          { x: 100, y: 120 },
          { x: 100, y: 220 },
          { x: 200, y: 220 },
        ],
      },
    ],
  };
}

test("SLD geometry verifier accepts aligned orthogonal geometry", () => {
  const result = evaluateSldGeometry(validSnapshot(), {
    tolerancePx: 0.1,
    requireSymbolCentering: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.metrics.alignedEndpoints, 2);
  assert.equal(result.metrics.orthogonalSegments, 2);
  assert.equal(result.metrics.centeredSymbols, 1);
});

test("SLD geometry verifier catches one-pixel endpoint drift", () => {
  const snapshot = validSnapshot();
  snapshot.edges[0].targetPoint = { x: 201, y: 220 };

  const result = evaluateSldGeometry(snapshot, {
    tolerancePx: 0.1,
  });

  assert.equal(result.success, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.code === "ENDPOINT_MISALIGNED" &&
        failure.edgeId === "edge-1" &&
        failure.dx === 1
    )
  );
});

test("SLD geometry verifier catches diagonal route segments", () => {
  const snapshot = validSnapshot();
  snapshot.edges[0].points = [
    { x: 100, y: 120 },
    { x: 150, y: 170 },
    { x: 200, y: 220 },
  ];

  const result = evaluateSldGeometry(snapshot, {
    tolerancePx: 0.1,
  });

  assert.equal(result.success, false);
  assert.ok(
    result.failures.some(
      (failure) => failure.code === "NON_ORTHOGONAL_SEGMENT"
    )
  );
});
