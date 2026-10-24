import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { endpointFile } from "../src/host.js";
import { capture, scriptedClient, scriptedLayerFS, scriptedRuntime, tempDirs } from "./helpers.mjs";

function sdkFor(runtime, client = scriptedClient()) {
  return {
    runtime,
    client,
    LayerFS: scriptedLayerFS(client),
    LayerFSRuntime: { async open() { return runtime; } },
  };
}

test("help mentions -C and the four commands without opening LayerFS", async () => {
  let opened = false;
  const io = capture();
  const code = await main(["--help"], {
    io,
    sdk: { LayerFSRuntime: { async open() { opened = true; } }, LayerFS: {} },
  });
  assert.equal(code, 0);
  assert.equal(opened, false);
  assert.match(io.out(), /codex exec -C/);
  assert.match(io.out(), /--worktree/);
  for (const command of ["init", "spawn-n", "verify-all", "report"]) {
    assert.match(io.out(), new RegExp(command));
  }
});

test("bad usage exits 2 before the runtime opens", async () => {
  let opened = false;
  const io = capture();
  const previous = process.env.LAYERFS_HOME;
  delete process.env.LAYERFS_HOME;
  try {
    const missingHome = await main(["report", "--name", "shop"], {
      io,
      sdk: { LayerFSRuntime: { async open() { opened = true; } }, LayerFS: {} },
    });
    const missingSource = await main(["init", "--name", "shop", "--home", "/tmp/layerfs-home"], {
      io,
      sdk: { LayerFSRuntime: { async open() { opened = true; } }, LayerFS: {} },
    });
    assert.equal(missingHome, 2);
    assert.equal(missingSource, 2);
    assert.equal(opened, false);
  } finally {
    if (previous === undefined) delete process.env.LAYERFS_HOME;
    else process.env.LAYERFS_HOME = previous;
  }
});

test("init --json reports one Init and exits 0", async () => {
  const { home, source } = await tempDirs();
  const runtime = scriptedRuntime({ home, volumeSize: 2 });
  const bound = sdkFor(runtime);
  const io = capture();
  const code = await main([
    "init", "--name", "shop", "--source", source, "--home", home, "--json",
  ], { io, sdk: bound });
  assert.equal(code, 0);
  const body = JSON.parse(io.out());
  assert.equal(body.project, "shop");
  assert.equal(body.unitBytes, 4);
  assert.equal(namedCount(runtime, "project.start_init"), 1);
  assert.equal(namedCount(runtime, "worker.start"), 0);
  assert.equal(namedCount(runtime, "runtime.close"), 1);
});

test("macOS init starts the worker once and records its endpoint", async () => {
  const { home, source } = await tempDirs();
  const runtime = scriptedRuntime({ home, platform: "macos" });
  const previous = process.env.LAYERFS_WORKER_ENDPOINT;
  delete process.env.LAYERFS_WORKER_ENDPOINT;
  const io = capture();
  try {
    const code = await main([
      "init", "--name", "shop", "--source", source, "--home", home, "--json",
    ], { io, sdk: sdkFor(runtime) });
    assert.equal(code, 0);
    assert.equal(namedCount(runtime, "worker.start"), 1);
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, endpointFile(home));
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, join(home, "worker", "endpoint.json"));
  } finally {
    if (previous === undefined) delete process.env.LAYERFS_WORKER_ENDPOINT;
    else process.env.LAYERFS_WORKER_ENDPOINT = previous;
  }
});

test("a failed worker start exits 125 and is not tried again", async () => {
  const { home, source } = await tempDirs();
  const runtime = scriptedRuntime({ home, platform: "macos" });
  runtime.worker.start = async () => {
    runtime.calls.push(["worker.start", []]);
    const error = new Error("docker failed");
    error.code = "Failed";
    throw error;
  };
  const previous = process.env.LAYERFS_WORKER_ENDPOINT;
  delete process.env.LAYERFS_WORKER_ENDPOINT;
  const io = capture();
  try {
    const code = await main([
      "init", "--name", "shop", "--source", source, "--home", home, "--json",
    ], { io, sdk: sdkFor(runtime) });
    assert.equal(code, 125);
    assert.equal(namedCount(runtime, "worker.start"), 1);
    assert.equal(namedCount(runtime, "project.start_init"), 0);
    assert.equal(process.env.LAYERFS_WORKER_ENDPOINT, undefined);
    assert.match(io.err(), /Failed/);
  } finally {
    if (previous === undefined) delete process.env.LAYERFS_WORKER_ENDPOINT;
    else process.env.LAYERFS_WORKER_ENDPOINT = previous;
  }
});

test("verify-all --json exits 1 when a candidate fails and report prints the savings", async () => {
  const { home, source } = await tempDirs();
  const runtime = scriptedRuntime({ home, volumeSize: 2 });
  const client = scriptedClient({
    exec: async (ws) => ({
      exitCode: String(ws.path).endsWith("hyp-2") ? 1 : 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }),
  });
  const bound = sdkFor(runtime, client);
  const io = capture();
  assert.equal(await main(["init", "--name", "shop", "--source", source, "--home", home, "--json"], { io, sdk: bound }), 0);
  assert.equal(await main(["spawn-n", "--name", "shop", "--home", home, "--count", "2", "--prefix", "hyp", "--json"], { io, sdk: bound }), 0);
  const verifyIo = capture();
  const code = await main([
    "verify-all", "--name", "shop", "--home", home, "--command", "npm test", "--sequenced", "--json",
  ], { io: verifyIo, sdk: bound });
  assert.equal(code, 1);
  const report = JSON.parse(verifyIo.out());
  assert.equal(report.pass, 1);
  assert.equal(report.fail, 1);
  assert.equal(report.stored, 2);
  assert.equal(report.worktreeBaseline, 8);
  assert.equal(report.savedBytes, 6);
  assert.equal(namedCount(client, "workspace.exec"), 2);
  assert.equal(namedCount(client, "workspace.commit"), 2);
  const reportIo = capture();
  assert.equal(await main(["report", "--name", "shop", "--home", home], { io: reportIo, sdk: bound }), 0);
  assert.match(reportIo.out(), /worktree baseline/);
  assert.match(reportIo.out(), /saved/);
  const opens = bound.LayerFS.opens.length;
  const discardIo = capture();
  assert.equal(await main(["discard", "--name", "shop", "--home", home, "hyp-2"], { io: discardIo, sdk: bound }), 0);
  assert.equal(bound.LayerFS.opens.length, opens);
  assert.match(discardIo.out(), /hyp-2/);
});

function namedCount(target, name) {
  return target.calls.filter((call) => call[0] === name).length;
}
