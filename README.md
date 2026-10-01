# mcp-scada

SCADA v1 above the industrial MCP slots of an [mcp-broker](../mcp-broker): one contract for `browse`, `read`, `write` and `invoke`, whatever protocol a slot speaks (Modbus today, OPC UA next).

```text
MCP client ──> mcp-broker ──> slot "scada" (mcp-scada)
                                  │  UNS resolution, capabilities, destination/consistency,
                                  │  broker policy decision, constraints, audit
                                  ├──> ModbusScadaProvider ──MCP──> slot "bench-motor01" (mcp-modbus, C++)
                                  └──> (OpcUaScadaProvider)  ──MCP──> slot "opcua-line1"
```

The invariant, from the [architecture brief](docs/brief_architecture_mcp_scada_v1.md):

```text
UNS          = identity
SCADA v1     = functional abstraction
Provider     = protocol binding
MCP Broker   = policy authority
```

Read [docs/validation-architecture-v1.md](docs/validation-architecture-v1.md) for how the brief maps onto the existing broker, what had to change, and the open alignment points.

## Use

```ts
import { BrokerPolicyGate, ModbusScadaProvider, ScadaService, ScadaBehavior } from "@cyanmycelium/mcp-scada";

// The same `auth` section as the broker's config.json, with scada.* capabilities.
const policy = BrokerPolicyGate.fromBrokerAuthConfig(brokerConfig.auth);
const scada = new ScadaService({ policy, resources: { "uns://plant/line1/motor01/speed_sp": { constraints: { minValue: 0, maxValue: 1500 } } } });

await scada.registerProviderAsync(
    new ModbusScadaProvider({ id: "modbus-line1", client: modbusSlotClient, root: "uns://plant/line1", source: "device" }),
    "uns://plant/line1"
);

const { items } = await scada.readAsync(actor, { ids: ["uns://plant/line1/motor01/speed"], destination: "source" });
```

Publish it as a slot with `new ScadaBehavior(scada, actorResolver)` on an `McpServerBuilder`. Tools: `scada.capabilities`, `scada.browse`, `scada.read`, `scada.write`, `scada.invoke`.

### Policy mapping

| SCADA | Broker `authorize()` |
|---|---|
| actor subjects | `subject.ids` |
| operation class | capability `scada.observe`, `scada.acquire`, `scada.control`, `scada.execute` |
| UNS `uns://a/b/c` | resource path `/a/b/c` |

A read of the mcp-scada cache (`local`) is `observe`; any read that may go downstream is `acquire`.

## Tests

```bash
npm test
```

Conformance tests of the brief (section 13) against a simulated provider and the real broker policy engine.

```bash
npm run test:live
```

The same contract against the live Modbus chain: pyModbusTCP simulator, embedded broker, C++ `mcp_modbus_provider`. See [test-bench/README.md](test-bench/README.md).
