"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isNewerVersion } = require("../src/version");

test("release versions are compared numerically", () => {
  assert.equal(isNewerVersion("1.0.1", "1.0.0"), true);
  assert.equal(isNewerVersion("v1.2.0", "1.1.9"), true);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", "1.0.1"), false);
  assert.equal(isNewerVersion("2.0", "1.9.9"), true);
});
