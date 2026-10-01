import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../src/audit/audit";
import { BrokerAuditReporter } from "../src/broker/broker.audit.reporter";
import { BrokerDecisionClient } from "../src/broker/broker.decision.client";
import { CALLER_META_KEY, readCallerMeta, type IBrokerChannel } from "../src/broker/broker.protocol";
import { buildScadaDeclaration } from "../src/broker/declaration";
import { isItemError, type IScadaValue } from "../src/contract/scada.types";
import type { IScadaActor } from "../src/policy/policy.types";
import { ScadaService, type IScadaServiceOptions } from "../src/scada.service";
import { ScadaBehavior, brokerCallerResolver } from "../src/server/scada.behavior";
import { FakeBroker, type IFakeBrokerOptions } from "./fake.broker";
import { FakeProvider, ROOT, SETPOINT, SPEED, brokerAuth } from "./helpers";

const NAMESPACE = "uns://production/site1";

async function setup(brokerOptions: Partial<IFakeBrokerOptions> = {}, serviceOptions: Partial<IScadaServiceOptions> = {}, clientOptions = {}) {
    const broker = new FakeBroker({
        auth: brokerAuth,
        allowedResources: ["/production/**"],
        providerSubjects: ["service:mcp-scada"],
        protectedSlots: ["bench-motor01"],
        ...brokerOptions,
    });
    const gate = new BrokerDecisionClient(broker, clientOptions);
    const local = new MemoryAuditSink();
    const provider = new FakeProvider();
    const service = new ScadaService({
        policy: gate,
        audit: new BrokerAuditReporter(broker, local),
        resources: { [SETPOINT]: { effect: "physical-action", constraints: { minValue: 0, maxValue: 1500 } } },
        ...serviceOptions,
    });
    await service.registerProviderAsync(provider, ROOT);
    return { broker, gate, service, provider, local };
}

/** What a request forwarded by the broker looks like from mcp-scada: a handle, never an identity. */
function callerFor(broker: FakeBroker, subjects: string[]): IScadaActor {
    const ref = broker.issueRef(subjects);
    return { id: `caller-ref:${ref}`, subjects: [], principal: { type: "caller-ref", ref }, correlationId: `corr-${ref}` };
}

const declare = (service: ScadaService, gate: BrokerDecisionClient) =>
    gate.declareAsync(service.buildDeclaration({ version: "2026-10-01.1", namespace: NAMESPACE, protects: ["bench-motor01"] }));

describe("E1 declaration", () => {
    it("is descriptive: namespace, capabilities, both identifiers, limits, protected slots, and no grant", async () => {
        const { service } = await setup();
        const declaration = service.buildDeclaration({ version: "v1", namespace: NAMESPACE, protects: ["bench-motor01", "bench-motor01"] });
        expect(declaration).toEqual({
            version: "v1",
            domain: "scada",
            namespace: { resource: "/production/site1" },
            capabilities: ["scada.observe", "scada.acquire", "scada.control", "scada.execute"],
            resources: [{ resource: SETPOINT, resourcePath: "/production/site1/line1/motor01/speed-setpoint", effect: "physical-action", limits: { minValue: 0, maxValue: 1500 } }],
            protects: ["bench-motor01"],
            resultsRequired: ["scada.control", "scada.execute"],
        });
        expect(Object.keys(declaration)).not.toEqual(expect.arrayContaining(["assignments"]));
    });

    it("is refused locally when a provider root or a resource lies outside the namespace", () => {
        expect(() => buildScadaDeclaration({ version: "v1", namespace: "uns://production/site2", roots: [ROOT] })).toThrow(/outside the namespace/);
        expect(() => buildScadaDeclaration({ version: "v1", namespace: NAMESPACE, roots: [], resources: { "uns://elsewhere/x": {} } })).toThrow(/outside the namespace/);
        expect(() => buildScadaDeclaration({ version: "v1", namespace: NAMESPACE, roots: [], protects: ["_all"] })).toThrow(/cannot be protected/);
    });

    it("serves nothing before the broker accepts it, without asking the broker or calling a provider", async () => {
        const { broker, service, provider } = await setup();
        const operator = callerFor(broker, ["group:operators"]);
        const read = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        const write = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 10 }], destination: "source" });
        expect(read.items[0]).toMatchObject({ error: { code: "authorization_unavailable" } });
        expect(write.items[0]).toMatchObject({ error: { code: "authorization_unavailable" } });
        expect(broker.authorizeCalls).toHaveLength(0);
        expect(provider.calls).toHaveLength(0);
    });

    it("fails closed at once on a broker without broker/* (1.4.1 answers -32601)", async () => {
        const { broker, gate, service, provider } = await setup({ mode: "unsupported" });
        const started = Date.now();
        await expect(declare(service, gate)).rejects.toMatchObject({ code: "authorization_unavailable", message: expect.stringMatching(/1\.5\.0 or later/) });
        expect(Date.now() - started).toBeLessThan(100);
        expect(gate.declaration.status).toBe("refused");
        const read = await service.readAsync(callerFor(broker, ["group:operators"]), { ids: [SPEED], destination: "source" });
        expect(read.items[0]).toMatchObject({ error: { code: "authorization_unavailable" } });
        expect(provider.calls).toHaveLength(0);
    });

    it("fails closed when the broker refuses the declaration, with its problems", async () => {
        const { gate, service } = await setup({ protectedSlots: [] });
        await expect(declare(service, gate)).rejects.toMatchObject({ code: "authorization_unavailable", detail: { problems: [expect.stringMatching(/bench-motor01/)] } });
    });

    it("waits on a silent broker by default, and gives up only with an explicit timeout", async () => {
        const silent = await setup({ mode: "silent" });
        const outcome = await Promise.race([
            declare(silent.service, silent.gate).then(
                () => "answered",
                () => "refused"
            ),
            new Promise((r) => setTimeout(() => r("still waiting"), 50)),
        ]);
        expect(outcome).toBe("still waiting");

        const bounded = await setup({ mode: "silent" }, {}, { declareTimeoutMs: 20 });
        await expect(declare(bounded.service, bounded.gate)).rejects.toMatchObject({ code: "authorization_unavailable", message: expect.stringMatching(/no answer within 20 ms/) });
    });
});

describe("E2/E3 decisions asked to the broker", () => {
    it("sends the caller handle, never an identity, and executes on an allow", async () => {
        const { broker, gate, service, provider } = await setup();
        await declare(service, gate);
        const operator = callerFor(broker, ["user:alice", "group:operators"]);
        const result = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect((result.items[0] as IScadaValue).value).toBe(1450);
        expect(provider.calls.map((c) => c.op)).toEqual(["read"]);
        const [call] = broker.authorizeCalls;
        expect(call.principal).toEqual({ type: "caller-ref", ref: operator.principal && "ref" in operator.principal ? operator.principal.ref : "" });
        expect(call.correlationId).toBe(operator.correlationId);
        expect(call.checks).toEqual([
            {
                capability: "scada.acquire",
                resource: SPEED,
                resourcePath: "/production/site1/line1/motor01/speed",
                attributes: { operation: "read", provider: "fake-line1", destination: "source", consistency: "source", effect: "observation" },
            },
        ]);
        expect(JSON.stringify(broker.authorizeCalls)).not.toMatch(/alice|operators/);
    });

    it("denies with the broker's decision id and calls no provider", async () => {
        const { broker, gate, service, provider } = await setup();
        await declare(service, gate);
        const result = await service.readAsync(callerFor(broker, ["user:eve"]), { ids: [SPEED], destination: "source" });
        expect(result.items[0]).toMatchObject({ error: { code: "policy_denied", auditId: broker.decisions[0].decisionId, detail: { reason: "no-matching-grant" } } });
        expect(provider.calls).toHaveLength(0);
    });

    it("never asks on behalf of a request that carries no caller handle", async () => {
        const { broker, gate, service, provider } = await setup();
        await declare(service, gate);
        const result = await service.readAsync({ id: "anonymous", subjects: ["group:operators"] }, { ids: [SPEED], destination: "source" });
        expect(result.items[0]).toMatchObject({ error: { code: "policy_denied", detail: { reason: "no-caller-reference" } } });
        expect(broker.authorizeCalls).toHaveLength(0);
        expect(provider.calls).toHaveLength(0);
    });

    it("refuses once the handle has expired with its request", async () => {
        const { broker, gate, service, provider } = await setup();
        await declare(service, gate);
        const operator = callerFor(broker, ["group:operators"]);
        broker.revokeRef((operator.principal as { ref: string }).ref);
        const result = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(result.items[0]).toMatchObject({ error: { code: "policy_denied", detail: { reason: "evaluation-error" } } });
        expect(provider.calls).toHaveLength(0);
    });

    it("asks with the provider principal for the provider's own operations", async () => {
        const { broker, gate, service } = await setup({
            auth: { ...brokerAuth, assignments: [...brokerAuth.assignments, { id: "scada-service", subject: "service:mcp-scada", role: "acquirer", resource: "/production/**" }] },
        });
        await declare(service, gate);
        const result = await service.readAsync({ id: "mcp-scada", subjects: [], principal: { type: "provider" } }, { ids: [SPEED], destination: "source" });
        expect(isItemError(result.items[0])).toBe(false);
        expect(broker.authorizeCalls[0].principal).toEqual({ type: "provider" });
    });

    it("asks a whole browse in one request, and splits only past the batch limit", async () => {
        const one = await setup();
        await declare(one.service, one.gate);
        const nodes = await one.service.browseAsync(callerFor(one.broker, ["group:observers"]));
        expect(nodes.nodes).toHaveLength(3);
        expect(one.broker.authorizeCalls).toHaveLength(1);
        expect(one.broker.authorizeCalls[0].checks).toHaveLength(3);

        const split = await setup({}, {}, { maxChecksPerRequest: 2 });
        await declare(split.service, split.gate);
        await split.service.browseAsync(callerFor(split.broker, ["group:observers"]));
        expect(split.broker.authorizeCalls.map((c) => c.checks.length)).toEqual([2, 1]);
    });

    it("treats an unknown effect or a short answer as a deny", async () => {
        const unknown: IBrokerChannel = {
            declare: async () => ({ accepted: true }),
            authorize: async (p) => ({ decisions: p.checks.map(() => ({ decisionId: "d", effect: "permit" as never, reason: "?" })) }),
            reportResult: () => {},
        };
        const short: IBrokerChannel = { ...unknown, authorize: async () => ({ decisions: [] }) };
        for (const [channel, reason] of [
            [unknown, "unrecognized-effect:permit"],
            [short, "evaluation-error"],
        ] as const) {
            const gate = new BrokerDecisionClient(channel);
            const provider = new FakeProvider();
            const service = new ScadaService({ policy: gate, audit: new MemoryAuditSink() });
            await service.registerProviderAsync(provider, ROOT);
            await gate.declareAsync(service.buildDeclaration({ version: "v", namespace: NAMESPACE }));
            const r = await service.writeAsync(
                { id: "x", subjects: [], principal: { type: "caller-ref", ref: "cr_1" } },
                { items: [{ id: SETPOINT, value: 1 }], destination: "source" }
            );
            expect(r.items[0]).toMatchObject({ error: { code: "policy_denied", detail: { reason } } });
            expect(provider.calls).toHaveLength(0);
        }
    });
});

describe("E4 obligations and E5 audit", () => {
    it("applies the declared engineering limit returned in the decision, and reports results against the decision id", async () => {
        const { broker, gate, service, provider } = await setup();
        await declare(service, gate);
        const operator = callerFor(broker, ["group:operators"]);

        const high = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 2400 }], destination: "source" });
        expect(high.items[0]).toMatchObject({ error: { code: "constraint_violation", detail: { maxValue: 1500 } } });
        expect(provider.calls).toHaveLength(0);

        const ok = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1200 }], destination: "source" });
        expect(ok.items[0]).toMatchObject({ status: "success" });

        const [refused, accepted] = broker.decisions;
        expect(refused).toMatchObject({ effect: "allow-with-constraints", obligations: { constraints: { minValue: 0, maxValue: 1500 } } });
        expect(broker.results).toEqual([
            { decisionId: refused.decisionId, result: "refused", errorCode: "constraint_violation" },
            { decisionId: accepted.decisionId, result: "success", nativeStatus: "Good" },
        ]);
    });

    it("intersects an assignment constraint with the declared limit", async () => {
        const { broker, gate, service } = await setup({ obligations: () => ({ constraints: { maxValue: 3000, minValue: 100 } }) });
        await declare(service, gate);
        const operator = callerFor(broker, ["group:operators"]);
        const low = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 50 }], destination: "source" });
        const high = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 2000 }], destination: "source" });
        expect(low.items[0]).toMatchObject({ error: { code: "constraint_violation", detail: { constraint: "minValue" } } });
        expect(high.items[0]).toMatchObject({ error: { code: "constraint_violation", detail: { constraint: "maxValue" } } });
    });

    it("suspends on require-approval", async () => {
        const { broker, gate, service, provider } = await setup({ obligations: () => ({ requireApproval: true }) });
        await declare(service, gate);
        const r = await service.writeAsync(callerFor(broker, ["group:operators"]), { items: [{ id: SETPOINT, value: 10 }], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "approval_required" } });
        expect(provider.calls).toHaveLength(0);
        expect(broker.results).toEqual([{ decisionId: broker.decisions[0].decisionId, result: "refused", errorCode: "approval_required" }]);
    });

    it("reports every allowed read against its decision when reads are audited, failures included", async () => {
        const { broker, gate, service, provider } = await setup({}, { auditReads: true });
        await declare(service, gate);
        provider.values.delete(SETPOINT);
        await service.readAsync(callerFor(broker, ["group:operators"]), { ids: [SPEED, SETPOINT], destination: "source" });
        const [speed, setpoint] = broker.decisions;
        expect(broker.results).toEqual([
            { decisionId: speed.decisionId, result: "success" },
            { decisionId: setpoint.decisionId, result: "failure", errorCode: "unknown_resource" },
        ]);
    });

    it("never reports decisions again: the broker already recorded them", async () => {
        const { broker, gate, service, local } = await setup();
        await declare(service, gate);
        await service.readAsync(callerFor(broker, ["user:eve"]), { ids: [SPEED], destination: "source" });
        expect(local.records.map((r) => r.phase)).toEqual(["decision"]);
        expect(broker.results).toHaveLength(0);
    });
});

describe("caller handle in the MCP surface", () => {
    it("reads only a well-formed caller block", () => {
        expect(readCallerMeta({ [CALLER_META_KEY]: { ref: "cr_1", correlationId: "c" } })).toEqual({ ref: "cr_1", correlationId: "c" });
        expect(readCallerMeta({ [CALLER_META_KEY]: { ref: "" } })).toBeUndefined();
        expect(readCallerMeta({ [CALLER_META_KEY]: { ref: 42 } })).toBeUndefined();
        expect(readCallerMeta({ [CALLER_META_KEY]: ["cr_1"] })).toBeUndefined();
        expect(readCallerMeta({ caller: { ref: "cr_1" } })).toBeUndefined();
        expect(readCallerMeta(undefined)).toBeUndefined();
    });

    it("asks the broker with the handle from _meta, and its correlation id wins over the argument", async () => {
        const { broker, gate, service } = await setup();
        await declare(service, gate);
        const ref = broker.issueRef(["group:operators"]);
        const behavior = new ScadaBehavior(service, brokerCallerResolver());
        const result = await behavior.executeToolAsync(
            "",
            "scada.read",
            { ids: [SPEED], destination: "source", correlationId: "client-chosen" },
            { meta: { [CALLER_META_KEY]: { ref, correlationId: "req-7f31" } } }
        );
        expect(result.isError).toBeFalsy();
        expect(broker.authorizeCalls[0]).toMatchObject({ principal: { type: "caller-ref", ref }, correlationId: "req-7f31" });
    });

    it("refuses a request without a caller block, whatever its arguments claim", async () => {
        const { broker, gate, service, provider } = await setup();
        await declare(service, gate);
        const behavior = new ScadaBehavior(service, brokerCallerResolver());
        const result = await behavior.executeToolAsync("", "scada.read", { ids: [SPEED], destination: "source", principal: { type: "provider" }, subjects: ["group:operators"] });
        expect(result.structuredContent).toMatchObject({ items: [{ error: { code: "policy_denied", detail: { reason: "no-caller-reference" } } }] });
        expect(broker.authorizeCalls).toHaveLength(0);
        expect(provider.calls).toHaveLength(0);
    });
});
