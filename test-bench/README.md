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
