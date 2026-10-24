import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ledgerPath(home, project) {
  return join(home, ".codex-parallel-verify", `${project}.json`);
}

export function loadLedger(home, project) {
  const path = ledgerPath(home, project);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function emptyLedger({ project, source, commit, sourceBytes, unitBytes, unitBytesFrom }) {
  return {
    plugin: "codex-parallel-verify",
    layerfs: "1.1.0",
    commit,
    project,
    source: source ?? null,
    sourceBytes: sourceBytes ?? null,
    unitBytes: unitBytes ?? null,
    unitBytesFrom: unitBytesFrom ?? null,
    install: null,
    branches: [],
    results: [],
    discarded: [],
    kept: [],
  };
}

export function saveLedger(home, ledger) {
  const path = ledgerPath(home, ledger.project);
  mkdirSync(join(home, ".codex-parallel-verify"), { recursive: true, mode: 0o700 });
  const next = { ...ledger, updatedAt: new Date().toISOString() };
  const temporary = `${path}.new`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return next;
}
