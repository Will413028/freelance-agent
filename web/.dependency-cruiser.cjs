/** Module boundaries: shared code never imports features; domain code never imports the app layer. */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "db-is-shared", severity: "error", from: { path: "^src/db" }, to: { path: "^src/(modules|workflows|app|platform)" } },
    { name: "platform-is-shared", severity: "error", from: { path: "^src/platform" }, to: { path: "^src/(modules|workflows|app|db)" } },
    { name: "modules-not-app", severity: "error", from: { path: "^src/modules" }, to: { path: "^src/(app|workflows|services)" } },
    { name: "services-not-app", severity: "error", from: { path: "^src/services" }, to: { path: "^src/(app|workflows)" } },
    {
      name: "discovery-is-a-leaf",
      comment: "Rules and settings are shared by collection, legacy and preferences; composing them belongs in src/services.",
      severity: "error",
      from: { path: "^src/modules/discovery/" },
      to: { path: "^src/modules/(?!discovery/)" },
    },
    { name: "ops-stand-alone", comment: "Operations tooling reads tables, not product modules.", severity: "error", from: { path: "^src/ops" }, to: { path: "^src/(modules|workflows|app|services|verify)" } },
    {
      name: "verify-runs-only-the-digest",
      comment: "Verification tools run product code on a copy (the digest replay runs create_digest); nothing else of the product.",
      severity: "error",
      from: { path: "^src/verify" },
      to: { path: "^src/(modules|workflows|app|services)", pathNot: "^src/services/digest\.ts$" },
    },
    { name: "product-not-verify", severity: "error", from: { path: "^src/(modules|workflows|app|db|platform|services|ops)" }, to: { path: "^src/verify" } },
    { name: "product-not-ops", severity: "error", from: { path: "^src/(modules|workflows|app|db|platform)" }, to: { path: "^src/ops" } },
    { name: "workflows-not-app", severity: "error", from: { path: "^src/workflows" }, to: { path: "^src/app" } },
    {
      name: "modules-use-public-contracts",
      comment: "Another module is reached only through its public.ts.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: { path: "^src/modules/[^/]+/", pathNot: ["^src/modules/$1/", "^src/modules/[^/]+/public\\.ts$"] },
    },
  ],
  options: { exclude: { path: "\\.test\\.ts$" }, parser: "swc", tsConfig: { fileName: "tsconfig.json" }, doNotFollow: { path: "node_modules" } },
};
