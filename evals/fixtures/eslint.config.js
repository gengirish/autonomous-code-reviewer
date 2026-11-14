// Fixture PRs are sample code under review (with seeded bugs), not project code: never lint them.
// ESLint 10 resolves the config from each file's directory, so this overrides the root config here.
export default [{ ignores: ["**/*"] }];
