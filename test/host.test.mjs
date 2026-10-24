import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageError } from "../src/errors.js";
import { endpointFile, openHost, storeFile } from "../src/host.js";
import { scriptedRuntime } from "./helpers.mjs";

test("linux does not start a worker", async () => {
  const home = await mkdtemp(join(tmpdir(), "cpv-host-"));
  const previous = process.env.LAYERFS_WORKER_ENDPOINT;
  delete process.env.LAYERFS_WORKER_ENDPOINT;
  const runtime = scriptedRuntime({ home, platform: "linux" });
  try {
    const opened = await openHost({ home, sweep: false }, {
      LayerFSRuntime: { async open() { return runtime; } },
    });
    assert.equal(opened, runtime);
    assert.equal(runtime.calls.some((call) => call[0] === "worker.start"), false);
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, undefined);
  } finally {
    if (previous === undefined) delete process.env.LAYERFS_WORKER_ENDPOINT;
    else process.env.LAYERFS_WORKER_ENDPOINT = previous;
  }
});

test("macOS starts the worker once and sets LAYERFS_WORKER_ENDPOINT", async () => {
  const home = await mkdtemp(join(tmpdir(), "cpv-host-"));
  const previous = process.env.LAYERFS_WORKER_ENDPOINT;
  delete process.env.LAYERFS_WORKER_ENDPOINT;
  const runtime = scriptedRuntime({ home, platform: "macos" });
  try {
    await openHost({ home }, { LayerFSRuntime: { async open() { return runtime; } } });
    assert.equal(runtime.calls.filter((call) => call[0] === "worker.start").length, 1);
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, endpointFile(home));
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, join(home, "worker", "endpoint.json"));
  } finally {
    if (previous === undefined) delete process.env.LAYERFS_WORKER_ENDPOINT;
    else process.env.LAYERFS_WORKER_ENDPOINT = previous;
  }
});

test("a failed worker start is not repeated and does not set the endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "cpv-host-"));
  const previous = process.env.LAYERFS_WORKER_ENDPOINT;
  delete process.env.LAYERFS_WORKER_ENDPOINT;
  const runtime = scriptedRuntime({ home, platform: "windows" });
  runtime.worker.start = async () => {
    runtime.calls.push(["worker.start", []]);
    const error = new Error("docker failed");
    error.code = "Failed";
    throw error;
  };
  try {
    await assert.rejects(
      () => openHost({ home }, { LayerFSRuntime: { async open() { return runtime; } } }),
      (error) => error.code === "Failed",
    );
    assert.equal(runtime.calls.filter((call) => call[0] === "worker.start").length, 1);
    assert.equal(runtime.calls.filter((call) => call[0] === "runtime.close").length, 1);
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, undefined);
  } finally {
    if (previous === undefined) delete process.env.LAYERFS_WORKER_ENDPOINT;
    else process.env.LAYERFS_WORKER_ENDPOINT = previous;
  }
});

test("a relative home is refused before the runtime opens", async () => {
  let opened = false;
  await assert.rejects(
    () => openHost({ home: "relative" }, { LayerFSRuntime: { async open() { opened = true; } } }),
    UsageError,
  );
  assert.equal(opened, false);
});

test("store file path follows the platform", () => {
  assert.equal(
    storeFile({ platform: "linux", volumes: "/volumes" }, "vol"),
    "/volumes/vol/_data/global/store.sqlite",
  );
  assert.equal(
    storeFile({ platform: "macos", volumes: "/ignored" }, "vol"),
    "/var/lib/docker/volumes/vol/_data/global/store.sqlite",
  );
});
