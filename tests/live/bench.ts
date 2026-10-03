import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WsTunnelBuilder, type WsTunnel } from "@cyanmycelium/mcp-broker";
import { McpClient } from "@cyanmycelium/mcp-core";
import { StreamableHttpTransport } from "@cyanmycelium/mcp-core/node";
import type { ISlotClient } from "../../src/providers/modbus/modbus.scada.provider";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
export const modbusRepo = path.resolve(process.env.MCP_MODBUS_DIR ?? path.join(repoRoot, "..", "mcp-modbus"));

const windows = process.platform === "win32";
export const providerExe =
    process.env.MCP_MODBUS_PROVIDER ??
    (windows ? path.join(modbusRepo, "build", "windows-release", "Release", "mcp_modbus_provider.exe") : path.join(modbusRepo, "build", "linux-release", "mcp_modbus_provider"));
export const python =
    process.env.MCP_MODBUS_PYTHON ??
    (windows ? path.join(modbusRepo, "tools", "pymodbustcp", ".venv", "Scripts", "python.exe") : path.join(modbusRepo, "tools", "pymodbustcp", ".venv", "bin", "python"));
const simulatorScript = path.join(modbusRepo, "tools", "pymodbustcp", "server.py");

/** The Modbus server the bench reads, and the device and three bindings it reads there. */
export interface IBenchTarget {
    /** An external server (MODBUS_TEST_HOST is set): no simulator is started. */
    readonly external: boolean;
    /** Device map handed to the C++ provider. */
    readonly profile: string;
    readonly device: string;
    readonly bindings: readonly [string, string, string];
}

/**
 * By default the pyModbusTCP motor simulator started by the bench. With
 * MODBUS_TEST_HOST set, an external server already running, for example
 * modbux loaded with mcp-modbus/config/simulators/modbux-spoony.json:
 *
 *   MODBUS_TEST_HOST      server address
 *   MODBUS_TEST_PORT      server port (default: the profile's)
 *   MODBUS_TEST_MAX_CONNECTIONS  connections the provider may open to it, 1 to 4 (default: the profile's)
 *   MODBUS_TEST_PROFILE   device map (default: mcp-modbus/config/profiles/local-spoony-modbux.json)
 *   MODBUS_TEST_DEVICE    device key (default: spoony_local)
 *   MODBUS_TEST_BINDINGS  three binding keys, comma separated (default: line_frequency,voltage_l1,relay_a)
 */
export const benchTarget: IBenchTarget = resolveBenchTarget();

function resolveBenchTarget(): IBenchTarget {
    const host = process.env.MODBUS_TEST_HOST;
    if (!host) {
        return { external: false, profile: path.join(repoRoot, "test-bench", "motor01.profile.json"), device: "motor01", bindings: ["speed", "temperature", "running"] };
    }
    const source = path.resolve(process.env.MODBUS_TEST_PROFILE ?? path.join(modbusRepo, "config", "profiles", "local-spoony-modbux.json"));
    const bindings = (process.env.MODBUS_TEST_BINDINGS ?? "line_frequency,voltage_l1,relay_a").split(",").map((key) => key.trim());
    if (bindings.length !== 3 || bindings.some((key) => !key)) throw new Error("MODBUS_TEST_BINDINGS must name three bindings");
    return {
        external: true,
        profile: existsSync(source) ? retarget(source, host, process.env.MODBUS_TEST_PORT, process.env.MODBUS_TEST_MAX_CONNECTIONS) : source,
        device: process.env.MODBUS_TEST_DEVICE ?? "spoony_local",
        bindings: bindings as unknown as readonly [string, string, string],
    };
}

/** A copy of the device map pointing at host:port, its profile_uri made absolute so the copy loads from anywhere. */
function retarget(source: string, host: string, port: string | undefined, maxConnections: string | undefined): string {
    const document = JSON.parse(readFileSync(source, "utf8"));
    document.endpoint.host = host;
    if (port) document.endpoint.port = Number(port);
    if (maxConnections) document.endpoint.max_connections = Number(maxConnections);
    if (typeof document.profile_uri === "string") document.profile_uri = path.resolve(path.dirname(source), document.profile_uri).replace(/\\/g, "/");
    const directory = mkdtempSync(path.join(tmpdir(), "scada-bench-"));
    const target = path.join(directory, path.basename(source));
    writeFileSync(target, JSON.stringify(document, null, 2));
    return target;
}

const required = benchTarget.external ? [providerExe, benchTarget.profile] : [providerExe, python, simulatorScript];
export const benchAvailable = required.every((file) => existsSync(file));
export const missingBench = required.filter((file) => !existsSync(file));

export const BROKER_PORT = Number(process.env.SCADA_BENCH_BROKER_PORT ?? 3931);
export const MODBUS_SLOT = "bench-motor01";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(what: string, attempt: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            return await attempt();
        } catch (error) {
            last = error;
            await sleep(200);
        }
    }
    throw new Error(`${what} did not become ready: ${last instanceof Error ? last.message : String(last)}`);
}

/** Wraps a slot client and counts what actually reaches the Modbus slot. */
export class CountingSlotClient implements ISlotClient {
    readonly calls: string[] = [];
    constructor(private readonly _inner: McpClient) {}

    callTool(name: string, args: Record<string, unknown>) {
        this.calls.push(`tool:${name}`);
        return this._inner.callTool(name, args);
    }

    readResource(uri: string) {
        this.calls.push(`resource:${uri}`);
        return this._inner.readResource(uri);
    }
}

export function slotClient(slot: string, options: { port?: number; headers?: Record<string, string> } = {}): McpClient {
    const url = `http://127.0.0.1:${options.port ?? BROKER_PORT}/${encodeURIComponent(slot)}/mcp`;
    return new McpClient({ name: "mcp-scada-bench", version: "0.1.0" }, new StreamableHttpTransport(url, options.headers ? { headers: options.headers } : {}), 5_000);
}

export interface IModbusBenchOptions {
    /** Port of the broker the provider publishes to. */
    readonly brokerPort?: number;
    /** Start an anonymous embedded broker on that port; false when the test brings its own. */
    readonly embeddedBroker?: boolean;
    /** Provider secret, sent by the C++ provider as `X-Provider-Token`. */
    readonly providerToken?: string;
}

/**
 * The Modbus test bench: a pyModbusTCP simulator standing in for the motor,
 * an embedded mcp-broker, and the real C++ mcp-modbus provider publishing
 * the motor into a broker slot.
 */
export class ModbusBench {
    tunnel?: WsTunnel;
    readonly port: number;
    private _simulator?: ChildProcess;
    private _provider?: ChildProcess;

    constructor(private readonly _options: IModbusBenchOptions = {}) {
        this.port = _options.brokerPort ?? BROKER_PORT;
    }

    async start(): Promise<void> {
        this.startSimulator();
        if (this._options.embeddedBroker !== false) {
            this.tunnel = new WsTunnelBuilder().withHost("127.0.0.1").withPort(this.port).build();
            await this.tunnel.start();
        }
        this.startProvider();
    }

    startSimulator(): void {
        if (benchTarget.external) return;
        this._simulator = spawn(python, [simulatorScript, "--config", path.join(repoRoot, "test-bench", "simulator.json")], { stdio: "ignore" });
    }

    /**
     * Stops the simulator and waits for its process to be gone: the provider keeps its connection
     * open, so a request sent while the process is still exiting would still be answered.
     */
    async stopSimulator(): Promise<void> {
        const simulator = this._simulator;
        this._simulator = undefined;
        if (!simulator || simulator.exitCode !== null) return;
        const exited = new Promise((resolve) => simulator.once("exit", resolve));
        simulator.kill();
        await exited;
    }

    startProvider(): void {
        this._provider = spawn(
            providerExe,
            [
                "--broker-host",
                "127.0.0.1",
                "--broker-port",
                String(this.port),
                "--slot",
                MODBUS_SLOT,
                "--config",
                benchTarget.profile,
                ...(this._options.providerToken ? ["--token", this._options.providerToken] : []),
            ],
            { stdio: "ignore" }
        );
    }

    async stopProvider(): Promise<void> {
        const provider = this._provider;
        this._provider = undefined;
        if (!provider || provider.exitCode !== null) return;
        const exited = new Promise((resolve) => provider.once("exit", resolve));
        provider.kill();
        await exited;
    }

    async stop(): Promise<void> {
        await this.stopProvider();
        await this.stopSimulator();
        await this.tunnel?.stop();
    }
}
