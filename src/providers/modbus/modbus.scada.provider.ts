import { ScadaError, type IScadaProvider } from "../../contract/scada.provider";
import {
    SCADA_INTERFACE_VERSION,
    type IBrowseRequest,
    type IBrowseResult,
    type IInvokeResult,
    type IProviderReadRequest,
    type IReadResult,
    type IScadaCapabilities,
    type IScadaNode,
    type ISubscriptionHandle,
    type IWriteResult,
    type ScadaReadItem,
    type UnsId,
} from "../../contract/scada.types";
import { UnsPath } from "@cyanmycelium/mcp-uns";

/** The part of an MCP client this provider uses; `McpClient` from mcp-core satisfies it. */
export interface ISlotClient {
    callTool(name: string, args: Record<string, unknown>): Promise<{ content?: readonly unknown[]; isError?: boolean }>;
    readResource(uri: string): Promise<{ text?: string } | readonly { text?: string }[]>;
}

export interface IModbusScadaProviderOptions {
    /** SCADA provider id, e.g. `modbus-bench`. */
    readonly id: string;
    /** MCP client connected to the mcp-modbus slot through the broker. */
    readonly client: ISlotClient;
    /** UNS root under which `<device>/<binding>` ids are published. */
    readonly root: UnsId;
    /**
     * What a read physically reaches. `device` for Modbus TCP or RTU wired
     * directly; `gateway` when a TCP/RTU gateway sits in between and cannot
     * prove it polled the device.
     */
    readonly source: "device" | "gateway";
    /** Per-read timeout passed to the Modbus service. */
    readonly timeoutMs?: number;
    /** Declared bound on concurrent reads; a Modbus link is half duplex. */
    readonly maxConcurrentAcquire?: number;
}

interface IInventory {
    readonly endpoints?: readonly { key: string; transport?: string; description?: string; enabled?: boolean }[];
    readonly devices?: readonly { key: string; endpoint?: string; unitId?: number; description?: string; enabled?: boolean }[];
    readonly bindings?: readonly {
        device: string;
        key: string;
        symbol?: string;
        unit?: string;
        area?: string;
        address?: number;
        quantity?: number;
        readable?: boolean;
        writable?: boolean;
    }[];
}

interface IModbusValue {
    readonly status?: string;
    readonly error?: string;
    readonly binding?: string;
    readonly symbol?: string;
    readonly unit?: string;
    readonly kind?: string;
    readonly value?: unknown;
    readonly values?: readonly IModbusValue[];
}

function firstText(result: { content?: readonly unknown[] } | { text?: string } | readonly { text?: string }[]): string | undefined {
    if (Array.isArray(result)) return result.find((item) => typeof item?.text === "string")?.text;
    const single = result as { text?: string; content?: readonly unknown[] };
    if (typeof single.text === "string") return single.text;
    const content = single.content?.find((item) => typeof (item as { text?: unknown })?.text === "string") as { text: string } | undefined;
    return content?.text;
}

/**
 * SCADA v1 binding for an mcp-modbus slot.
 *
 * The slot is a C++ `McpModbusService` published into the broker. This
 * provider speaks to it as an ordinary MCP client (`modbus.read`,
 * `modbus.batch_read`, `modbus://gateway/inventory`) and maps the Modbus
 * catalog onto UNS ids `<root>/<device>/<binding>`. Catalog keys are stable,
 * so a provider reconnect or a slot rename never changes a UNS id.
 *
 * What it declares, and why:
 *
 * - no cache (`cachePolicy.mode: "none"`): every read is a live Modbus
 *   transaction, so `provider` and `cached` are refused rather than faked;
 * - `source` is the device, or the gateway when one is configured;
 * - Modbus carries no timestamp, so `sourceTimestamp` is always `null`;
 * - write, invoke and subscribe are not supported: the Modbus service does
 *   not publish them yet (`modbus.write` is planned upstream).
 */
export class ModbusScadaProvider implements IScadaProvider {
    readonly id: string;
    private readonly _client: ISlotClient;
    private readonly _root: UnsPath;
    private readonly _source: "device" | "gateway";
    private readonly _timeoutMs: number;
    private readonly _maxConcurrent: number;

    constructor(options: IModbusScadaProviderOptions) {
        this.id = options.id;
        this._client = options.client;
        this._root = UnsPath.parse(options.root);
        this._source = options.source;
        this._timeoutMs = options.timeoutMs ?? 3000;
        this._maxConcurrent = options.maxConcurrentAcquire ?? 1;
    }

    async getCapabilitiesAsync(): Promise<IScadaCapabilities> {
        return {
            interface: SCADA_INTERFACE_VERSION,
            provider: this.id,
            source: this._source,
            cachePolicy: { mode: "none" },
            capabilities: {
                browse: { supported: true },
                read: { destinations: [this._source, "source"], consistency: ["fresh", "max-age", "source"] },
                write: { supported: false },
                invoke: { supported: false },
                subscribe: { supported: false },
            },
            limits: { maxConcurrentAcquire: this._maxConcurrent },
            security: ["none"],
            nativeMetadata: ["device", "binding", "symbol", "unit", "kind", "area", "address", "quantity", "unitId", "endpoint"],
        };
    }

    async browseAsync(request: IBrowseRequest): Promise<IBrowseResult> {
        const inventory = await this._inventory();
        const devices = new Map((inventory.devices ?? []).map((device) => [device.key, device]));
        const nodes: IScadaNode[] = [];
        for (const device of devices.values()) {
            nodes.push({
                id: this._root.child(device.key).id,
                kind: "folder",
                name: device.key,
                description: device.description,
                native: { device: device.key, endpoint: device.endpoint, unitId: device.unitId, enabled: device.enabled },
            });
        }
        for (const binding of inventory.bindings ?? []) {
            nodes.push({
                id: this._root.child(binding.device, binding.key).id,
                kind: "variable",
                name: binding.key,
                description: binding.symbol,
                unit: binding.unit || undefined,
                readable: binding.readable,
                // The slot cannot write yet, whatever the profile says.
                writable: false,
                effect: "observation",
                native: {
                    device: binding.device,
                    binding: binding.key,
                    symbol: binding.symbol,
                    area: binding.area,
                    address: binding.address,
                    quantity: binding.quantity,
                    profileWritable: binding.writable,
                },
            });
        }
        const root = request.root ? UnsPath.tryParse(request.root) : undefined;
        return { nodes: root ? nodes.filter((node) => root.contains(UnsPath.parse(node.id))) : nodes };
    }

    async readAsync(request: IProviderReadRequest): Promise<IReadResult> {
        if (request.destination !== this._source && request.destination !== "source") {
            throw new ScadaError("unsupported_destination", `modbus provider "${this.id}" reads from "${this._source}" only`);
        }
        const byDevice = new Map<string, { id: UnsId; binding: string }[]>();
        const items: ScadaReadItem[] = [];
        for (const id of request.ids) {
            const key = this._keyOf(id);
            if (!key) {
                items.push({ id, error: { code: "unknown_resource", message: `${id} is not a <device>/<binding> id under ${this._root.id}` } });
                continue;
            }
            const bucket = byDevice.get(key.device);
            if (bucket) bucket.push({ id, binding: key.binding });
            else byDevice.set(key.device, [{ id, binding: key.binding }]);
        }

        for (const [device, wanted] of byDevice) {
            if (wanted.length === 1) {
                items.push(await this._readOne(device, wanted[0].binding, wanted[0].id));
                continue;
            }
            // Several bindings of one device: one grouped Modbus transaction set.
            const batch = await this._call("modbus.batch_read", { device, timeoutMs: this._timeoutMs });
            const receivedTimestamp = new Date().toISOString();
            if (batch.status !== "ok") {
                for (const w of wanted) items.push(this._error(w.id, batch));
                continue;
            }
            const values = new Map((batch.values ?? []).map((value) => [value.binding, value]));
            for (const w of wanted) {
                const value = values.get(w.binding);
                items.push(
                    value
                        ? this._value(w.id, value, receivedTimestamp)
                        : { id: w.id, error: { code: "unknown_resource", message: `binding "${w.binding}" is not configured on device "${device}"` } }
                );
            }
        }
        return { items };
    }

    async writeAsync(): Promise<IWriteResult> {
        throw new ScadaError("unsupported_capability", `modbus provider "${this.id}" does not support write`, { detail: { capability: "write" } });
    }

    async invokeAsync(): Promise<IInvokeResult> {
        throw new ScadaError("unsupported_capability", `modbus provider "${this.id}" does not support invoke`, { detail: { capability: "invoke" } });
    }

    async subscribeAsync(): Promise<ISubscriptionHandle> {
        throw new ScadaError("unsupported_capability", `modbus provider "${this.id}" does not support subscribe`, { detail: { capability: "subscribe" } });
    }

    async unsubscribeAsync(): Promise<void> {}

    // ── Internals ───────────────────────────────────────────────────────────

    private _keyOf(id: UnsId): { device: string; binding: string } | undefined {
        const path = UnsPath.tryParse(id);
        if (!path || !this._root.contains(path) || path.segments.length !== this._root.segments.length + 2) return undefined;
        const [device, binding] = path.segments.slice(this._root.segments.length);
        return { device, binding };
    }

    private async _inventory(): Promise<IInventory> {
        let text: string | undefined;
        try {
            text = firstText(await this._client.readResource("modbus://gateway/inventory"));
        } catch (error) {
            throw new ScadaError("provider_unavailable", `modbus slot for "${this.id}" is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!text) throw new ScadaError("native_protocol_error", "modbus inventory has no text content");
        return JSON.parse(text) as IInventory;
    }

    private async _call(tool: string, args: Record<string, unknown>): Promise<IModbusValue> {
        let result;
        try {
            result = await this._client.callTool(tool, args);
        } catch (error) {
            throw new ScadaError("provider_unavailable", `modbus slot for "${this.id}" is unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        const text = firstText(result);
        if (!text) return { status: "error", error: "no text content" };
        try {
            return JSON.parse(text) as IModbusValue;
        } catch {
            return { status: "error", error: text };
        }
    }

    private async _readOne(device: string, binding: string, id: UnsId): Promise<ScadaReadItem> {
        const result = await this._call("modbus.read", { device, binding, timeoutMs: this._timeoutMs });
        const receivedTimestamp = new Date().toISOString();
        return result.status === "ok" ? this._value(id, result, receivedTimestamp) : this._error(id, result);
    }

    private _value(id: UnsId, value: IModbusValue, receivedTimestamp: string): ScadaReadItem {
        return {
            id,
            value: value.value,
            quality: "good",
            sourceTimestamp: null,
            receivedTimestamp,
            provenance: { provider: this.id, level: this._source, cached: false, cacheMode: "none", ageMs: 0 },
            native: { symbol: value.symbol, unit: value.unit, kind: value.kind },
        };
    }

    private _error(id: UnsId, result: IModbusValue): ScadaReadItem {
        const nativeError = result.error ?? "unknown error";
        return {
            id,
            error: {
                code: nativeError === "not found" ? "unknown_resource" : "native_protocol_error",
                message: `modbus: ${nativeError}`,
                detail: { nativeError },
            },
        };
    }
}
