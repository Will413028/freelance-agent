// Fails when any compose service publishes a port on an address other than 127.0.0.1 or uses the
// host network (plan step 2): the system is reachable only through Tailscale Serve on the VM; and when
// the browser tier shares a network with any service but daily (plan step 8d); when a service other than
// daily gets the Resend key (12e O3); when the systemd unit's container name and stop disagree (12e O4); and
// when the timer's first trigger is not EARLIEST_HOUR in web/src/services/run-daily.ts (12e W5).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../web/package.json", import.meta.url));
const { parse } = require("yaml");
const file = process.argv[2] ?? new URL("./compose.yaml", import.meta.url);
const compose = parse(readFileSync(file, "utf8"), { merge: true });

const hostIp = (port) => {
  if (typeof port === "object" && port !== null) return port.host_ip ?? null;
  const parts = String(port).split(":");
  return parts.length === 3 ? parts[0] : null; // "3000" and "3347:3000" bind every address
};

const problems = [];
for (const [name, service] of Object.entries(compose.services ?? {})) {
  if (service.network_mode === "host") problems.push(`${name}: network_mode host`);
  for (const port of service.ports ?? []) {
    if (hostIp(port) !== "127.0.0.1") problems.push(`${name}: port ${JSON.stringify(port)} is not bound to 127.0.0.1`);
  }
}
// The browser tier loads untrusted pages (plan step 8d): it publishes no port, shares no network
// namespace, and shares a Docker network with no service but daily. Network keys are compared by the
// Docker network they name (`name:`), so an alias of the default network is caught too.
const networkName = (key) => compose.networks?.[key]?.name ?? key;
const networksOf = (service) => {
  const n = service.networks ?? ["default"];
  return (Array.isArray(n) ? n : Object.keys(n)).map(networkName);
};
const browser = compose.services?.browser;
if (browser) {
  if ((browser.ports ?? []).length) problems.push("browser: publishes a port");
  if (browser.network_mode) problems.push(`browser: network_mode ${browser.network_mode}`);
  for (const [name, service] of Object.entries(compose.services)) {
    if (name === "browser") continue;
    if (service.network_mode === "service:browser") problems.push(`${name}: shares the browser's network namespace`);
    if (name === "daily") continue;
    const shared = networksOf(service).filter((n) => networksOf(browser).includes(n));
    if (shared.length) problems.push(`${name}: shares network ${shared.join(", ")} with browser`);
  }
}
// Only daily reads mail (plan step 7): the Resend key goes nowhere else, migrations included.
for (const [name, service] of Object.entries(compose.services ?? {})) {
  const env = service.environment ?? {};
  const names = Array.isArray(env) ? env.map((e) => String(e).split("=")[0]) : Object.keys(env);
  if (name !== "daily" && names.includes("RESEND_API_KEY")) problems.push(`${name}: gets RESEND_API_KEY`);
}
// The unit names its run container and removes it after a stop or timeout; both must name the same container.
const unit = readFileSync(new URL("./systemd/side-income-daily.service", import.meta.url), "utf8");
const runName = unit.match(/^ExecStart=.* run --rm --name (\S+) daily$/m)?.[1];
if (!runName) problems.push("systemd: ExecStart does not run daily with --rm --name <container>");
else if (!new RegExp(`^ExecStopPost=-/usr/bin/docker rm --force ${runName}$`, "m").test(unit)) problems.push(`systemd: no ExecStopPost removes ${runName}`);
// A Persistent catch-up before the first trigger exits as not_due: the two hours must agree.
const timer = readFileSync(new URL("./systemd/side-income-daily.timer", import.meta.url), "utf8");
const hours = [...timer.matchAll(/^OnCalendar=\*-\*-\* (\d{2}):00:00 Asia\/Taipei$/gm)].map((m) => Number(m[1]));
const earliest = Number(readFileSync(new URL("../web/src/services/run-daily.ts", import.meta.url), "utf8").match(/^export const EARLIEST_HOUR = (\d+);$/m)?.[1]);
if (!hours.length || Math.min(...hours) !== earliest) problems.push(`systemd: the timer's first trigger (${hours.join(", ")}) is not EARLIEST_HOUR (${earliest})`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`compose ports ok (${Object.keys(compose.services ?? {}).length} services)`);
