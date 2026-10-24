import { isAbsolute, join } from "node:path";
import { UsageError } from "./errors.js";

/** Where @layerfs/runtime writes the worker endpoint on macOS and Windows. */
export function endpointFile(home) {
  return join(home, "worker", "endpoint.json");
}

/**
 * The installed Store file for a project volume.
 * Linux uses the runtime's volumes directory. macOS and Windows use Docker Desktop's path.
 */
export function storeFile(settings, volume) {
  const root = settings.platform === "linux"
    ? (settings.volumes || "/var/lib/docker/volumes")
    : "/var/lib/docker/volumes";
  return `${root}/${volume}/_data/global/store.sqlite`;
}

/** LAYERFS_* values one project client reads when it is constructed. */
export function projectEnv(settings, project) {
  return {
    LAYERFS_HOME: settings.wsl?.home ?? settings.home,
    LAYERFS_DOCKER: settings.docker,
    LAYERFS_IMAGE: project.image || settings.image || "",
    LAYERFS_DAEMON: settings.daemon || "",
    LAYERFS_VOLUME: project.volume,
    LAYERFS_STORE_PATH: storeFile(settings, project.volume),
    LAYERFS_CONTAINER_PREFIX: settings.containerPrefix,
  };
}

/** Sets LAYERFS_* for the synchronous client constructor, then restores them. */
export function applyEnv(env) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined || value === null || value === "") delete process.env[key];
    else process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Opens the runtime. On macOS and Windows, starts the home's worker once and
 * sets LAYERFS_WORKER_ENDPOINT so later agent clients use it. Linux has no
 * worker; this does not call start. A failed start is not tried again.
 */
export async function openHost(options, { LayerFSRuntime }) {
  if (typeof options?.home !== "string" || !isAbsolute(options.home)) {
    throw new UsageError("set LAYERFS_HOME to an absolute LayerFS home directory");
  }
  const runtime = await LayerFSRuntime.open(options);
  try {
    const platform = runtime.settings?.platform;
    if (platform === "macos" || platform === "windows") {
      await runtime.worker.start();
      process.env.LAYERFS_WORKER_ENDPOINT = endpointFile(runtime.settings.home);
    }
    return runtime;
  } catch (error) {
    await runtime.close?.();
    throw error;
  }
}

/** One open client. The constructor reads LAYERFS_* before its first await. */
export async function withClient(runtime, project, LayerFS, fn) {
  if (!project?.volume) {
    const error = new Error(`the runtime has no volume for ${project?.name ?? "this project"}; init it with this plugin`);
    error.code = "InvalidInput";
    throw error;
  }
  const restore = applyEnv(projectEnv(runtime.settings, project));
  let client;
  try {
    client = await LayerFS.open(project.name);
    return await fn(client);
  } finally {
    if (client) await client.close();
    restore();
  }
}
