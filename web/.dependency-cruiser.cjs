/** Module boundaries: shared code never imports features; domain code never imports the app layer. */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "db-is-shared", severity: "error", from: { path: "^src/db" }, to: { path: "^src/(modules|services|app|platform)" } },
    { name: "platform-is-shared", severity: "error", from: { path: "^src/platform" }, to: { path: "^src/(modules|services|app|db)" } },
    { name: "modules-not-app", severity: "error", from: { path: "^src/modules" }, to: { path: "^src/(app|services)" } },
    { name: "services-not-app", severity: "error", from: { path: "^src/services" }, to: { path: "^src/app" } },
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
