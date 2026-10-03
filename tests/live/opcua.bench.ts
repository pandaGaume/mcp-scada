import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WsTunnelBuilder, type WsTunnel } from "@cyanmycelium/mcp-broker";
import { repoRoot } from "./bench";

export const opcuaRepo = path.resolve(process.env.MCP_OPCUA_DIR ?? path.join(repoRoot, "..", "mcp-opc-ua"));

const windows = process.platform === "win32";
const exe = (name: string) => (windows ? `${name}.exe` : name);
export const opcuaSimulatorExe = process.env.MCP_OPCUA_SIMULATOR ?? path.join(opcuaRepo, "test-bench", "OpcUaSimulator", "bin", "Debug", "net8.0", exe("opcua-simulator"));
export const opcuaSlotExe = process.env.MCP_OPCUA_SLOT ?? path.join(opcuaRepo, "src", "McpOpcUa", "bin", "Debug", "net8.0", exe("mcp-opc-ua"));

const required = [opcuaSimulatorExe, opcuaSlotExe];
export const opcuaBenchAvailable = required.every((file) => existsSync(file));
export const missingOpcuaBench = required.filter((file) => !existsSync(file));

export const OPCUA_BROKER_PORT = Number(process.env.SCADA_OPCUA_BROKER_PORT ?? 3932);
export const OPCUA_SIMULATOR_PORT = Number(process.env.SCADA_OPCUA_SIMULATOR_PORT ?? 48431);
export const OPCUA_SLOT = "opcua-line1";
/** The server key of the slot configuration: UNS ids are `<root>/line1/<binding>`. */
export const OPCUA_SERVER = "line1";

const NS = "nsu=urn:cyanmycelium:opcua-simulator:line1;s=";

/**
 * The OPC UA test bench: the .NET simulator of mcp-opc-ua, an embedded
 * mcp-broker, and the real mcp-opc-ua slot publishing it (SignAndEncrypt,
 * user name login). Build mcp-opc-ua first: `dotnet build McpOpcUa.slnx`.
 */
export class OpcUaBench {
    tunnel?: WsTunnel;
    readonly port = OPCUA_BROKER_PORT;
    private readonly _work = mkdtempSync(path.join(tmpdir(), "scada-opcua-"));
    private _simulator?: ChildProcess;
    private _slot?: ChildProcess;

    async start(): Promise<void> {
        this._simulator = spawn(opcuaSimulatorExe, ["--port", String(OPCUA_SIMULATOR_PORT), "--pki", path.join(this._work, "pki-simulator")], { stdio: "ignore" });
        this.tunnel = new WsTunnelBuilder().withHost("127.0.0.1").withPort(this.port).build();
        await this.tunnel.start();
        this.startSlot();
    }

    startSlot(): void {
        const config = path.join(this._work, "slot.config.json");
        writeFileSync(config, JSON.stringify(slotConfig(path.join(this._work, "pki")), null, 2));
        this._slot = spawn(opcuaSlotExe, ["--config", config, "--broker", `ws://127.0.0.1:${this.port}`, "--slot", OPCUA_SLOT, "--log-level", "warning"], {
            stdio: "ignore",
            env: { ...process.env, OPCUA_LINE1_PASSWORD: "bench-password" },
        });
    }

    async stopSlot(): Promise<void> {
        await stopProcess(this._slot);
        this._slot = undefined;
    }

    async stopSimulator(): Promise<void> {
        await stopProcess(this._simulator);
        this._simulator = undefined;
    }

    async stop(): Promise<void> {
        await this.stopSlot();
        await this.stopSimulator();
        await this.tunnel?.stop();
    }
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
}

function slotConfig(pkiPath: string) {
    const binding = (key: string, node: string, extra: Record<string, unknown> = {}) => ({ key, nodeId: NS + node, ...extra });
    const method = (key: string, node: string) => ({ key, objectId: `${NS}Line1.Motor01`, methodId: NS + node });
    return {
        application: { name: "mcp-opc-ua-scada-bench", pkiPath, autoAcceptUntrustedCertificates: true },
        limits: { maxNodesPerRead: 100, defaultTimeoutMs: 5000 },
        servers: [
            {
                key: OPCUA_SERVER,
                endpointUrl: `opc.tcp://localhost:${OPCUA_SIMULATOR_PORT}/`,
                securityMode: "signAndEncrypt",
                securityPolicy: "Basic256Sha256",
                identity: { type: "username", username: "operator", passwordEnv: "OPCUA_LINE1_PASSWORD" },
                allowWrite: true,
                allowCall: true,
                bindings: [
                    binding("motor01-running", "Line1.Motor01.Running"),
                    binding("motor01-speed", "Line1.Motor01.Speed", { unit: "rpm" }),
                    binding("motor01-speed-sp", "Line1.Motor01.SpeedSetpoint", { unit: "rpm", writable: true, minValue: 0, maxValue: 1500 }),
                    binding("motor01-temperature", "Line1.Motor01.Temperature", { unit: "°C" }),
                ],
                methods: [method("motor01-start", "Line1.Motor01.Start"), method("motor01-stop", "Line1.Motor01.Stop"), method("motor01-set-speed", "Line1.Motor01.SetSpeed")],
            },
        ],
    };
}
