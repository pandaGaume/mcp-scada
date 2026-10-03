import { defineConfig } from "vitest/config";

// Load measurements on the motor bench (see bench/load.bench.ts): same prerequisites as the live tests.
export default defineConfig({
    test: {
        include: ["bench/**/*.bench.ts"],
        environment: "node",
        testTimeout: 600_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
});
