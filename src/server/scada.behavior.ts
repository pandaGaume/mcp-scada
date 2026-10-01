import { McpAdapterBase, McpBehavior, McpToolResults, type McpResource, type McpResourceContent, type McpTool, type McpToolResult } from "@cyanmycelium/mcp-core";
import { ScadaError } from "../contract/scada.provider";
import { DESTINATIONS, CONSISTENCY_MODES, type Destination, type DestinationRequest, type IConsistency, type IWriteItem } from "../contract/scada.types";
import type { IScadaActor } from "../policy/policy.types";
import type { ScadaService } from "../scada.service";

export const SCADA_CAPABILITIES_URI = "scada://capabilities";

/**
 * Who the MCP session acts as.
 *
 * mcp-broker 1.4.0 authorizes the client frame, then forwards it to the slot
 * without the caller's principal. Until the broker propagates the verified
 * subjects, the SCADA slot acts as one configured service actor. See
 * docs/validation-architecture-v1.md, alignment point A1.
 */
export type ActorResolver = (args: Record<string, unknown>) => IScadaActor;

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

    async executeToolAsync(_uri: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
        const actor = this._actor(args);
        const correlationId = typeof args.correlationId === "string" && args.correlationId ? args.correlationId : undefined;
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
    constructor(service: ScadaService, actor: ActorResolver) {
        super(new ScadaAdapter(service, actor), { namespace: "scada" });
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
