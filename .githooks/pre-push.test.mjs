// Tests .githooks/pre-push with a stub gitleaks on PATH (no real scan): the stub records each --log-opts range
// and, like any command that inherits the hook's stdin, reads that stdin to the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const hook = fileURLToPath(new URL("./pre-push", import.meta.url));
const zero = "0".repeat(40);
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pre-push-test-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("remote", "add", "origin", "https://example.invalid/repo.git");
  git("update-ref", "refs/remotes/origin/dev", base);
  git("commit", "-q", "--allow-empty", "-m", "a");
  const a = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "b");
  const b = git("rev-parse", "HEAD");
  const log = join(dir, "gitleaks.log");
  writeFileSync(log, "");
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  writeFileSync(join(bin, "gitleaks"), `#!/bin/bash\ncat >/dev/null\nfor a in "$@"; do [[ $a == --log-opts=* ]] && echo "\${a#--log-opts=}" >> "${log}"; done\nexit 0\n`);
  chmodSync(join(bin, "gitleaks"), 0o755);
  return { repo, bin, log, base, a, b };
}

function push(ctx, args, lines) {
  const r = spawnSync("bash", [hook, ...args], {
    cwd: ctx.repo,
    input: lines.map((l) => l.join(" ") + "\n").join(""),
    env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr, ranges: readFileSync(ctx.log, "utf8").split("\n").filter(Boolean) };
}

test("every ref in one push is scanned, not only the first (gitleaks must not read the ref list)", () => {
  const c = setup();
  const r = push(c, ["origin", "https://example.invalid/repo.git"], [
    ["refs/heads/dev", c.b, "refs/heads/dev", c.base],
    ["refs/heads/feature", c.a, "refs/heads/feature", zero],
    ["refs/heads/old", zero, "refs/heads/old", c.base],
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ranges, [`${c.base}..${c.b}`, `${c.a} --not --remotes=origin`]);
});

test("pushing to a URL scans a new branch against every remote-tracking ref, not the full history", () => {
  const c = setup();
  const url = "https://example.invalid/repo.git";
  const r = push(c, [url, url], [["refs/heads/feature", c.a, "refs/heads/feature", zero]]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ranges, [`${c.a} --not --remotes`]);
});

test("a finding blocks the push", () => {
  const c = setup();
  writeFileSync(join(c.bin, "gitleaks"), "#!/bin/bash\nexit 1\n");
  const r = push(c, ["origin", "x"], [["refs/heads/dev", c.b, "refs/heads/dev", c.base]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the push is blocked/);
});
