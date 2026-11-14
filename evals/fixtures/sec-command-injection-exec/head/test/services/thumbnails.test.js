"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createThumbnail, ALLOWED_WIDTHS } = require("../../src/services/thumbnails");

test("rejects widths outside the allow-list", async () => {
  await assert.rejects(createThumbnail("1700000000000-photo.png", 300), RangeError);
});

test("allow-list contains the sizes the web client requests", () => {
  assert.deepEqual([...ALLOWED_WIDTHS].sort((a, b) => a - b), [64, 128, 256, 512]);
});
