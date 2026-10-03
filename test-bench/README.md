# Modbus test bench

The live tests (`npm run test:live`) run SCADA v1 against the real mcp-modbus stack:

```text
tests/live  ->  ScadaService  ->  ModbusScadaProvider  --MCP-->  mcp-broker (embedded, :3931)
                                                                     |  slot "bench-motor01"
                                                                     v
                                                          mcp_modbus_provider.exe (C++)
                                                                     |  Modbus TCP
                                                                     v
                                                          pyModbusTCP simulator (:15020)
```

The same broker also carries mcp-scada itself as the `scada` slot, so one test drives `scada.read` from an ordinary MCP client over Streamable HTTP.

## Files

| file | role |
|---|---|
| `simulator.json` | Registers served by the simulator on `127.0.0.1:15020` |
| `motor01.profile.json` | mcp-modbus device map: device `motor01`, bindings `speed`, `speed_setpoint`, `temperature`, `running` |

UNS ids are `uns://production/site1/line1/motor01/<binding>`.

## Prerequisites

A sibling checkout of `mcp-modbus` (or `MCP_MODBUS_DIR`) with:

- the provider built: `npm run build:provider` there, which produces `build/windows-release/Release/mcp_modbus_provider.exe` (or `build/linux-release/mcp_modbus_provider`);
- the simulator virtual environment: run `tools/pymodbustcp/start.ps1` once there.

Overrides: `MCP_MODBUS_PROVIDER`, `MCP_MODBUS_PYTHON`, `SCADA_BENCH_BROKER_PORT`. When a prerequisite is missing, the live suite is skipped and prints what it did not find.

## OPC UA chain

`tests/live/opcua.live.test.ts` drives the same contract over OPC UA. It needs a
sibling [mcp-opc-ua](../../mcp-opc-ua) checkout, built once:

```sh
cd ../mcp-opc-ua && dotnet build McpOpcUa.slnx
```

The bench then starts the .NET OPC UA simulator (port 48431), an embedded
broker (port 3932) and the `mcp-opc-ua` slot `opcua-line1`, connected with
SignAndEncrypt/Basic256Sha256 and the bench user. Override the locations with
`MCP_OPCUA_DIR`, `MCP_OPCUA_SIMULATOR` and `MCP_OPCUA_SLOT`, the ports with
`SCADA_OPCUA_SIMULATOR_PORT` and `SCADA_OPCUA_BROKER_PORT`.
