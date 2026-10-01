import { ResourcePath, ResourcePathPattern, compileAuthorizationPolicy, type IAuthorizationPolicyConfig, type IPolicyEngine } from "@cyanmycelium/mcp-broker";
import {
    BrokerRpcError,
    type IAuditResultParams,
    type IAuthorizeCheck,
    type IAuthorizeParams,
    type IAuthorizeResult,
    type IBrokerChannel,
    type IBrokerDecision,
    type IBrokerObligations,
    type IDeclareParams,
    type IDeclareResult,
} from "../src/broker/broker.protocol";

export interface IFakeBrokerOptions {
    readonly auth: IAuthorizationPolicyConfig;
    /** `allowedResources` of mcp-scada's provider principal. */
    readonly allowedResources?: readonly string[];
    /** `subjects` of mcp-scada's provider principal. */
    readonly providerSubjects?: readonly string[];
    /** `protectedSlots` of the broker security file, `declaredBy` this provider. */
    readonly protectedSlots?: readonly string[];
    /** `implemented`: a 1.5.0 broker; `unsupported`: 1.4.1 (answers -32601); `silent`: 1.4.0 (never answers). */
    readonly mode?: "implemented" | "unsupported" | "silent";
    /** Assignment obligations, which the 1.4.0 engine cannot express yet (E4). */
    readonly obligations?: (check: IAuthorizeCheck, subjects: readonly string[]) => (IBrokerObligations & { requireApproval?: boolean }) | undefined;
}

/**
 * A stand-in for the MCP Broker 1.5.0 side of `broker/*`, written from
 * docs/brief_evolution_mcp_broker_scada.md. Decisions come from the real
 * `ConfigPolicyEngine` of `@cyanmycelium/mcp-broker`; everything around it
 * (declaration checks, caller handles, obligations, audit) follows the brief.
 */
export class FakeBroker implements IBrokerChannel {
    readonly authorizeCalls: IAuthorizeParams[] = [];
    readonly results: IAuditResultParams[] = [];
    readonly decisions: (IBrokerDecision & { subjects: readonly string[]; resource: string })[] = [];
    private readonly _engine: IPolicyEngine;
    private readonly _refs = new Map<string, readonly string[]>();
    private _declaration?: IDeclareParams;
    private _nextRef = 1;
    private _nextDecision = 1;

    constructor(private readonly _options: IFakeBrokerOptions) {
        this._engine = compileAuthorizationPolicy(_options.auth).engine;
    }

    /** What the broker does when it forwards a client request: a handle bound to that request. */
    issueRef(subjects: readonly string[]): string {
        const ref = `cr_${(this._nextRef++).toString(16).padStart(8, "0")}`;
        this._refs.set(ref, subjects);
        return ref;
    }

    /** The provider answered: the handle dies with the request. */
    revokeRef(ref: string): void {
        this._refs.delete(ref);
    }

    async declare(params: IDeclareParams): Promise<IDeclareResult> {
        if (this._options.mode === "unsupported")
            throw new BrokerRpcError(-32601, "Method not found: the broker does not relay requests opened by a provider (broker/authorization/declare)");
        if (this._options.mode === "silent") return new Promise<IDeclareResult>(() => {});

        const problems: string[] = [];
        for (const key of ["assignments", "roles", "denies"]) if (key in (params as unknown as Record<string, unknown>)) problems.push(`"${key}" cannot be declared by a provider`);
        for (const capability of params.capabilities)
            if (capability === "*" || !capability.startsWith(`${params.domain}.`)) problems.push(`capability "${capability}" is outside the domain "${params.domain}"`);
        const namespace = ResourcePath.tryParse(params.namespace?.resource ?? "");
        if (!namespace) problems.push("namespace.resource is not a resource path");
        else if (!(this._options.allowedResources ?? ["/**"]).some((pattern) => ResourcePathPattern.parse(pattern).matches(namespace))) {
            problems.push(`namespace ${namespace.value} is outside the provider's allowedResources`);
        }
        for (const resource of params.resources) {
            const path = ResourcePath.tryParse(resource.resourcePath);
            if (!path || !namespace || !ResourcePathPattern.parse(`${namespace.value}/**`).matches(path))
                problems.push(`resource ${resource.resource} has a path outside the namespace`);
        }
        for (const slot of params.protects) if (!(this._options.protectedSlots ?? []).includes(slot)) problems.push(`slot "${slot}" is not in protectedSlots for this provider`);
        if (problems.length) return { accepted: false, problems };
        this._declaration = params;
        return { accepted: true, version: params.version, policyVersion: `policy-${params.version}` };
    }

    async authorize(params: IAuthorizeParams): Promise<IAuthorizeResult> {
        this.authorizeCalls.push(JSON.parse(JSON.stringify(params)));
        if (!this._declaration) throw new BrokerRpcError(-32003, "no accepted declaration for this provider");
        const principal = params.principal as unknown as Record<string, unknown>;
        const keys = Object.keys(principal ?? {})
            .sort()
            .join(",");
        let subjects: readonly string[];
        if (principal?.type === "caller-ref" && keys === "ref,type" && typeof principal.ref === "string") {
            const known = this._refs.get(principal.ref);
            if (!known) throw new BrokerRpcError(-32602, "unknown or expired caller reference");
            subjects = known;
        } else if (principal?.type === "provider" && keys === "type") {
            subjects = this._options.providerSubjects ?? [];
        } else {
            throw new BrokerRpcError(-32602, "invalid principal");
        }

        const declaration = this._declaration;
        const namespace = ResourcePathPattern.parse(`${declaration.namespace.resource}/**`);
        const decisions = params.checks.map((check): IBrokerDecision => {
            const decisionId = `dec_${this._nextDecision++}`;
            const record = (decision: IBrokerDecision) => {
                this.decisions.push({ ...decision, subjects, resource: check.resource });
                return decision;
            };
            const path = ResourcePath.tryParse(check.resourcePath);
            if (!path || !namespace.matches(path)) return record({ decisionId, effect: "deny", reason: "undeclared-resource" });
            if (!declaration.capabilities.includes(check.capability)) return record({ decisionId, effect: "deny", reason: "undeclared-capability" });
            const declared = declaration.resources.find((resource) => resource.resource === check.resource);
            if (declared && declared.resourcePath !== check.resourcePath) return record({ decisionId, effect: "deny", reason: "undeclared-resource" });

            const outcome = this._engine.authorize({ subject: { ids: subjects }, capability: check.capability, resource: path });
            if (!outcome.allowed) return record({ decisionId, effect: "deny", reason: outcome.reason, policies: outcome.matchedPolicies });

            const extra = this._options.obligations?.(check, subjects);
            if (extra?.requireApproval) return record({ decisionId, effect: "require-approval", reason: "approval-required", policies: outcome.matchedPolicies });
            const limits = declared?.limits;
            const min = [extra?.constraints?.minValue, limits?.minValue].filter((v): v is number => v !== undefined);
            const max = [extra?.constraints?.maxValue, limits?.maxValue].filter((v): v is number => v !== undefined);
            const constraints = {
                ...(min.length ? { minValue: Math.max(...min) } : {}),
                ...(max.length ? { maxValue: Math.min(...max) } : {}),
            };
            const obligations: IBrokerObligations | undefined =
                Object.keys(constraints).length || extra?.notAfter
                    ? { ...(Object.keys(constraints).length ? { constraints } : {}), ...(extra?.notAfter ? { notAfter: extra.notAfter } : {}) }
                    : undefined;
            return record({
                decisionId,
                effect: obligations ? "allow-with-constraints" : "allow",
                reason: "role-grant",
                policies: outcome.matchedPolicies,
                ...(obligations ? { obligations } : {}),
            });
        });
        return { policyVersion: `policy-${declaration.version}`, decisions };
    }

    reportResult(params: IAuditResultParams): void {
        this.results.push(params);
    }
}
