import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initProject, makeReport, spawnN, verifyAll } from "../src/commands.js";
import { renderReport } from "../src/format.js";
import { loadLedger } from "../src/ledger.js";
import { SIZE_PROBE } from "../src/tree-bytes.js";
import { verifyBranches } from "../src/verify.js";
import { named, scriptedClient, scriptedLayerFS, scriptedRuntime, tempDirs } from "./helpers.mjs";

async function fixture(volumeSize = 2) {
  const dirs = await tempDirs();
  const runtime = scriptedRuntime({ home: dirs.home, volumeSize });
  const client = scriptedClient();
  const LayerFS = scriptedLayerFS(client);
  return { ...dirs, runtime, client, LayerFS };
}

test("init calls start_init once and does not open a Sandbox", async () => {
  const { home, source, runtime, client, LayerFS } = await fixture();
  const ledger = await initProject(runtime, LayerFS, { home, name: "shop", source });
  assert.equal(named(runtime.calls, "project.start_init").length, 1);
  assert.equal(named(runtime.calls, "project.get_init").length, 0);
  assert.equal(LayerFS.opens.length, 0);
  assert.equal(named(client.calls, "sandbox.create").length, 0);
  assert.equal(ledger.sourceBytes, 4);
  assert.equal(ledger.unitBytes, 4);
  assert.equal(ledger.unitBytesFrom, "source-scan");
  assert.equal(JSON.parse(await readFile(join(home, ".codex-parallel-verify", "shop.json"), "utf8")).project, "shop");
});

test("init polls the same job and does not start a second Init", async () => {
  const { home, source, runtime, LayerFS } = await fixture();
  let polls = 0;
  runtime.project.start_init = async (name, folder) => {
    runtime.calls.push(["project.start_init", [name, folder, {}]]);
    return { id: "job-9", name, ended: null, step: "import", project: null };
  };
  runtime.project.get_init = async (id) => {
    runtime.calls.push(["project.get_init", [id]]);
    polls += 1;
    if (polls < 2) return { id, ended: null, step: "import", project: null };
    return {
      id,
      ended: 1,
      step: "done",
      error: null,
      project: { ...runtime.projectApi, name: "shop", source },
    };
  };
  const ledger = await initProject(runtime, LayerFS, {
    home,
    name: "shop",
    source,
    sleep: async () => {},
  });
  assert.equal(ledger.project, "shop");
  assert.equal(named(runtime.calls, "project.start_init").length, 1);
  assert.equal(named(runtime.calls, "project.get_init").length, 2);
});

test("a refused Init is not retried", async () => {
  const { home, source, runtime, LayerFS } = await fixture();
  runtime.project.start_init = async () => {
    runtime.calls.push(["project.start_init", []]);
    const error = new Error("image is not a digest");
    error.code = "InvalidInput";
    throw error;
  };
  await assert.rejects(
    () => initProject(runtime, LayerFS, { home, name: "shop", source }),
    (error) => error.code === "InvalidInput",
  );
  assert.equal(named(runtime.calls, "project.start_init").length, 1);
  assert.equal(named(runtime.calls, "project.get_init").length, 0);
  await assert.rejects(readFile(join(home, ".codex-parallel-verify", "shop.json"), "utf8"));
});

test("install forks, commits, probes, and publishes once when the command exits 0", async () => {
  const { home, source, runtime, client, LayerFS } = await fixture();
  client.workspace.exec = async (ws, command) => {
    client.calls.push(["workspace.exec", [ws, command]]);
    if (command === SIZE_PROBE) return { exitCode: 0, stdout: "50", stderr: "", truncated: false };
    return { exitCode: 0, stdout: "", stderr: "", truncated: false };
  };
  const ledger = await initProject(runtime, LayerFS, { home, name: "shop", source, install: "npm ci" });
  assert.deepEqual(named(client.calls, "branch.fork").map((call) => call[1]), [["deps", "main"]]);
  assert.equal(named(client.calls, "workspace.exec").length, 2);
  assert.equal(named(client.calls, "workspace.commit").length, 1);
  assert.equal(named(client.calls, "branch.publish").length, 1);
  assert.deepEqual(named(client.calls, "branch.publish")[0][1], ["deps"]);
  assert.equal(named(client.calls, "workspace.unmount").length, 1);
  assert.equal(named(client.calls, "workspace.unmount")[0][1][1], false);
  assert.equal(named(client.calls, "sandbox.close").length, 1);
  assert.equal(ledger.unitBytes, 50);
  assert.equal(ledger.unitBytesFrom, "workspace-probe");
  assert.equal(ledger.install.pass, true);
});

test("a failing install is committed once and not published", async () => {
  const { home, source, runtime, client, LayerFS } = await fixture();
  client.workspace.exec = async (ws, command) => {
    client.calls.push(["workspace.exec", [ws, command]]);
    return { exitCode: 1, stdout: "", stderr: "no", truncated: false };
  };
  await assert.rejects(
    () => initProject(runtime, LayerFS, { home, name: "shop", source, install: "npm ci" }),
    (error) => error.code === "Failed",
  );
  assert.equal(named(client.calls, "workspace.exec").length, 1);
  assert.equal(named(client.calls, "workspace.commit").length, 1);
  assert.equal(named(client.calls, "branch.publish").length, 0);
  const ledger = loadLedger(home, "shop");
  assert.equal(ledger.install.pass, false);
  assert.equal(ledger.install.exitCode, 1);
});

test("spawn-n defaults to prefix hyp", async () => {
  const { home, runtime, client, LayerFS } = await fixture();
  const ledger = await spawnN(runtime, LayerFS, { home, name: "shop", count: 2 });
  const forks = named(client.calls, "branch.fork");
  assert.deepEqual(forks.map((call) => call[1][0]), ["hyp-1", "hyp-2"]);
  assert.deepEqual(ledger.requested, ["hyp-1", "hyp-2"]);
});

test("spawn-n forks each candidate once", async () => {
  const { home, source, runtime, client, LayerFS } = await fixture();
  await initProject(runtime, LayerFS, { home, name: "shop", source });
  const ledger = await spawnN(runtime, LayerFS, { home, name: "shop", count: 3, prefix: "hyp" });
  const forks = named(client.calls, "branch.fork");
  assert.deepEqual(forks.map((call) => call[1][0]), ["hyp-1", "hyp-2", "hyp-3"]);
  assert.ok(forks.every((call) => call[1][1] === "main"));
  assert.equal(ledger.branches.filter((branch) => branch.forked).length, 3);
  const again = await spawnN(runtime, LayerFS, { home, name: "shop", count: 3, prefix: "hyp" });
  assert.equal(named(client.calls, "branch.fork").length, 3);
  assert.equal(again.requested.length, 3);
  assert.equal(LayerFS.opens.length, 1);
});

test("a fork refusal is one attempt and does not stop the other candidates", async () => {
  const { home, source, runtime, client, LayerFS } = await fixture();
  await initProject(runtime, LayerFS, { home, name: "shop", source });
  client.branch.fork = async (name, from) => {
    client.calls.push(["branch.fork", [name, from]]);
    if (name === "hyp-1") {
      const error = new Error("taken");
      error.code = "Exists";
      throw error;
    }
    return { kind: "Forked", branch: name };
  };
  const ledger = await spawnN(runtime, LayerFS, { home, name: "shop", count: 2, prefix: "hyp" });
  assert.equal(named(client.calls, "branch.fork").length, 2);
  assert.equal(ledger.branches.find((branch) => branch.name === "hyp-1").error.code, "Exists");
  assert.equal(ledger.branches.find((branch) => branch.name === "hyp-2").forked, true);
});

test("verify keeps each workspace sequential and commits a non-zero exit", async () => {
  const client = scriptedClient({
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "fail", truncated: false }),
  });
  const { results } = await verifyBranches(client, { branches: ["hyp-1"], command: "npm test", jobs: 1 });
  assert.equal(results[0].pass, false);
  assert.equal(results[0].exitCode, 1);
  assert.equal(results[0].attempts.exec, 1);
  assert.equal(results[0].attempts.commit, 1);
  const order = client.calls.map((call) => call[0]);
  assert.deepEqual(order, [
    "sandbox.create",
    "workspace.mount",
    "workspace.exec",
    "workspace.commit",
    "workspace.unmount",
    "sandbox.close",
  ]);
  const commit = named(client.calls, "workspace.commit")[0][1];
  assert.equal(commit.length, 2);
  assert.match(commit[1], /verify hyp-1: npm test \(exit 1\)/);
  assert.equal(named(client.calls, "workspace.unmount")[0][1][1], false);
});

test("sequenced verify finishes one branch before mounting the next", async () => {
  const client = scriptedClient();
  await verifyBranches(client, { branches: ["hyp-1", "hyp-2"], command: "npm test", jobs: 1 });
  const steps = client.calls
    .filter((call) => call[0].startsWith("workspace."))
    .map((call) => `${call[0]}:${call[1][0].path ?? call[1][1]}`);
  assert.deepEqual(steps, [
    "workspace.mount:hyp-1",
    "workspace.exec:/workspaces/hyp-1",
    "workspace.commit:/workspaces/hyp-1",
    "workspace.unmount:/workspaces/hyp-1",
    "workspace.mount:hyp-2",
    "workspace.exec:/workspaces/hyp-2",
    "workspace.commit:/workspaces/hyp-2",
    "workspace.unmount:/workspaces/hyp-2",
  ]);
});

test("parallel verify mounts both branches before either commit", { timeout: 3000 }, async () => {
  let mounted = 0;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const client = scriptedClient({
    mount: async (sandbox, branch) => {
      mounted += 1;
      if (mounted === 2) release();
      await gate;
      return { sandbox, path: `/workspaces/${branch}`, image: "sha256:abc" };
    },
  });
  await verifyBranches(client, { branches: ["hyp-1", "hyp-2"], command: "npm test", jobs: 2 });
  const events = client.calls.map((call) => call[0]);
  const firstCommit = events.indexOf("workspace.commit");
  const mountsBefore = events.slice(0, firstCommit).filter((name) => name === "workspace.mount");
  assert.equal(mountsBefore.length, 2);
  for (const branch of ["hyp-1", "hyp-2"]) {
    const branchCalls = client.calls.filter((call) => JSON.stringify(call[1]).includes(branch) && call[0].startsWith("workspace."));
    assert.deepEqual(branchCalls.map((call) => call[0]), [
      "workspace.mount",
      "workspace.exec",
      "workspace.commit",
      "workspace.unmount",
    ]);
  }
});

test("seventeen branches at jobs 4 share one sandbox", async () => {
  let next = 0;
  const client = scriptedClient({
    create: async () => ({ sandbox: String(++next), image: "sha256:abc" }),
  });
  const branches = Array.from({ length: 17 }, (_, index) => `hyp-${index + 1}`);
  await verifyBranches(client, { branches, command: "npm test", jobs: 4 });
  assert.equal(named(client.calls, "sandbox.create").length, 1);
  assert.equal(named(client.calls, "sandbox.close").length, 1);
  const mounts = named(client.calls, "workspace.mount");
  assert.equal(mounts.length, 17);
  assert.ok(mounts.every((call) => call[1][0] === "1"));
  const creates = client.calls.map((call) => call[0]);
  assert.equal(creates.indexOf("sandbox.create"), 0);
  assert.ok(creates.indexOf("workspace.mount") > creates.indexOf("sandbox.create"));
});

test("seventeen in-flight branches use two sandboxes at the same time", async () => {
  let next = 0;
  let mounted = 0;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const client = scriptedClient({
    create: async () => ({ sandbox: String(++next), image: "sha256:abc" }),
    mount: async (sandbox, branch) => {
      mounted += 1;
      if (mounted === 17) release();
      await gate;
      return { sandbox, path: `/workspaces/${branch}`, image: "sha256:abc" };
    },
  });
  const branches = Array.from({ length: 17 }, (_, index) => `hyp-${index + 1}`);
  const pending = verifyBranches(client, { branches, command: "npm test", jobs: 17 });
  await gate;
  assert.equal(mounted, 17);
  assert.equal(next, 2);
  await pending;
  assert.equal(named(client.calls, "sandbox.create").length, 2);
  assert.equal(named(client.calls, "sandbox.close").length, 2);
  const mounts = named(client.calls, "workspace.mount");
  assert.equal(mounts.filter((call) => call[1][0] === "1").length, 16);
  assert.equal(mounts.filter((call) => call[1][0] === "2").length, 1);
});

test("a refused sandbox create is one attempt and is not retried", async () => {
  const client = scriptedClient({
    create: async () => {
      const error = new Error("image missing");
      error.code = "Failed";
      throw error;
    },
  });
  const { results, sandboxCloseErrors } = await verifyBranches(client, {
    branches: ["hyp-1", "hyp-2"],
    command: "npm test",
    jobs: 2,
  });
  assert.equal(named(client.calls, "sandbox.create").length, 1);
  assert.equal(named(client.calls, "sandbox.close").length, 0);
  assert.equal(sandboxCloseErrors.length, 0);
  assert.equal(named(client.calls, "workspace.mount").length, 0);
  for (const result of results) {
    assert.equal(result.pass, false);
    assert.equal(result.error.code, "Failed");
    assert.equal(result.attempts.mount, 0);
  }
});

test("a landed commit stays when the following unmount fails", async () => {
  const client = scriptedClient({
    unmount: async () => {
      const error = new Error("daemon gone");
      error.code = "NoSuchSandbox";
      throw error;
    },
  });
  const { results } = await verifyBranches(client, { branches: ["hyp-1"], command: "npm test", jobs: 1 });
  const result = results[0];
  assert.equal(result.pass, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.commit.head, "c0");
  assert.equal(result.newStored, 4);
  assert.equal(result.error, null);
  assert.equal(result.conflict, null);
  assert.equal(result.unmount.code, "NoSuchSandbox");
  assert.equal(result.attempts.commit, 1);
  assert.equal(result.attempts.unmount, 1);
  assert.equal(named(client.calls, "workspace.commit").length, 1);
  assert.equal(named(client.calls, "workspace.unmount").length, 1);
  assert.equal(named(client.calls, "workspace.unmount")[0][1][1], false);
  const text = renderReport({
    project: "shop",
    layerfs: "1.1.0",
    commit: "abc",
    stored: 1,
    storedFrom: "volume",
    unitBytes: 1,
    unitBytesFrom: "source-scan",
    candidates: 1,
    worktreeBaseline: 1,
    savedBytes: 0,
    timesSmaller: 1,
    pass: 1,
    fail: 0,
    results,
  });
  assert.match(text, /c0; unmount NoSuchSandbox/);
  assert.match(text, /pass/);
});

test("Conflict is committed once and the workspace is discarded", async () => {
  const client = scriptedClient({
    commit: async (ws, message) => {
      if (ws.path.endsWith("hyp-2")) {
        const error = new Error("both changed /src/app.js");
        error.code = "Conflict";
        error.detail = { conflicts: ["/src/app.js"], head: "abc" };
        throw error;
      }
      return { kind: "Committed", head: "c0", commit: { id: "c0", newStored: 4 } };
    },
  });
  const { results } = await verifyBranches(client, {
    branches: ["hyp-1", "hyp-2"],
    command: "npm test",
    jobs: 1,
  });
  const conflict = results.find((result) => result.branch === "hyp-2");
  assert.equal(conflict.pass, false);
  assert.equal(conflict.conflict.code, "Conflict");
  assert.deepEqual(conflict.conflict.detail.conflicts, ["/src/app.js"]);
  assert.equal(conflict.attempts.commit, 1);
  const commits = named(client.calls, "workspace.commit").filter((call) => call[1][0].path.endsWith("hyp-2"));
  assert.equal(commits.length, 1);
  const unmount = named(client.calls, "workspace.unmount").find((call) => call[1][0].path.endsWith("hyp-2"));
  assert.equal(unmount[1][1], true);
  const winner = named(client.calls, "workspace.unmount").find((call) => call[1][0].path.endsWith("hyp-1"));
  assert.equal(winner[1][1], false);
});

test("a refused exec is not repeated and is not committed", async () => {
  const client = scriptedClient({
    exec: async () => {
      const error = new Error("container is gone");
      error.code = "NoSuchSandbox";
      throw error;
    },
  });
  const { results } = await verifyBranches(client, { branches: ["hyp-1"], command: "npm test", jobs: 1 });
  assert.equal(results[0].error.code, "NoSuchSandbox");
  assert.equal(results[0].attempts.exec, 1);
  assert.equal(results[0].attempts.commit, 0);
  assert.equal(named(client.calls, "workspace.exec").length, 1);
  assert.equal(named(client.calls, "workspace.commit").length, 0);
  assert.equal(named(client.calls, "workspace.unmount")[0][1][1], true);
});

test("verify-all reports stored against the worktree baseline and discard copies nothing", async () => {
  const { home, source, runtime, client, LayerFS } = await fixture(2);
  await initProject(runtime, LayerFS, { home, name: "shop", source });
  await spawnN(runtime, LayerFS, { home, name: "shop", count: 2, prefix: "hyp" });
  client.workspace.exec = async (ws) => {
    client.calls.push(["workspace.exec", [ws]]);
    return { exitCode: ws.path.endsWith("hyp-2") ? 1 : 0, stdout: "", stderr: "", truncated: false };
  };
  const before = client.calls.length;
  const report = await verifyAll(runtime, LayerFS, {
    home,
    name: "shop",
    command: "npm test",
    sequenced: true,
    discardLosers: true,
  });
  const during = client.calls.slice(before).map((call) => call[0]);
  assert.equal(during.filter((name) => name === "workspace.exec").length, 2);
  assert.equal(during.filter((name) => name === "workspace.commit").length, 2);
  assert.equal(during.includes("fs.cp"), false);
  assert.equal(report.stored, 2);
  assert.equal(report.storedFrom, "volume");
  assert.equal(report.candidates, 2);
  assert.equal(report.unitBytes, 4);
  assert.equal(report.worktreeBaseline, 8);
  assert.equal(report.savedBytes, 6);
  assert.equal(report.pass, 1);
  assert.equal(report.fail, 1);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.discarded, ["hyp-2"]);
  assert.equal(named(runtime.calls, "volume.list").length, 1);
});

test("stored falls back to the store file once when the volume has no size", async () => {
  const { home, source, runtime, LayerFS } = await fixture();
  await initProject(runtime, LayerFS, { home, name: "shop", source });
  runtime.settings.platform = "linux";
  runtime.settings.volumes = home;
  const file = join(home, runtime.projectApi.volume, "_data", "global", "store.sqlite");
  await mkdir(join(home, runtime.projectApi.volume, "_data", "global"), { recursive: true });
  await writeFile(file, "abcdef");
  runtime.volume.list = async () => {
    runtime.calls.push(["volume.list", []]);
    const error = new Error("docker is down");
    error.code = "Failed";
    throw error;
  };
  const ledger = loadLedger(home, "shop");
  const report = await makeReport(runtime, { ...runtime.projectApi, source }, ledger);
  assert.equal(named(runtime.calls, "volume.list").length, 1);
  assert.equal(report.stored, 6);
  assert.equal(report.storedFrom, "store-file");
});
