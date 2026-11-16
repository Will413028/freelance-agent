// Tests deploy/deploy.sh's decisions with stub docker, git and flock on PATH (no containers; plan step 9).
// The stub docker reads the env file's APP_IMAGE at call time: `inspect` says unhealthy when it matches the
// glob FAKE_BAD (and `starting` forever with FAKE_STUCK), `up -d web` fails when it matches FAKE_UP_FAIL;
// FAKE_MIGRATE_FAIL fails the migration; FAKE_BUILD_FAIL fails a build whose arguments contain it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./deploy.sh", import.meta.url));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "deploy-test-"));
  dirs.push(dir);
  const envFile = join(dir, "compose.env");
  const calls = join(dir, "calls.log");
  const head = join(dir, "head");
  writeFileSync(envFile, "APP_IMAGE=side-income-web:old1234\nPOSTGRES_PASSWORD=x\n");
  writeFileSync(head, "old1234full\n");
  writeFileSync(calls, "");
  const stubs = {
    docker: `#!/bin/bash
img=$(sed -n 's/^APP_IMAGE=//p' "${envFile}")
echo "docker env=$img APP_IMAGE=\${APP_IMAGE:-} $*" >> "${calls}"
if [[ "$1" == build ]]; then [[ -n "\${FAKE_BUILD_FAIL:-}" && "$*" == *"\$FAKE_BUILD_FAIL"* ]] && exit 1; exit 0; fi
if [[ "$1" == inspect ]]; then
  if [[ -n "\${FAKE_STUCK:-}" ]]; then echo starting
  elif [[ "$img" == \${FAKE_BAD:-none} ]]; then echo unhealthy; else echo healthy; fi; exit 0
fi
shift 5 # compose --env-file F -f Y
case "$1 \${2:-} \${3:-}" in
  "run --rm daily") [[ -n "\${FAKE_MIGRATE_FAIL:-}" ]] && exit 1 ;;
  "up -d web") [[ "$img" == \${FAKE_UP_FAIL:-none} ]] && exit 1 ;;
  "ps -q web") echo web-container ;;
esac
exit 0
`,
    git: `#!/bin/bash
echo "git $*" >> "${calls}"
case "$1" in
  rev-parse)
    if [[ "$2" == --short ]]; then cut -c1-7 "${head}"
    elif [[ "$2" == --verify && "$3" == --quiet ]]; then [[ "$4" == refs/remotes/origin/dev* ]] && echo new5678full || exit 1
    elif [[ "$2" == --verify ]]; then echo "\${3%^*}"
    else cat "${head}"; fi ;;
  checkout) echo "\${@: -1}" > "${head}" ;;
esac
exit 0
`,
    flock: "#!/bin/bash\nexit 0\n",
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, envFile, calls, head };
}

function run(extraEnv = {}, target = "new5678full") {
  const ctx = setup();
  const r = spawnSync("bash", [script, target], {
    env: { ...process.env, PATH: `${ctx.dir}:${process.env.PATH}`, ENV_FILE: ctx.envFile, REPO: ctx.dir, POLL: "0", HEALTH_TIMEOUT: "2", ...extraEnv },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stderr: r.stderr, calls: readFileSync(ctx.calls, "utf8"), env: readFileSync(ctx.envFile, "utf8"), head: readFileSync(ctx.head, "utf8").trim() };
}
const OLD = /^APP_IMAGE=side-income-web:old1234$/m;
const upWeb = (calls) => calls.split("\n").filter((l) => / up -d web$/.test(l));

test("healthy deploy switches APP_IMAGE and migrates with the new image", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.env, /^APP_IMAGE=side-income-web:new5678$/m);
  assert.match(r.env, /^POSTGRES_PASSWORD=x$/m);
  assert.match(r.calls, /APP_IMAGE=side-income-web:new5678 compose .* run --rm daily pnpm exec tsx scripts\/migrate-pg\.ts/);
  assert.equal(r.head, "new5678full");
});

test("builds the browser tier as the app image's tag plus -browser (plan step 8d)", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, / build -f deploy\/browser\.Dockerfile -t side-income-web:new5678-browser browser$/m);
});

test("a branch name deploys the fetched origin branch", () => {
  const r = run({}, "dev");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.head, "new5678full");
});

test("failed build or migration leaves APP_IMAGE, the checkout and web untouched", () => {
  for (const env of [{ FAKE_BUILD_FAIL: "web.Dockerfile" }, { FAKE_BUILD_FAIL: "browser.Dockerfile" }, { FAKE_MIGRATE_FAIL: "1" }]) {
    const r = run(env);
    assert.equal(r.status, 1);
    assert.match(r.env, OLD);
    assert.deepEqual(upWeb(r.calls), []);
    assert.equal(r.head, "old1234full");
  }
});

test("unhealthy web rolls APP_IMAGE and the checkout back, then recreates web on the old image", () => {
  const r = run({ FAKE_BAD: "side-income-web:new5678" });
  assert.equal(r.status, 1);
  assert.match(r.env, OLD);
  assert.equal(r.head, "old1234full");
  const ups = upWeb(r.calls);
  assert.equal(ups.length, 2);
  assert.match(ups[0], /env=side-income-web:new5678 /);
  assert.match(ups[1], /env=side-income-web:old1234 /);
  assert.match(r.stderr, /rolled back to side-income-web:old1234/);
});

test("a failing recreate of web also rolls back", () => {
  const r = run({ FAKE_UP_FAIL: "side-income-web:new5678" });
  assert.equal(r.status, 1);
  assert.match(r.env, OLD);
  assert.match(r.stderr, /rolled back to side-income-web:old1234/);
});

test("a rollback that is unhealthy too says so", () => {
  const r = run({ FAKE_BAD: "side-income-web:*" });
  assert.equal(r.status, 1);
  assert.match(r.env, OLD);
  assert.match(r.stderr, /ROLLBACK UNHEALTHY/);
});

test("a health status that never settles times out and rolls back", () => {
  const r = run({ FAKE_STUCK: "1" });
  assert.equal(r.status, 1);
  assert.match(r.env, OLD);
  assert.match(r.stderr, /not healthy within/);
});
