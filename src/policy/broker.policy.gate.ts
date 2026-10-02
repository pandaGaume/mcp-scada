import {
    ResourcePath,
    compileAuthorizationPolicy,
    type IAuthorizationAuditEvent,
    type IAuthorizationDecision,
    type IAuthorizationPolicyConfig,
    type IAuthorizationRequest,
    type IAuthorizationSubject,
    type IPolicyEngine,
} from "@cyanmycelium/mcp-broker";
import { UnsPath } from "@cyanmycelium/mcp-uns";
import { capabilityOf } from "./operation.class";
import type { IScadaDecision, IScadaPolicyContext, IScadaPolicyGate } from "./policy.types";

interface IAuditFields {
    readonly subject: IAuthorizationSubject;
    readonly slot: string;
    readonly resource?: ResourcePath;
    readonly capability: string;
    readonly provider: string;
    readonly tool: string;
}

// Same shape and sink as the broker's own `makeAuthorizationAuditEvent` /
// `writeAuthorizationAuditEvent`, which the package does not export from its
// root in 1.4.0. SCADA decisions land in the broker's audit stream, not in a
// second one.
function makeAuditEvent(fields: IAuditFields, decision: IAuthorizationDecision): IAuthorizationAuditEvent {
    const clientId = fields.subject.ids.find((id) => id.startsWith("client:"))?.slice("client:".length);
    return {
        timestamp: new Date().toISOString(),
        allowed: decision.allowed,
        subjectIds: fields.subject.ids,
        clientId,
        slot: fields.slot,
        resource: fields.resource?.value,
        capability: fields.capability,
        provider: fields.provider,
        tool: fields.tool,
        reason: decision.reason,
        matchedPolicies: decision.matchedPolicies,
    };
}

function writeBrokerAuditEvent(event: IAuthorizationAuditEvent): void {
    console.error(`[broker] authorization ${JSON.stringify(event)}`);
}

export interface IBrokerPolicyGateOptions {
    /** Capability prefix; `scada` yields `scada.observe`, `scada.control`, ... */
    readonly capabilityPrefix?: string;
    /** Slot name written in the broker audit events. */
    readonly slot?: string;
    /** Mirror of the broker's `auth.audit.logAllowed`. Denies are always written. */
    readonly logAllowed?: boolean;
    /** Where broker authorization events go; the broker's own writer by default. */
    readonly auditWriter?: (event: IAuthorizationAuditEvent) => void;
}

/**
 * Translates a SCADA policy context into an MCP Broker authorization request
 * and asks the broker's policy engine. This is the `PolicyContextMapper` of
 * the architecture brief: it owns no rule, no rule store and no language.
 *
 * The mapping:
 *
 * - subject    the actor's canonical subjects, unchanged;
 * - capability `scada.<operation class>` (`observe`, `acquire`, `control`, `execute`);
 * - resource   the UNS path, `uns://a/b/c` becoming `/a/b/c`;
 * - provider   the SCADA provider id; tool: the SCADA operation.
 *
 * The broker engine answers allow or deny. It has no notion of approval or
 * value constraints today, so this gate never produces `require-approval` or
 * `allow-with-constraints` on its own; see docs/validation-architecture-v1.md.
 */
export class BrokerPolicyGate implements IScadaPolicyGate {
    private readonly _engine: IPolicyEngine;
    private readonly _prefix: string;
    private readonly _slot: string;
    private readonly _logAllowed: boolean;
    private readonly _write: (event: IAuthorizationAuditEvent) => void;

    constructor(engine: IPolicyEngine, options: IBrokerPolicyGateOptions = {}) {
        this._engine = engine;
        this._prefix = options.capabilityPrefix ?? "scada";
        this._slot = options.slot ?? "scada";
        this._logAllowed = options.logAllowed ?? false;
        this._write = options.auditWriter ?? writeBrokerAuditEvent;
    }

    /** Compiles the same `auth` section the broker reads from its config.json. */
    static fromBrokerAuthConfig(config: IAuthorizationPolicyConfig, options: IBrokerPolicyGateOptions = {}): BrokerPolicyGate {
        const runtime = compileAuthorizationPolicy(config);
        return new BrokerPolicyGate(runtime.engine, { logAllowed: runtime.audit.logAllowed, ...options });
    }

    evaluate(context: IScadaPolicyContext): IScadaDecision {
        const path = ResourcePath.tryParse(UnsPath.tryParse(context.resource)?.resourcePath ?? "");
        const subject = { ids: context.actor.subjects };
        const capability = capabilityOf(context.operationClass, this._prefix);
        if (!path) {
            this._write(
                makeAuditEvent({ subject, slot: this._slot, capability, provider: context.provider, tool: context.operation }, { allowed: false, reason: "invalid-resource" })
            );
            return { decision: "deny", reason: "invalid-resource" };
        }

        const request: IAuthorizationRequest = { subject, capability, resource: path, provider: context.provider, tool: context.operation };
        let outcome: IAuthorizationDecision;
        try {
            outcome = this._engine.authorize(request);
        } catch {
            outcome = { allowed: false, reason: "evaluation-error" };
        }
        if (!outcome.allowed || this._logAllowed) {
            this._write(makeAuditEvent({ subject, slot: this._slot, resource: path, capability, provider: context.provider, tool: context.operation }, outcome));
        }
        return {
            decision: outcome.allowed ? "allow" : "deny",
            reason: outcome.reason,
            ...(outcome.matchedPolicies ? { policies: outcome.matchedPolicies } : {}),
        };
    }
}
