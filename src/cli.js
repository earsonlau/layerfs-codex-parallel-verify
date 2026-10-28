import { discardBranches, initProject, keepBranches, reportProject, spawnN, verifyAll } from "./commands.js";
import { isUsage, refusalOf, UsageError } from "./errors.js";
import { openHost } from "./host.js";
import { loadSdk } from "./load.js";
import { renderInit, renderReport, renderSpawn } from "./format.js";
import { DEFAULT_PREFIX } from "./names.js";
import { pin } from "./pin.js";

const BOOLEAN = new Set(["json", "parallel", "sequenced", "discard-losers", "help", "version"]);

export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help", flags: {}, positionals: [] };
  }
  if (args[0] === "--version" || args[0] === "-V") {
    return { command: "version", flags: {}, positionals: [] };
  }
  const command = args.shift();
  const flags = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (!key) throw new UsageError("a flag needs a name");
    if (eq !== -1) {
      flags[key] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${key} needs a value`);
    flags[key] = value;
    index += 1;
  }
  return { command, flags, positionals };
}

function integerFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(String(flags[key]))) throw new UsageError(`--${key} must be a positive integer`);
  const value = Number(flags[key]);
  if (!Number.isSafeInteger(value)) throw new UsageError(`--${key} is too large`);
  return value;
}

export function helpText() {
  return `codex-parallel-verify — LayerFS parallel verify for Codex

One Store, one Branch per hypothesis. Replaces \`codex exec -C <worktree>\`
and \`codex --worktree\` when you would otherwise materialize N checkouts.

Commands
  init --name <project> --source <dir> [--install <command>] [--timeout <ms>]
  spawn-n --name <project> --count <n> [--prefix hyp] [--from main]
  verify-all --name <project> --command <command> [--sequenced | --parallel | --jobs <n>]
             [--branches a,b] [--discard-losers]
  report --name <project>
  discard --name <project> <branch> [branch...]
  keep --name <project> <branch> [branch...]

spawn-n's default prefix is hyp, so the branches are hyp-1, hyp-2, and so on.
Each LayerFS call is one attempt. A Conflict is reported and not retried.
Add --json for one JSON object on stdout.

Settings (environment, or the matching flag)
  LAYERFS_HOME              absolute home (required)
  LAYERFS_IMAGE             runtime image sha256 digest
  LAYERFS_DAEMON            layerfs-daemon path
  LAYERFS_BUNDLE            sealed Linux bundle (macOS and Windows)
  LAYERFS_DOCKER            Docker socket
  LAYERFS_VOLUMES           Docker volumes directory (Linux)
  LAYERFS_CONTAINER_PREFIX  container name prefix
  LAYERFS_REPO              LayerFS checkout at ${pin.commit}
  On macOS and Windows this process starts the worker and sets
  LAYERFS_WORKER_ENDPOINT. On Linux leave that variable unset.

LayerFS ${pin.layerfs}  ${pin.commit}
`;
}

function hostOptions(flags) {
  const home = flags.home || process.env.LAYERFS_HOME;
  const wsl = flags["wsl-distro"] || flags["wsl-user"] || flags["wsl-node"] || flags["wsl-home"]
    ? {
      distribution: flags["wsl-distro"],
      user: flags["wsl-user"],
      node: flags["wsl-node"],
      home: flags["wsl-home"],
    }
    : undefined;
  return {
    home,
    image: flags.image || process.env.LAYERFS_IMAGE,
    daemon: flags.daemon || process.env.LAYERFS_DAEMON,
    bundle: flags.bundle || process.env.LAYERFS_BUNDLE,
    docker: flags.docker || process.env.LAYERFS_DOCKER,
    volumes: flags.volumes || process.env.LAYERFS_VOLUMES,
    containerPrefix: flags["container-prefix"] || process.env.LAYERFS_CONTAINER_PREFIX,
    wsl,
    sweep: false,
  };
}

function compact(options) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== ""));
}

function writeOut(io, text) {
  io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function emit(io, json, text, value) {
  if (json) writeOut(io, JSON.stringify(value, null, 2));
  else writeOut(io, text);
}

/**
 * Runs one command. Returns a process exit code.
 * 0 success, 1 a verify command failed, 2 bad usage, 125 LayerFS refused or failed.
 */
export async function main(argv, deps = {}) {
  const io = deps.io ?? { stdout: process.stdout, stderr: process.stderr };
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (parsed.command === "help") {
    writeOut(io, helpText());
    return 0;
  }
  if (parsed.command === "version") {
    writeOut(io, `${pin.layerfs} ${pin.commit}\nplugin 0.1.1 ${pin.id}`);
    return 0;
  }
  const known = new Set(["init", "spawn-n", "verify-all", "report", "discard", "keep"]);
  if (!known.has(parsed.command)) {
    io.stderr.write(`unknown command ${parsed.command}\n${helpText()}`);
    return 2;
  }
  try {
    const { flags, positionals } = parsed;
    const name = flags.name;
    if (!name) throw new UsageError("--name is the LayerFS project");
    if (parsed.command === "init" && !flags.source) throw new UsageError("--source is the project directory to init");
    if (parsed.command === "spawn-n" && !integerFlag(flags, "count")) throw new UsageError("--count is how many branches to fork");
    if (parsed.command === "verify-all" && !String(flags.command ?? "").trim()) throw new UsageError("--command is the verify command to run in each Workspace");
    if ((parsed.command === "discard" || parsed.command === "keep") && positionals.length === 0) {
      throw new UsageError(`name the branches to ${parsed.command}`);
    }
    if (flags.parallel && flags.sequenced) throw new UsageError("pass either --sequenced or --parallel");
    if (flags.timeout !== undefined) integerFlag(flags, "timeout");
    if (flags.jobs !== undefined) integerFlag(flags, "jobs");
    const options = compact(hostOptions(flags));
    if (!options.home) throw new UsageError("set LAYERFS_HOME or pass --home");
    const sdk = deps.sdk ?? await loadSdk({ ...process.env, ...(flags.repo ? { LAYERFS_REPO: flags.repo } : {}) });
    const runtime = await openHost(options, sdk);
    try {
      if (parsed.command === "init") {
        const ledger = await initProject(runtime, sdk.LayerFS, {
          home: options.home,
          name,
          source: flags.source,
          install: flags.install ?? null,
          timeout: integerFlag(flags, "timeout"),
        });
        emit(io, flags.json, renderInit(ledger), ledger);
        return ledger.install && ledger.install.pass === false ? 125 : 0;
      }
      if (parsed.command === "spawn-n") {
        const count = integerFlag(flags, "count");
        const ledger = await spawnN(runtime, sdk.LayerFS, {
          home: options.home,
          name,
          count,
          prefix: flags.prefix ?? DEFAULT_PREFIX,
          from: flags.from ?? "main",
        });
        const names = ledger.requested;
        const refused = ledger.branches.filter((branch) => names.includes(branch.name) && !branch.forked);
        emit(io, flags.json, renderSpawn(ledger, names), { ...ledger, exitCode: refused.length ? 125 : 0 });
        return refused.length ? 125 : 0;
      }
      if (parsed.command === "verify-all") {
        const branches = flags.branches ? String(flags.branches).split(",").map((item) => item.trim()).filter(Boolean) : null;
        const report = await verifyAll(runtime, sdk.LayerFS, {
          home: options.home,
          name,
          command: flags.command,
          branches,
          parallel: Boolean(flags.parallel),
          sequenced: Boolean(flags.sequenced),
          jobs: integerFlag(flags, "jobs"),
          discardLosers: Boolean(flags["discard-losers"]),
        });
        emit(io, flags.json, renderReport(report), report);
        return report.exitCode;
      }
      if (parsed.command === "report") {
        const report = await reportProject(runtime, { home: options.home, name });
        emit(io, flags.json, renderReport(report), report);
        return 0;
      }
      if (parsed.command === "discard") {
        const report = await discardBranches(runtime, { home: options.home, name, names: positionals });
        emit(io, flags.json, renderReport(report), report);
        return 0;
      }
      const report = await keepBranches(runtime, { home: options.home, name, names: positionals });
      emit(io, flags.json, renderReport(report), report);
      return 0;
    } finally {
      await runtime.close?.();
    }
  } catch (error) {
    if (isUsage(error)) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    const refusal = refusalOf(error);
    io.stderr.write(`${JSON.stringify(refusal)}\n`);
    return 125;
  }
}
