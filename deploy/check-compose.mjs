// Fails when any compose service publishes a port on an address other than 127.0.0.1 or uses the
// host network (plan step 2): the system is reachable only through Tailscale Serve on the VM; and when
// the browser tier shares a network with any service but daily (plan step 8d).
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
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`compose ports ok (${Object.keys(compose.services ?? {}).length} services)`);
