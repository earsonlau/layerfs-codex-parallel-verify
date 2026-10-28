---
name: codex-parallel-verify
description: >
  Verify several Codex hypotheses on one LayerFS Store instead of N git worktrees.
  Use when Codex would pass -C or --worktree for each candidate, when a fix has
  multiple paths to test, or when disk is growing from repeated dependency installs.
  Fork one Branch per candidate, mount a Workspace, exec the verify command, and
  commit once. On Conflict, handle it once and do not retry the call.
---

# Codex parallel verify

LayerFS **1.1.0**, commit `4b5276216a2e9f780194a554ef9f0c33f9b6ba6d`. Plugin id `codex-parallel-verify`.

Codex CLI sets the session root with `-C` / `--cd` (`codex exec -C ../hyp-1 "…"`). `codex exec --worktree` and `codex --worktree` create a managed git worktree and use it as that root. The desktop app does the same per thread. Each of those directories is a full checkout, and each one reinstalls dependencies.

This skill replaces that fan-out. The candidates are Branches in one Store. Verification runs through `workspace.exec`, which is the command that used to run in the directory you gave to `-C`.

Do not pass a Sandbox path such as `/workspaces/1` to `codex -C`. That path exists inside the Sandbox, not on the host.

## Calls you use

`@layerfs/agent` and `@layerfs/runtime` only, public methods only. Settings come from `LAYERFS_*`. One attempt per call. Never retry a refused call. On macOS and Windows, start the worker once and set `LAYERFS_WORKER_ENDPOINT`. On Linux, leave it unset.

The CLI in this plugin makes those calls. Prefer it to hand-written scripts.

## Steps

### 1. Init once, dependencies included

```bash
export LAYERFS_REPO="$HOME/layerfs"          # checkout 4b5276216a2e9f780194a554ef9f0c33f9b6ba6d
export LAYERFS_HOME="$HOME/.layerfs-codex"
export LAYERFS_IMAGE="sha256:<64 hex>"
export LAYERFS_DAEMON="/absolute/path/to/layerfs-daemon"
# macOS and Windows also:
export LAYERFS_BUNDLE="/absolute/path/to/sealed-linux-bundle"

node bin/codex-parallel-verify.js init \
  --name shop \
  --source "$PWD" \
  --install "npm ci" \
  --json
```

`--install` forks `deps` from `main`, mounts one Workspace, execs the command, commits once (even on a non-zero exit), and publishes to `main` only when the exit code is 0. Every later fork sees that install. Do not run `npm ci` on the candidates.

Without `--install`, the source directory you pass is the tree that gets shared. Put dependencies in that directory first if they must be in the Store.

### 2. Fork one Branch per candidate

```bash
node bin/codex-parallel-verify.js spawn-n --name shop --count 3 --prefix hyp --json
```

This is `branch.fork` from `main`. It copies no files. Names are `hyp-1`, `hyp-2`, `hyp-3`. The default prefix is `hyp`. A name that is already forked is not forked again. A refusal such as `Exists` is recorded for that name only and is not retried inside the command.

### 3. Edit each candidate on its own Branch

One writer per Branch. Either:

- `fs.write` / `fs.apply` on that Branch (each call is one Commit), or
- mount that Branch, `workspace.exec` the edit, `workspace.commit` once, `workspace.unmount`.

Do not point a second Codex session at the same Branch.

### 4. Verify: mount, exec, commit

```bash
node bin/codex-parallel-verify.js verify-all \
  --name shop \
  --command "npm test" \
  --json
```

For each Branch the CLI does, in order, and each call once:

1. `sandbox.create` when a Branch is about to mount and no Sandbox has a free Workspace (16 per Sandbox). A Sandbox is not started ahead of the Branches that will use it.
2. `workspace.mount(sandbox, branch)`.
3. `workspace.exec` the verify command.
4. `workspace.commit`, including when the command exits non-zero. The message is `verify <branch>: <command> (exit N)`.
5. `workspace.unmount`.
6. `sandbox.close` once, after the branches on that Sandbox are done.

Default concurrency is 4, which keeps a Sandbox inside its connection budget. `--sequenced` runs one Branch at a time. `--parallel` runs every Branch at once. Calls on one Workspace are never reordered.

Add `--discard-losers` to mark failing branches. That does not copy a tree and does not delete commits.

### 5. Report disk

```bash
node bin/codex-parallel-verify.js report --name shop --json
```

Read these fields:

| Field | Meaning |
| --- | --- |
| `stored` | Store on-disk size, from `runtime.volume.list` (or the store file if the volume figure is missing) |
| `unitBytes` | Bytes of one materialized tree (the shared install when `--install` succeeded, otherwise the source scan) |
| `candidates` | Forked branches |
| `worktreeBaseline` | `candidates × unitBytes`, what N git worktrees would hold |
| `savedBytes` | `worktreeBaseline - stored` |
| `timesSmaller` | `worktreeBaseline / stored` |
| `results[].pass` | The verify command exited 0 |
| `results[].conflict` | Present when commit was refused. It was not retried |

## Conflict, once

When `workspace.commit` throws `Conflict`:

1. Stop. Do not call `commit` again, and do not pass `force`.
2. `detail.conflicts` lists the paths. `detail.head` is the head you collided with.
3. Read those paths once (`fs.read` or one `workspace.exec` of a diff) if you need to see them.
4. Either `unmount(ws, true)` to drop the uncommitted overlay, or resolve the edit on a **new** fork and commit there once.
5. Do not merge by retrying the same call.

`verify-all` already unmounts a conflicted Workspace with `discard: true` and records `conflict` on that result.

## What replaces `-C` and `--worktree`

| You were going to run | Run this instead |
| --- | --- |
| `git worktree add ../hyp-1 -b hyp-1` | `spawn-n` (one `branch.fork`, no file copy) |
| `npm ci` in every worktree | one `init --install`, published to `main` |
| `codex exec -C ../hyp-1 "npm test"` | edit branch `hyp-1`, then `verify-all --command "npm test"` |
| `codex exec --worktree` for a second try | another Branch from the same `main` |
| `rm -rf ../hyp-2` | `discard --name shop hyp-2` (no checkout, no copy) |

A desktop thread per worktree becomes a Branch per hypothesis, then one `verify-all`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command succeeded, and every verified candidate passed |
| 1 | LayerFS accepted the calls, and at least one candidate failed |
| 2 | The command line is wrong. Nothing was called |
| 125 | LayerFS refused or failed a call. Read stderr. Do not retry it automatically |
