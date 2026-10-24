# Codex parallel verify

Plugin id `codex-parallel-verify`. LayerFS **1.1.0** commit `9f97a7ec95b662e9cb288704afa165feff132cfa`.

Use this instead of `codex exec -C <worktree>` and `codex --worktree` when several hypotheses share one tree. One Store holds the project, including dependencies. Each candidate is a Branch. A Workspace is not a host directory: do not pass `/workspaces/N` to `codex -C`.

## Do this

1. `init` the project once. With `--install`, the install runs on branch `deps`, is committed once, and is published to `main` only when it exits 0. Later forks mount that same Store. They do not reinstall.
2. `spawn-n` forks one Branch per candidate (`branch.fork`). Forking copies no files.
3. Put that candidate's edit on its own Branch (`fs.write`, `fs.apply`, or one `workspace.exec` plus one `workspace.commit`). One writer per Branch.
4. `verify-all` does **mount → exec → commit → unmount** on each Branch. Commands inside one Workspace stay in order. `--sequenced` runs one Branch at a time. The default runs four at a time. `--parallel` runs them together.
5. Commit the verify command even when it exits non-zero. The message names the exit code.
6. `report` prints pass/fail and the Store `stored` size against N worktrees (`candidates × unitBytes`).

## Conflict, once

`workspace.commit` throws `Conflict` with `detail.conflicts` and `detail.head`. Do not call `commit` again on that Workspace. Read the named paths once if you need them, resolve on a new fork, and make one new commit there. Or `unmount(ws, true)` to drop the overlay. That copies no tree.

`verify-all` already does this: one commit, then one discarding unmount, then it stops.

## Calls

Every LayerFS call is one attempt. Do not wrap these commands in a retry loop. A refusal is JSON on stderr and exit 125. Fix the cause before you run the command again.

On macOS and Windows the CLI starts the home's worker once and sets `LAYERFS_WORKER_ENDPOINT` to `$LAYERFS_HOME/worker/endpoint.json`. On Linux leave that variable unset.

Packages are `@layerfs/agent` and `@layerfs/runtime` only. Do not import `@layerfs/agent/internal`.

Keep a winner with `keep`. `discard` only marks a loser. The commits stay in the Store; nothing is checked out and nothing is copied.

The skill with the full command lines is `.agents/skills/codex-parallel-verify/SKILL.md`.
