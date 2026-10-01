import { McpAdapterBase, McpBehavior, McpToolResults, type McpResource, type McpResourceContent, type McpTool, type McpToolResult } from "@cyanmycelium/mcp-core";
import { readCallerMeta } from "../broker/broker.protocol";
import { ScadaError } from "../contract/scada.provider";
import { DESTINATIONS, CONSISTENCY_MODES, type Destination, type DestinationRequest, type IConsistency, type IWriteItem } from "../contract/scada.types";
import type { IScadaActor } from "../policy/policy.types";
import type { ScadaService } from "../scada.service";

export const SCADA_CAPABILITIES_URI = "scada://capabilities";

/** What the MCP server knows about the request, beyond its arguments (mcp-core `IMcpRequestContext`). */
export interface IScadaRequestContext {
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
}

/** Who one MCP request acts for. */
export type ActorResolver = (args: Record<string, unknown>, context?: IScadaRequestContext) => IScadaActor;

/**
 * Broker mode: the actor is the caller handle the broker wrote in
 * `_meta["io.cyanmycelium/caller"]`. Without it the actor has no principal,
 * and the broker decision client denies every question: mcp-scada never
 * substitutes an identity of its own.
 *
 * Needs an mcp-core that passes `params._meta` to the adapter (1.4.0).
 */
export function brokerCallerResolver(): ActorResolver {
    return (_args, context) => {
        const caller = readCallerMeta(context?.meta);
        if (!caller) return { id: "anonymous", subjects: [] };
        return {
            id: `caller-ref:${caller.ref}`,
            subjects: [],
            principal: { type: "caller-ref", ref: caller.ref },
            ...(caller.correlationId ? { correlationId: caller.correlationId } : {}),
        };
    };
}

/**
 * Interim mode, until the broker exposes `broker/authorize`: every request
 * acts as one configured service actor, evaluated by the local
 * `BrokerPolicyGate`. Acceptable on a bench or a single-operator site only.
 */
export function serviceActorResolver(actor: IScadaActor): ActorResolver {
    return () => actor;
}

const destinationSchema = {
    oneOf: [
        { type: "string", enum: [...DESTINATIONS] },
        { type: "array", items: { type: "string", enum: [...DESTINATIONS] }, minItems: 1, description: "Explicit ordered fallback." },
    ],
};

class ScadaAdapter extends McpAdapterBase {
    constructor(
        private readonly _service: ScadaService,
        private readonly _actor: ActorResolver
    ) {
        super("scada");
    }

    async readResourceAsync(uri: string): Promise<McpResourceContent | undefined> {
        if (uri !== SCADA_CAPABILITIES_URI) return undefined;
        return { uri, mimeType: "application/json", text: JSON.stringify({ providers: this._service.capabilities() }) };
    }

    async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>, context?: IScadaRequestContext): Promise<McpToolResult> {
        const actor = this._actor(args, context);
        // The broker's correlation id wins: it is the one in the broker audit.
        const correlationId = actor.correlationId ?? (typeof args.correlationId === "string" && args.correlationId ? args.correlationId : undefined);
        try {
            switch (toolName) {
                case "scada.capabilities":
                    return McpToolResults.json({ providers: this._service.capabilities() });
                case "scada.browse":
                    return McpToolResults.json(await this._service.browseAsync(actor, args.root as string | undefined, { correlationId }));
                case "scada.read":
                    return McpToolResults.json(
                        await this._service.readAsync(
                            actor,
                            { ids: args.ids as string[], destination: args.destination as DestinationRequest, consistency: args.consistency as IConsistency | undefined },
                            { correlationId }
                        )
                    );
                case "scada.write":
                    return McpToolResults.json(
                        await this._service.writeAsync(actor, { items: args.items as IWriteItem[], destination: args.destination as Destination }, { correlationId })
                    );
                case "scada.invoke":
                    return McpToolResults.json(await this._service.invokeAsync(actor, args.id as string, (args.arguments as Record<string, unknown>) ?? {}, { correlationId }));
                default:
                    return McpToolResults.error(`unknown tool: ${toolName}`);
            }
        } catch (error) {
            const body = ScadaError.toBody(error);
            return { content: [{ type: "text", text: JSON.stringify({ error: body }) }], isError: true };
        }
    }
}

/** MCP surface of mcp-scada: one tool per SCADA v1 operation. */
export class ScadaBehavior extends McpBehavior {
    private readonly _scada: ScadaAdapter;

    constructor(service: ScadaService, actor: ActorResolver) {
        const adapter = new ScadaAdapter(service, actor);
        super(adapter, { namespace: "scada" });
        this._scada = adapter;
    }

    /** Forwards the request context that mcp-core's `McpBehavior` (1.3.0) does not pass on. */
    public override executeToolAsync(uri: string, toolName: string, args: Record<string, unknown>, context?: IScadaRequestContext): Promise<McpToolResult> {
        return this._scada.executeToolAsync(uri, toolName, args, context);
    }

    protected override _buildResources(): McpResource[] {
        return [{ uri: SCADA_CAPABILITIES_URI, name: "SCADA capabilities", description: "SCADA v1 capabilities of every registered provider.", mimeType: "application/json" }];
    }

    protected override _buildTools(): McpTool[] {
        const correlationId = { type: "string", description: "Optional correlation id propagated to the audit." };
        return [
            {
                name: "scada.capabilities",
                description: "List the SCADA v1 capabilities each provider declares. A capability says what a provider can do, never what you may do.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "scada.browse",
                description: "List the UNS resources you may observe, with unit, access and effect metadata.",
                inputSchema: { type: "object", properties: { root: { type: "string", description: "UNS subtree, e.g. uns://plant/line1" }, correlationId } },
            },
            {
                name: "scada.read",
                description:
                    "Read UNS resources from an explicit destination (local = mcp-scada cache, provider, gateway, controller, device, source). Each value states its quality, timestamps and provenance. A list of destinations is an explicit ordered fallback; nothing else falls back.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ids: { type: "array", items: { type: "string" }, minItems: 1 },
                        destination: destinationSchema,
                        consistency: {
                            type: "object",
                            properties: { mode: { type: "string", enum: [...CONSISTENCY_MODES] }, maxAgeMs: { type: "integer", minimum: 0 } },
                            required: ["mode"],
                        },
                        correlationId,
                    },
                    required: ["ids", "destination"],
                },
            },
            {
                name: "scada.write",
                description: "Write UNS resources at one destination. Authorized by the MCP Broker policy, constrained, and audited end to end.",
                inputSchema: {
                    type: "object",
                    properties: {
                        items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, value: {} }, required: ["id", "value"] }, minItems: 1 },
                        destination: { type: "string", enum: DESTINATIONS.filter((d) => d !== "local") },
                        correlationId,
                    },
                    required: ["items", "destination"],
                },
            },
            {
                name: "scada.invoke",
                description: "Invoke a UNS method. Authorized by the MCP Broker policy and audited.",
                inputSchema: { type: "object", properties: { id: { type: "string" }, arguments: { type: "object" }, correlationId }, required: ["id"] },
            },
        ];
    }
}
