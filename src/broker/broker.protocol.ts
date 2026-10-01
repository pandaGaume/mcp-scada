/**
 * Wire contract of the `broker/*` methods a provider sends to the MCP Broker,
 * as specified in docs/brief_evolution_mcp_broker_scada.md (E1, E2, E3, E5).
 *
 * Nothing here talks to a socket. The transport side is `transport.broker`
 * (`declare()`, `authorize()`) of `DirectTransport` / `MultiplexTransport` in
 * `@cyanmycelium/mcp-broker-provider`, or a loopback handle; {@link brokerChannelOf} adapts either.
 * mcp-scada itself only depends on {@link IBrokerChannel}.
 */

export const BROKER_METHODS = {
    declare: "broker/authorization/declare",
    authorize: "broker/authorize",
    auditResult: "broker/audit/result",
} as const;

/** `_meta` key the broker writes on every request it forwards to a declared provider. */
export const CALLER_META_KEY = "io.cyanmycelium/caller";

/** What the broker puts in `_meta["io.cyanmycelium/caller"]`. */
export interface ICallerMeta {
    readonly ref: string;
    readonly correlationId?: string;
}

/**
 * On whose behalf a decision is asked. Two forms only, told apart by `type`.
 * A `ref` is an ephemeral handle bound to one forwarded request, not an
 * identity: the broker resolves the subjects itself.
 */
export type BrokerPrincipal = { readonly type: "caller-ref"; readonly ref: string } | { readonly type: "provider" };

// ── broker/authorization/declare ────────────────────────────────────────────

export interface IDeclaredResource {
    /** Native identifier, kept by the broker for audit only. */
    readonly resource: string;
    /** The only form the broker evaluates. */
    readonly resourcePath: string;
    readonly effect?: string;
    readonly limits?: {
        readonly minValue?: number;
        readonly maxValue?: number;
        readonly allowedValues?: readonly (string | number | boolean | null)[];
        readonly destinations?: readonly string[];
    };
}

export interface IDeclareParams {
    readonly version: string;
    readonly domain: string;
    readonly namespace: { readonly resource: string };
    readonly capabilities: readonly string[];
    readonly resources: readonly IDeclaredResource[];
    readonly protects: readonly string[];
    /** Capabilities whose allowed decisions mcp-scada reports with `broker/audit/result`. */
    readonly resultsRequired?: readonly string[];
}

export interface IDeclareResult {
    readonly accepted: boolean;
    readonly version?: string;
    readonly policyVersion?: string;
    readonly problems?: readonly string[];
}

// ── broker/authorize ────────────────────────────────────────────────────────

export interface IAuthorizeCheck {
    readonly capability: string;
    readonly resource: string;
    readonly resourcePath: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface IAuthorizeParams {
    readonly principal: BrokerPrincipal;
    readonly correlationId?: string;
    readonly checks: readonly IAuthorizeCheck[];
}

export type BrokerEffect = "allow" | "deny" | "require-approval" | "allow-with-constraints";

export interface IBrokerObligations {
    readonly constraints?: {
        readonly minValue?: number;
        readonly maxValue?: number;
        readonly allowedValues?: readonly (string | number | boolean | null)[];
        readonly destinations?: readonly string[];
    };
    readonly notAfter?: string;
    readonly approval?: { readonly approvers: string; readonly policy: string };
}

export interface IBrokerDecision {
    readonly decisionId: string;
    readonly effect: BrokerEffect;
    readonly reason: string;
    readonly policies?: readonly string[];
    readonly obligations?: IBrokerObligations;
}

export interface IAuthorizeResult {
    readonly policyVersion?: string;
    readonly decisions: readonly IBrokerDecision[];
}

// ── broker/audit/result ─────────────────────────────────────────────────────

export interface IAuditResultParams {
    readonly decisionId: string;
    readonly result: "success" | "failure" | "refused";
    readonly nativeStatus?: string;
    readonly errorCode?: string;
}

// ── Channel ─────────────────────────────────────────────────────────────────

/** A JSON-RPC error answered by the broker, e.g. `-32601` from a broker without `broker/*`. */
export class BrokerRpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "BrokerRpcError";
    }
}

/**
 * The provider's side channel to the broker. Requests reject with
 * {@link BrokerRpcError} when the broker answers an error.
 */
export interface IBrokerChannel {
    declare(params: IDeclareParams): Promise<IDeclareResult>;
    authorize(params: IAuthorizeParams): Promise<IAuthorizeResult>;
    /** `broker/audit/result` (E5). Optional: a broker before it drops the notification with a warning. */
    reportResult?(params: IAuditResultParams): void;
}

/** What `transport.broker` (mcp-broker-provider) and a loopback handle (`registerLoopbackProvider`) both offer. */
export interface IBrokerMethods {
    declare(declaration: IDeclareParams): Promise<unknown>;
    authorize(query: IAuthorizeParams): Promise<unknown>;
    reportResult?(report: IAuditResultParams): void;
}

/**
 * Adapts the broker's own client to {@link IBrokerChannel}. A refusal
 * (`BrokerRequestError`, with `data.errors` for a declaration) becomes a
 * {@link BrokerRpcError}; a timeout or a closed socket keeps its message and
 * has no code.
 */
export function brokerChannelOf(methods: IBrokerMethods): IBrokerChannel {
    const wrap = async <T>(call: () => Promise<unknown>): Promise<T> => {
        try {
            return (await call()) as T;
        } catch (error) {
            const e = error as { code?: unknown; message?: unknown; data?: unknown };
            if (typeof e?.code === "number") throw new BrokerRpcError(e.code, String(e.message ?? "broker error"), e.data);
            throw error;
        }
    };
    return {
        declare: (params) => wrap<IDeclareResult>(() => methods.declare(params)),
        authorize: (params) => wrap<IAuthorizeResult>(() => methods.authorize(params)),
        ...(methods.reportResult ? { reportResult: (params: IAuditResultParams) => methods.reportResult!(params) } : {}),
    };
}

/**
 * Reads the caller block the broker wrote in `_meta`. Anything that does not
 * have exactly the expected shape is treated as absent, never repaired.
 */
export function readCallerMeta(meta: unknown): ICallerMeta | undefined {
    if (typeof meta !== "object" || meta === null) return undefined;
    const block = (meta as Record<string, unknown>)[CALLER_META_KEY];
    if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
    const { ref, correlationId } = block as Record<string, unknown>;
    if (typeof ref !== "string" || ref.length === 0) return undefined;
    if (correlationId !== undefined && typeof correlationId !== "string") return undefined;
    return { ref, ...(correlationId ? { correlationId } : {}) };
}
