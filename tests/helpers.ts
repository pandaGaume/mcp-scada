import { MemoryAuditSink } from "../src/audit/audit";
import { ScadaError, type IScadaProvider } from "../src/contract/scada.provider";
import {
    SCADA_INTERFACE_VERSION,
    type IBrowseResult,
    type IInvokeRequest,
    type IInvokeResult,
    type IProviderReadRequest,
    type IProviderWriteRequest,
    type IReadResult,
    type IScadaCapabilities,
    type IScadaValue,
    type ISubscriptionHandle,
    type IWriteResult,
} from "../src/contract/scada.types";
import { BrokerPolicyGate } from "../src/policy/broker.policy.gate";
import type { IScadaActor } from "../src/policy/policy.types";
import { ScadaService, type IScadaServiceOptions } from "../src/scada.service";

export const ROOT = "uns://production/site1/line1";
export const SPEED = `${ROOT}/motor01/speed`;
export const SETPOINT = `${ROOT}/motor01/speed-setpoint`;
export const FURNACE = `${ROOT}/furnace/setpoint`;

export const operator: IScadaActor = { id: "alice", subjects: ["user:alice", "group:operators"] };
export const observer: IScadaActor = { id: "bob", subjects: ["user:bob", "group:observers"] };
export const stranger: IScadaActor = { id: "eve", subjects: ["user:eve"] };

/** The broker `auth` section a site would already have, extended with SCADA capabilities. */
export const brokerAuth = {
    roles: {
        observer: { capabilities: ["scada.observe"] },
        acquirer: { inherits: ["observer"], capabilities: ["scada.acquire"] },
        operator: { inherits: ["acquirer"], capabilities: ["scada.control", "scada.execute"] },
    },
    assignments: [
        { id: "observers-site1", subject: "group:observers", role: "observer", resource: "/production/site1/**" },
        { id: "operators-line1", subject: "group:operators", role: "operator", resource: "/production/site1/line1/**" },
    ],
    denies: [{ id: "protect-furnace", subject: "group:operators", capabilities: ["scada.control"], resource: "/production/site1/line1/furnace/**" }],
};

/**
 * A provider that records every downstream call. `calls` is the traffic the
 * tests assert on: an empty list means nothing reached the protocol.
 */
export class FakeProvider implements IScadaProvider {
    readonly calls: { op: string; request: unknown }[] = [];
    values = new Map<string, unknown>([
        [SPEED, 1450],
        [SETPOINT, 2400],
        [FURNACE, 800],
    ]);
    capabilities: IScadaCapabilities;
    /** Override to simulate a provider lying about what it did. */
    provenanceOverride?: Partial<IScadaValue["provenance"]> | null;
    readDelayMs = 0;

    constructor(
        readonly id = "fake-line1",
        overrides: Partial<IScadaCapabilities> = {}
    ) {
        this.capabilities = {
            interface: SCADA_INTERFACE_VERSION,
            provider: id,
            source: "device",
            cachePolicy: { mode: "polling", freshnessMs: 1000 },
            capabilities: {
                browse: { supported: true },
                read: { destinations: ["provider", "device", "source"], consistency: ["cached", "fresh", "max-age", "source"] },
                write: { supported: true, destinations: ["source", "device"] },
                invoke: { supported: true },
                subscribe: { supported: false },
            },
            ...overrides,
        };
    }

    async getCapabilitiesAsync(): Promise<IScadaCapabilities> {
        return this.capabilities;
    }

    async browseAsync(): Promise<IBrowseResult> {
        this.calls.push({ op: "browse", request: {} });
        return {
            nodes: [...this.values.keys()].map((id) => ({
                id,
                kind: "variable" as const,
                name: id.split("/").pop()!,
                writable: true,
                // A provider's own opinion about authorization. It must change nothing.
                native: { accessLevel: "CurrentReadOrWrite", authorization: "allow", policy: "allow-all" },
            })),
        };
    }

    async readAsync(request: IProviderReadRequest): Promise<IReadResult> {
        this.calls.push({ op: "read", request });
        if (this.readDelayMs) await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
        const cached = request.destination === "provider" && request.consistency.mode !== "source";
        return {
            items: request.ids.map((id) =>
                this.values.has(id)
                    ? {
                          id,
                          value: this.values.get(id),
                          quality: "good" as const,
                          sourceTimestamp: null,
                          receivedTimestamp: new Date().toISOString(),
                          provenance:
                              this.provenanceOverride === null
                                  ? (undefined as never)
                                  : {
                                        provider: this.id,
                                        level: cached ? ("provider" as const) : ("device" as const),
                                        cached,
                                        cacheMode: "polling" as const,
                                        ageMs: cached ? 120 : 0,
                                        ...(this.provenanceOverride ?? {}),
                                    },
                      }
                    : { id, error: { code: "unknown_resource" as const, message: "no such point" } }
            ),
        };
    }

    async writeAsync(request: IProviderWriteRequest): Promise<IWriteResult> {
        this.calls.push({ op: "write", request });
        for (const item of request.items) this.values.set(item.id, item.value);
        return { items: request.items.map((item) => ({ id: item.id, status: "success" as const, nativeStatus: "Good" })) };
    }

    async invokeAsync(request: IInvokeRequest): Promise<IInvokeResult> {
        this.calls.push({ op: "invoke", request });
        return { id: request.id, status: "success", nativeStatus: "Good" };
    }

    async subscribeAsync(): Promise<ISubscriptionHandle> {
        throw new ScadaError("unsupported_capability", "no subscribe");
    }

    async unsubscribeAsync(): Promise<void> {}
}

export async function makeService(options: Partial<IScadaServiceOptions> = {}, provider = new FakeProvider()) {
    const audit = new MemoryAuditSink();
    const brokerEvents: unknown[] = [];
    const policy = options.policy ?? BrokerPolicyGate.fromBrokerAuthConfig(brokerAuth, { auditWriter: (event) => brokerEvents.push(event) });
    const service = new ScadaService({ audit, ...options, policy });
    await service.registerProviderAsync(provider, ROOT);
    return { service, provider, audit, brokerEvents };
}
