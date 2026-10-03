import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LoopbackTransport, McpServerBuilder, type IMcpServer, type McpClient } from "@cyanmycelium/mcp-core";
import { MemoryAuditSink } from "../../src/audit/audit";
import { isItemError, type IScadaValue } from "../../src/contract/scada.types";
import { BrokerPolicyGate } from "../../src/policy/broker.policy.gate";
import { ModbusScadaProvider } from "../../src/providers/modbus/modbus.scada.provider";
import { ScadaService } from "../../src/scada.service";
import { ScadaBehavior } from "../../src/server/scada.behavior";
import { brokerAuth, observer, operator, stranger } from "../helpers";
import { CountingSlotClient, MODBUS_SLOT, ModbusBench, benchAvailable, benchTarget, missingBench, slotClient, until } from "./bench";

const ROOT = "uns://production/site1/line1";
const MOTOR = `${ROOT}/motor01`;
const SPEED = `${MOTOR}/speed`;
const SETPOINT = `${MOTOR}/speed_setpoint`;
const TEMPERATURE = `${MOTOR}/temperature`;
const RUNNING = `${MOTOR}/running`;

if (!benchAvailable) console.warn(`[scada live] skipped, missing: ${missingBench.join(", ")}`);

// These scenarios write the motor simulator's setpoints: not run against an external server.
describe.skipIf(!benchAvailable || benchTarget.external)("SCADA v1 over the live mcp-modbus slot", () => {
    const bench = new ModbusBench();
    let modbusClient: McpClient;
    let counting: CountingSlotClient;
    let service: ScadaService;
    let audit: MemoryAuditSink;
    let scadaServer: IMcpServer;

    const connectModbusSlot = async () => {
        // A client whose initialize failed is not reused: each attempt starts clean.
        modbusClient = await until("modbus slot", async () => {
            const client = slotClient(MODBUS_SLOT);
            try {
                await client.connect();
                return client;
            } catch (error) {
                client.disconnect();
                throw error;
            }
        });
        counting = new CountingSlotClient(modbusClient);
        // The simulator may still be binding its port.
        await until("modbus simulator", async () => {
            const result = await modbusClient.callTool("modbus.read", { device: "motor01", binding: "speed", timeoutMs: 500 });
            if (result.isError) throw new Error(JSON.stringify(result.content));
        });
    };

    const register = async () => {
        audit = new MemoryAuditSink();
        service = new ScadaService({ policy: BrokerPolicyGate.fromBrokerAuthConfig(brokerAuth, { auditWriter: () => {} }), audit });
        await service.registerProviderAsync(new ModbusScadaProvider({ id: "modbus-bench", client: counting, root: ROOT, source: "device", timeoutMs: 2000 }), ROOT);
    };

    beforeAll(async () => {
        await bench.start();
        await connectModbusSlot();
        await register();

        // mcp-scada itself, published as the `scada` slot of the same broker.
        const [serverEnd, clientEnd] = LoopbackTransport.createPair();
        scadaServer = new McpServerBuilder()
            .withName("mcp-scada")
            .withTransport(serverEnd)
            .register(new ScadaBehavior(service, () => operator))
            .build();
        await scadaServer.start();
        bench.tunnel!.registerLoopbackProvider("scada", clientEnd);
    });

    afterAll(async () => {
        modbusClient?.disconnect();
        await bench.stop();
    });

    it("registers the Modbus provider with a coherent declaration", () => {
        const [caps] = service.capabilities();
        expect(caps).toMatchObject({
            interface: "scada.v1",
            provider: "modbus-bench",
            source: "device",
            cachePolicy: { mode: "none" },
            capabilities: { read: { destinations: ["device", "source"] }, write: { supported: false } },
        });
    });

    it("browses the Modbus catalog as UNS resources", async () => {
        const { nodes } = await service.browseAsync(observer);
        expect(nodes.filter((n) => n.kind === "variable").map((n) => n.id)).toEqual([SPEED, SETPOINT, TEMPERATURE, RUNNING]);
        expect(nodes.find((n) => n.id === SPEED)).toMatchObject({ unit: "rpm", readable: true, writable: false, native: { area: "holding_registers", address: 0 } });
    });

    it("reads the device with provenance, and never invents a source timestamp", async () => {
        const before = counting.calls.length;
        const { items } = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        const speed = items[0] as IScadaValue;
        expect(speed).toMatchObject({
            id: SPEED,
            value: 1450,
            quality: "good",
            sourceTimestamp: null,
            provenance: { provider: "modbus-bench", level: "device", cached: false, cacheMode: "none" },
        });
        expect(Date.parse(speed.receivedTimestamp)).not.toBeNaN();
        expect(counting.calls.slice(before)).toEqual(["tool:modbus.read"]);
    });

    it("groups several bindings of one device into one batch read", async () => {
        const before = counting.calls.length;
        const { items } = await service.readAsync(operator, { ids: [SPEED, SETPOINT, TEMPERATURE, RUNNING], destination: "device" });
        expect(items.map((i) => (i as IScadaValue).value)).toEqual([1450, 2400, 523, true]);
        expect(counting.calls.slice(before)).toEqual(["tool:modbus.batch_read"]);
    });

    it("serves `local` from the mcp-scada cache with no Modbus traffic", async () => {
        await service.readAsync(operator, { ids: [TEMPERATURE], destination: "source" });
        const before = counting.calls.length;
        const { items } = await service.readAsync(observer, { ids: [TEMPERATURE], destination: "local" });
        expect(items[0]).toMatchObject({ value: 523, provenance: { level: "local", cached: true } });
        expect(counting.calls.length).toBe(before);
    });

    it("refuses what Modbus cannot distinguish, without traffic", async () => {
        const before = counting.calls.length;
        const provider = await service.readAsync(operator, { ids: [SPEED], destination: "provider" });
        const gateway = await service.readAsync(operator, { ids: [SPEED], destination: "gateway" });
        const cached = await service.readAsync(operator, { ids: [SPEED], destination: "source", consistency: { mode: "cached" } });
        expect(provider.items[0]).toMatchObject({ error: { code: "unsupported_destination" } });
        expect(gateway.items[0]).toMatchObject({ error: { code: "unsupported_destination" } });
        expect(cached.items[0]).toMatchObject({ error: { code: "unsupported_consistency" } });
        expect(counting.calls.length).toBe(before);
    });

    it("refuses a write as unsupported_capability, the Modbus slot has no write tool", async () => {
        const before = counting.calls.length;
        const { items } = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1200 }], destination: "source" });
        expect(items[0]).toMatchObject({ status: "failure", error: { code: "unsupported_capability", detail: { capability: "write" } } });
        expect(counting.calls.length).toBe(before);
    });

    it("sends nothing to the Modbus slot when the broker policy denies", async () => {
        const before = counting.calls.length;
        const { items } = await service.readAsync(stranger, { ids: [SPEED, TEMPERATURE], destination: "source" });
        expect(items.every((i) => isItemError(i) && i.error.code === "policy_denied")).toBe(true);
        expect(counting.calls.length).toBe(before);
        expect(audit.records.filter((r) => r.actor === "eve" && r.decision === "deny")).toHaveLength(2);
    });

    it("maps a Modbus error to a normalized SCADA error", async () => {
        const { items } = await service.readAsync(operator, { ids: [`${MOTOR}/torque`], destination: "source" });
        expect(items[0]).toMatchObject({ error: { code: "unknown_resource", detail: { nativeError: "not found" } } });
    });

    it("exposes the same contract through the `scada` broker slot", async () => {
        const client = slotClient("scada");
        await client.connect();
        try {
            const tools = (await client.listTools()).map((t) => t.name);
            expect(tools).toEqual(expect.arrayContaining(["scada.capabilities", "scada.browse", "scada.read", "scada.write"]));
            const result = await client.callTool("scada.read", { ids: [SPEED], destination: "source", correlationId: "live-req-1" });
            expect(result.isError).toBeFalsy();
            expect(result.structuredContent).toMatchObject({ items: [{ id: SPEED, value: 1450, provenance: { level: "device" } }] });
            const missing = await client.callTool("scada.read", { ids: [SPEED] });
            expect(missing.isError).toBe(true);
        } finally {
            client.disconnect();
        }
    });

    it("keeps UNS identities across a provider reconnect", async () => {
        const before = (await service.browseAsync(observer)).nodes.map((n) => n.id);
        await bench.stopProvider();
        bench.startProvider();
        modbusClient.disconnect();
        await connectModbusSlot();
        service.unregisterProvider("modbus-bench");
        await service.registerProviderAsync(new ModbusScadaProvider({ id: "modbus-bench", client: counting, root: ROOT, source: "device", timeoutMs: 2000 }), ROOT);
        const after = (await service.browseAsync(observer)).nodes.map((n) => n.id);
        expect(after).toEqual(before);
        const { items } = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(items[0]).toMatchObject({ value: 1450 });
    });

    it("reports a dead device as a native protocol error, not as a value", async () => {
        bench.stopSimulator();
        const { items } = await service.readAsync(operator, { ids: [RUNNING], destination: "source" });
        expect(items[0]).toMatchObject({ error: { code: "native_protocol_error" } });
        // The last good value is still available, labelled as cached.
        const local = await service.readAsync(operator, { ids: [RUNNING], destination: "local" });
        expect(local.items[0]).toMatchObject({ value: true, provenance: { level: "local", cached: true } });
    });
});
