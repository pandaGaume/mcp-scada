/**
 * SCADA v1 contract types.
 *
 * Nothing here names a protocol. A provider maps these shapes onto OPC UA,
 * Modbus or anything else; the MCP Broker policy engine and the audit only
 * ever see these shapes.
 */

export const SCADA_INTERFACE_VERSION = "scada.v1";

/**
 * Logical destinations of a read or a write, from the closest cache to the
 * declared source. `local` is owned by mcp-scada (the broker tier cache) and
 * can never be declared by a provider.
 */
export const DESTINATIONS = ["local", "provider", "gateway", "controller", "device", "source"] as const;
export type Destination = (typeof DESTINATIONS)[number];

/** Physical levels a provider may claim for its `source`. */
export const SOURCE_LEVELS = ["gateway", "controller", "device", "server"] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];

export const CONSISTENCY_MODES = ["cached", "fresh", "max-age", "source"] as const;
export type ConsistencyMode = (typeof CONSISTENCY_MODES)[number];

export const CACHE_MODES = ["none", "read-through", "polling", "subscription", "push", "hybrid"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

export type Operation = "browse" | "read" | "write" | "invoke" | "subscribe";

/** Policy attribute: never a statement about how a client or harness works. */
export type OperationClass = "observe" | "acquire" | "control" | "execute" | "admin";

export type Quality = "good" | "uncertain" | "bad";

/** Canonical UNS identifier, `uns://segment/segment/...`. */
export type UnsId = string;

export interface IConsistency {
    readonly mode: ConsistencyMode;
    /** Required with `max-age`. */
    readonly maxAgeMs?: number;
}

/** A single destination, or an explicit ordered fallback list. */
export type DestinationRequest = Destination | readonly Destination[];

// ── Capabilities ────────────────────────────────────────────────────────────

export interface IReadCapability {
    readonly destinations: readonly Destination[];
    readonly consistency: readonly ConsistencyMode[];
}

export interface IWriteCapability {
    readonly supported: boolean;
    readonly destinations?: readonly Destination[];
}

export interface IInvokeCapability {
    readonly supported: boolean;
}

export interface ISubscribeCapability {
    readonly supported: boolean;
    readonly mode?: "native" | "polling";
}

export interface ICachePolicy {
    readonly mode: CacheMode;
    /** Freshness window honoured by `fresh`, when the provider keeps a cache. */
    readonly freshnessMs?: number;
}

export interface IProviderLimits {
    readonly maxBatchSize?: number;
    readonly maxConcurrentAcquire?: number;
    readonly maxAcquirePerSecond?: number;
}

export interface IScadaCapabilities {
    readonly interface: typeof SCADA_INTERFACE_VERSION;
    readonly provider: string;
    /** What `source` physically means for this provider. */
    readonly source: SourceLevel;
    readonly cachePolicy: ICachePolicy;
    readonly capabilities: {
        readonly browse: { readonly supported: boolean };
        readonly read: IReadCapability;
        readonly write: IWriteCapability;
        readonly invoke: IInvokeCapability;
        readonly subscribe: ISubscribeCapability;
    };
    readonly limits?: IProviderLimits;
    /** Protocol security mechanisms in use, for information only. */
    readonly security?: readonly string[];
    /** Native metadata keys the provider preserves in results and audit. */
    readonly nativeMetadata?: readonly string[];
}

// ── Browse ──────────────────────────────────────────────────────────────────

export type ResourceEffect = "none" | "observation" | "configuration" | "physical-action";

export interface IScadaNode {
    readonly id: UnsId;
    readonly kind: "folder" | "variable" | "method";
    readonly name: string;
    readonly description?: string;
    readonly unit?: string;
    readonly dataType?: string;
    readonly readable?: boolean;
    readonly writable?: boolean;
    readonly effect?: ResourceEffect;
    /** Protocol metadata. Informative only: it never widens an authorization. */
    readonly native?: Readonly<Record<string, unknown>>;
}

export interface IBrowseRequest {
    /** Subtree to list; the whole provider namespace when omitted. */
    readonly root?: UnsId;
}

export interface IBrowseResult {
    readonly nodes: readonly IScadaNode[];
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface IProvenance {
    readonly provider: string;
    /** The level that actually answered; `unknown` rather than an invented origin. */
    readonly level: Destination | SourceLevel | "unknown";
    readonly cached: boolean;
    readonly cacheMode: CacheMode;
    readonly ageMs: number | null;
}

export interface IScadaValue {
    readonly id: UnsId;
    readonly value: unknown;
    readonly quality: Quality;
    /** `null` when the protocol does not carry it. Never synthesized. */
    readonly sourceTimestamp: string | null;
    readonly receivedTimestamp: string;
    readonly provenance: IProvenance;
    readonly native?: Readonly<Record<string, unknown>>;
}

export interface IScadaItemError {
    readonly id: UnsId;
    readonly error: IScadaErrorBody;
}

export type ScadaReadItem = IScadaValue | IScadaItemError;

export interface IProviderReadRequest {
    readonly ids: readonly UnsId[];
    /** Already resolved to a single destination the provider declared. */
    readonly destination: Exclude<Destination, "local">;
    readonly consistency: IConsistency;
}

export interface IReadResult {
    readonly items: readonly ScadaReadItem[];
}

// ── Write ───────────────────────────────────────────────────────────────────

export interface IWriteItem {
    readonly id: UnsId;
    readonly value: unknown;
}

export interface IProviderWriteRequest {
    readonly items: readonly IWriteItem[];
    readonly destination: Exclude<Destination, "local">;
}

export interface IWriteOutcome {
    readonly id: UnsId;
    readonly status: "success" | "failure";
    readonly nativeStatus?: string;
    readonly error?: IScadaErrorBody;
}

export interface IWriteResult {
    readonly items: readonly IWriteOutcome[];
}

// ── Invoke and subscribe (phase 3, contract only) ───────────────────────────

export interface IInvokeRequest {
    readonly id: UnsId;
    readonly arguments: Readonly<Record<string, unknown>>;
}

export interface IInvokeResult {
    readonly id: UnsId;
    readonly status: "success" | "failure";
    readonly outputs?: Readonly<Record<string, unknown>>;
    readonly nativeStatus?: string;
}

export interface ISubscribeRequest {
    readonly ids: readonly UnsId[];
    readonly samplingMs?: number;
}

export interface ISubscriptionHandle {
    readonly subscriptionId: string;
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type ScadaErrorCode =
    | "unsupported_capability"
    | "unsupported_destination"
    | "unsupported_consistency"
    | "unknown_resource"
    | "invalid_request"
    | "policy_denied"
    | "authorization_unavailable"
    | "approval_required"
    | "constraint_violation"
    | "rate_limited"
    | "cache_miss"
    | "native_protocol_error"
    | "provider_unavailable"
    | "provenance_unknown";

export interface IScadaErrorBody {
    readonly code: ScadaErrorCode;
    readonly message: string;
    /** Audit record linking this refusal, when one was written. */
    readonly auditId?: string;
    readonly detail?: Readonly<Record<string, unknown>>;
}

export function isItemError(item: ScadaReadItem): item is IScadaItemError {
    return (item as IScadaItemError).error !== undefined;
}
