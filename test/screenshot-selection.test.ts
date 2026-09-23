// The screenshot failure messages must report what was checked, never assert an unverified cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureTimeoutMessage, selectionTimeoutMessage } from "../src/figma-web.ts";

test("selection timeout reports the wait and marks the causes it did not check", () => {
  const m = selectionTimeoutMessage("AbCdEf1234567890XyZ", "1190:37798", { ids: [], readable: true, matched: false, waitedMs: 20_000 });
  assert.match(m, /1190:37798/);
  assert.match(m, /node-id=1190-37798/);
  assert.match(m, /20\.0s/);
  assert.match(m, /Checked:/);
  assert.match(m, /Not checked:/);
  assert.match(m, /selection stayed empty/);
  // The old message stated "node missing or hidden" as fact without ever testing it.
  assert.doesNotMatch(m, /node missing or hidden/);
});

test("selection timeout names the nodes Figma selected instead", () => {
  const m = selectionTimeoutMessage("KEY", "1:2", { ids: ["9:9"], readable: true, matched: false, waitedMs: 3000 });
  assert.match(m, /Figma selected 9:9 instead/);
  assert.doesNotMatch(m, /stayed empty/);
});

test("capture timeout names the selection it actually observed", () => {
  const m = captureTimeoutMessage({
    nodeId: "1190:37798",
    selection: { ids: ["1190:37798"], readable: true, waitedMs: 900 },
    attempts: 2,
    waitedMs: 30_000,
    selectAll: false,
  });
  assert.match(m, /2 attempt\(s\)/);
  assert.match(m, /30\.0s/);
  assert.match(m, /1 node\(s\): 1190:37798/);
  assert.match(m, /Not checked:/);
});

test("capture timeout distinguishes an empty selection from an uninspectable one", () => {
  const empty = captureTimeoutMessage({
    nodeId: "1:2",
    selection: { ids: [], readable: true, waitedMs: 0 },
    attempts: 1,
    waitedMs: 1000,
    selectAll: true,
  });
  assert.match(empty, /selection was empty/);
  assert.match(empty, /select-all was used/);

  const unknown = captureTimeoutMessage({
    nodeId: "1:2",
    selection: { ids: null, readable: false, waitedMs: 0 },
    attempts: 1,
    waitedMs: 1000,
    selectAll: false,
  });
  assert.match(unknown, /could not be inspected/);
  assert.doesNotMatch(unknown, /selection was empty/);
});
