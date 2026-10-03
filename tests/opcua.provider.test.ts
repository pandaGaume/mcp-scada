import { describe, expect, it } from "vitest";
import { ScadaError } from "../src/contract/scada.provider";
import { isItemError, type IScadaValue } from "../src/contract/scada.types";
import { validateCapabilities } from "../src/contract/capabilities";
import type { ISlotClient } from "../src/providers/modbus/modbus.scada.provider";
import { OpcUaScadaProvider } from "../src/providers/opcua/opcua.scada.provider";
import { BrokerPolicyGate } from "../src/policy/broker.policy.gate";
import { ScadaService } from "../src/scada.service";
import { brokerAuth, observer, operator, ROOT } from "./helpers";

const SPEED = `${ROOT}/plc/motor01-speed`;
const SETPOINT = `${ROOT}/plc/motor01-speed-sp`;
const START = `${ROOT}/plc/motor01-start`;

const inventory = {
    schemaVersion: 1,
    servers: [{ key: "plc", description: "Line PLC", endpointUrl: "opc.tcp://plc:4840/", enabled: true, allowWrite: true, allowCall: true }],
    bindings: [
        { server: "plc", key: "motor01-speed", nodeId: "nsu=urn:x;s=Speed", unit: "rpm", writable: false },
        { server: "plc", key: "motor01-speed-sp", nodeId: "nsu=urn:x;s=SpeedSetpoint", unit: "rpm", writable: true, minValue: 0, maxValue: 1500 },
    ],
    methods: [{ server: "plc", key: "motor01-start", objectId: "nsu=urn:x;s=Motor01", methodId: "nsu=urn:x;s=Start", callable: true }],
};

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: (value as { status?: string }).status === "error" });

/** Answers like mcp-opc-ua and records every call. */
class FakeOpcUaSlot implements ISlotClient {
    readonly calls: { name: string; args: Record<string, unknown> }[] = [];
    values: Record<string, unknown> = { "motor01-speed": 1166.1, "motor01-speed-sp": 1200 };
    readback?: unknown;
    down = false;

    readonly publications = new Map<string, string>();

    async callTool(name: string, args: Record<string, unknown>) {
        this.calls.push({ name, args });
        if (this.down) return text({ status: "error", code: "server_unavailable", error: 'Cannot connect to "plc"' });
        switch (name) {
            case "opcua.publish_start": {
                if (!((args.binding as string) in this.values)) return text({ status: "error", code: "unknown_binding", error: "not configured" });
                if (!(args.topic as string).startsWith("production/")) return text({ status: "error", code: "not_permitted", error: "outside mqtt.allowedTopicRoots" });
                const existing = [...this.publications].find(([, topic]) => topic === args.topic)?.[0];
                const publicationId = existing ?? `pub-${this.publications.size + 1}`;
                this.publications.set(publicationId, args.topic as string);
                return text({ status: "ok", publicationId, created: !existing, topic: args.topic });
            }
            case "opcua.publish_stop":
                return text({ status: "ok", stopped: this.publications.delete(args.publicationId as string) });
            case "opcua.read":
                return text({
                    status: "ok",
                    server: args.server,
                    receivedTimestamp: "2026-10-03T10:00:01.000Z",
                    items: (args.bindings as string[]).map((binding) =>
                        binding in this.values
                            ? {
                                  binding,
                                  nodeId: `nsu=urn:x;s=${binding}`,
                                  status: "ok",
                                  value: this.values[binding],
                                  dataType: "Double",
                                  quality: binding === "motor01-speed" ? "good" : "uncertain",
                                  statusCode: "Good",
                                  sourceTimestamp: "2026-10-03T10:00:00.750Z",
                                  serverTimestamp: "2026-10-03T10:00:00.900Z",
                              }
                            : { binding, status: "error", code: "unknown_node", error: "BadNodeIdUnknown", statusCode: "BadNodeIdUnknown", quality: "bad" }
                    ),
                });
            case "opcua.write": {
                const value = args.value as number;
                if (value > 1500) return text({ status: "error", code: "out_of_range", error: `${value} is outside the engineering limits`, detail: { maxValue: 1500 } });
                this.values[args.binding as string] = value;
                return text({ status: "ok", statusCode: "Good", readback: { value: this.readback ?? value, statusCode: "Good", matches: this.readback === undefined } });
            }
            case "opcua.call":
                if (args.method !== "motor01-start") return text({ status: "error", code: "unknown_method", error: "not declared" });
                return text({ status: "ok", statusCode: "Good", outputs: [true], namedOutputs: { started: true } });
            default:
                throw new Error(`unexpected tool ${name}`);
        }
    }

    async readResource(uri: string) {
        if (uri !== "opcua://gateway/inventory") throw new Error(`unexpected resource ${uri}`);
        return { text: JSON.stringify(inventory) };
    }
}

const create = (slot = new FakeOpcUaSlot(), options: Partial<ConstructorParameters<typeof OpcUaScadaProvider>[0]> = {}) => ({
    slot,
    provider: new OpcUaScadaProvider({ id: "opcua-line1", client: slot, root: ROOT, ...options }),
});

describe("OpcUaScadaProvider", () => {
    it("declares a coherent server-level capability set", async () => {
        const { provider } = create();
        const capabilities = await provider.getCapabilitiesAsync();
        expect(validateCapabilities("opcua-line1", capabilities)).toEqual([]);
        expect(capabilities.source).toBe("server");
        expect(capabilities.capabilities.read.consistency).toContain("max-age");
    });

    it("browses servers, bindings and methods as UNS nodes", async () => {
        const { provider } = create();
        const { nodes } = await provider.browseAsync({});
        expect(nodes.map((n) => [n.id, n.kind])).toEqual([
            [`${ROOT}/plc`, "folder"],
            [SPEED, "variable"],
            [SETPOINT, "variable"],
            [START, "method"],
        ]);
        expect(nodes.find((n) => n.id === SETPOINT)).toMatchObject({ writable: true, unit: "rpm", effect: "physical-action", native: { maxValue: 1500 } });
        expect((await provider.browseAsync({ root: `${ROOT}/other` })).nodes).toEqual([]);
    });

    it("reads one batch per server with the server's quality and timestamps", async () => {
        const { provider, slot } = create();
        const { items } = await provider.readAsync({ ids: [SPEED, SETPOINT, `${ROOT}/plc/ghost`, `${ROOT}/bad`], destination: "source", consistency: { mode: "fresh" } });
        expect(slot.calls).toEqual([{ name: "opcua.read", args: { server: "plc", bindings: ["motor01-speed", "motor01-speed-sp", "ghost"], maxAgeMs: 0, timeoutMs: 5000 } }]);

        const speed = items.find((i) => i.id === SPEED) as IScadaValue;
        expect(speed).toMatchObject({
            value: 1166.1,
            quality: "good",
            sourceTimestamp: "2026-10-03T10:00:00.750Z",
            receivedTimestamp: "2026-10-03T10:00:01.000Z",
            provenance: { provider: "opcua-line1", level: "server", cached: false, cacheMode: "none", ageMs: 250 },
            native: { server: "plc", statusCode: "Good", dataType: "Double" },
        });
        expect((items.find((i) => i.id === SETPOINT) as IScadaValue).quality).toBe("uncertain");

        const ghost = items.find((i) => i.id === `${ROOT}/plc/ghost`)!;
        expect(isItemError(ghost) && ghost.error).toMatchObject({ code: "native_protocol_error", detail: { nativeCode: "unknown_node", statusCode: "BadNodeIdUnknown" } });
        const bad = items.find((i) => i.id === `${ROOT}/bad`)!;
        expect(isItemError(bad) && bad.error.code).toBe("unknown_resource");
    });

    it("passes max-age to the server as the OPC UA MaxAge and splits large batches", async () => {
        const { provider, slot } = create(undefined, { maxBatchSize: 1 });
        await provider.readAsync({ ids: [SPEED, SETPOINT], destination: "source", consistency: { mode: "max-age", maxAgeMs: 2000 } });
        expect(slot.calls.map((c) => [c.args.bindings, c.args.maxAgeMs])).toEqual([
            [["motor01-speed"], 2000],
            [["motor01-speed-sp"], 2000],
        ]);
    });

    it("reports an unreachable server as provider_unavailable for every id", async () => {
        const slot = new FakeOpcUaSlot();
        slot.down = true;
        const { provider } = create(slot);
        const { items } = await provider.readAsync({ ids: [SPEED, SETPOINT], destination: "source", consistency: { mode: "source" } });
        expect(items.map((i) => isItemError(i) && i.error.code)).toEqual(["provider_unavailable", "provider_unavailable"]);
        await expect(provider.readAsync({ ids: [SPEED], destination: "device", consistency: { mode: "source" } })).rejects.toMatchObject({ code: "unsupported_destination" });
    });

    it("writes with read-back, and maps refusals and mismatches to failures", async () => {
        const { provider, slot } = create();
        const ok = await provider.writeAsync({ items: [{ id: SETPOINT, value: 900 }], destination: "source" });
        expect(ok.items).toEqual([{ id: SETPOINT, status: "success", nativeStatus: "Good" }]);
        expect(slot.calls[0]).toEqual({ name: "opcua.write", args: { server: "plc", binding: "motor01-speed-sp", value: 900, verify: true, timeoutMs: 5000 } });

        const refused = await provider.writeAsync({ items: [{ id: SETPOINT, value: 2000 }], destination: "source" });
        expect(refused.items[0]).toMatchObject({ status: "failure", error: { code: "constraint_violation", detail: { nativeCode: "out_of_range" } } });

        slot.readback = 0;
        const mismatch = await provider.writeAsync({ items: [{ id: SETPOINT, value: 800 }], destination: "source" });
        expect(mismatch.items[0]).toMatchObject({ status: "failure", error: { code: "native_protocol_error", detail: { readback: 0 } } });
    });

    it("invokes declared methods by name and refuses unknown ones", async () => {
        const { provider, slot } = create();
        const result = await provider.invokeAsync({ id: START, arguments: {} });
        expect(result).toEqual({ id: START, status: "success", outputs: { started: true }, nativeStatus: "Good" });
        expect(slot.calls[0].args).toMatchObject({ server: "plc", method: "motor01-start", arguments: {} });

        await expect(provider.invokeAsync({ id: `${ROOT}/plc/explode`, arguments: {} })).rejects.toBeInstanceOf(ScadaError);
    });

    it("subscribes by publishing each id to its UNS topic on the MQTT data plane", async () => {
        const { provider, slot } = create();
        expect(provider.topicOf(SPEED)).toBe("production/site1/line1/plc/motor01-speed");

        const first = await provider.subscribeAsync({ ids: [SPEED, SETPOINT], samplingMs: 250 });
        expect(slot.calls).toEqual([
            {
                name: "opcua.publish_start",
                args: { server: "plc", binding: "motor01-speed", topic: "production/site1/line1/plc/motor01-speed", id: SPEED, samplingIntervalMs: 250 },
            },
            {
                name: "opcua.publish_start",
                args: { server: "plc", binding: "motor01-speed-sp", topic: "production/site1/line1/plc/motor01-speed-sp", id: SETPOINT, samplingIntervalMs: 250 },
            },
        ]);

        // A second subscription on the speed shares its publication: stopping the first keeps it alive.
        const second = await provider.subscribeAsync({ ids: [SPEED] });
        await provider.unsubscribeAsync(first.subscriptionId);
        expect([...slot.publications.values()]).toEqual(["production/site1/line1/plc/motor01-speed"]);
        await provider.unsubscribeAsync(second.subscriptionId);
        expect(slot.publications.size).toBe(0);
        expect(slot.calls.filter((c) => c.name === "opcua.publish_stop").every((c) => c.args.clearRetained === true)).toBe(true);
    });

    it("rolls a subscription back when one id is refused", async () => {
        const { provider, slot } = create(undefined, { topicOf: (id) => (id === SETPOINT ? "elsewhere/sp" : `production/${id.split("/").pop()}`) });
        await expect(provider.subscribeAsync({ ids: [SPEED, SETPOINT] })).rejects.toMatchObject({ code: "policy_denied", detail: { nativeCode: "not_permitted", id: SETPOINT } });
        expect(slot.publications.size).toBe(0);
        await expect(provider.subscribeAsync({ ids: [START] })).rejects.toMatchObject({ code: "unknown_resource" });
        await expect(provider.subscribeAsync({ ids: [`${ROOT}/bad`] })).rejects.toMatchObject({ code: "unknown_resource" });
    });

    it("serves the SCADA contract through ScadaService and the broker policy", async () => {
        const { provider, slot } = create();
        const service = new ScadaService({ policy: BrokerPolicyGate.fromBrokerAuthConfig(brokerAuth, { auditWriter: () => {} }) });
        await service.registerProviderAsync(provider, ROOT);

        const read = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect((read.items[0] as IScadaValue).value).toBe(1166.1);

        const written = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 700 }], destination: "source" });
        expect(written.items[0].status).toBe("success");
        expect(slot.values["motor01-speed-sp"]).toBe(700);

        // An observer may not control: the slot never sees the write.
        const before = slot.calls.length;
        const denied = await service.writeAsync(observer, { items: [{ id: SETPOINT, value: 1 }], destination: "source" });
        expect(denied.items[0]).toMatchObject({ status: "failure", error: { code: "policy_denied" } });
        expect(slot.calls.length).toBe(before);
    });
});
