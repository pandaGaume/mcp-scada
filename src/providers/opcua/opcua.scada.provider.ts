import { ScadaError, type IScadaProvider } from "../../contract/scada.provider";
import {
    SCADA_INTERFACE_VERSION,
    type IBrowseRequest,
    type IBrowseResult,
    type IInvokeRequest,
    type IInvokeResult,
    type IProviderReadRequest,
    type IProviderWriteRequest,
    type IReadResult,
    type IScadaCapabilities,
    type IScadaErrorBody,
    type IScadaNode,
    type ISubscriptionHandle,
    type IWriteOutcome,
    type IWriteResult,
    type Quality,
    type ScadaErrorCode,
    type ScadaReadItem,
    type UnsId,
} from "../../contract/scada.types";
import type { ISlotClient } from "../modbus/modbus.scada.provider";
import { UnsPath } from "@cyanmycelium/mcp-uns";

export interface IOpcUaScadaProviderOptions {
    /** SCADA provider id, e.g. `opcua-line1`. */
    readonly id: string;
    /** MCP client connected to the mcp-opc-ua slot through the broker. */
    readonly client: ISlotClient;
    /** UNS root under which `<server>/<binding>` and `<server>/<method>` ids are published. */
    readonly root: UnsId;
    /** Per-call timeout passed to the slot. */
    readonly timeoutMs?: number;
    /** Declared bound on concurrent reads. An OPC UA session multiplexes, so more than one is fine. */
    readonly maxConcurrentAcquire?: number;
    /** Ids per `opcua.read`; keep it at or below the slot's `limits.maxNodesPerRead`. */
    readonly maxBatchSize?: number;
    /** Ask the slot to read every written value back and report a mismatch as a failure. */
    readonly verifyWrites?: boolean;
}

interface IInventory {
    readonly servers?: readonly { key: string; description?: string; endpointUrl?: string; enabled?: boolean; allowWrite?: boolean; allowCall?: boolean }[];
    readonly bindings?: readonly {
        server: string;
        key: string;
        nodeId?: string;
        description?: string;
        unit?: string;
        writable?: boolean;
        minValue?: number;
        maxValue?: number;
    }[];
    readonly methods?: readonly { server: string; key: string; objectId?: string; methodId?: string; description?: string; callable?: boolean }[];
}

/** One mcp-opc-ua tool result: `{ status: "ok", ... }` or `{ status: "error", code, error, detail }`. */
interface IOpcUaResult {
    readonly status?: string;
    readonly code?: string;
    readonly error?: string;
    readonly detail?: Record<string, unknown>;
    readonly receivedTimestamp?: string;
    readonly items?: readonly IOpcUaItem[];
    readonly statusCode?: string;
    readonly readback?: IOpcUaItem & { matches?: boolean };
    readonly namedOutputs?: Record<string, unknown>;
}

interface IOpcUaItem {
    readonly binding?: string;
    readonly nodeId?: string;
    readonly status?: string;
    readonly code?: string;
    readonly error?: string;
    readonly value?: unknown;
    readonly dataType?: string;
    readonly unit?: string;
    readonly quality?: string;
    readonly statusCode?: string;
    readonly sourceTimestamp?: string | null;
    readonly serverTimestamp?: string | null;
}

function firstText(result: { content?: readonly unknown[] } | { text?: string } | readonly { text?: string }[]): string | undefined {
    if (Array.isArray(result)) return result.find((item) => typeof item?.text === "string")?.text;
    const single = result as { text?: string; content?: readonly unknown[] };
    if (typeof single.text === "string") return single.text;
    const content = single.content?.find((item) => typeof (item as { text?: unknown })?.text === "string") as { text: string } | undefined;
    return content?.text;
}

/** mcp-opc-ua error codes that concern the whole call, not one item. */
const UNAVAILABLE = new Set(["server_unavailable", "server_disabled", "timeout"]);

/**
 * SCADA v1 binding for an mcp-opc-ua slot.
 *
 * The slot is the .NET mcp-opc-ua gateway published into the broker. This
 * provider speaks to it as an ordinary MCP client (`opcua.read`,
 * `opcua.write`, `opcua.call`, `opcua://gateway/inventory`) and maps its
 * catalog onto UNS ids `<root>/<server>/<binding>` (variables) and
 * `<root>/<server>/<method>` (methods). Catalog keys are stable, so a node id
 * change or a slot rename never changes a UNS id.
 *
 * What it declares, and why:
 *
 * - `source: "server"`: an OPC UA client cannot know whether the server
 *   polled the field device, so `device` is never claimed;
 * - no cache (`cachePolicy.mode: "none"`), but `max-age` is honoured: it is
 *   passed to the server as the OPC UA MaxAge, and the server answers from its
 *   own cache within that age;
 * - `sourceTimestamp` and `quality` come from the server; never synthesized;
 * - write and invoke go to bindings and methods the slot operator allowed;
 *   the slot re-checks its own engineering limits on top of the broker's;
 * - subscribe is not offered yet: the slot supports native resource
 *   subscriptions, but mcp-scada has no subscription path to route them.
 */
export class OpcUaScadaProvider implements IScadaProvider {
    readonly id: string;
    private readonly _client: ISlotClient;
    private readonly _root: UnsPath;
    private readonly _timeoutMs: number;
    private readonly _maxConcurrent: number;
    private readonly _maxBatch: number;
    private readonly _verifyWrites: boolean;

    constructor(options: IOpcUaScadaProviderOptions) {
        this.id = options.id;
        this._client = options.client;
        this._root = UnsPath.parse(options.root);
        this._timeoutMs = options.timeoutMs ?? 5000;
        this._maxConcurrent = options.maxConcurrentAcquire ?? 4;
        this._maxBatch = options.maxBatchSize ?? 100;
        this._verifyWrites = options.verifyWrites ?? true;
    }

    async getCapabilitiesAsync(): Promise<IScadaCapabilities> {
        return {
            interface: SCADA_INTERFACE_VERSION,
            provider: this.id,
            source: "server",
            cachePolicy: { mode: "none" },
            capabilities: {
                browse: { supported: true },
                // "server" is the source level, not a destination: reads and writes target "source".
                read: { destinations: ["source"], consistency: ["fresh", "max-age", "source"] },
                write: { supported: true, destinations: ["source"] },
                invoke: { supported: true },
                subscribe: { supported: false },
            },
            limits: { maxBatchSize: this._maxBatch, maxConcurrentAcquire: this._maxConcurrent },
            security: ["opcua"],
            nativeMetadata: ["server", "binding", "method", "nodeId", "dataType", "statusCode", "serverTimestamp", "unit"],
        };
    }

    async browseAsync(request: IBrowseRequest): Promise<IBrowseResult> {
        const inventory = await this._inventory();
        const nodes: IScadaNode[] = [];
        for (const server of inventory.servers ?? []) {
            nodes.push({
                id: this._root.child(server.key).id,
                kind: "folder",
                name: server.key,
                description: server.description,
                native: { server: server.key, endpointUrl: server.endpointUrl, enabled: server.enabled },
            });
        }
        for (const binding of inventory.bindings ?? []) {
            nodes.push({
                id: this._root.child(binding.server, binding.key).id,
                kind: "variable",
                name: binding.key,
                description: binding.description,
                unit: binding.unit || undefined,
                readable: true,
                writable: binding.writable === true,
                effect: binding.writable ? "physical-action" : "observation",
                native: { server: binding.server, binding: binding.key, nodeId: binding.nodeId, minValue: binding.minValue, maxValue: binding.maxValue },
            });
        }
        for (const method of inventory.methods ?? []) {
            nodes.push({
                id: this._root.child(method.server, method.key).id,
                kind: "method",
                name: method.key,
                description: method.description,
                effect: "physical-action",
                native: { server: method.server, method: method.key, objectId: method.objectId, methodId: method.methodId, callable: method.callable },
            });
        }
        const root = request.root ? UnsPath.tryParse(request.root) : undefined;
        return { nodes: root ? nodes.filter((node) => root.contains(UnsPath.parse(node.id))) : nodes };
    }

    async readAsync(request: IProviderReadRequest): Promise<IReadResult> {
        if (request.destination !== "source") {
            throw new ScadaError("unsupported_destination", `opcua provider "${this.id}" reads from "source" (the OPC UA server) only`);
        }
        const maxAgeMs = request.consistency.mode === "max-age" ? Math.max(0, request.consistency.maxAgeMs ?? 0) : 0;

        const byServer = new Map<string, { id: UnsId; binding: string }[]>();
        const items: ScadaReadItem[] = [];
        for (const id of request.ids) {
            const key = this._keyOf(id);
            if (!key) {
                items.push({ id, error: { code: "unknown_resource", message: `${id} is not a <server>/<binding> id under ${this._root.id}` } });
                continue;
            }
            const bucket = byServer.get(key.server);
            if (bucket) bucket.push({ id, binding: key.name });
            else byServer.set(key.server, [{ id, binding: key.name }]);
        }

        for (const [server, wanted] of byServer) {
            for (let start = 0; start < wanted.length; start += this._maxBatch) {
                const chunk = wanted.slice(start, start + this._maxBatch);
                const result = await this._call("opcua.read", { server, bindings: chunk.map((w) => w.binding), maxAgeMs, timeoutMs: this._timeoutMs });
                if (result.status !== "ok") {
                    const error = this._error(result);
                    for (const w of chunk) items.push({ id: w.id, error });
                    continue;
                }
                const received = result.receivedTimestamp ?? new Date().toISOString();
                const byBinding = new Map((result.items ?? []).map((item) => [item.binding, item]));
                for (const w of chunk) {
                    const item = byBinding.get(w.binding);
                    items.push(
                        item
                            ? this._item(w.id, server, item, received)
                            : { id: w.id, error: { code: "native_protocol_error", message: `the slot returned no item for "${w.binding}"` } }
                    );
                }
            }
        }
        return { items };
    }

    async writeAsync(request: IProviderWriteRequest): Promise<IWriteResult> {
        if (request.destination !== "source") {
            throw new ScadaError("unsupported_destination", `opcua provider "${this.id}" writes to "source" (the OPC UA server) only`);
        }
        const outcomes: IWriteOutcome[] = [];
        // One write per item: an OPC UA write of one binding is its own audited outcome.
        for (const item of request.items) {
            const key = this._keyOf(item.id);
            if (!key) {
                outcomes.push({ id: item.id, status: "failure", error: { code: "unknown_resource", message: `${item.id} is not a <server>/<binding> id under ${this._root.id}` } });
                continue;
            }
            const result = await this._call("opcua.write", { server: key.server, binding: key.name, value: item.value, verify: this._verifyWrites, timeoutMs: this._timeoutMs });
            if (result.status !== "ok") {
                outcomes.push({ id: item.id, status: "failure", nativeStatus: this._nativeStatus(result), error: this._error(result) });
                continue;
            }
            if (result.readback && result.readback.matches === false) {
                outcomes.push({
                    id: item.id,
                    status: "failure",
                    nativeStatus: result.statusCode,
                    error: {
                        code: "native_protocol_error",
                        message: `the server accepted the write but reads back ${JSON.stringify(result.readback.value)}`,
                        detail: { readback: result.readback.value, statusCode: result.readback.statusCode },
                    },
                });
                continue;
            }
            outcomes.push({ id: item.id, status: "success", nativeStatus: result.statusCode });
        }
        return { items: outcomes };
    }

    async invokeAsync(request: IInvokeRequest): Promise<IInvokeResult> {
        const key = this._keyOf(request.id);
        if (!key) throw new ScadaError("unknown_resource", `${request.id} is not a <server>/<method> id under ${this._root.id}`);
        const result = await this._call("opcua.call", { server: key.server, method: key.name, arguments: request.arguments ?? {}, timeoutMs: this._timeoutMs });
        if (result.status === "ok") return { id: request.id, status: "success", outputs: result.namedOutputs ?? {}, nativeStatus: result.statusCode };

        const error = this._error(result);
        // Refusals of the request itself are errors; a method that ran and failed is an outcome.
        if (error.code !== "native_protocol_error") throw new ScadaError(error.code, error.message, { detail: error.detail });
        return { id: request.id, status: "failure", nativeStatus: this._nativeStatus(result) };
    }

    async subscribeAsync(): Promise<ISubscriptionHandle> {
        throw new ScadaError("unsupported_capability", `opcua provider "${this.id}" does not route subscriptions yet`, { detail: { capability: "subscribe" } });
    }

    async unsubscribeAsync(): Promise<void> {}

    // ── Internals ───────────────────────────────────────────────────────────

    private _keyOf(id: UnsId): { server: string; name: string } | undefined {
        const path = UnsPath.tryParse(id);
        if (!path || !this._root.contains(path) || path.segments.length !== this._root.segments.length + 2) return undefined;
        const [server, name] = path.segments.slice(this._root.segments.length);
        return { server, name };
    }

    private async _inventory(): Promise<IInventory> {
        let text: string | undefined;
        try {
            text = firstText(await this._client.readResource("opcua://gateway/inventory"));
        } catch (error) {
            throw new ScadaError("provider_unavailable", `opcua slot for "${this.id}" is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!text) throw new ScadaError("native_protocol_error", "opcua inventory has no text content");
        return JSON.parse(text) as IInventory;
    }

    private async _call(tool: string, args: Record<string, unknown>): Promise<IOpcUaResult> {
        let result;
        try {
            result = await this._client.callTool(tool, args);
        } catch (error) {
            throw new ScadaError("provider_unavailable", `opcua slot for "${this.id}" is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        const text = firstText(result);
        if (!text) return { status: "error", code: "opcua_error", error: "no text content" };
        try {
            return JSON.parse(text) as IOpcUaResult;
        } catch {
            return { status: "error", code: "opcua_error", error: text };
        }
    }

    private _item(id: UnsId, server: string, item: IOpcUaItem, receivedTimestamp: string): ScadaReadItem {
        if (item.status !== "ok") return { id, error: this._error(item) };
        const sourceTimestamp = item.sourceTimestamp ?? null;
        const ageMs = sourceTimestamp ? Math.max(0, Date.parse(receivedTimestamp) - Date.parse(sourceTimestamp)) : null;
        return {
            id,
            value: item.value,
            quality: (["good", "uncertain", "bad"].includes(item.quality ?? "") ? item.quality : "uncertain") as Quality,
            sourceTimestamp,
            receivedTimestamp,
            provenance: { provider: this.id, level: "server", cached: false, cacheMode: "none", ageMs },
            native: {
                server,
                binding: item.binding,
                nodeId: item.nodeId,
                dataType: item.dataType,
                statusCode: item.statusCode,
                serverTimestamp: item.serverTimestamp,
                unit: item.unit,
            },
        };
    }

    /** Maps an mcp-opc-ua error code onto the SCADA vocabulary, keeping the native one in `detail`. */
    private _error(result: { code?: string; error?: string; statusCode?: string; detail?: Record<string, unknown> }): IScadaErrorBody {
        const nativeCode = result.code ?? "opcua_error";
        const code: ScadaErrorCode = UNAVAILABLE.has(nativeCode)
            ? "provider_unavailable"
            : nativeCode === "busy"
              ? "rate_limited"
              : nativeCode === "unknown_binding" || nativeCode === "unknown_method" || nativeCode === "unknown_server"
                ? "unknown_resource"
                : nativeCode === "out_of_range"
                  ? "constraint_violation"
                  : nativeCode === "invalid_argument" || nativeCode === "type_mismatch"
                    ? "invalid_request"
                    : nativeCode === "not_permitted"
                      ? "policy_denied"
                      : "native_protocol_error";
        const statusCode = result.statusCode ?? (result.detail?.statusCode as string | undefined);
        return {
            code,
            message: `opcua: ${result.error ?? nativeCode}`,
            detail: { nativeCode, ...(statusCode ? { statusCode } : {}), ...(nativeCode === "not_permitted" ? { refusedBy: "slot-configuration" } : {}) },
        };
    }

    private _nativeStatus(result: IOpcUaResult): string {
        return (result.detail?.statusCode as string | undefined) ?? result.statusCode ?? result.code ?? "unknown";
    }
}
