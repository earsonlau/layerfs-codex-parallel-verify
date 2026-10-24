import { refusalOf } from "./errors.js";
import { SANDBOX_CAPACITY, verifyMessage } from "./names.js";
import { mapPool } from "./pool.js";

async function unmountOnce(state, client, discard) {
  if (!state.ws || state.unmounted) return null;
  state.unmounted = true;
  state.attempts.unmount += 1;
  return client.workspace.unmount(state.ws, discard);
}

/**
 * mount → exec → commit → unmount for one Branch.
 * Each call is made once. A Conflict is recorded and the commit is not repeated.
 * A finished command is committed even when its exit code is not zero.
 * Once commit returns, that result stays on the branch outcome. An unmount
 * failure after it is `unmount`, and does not clear the commit.
 */
export async function verifyBranch(client, { branch, command, sandbox }) {
  const state = { ws: null, unmounted: false, attempts: { mount: 0, exec: 0, commit: 0, unmount: 0 } };
  try {
    state.attempts.mount += 1;
    state.ws = await client.workspace.mount(sandbox, branch);
    state.attempts.exec += 1;
    const execed = await client.workspace.exec(state.ws, command, `verify ${branch}`);
    const exitCode = Number.isInteger(execed?.exitCode) ? execed.exitCode : null;
    state.attempts.commit += 1;
    let committed;
    try {
      committed = await client.workspace.commit(state.ws, verifyMessage(branch, command, exitCode));
    } catch (error) {
      if (error?.code !== "Conflict") throw error;
      let unmount = null;
      try {
        await unmountOnce(state, client, true);
      } catch (cleanup) {
        unmount = refusalOf(cleanup);
      }
      return {
        branch,
        command,
        sandbox,
        exitCode,
        pass: false,
        commit: null,
        newStored: null,
        conflict: refusalOf(error),
        unmount,
        error: null,
        attempts: state.attempts,
      };
    }
    let unmount = null;
    try {
      await unmountOnce(state, client, false);
    } catch (cleanup) {
      unmount = refusalOf(cleanup);
    }
    return {
      branch,
      command,
      sandbox,
      exitCode,
      pass: exitCode === 0,
      commit: committed ?? null,
      newStored: committed?.commit?.newStored ?? null,
      conflict: null,
      unmount,
      error: null,
      attempts: state.attempts,
    };
  } catch (error) {
    let unmount = null;
    try {
      await unmountOnce(state, client, true);
    } catch (cleanup) {
      unmount = refusalOf(cleanup);
    }
    return {
      branch,
      command,
      sandbox,
      exitCode: null,
      pass: false,
      commit: null,
      newStored: null,
      conflict: null,
      unmount,
      error: refusalOf(error),
      attempts: state.attempts,
    };
  }
}

/**
 * One Sandbox per 16 Workspaces that are actually in flight.
 * Created when the next Branch is about to mount and every Sandbox already
 * started for this run is full. A refused create is not called again.
 */
class SandboxPool {
  constructor(client) {
    this.client = client;
    this.boxes = [];
    this.pendingCreate = null;
  }

  async acquire() {
    for (;;) {
      const box = this.boxes.find((item) => item.inFlight < SANDBOX_CAPACITY);
      if (box) {
        box.inFlight += 1;
        return box.sandbox;
      }
      if (!this.pendingCreate) {
        this.pendingCreate = this.createOne();
      }
      const pending = this.pendingCreate;
      await pending;
    }
  }

  async createOne() {
    try {
      const created = await this.client.sandbox.create();
      this.boxes.push({ sandbox: created.sandbox, inFlight: 0 });
    } finally {
      this.pendingCreate = null;
    }
  }

  release(sandbox) {
    const box = this.boxes.find((item) => item.sandbox === sandbox);
    if (box && box.inFlight > 0) box.inFlight -= 1;
  }

  async closeAll(errors) {
    for (const box of this.boxes) {
      try {
        await this.client.sandbox.close(box.sandbox);
      } catch (error) {
        errors.push({ sandbox: box.sandbox, ...refusalOf(error) });
      }
    }
  }
}

function createFailure(branch, command, error) {
  return {
    branch,
    command,
    sandbox: null,
    exitCode: null,
    pass: false,
    commit: null,
    newStored: null,
    conflict: null,
    unmount: null,
    error: refusalOf(error),
    attempts: { mount: 0, exec: 0, commit: 0, unmount: 0 },
  };
}

/**
 * Verifies every branch. Workspace calls on one branch stay in order.
 * `jobs` is how many branches run at once (1 is sequenced; the branch count is parallel).
 * Sandboxes are created for in-flight Branches, 16 workspaces each, and each is closed once.
 */
export async function verifyBranches(client, { branches, command, jobs }) {
  const pool = new SandboxPool(client);
  const sandboxCloseErrors = [];
  try {
    const results = await mapPool(branches, jobs, async (branch) => {
      let sandbox;
      try {
        sandbox = await pool.acquire();
      } catch (error) {
        return createFailure(branch, command, error);
      }
      try {
        return await verifyBranch(client, { branch, command, sandbox });
      } finally {
        pool.release(sandbox);
      }
    });
    return { results, sandboxCloseErrors };
  } finally {
    await pool.closeAll(sandboxCloseErrors);
  }
}
