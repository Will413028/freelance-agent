// Tests .githooks/pre-push with a stub gitleaks on PATH (no real scan): the stub records each --log-opts range
// and, like any command that inherits the hook's stdin, reads that stdin to the end; it fails (a "finding") when a
// commit in the range has FAKE_SECRET in its message. Every git call runs with the GIT_* variables stripped (a hook
// that runs this test exports GIT_DIR and friends, which would otherwise point git at the real checkout), and the
// temp repository disables signing and hooks.
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
// The parent's env minus every GIT_* variable, so git always resolves the repository from its cwd / -C.
const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), ...extra });
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pre-push-test-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: cleanEnv() }).trim();
  execFileSync("git", ["init", "-q", repo], { env: cleanEnv() });
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
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
  writeFileSync(join(bin, "gitleaks"), `#!/bin/bash\ncat >/dev/null\nfor a in "$@"; do [[ $a == --log-opts=* ]] && o="\${a#--log-opts=}" && echo "$o" >> "${log}"; done\n! git log --format=%B $o | grep -q FAKE_SECRET\n`);
  chmodSync(join(bin, "gitleaks"), 0o755);
  return { repo, git, bin, log, base, a, b };
}

function push(ctx, args, lines) {
  const r = spawnSync("bash", [hook, ...args], {
    cwd: ctx.repo,
    input: lines.map((l) => l.join(" ") + "\n").join(""),
    env: cleanEnv({ PATH: `${ctx.bin}:${process.env.PATH}` }),
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

test("pushing to a URL scans the full history: a commit that only another remote has is not taken as scanned", () => {
  const c = setup();
  c.git("commit", "-q", "--allow-empty", "-m", "FAKE_SECRET leaked");
  const leak = c.git("rev-parse", "HEAD");
  c.git("remote", "add", "fork", "https://example.invalid/fork.git");
  c.git("update-ref", "refs/remotes/fork/dev", leak);
  const url = "https://example.invalid/repo.git";
  const r = push(c, [url, url], [["refs/heads/feature", leak, "refs/heads/feature", zero]]);
  assert.deepEqual(r.ranges, [leak]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the push is blocked/);
});

test("a new branch to a named remote excludes only that remote's refs, never another remote's", () => {
  const c = setup();
  c.git("commit", "-q", "--allow-empty", "-m", "FAKE_SECRET leaked");
  const leak = c.git("rev-parse", "HEAD");
  c.git("remote", "add", "fork", "https://example.invalid/fork.git");
  c.git("update-ref", "refs/remotes/fork/dev", leak);
  const r = push(c, ["origin", "x"], [["refs/heads/feature", leak, "refs/heads/feature", zero]]);
  assert.deepEqual(r.ranges, [`${leak} --not --remotes=origin`]);
  assert.equal(r.status, 1);
});

test("the first push to a named remote with no remote-tracking refs scans the full history", () => {
  const c = setup();
  c.git("remote", "add", "fresh", "https://example.invalid/fresh.git");
  const r = push(c, ["fresh", "x"], [["refs/heads/dev", c.b, "refs/heads/dev", zero]]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.ranges, [c.b]);
});

test("a GIT_DIR in the parent env cannot reach the test's git calls (the real checkout stays untouched)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pre-push-victim-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "--bare", dir], { env: cleanEnv() });
  const before = execFileSync("git", ["--git-dir", dir, "for-each-ref"], { encoding: "utf8", env: cleanEnv() });
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = dir;
  try {
    const c = setup();
    push(c, ["origin", "x"], [["refs/heads/dev", c.b, "refs/heads/dev", c.base]]);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
  const afterRefs = execFileSync("git", ["--git-dir", dir, "for-each-ref"], { encoding: "utf8", env: cleanEnv() });
  const config = readFileSync(join(dir, "config"), "utf8");
  assert.equal(afterRefs, before);
  assert.equal(afterRefs, "");
  assert.doesNotMatch(config, /example\.invalid|hooksPath|gpgsign/);
});

test("a finding blocks the push", () => {
  const c = setup();
  writeFileSync(join(c.bin, "gitleaks"), "#!/bin/bash\nexit 1\n");
  const r = push(c, ["origin", "x"], [["refs/heads/dev", c.b, "refs/heads/dev", c.base]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the push is blocked/);
});
