import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pin } from "./pin.js";

const MISSING = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

function isMissing(error) {
  return MISSING.has(error?.code) || /Cannot find package/.test(error?.message ?? "");
}

function pack(agent, runtime) {
  if (typeof agent?.LayerFS?.open !== "function" || typeof runtime?.LayerFSRuntime?.open !== "function") {
    const error = new Error("@layerfs/agent and @layerfs/runtime did not export LayerFS and LayerFSRuntime");
    error.code = "InvalidInput";
    throw error;
  }
  return {
    LayerFS: agent.LayerFS,
    LayerFSRuntime: runtime.LayerFSRuntime,
    isRefusal: agent.isRefusal,
  };
}

async function importPackages() {
  let agent;
  try {
    agent = await import("@layerfs/agent");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const runtime = await import("@layerfs/runtime");
    return pack(agent, runtime);
  } catch (error) {
    if (isMissing(error)) {
      const wrapped = new Error(`@layerfs/agent loaded but @layerfs/runtime did not. Install both from LayerFS ${pin.commit}. ${error.message}`);
      wrapped.code = "InvalidInput";
      throw wrapped;
    }
    throw error;
  }
}

/** Loads the public packages from node, or from a LayerFS checkout at LAYERFS_REPO. */
export async function loadSdk(env = process.env) {
  const bundled = await importPackages();
  if (bundled) return bundled;
  const root = env.LAYERFS_REPO;
  if (!root) {
    const error = new Error(
      `Cannot find @layerfs/agent and @layerfs/runtime. Clone LayerFS, checkout ${pin.commit}, run npm --prefix "$LAYERFS_REPO/api" install, and set LAYERFS_REPO to that checkout. See README Install.`,
    );
    error.code = "InvalidInput";
    throw error;
  }
  const agentEntry = join(root, "api/agent/src/index.js");
  const runtimeEntry = join(root, "api/runtime/src/index.js");
  if (!existsSync(agentEntry) || !existsSync(runtimeEntry)) {
    const error = new Error(`LAYERFS_REPO ${root} is not a LayerFS checkout with api/agent and api/runtime. Checkout ${pin.commit}.`);
    error.code = "InvalidInput";
    throw error;
  }
  const agent = await import(pathToFileURL(agentEntry).href);
  const runtime = await import(pathToFileURL(runtimeEntry).href);
  return pack(agent, runtime);
}
