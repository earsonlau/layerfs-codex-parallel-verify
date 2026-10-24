import { formatBytes } from "./metrics.js";

function ratio(timesSmaller) {
  if (timesSmaller == null) return "n/a";
  if (timesSmaller >= 10) return `${timesSmaller.toFixed(0)}× smaller`;
  return `${timesSmaller.toFixed(2)}× smaller`;
}

function resultLabel(result, discarded) {
  if (discarded) return "discarded";
  if (result.conflict) return "conflict";
  if (result.error) return result.error.code || "error";
  return result.pass ? "pass" : "fail";
}

/** A short report for a person. `--json` prints the object instead. */
export function renderReport(report) {
  const lines = [
    `codex-parallel-verify  ${report.project}`,
    `LayerFS ${report.layerfs}  ${report.commit}`,
    "",
    `stored              ${formatBytes(report.stored)}  (${report.storedFrom ?? "unavailable"})`,
    `one worktree        ${formatBytes(report.unitBytes)}  (${report.unitBytesFrom ?? "unknown"})`,
    `candidates          ${report.candidates}`,
    `worktree baseline   ${formatBytes(report.worktreeBaseline)}  (${report.candidates} × ${formatBytes(report.unitBytes)})`,
    `saved               ${formatBytes(report.savedBytes)}  (${ratio(report.timesSmaller)})`,
    `pass ${report.pass}   fail ${report.fail}`,
    "",
  ];
  if (report.results?.length) {
    lines.push("branch  result  exit  note");
    for (const result of report.results) {
      const discarded = report.discarded?.includes(result.branch);
      const head = result.commit?.head ?? result.commit?.commit?.id ?? "";
      const unmountNote = result.unmount ? `unmount ${result.unmount.code}` : "";
      const note = result.conflict
        ? "Conflict once, not retried"
        : result.error
          ? result.error.message
          : unmountNote
            ? (head ? `${head}; ${unmountNote}` : unmountNote)
            : head;
      lines.push(`${result.branch}  ${resultLabel(result, discarded)}  ${result.exitCode ?? "—"}  ${note}`);
    }
  } else {
    lines.push("No verify results yet.");
  }
  if (report.kept?.length) lines.push("", `kept  ${report.kept.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

export function renderInit(ledger) {
  const install = ledger.install
    ? `install ${ledger.install.pass ? "published" : "not published"} on ${ledger.install.branch} (exit ${ledger.install.exitCode ?? "—"})`
    : "no install command";
  return [
    `initialized ${ledger.project}`,
    `source ${formatBytes(ledger.sourceBytes)}`,
    `one worktree ${formatBytes(ledger.unitBytes)} (${ledger.unitBytesFrom})`,
    install,
    `fork candidates with: codex-parallel-verify spawn-n --name ${ledger.project} --count N --prefix hyp`,
    "",
  ].join("\n");
}

export function renderSpawn(ledger, names) {
  const lines = [`forked on ${ledger.project}`];
  for (const name of names) {
    const branch = ledger.branches.find((item) => item.name === name);
    lines.push(branch?.forked ? `${name}  forked` : `${name}  ${branch?.error?.code ?? "not forked"}`);
  }
  return `${lines.join("\n")}\n`;
}
