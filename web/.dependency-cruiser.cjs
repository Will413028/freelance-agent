/** Module boundaries: shared code never imports features; domain code never imports the app layer. */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "db-is-shared", severity: "error", from: { path: "^src/db" }, to: { path: "^src/(modules|workflows|app)" } },
    { name: "modules-not-app", severity: "error", from: { path: "^src/modules" }, to: { path: "^src/(app|workflows)" } },
    { name: "workflows-not-app", severity: "error", from: { path: "^src/workflows" }, to: { path: "^src/app" } },
  ],
  options: { parser: "swc", tsConfig: { fileName: "tsconfig.json" }, doNotFollow: { path: "node_modules" } },
};
