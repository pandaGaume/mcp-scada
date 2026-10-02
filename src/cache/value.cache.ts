import { MemoryCacheStore, isItemError, type ICacheStore } from "@cyanmycelium/mcp-cache";
import type { IScadaValue, UnsId } from "../contract/scada.types";

export interface ILocalValueCacheOptions {
    /**
     * Where the values are kept: any cache.v1 store. Default: this process's
     * memory. A `RedisCacheStore` gives several mcp-scada instances one shared
     * `local` view; give it a prefix of its own (`mcp-scada:local:`).
     */
    readonly store?: ICacheStore;
    /** Time to live of each value. Default: none in memory; set one for a shared store, or its keys stay. */
    readonly ttlMs?: number;
    /** Clock, for tests. Also drives the default memory store, so that ages stay coherent. */
    readonly now?: () => number;
}

/**
 * The `local` destination: values mcp-scada already holds, in the broker tier.
 *
 * It is filled only by reads that really went downstream, and it never goes
 * downstream itself. A `local` read therefore produces no traffic towards the
 * equipment by construction, which is the guarantee the contract makes for it.
 *
 * The values live in a cache.v1 store, read in process: going through a cache
 * slot would add a network hop to a read that promises none.
 */
export class LocalValueCache {
    private readonly _store: ICacheStore;
    private readonly _ttlMs?: number;
    private readonly _now: () => number;

    constructor(options: ILocalValueCacheOptions = {}) {
        this._now = options.now ?? Date.now;
        this._store = options.store ?? new MemoryCacheStore({ id: "mcp-scada-local", now: this._now });
        this._ttlMs = options.ttlMs;
    }

    /**
     * Keeps the values of a downstream read. `bad` values are not kept: a
     * `local` read must never serve a value the source itself disowned.
     *
     * Never throws: a cache that cannot store only costs a later `cache_miss`,
     * it must not fail the read that fed it.
     */
    async storeAsync(values: readonly IScadaValue[]): Promise<void> {
        const entries = values.filter((value) => value.quality !== "bad").map((value) => ({ id: value.id, value, ...(this._ttlMs ? { ttlMs: this._ttlMs } : {}) }));
        if (entries.length === 0) return;
        try {
            await this._store.setAsync(entries);
        } catch {
            // The next local read reports the miss.
        }
    }

    /**
     * The cached values found among `ids`, with their provenance rewritten to
     * say where they come from now. Rejects when the store cannot be read.
     */
    async getAsync(ids: readonly UnsId[]): Promise<Map<UnsId, { value: IScadaValue; ageMs: number }>> {
        const found = new Map<UnsId, { value: IScadaValue; ageMs: number }>();
        if (ids.length === 0) return found;
        const { items } = await this._store.getAsync(ids);
        const now = this._now();
        for (const item of items) {
            if (isItemError(item) || !item.hit) continue;
            const value = item.value as IScadaValue;
            const ageMs = Math.max(0, now - Date.parse(item.storedAt));
            const original = value.provenance;
            found.set(item.id, {
                ageMs,
                value: {
                    ...value,
                    provenance: {
                        provider: original.provider,
                        level: "local",
                        cached: true,
                        cacheMode: "read-through",
                        ageMs: (original.ageMs ?? 0) + ageMs,
                    },
                },
            });
        }
        return found;
    }

    /** Drops every value this cache holds. */
    async clearAsync(): Promise<void> {
        const ids = new Set<UnsId>();
        let cursor: string | undefined;
        do {
            const page = await this._store.scanAsync(cursor ? { cursor } : {});
            page.ids.forEach((id) => ids.add(id));
            cursor = page.cursor ?? undefined;
        } while (cursor);
        const all = [...ids];
        const max = (await this._store.getCapabilitiesAsync()).limits.maxIdsPerCall;
        for (let start = 0; start < all.length; start += max) await this._store.deleteAsync(all.slice(start, start + max));
    }

    async closeAsync(): Promise<void> {
        await this._store.closeAsync();
    }
}
