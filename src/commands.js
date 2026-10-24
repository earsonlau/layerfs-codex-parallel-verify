import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { refusalOf, UsageError } from "./errors.js";
import { withClient } from "./host.js";
import { emptyLedger, loadLedger, saveLedger } from "./ledger.js";
import { spaceReport } from "./metrics.js";
import { assertName, boundedMessage, candidateNames, DEFAULT_PREFIX } from "./names.js";
import { pin } from "./pin.js";
import { resolveJobs } from "./pool.js";
import { readStored } from "./stored.js";
import { parseByteCount, SIZE_PROBE, treeBytes } from "./tree-bytes.js";
import { verifyBranches } from "./verify.js";

const INSTALL_BRANCH = "deps";

async function requireProject(runtime, name) {
  assertName(name, "a project name");
  const projects = await runtime.project.list();
  const project = projects.find((item) => item.name === name);
  if (!project) {
    const error = new Error(`no LayerFS project named ${name} in this home`);
    error.code = "NoSuchProject";
    throw error;
  }
  return project;
}

function requireLedger(home, project, name) {
  const ledger = loadLedger(home, name);
  if (ledger) return ledger;
  return emptyLedger({
    project: name,
    source: project.source,
    commit: pin.commit,
    sourceBytes: null,
    unitBytes: null,
    unitBytesFrom: null,
  });
}

/**
 * Follows the Init job the runtime already started.
 * `get_init` only reads that job. A failure does not start another Init.
 */
export async function waitInit(runtime, job, { timeoutMs, sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) } = {}) {
  const budget = timeoutMs + 120_000;
  const deadline = Date.now() + budget;
  let current = job;
  while (!current?.ended) {
    if (Date.now() > deadline) {
      const error = new Error("init did not finish before the timeout");
      error.code = "Failed";
      throw error;
    }
    await sleep(200);
    const next = await runtime.project.get_init(current.id);
    if (!next) {
      const error = new Error(`init job ${current.id} disappeared`);
      error.code = "Unknown";
      throw error;
    }
    current = next;
  }
  if (current.step === "failed" || current.error) {
    const error = new Error(current.error?.message || "init failed");
    error.code = current.error?.code || "Failed";
    error.detail = current.error ?? null;
    throw error;
  }
  if (!current.project?.volume) {
    const error = new Error("init finished without a project volume");
    error.code = "Failed";
    throw error;
  }
  return current.project;
}

async function runInstall(client, { command, sourceBytes }) {
  const created = await client.sandbox.create();
  const sandbox = created.sandbox;
  let ws = null;
  let unmounted = false;
  const unmount = async (discard) => {
    if (!ws || unmounted) return;
    unmounted = true;
    await client.workspace.unmount(ws, discard);
  };
  try {
    await client.branch.fork(INSTALL_BRANCH, "main");
    ws = await client.workspace.mount(sandbox, INSTALL_BRANCH);
    const execed = await client.workspace.exec(ws, command, "install dependencies");
    const exitCode = Number.isInteger(execed?.exitCode) ? execed.exitCode : null;
    const committed = await client.workspace.commit(
      ws,
      boundedMessage(`install ${INSTALL_BRANCH}: `, command, ` (exit ${exitCode})`),
    );
    let unitBytes = null;
    let probeError = null;
    let published = null;
    if (exitCode === 0) {
      try {
        const probed = await client.workspace.exec(ws, SIZE_PROBE, "measure tree bytes");
        unitBytes = parseByteCount(probed?.stdout);
        if (unitBytes == null) probeError = "the size probe did not print an integer";
      } catch (error) {
        probeError = error?.message || String(error);
      }
      published = await client.branch.publish(INSTALL_BRANCH);
    }
    await unmount(false);
    return {
      branch: INSTALL_BRANCH,
      command,
      exitCode,
      pass: exitCode === 0,
      commit: committed ?? null,
      published,
      unitBytes,
      unitBytesFrom: unitBytes == null ? "source-scan" : "workspace-probe",
      probeError,
      sourceBytes,
    };
  } catch (error) {
    try {
      await unmount(true);
    } catch (cleanup) {
      error.unmount = refusalOf(cleanup);
    }
    throw error;
  } finally {
    await client.sandbox.close(sandbox);
  }
}

/**
 * One project Init, dependencies included when `--install` is set.
 * The install runs on branch `deps` and is published to `main` only when it exits 0.
 */
export async function initProject(runtime, LayerFS, {
  home,
  name,
  source,
  install = null,
  timeout,
  sleep,
} = {}) {
  assertName(name, "a project name");
  const folder = resolve(source);
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) throw new UsageError(`${folder} is not a directory`);
  const scanned = await treeBytes(folder);
  const job = await runtime.project.start_init(name, folder, timeout === undefined ? {} : { timeout });
  const project = await waitInit(runtime, job, { timeoutMs: timeout ?? 300_000, sleep });
  let ledger = emptyLedger({
    project: name,
    source: folder,
    commit: pin.commit,
    sourceBytes: scanned.bytes,
    unitBytes: scanned.bytes,
    unitBytesFrom: "source-scan",
  });
  ledger.sourceFiles = scanned.files;
  ledger.sourceSkipped = scanned.skipped;
  ledger = saveLedger(home, ledger);
  if (!install) return ledger;
  try {
    const outcome = await withClient(runtime, project, LayerFS, (client) => runInstall(client, {
      command: install,
      sourceBytes: scanned.bytes,
    }));
    ledger.install = outcome;
    if (outcome.unitBytes != null) {
      ledger.unitBytes = outcome.unitBytes;
      ledger.unitBytesFrom = "workspace-probe";
    }
    ledger = saveLedger(home, ledger);
    if (!outcome.pass) {
      const error = new Error(`install exited ${outcome.exitCode}; committed on ${INSTALL_BRANCH} and not published`);
      error.code = "Failed";
      error.detail = outcome;
      throw error;
    }
    return ledger;
  } catch (error) {
    if (!ledger.install) {
      ledger.install = { branch: INSTALL_BRANCH, command: install, pass: false, error: refusalOf(error) };
      saveLedger(home, ledger);
    }
    throw error;
  }
}

/** Forks one Branch per candidate. Each fork is one call. Names already forked are not called again. */
export async function spawnN(runtime, LayerFS, {
  home,
  name,
  count,
  prefix = DEFAULT_PREFIX,
  from = "main",
} = {}) {
  assertName(from, "a from-ref");
  const names = candidateNames(prefix, count);
  const project = await requireProject(runtime, name);
  const ledger = requireLedger(home, project, name);
  const pending = names.filter((branchName) => !ledger.branches.some((item) => item.name === branchName && item.forked));
  if (pending.length) await withClient(runtime, project, LayerFS, async (client) => {
    for (const branchName of pending) {
      const existing = ledger.branches.find((item) => item.name === branchName);
      try {
        const created = await client.branch.fork(branchName, from);
        const record = { name: branchName, from, forked: true, fork: created ?? null, error: null };
        if (existing) Object.assign(existing, record);
        else ledger.branches.push(record);
      } catch (error) {
        const record = { name: branchName, from, forked: false, fork: null, error: refusalOf(error) };
        if (existing) Object.assign(existing, record);
        else ledger.branches.push(record);
      }
    }
  });
  const saved = saveLedger(home, ledger);
  saved.requested = names;
  return saved;
}

function branchList(ledger, explicit) {
  if (explicit?.length) {
    for (const name of explicit) assertName(name, "a branch name");
    return explicit;
  }
  const spawned = ledger.branches.filter((branch) => branch.forked && !ledger.discarded.includes(branch.name));
  if (!spawned.length) {
    throw new UsageError("no candidates to verify; run spawn-n, or pass --branches");
  }
  return spawned.map((branch) => branch.name);
}

function rememberResults(ledger, results) {
  const byBranch = new Map(ledger.results.map((result) => [result.branch, result]));
  for (const result of results) byBranch.set(result.branch, result);
  ledger.results = [...byBranch.values()];
}

/**
 * Runs the verify command on each candidate.
 * Default concurrency is 4 (sequenced-safe). `--parallel` runs every candidate at once.
 * `--sequenced` runs one at a time. Calls inside one Workspace stay in order.
 */
export async function verifyAll(runtime, LayerFS, {
  home,
  name,
  command,
  branches = null,
  parallel = false,
  sequenced = false,
  jobs,
  discardLosers = false,
} = {}) {
  if (typeof command !== "string" || !command.trim()) throw new UsageError("--command is the verify command to run in each Workspace");
  const project = await requireProject(runtime, name);
  const ledger = requireLedger(home, project, name);
  const selected = branchList(ledger, branches);
  const limit = resolveJobs({ parallel, sequenced, jobs, count: selected.length });
  const { results, sandboxCloseErrors } = await withClient(runtime, project, LayerFS, (client) => verifyBranches(client, {
    branches: selected,
    command,
    jobs: limit,
  }));
  rememberResults(ledger, results);
  if (discardLosers) {
    for (const result of results) {
      if (!result.pass) {
        if (!ledger.discarded.includes(result.branch)) ledger.discarded.push(result.branch);
        ledger.kept = ledger.kept.filter((kept) => kept !== result.branch);
      }
    }
  }
  const saved = saveLedger(home, ledger);
  const report = await makeReport(runtime, project, saved);
  const exitCode = sandboxCloseErrors.length ? 125 : results.every((result) => result.pass) ? 0 : 1;
  return { ...report, sandboxCloseErrors, jobs: limit, exitCode };
}

/** Pass/fail plus the Store `stored` size against N worktrees of `unitBytes`. */
export async function makeReport(runtime, project, ledger) {
  const stored = await readStored(runtime, project);
  const candidates = ledger.branches.filter((branch) => branch.forked).length;
  const space = spaceReport({
    stored: stored.stored,
    unitBytes: ledger.unitBytes,
    candidates,
  });
  const results = ledger.results ?? [];
  return {
    plugin: ledger.plugin,
    project: ledger.project,
    layerfs: ledger.layerfs,
    commit: ledger.commit,
    source: ledger.source,
    sourceBytes: ledger.sourceBytes,
    unitBytesFrom: ledger.unitBytesFrom,
    install: ledger.install,
    ...stored,
    ...space,
    pass: results.filter((result) => result.pass).length,
    fail: results.filter((result) => !result.pass).length,
    kept: ledger.kept,
    discarded: ledger.discarded,
    branches: ledger.branches,
    results,
  };
}

export async function reportProject(runtime, { home, name } = {}) {
  const project = await requireProject(runtime, name);
  const ledger = loadLedger(home, name) ?? requireLedger(home, project, name);
  const report = await makeReport(runtime, project, ledger);
  return { ...report, exitCode: 0 };
}

/** Marks losers. Their commits stay in the Store; no tree is copied or checked out. */
export async function discardBranches(runtime, { home, name, names } = {}) {
  if (!names?.length) throw new UsageError("name the branches to discard");
  for (const branch of names) assertName(branch, "a branch name");
  const project = await requireProject(runtime, name);
  const ledger = requireLedger(home, project, name);
  const known = new Set([
    ...ledger.branches.map((branch) => branch.name),
    ...ledger.results.map((result) => result.branch),
  ]);
  for (const branch of names) {
    if (!known.has(branch)) throw new UsageError(`no candidate named ${branch}`);
    if (!ledger.discarded.includes(branch)) ledger.discarded.push(branch);
    ledger.kept = ledger.kept.filter((kept) => kept !== branch);
  }
  const saved = saveLedger(home, ledger);
  return { ...(await makeReport(runtime, project, saved)), exitCode: 0 };
}

/** Marks winners. This does not publish and does not copy a tree. */
export async function keepBranches(runtime, { home, name, names } = {}) {
  if (!names?.length) throw new UsageError("name the branches to keep");
  for (const branch of names) assertName(branch, "a branch name");
  const project = await requireProject(runtime, name);
  const ledger = requireLedger(home, project, name);
  const known = new Set(ledger.branches.filter((branch) => branch.forked).map((branch) => branch.name));
  for (const branch of names) {
    if (!known.has(branch)) throw new UsageError(`no forked candidate named ${branch}`);
    if (!ledger.kept.includes(branch)) ledger.kept.push(branch);
    ledger.discarded = ledger.discarded.filter((discarded) => discarded !== branch);
  }
  const saved = saveLedger(home, ledger);
  return { ...(await makeReport(runtime, project, saved)), exitCode: 0 };
}
