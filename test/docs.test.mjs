import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pin, PACKAGE_ROOT } from "../src/pin.js";

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (path.endsWith(".js")) files.push(path);
  }
  return files;
}

test("layerfs.json pins the v1.1.0 commit and the plugin id", () => {
  assert.equal(pin.commit, "9f97a7ec95b662e9cb288704afa165feff132cfa");
  assert.equal(pin.layerfs, "1.1.0");
  assert.equal(pin.id, "codex-parallel-verify");
  assert.deepEqual(pin.packages, ["@layerfs/agent", "@layerfs/runtime"]);
});

test("package.json is the MIT plugin at 0.1.0", () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "layerfs-codex-parallel-verify");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.bin["codex-parallel-verify"], "./bin/codex-parallel-verify.js");
});

test("the Codex plugin manifest points at the skill and the logo", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "codex-parallel-verify");
  assert.equal(manifest.skills, "./.agents/skills/codex-parallel-verify/SKILL.md");
  assert.equal(manifest.interface.logo, "./logo.svg");
  const logo = readFileSync(join(PACKAGE_ROOT, "logo.svg"), "utf8");
  assert.match(logo, /<svg/);
  assert.equal(existsSync(join(PACKAGE_ROOT, manifest.skills.slice(2))), true);
});

test("README Install, AGENTS.md, and the skill teach the Codex path", () => {
  const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
  const agents = readFileSync(join(PACKAGE_ROOT, "AGENTS.md"), "utf8");
  const skill = readFileSync(join(PACKAGE_ROOT, ".agents/skills/codex-parallel-verify/SKILL.md"), "utf8");
  for (const text of [readme, agents, skill]) {
    assert.match(text, /9f97a7ec95b662e9cb288704afa165feff132cfa/);
    assert.match(text, /codex exec -C/);
    assert.match(text, /--worktree/);
    assert.match(text, /Conflict/);
  }
  assert.match(readme, /^## Install/m);
  for (const command of ["init", "spawn-n", "verify-all", "report"]) {
    assert.match(readme, new RegExp(command));
    assert.match(skill, new RegExp(command));
  }
  assert.match(skill, /mount/);
  assert.match(skill, /exec/);
  assert.match(skill, /commit/);
  assert.match(skill, /fork/);
  assert.match(agents, /fork/);
  assert.match(readme, /npm test/);
  assert.match(readme, /Docker/);
  assert.match(readme, /default prefix is `hyp`/);
  assert.match(skill, /default prefix is `hyp`/);
  assert.match(readme, /needs `node` and `npm`/);
});

test("plugin code uses only the public agent and runtime packages", () => {
  const files = [...walk(join(PACKAGE_ROOT, "src")), ...walk(join(PACKAGE_ROOT, "bin"))];
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /@layerfs\/agent\/internal/);
    assert.doesNotMatch(text, /@layerfs\/backend/);
  }
});
