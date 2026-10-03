import { afterAll, beforeAll, it } from "vitest";
import { DirectTransport } from "@cyanmycelium/mcp-broker-provider";
import { startTestBroker, type ITestBroker } from "@cyanmycelium/mcp-broker/testing";
import { McpServerBuilder, type McpClient } from "@cyanmycelium/mcp-core";
import { MemoryAuditSink } from "../src/audit/audit";
import { BrokerAuditReporter } from "../src/broker/broker.audit.reporter";
import { BrokerDecisionClient } from "../src/broker/broker.decision.client";
import { brokerChannelOf } from "../src/broker/broker.protocol";
import { ModbusScadaProvider } from "../src/providers/modbus/modbus.scada.provider";
import { ScadaService } from "../src/scada.service";
import { ScadaBehavior, brokerCallerResolver } from "../src/server/scada.behavior";
import { MODBUS_SLOT, ModbusBench, benchAvailable, benchTarget, missingBench, slotClient, until } from "../tests/live/bench";

/**
 * Load measurement of the SCADA chain on the motor bench, through a real
 * broker that decides every call:
 *
 *   client(s) ─► broker ─► scada ─► broker ─► bench-motor01 (C++ mcp-modbus) ─► Modbus TCP server
 *
 * The server is the pyModbusTCP motor simulator, or with MODBUS_TEST_HOST an
 * external one such as modbux loaded with the Spoony map (see tests/live/bench.ts).
 *
 * Each cell runs N clients, each in its own MCP session, calling back to back
 * for a fixed duration. Run with `npm run bench:load`; BENCH_SECONDS sets the
 * duration of a cell (default 3).
 */

const NAMESPACE = "uns://production/site1";
const ROOT = "uns://production/site1/line1";
const { device: DEVICE, bindings: BINDINGS } = benchTarget;
const FIRST = `${ROOT}/${DEVICE}/${BINDINGS[0]}`;
const IDS3 = BINDINGS.map((binding) => `${ROOT}/${DEVICE}/${binding}`);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 3);
/** BENCH_CONCURRENCY: client counts to run, comma separated (default 1,2,4,8). */
const CONCURRENCY = (process.env.BENCH_CONCURRENCY ?? "1,2,4,8").split(",").map(Number);
/** BENCH_CELLS: which paths to measure, among A, B and C (default all). */
const CELLS = new Set((process.env.BENCH_CELLS ?? "A,B,C").split(",").map((cell) => cell.trim().toUpperCase()));
/** BENCH_ACQUIRE: the maxConcurrentAcquire values the B cells declare (default 1,4). */
const ACQUIRE = (process.env.BENCH_ACQUIRE ?? "1,4").split(",").map(Number);
/** A refused client waits this long before trying again, as a well-behaved one would, instead of hammering the broker. */
const BACKOFF_MS = Number(process.env.BENCH_BACKOFF_MS ?? 25);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorKinds = new Map<string, number>();

interface ICell {
    calls: number;
    ok: number;
    rateLimited: number;
    errors: number;
    latencies: number[];
}

let broker: ITestBroker;
let bench: ModbusBench;
let port: number;
let scadaTransport: DirectTransport | undefined;
const clients: McpClient[] = [];
const rows: string[] = [];

async function connect(slot: string, caller: string): Promise<McpClient> {
    const client = slotClient(slot, { port, headers: broker.bearer(caller) });
    await client.connect();
    clients.push(client);
    return client;
}

/** (Re)publishes mcp-scada with a given provider concurrency, declared to the broker by the same identity. */
async function publishScada(maxConcurrentAcquire: number): Promise<void> {
    scadaTransport?.close();
    const modbus = await connect(MODBUS_SLOT, "scada");
    scadaTransport = new DirectTransport(broker.providerUrl("scada"), { secret: broker.providerSecret("mcp-scada") });
    const channel = brokerChannelOf(scadaTransport.broker);
    const gate = new BrokerDecisionClient(channel);
    const service = new ScadaService({ policy: gate, audit: new BrokerAuditReporter(channel, new MemoryAuditSink()) });
    await service.registerProviderAsync(new ModbusScadaProvider({ id: "modbus-bench", client: modbus, root: ROOT, source: "device", timeoutMs: 2_000, maxConcurrentAcquire }), ROOT);
    await new McpServerBuilder().withName("mcp-scada").withTransport(scadaTransport).register(new ScadaBehavior(service, brokerCallerResolver())).build().start();
    await until("scada declaration", () => gate.declareAsync(service.buildDeclaration({ version: `load-${maxConcurrentAcquire}`, namespace: NAMESPACE, protects: [MODBUS_SLOT] })));
}

/** N sessions calling back to back for SECONDS; classifies each answer. */
async function measure(label: string, sessions: McpClient[], call: (client: McpClient) => Promise<{ isError?: boolean; structuredContent?: unknown; content?: readonly unknown[] }>): Promise<void> {
    const cell: ICell = { calls: 0, ok: 0, rateLimited: 0, errors: 0, latencies: [] };
    const deadline = performance.now() + SECONDS * 1000;
    await Promise.all(
        sessions.map(async (client) => {
            while (performance.now() < deadline) {
                const started = performance.now();
                let text = "";
                try {
                    const result = await call(client);
                    text = JSON.stringify(result.structuredContent ?? result.content ?? "");
                    if (result.isError) text = `error ${text}`;
                } catch (error) {
                    text = `error ${error instanceof Error ? error.message : String(error)}`;
                }
                cell.latencies.push(performance.now() - started);
                cell.calls++;
                if (text.includes("rate_limited")) {
                    cell.rateLimited++;
                    await sleep(BACKOFF_MS);
                } else if (text.startsWith("error") || text.includes('"error"')) {
                    cell.errors++;
                    const kind = `${label} x${sessions.length}: ${text.replace(/\d+/g, "#").slice(0, 160)}`;
                    errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
                } else cell.ok++;
            }
        })
    );
    const sorted = [...cell.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(1) : "-");
    const row = `| ${label} | ${sessions.length} | ${(cell.ok / SECONDS).toFixed(0)} | ${pct(50)} | ${pct(95)} | ${cell.calls ? ((100 * cell.rateLimited) / cell.calls).toFixed(0) : 0} % | ${cell.errors} |`;
    rows.push(row);
    console.log(row);
}

beforeAll(async () => {
    if (!benchAvailable) throw new Error(`bench missing: ${missingBench.join(", ")}`);
    broker = await startTestBroker({
        callers: { scada: { service: "mcp-scada" }, operator: { groups: ["operators"] } },
        providers: {
            "mcp-scada": { subjects: ["service:mcp-scada"], allowedResources: ["/production/site1/**"] },
            "modbus-bench": { allowedResources: ["/production/site1/line1/**"] },
        },
        protectedSlots: { [MODBUS_SLOT]: { declaredBy: "mcp-scada", publishedBy: "modbus-bench" } },
        policy: {
            slotResources: { scada: "/production/site1/scada", [MODBUS_SLOT]: "/production/site1/line1/motor01-slot" },
            roles: {
                caller: { capabilities: ["mcp.tools.call", "mcp.tools.list", "mcp.resources.read"] },
                operator: { inherits: ["caller"], capabilities: ["scada.observe", "scada.acquire"] },
            },
            assignments: [
                { id: "scada-reads-modbus", subject: "service:mcp-scada", role: "caller", resource: "/production/site1/line1/**" },
                { id: "operators", subject: "group:operators", role: "operator", resource: "/production/site1/**" },
            ],
        },
    });
    port = Number(new URL(broker.url).port);
    bench = new ModbusBench({ brokerPort: port, embeddedBroker: false, providerToken: broker.providerSecret("modbus-bench") });
    await bench.start();
    console.log(`[bench] ${benchTarget.external ? `external server, ${benchTarget.profile}, max_connections ${process.env.MODBUS_TEST_MAX_CONNECTIONS ?? "from the profile"}` : "pyModbusTCP motor simulator"}, device ${DEVICE}, bindings ${BINDINGS.join(", ")}`);
    await until("modbus slot", async () => {
        const probe = await (await connect(MODBUS_SLOT, "scada")).callTool("modbus.read", { device: DEVICE, binding: BINDINGS[0], timeoutMs: 500 });
        if (probe.isError) throw new Error(JSON.stringify(probe.content));
    });
}, 120_000);

afterAll(async () => {
    for (const [kind, count] of errorKinds) console.log(`[error x${count}] ${kind}`);
    console.log(["", "| chemin | clients | lectures réussies/s | p50 ms | p95 ms | rate_limited | autres erreurs |", "|---|---|---|---|---|---|---|", ...rows].join("\n"));
    for (const client of clients) client.disconnect();
    scadaTransport?.close();
    await bench?.stop();
    await broker?.stop();
});

it("measures the chain under load", async () => {
    // A. The Modbus slot alone: what the C++ provider and the simulator sustain.
    for (const n of CELLS.has("A") ? CONCURRENCY : []) {
        const sessions = await Promise.all(Array.from({ length: n }, () => connect(MODBUS_SLOT, "scada")));
        await measure("A modbus.read", sessions, (client) => client.callTool("modbus.read", { device: DEVICE, binding: BINDINGS[0], timeoutMs: 2_000 }));
    }
    // B. scada.read to the source, with the provider declaring 1 then 4 concurrent acquires.
    for (const maxConcurrentAcquire of CELLS.has("B") ? ACQUIRE : []) {
        await publishScada(maxConcurrentAcquire);
        for (const ids of [[FIRST], IDS3]) {
            for (const n of CONCURRENCY) {
                const sessions = await Promise.all(Array.from({ length: n }, () => connect("scada", "operator")));
                await measure(`B scada.read source, ${ids.length} id, maxConcurrentAcquire ${maxConcurrentAcquire}`, sessions, (client) =>
                    client.callTool("scada.read", { ids, destination: "source" })
                );
            }
        }
    }
    // C. scada.read from the local cache: no traffic to the equipment.
    if (CELLS.has("C") && !CELLS.has("B")) await publishScada(ACQUIRE[ACQUIRE.length - 1]!);
    for (const n of CELLS.has("C") ? CONCURRENCY : []) {
        const sessions = await Promise.all(Array.from({ length: n }, () => connect("scada", "operator")));
        await measure("C scada.read local, 3 id", sessions, (client) => client.callTool("scada.read", { ids: IDS3, destination: "local" }));
    }
}, 600_000);
