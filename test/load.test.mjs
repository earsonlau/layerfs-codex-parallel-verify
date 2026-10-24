import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSdk } from "../src/load.js";
import { pin } from "../src/pin.js";

test("a missing install names the pinned commit and does not throw a raw module error", async () => {
  await assert.rejects(() => loadSdk({}), (error) => {
    assert.equal(error.code, "InvalidInput");
    assert.match(error.message, new RegExp(pin.commit));
    assert.match(error.message, /@layerfs\/agent/);
    assert.match(error.message, /@layerfs\/runtime/);
    return true;
  });
});

test("LAYERFS_REPO loads the public entry points from a checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpv-repo-"));
  const agentDir = join(root, "api/agent/sdk/src");
  const runtimeDir = join(root, "api/runtime/src");
  await mkdir(agentDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(agentDir, "index.js"), "export class LayerFS { static open() { return null; } }\nexport const isRefusal = () => false;\n");
  await writeFile(join(runtimeDir, "index.js"), "export class LayerFSRuntime { static open() { return null; } }\n");
  const sdk = await loadSdk({ LAYERFS_REPO: root });
  assert.equal(typeof sdk.LayerFS.open, "function");
  assert.equal(typeof sdk.LayerFSRuntime.open, "function");
});

test("a checkout without the packages is refused once", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpv-empty-"));
  await assert.rejects(() => loadSdk({ LAYERFS_REPO: root }), (error) => {
    assert.equal(error.code, "InvalidInput");
    assert.match(error.message, /LAYERFS_REPO/);
    return true;
  });
});
