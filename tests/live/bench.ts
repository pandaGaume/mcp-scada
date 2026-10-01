import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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

export const benchAvailable = existsSync(providerExe) && existsSync(python) && existsSync(simulatorScript);
export const missingBench = [providerExe, python, simulatorScript].filter((file) => !existsSync(file));

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

export function slotClient(slot: string): McpClient {
    return new McpClient({ name: "mcp-scada-bench", version: "0.1.0" }, new StreamableHttpTransport(`http://127.0.0.1:${BROKER_PORT}/${encodeURIComponent(slot)}/mcp`), 5_000);
}

/**
 * The Modbus test bench: a pyModbusTCP simulator standing in for the motor,
 * an embedded mcp-broker, and the real C++ mcp-modbus provider publishing
 * the motor into a broker slot.
 */
export class ModbusBench {
    tunnel!: WsTunnel;
    private _simulator?: ChildProcess;
    private _provider?: ChildProcess;

    async start(): Promise<void> {
        this.startSimulator();
        this.tunnel = new WsTunnelBuilder().withHost("127.0.0.1").withPort(BROKER_PORT).build();
        await this.tunnel.start();
        this.startProvider();
    }

    startSimulator(): void {
        this._simulator = spawn(python, [simulatorScript, "--config", path.join(repoRoot, "test-bench", "simulator.json")], { stdio: "ignore" });
    }

    stopSimulator(): void {
        this._simulator?.kill();
        this._simulator = undefined;
    }

    startProvider(): void {
        this._provider = spawn(
            providerExe,
            ["--broker-host", "127.0.0.1", "--broker-port", String(BROKER_PORT), "--slot", MODBUS_SLOT, "--config", path.join(repoRoot, "test-bench", "motor01.profile.json")],
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
        this.stopSimulator();
        await this.tunnel?.stop();
    }
}
