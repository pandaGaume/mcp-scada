import { defineConfig } from "vitest/config";

// Live tests start a Modbus TCP simulator, an embedded mcp-broker and the C++
// mcp-modbus provider. They need a sibling mcp-modbus checkout with a built
// provider and its pyModbusTCP virtual environment; see test-bench/README.md.
export default defineConfig({
    test: {
        include: ["tests/live/**/*.test.ts"],
        environment: "node",
        testTimeout: 30_000,
        hookTimeout: 60_000,
        fileParallelism: false,
    },
});
