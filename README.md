<p align="center">
  <img src="docs/assets/mcp-scada-logo.png" alt="mcp-scada pixel art logo: a supervision screen with a panda, linked to a Modbus device and an OPC UA server" width="320">
</p>

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

mcp-scada configures the broker, the broker decides, mcp-scada applies: see [docs/brief_evolution_mcp_broker_scada.md](docs/brief_evolution_mcp_broker_scada.md). Two modes exist while the broker side ships.

### Broker mode (target, needs broker 1.5.0)

```ts
import { BrokerAuditReporter, BrokerDecisionClient, ModbusScadaProvider, ScadaBehavior, ScadaService, brokerCallerResolver } from "@cyanmycelium/mcp-scada";

// `broker` is the provider's side channel: broker.declare / authorize / reportResult (mcp-broker-provider 0.3.0).
const policy = new BrokerDecisionClient(broker);
const scada = new ScadaService({
    policy,
    audit: new BrokerAuditReporter(broker),
    resources: { "uns://plant/line1/motor01/speed_sp": { effect: "physical-action", constraints: { minValue: 0, maxValue: 1500 } } },
});

await scada.registerProviderAsync(
    new ModbusScadaProvider({ id: "modbus-line1", client: modbusSlotClient, root: "uns://plant/line1", source: "device" }),
    "uns://plant/line1"
);

// Descriptive only: namespace, capabilities, effects and limits, protected slots. No grant.
await policy.declareAsync(scada.buildDeclaration({ version: "2026-10-01.1", namespace: "uns://plant", protects: ["modbus-line1"] }));

const behavior = new ScadaBehavior(scada, brokerCallerResolver());
```

- Every question goes to `broker/authorize` with the caller handle the broker wrote in `_meta["io.cyanmycelium/caller"]`; mcp-scada never sends an identity.
- Until the declaration is accepted, or once it is refused, every operation fails with `authorization_unavailable`. A broker without `broker/*` answers `-32601` at once (1.4.1), which is a refusal. No timeout is involved unless `declareTimeoutMs` is set explicitly.
- Execution results are reported with `broker/audit/result` against the broker's `decisionId`.
- Reading `_meta` needs an mcp-core that passes the request context to the adapter (1.4.0).

### Interim mode (broker 1.4.x)

```ts
const policy = BrokerPolicyGate.fromBrokerAuthConfig(brokerConfig.auth);
const scada = new ScadaService({ policy });
const behavior = new ScadaBehavior(scada, serviceActorResolver({ id: "mcp-scada", subjects: ["service:mcp-scada"] }));
```

`BrokerPolicyGate` compiles a copy of the broker's own policy engine and acts for one service actor. Bench or single-operator site only.

Tools: `scada.capabilities`, `scada.browse`, `scada.read`, `scada.write`, `scada.invoke`.

### Policy mapping

| SCADA | Broker |
|---|---|
| caller handle (`_meta`) | `principal: { type: "caller-ref", ref }` |
| operation class | capability `scada.observe`, `scada.acquire`, `scada.control`, `scada.execute` |
| UNS `uns://a/b/c` | `resource: "uns://a/b/c"`, `resourcePath: "/a/b/c"` |

A read of the mcp-scada cache (`local`) is `observe`; any read that may go downstream is `acquire`.

## Tests

```bash
npm test
```

Conformance tests of the brief (section 13) against a simulated provider and the real broker policy engine, and the broker mode against `tests/fake.broker.ts`, a stand-in for the `broker/*` side of broker 1.5.0 written from the evolution brief.

```bash
npm run test:live
```

The same contract against the live Modbus chain: pyModbusTCP simulator, embedded broker, C++ `mcp_modbus_provider`. See [test-bench/README.md](test-bench/README.md).
