"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { retry } = require("../../src/lib/retry");

test("returns the first successful result", async () => {
  let calls = 0;
  const result = await retry(
    async () => {
      calls++;
      if (calls < 2) throw new Error("flaky");
      return "ok";
    },
    { attempts: 3, delayMs: 1 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("rethrows the last error when attempts run out", async () => {
  await assert.rejects(retry(async () => Promise.reject(new Error("down")), { attempts: 2, delayMs: 1 }), /down/);
});

test("does not retry errors rejected by shouldRetry", async () => {
  let calls = 0;
  const declined = Object.assign(new Error("declined"), { code: "card_declined" });
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw declined;
      },
      { attempts: 5, delayMs: 1, shouldRetry: (err) => err.code !== "card_declined" },
    ),
    /declined/,
  );
  assert.equal(calls, 1);
});
