import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    projects: [
      {
        extends: true,
        // The first test in a Fastify file pays cold module/JIT cost; under full parallel load
        // on Windows that alone can pass the 5 s default. Real hangs still fail at 15 s.
        test: { name: "unit", include: ["test/unit/**/*.test.ts"], testTimeout: 15_000 },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
