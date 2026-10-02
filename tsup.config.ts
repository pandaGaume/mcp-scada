import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2022",
    platform: "node",
    external: ["@cyanmycelium/mcp-broker", "@cyanmycelium/mcp-cache", "@cyanmycelium/mcp-core", "@cyanmycelium/mcp-uns"],
});
