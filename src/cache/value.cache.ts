import type { IScadaValue, UnsId } from "../contract/scada.types";

interface IEntry {
    readonly value: IScadaValue;
    readonly storedAt: number;
}

/**
 * The `local` destination: values mcp-scada already holds, in the broker tier.
 *
 * It is filled only by reads that really went downstream, and it never goes
 * downstream itself. A `local` read therefore produces no traffic by
 * construction, which is the guarantee the contract makes for it.
 */
export class LocalValueCache {
    private readonly _entries = new Map<UnsId, IEntry>();
    private readonly _now: () => number;

    constructor(now: () => number = Date.now) {
        this._now = now;
    }

    store(value: IScadaValue): void {
        if (value.quality === "bad") return;
        this._entries.set(value.id, { value, storedAt: this._now() });
    }

    /** The cached value with its provenance rewritten to say where it came from now. */
    get(id: UnsId): { value: IScadaValue; ageMs: number } | undefined {
        const entry = this._entries.get(id);
        if (!entry) return undefined;
        const ageMs = Math.max(0, this._now() - entry.storedAt);
        const original = entry.value.provenance;
        return {
            ageMs,
            value: {
                ...entry.value,
                provenance: {
                    provider: original.provider,
                    level: "local",
                    cached: true,
                    cacheMode: "read-through",
                    ageMs: (original.ageMs ?? 0) + ageMs,
                },
            },
        };
    }

    clear(): void {
        this._entries.clear();
    }
}
