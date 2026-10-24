# LayerFS for Codex parallel verify

Plugin id `codex-parallel-verify`. One shared LayerFS Store, one Branch per Codex hypothesis, verify commands in parallel. Disk stays near the size of one tree instead of N git worktrees.

LayerFS **v1.1.0**, pinned in [`layerfs.json`](layerfs.json) at commit `9f97a7ec95b662e9cb288704afa165feff132cfa`.

The public packages are `@layerfs/agent` and `@layerfs/runtime`. This plugin does not import `@layerfs/agent/internal` or `@layerfs/backend`. Every LayerFS call is one attempt. A refusal is not retried.

## Install

Do these steps in order. Stop at the first one you cannot finish and report the step plus the exact error. Do not retry a LayerFS call that failed.

### 1. Check Node

Node 20 or newer:

```bash
node -v
```

The first line must be `v20` or a newer major.

### 2. Test this plugin

From this repository:

```bash
npm test
```

Success is exit 0 and every test passing. This does **not** need Docker, a LayerFS checkout, a daemon, or a Rust toolchain. `npm test` is the default test entry and it never starts a container.

You can also print the command list without LayerFS installed:

```bash
node bin/codex-parallel-verify.js --help
```

### 3. Pin the LayerFS checkout

```bash
git clone https://github.com/Ephemeral-AI-Lab/layerfs.git "$HOME/layerfs"
git -C "$HOME/layerfs" checkout 9f97a7ec95b662e9cb288704afa165feff132cfa
export LAYERFS_REPO="$HOME/layerfs"
git -C "$LAYERFS_REPO" rev-parse HEAD
```

The printed commit must be exactly `9f97a7ec95b662e9cb288704afa165feff132cfa`. If it is not, stop. Do not use another commit.

### 4. Link the JavaScript packages

In the checkout, `api/` is an npm workspace. Installing it links the packages; it does not download them from the registry.

```bash
npm --prefix "$LAYERFS_REPO/api" install
```

This plugin loads `@layerfs/agent` from `api/agent/sdk` and `@layerfs/runtime` from `api/runtime` through `LAYERFS_REPO`. Confirm both public entry points load:

```bash
node --input-type=module -e 'import { loadSdk } from "./src/load.js"; const sdk = await loadSdk(); console.log(typeof sdk.LayerFS.open, typeof sdk.LayerFSRuntime.open)'
```

Success prints `function function`. If it does not, stop and report the error. Do not import `@layerfs/agent/internal`.

### 5. Settings for a real project

A live Init needs a Linux `layerfs-daemon` and a runtime image built from **this same commit**. That image needs `node` and `npm`: `init --install` and `verify-all --command "npm test"` run inside the Sandbox, and the size probe runs `node`. Build the image the way `api/README.md` and `api/how-to-use/runtime.md` in the checkout describe (`npm --prefix "$LAYERFS_REPO/api" run build:native` builds the addon on a macOS or Linux host). Then:

```bash
export LAYERFS_HOME="$HOME/.layerfs-codex"
export LAYERFS_IMAGE="sha256:<64 lowercase hex digits>"
export LAYERFS_DAEMON="/absolute/path/to/layerfs-daemon"
```

Optional, when the defaults are wrong:

```bash
export LAYERFS_DOCKER="/var/run/docker.sock"
export LAYERFS_VOLUMES="/var/lib/docker/volumes"   # Linux
export LAYERFS_CONTAINER_PREFIX="layerfs-"
```

On **macOS and Windows** the Store is not opened in this process. Also set:

```bash
export LAYERFS_BUNDLE="/absolute/path/to/sealed-linux-bundle"
```

The bundle directory contains `layerfs-daemon`, `layerfs.node`, and `manifest.json`. The CLI calls `runtime.worker.start()` once and sets `LAYERFS_WORKER_ENDPOINT` to `$LAYERFS_HOME/worker/endpoint.json`. Do not start a second worker for the same home. On **Linux**, leave `LAYERFS_WORKER_ENDPOINT` unset so Store calls stay in-process.

Windows can pass `--wsl-distro`, `--wsl-user`, `--wsl-node`, and `--wsl-home` when the runtime's defaults (Ubuntu, root, `/usr/local/bin/node`) are wrong.

### 6. Initialize once

```bash
node bin/codex-parallel-verify.js init \
  --name shop \
  --source "$PWD" \
  --install "npm ci" \
  --json
```

`--name` is a LayerFS project name: 1–63 characters, lowercase letters, digits, `_`, `.`, `-`, starting and ending with a letter or digit. `--source` is the directory Init imports. `--install` runs once on branch `deps` and is published to `main` only when it exits 0.

Exit 0 means the project exists and, if you passed `--install`, `main` now contains that install. Exit 125 means LayerFS refused the call. Read the JSON on stderr. Do not run `init` again for the same name (`Exists` is not a prompt to retry). The ledger is `$LAYERFS_HOME/.codex-parallel-verify/shop.json`.

## Codex `-C` and worktrees

Codex CLI sets the session root with `-C` / `--cd`:

```bash
codex exec -C ../hyp-1 "apply candidate 1 and run the tests"
```

`codex exec --worktree` and `codex --worktree` create a managed git worktree (by default under the Codex home) and use that checkout as the session root. The desktop app gives each thread its own worktree. A worktree is a full checkout. Dependencies are not in git, so each one runs its own install. N candidates cost about N copies of the tree plus N copies of `node_modules`.

This plugin is the replacement. You do **not** pass `-C` once per candidate, and you do **not** pass a LayerFS Workspace path to `-C`.

| Codex worktree | This plugin |
| --- | --- |
| `git worktree add ../hyp-1 -b hyp-1` | `spawn-n` → `branch.fork` (no file copy) |
| `npm ci` in every worktree | one `init --install`, committed on `deps` and published to `main` |
| `codex exec -C ../hyp-1 "npm test"` | edit branch `hyp-1`, then `verify-all --command "npm test"` |
| `codex exec --worktree` for another try | another Branch forked from the same `main` |
| desktop thread per worktree | one Branch per hypothesis, then one `verify-all` |
| `rm -rf ../hyp-2` | `discard --name shop hyp-2` |

`workspace.mount` returns a path such as `/workspaces/1`. That path is inside the Sandbox. It is not a directory on the host, so `codex exec -C /workspaces/1` does not see the candidate. Host Codex stays in your real checkout. Edits for a candidate go to that candidate's Branch (`fs.write` / `fs.apply`, or one `workspace.exec` plus one `workspace.commit`). The verify command runs with `workspace.exec`, which is the step that used to run in the directory you passed to `-C`.

One Codex session, one Branch. The next hypothesis is another Branch, not another `-C`.

## Commands

```bash
node bin/codex-parallel-verify.js init --name shop --source "$PWD" [--install "npm ci"] [--timeout <ms>]
node bin/codex-parallel-verify.js spawn-n --name shop --count 4 [--prefix hyp] [--from main]
node bin/codex-parallel-verify.js verify-all --name shop --command "npm test" [--sequenced | --parallel | --jobs 4] [--branches hyp-1,hyp-2] [--discard-losers]
node bin/codex-parallel-verify.js report --name shop
node bin/codex-parallel-verify.js discard --name shop hyp-2
node bin/codex-parallel-verify.js keep --name shop hyp-1
```

Add `--json` for one JSON object on stdout. `--home` overrides `LAYERFS_HOME`. `spawn-n`'s default prefix is `hyp` (`hyp-1`, `hyp-2`, …). Pass `--prefix` to use another one.

`verify-all` runs **mount → exec → commit → unmount** per Branch. A non-zero verify command is still committed once, with the exit code in the message. If that commit returns and the following unmount fails, the commit stays on the result and the unmount failure is reported separately. Default concurrency is 4. `--sequenced` is one Branch at a time. `--parallel` is all of them. Sandboxes hold 16 Workspaces. One is created when a Branch is about to mount and every Sandbox already started for this run is full, then each is closed once after the run.

`discard` and `keep` only change the ledger. They do not copy a tree, check out a worktree, or delete commits. Losers you discard stay as deduplicated history. `unmount(ws, true)` drops an uncommitted overlay and also copies nothing.

## Conflict, once

If two commits change the same path on one Branch, `workspace.commit` throws `Conflict`. `detail.conflicts` lists the paths and `detail.head` is the head that won the race. Do not send the commit again and do not pass `force`.

`verify-all` records the refusal, unmounts that Workspace once with `discard: true`, and moves on. To keep the edit, read the conflicting paths once, resolve them on a new fork, and commit there once.

## Disk report

`report` (and `verify-all`) prints:

| Field | Meaning |
| --- | --- |
| `stored` | Bytes the Store occupies on disk. From `runtime.volume.list` for this project's volume. If that figure is missing, one `stat` of the Store file (`global/store.sqlite` in the volume). |
| `unitBytes` | One materialized tree. After a successful `--install`, this is measured inside the Workspace and includes dependencies. Otherwise it is the source directory scan. |
| `worktreeBaseline` | `candidates × unitBytes`. This is the working-tree cost of one git worktree per candidate. |
| `savedBytes` | `worktreeBaseline - stored` |
| `timesSmaller` | `worktreeBaseline / stored` |

Forked candidates stay in the baseline after `discard`, because a worktree workflow would have had those trees on disk and the Store still holds their commits. The point of the number is how much you did not copy.

## Tests

```bash
npm test
```

The tests use stand-in clients. They check that each LayerFS call is made once, that a `Conflict` is not committed again, that macOS and Windows set `LAYERFS_WORKER_ENDPOINT` after one `worker.start`, and that the report's `stored` size is compared with the worktree baseline. They do not need Docker.

## Out of scope

A Cursor plugin, the DeepSeek Harness / Pi UI, changes to LayerFS itself, and the marketplace listing pull request. Those are separate.
