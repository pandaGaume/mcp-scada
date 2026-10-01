import type { Destination, Operation, OperationClass, UnsId } from "../contract/scada.types";
import type { IScadaConstraints, ScadaDecisionKind } from "../policy/policy.types";

/**
 * One step of one operation. All the steps of an operation share its
 * `correlationId`, which is what links the request, the broker decision, the
 * provider execution and the native result.
 *
 * - `decision` is written before any provider call, so a crash during
 *   execution still leaves the decision on record.
 * - `result` is written after the provider answered (or failed).
 */
export interface IScadaAuditRecord {
    readonly auditId: string;
    readonly correlationId: string;
    readonly phase: "decision" | "result";
    readonly timestamp: string;
    readonly actor: string;
    readonly operation: Operation;
    readonly operationClass: OperationClass;
    readonly resource: UnsId;
    readonly destination?: Destination;
    readonly requested?: unknown;
    readonly provider: string;
    readonly policies?: readonly string[];
    readonly decision: ScadaDecisionKind;
    readonly reason: string;
    readonly constraints?: IScadaConstraints;
    readonly result?: "success" | "failure" | "refused";
    readonly errorCode?: string;
    readonly nativeStatus?: string;
    /** Broker audit id of the decision this record belongs to, when the broker decided. */
    readonly decisionId?: string;
}

export interface IScadaAuditSink {
    write(record: IScadaAuditRecord): void;
}

const SECRET_KEYS = /pass(word)?|secret|token|private.?key|credential|certificate|authorization/i;

/**
 * Removes anything that looks like a credential from a value before it is
 * audited. The audit is read by people who must not learn secrets from it.
 */
export function redact(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        output[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return output;
}

/** Writes one JSON line per record on stderr, next to the broker's own audit lines. */
export class ConsoleAuditSink implements IScadaAuditSink {
    write(record: IScadaAuditRecord): void {
        console.error(`[scada] audit ${JSON.stringify(record)}`);
    }
}

/** Keeps records in memory; for tests and for an MCP resource exposing recent activity. */
export class MemoryAuditSink implements IScadaAuditSink {
    private readonly _records: IScadaAuditRecord[] = [];
    private readonly _capacity: number;

    constructor(capacity = 1000) {
        this._capacity = capacity;
    }

    write(record: IScadaAuditRecord): void {
        this._records.push(record);
        if (this._records.length > this._capacity) this._records.shift();
    }

    get records(): readonly IScadaAuditRecord[] {
        return this._records;
    }

    byCorrelation(correlationId: string): IScadaAuditRecord[] {
        return this._records.filter((record) => record.correlationId === correlationId);
    }
}

/** Fans one record out to several sinks. */
export class TeeAuditSink implements IScadaAuditSink {
    constructor(private readonly _sinks: readonly IScadaAuditSink[]) {}

    write(record: IScadaAuditRecord): void {
        for (const sink of this._sinks) sink.write(record);
    }
}
