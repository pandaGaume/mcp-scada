import { describe, expect, it } from "vitest";
import { validateCapabilities } from "../src/contract/capabilities";
import { isItemError, type IScadaValue } from "../src/contract/scada.types";
import type { IScadaPolicyGate } from "../src/policy/policy.types";
import { ScadaService } from "../src/scada.service";
import { FakeProvider, FURNACE, ROOT, SETPOINT, SPEED, makeService, observer, operator, stranger } from "./helpers";

// One `describe` per conformance test of the architecture brief, section 13.

describe("§13.1 a provider cannot register a destination it cannot distinguish", () => {
    it("refuses `local`, a cache level without a cache, and a level other than its source", async () => {
        const liar = new FakeProvider("liar", {
            source: "gateway",
            cachePolicy: { mode: "none" },
            capabilities: {
                browse: { supported: true },
                read: { destinations: ["local", "provider", "device", "source"], consistency: ["cached", "source"] },
                write: { supported: false },
                invoke: { supported: false },
                subscribe: { supported: false },
            },
        });
        const problems = validateCapabilities("liar", await liar.getCapabilitiesAsync());
        expect(problems.join("\n")).toMatch(/"local" is the mcp-scada cache/);
        expect(problems.join("\n")).toMatch(/"provider" requires a provider cache/);
        expect(problems.join("\n")).toMatch(/"device" is not distinguishable, the declared source level is "gateway"/);
        expect(problems.join("\n")).toMatch(/"cached" consistency requires a provider cache/);

        const service = new ScadaService({ policy: { evaluate: () => ({ decision: "allow", reason: "test" }) } });
        await expect(service.registerProviderAsync(liar, ROOT)).rejects.toThrow(/invalid capabilities/);
    });

    it("refuses a wrong interface version and a mismatched provider id", () => {
        const problems = validateCapabilities("a", { ...new FakeProvider("b").capabilities, interface: "scada.v0" as never });
        expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/interface must be "scada.v1"/), expect.stringMatching(/does not match the registered id "a"/)]));
    });

    it("refuses overlapping UNS roots", async () => {
        const { service } = await makeService();
        await expect(service.registerProviderAsync(new FakeProvider("other"), `${ROOT}/motor01`)).rejects.toThrow(/overlaps/);
    });
});

describe("§13.2 a `local` cached read produces no downstream traffic", () => {
    it("serves from the mcp-scada cache without calling the provider", async () => {
        const { service, provider } = await makeService();
        await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        const before = provider.calls.length;

        const result = await service.readAsync(observer, { ids: [SPEED], destination: "local" });
        expect(provider.calls.length).toBe(before);
        const value = result.items[0] as IScadaValue;
        expect(value.value).toBe(1450);
        expect(value.provenance).toMatchObject({ level: "local", cached: true });
    });

    it("answers cache_miss instead of going downstream, and honours max-age", async () => {
        const now = { t: 1_000 };
        const { service, provider } = await makeService({ now: () => now.t });
        const miss = await service.readAsync(operator, { ids: [SPEED], destination: "local" });
        expect(miss.items[0]).toMatchObject({ error: { code: "cache_miss" } });
        expect(provider.calls).toHaveLength(0);

        await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        now.t += 500;
        const stale = await service.readAsync(operator, { ids: [SPEED], destination: "local", consistency: { mode: "max-age", maxAgeMs: 100 } });
        expect(stale.items[0]).toMatchObject({ error: { code: "cache_miss" } });
        const ok = await service.readAsync(operator, { ids: [SPEED], destination: "local", consistency: { mode: "max-age", maxAgeMs: 1000 } });
        expect(isItemError(ok.items[0])).toBe(false);
    });
});

describe("§13.3 a source read respects the acquire limits", () => {
    it("refuses reads beyond the concurrency bound with rate_limited, never queues them", async () => {
        const provider = new FakeProvider();
        provider.readDelayMs = 30;
        const { service } = await makeService({ acquireLimits: { maxConcurrent: 1 } }, provider);
        const [first, second] = await Promise.all([
            service.readAsync(operator, { ids: [SPEED], destination: "source" }),
            service.readAsync(operator, { ids: [SPEED], destination: "source" }),
        ]);
        expect(isItemError(first.items[0])).toBe(false);
        expect(second.items[0]).toMatchObject({ error: { code: "rate_limited" } });
        expect(provider.calls.filter((c) => c.op === "read")).toHaveLength(1);
    });

    it("takes the stricter of the deployment and provider limits", async () => {
        const provider = new FakeProvider("strict", { limits: { maxAcquirePerSecond: 1 } });
        const { service } = await makeService({ acquireLimits: { maxPerSecond: 50 } }, provider);
        await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        const second = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(second.items[0]).toMatchObject({ error: { code: "rate_limited" } });
    });

    it("does not limit observation of the local cache", async () => {
        const { service } = await makeService({ acquireLimits: { maxPerSecond: 1 } });
        await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        for (let i = 0; i < 5; i += 1) {
            const r = await service.readAsync(operator, { ids: [SPEED], destination: "local" });
            expect(isItemError(r.items[0])).toBe(false);
        }
    });
});

describe("§13.4 a deny causes no provider call", () => {
    it("denies an actor without grant, for read and for write", async () => {
        const { service, provider, audit } = await makeService();
        const read = await service.readAsync(stranger, { ids: [SPEED], destination: "source" });
        const write = await service.writeAsync(stranger, { items: [{ id: SETPOINT, value: 1000 }], destination: "source" });
        expect(read.items[0]).toMatchObject({ error: { code: "policy_denied" } });
        expect(write.items[0]).toMatchObject({ status: "failure", error: { code: "policy_denied" } });
        expect(provider.calls).toHaveLength(0);
        expect(audit.records.filter((r) => r.decision === "deny").length).toBeGreaterThanOrEqual(2);
    });

    it("applies an explicit broker deny over a role grant", async () => {
        const { service, provider } = await makeService();
        const result = await service.writeAsync(operator, { items: [{ id: FURNACE, value: 900 }], destination: "source" });
        expect(result.items[0]).toMatchObject({ error: { code: "policy_denied", detail: { reason: "explicit-deny" } } });
        expect(provider.calls).toHaveLength(0);
    });

    it("lets an observer read the cache but not force a source read", async () => {
        const { service, provider } = await makeService();
        const forced = await service.readAsync(observer, { ids: [SPEED], destination: "source" });
        expect(forced.items[0]).toMatchObject({ error: { code: "policy_denied" } });
        expect(provider.calls).toHaveLength(0);
    });

    it("treats a failing or unknown policy answer as a deny", async () => {
        const throwing: IScadaPolicyGate = {
            evaluate: () => {
                throw new Error("engine down");
            },
        };
        const weird: IScadaPolicyGate = { evaluate: () => ({ decision: "maybe" as never, reason: "?" }) };
        for (const policy of [throwing, weird]) {
            const { service, provider } = await makeService({ policy });
            const r = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 10 }], destination: "source" });
            expect(r.items[0]).toMatchObject({ error: { code: "policy_denied" } });
            expect(provider.calls).toHaveLength(0);
        }
    });

    it("suspends on require-approval without calling the provider", async () => {
        const { service, provider } = await makeService({ policy: { evaluate: () => ({ decision: "require-approval", reason: "two-person-rule" }) } });
        const r = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 10 }], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "approval_required" } });
        expect(provider.calls).toHaveLength(0);
    });
});

describe("§13.5 a value constraint is applied right before execution", () => {
    it("refuses a write outside the approved SCADA range, after an allow", async () => {
        const { service, provider, audit } = await makeService({ resources: { [SETPOINT]: { constraints: { minValue: 0, maxValue: 1500 } } } });
        const r = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 2400 }], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "constraint_violation", detail: { constraint: "maxValue", maxValue: 1500 } } });
        expect(provider.calls).toHaveLength(0);
        expect(audit.records.map((x) => [x.phase, x.decision, x.result])).toEqual([
            ["decision", "allow", undefined],
            ["result", "allow", "refused"],
        ]);

        const ok = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1200 }], destination: "source" });
        expect(ok.items[0]).toMatchObject({ status: "success" });
    });

    it("intersects broker constraints with the approved configuration (constraints only narrow)", async () => {
        const policy: IScadaPolicyGate = { evaluate: () => ({ decision: "allow-with-constraints", reason: "t", constraints: { maxValue: 3000, minValue: 100 } }) };
        const { service, provider } = await makeService({ policy, resources: { [SETPOINT]: { constraints: { maxValue: 1500 } } } });
        const high = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 2000 }], destination: "source" });
        const low = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 50 }], destination: "source" });
        expect(high.items[0]).toMatchObject({ error: { code: "constraint_violation" } });
        expect(low.items[0]).toMatchObject({ error: { code: "constraint_violation" } });
        expect(provider.calls).toHaveLength(0);
    });

    it("refuses an expired decision", async () => {
        const policy: IScadaPolicyGate = { evaluate: () => ({ decision: "allow-with-constraints", reason: "t", constraints: { notAfter: "2000-01-01T00:00:00Z" } }) };
        const { service, provider } = await makeService({ policy });
        const r = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1 }], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "constraint_violation", detail: { constraint: "notAfter" } } });
        expect(provider.calls).toHaveLength(0);
    });
});

describe("§13.6 the audit links request, decision, execution and native result", () => {
    it("writes a decision record before execution and a result record after, under one correlation id", async () => {
        const { service, audit, brokerEvents } = await makeService();
        await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1200 }], destination: "source" }, { correlationId: "req-7f31" });
        const trail = audit.byCorrelation("req-7f31");
        expect(trail).toHaveLength(2);
        expect(trail[0]).toMatchObject({
            phase: "decision",
            actor: "alice",
            operation: "write",
            operationClass: "control",
            resource: SETPOINT,
            destination: "source",
            requested: 1200,
            decision: "allow",
            reason: "role-grant",
            policies: ["operators-line1"],
        });
        expect(trail[1]).toMatchObject({ phase: "result", result: "success", nativeStatus: "Good", policies: ["operators-line1"] });
        expect(brokerEvents).toHaveLength(0); // broker logs allows only with logAllowed
    });

    it("sends denies to the broker's own audit stream too", async () => {
        const { service, brokerEvents } = await makeService();
        await service.readAsync(stranger, { ids: [SPEED], destination: "source" });
        expect(brokerEvents).toEqual([
            expect.objectContaining({
                allowed: false,
                reason: "no-matching-grant",
                capability: "scada.acquire",
                resource: "/production/site1/line1/motor01/speed",
                provider: "fake-line1",
                tool: "read",
            }),
        ]);
    });

    it("redacts secrets from audited values", async () => {
        const { service, audit } = await makeService();
        await service.invokeAsync(operator, SETPOINT, { mode: "auto", password: "hunter2", nested: { apiToken: "x" } });
        const text = JSON.stringify(audit.records);
        expect(text).not.toContain("hunter2");
        expect(text).toContain("[redacted]");
    });
});

describe("§13.8 a provider cannot authorize itself through its own metadata", () => {
    it("filters browse by policy, whatever the node metadata says", async () => {
        const { service } = await makeService();
        expect((await service.browseAsync(stranger)).nodes).toHaveLength(0);
        const visible = await service.browseAsync(observer);
        expect(visible.nodes.map((n) => n.id).sort()).toEqual([FURNACE, SETPOINT, SPEED].sort());
    });

    it("ignores extra capability fields that claim authority", async () => {
        const provider = new FakeProvider("self-authorizing", { authorization: "allow-all", policy: { allow: "*" } } as never);
        const { service } = await makeService({}, provider);
        const r = await service.writeAsync(stranger, { items: [{ id: SETPOINT, value: 1 }], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "policy_denied" } });
        expect(provider.calls).toHaveLength(0);
    });
});

describe("§3.4 no silent downgrade", () => {
    it("requires a destination", async () => {
        const { service } = await makeService();
        await expect(service.readAsync(operator, { ids: [SPEED] } as never)).rejects.toMatchObject({ code: "invalid_request" });
    });

    it("refuses an unsupported destination without falling back", async () => {
        const { service, provider } = await makeService();
        const r = await service.readAsync(operator, { ids: [SPEED], destination: "controller" });
        expect(r.items[0]).toMatchObject({ error: { code: "unsupported_destination", detail: { supported: ["provider", "device", "source"] } } });
        expect(provider.calls).toHaveLength(0);
    });

    it("falls back only along an explicit ordered list, and says what it tried", async () => {
        const { service } = await makeService();
        const r = await service.readAsync(operator, { ids: [SPEED], destination: ["local", "controller", "device"] });
        expect(r.items[0]).toMatchObject({ value: 1450, provenance: { level: "device", cached: false } });

        const failed = await service.readAsync(observer, { ids: [SPEED], destination: ["controller", "source"] });
        expect(failed.items[0]).toMatchObject({
            error: {
                code: "policy_denied",
                detail: {
                    attempts: [
                        { destination: "controller", code: "unsupported_destination" },
                        { destination: "source", code: "policy_denied" },
                    ],
                },
            },
        });
    });

    it("rejects a cached value for a source read", async () => {
        const provider = new FakeProvider();
        provider.provenanceOverride = { cached: true, level: "provider", ageMs: 5000 };
        const { service } = await makeService({}, provider);
        const r = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "unsupported_consistency" } });
    });

    it("rejects a provider cache value older than max-age", async () => {
        const { service } = await makeService();
        const r = await service.readAsync(operator, { ids: [SPEED], destination: "provider", consistency: { mode: "max-age", maxAgeMs: 50 } });
        expect(r.items[0]).toMatchObject({ error: { code: "unsupported_consistency" } });
        const ok = await service.readAsync(observer, { ids: [SPEED], destination: "provider", consistency: { mode: "cached" } });
        expect(ok.items[0]).toMatchObject({ provenance: { level: "provider", cached: true, ageMs: 120 } });
    });

    it("reports provenance_unknown instead of inventing an origin", async () => {
        const provider = new FakeProvider();
        provider.provenanceOverride = null;
        const { service } = await makeService({}, provider);
        const r = await service.readAsync(operator, { ids: [SPEED], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "provenance_unknown" } });
    });

    it("never writes to the local cache and never falls back on writes", async () => {
        const { service } = await makeService();
        await expect(service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1 }], destination: "local" })).rejects.toMatchObject({ code: "unsupported_destination" });
        await expect(service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1 }], destination: ["device", "source"] as never })).rejects.toMatchObject({
            code: "invalid_request",
        });
    });

    it("refuses an unsupported capability before asking the policy", async () => {
        const provider = new FakeProvider("ro", {
            capabilities: { ...new FakeProvider().capabilities.capabilities, write: { supported: false }, invoke: { supported: false } },
        });
        let asked = 0;
        const { service } = await makeService({ policy: { evaluate: () => (asked++, { decision: "allow", reason: "t" }) } }, provider);
        const r = await service.writeAsync(operator, { items: [{ id: SETPOINT, value: 1 }], destination: "source" });
        expect(r.items[0]).toMatchObject({ error: { code: "unsupported_capability", detail: { capability: "write" } } });
        await expect(service.invokeAsync(operator, SETPOINT, {})).rejects.toMatchObject({ code: "unsupported_capability" });
        expect(asked).toBe(0);
    });

    it("rejects unknown UNS resources and malformed ids per item", async () => {
        const { service } = await makeService();
        const r = await service.readAsync(operator, { ids: ["uns://elsewhere/x", "not-a-uns-id", SPEED], destination: "source" });
        expect(r.items.map((i) => (isItemError(i) ? i.error.code : "ok"))).toEqual(["unknown_resource", "invalid_request", "ok"]);
    });
});
