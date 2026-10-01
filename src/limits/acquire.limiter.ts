import { ScadaError } from "../contract/scada.provider";

export interface IAcquireLimits {
    /** Downstream reads in flight at once, per provider. */
    readonly maxConcurrent?: number;
    /** Downstream reads started per rolling second, per provider. */
    readonly maxPerSecond?: number;
}

/**
 * Bounds the `acquire` traffic mcp-scada sends to one provider.
 *
 * The effective limit is the stricter of the deployment's and the provider's
 * declaration. Excess requests are refused with `rate_limited` rather than
 * queued: a queued forced read would return a value older than the caller
 * asked for, which is a silent downgrade.
 */
export class AcquireLimiter {
    private readonly _maxConcurrent: number;
    private readonly _maxPerSecond: number;
    private readonly _now: () => number;
    private _inFlight = 0;
    private _starts: number[] = [];

    constructor(limits: IAcquireLimits, now: () => number = Date.now) {
        this._maxConcurrent = limits.maxConcurrent ?? Number.POSITIVE_INFINITY;
        this._maxPerSecond = limits.maxPerSecond ?? Number.POSITIVE_INFINITY;
        this._now = now;
    }

    static strictest(...limits: (IAcquireLimits | undefined)[]): IAcquireLimits {
        const pick = (values: (number | undefined)[]): number | undefined => {
            const defined = values.filter((value): value is number => typeof value === "number" && value > 0);
            return defined.length ? Math.min(...defined) : undefined;
        };
        return { maxConcurrent: pick(limits.map((l) => l?.maxConcurrent)), maxPerSecond: pick(limits.map((l) => l?.maxPerSecond)) };
    }

    get inFlight(): number {
        return this._inFlight;
    }

    async run<T>(provider: string, work: () => Promise<T>): Promise<T> {
        const now = this._now();
        this._starts = this._starts.filter((start) => now - start < 1000);
        if (this._inFlight >= this._maxConcurrent) {
            throw new ScadaError("rate_limited", `provider "${provider}" already has ${this._inFlight} acquire operations in flight`, {
                detail: { maxConcurrent: this._maxConcurrent },
            });
        }
        if (this._starts.length >= this._maxPerSecond) {
            throw new ScadaError("rate_limited", `provider "${provider}" reached ${this._maxPerSecond} acquire operations per second`, {
                detail: { maxPerSecond: this._maxPerSecond },
            });
        }
        this._inFlight += 1;
        this._starts.push(now);
        try {
            return await work();
        } finally {
            this._inFlight -= 1;
        }
    }
}
