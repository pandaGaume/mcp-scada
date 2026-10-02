import { describe, expect, it } from "vitest";
import { MemoryCacheStore, type ICacheStore } from "@cyanmycelium/mcp-cache";
import { isItemError, type IScadaValue } from "../src/contract/scada.types";
import { FakeProvider, SPEED, makeService, operator } from "./helpers";

/** A cache.v1 store that cannot be reached, as a Redis down would be. */
function unreachable(): ICacheStore {
    const fail = async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:6379");
    };
    return { id: "down", getCapabilitiesAsync: fail, getAsync: fail, setAsync: fail, deleteAsync: fail, scanAsync: fail, closeAsync: async () => {} };
}

describe("the local destination on a cache.v1 store", () => {
    it("is shared between mcp-scada instances that share the store", async () => {
        const shared = new MemoryCacheStore();
        const a = await makeService({ localCache: shared });
        const b = await makeService({ localCache: shared }, new FakeProvider());

        await a.service.readAsync(operator, { ids: [SPEED], destination: "source" });
        const local = await b.service.readAsync(operator, { ids: [SPEED], destination: "local" });

        expect(isItemError(local.items[0]!)).toBe(false);
        expect((local.items[0] as IScadaValue).provenance).toMatchObject({ level: "local", cached: true });
        expect(b.provider.calls).toHaveLength(0);
    });

    it("answers cache_miss when the store cannot be read, and an explicit fallback goes on to the source", async () => {
        const { service, provider } = await makeService({ localCache: unreachable() });

        const local = await service.readAsync(operator, { ids: [SPEED], destination: "local" });
        expect(local.items[0]).toMatchObject({ error: { code: "cache_miss", detail: { reason: "cache_unavailable" } } });
        expect(provider.calls).toHaveLength(0);

        const fallback = await service.readAsync(operator, { ids: [SPEED], destination: ["local", "source"] });
        expect(isItemError(fallback.items[0]!)).toBe(false);
        expect(provider.calls.filter((call) => call.op === "read")).toHaveLength(1);
    });

    it("does not fail a source read when the store cannot keep its value", async () => {
        const { service } = await makeService({ localCache: unreachable() });
        const read = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(isItemError(read.items[0]!)).toBe(false);
    });

    it("lets local values expire with localCacheTtlMs", async () => {
        const now = { t: Date.parse("2026-01-01T00:00:00.000Z") };
        const clock = () => now.t;
        const { service } = await makeService({ localCache: new MemoryCacheStore({ now: clock }), localCacheTtlMs: 1_000, now: clock });

        await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        now.t += 999;
        expect(isItemError((await service.readAsync(operator, { ids: [SPEED], destination: "local" })).items[0]!)).toBe(false);
        now.t += 1;
        expect((await service.readAsync(operator, { ids: [SPEED], destination: "local" })).items[0]).toMatchObject({ error: { code: "cache_miss" } });
    });
});
