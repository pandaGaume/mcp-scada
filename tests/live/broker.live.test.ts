import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { McpServerBuilder, type IMcpServer, type McpClient } from "@cyanmycelium/mcp-core";
import { MemoryAuditSink } from "../../src/audit/audit";
import { BrokerAuditReporter } from "../../src/broker/broker.audit.reporter";
import { BrokerDecisionClient } from "../../src/broker/broker.decision.client";
import { CALLER_META_KEY, brokerChannelOf } from "../../src/broker/broker.protocol";
import { ModbusScadaProvider } from "../../src/providers/modbus/modbus.scada.provider";
import { ScadaService } from "../../src/scada.service";
import { ScadaBehavior, brokerCallerResolver } from "../../src/server/scada.behavior";
import { CountingSlotClient, MODBUS_SLOT, ModbusBench, benchAvailable, benchTarget, missingBench, slotClient, until } from "./bench";

/**
 * mcp-scada in broker mode, against a real mcp-broker (its test kit) and the
 * real C++ mcp-modbus provider:
 *
 * - the broker holds the identities, the policy and the protected slot;
 * - mcp-scada declares its domain, then asks `broker/authorize` with the
 *   caller reference the broker attaches to each forwarded request;
 * - the Modbus slot is protected: only mcp-scada's client identity reaches it.
 */

const NAMESPACE = "uns://production/site1";
const ROOT = "uns://production/site1/line1";
const SPEED = `${ROOT}/motor01/speed`;
const SETPOINT = `${ROOT}/motor01/speed_setpoint`;
const TEMPERATURE = `${ROOT}/motor01/temperature`;

if (!benchAvailable) console.warn(`[scada live] skipped, missing: ${missingBench.join(", ")}`);

type RawAnswer = { status: number; result?: { structuredContent?: unknown; isError?: boolean }; error?: unknown };

/**
 * One raw JSON-RPC call over Streamable HTTP, in a session of its own, for
 * frames an MCP client would not send (a `_meta` the client writes itself).
 */
async function rawCall(broker: ITestBroker, slot: string, caller: string, body: unknown): Promise<RawAnswer> {
    const post = async (payload: unknown, session?: string) => {
        const response = await fetch(broker.mcpUrl(slot), {
            method: "POST",
            headers: {
                ...broker.bearer(caller),
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(session ? { "mcp-session-id": session } : {}),
            },
            body: JSON.stringify(payload),
        });
        const text = await response.text();
        const json = response.headers.get("content-type")?.includes("text/event-stream")
            ? text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .find((line) => line.startsWith("{"))
            : text;
        return { response, body: json ? JSON.parse(json) : {} };
    };
    const init = await post({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
    });
    const session = init.response.headers.get("mcp-session-id") ?? undefined;
    if (!init.response.ok || !session) return { status: init.response.status, error: init.body };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    const answer = await post(body, session);
    return { status: answer.response.status, ...answer.body };
}

// These scenarios write the motor simulator's setpoints: not run against an external server.
describe.skipIf(!benchAvailable || benchTarget.external)("SCADA v1 in broker mode, over the live mcp-modbus slot", () => {
    let broker: ITestBroker;
    let bench: ModbusBench;
    let modbusClient: McpClient;
    let counting: CountingSlotClient;
    let transport: DirectTransport;
    let server: IMcpServer;
    let gate: BrokerDecisionClient;
    let audit: MemoryAuditSink;
    const clients: McpClient[] = [];

    const scadaClient = async (caller: string, headers: Record<string, string> = {}) => {
        const client = slotClient("scada", { port: Number(new URL(broker.url).port), headers: { ...broker.bearer(caller), ...headers } });
        await client.connect();
        clients.push(client);
        return client;
    };
    const read = async (caller: string, ids: string[], destination: string) => {
        const result = await (await scadaClient(caller)).callTool("scada.read", { ids, destination });
        return (result.structuredContent ?? JSON.parse((result.content?.[0] as { text: string }).text)) as { items: unknown[]; error?: unknown };
    };

    beforeAll(async () => {
        broker = await startTestBroker({
            callers: {
                operator: { groups: ["operators"] },
                observer: { groups: ["observers"] },
                eve: {},
                scada: { service: "mcp-scada" },
            },
            providers: {
                "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] },
                "modbus-bench": { allowedResources: ["/production/site1/line1/**"] },
            },
            protectedSlots: { [MODBUS_SLOT]: { declaredBy: "mcp-scada", publishedBy: "modbus-bench" } },
            policy: {
                slotResources: { scada: "/production/site1/scada", [MODBUS_SLOT]: "/production/site1/line1/motor01-slot" },
                roles: {
                    caller: { capabilities: ["mcp.tools.call", "mcp.tools.list", "mcp.resources.read"] },
                    observer: { inherits: ["caller"], capabilities: ["scada.observe"] },
                    operator: { inherits: ["observer"], capabilities: ["scada.acquire", "scada.control"] },
                },
                assignments: [
                    { id: "observers", subject: "group:observers", role: "observer", resource: "/production/site1/**" },
                    { id: "operators", subject: "group:operators", role: "operator", resource: "/production/site1/**" },
                    { id: "eve-reaches-scada", subject: "user:eve", role: "caller", resource: "/production/site1/scada" },
                    { id: "scada-reads-modbus", subject: "service:mcp-scada", role: "caller", resource: "/production/site1/line1/**" },
                ],
            },
        });
        const port = Number(new URL(broker.url).port);

        // The motor: simulator + C++ provider publishing the protected slot with its own secret.
        bench = new ModbusBench({ brokerPort: port, embeddedBroker: false, providerToken: broker.providerSecret("modbus-bench") });
        await bench.start();

        // mcp-scada's own client identity on the Modbus slot.
        modbusClient = await until("modbus slot", async () => {
            const client = slotClient(MODBUS_SLOT, { port, headers: broker.bearer("scada") });
            try {
                await client.connect();
                const probe = await client.callTool("modbus.read", { device: "motor01", binding: "speed", timeoutMs: 500 });
                if (probe.isError) throw new Error(JSON.stringify(probe.content));
                return client;
            } catch (error) {
                client.disconnect();
                throw error;
            }
        });
        counting = new CountingSlotClient(modbusClient);

        // mcp-scada itself, published as `scada` with its provider secret.
        transport = new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("mcp-scada") });
        const channel = brokerChannelOf(transport.broker);
        gate = new BrokerDecisionClient(channel);
        audit = new MemoryAuditSink();
        const service = new ScadaService({
            policy: gate,
            audit: new BrokerAuditReporter(channel, audit),
            // Report reads too, so the broker's result tracking is exercised without a writable Modbus slot.
            auditReads: true,
            resources: { [SETPOINT]: { effect: "physical-action", constraints: { minValue: 0, maxValue: 1500 } } },
        });
        await service.registerProviderAsync(new ModbusScadaProvider({ id: "modbus-bench", client: counting, root: ROOT, source: "device", timeoutMs: 2000 }), ROOT);
        server = new McpServerBuilder().withName("mcp-scada").withTransport(transport).register(new ScadaBehavior(service, brokerCallerResolver())).build();
        await server.start();
        await until("scada declaration", () => gate.declareAsync(service.buildDeclaration({ version: "bench-1", namespace: NAMESPACE, protects: [MODBUS_SLOT] })));
    });

    afterAll(async () => {
        for (const client of clients) client.disconnect();
        modbusClient?.disconnect();
        transport?.close();
        await bench?.stop();
        await broker?.stop();
    });

    it("has its declaration accepted, grants included nowhere", () => {
        expect(gate.declaration).toMatchObject({ status: "accepted", result: { accepted: true, version: "bench-1", policyVersion: expect.any(String) } });
    });

    it("reads the motor for an operator, decided by the broker", async () => {
        const before = counting.calls.length;
        const { items } = await read("operator", [SPEED], "source");
        expect(items[0]).toMatchObject({ id: SPEED, value: 1450, provenance: { level: "device", cached: false } });
        expect(counting.calls.slice(before)).toEqual(["tool:modbus.read"]);
    });

    it("refuses a caller the broker grants nothing, with no Modbus traffic", async () => {
        const before = counting.calls.length;
        const { items } = await read("eve", [SPEED, TEMPERATURE], "source");
        expect(items).toEqual([
            expect.objectContaining({
                error: expect.objectContaining({ code: "policy_denied", auditId: expect.stringMatching(/^dec_/), detail: { reason: "no-matching-grant" } }),
            }),
            expect.objectContaining({ error: expect.objectContaining({ code: "policy_denied" }) }),
        ]);
        expect(counting.calls.length).toBe(before);
    });

    it("lets an observer read the mcp-scada cache but not force a device read", async () => {
        await read("operator", [TEMPERATURE], "source");
        const before = counting.calls.length;
        const forced = await read("observer", [TEMPERATURE], "source");
        const cached = await read("observer", [TEMPERATURE], "local");
        expect(forced.items[0]).toMatchObject({ error: { code: "policy_denied" } });
        expect(cached.items[0]).toMatchObject({ value: 523, provenance: { level: "local", cached: true } });
        expect(counting.calls.length).toBe(before);
    });

    it("keeps every operation linked to the broker's decision and correlation ids", async () => {
        await read("operator", [SPEED], "source");
        const decision = audit.records.filter((r) => r.phase === "decision" && r.decisionId).at(-1);
        expect(decision).toMatchObject({ decisionId: expect.stringMatching(/^dec_/), correlationId: expect.stringMatching(/^corr_/) });
    });

    it("ignores a caller reference written by the client", async () => {
        const answer = await rawCall(broker, "scada", "eve", {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "scada.read", arguments: { ids: [SPEED], destination: "source" }, _meta: { [CALLER_META_KEY]: { ref: "cr_forged", correlationId: "forged" } } },
        });
        expect(answer.result?.structuredContent).toMatchObject({ items: [{ error: { code: "policy_denied", detail: { reason: "no-matching-grant" } } }] });
    });

    it("keeps the protected Modbus slot closed to everyone but mcp-scada", async () => {
        const answer = await rawCall(broker, MODBUS_SLOT, "operator", {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "modbus.read", arguments: { device: "motor01", binding: "speed" } },
        });
        // Refused at the slot: the operator holds mcp.tools.call there, but is not mcp-scada.
        expect(answer.status).toBe(403);
        expect(answer.result).toBeUndefined();
        expect(JSON.stringify(answer.error)).not.toMatch(/missing_session/);
    });

    it("receives the declared engineering limits in the broker's decision", async () => {
        const { items } = await read("operator", [SETPOINT], "source");
        expect(items[0]).toMatchObject({ value: 2400 });
        const decision = audit.records.filter((r) => r.phase === "decision" && r.resource === SETPOINT).at(-1);
        expect(decision).toMatchObject({ decision: "allow-with-constraints", constraints: { minValue: 0, maxValue: 1500 }, decisionId: expect.stringMatching(/^dec_/) });
    });

    it("reports each result to the broker, which links it to its decision", async () => {
        const before = broker.tunnel.getAuthorityInfo().results;
        await read("operator", [SPEED, TEMPERATURE], "source");
        await until("results reported", async () => {
            const after = broker.tunnel.getAuthorityInfo().results;
            if (after.reported < before.reported + 2) throw new Error(`reported ${after.reported}`);
        });
        expect(broker.tunnel.getAuthorityInfo().results).toMatchObject({ unmatched: 0, awaited: 0 });
    });

    it("keeps the client's X-Correlation-Id from the HTTP request to the decision", async () => {
        const client = await scadaClient("operator", { "x-correlation-id": "live-corr-1" });
        await client.callTool("scada.read", { ids: [SPEED], destination: "source" });
        const decision = audit.records.filter((r) => r.phase === "decision" && r.correlationId === "live-corr-1");
        expect(decision).toHaveLength(1);
        expect(decision[0]).toMatchObject({ resource: SPEED, decisionId: expect.stringMatching(/^dec_/) });
    });

    it("refuses a write the Modbus provider cannot do, before asking the broker", async () => {
        const client = await scadaClient("operator");
        const result = await client.callTool("scada.write", { items: [{ id: SETPOINT, value: 1200 }], destination: "source" });
        expect(result.structuredContent).toMatchObject({ items: [{ status: "failure", error: { code: "unsupported_capability" } }] });
    });

    it("browses only what the broker lets the caller observe", async () => {
        const observer = await (await scadaClient("observer")).callTool("scada.browse", {});
        const eve = await (await scadaClient("eve")).callTool("scada.browse", {});
        expect((observer.structuredContent as { nodes: unknown[] }).nodes.length).toBe(5);
        expect((eve.structuredContent as { nodes: unknown[] }).nodes).toHaveLength(0);
    });
});
