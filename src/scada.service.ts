import { randomUUID } from "node:crypto";
import type { IDeclareParams } from "./broker/broker.protocol";
import { buildScadaDeclaration } from "./broker/declaration";
import { redact, ConsoleAuditSink, type IScadaAuditRecord, type IScadaAuditSink } from "./audit/audit";
import type { ICacheStore } from "@cyanmycelium/mcp-cache";
import { LocalValueCache } from "./cache/value.cache";
import { validateCapabilities } from "./contract/capabilities";
import { ScadaError, type IScadaProvider } from "./contract/scada.provider";
import {
    isItemError,
    type ConsistencyMode,
    type Destination,
    type DestinationRequest,
    type IBrowseResult,
    type IConsistency,
    type IInvokeResult,
    type IReadResult,
    type IScadaCapabilities,
    type IScadaErrorBody,
    type IScadaNode,
    type IScadaValue,
    type IWriteItem,
    type IWriteOutcome,
    type IWriteResult,
    type Operation,
    type ResourceEffect,
    type ScadaErrorCode,
    type ScadaReadItem,
    type UnsId,
} from "./contract/scada.types";
import { AcquireLimiter, type IAcquireLimits } from "./limits/acquire.limiter";
import { classifyOperation } from "./policy/operation.class";
import type { IScadaActor, IScadaConstraints, IScadaDecision, IScadaPolicyContext, IScadaPolicyGate } from "./policy/policy.types";
import { UnsPath } from "@cyanmycelium/mcp-uns";

/** Configuration approved for one resource by the SCADA owner. It can only narrow. */
export interface IApprovedResourceConfig {
    readonly effect?: ResourceEffect;
    readonly constraints?: IScadaConstraints;
}

export interface IScadaServiceOptions {
    /** The MCP Broker policy engine, through its SCADA mapper. Required: there is no default allow. */
    readonly policy: IScadaPolicyGate;
    readonly audit?: IScadaAuditSink;
    /** Also audit allowed reads and browses. Mutations and refusals are always audited. */
    readonly auditReads?: boolean;
    /** Deployment bound on downstream reads, per provider. */
    readonly acquireLimits?: IAcquireLimits;
    /** Approved SCADA configuration, keyed by exact UNS id. */
    readonly resources?: Readonly<Record<UnsId, IApprovedResourceConfig>>;
    /** Operational context handed to the policy, e.g. `{ mode: "maintenance" }`. */
    readonly plantContext?: Readonly<Record<string, string>>;
    /**
     * The store behind the `local` destination: any cache.v1 store. Default:
     * this process's memory. A `RedisCacheStore` shares one `local` view
     * between mcp-scada instances.
     */
    readonly localCache?: ICacheStore;
    /** Time to live of the `local` values. Set one with a shared store. */
    readonly localCacheTtlMs?: number;
    readonly now?: () => number;
}

export interface IRequestContext {
    readonly correlationId?: string;
    readonly signal?: AbortSignal;
}

export interface IReadRequest {
    readonly ids: readonly UnsId[];
    /** Required. An ordered list is an explicit fallback; nothing else falls back. */
    readonly destination: DestinationRequest;
    /** Defaults by destination: `local` cached, `provider` fresh, anything downstream `source`. */
    readonly consistency?: IConsistency;
}

export interface IWriteRequest {
    readonly items: readonly IWriteItem[];
    /** Required and single: a write never falls back to another level. */
    readonly destination: Destination;
}

interface IRegistration {
    readonly provider: IScadaProvider;
    readonly root: UnsPath;
    readonly capabilities: IScadaCapabilities;
    readonly limiter: AcquireLimiter;
}

/** Errors after which an explicit fallback list may try its next destination. */
const FALLBACK_ON: ReadonlySet<ScadaErrorCode> = new Set([
    "unsupported_destination",
    "unsupported_consistency",
    "cache_miss",
    "rate_limited",
    "policy_denied",
    "constraint_violation",
    "native_protocol_error",
    "provider_unavailable",
    "provenance_unknown",
]);

function defaultConsistency(destination: Destination): IConsistency {
    if (destination === "local") return { mode: "cached" };
    if (destination === "provider") return { mode: "fresh" };
    return { mode: "source" };
}

function mergeConstraints(...all: (IScadaConstraints | undefined)[]): IScadaConstraints | undefined {
    const present = all.filter((c): c is IScadaConstraints => c !== undefined);
    if (present.length === 0) return undefined;
    const numbers = (values: (number | undefined)[]) => values.filter((v): v is number => typeof v === "number");
    const mins = numbers(present.map((c) => c.minValue));
    const maxs = numbers(present.map((c) => c.maxValue));
    const lists = present.map((c) => c.allowedValues).filter((v): v is NonNullable<IScadaConstraints["allowedValues"]> => Array.isArray(v));
    const destinationLists = present.map((c) => c.destinations).filter((v): v is readonly Destination[] => Array.isArray(v));
    const deadlines = present.map((c) => c.notAfter).filter((v): v is string => typeof v === "string");
    return {
        ...(mins.length ? { minValue: Math.max(...mins) } : {}),
        ...(maxs.length ? { maxValue: Math.min(...maxs) } : {}),
        ...(lists.length ? { allowedValues: lists.reduce((acc, list) => acc.filter((v) => list.some((w) => Object.is(v, w)))) } : {}),
        ...(destinationLists.length ? { destinations: destinationLists.reduce((acc, list) => acc.filter((d) => list.includes(d))) } : {}),
        ...(deadlines.length ? { notAfter: deadlines.sort()[0] } : {}),
    };
}

/**
 * mcp-scada: one SCADA v1 surface above every registered industrial provider.
 *
 * Every operation follows the canonical flow: resolve the UNS binding, check
 * the provider capability, validate destination and consistency, build the
 * policy context, ask the MCP Broker, and only on an allow apply the
 * constraints and call the provider. Nothing reaches a provider without a
 * broker decision, and every mutation and refusal is audited.
 */
export class ScadaService {
    private readonly _policy: IScadaPolicyGate;
    private readonly _audit: IScadaAuditSink;
    private readonly _auditReads: boolean;
    private readonly _acquireLimits: IAcquireLimits;
    private readonly _resources: Readonly<Record<UnsId, IApprovedResourceConfig>>;
    private readonly _plantContext?: Readonly<Record<string, string>>;
    private readonly _registrations = new Map<string, IRegistration>();
    readonly cache: LocalValueCache;

    constructor(options: IScadaServiceOptions) {
        if (!options?.policy) throw new Error("ScadaService: a policy gate is required; mcp-scada never allows by default.");
        this._policy = options.policy;
        this._audit = options.audit ?? new ConsoleAuditSink();
        this._auditReads = options.auditReads ?? false;
        this._acquireLimits = options.acquireLimits ?? {};
        this._resources = options.resources ?? {};
        this._plantContext = options.plantContext;
        this.cache = new LocalValueCache({
            ...(options.localCache ? { store: options.localCache } : {}),
            ...(options.localCacheTtlMs ? { ttlMs: options.localCacheTtlMs } : {}),
            ...(options.now ? { now: options.now } : {}),
        });
    }

    // ── Registration ────────────────────────────────────────────────────────

    /**
     * Registers a provider under a UNS root. Its capabilities are fetched and
     * validated now; an incoherent declaration is refused.
     */
    async registerProviderAsync(provider: IScadaProvider, root: UnsId): Promise<IScadaCapabilities> {
        if (this._registrations.has(provider.id)) throw new Error(`provider "${provider.id}" is already registered`);
        const rootPath = UnsPath.parse(root);
        for (const other of this._registrations.values()) {
            if (other.root.contains(rootPath) || rootPath.contains(other.root)) {
                throw new Error(`provider "${provider.id}": UNS root ${rootPath.id} overlaps ${other.root.id} of provider "${other.provider.id}"`);
            }
        }
        const capabilities = await provider.getCapabilitiesAsync();
        const problems = validateCapabilities(provider.id, capabilities);
        if (problems.length > 0) throw new Error(`provider "${provider.id}" declared invalid capabilities: ${problems.join("; ")}`);
        const limiter = new AcquireLimiter(
            AcquireLimiter.strictest(this._acquireLimits, { maxConcurrent: capabilities.limits?.maxConcurrentAcquire, maxPerSecond: capabilities.limits?.maxAcquirePerSecond })
        );
        this._registrations.set(provider.id, { provider, root: rootPath, capabilities, limiter });
        return capabilities;
    }

    unregisterProvider(providerId: string): void {
        this._registrations.delete(providerId);
    }

    /**
     * The `broker/authorization/declare` payload for this deployment: the
     * namespace, the registered provider roots, and the approved effects and
     * engineering limits. It grants nothing.
     */
    buildDeclaration(options: { version: string; namespace: UnsId; protects?: readonly string[] }): IDeclareParams {
        return buildScadaDeclaration({
            version: options.version,
            namespace: options.namespace,
            roots: [...this._registrations.values()].map((registration) => registration.root.id),
            resources: this._resources,
            protects: options.protects,
        });
    }

    capabilities(): IScadaCapabilities[] {
        return [...this._registrations.values()].map((registration) => registration.capabilities);
    }

    // ── Browse ──────────────────────────────────────────────────────────────

    /** Lists the nodes the actor may observe. Discoverability is not executability. */
    async browseAsync(actor: IScadaActor, root?: UnsId, context: IRequestContext = {}): Promise<IBrowseResult> {
        const correlationId = context.correlationId ?? actor.correlationId ?? randomUUID();
        const rootPath = root !== undefined ? UnsPath.tryParse(root) : undefined;
        if (root !== undefined && !rootPath) throw new ScadaError("invalid_request", `invalid UNS id "${root}"`);

        const nodes: IScadaNode[] = [];
        for (const registration of this._registrations.values()) {
            if (rootPath && !registration.root.contains(rootPath) && !rootPath.contains(registration.root)) continue;
            if (!registration.capabilities.capabilities.browse.supported) continue;
            const providerRoot = rootPath && registration.root.contains(rootPath) ? rootPath.id : undefined;
            const result = await registration.provider.browseAsync({ root: providerRoot }, context.signal);
            const decisions = await this._decideMany(
                actor,
                "browse",
                registration,
                correlationId,
                result.nodes.map((node) => ({ resource: node.id }))
            );
            result.nodes.forEach((node, index) => {
                const decision = decisions[index].decision;
                if (decision === "allow" || decision === "allow-with-constraints") nodes.push(node);
            });
        }
        return { nodes };
    }

    // ── Read ────────────────────────────────────────────────────────────────

    async readAsync(actor: IScadaActor, request: IReadRequest, context: IRequestContext = {}): Promise<IReadResult> {
        const correlationId = context.correlationId ?? actor.correlationId ?? randomUUID();
        if (!Array.isArray(request?.ids) || request.ids.length === 0) throw new ScadaError("invalid_request", "ids must be a non-empty array");
        if (request.destination === undefined) {
            throw new ScadaError("invalid_request", "destination is required: a read without destination is ambiguous", {
                detail: { allowed: ["local", "provider", "gateway", "controller", "device", "source"] },
            });
        }
        const destinations: readonly Destination[] = typeof request.destination === "string" ? [request.destination] : request.destination;
        if (destinations.length === 0) throw new ScadaError("invalid_request", "destination list is empty");

        const results = new Map<UnsId, ScadaReadItem>();
        const attempts = new Map<UnsId, { destination: Destination; code: ScadaErrorCode }[]>();
        let pending: UnsPath[] = [];
        for (const id of request.ids) {
            const path = UnsPath.tryParse(id);
            if (!path) results.set(id, { id, error: { code: "invalid_request", message: `invalid UNS id "${id}"` } });
            else if (!this._resolve(path)) results.set(id, { id, error: { code: "unknown_resource", message: `no provider is registered for ${path.id}` } });
            else pending.push(path);
        }

        for (let index = 0; index < destinations.length && pending.length > 0; index += 1) {
            const destination = destinations[index];
            const consistency = request.consistency ?? defaultConsistency(destination);
            const isLast = index === destinations.length - 1;
            const outcome = await this._readAt(actor, pending, destination, consistency, correlationId, context.signal);
            pending = [];
            for (const [id, item] of outcome) {
                if (!isItemError(item)) {
                    results.set(id, item);
                    continue;
                }
                const tried = attempts.get(id) ?? [];
                tried.push({ destination, code: item.error.code });
                attempts.set(id, tried);
                if (!isLast && FALLBACK_ON.has(item.error.code)) {
                    pending.push(UnsPath.parse(id));
                } else {
                    const detail = tried.length > 1 ? { ...(item.error.detail ?? {}), attempts: tried } : item.error.detail;
                    results.set(id, { id, error: { ...item.error, ...(detail ? { detail } : {}) } });
                }
            }
        }
        return { items: request.ids.map((id) => results.get(UnsPath.tryParse(id)?.id ?? id) ?? results.get(id)!) };
    }

    private async _readAt(
        actor: IScadaActor,
        paths: readonly UnsPath[],
        destination: Destination,
        consistency: IConsistency,
        correlationId: string,
        signal?: AbortSignal
    ): Promise<Map<UnsId, ScadaReadItem>> {
        const out = new Map<UnsId, ScadaReadItem>();
        const fail = (id: UnsId, code: ScadaErrorCode, message: string, extra: Partial<IScadaErrorBody> = {}) => out.set(id, { id, error: { code, message, ...extra } });

        if (consistency.mode === "max-age" && !(typeof consistency.maxAgeMs === "number" && consistency.maxAgeMs >= 0)) {
            for (const path of paths) fail(path.id, "invalid_request", "max-age consistency requires a non-negative maxAgeMs");
            return out;
        }

        // Group by provider so each provider gets one batched call.
        const groups = new Map<IRegistration, UnsPath[]>();
        for (const path of paths) {
            const registration = this._resolve(path)!;
            const bucket = groups.get(registration);
            if (bucket) bucket.push(path);
            else groups.set(registration, [path]);
        }

        for (const [registration, group] of groups) {
            const providerId = registration.provider.id;
            const caps = registration.capabilities.capabilities.read;

            if (destination === "local") {
                if (consistency.mode !== "cached" && consistency.mode !== "max-age") {
                    for (const path of group) fail(path.id, "unsupported_consistency", `"${consistency.mode}" cannot be served by the local cache`);
                    continue;
                }
            } else {
                if (!caps.destinations.includes(destination)) {
                    for (const path of group)
                        fail(path.id, "unsupported_destination", `provider "${providerId}" cannot distinguish "${destination}"`, { detail: { supported: caps.destinations } });
                    continue;
                }
                if (!caps.consistency.includes(consistency.mode)) {
                    for (const path of group)
                        fail(path.id, "unsupported_consistency", `provider "${providerId}" does not support "${consistency.mode}"`, { detail: { supported: caps.consistency } });
                    continue;
                }
            }

            const allowed: UnsPath[] = [];
            const decisionOf = new Map<UnsId, IScadaDecision>();
            const decisions = await this._decideMany(
                actor,
                "read",
                registration,
                correlationId,
                group.map((path) => ({ resource: path.id, destination, consistency: consistency.mode }))
            );
            for (const [index, path] of group.entries()) {
                const decision = decisions[index];
                const refusal = this._refusal(decision, destination);
                if (refusal) {
                    fail(path.id, refusal.code, refusal.message, { auditId: decision.auditId, detail: refusal.detail });
                    continue;
                }
                allowed.push(path);
                decisionOf.set(path.id, decision);
            }
            if (allowed.length === 0) continue;

            const execute = async (): Promise<void> => {
                if (destination === "local") {
                    let hits: Awaited<ReturnType<LocalValueCache["getAsync"]>>;
                    try {
                        hits = await this.cache.getAsync(allowed.map((path) => path.id));
                    } catch (error) {
                        // An unreachable cache is a miss: an explicit fallback list may go on to the next destination.
                        const reason = error instanceof Error ? error.message : String(error);
                        for (const path of allowed) fail(path.id, "cache_miss", `the local cache cannot be read: ${reason}`, { detail: { reason: "cache_unavailable" } });
                        return;
                    }
                    for (const path of allowed) {
                        const hit = hits.get(path.id);
                        if (!hit) fail(path.id, "cache_miss", `no value for ${path.id} in the local cache`);
                        else if (consistency.mode === "max-age" && (hit.value.provenance.ageMs ?? Infinity) > consistency.maxAgeMs!) {
                            fail(path.id, "cache_miss", `cached value is ${hit.value.provenance.ageMs} ms old, more than ${consistency.maxAgeMs} ms`);
                        } else out.set(path.id, hit.value);
                    }
                    return;
                }

                const operationClass = classifyOperation("read", destination, consistency.mode);
                const call = () => registration.provider.readAsync({ ids: allowed.map((p) => p.id), destination, consistency }, signal);
                let items: readonly ScadaReadItem[];
                try {
                    const result = operationClass === "acquire" ? await registration.limiter.run(providerId, call) : await call();
                    items = result.items;
                } catch (error) {
                    const body = ScadaError.toBody(error);
                    for (const path of allowed) fail(path.id, body.code, body.message, body.detail ? { detail: body.detail } : {});
                    return;
                }

                const byId = new Map(items.map((item) => [item.id, item]));
                const fresh: IScadaValue[] = [];
                for (const path of allowed) {
                    const item = byId.get(path.id);
                    if (!item) {
                        fail(path.id, "native_protocol_error", `provider "${providerId}" returned no item for ${path.id}`);
                        continue;
                    }
                    if (isItemError(item)) {
                        out.set(path.id, item);
                        continue;
                    }
                    const problem = this._checkProvenance(item, providerId, destination, consistency);
                    if (problem) {
                        fail(path.id, problem.code, problem.message);
                        continue;
                    }
                    fresh.push(item);
                    out.set(path.id, item);
                }
                await this.cache.storeAsync(fresh);
            };
            await execute();

            // Every allowed read gets its outcome, success or not, against its decision.
            if (this._auditReads) {
                for (const path of allowed) {
                    const item = out.get(path.id);
                    const error = !item ? "native_protocol_error" : isItemError(item) ? item.error.code : undefined;
                    this._writeResult(correlationId, actor, "read", path.id, registration, destination, undefined, error ? "failure" : "success", decisionOf.get(path.id), error);
                }
            }
        }
        return out;
    }

    /**
     * A provider must say what really happened. A value with no provenance,
     * a cached value for a source read, or one older than `max-age` is not
     * delivered: serving it would be the silent downgrade the contract forbids.
     */
    private _checkProvenance(item: IScadaValue, providerId: string, destination: Destination, consistency: IConsistency): { code: ScadaErrorCode; message: string } | undefined {
        const provenance = item.provenance;
        if (!provenance || provenance.level === "unknown") {
            return { code: "provenance_unknown", message: `provider "${providerId}" did not state where ${item.id} came from` };
        }
        if (consistency.mode === "source" && provenance.cached) {
            return { code: "unsupported_consistency", message: `provider "${providerId}" served ${item.id} from a cache although the request required the source` };
        }
        if (destination !== "provider" && provenance.cached && consistency.mode !== "cached" && consistency.mode !== "max-age") {
            return { code: "unsupported_destination", message: `provider "${providerId}" answered ${item.id} from its cache instead of "${destination}"` };
        }
        if (consistency.mode === "max-age" && (provenance.ageMs ?? Infinity) > consistency.maxAgeMs!) {
            return { code: "unsupported_consistency", message: `value for ${item.id} is ${provenance.ageMs} ms old, more than ${consistency.maxAgeMs} ms` };
        }
        return undefined;
    }

    // ── Write ───────────────────────────────────────────────────────────────

    async writeAsync(actor: IScadaActor, request: IWriteRequest, context: IRequestContext = {}): Promise<IWriteResult> {
        const correlationId = context.correlationId ?? actor.correlationId ?? randomUUID();
        if (!Array.isArray(request?.items) || request.items.length === 0) throw new ScadaError("invalid_request", "items must be a non-empty array");
        if (typeof request.destination !== "string") throw new ScadaError("invalid_request", "a write needs exactly one destination; writes never fall back");
        if (request.destination === "local") throw new ScadaError("unsupported_destination", "the local cache cannot be written");
        const destination = request.destination;

        const outcomes = new Map<UnsId, IWriteOutcome>();
        const refuse = (id: UnsId, code: ScadaErrorCode, message: string, extra: Partial<IScadaErrorBody> = {}) =>
            outcomes.set(id, { id, status: "failure", error: { code, message, ...extra } });

        const ready = new Map<IRegistration, { item: IWriteItem; decision: IScadaDecision & { auditId: string } }[]>();
        const eligible = new Map<IRegistration, { path: UnsPath; item: IWriteItem }[]>();
        for (const item of request.items) {
            const path = UnsPath.tryParse(item?.id);
            if (!path) {
                refuse(String(item?.id), "invalid_request", `invalid UNS id "${String(item?.id)}"`);
                continue;
            }
            const registration = this._resolve(path);
            if (!registration) {
                refuse(item.id, "unknown_resource", `no provider is registered for ${path.id}`);
                continue;
            }
            const caps = registration.capabilities.capabilities.write;
            if (!caps.supported) {
                refuse(item.id, "unsupported_capability", `provider "${registration.provider.id}" does not support write`, { detail: { capability: "write" } });
                continue;
            }
            if (!caps.destinations?.includes(destination)) {
                refuse(item.id, "unsupported_destination", `provider "${registration.provider.id}" cannot write to "${destination}"`, {
                    detail: { supported: caps.destinations ?? [] },
                });
                continue;
            }
            const bucket = eligible.get(registration);
            if (bucket) bucket.push({ path, item });
            else eligible.set(registration, [{ path, item }]);
        }

        for (const [registration, entries] of eligible) {
            const decisions = await this._decideMany(
                actor,
                "write",
                registration,
                correlationId,
                entries.map(({ path, item }) => ({ resource: path.id, destination, requestedValue: item.value }))
            );
            for (const [index, { path, item }] of entries.entries()) {
                const decision = decisions[index];
                const refusal = this._refusal(decision, destination);
                if (refusal) {
                    refuse(item.id, refusal.code, refusal.message, { auditId: decision.auditId, detail: refusal.detail });
                    this._writeResult(correlationId, actor, "write", path.id, registration, destination, item.value, "refused", decision, refusal.code);
                    continue;
                }
                const bucket = ready.get(registration);
                const entry = { item: { id: path.id, value: item.value }, decision };
                if (bucket) bucket.push(entry);
                else ready.set(registration, [entry]);
            }
        }

        for (const [registration, entries] of ready) {
            // Constraints are applied here, immediately before execution, so
            // a decision that expired while other items were evaluated is caught.
            const executable: typeof entries = [];
            for (const entry of entries) {
                const constraints = mergeConstraints(entry.decision.constraints, this._resources[entry.item.id]?.constraints);
                const violation = this._violation(constraints, entry.item.value, destination);
                if (violation) {
                    refuse(entry.item.id, "constraint_violation", violation.message, { auditId: entry.decision.auditId, detail: violation.detail });
                    this._writeResult(correlationId, actor, "write", entry.item.id, registration, destination, entry.item.value, "refused", entry.decision, "constraint_violation");
                    continue;
                }
                executable.push(entry);
            }
            if (executable.length === 0) continue;

            let results: readonly IWriteOutcome[];
            try {
                results = (await registration.provider.writeAsync({ items: executable.map((e) => e.item), destination }, context.signal)).items;
            } catch (error) {
                const body = ScadaError.toBody(error);
                results = executable.map((e) => ({ id: e.item.id, status: "failure" as const, error: body }));
            }
            const byId = new Map(results.map((r) => [r.id, r]));
            for (const entry of executable) {
                const outcome: IWriteOutcome = byId.get(entry.item.id) ?? {
                    id: entry.item.id,
                    status: "failure",
                    error: { code: "native_protocol_error", message: `provider "${registration.provider.id}" returned no outcome` },
                };
                outcomes.set(entry.item.id, outcome);
                this._writeResult(
                    correlationId,
                    actor,
                    "write",
                    entry.item.id,
                    registration,
                    destination,
                    entry.item.value,
                    outcome.status,
                    entry.decision,
                    outcome.error?.code,
                    outcome.nativeStatus
                );
            }
        }
        return { items: request.items.map((item) => outcomes.get(UnsPath.tryParse(item?.id)?.id ?? String(item?.id)) ?? outcomes.get(String(item?.id))!) };
    }

    // ── Invoke (phase 3: same gate, no value constraints yet) ───────────────

    async invokeAsync(actor: IScadaActor, id: UnsId, args: Readonly<Record<string, unknown>>, context: IRequestContext = {}): Promise<IInvokeResult> {
        const correlationId = context.correlationId ?? actor.correlationId ?? randomUUID();
        const path = UnsPath.tryParse(id);
        if (!path) throw new ScadaError("invalid_request", `invalid UNS id "${id}"`);
        const registration = this._resolve(path);
        if (!registration) throw new ScadaError("unknown_resource", `no provider is registered for ${path.id}`);
        if (!registration.capabilities.capabilities.invoke.supported) {
            throw new ScadaError("unsupported_capability", `provider "${registration.provider.id}" does not support invoke`, { detail: { capability: "invoke" } });
        }
        const [decision] = await this._decideMany(actor, "invoke", registration, correlationId, [{ resource: path.id, requestedValue: args }]);
        const refusal = this._refusal(decision, undefined);
        if (refusal) {
            this._writeResult(correlationId, actor, "invoke", path.id, registration, undefined, args, "refused", decision, refusal.code);
            throw new ScadaError(refusal.code, refusal.message, { auditId: decision.auditId, detail: refusal.detail });
        }
        try {
            const result = await registration.provider.invokeAsync({ id: path.id, arguments: args }, context.signal);
            this._writeResult(correlationId, actor, "invoke", path.id, registration, undefined, args, result.status, decision, undefined, result.nativeStatus);
            return result;
        } catch (error) {
            const body = ScadaError.toBody(error);
            this._writeResult(correlationId, actor, "invoke", path.id, registration, undefined, args, "failure", decision, body.code);
            throw error instanceof ScadaError ? error : new ScadaError(body.code, body.message);
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private _resolve(path: UnsPath): IRegistration | undefined {
        for (const registration of this._registrations.values()) {
            if (registration.root.contains(path)) return registration;
        }
        return undefined;
    }

    /**
     * Asks the broker, in one batch per provider, and records each decision
     * before anything executes. Decisions come back in the order asked.
     */
    private async _decideMany(
        actor: IScadaActor,
        operation: Operation,
        registration: IRegistration,
        correlationId: string,
        entries: readonly { resource: UnsId; destination?: Destination; consistency?: ConsistencyMode; requestedValue?: unknown }[]
    ): Promise<(IScadaDecision & { auditId: string })[]> {
        if (entries.length === 0) return [];
        const contexts: IScadaPolicyContext[] = entries.map((entry) => ({
            actor,
            operation,
            operationClass: classifyOperation(operation, entry.destination, entry.consistency),
            resource: entry.resource,
            destination: entry.destination,
            consistency: entry.consistency,
            requestedValue: entry.requestedValue,
            effect: this._resources[entry.resource]?.effect ?? (operation === "write" || operation === "invoke" ? "physical-action" : "observation"),
            provider: registration.provider.id,
            plantContext: this._plantContext,
            requestContext: { correlationId },
        }));

        let decisions: readonly IScadaDecision[];
        try {
            decisions = this._policy.evaluateMany ? await this._policy.evaluateMany(contexts) : await Promise.all(contexts.map((context) => this._policy.evaluate(context)));
            if (decisions.length !== contexts.length) throw new Error("the policy answered a different number of decisions");
        } catch (error) {
            // Nothing was decided: deny, and say why. An unreachable or
            // undeclared broker is not a policy outcome.
            const reason = error instanceof ScadaError && error.code === "authorization_unavailable" ? "authorization_unavailable" : "evaluation-error";
            decisions = contexts.map(() => ({ decision: "deny" as const, reason }));
        }

        const mutation = operation === "write" || operation === "invoke";
        return contexts.map((context, index) => {
            const decision = decisions[index];
            const auditId = decision.decisionId ?? randomUUID();
            if (mutation || decision.decision !== "allow" || this._auditReads) {
                this._audit.write({
                    auditId,
                    correlationId,
                    phase: "decision",
                    timestamp: new Date().toISOString(),
                    actor: actor.id,
                    operation,
                    operationClass: context.operationClass,
                    resource: context.resource,
                    destination: context.destination,
                    ...(context.requestedValue !== undefined ? { requested: redact(context.requestedValue) } : {}),
                    provider: registration.provider.id,
                    policies: decision.policies,
                    decision: decision.decision,
                    reason: decision.reason,
                    constraints: decision.constraints,
                    ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
                });
            }
            return { ...decision, auditId };
        });
    }

    private _refusal(decision: IScadaDecision, destination: Destination | undefined): { code: ScadaErrorCode; message: string; detail?: Record<string, unknown> } | undefined {
        switch (decision.decision) {
            case "deny":
                if (decision.reason === "authorization_unavailable") {
                    return { code: "authorization_unavailable", message: "the MCP Broker has not accepted the SCADA declaration; no operation is served" };
                }
                return { code: "policy_denied", message: "denied by the MCP Broker policy", detail: { reason: decision.reason } };
            case "require-approval":
                return { code: "approval_required", message: "the MCP Broker policy requires an approval for this operation", detail: { reason: decision.reason } };
            case "allow-with-constraints":
                if (destination && decision.constraints?.destinations && !decision.constraints.destinations.includes(destination)) {
                    return {
                        code: "constraint_violation",
                        message: `destination "${destination}" is outside the allowed destinations`,
                        detail: { constraint: "destinations", allowed: decision.constraints.destinations },
                    };
                }
                return undefined;
            case "allow":
                return undefined;
            default:
                // An unknown decision kind is not an allow.
                return { code: "policy_denied", message: `unrecognized policy decision "${String((decision as IScadaDecision).decision)}"` };
        }
    }

    private _violation(constraints: IScadaConstraints | undefined, value: unknown, destination: Destination): { message: string; detail: Record<string, unknown> } | undefined {
        if (!constraints) return undefined;
        if (constraints.notAfter && Date.parse(constraints.notAfter) < Date.now()) {
            return { message: `the decision expired at ${constraints.notAfter}`, detail: { constraint: "notAfter", notAfter: constraints.notAfter } };
        }
        if (constraints.destinations && !constraints.destinations.includes(destination)) {
            return { message: `destination "${destination}" is not allowed`, detail: { constraint: "destinations", allowed: constraints.destinations } };
        }
        const numeric = typeof value === "number" ? value : undefined;
        if ((constraints.minValue !== undefined || constraints.maxValue !== undefined) && numeric === undefined) {
            return { message: "a numeric range applies, but the requested value is not a number", detail: { constraint: "range" } };
        }
        if (numeric !== undefined && constraints.minValue !== undefined && numeric < constraints.minValue) {
            return { message: `requested ${numeric} is below the minimum ${constraints.minValue}`, detail: { constraint: "minValue", minValue: constraints.minValue } };
        }
        if (numeric !== undefined && constraints.maxValue !== undefined && numeric > constraints.maxValue) {
            return { message: `requested ${numeric} is above the maximum ${constraints.maxValue}`, detail: { constraint: "maxValue", maxValue: constraints.maxValue } };
        }
        if (constraints.allowedValues && !constraints.allowedValues.some((allowed) => Object.is(allowed, value))) {
            return { message: "the requested value is not one of the allowed values", detail: { constraint: "allowedValues" } };
        }
        return undefined;
    }

    private _writeResult(
        correlationId: string,
        actor: IScadaActor,
        operation: Operation,
        resource: UnsId,
        registration: IRegistration,
        destination: Destination | undefined,
        requested: unknown,
        result: IScadaAuditRecord["result"],
        decision?: IScadaDecision,
        errorCode?: string,
        nativeStatus?: string
    ): void {
        this._audit.write({
            auditId: randomUUID(),
            correlationId,
            phase: "result",
            timestamp: new Date().toISOString(),
            actor: actor.id,
            operation,
            operationClass: classifyOperation(operation, destination),
            resource,
            destination,
            ...(requested !== undefined ? { requested: redact(requested) } : {}),
            provider: registration.provider.id,
            policies: decision?.policies,
            decision: decision?.decision ?? "allow",
            reason: decision?.reason ?? "",
            constraints: decision?.constraints,
            result,
            ...(decision?.decisionId ? { decisionId: decision.decisionId } : {}),
            ...(errorCode ? { errorCode } : {}),
            ...(nativeStatus ? { nativeStatus } : {}),
        });
    }
}
