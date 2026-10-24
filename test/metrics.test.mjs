import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatBytes, spaceReport } from "../src/metrics.js";
import { candidateNames, verifyMessage } from "../src/names.js";
import { parseByteCount, treeBytes } from "../src/tree-bytes.js";
import { UsageError } from "../src/errors.js";

test("space report compares one Store with N worktrees", () => {
  const report = spaceReport({ stored: 100, unitBytes: 1000, candidates: 4 });
  assert.equal(report.worktreeBaseline, 4000);
  assert.equal(report.savedBytes, 3900);
  assert.equal(report.timesSmaller, 40);
  assert.equal(spaceReport({ stored: 0, unitBytes: 10, candidates: 2 }).timesSmaller, null);
  assert.equal(spaceReport({ stored: 10, unitBytes: null, candidates: 2 }).worktreeBaseline, null);
});

test("formatBytes uses decimal units", () => {
  assert.equal(formatBytes(4), "4 B");
  assert.equal(formatBytes(1000), "1.00 KB");
  assert.equal(formatBytes(10_000), "10.0 KB");
  assert.equal(formatBytes(100_000), "100 KB");
  assert.equal(formatBytes(null), "unknown");
  assert.equal(formatBytes(-20), "-20 B");
});

test("verify messages stay within 4096 bytes", () => {
  const message = verifyMessage("hyp-1", "x".repeat(8000), 0);
  assert.ok(Buffer.byteLength(message) <= 4096);
  assert.match(message, /\(exit 0\)$/);
});

test("candidate names are lowercase LayerFS names", () => {
  assert.deepEqual(candidateNames("hyp", 2), ["hyp-1", "hyp-2"]);
  assert.throws(() => candidateNames("Hyp", 1), UsageError);
  assert.throws(() => candidateNames("hyp", 0), UsageError);
});

test("tree bytes skip symlinks and count regular files once", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpv-tree-"));
  await writeFile(join(root, "real.txt"), "abcd");
  await symlink(join(root, "real.txt"), join(root, "link.txt"));
  const scanned = await treeBytes(root);
  assert.equal(scanned.bytes, 4);
  assert.equal(scanned.files, 1);
  assert.equal(parseByteCount("42\n"), 42);
  assert.equal(parseByteCount("nope"), null);
});
