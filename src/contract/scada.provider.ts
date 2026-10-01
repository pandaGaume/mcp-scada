import type {
    IBrowseRequest,
    IBrowseResult,
    IInvokeRequest,
    IInvokeResult,
    IProviderReadRequest,
    IProviderWriteRequest,
    IReadResult,
    IScadaCapabilities,
    ISubscribeRequest,
    ISubscriptionHandle,
    IWriteResult,
    ScadaErrorCode,
    IScadaErrorBody,
} from "./scada.types";

/**
 * The binding between SCADA v1 and one industrial protocol.
 *
 * A provider never evaluates the actor's policy. By the time a method is
 * called, mcp-scada has checked its capabilities and obtained an allow from
 * the MCP Broker policy engine. The provider only applies the protocol's own
 * security and reports what really happened.
 */
export interface IScadaProvider {
    readonly id: string;

    getCapabilitiesAsync(signal?: AbortSignal): Promise<IScadaCapabilities>;
    browseAsync(request: IBrowseRequest, signal?: AbortSignal): Promise<IBrowseResult>;
    readAsync(request: IProviderReadRequest, signal?: AbortSignal): Promise<IReadResult>;
    writeAsync(request: IProviderWriteRequest, signal?: AbortSignal): Promise<IWriteResult>;
    invokeAsync(request: IInvokeRequest, signal?: AbortSignal): Promise<IInvokeResult>;
    subscribeAsync(request: ISubscribeRequest, signal?: AbortSignal): Promise<ISubscriptionHandle>;
    unsubscribeAsync(subscriptionId: string, signal?: AbortSignal): Promise<void>;
}

/** A normalized SCADA failure. Thrown for request-level refusals. */
export class ScadaError extends Error implements IScadaErrorBody {
    readonly code: ScadaErrorCode;
    readonly auditId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;

    constructor(code: ScadaErrorCode, message: string, options: { auditId?: string; detail?: Readonly<Record<string, unknown>> } = {}) {
        super(message);
        this.name = "ScadaError";
        this.code = code;
        this.auditId = options.auditId;
        this.detail = options.detail;
    }

    toBody(): IScadaErrorBody {
        return {
            code: this.code,
            message: this.message,
            ...(this.auditId ? { auditId: this.auditId } : {}),
            ...(this.detail ? { detail: this.detail } : {}),
        };
    }

    static toBody(error: unknown): IScadaErrorBody {
        if (error instanceof ScadaError) return error.toBody();
        return { code: "native_protocol_error", message: error instanceof Error ? error.message : String(error) };
    }
}
