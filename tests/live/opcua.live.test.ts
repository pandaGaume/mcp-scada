import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAsync, type MqttClient } from "mqtt";
import type { McpClient } from "@cyanmycelium/mcp-core";
import { MemoryAuditSink } from "../../src/audit/audit";
import { isItemError, type IScadaValue } from "../../src/contract/scada.types";
import { BrokerPolicyGate } from "../../src/policy/broker.policy.gate";
import { OpcUaScadaProvider } from "../../src/providers/opcua/opcua.scada.provider";
import { ScadaService } from "../../src/scada.service";
import { brokerAuth, observer, operator, stranger } from "../helpers";
import { CountingSlotClient, slotClient, until } from "./bench";
import { OPCUA_MQTT_PORT, OPCUA_SERVER, OPCUA_SLOT, OpcUaBench, missingOpcuaBench, opcuaBenchAvailable } from "./opcua.bench";

const ROOT = "uns://production/site1";
const LINE = `${ROOT}/${OPCUA_SERVER}`;
const SPEED = `${LINE}/motor01-speed`;
const SETPOINT = `${LINE}/motor01-speed-sp`;
const RUNNING = `${LINE}/motor01-running`;
const TEMPERATURE = `${LINE}/motor01-temperature`;
const START = `${LINE}/motor01-start`;
const STOP = `${LINE}/motor01-stop`;
const SET_SPEED = `${LINE}/motor01-set-speed`;

if (!opcuaBenchAvailable) console.warn(`[scada live] OPC UA skipped, missing: ${missingOpcuaBench.join(", ")}`);

describe.skipIf(!opcuaBenchAvailable)("SCADA v1 over the live mcp-opc-ua slot", () => {
    const bench = new OpcUaBench();
    let client: McpClient;
    let counting: CountingSlotClient;
    let service: ScadaService;
    let audit: MemoryAuditSink;
    let provider: OpcUaScadaProvider;

    const connectSlot = async () => {
        client = await until("opcua slot", async () => {
            const candidate = slotClient(OPCUA_SLOT, { port: bench.port });
            try {
                await candidate.connect();
                return candidate;
            } catch (error) {
                candidate.disconnect();
                throw error;
            }
        });
        counting = new CountingSlotClient(client);
        // The simulator may still be starting, and the first session negotiates certificates.
        await until("opcua simulator", async () => {
            const result = await client.callTool("opcua.server_test", { server: OPCUA_SERVER, timeoutMs: 3000 });
            if (result.isError) throw new Error(JSON.stringify(result.content));
        });
    };

    beforeAll(async () => {
        await bench.start();
        await connectSlot();
        audit = new MemoryAuditSink();
        service = new ScadaService({ policy: BrokerPolicyGate.fromBrokerAuthConfig(brokerAuth, { auditWriter: () => {} }), audit });
        provider = new OpcUaScadaProvider({ id: "opcua-bench", client: counting, root: ROOT, timeoutMs: 5000 });
        await service.registerProviderAsync(provider, ROOT);
    });

    afterAll(async () => {
        client?.disconnect();
        await bench.stop();
    });

    it("registers the OPC UA provider with a server-level declaration", () => {
        const caps = service.capabilities().find((c) => c.provider === "opcua-bench");
        expect(caps).toMatchObject({ source: "server", cachePolicy: { mode: "none" }, capabilities: { read: { destinations: ["source"] }, write: { supported: true } } });
    });

    it("browses the slot catalog as UNS resources", async () => {
        const { nodes } = await service.browseAsync(observer);
        expect(nodes.filter((n) => n.kind === "variable").map((n) => n.id)).toEqual([RUNNING, SPEED, SETPOINT, TEMPERATURE]);
        expect(nodes.filter((n) => n.kind === "method").map((n) => n.id)).toEqual([START, STOP, SET_SPEED]);
        expect(nodes.find((n) => n.id === SETPOINT)).toMatchObject({ writable: true, unit: "rpm", native: { maxValue: 1500 } });
    });

    it("reads the server with its quality and source timestamps, in one OPC UA read", async () => {
        const before = counting.calls.length;
        const { items } = await service.readAsync(operator, { ids: [SPEED, TEMPERATURE, RUNNING], destination: "source" });
        expect(counting.calls.slice(before)).toEqual(["tool:opcua.read"]);
        for (const item of items) {
            const value = item as IScadaValue;
            expect(value.quality).toBe("good");
            expect(Date.parse(value.sourceTimestamp!)).not.toBeNaN();
            expect(value.provenance).toMatchObject({ provider: "opcua-bench", level: "server", cached: false });
        }
        expect(typeof (items[0] as IScadaValue).value).toBe("number");
    });

    it("writes a setpoint, invokes methods, and the motor follows", async () => {
        const write = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 600 }], destination: "source" });
        expect(write.items[0]).toMatchObject({ status: "success", nativeStatus: "Good" });

        const previous = await service.invokeAsync(operator, SET_SPEED, { setpoint: 900 });
        expect(previous).toMatchObject({ status: "success", outputs: { previous: 600 } });

        await service.invokeAsync(operator, START, {});
        await until("motor speed", async () => {
            const { items } = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
            if ((items[0] as IScadaValue).value !== 900) throw new Error(`speed is ${(items[0] as IScadaValue).value}`);
        });
    });

    it("refuses out-of-limit writes in the slot, and unauthorized ones before it", async () => {
        const refused = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 5000 }], destination: "source" });
        expect(refused.items[0]).toMatchObject({ status: "failure", error: { code: "constraint_violation", detail: { nativeCode: "out_of_range" } } });

        const before = counting.calls.length;
        const denied = await service.readAsync(stranger, { ids: [SPEED], destination: "source" });
        expect(isItemError(denied.items[0]) && denied.items[0].error.code).toBe("policy_denied");
        expect(counting.calls.length).toBe(before);
        expect(audit.records.some((r) => r.actor === "eve" && r.decision === "deny")).toBe(true);
    });

    it("subscribes on the MQTT data plane: values arrive under the UNS topic, never over MCP", async () => {
        const topic = provider.topicOf(SETPOINT);
        expect(topic).toBe("production/site1/line1/motor01-speed-sp");
        const consumer: MqttClient = await connectAsync(`mqtt://127.0.0.1:${OPCUA_MQTT_PORT}`);
        const values: unknown[] = [];
        let cleared = false;
        consumer.on("message", (_topic, payload) => {
            if (payload.length === 0) cleared = true;
            else values.push(JSON.parse(payload.toString()));
        });
        try {
            await consumer.subscribeAsync(topic);
            const before = counting.calls.length;
            const handle = await provider.subscribeAsync({ ids: [SETPOINT], samplingMs: 200 });
            expect(counting.calls.slice(before)).toEqual(["tool:opcua.publish_start"]);

            // The current value arrives first, with the identity mcp-scada gave it.
            await until("current setpoint on MQTT", async () => {
                if (values.length === 0) throw new Error("no message yet");
            });
            expect(values[0]).toMatchObject({ id: SETPOINT, binding: "motor01-speed-sp", kind: "value", quality: "good", unit: "rpm" });
            expect(Date.parse((values[0] as { sourceTimestamp: string }).sourceTimestamp)).not.toBeNaN();

            // A change made through SCADA comes back on MQTT; only the write itself went over MCP.
            await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 444 }], destination: "source" });
            await until("new setpoint on MQTT", async () => {
                if (!values.some((v) => (v as { value: unknown }).value === 444)) throw new Error(`${values.length} message(s)`);
            });
            expect(counting.calls.slice(before)).toEqual(["tool:opcua.publish_start", "tool:opcua.write"]);

            await provider.unsubscribeAsync(handle.subscriptionId);
            await until("retained value cleared", async () => {
                if (!cleared) throw new Error("no clearing message yet");
            });
        } finally {
            await consumer.endAsync();
        }
    });

    it("reports a stopped OPC UA server as provider_unavailable", async () => {
        await bench.stopSimulator();
        const { items } = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(isItemError(items[0]) && items[0].error.code).toBe("provider_unavailable");
    });
});
