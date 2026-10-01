import type { IScadaAuditRecord, IScadaAuditSink } from "../audit/audit";
import type { IBrokerChannel } from "./broker.protocol";

/**
 * Audit sink for broker mode: the broker is the only audit authority.
 *
 * Decisions are already recorded by the broker when it answers
 * `broker/authorize`, so `decision` records are not sent again. Each
 * `result` record of a broker decision becomes one `broker/audit/result`
 * notification, which the broker links to its decision by `decisionId`.
 * A record without a decision id (a refusal decided before any question,
 * such as an unsupported capability) has nothing to attach to and is only
 * passed to the optional local sink.
 *
 * With a broker older than `broker/audit/result`, give it a channel without
 * `reportResult` and a local sink: results are then kept locally, each one
 * carrying the broker's `decisionId` and `correlationId`, which is what links
 * them to the decision the broker audited.
 */
export class BrokerAuditReporter implements IScadaAuditSink {
    constructor(
        private readonly _channel: IBrokerChannel,
        private readonly _local?: IScadaAuditSink
    ) {}

    write(record: IScadaAuditRecord): void {
        this._local?.write(record);
        if (record.phase !== "result" || !record.decisionId || !record.result || !this._channel.reportResult) return;
        try {
            this._channel.reportResult({
                decisionId: record.decisionId,
                result: record.result,
                ...(record.nativeStatus ? { nativeStatus: record.nativeStatus } : {}),
                ...(record.errorCode ? { errorCode: record.errorCode } : {}),
            });
        } catch (error) {
            // A lost report is surfaced by the broker's own diagnostics
            // (decision without result); it must not fail the operation.
            console.error(`[scada] broker/audit/result for ${record.decisionId} could not be sent: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
