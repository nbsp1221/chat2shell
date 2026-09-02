import assert from "node:assert/strict";
import test from "node:test";
import { loadAppConfig } from "../src/config.js";

test("uses the complete public lifecycle policy", () => {
  const config = loadAppConfig({ HOME: "/tmp/chat2shell-config-test" });

  assert.equal(config.idleTimeoutMs, 24 * 60 * 60_000);
  assert.equal(config.workspaceRetentionMs, 30 * 24 * 60 * 60_000);
  assert.equal("maxLifetimeMs" in config, false);
});
