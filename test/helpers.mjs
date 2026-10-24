import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function tempDirs() {
  const home = await mkdtemp(join(tmpdir(), "cpv-home-"));
  const source = await mkdtemp(join(tmpdir(), "cpv-src-"));
  await writeFile(join(source, "app.txt"), "tree");
  return { home, source };
}

export function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout: { write(chunk) { stdout.push(String(chunk)); } },
    stderr: { write(chunk) { stderr.push(String(chunk)); } },
    out() { return stdout.join(""); },
    err() { return stderr.join(""); },
  };
}

/** A stand-in @layerfs/agent client. Every method records one call, then runs the handler. */
export function scriptedClient(handlers = {}) {
  const calls = [];
  const wrap = (name, fn) => async (...args) => {
    calls.push([name, args]);
    return fn(...args);
  };
  return {
    calls,
    projectName: "shop",
    close: wrap("close", handlers.close ?? (async () => {})),
    project: {
      list_branches: wrap("project.list_branches", handlers.list_branches ?? (async () => ({ items: [{ name: "main" }], hasMore: false }))),
    },
    branch: {
      fork: wrap("branch.fork", handlers.fork ?? (async (name) => ({ kind: "Forked", branch: name }))),
      publish: wrap("branch.publish", handlers.publish ?? (async (branch) => ({ kind: "Published", branch }))),
    },
    sandbox: {
      create: wrap("sandbox.create", handlers.create ?? (async () => ({ sandbox: "1", image: "sha256:abc" }))),
      close: wrap("sandbox.close", handlers.closeSandbox ?? (async () => ({ kind: "Closed" }))),
    },
    workspace: {
      mount: wrap("workspace.mount", handlers.mount ?? (async (sandbox, branch) => ({ sandbox, path: `/workspaces/${branch}`, image: "sha256:abc" }))),
      exec: wrap("workspace.exec", handlers.exec ?? (async () => ({ kind: "exit:0", exitCode: 0, stdout: "4", stderr: "", truncated: false }))),
      commit: wrap("workspace.commit", handlers.commit ?? (async () => ({ kind: "Committed", head: "c0", commit: { id: "c0", newStored: 4 } }))),
      unmount: wrap("workspace.unmount", handlers.unmount ?? (async () => ({ kind: "Unmounted" }))),
    },
  };
}

export function scriptedLayerFS(client) {
  const opens = [];
  return {
    opens,
    async open(name) {
      opens.push(name);
      return client;
    },
  };
}

/** A stand-in @layerfs/runtime. No Docker. */
export function scriptedRuntime({
  platform = "linux",
  home,
  volumeSize = 1000,
  startInit,
  getInit,
  volumeList,
  projects,
} = {}) {
  const calls = [];
  const settings = {
    platform,
    home,
    volumes: "/var/lib/docker/volumes",
    docker: "/var/run/docker.sock",
    image: `sha256:${"ab".repeat(32)}`,
    daemon: "/opt/layerfs-daemon",
    containerPrefix: "layerfs-",
    stateDir: join(home, ".runtime"),
    bundle: platform === "linux" ? null : "/bundle",
  };
  const project = {
    name: "shop",
    volume: "layerfs-shop-store-1",
    source: "/src",
    image: settings.image,
    created: 1,
  };
  return {
    calls,
    settings,
    project,
    worker: {
      start: async () => {
        calls.push(["worker.start", []]);
        return { worker: { state: "running" } };
      },
    },
    projectApi: project,
    project: {
      start_init: async (name, folder, options) => {
        calls.push(["project.start_init", [name, folder, options]]);
        if (startInit) return startInit(name, folder, options);
        return {
          id: "job-1",
          name,
          ended: Date.now(),
          step: "done",
          error: null,
          project: { ...project, name, source: folder },
        };
      },
      get_init: async (id) => {
        calls.push(["project.get_init", [id]]);
        return getInit ? getInit(id) : null;
      },
      list: async () => {
        calls.push(["project.list", []]);
        return projects ? projects() : [project];
      },
    },
    volume: {
      list: async () => {
        calls.push(["volume.list", []]);
        if (volumeList) return volumeList();
        return [{
          name: project.volume,
          size: volumeSize,
          owner: "this",
          project: project.name,
          live: true,
          containers: 0,
          removable: false,
        }];
      },
    },
    close: async () => {
      calls.push(["runtime.close", []]);
    },
  };
}

export const named = (calls, name) => calls.filter((call) => call[0] === name);
