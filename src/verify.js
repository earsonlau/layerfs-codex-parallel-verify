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
    try {
      const committed = await client.workspace.commit(state.ws, verifyMessage(branch, command, exitCode));
      await unmountOnce(state, client, false);
      return {
        branch,
        command,
        sandbox,
        exitCode,
        pass: exitCode === 0,
        commit: committed ?? null,
        newStored: committed?.commit?.newStored ?? null,
        conflict: null,
        error: null,
        attempts: state.attempts,
      };
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
 * Verifies every branch. Workspace calls on one branch stay in order.
 * `jobs` is how many branches run at once (1 is sequenced; the branch count is parallel).
 * Sandboxes are created up front, 16 workspaces each, and each is closed once.
 */
export async function verifyBranches(client, { branches, command, jobs }) {
  const boxes = [];
  const needed = Math.ceil(branches.length / SANDBOX_CAPACITY);
  for (let index = 0; index < needed; index += 1) {
    const created = await client.sandbox.create();
    boxes.push(created.sandbox);
  }
  const sandboxCloseErrors = [];
  try {
    const results = await mapPool(branches, jobs, (branch, index) => verifyBranch(client, {
      branch,
      command,
      sandbox: boxes[Math.floor(index / SANDBOX_CAPACITY)],
    }));
    return { results, sandboxCloseErrors };
  } finally {
    for (const sandbox of boxes) {
      try {
        await client.sandbox.close(sandbox);
      } catch (error) {
        sandboxCloseErrors.push({ sandbox, ...refusalOf(error) });
      }
    }
  }
}
