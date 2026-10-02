import { redact } from "../audit/audit";
import { ScadaError } from "../contract/scada.provider";
import type { Destination } from "../contract/scada.types";
import { capabilityOf } from "../policy/operation.class";
import type { IScadaConstraints, IScadaDecision, IScadaPolicyContext, IScadaPolicyGate } from "../policy/policy.types";
import { UnsPath } from "@cyanmycelium/mcp-uns";
import { BrokerRpcError, type IAuthorizeCheck, type IBrokerChannel, type IBrokerDecision, type IDeclareParams, type IDeclareResult } from "./broker.protocol";

export interface IBrokerDecisionClientOptions {
    /** Checks per `broker/authorize` request; larger batches are split. */
    readonly maxChecksPerRequest?: number;
    /**
     * Gives up on a declaration that gets no answer. Off by default: a broker
     * from 1.4.1 answers every provider request at once, and the normal path
     * must never depend on a deadline. Set it only for an older broker.
     */
    readonly declareTimeoutMs?: number;
}

type DeclarationState =
    { readonly status: "pending" } | { readonly status: "accepted"; readonly result: IDeclareResult } | { readonly status: "refused"; readonly problems: readonly string[] };

/**
 * mcp-scada's policy gate when the MCP Broker is the decision point.
 *
 * It holds no policy. It declares the SCADA domain once, then forwards each
 * question to `broker/authorize` with the caller handle the broker gave, and
 * maps the answer onto a SCADA decision. Until the declaration is accepted,
 * and after it is refused, every question fails with
 * `authorization_unavailable`: mcp-scada serves nothing it cannot have
 * decided by the broker.
 */
export class BrokerDecisionClient implements IScadaPolicyGate {
    private readonly _channel: IBrokerChannel;
    private readonly _maxChecks: number;
    private readonly _declareTimeoutMs?: number;
    private _state: DeclarationState = { status: "pending" };

    constructor(channel: IBrokerChannel, options: IBrokerDecisionClientOptions = {}) {
        this._channel = channel;
        this._maxChecks = Math.max(1, options.maxChecksPerRequest ?? 100);
        this._declareTimeoutMs = options.declareTimeoutMs;
    }

    get declaration(): DeclarationState {
        return this._state;
    }

    /** Sends the declaration. Resolves when accepted; throws `authorization_unavailable` otherwise. */
    async declareAsync(params: IDeclareParams): Promise<IDeclareResult> {
        this._state = { status: "pending" };
        let result: IDeclareResult;
        try {
            result = await this._withOptionalTimeout(this._channel.declare(params));
        } catch (error) {
            if (error instanceof BrokerRpcError) {
                if (error.code === -32601) return this._refuse(["the broker does not implement broker/authorization/declare (broker 1.5.0 or later is required)"]);
                const listed = (error.data as { errors?: unknown } | undefined)?.errors;
                const problems = Array.isArray(listed) && listed.length > 0 ? listed.map(String) : [`the broker refused the declaration (${error.code}): ${error.message}`];
                return this._refuse(problems);
            }
            return this._refuse([`the declaration got no usable answer: ${error instanceof Error ? error.message : String(error)}`]);
        }
        if (!result?.accepted) return this._refuse(result?.problems?.length ? result.problems : ["the broker did not accept the declaration"]);
        this._state = { status: "accepted", result };
        return result;
    }

    async evaluate(context: IScadaPolicyContext): Promise<IScadaDecision> {
        const [decision] = await this.evaluateMany([context]);
        return decision;
    }

    async evaluateMany(contexts: readonly IScadaPolicyContext[]): Promise<readonly IScadaDecision[]> {
        if (this._state.status !== "accepted") {
            const why = this._state.status === "refused" ? this._state.problems.join("; ") : "the declaration has not been accepted yet";
            throw new ScadaError("authorization_unavailable", `MCP Broker authorization is unavailable: ${why}`);
        }

        const decisions: IScadaDecision[] = new Array(contexts.length);
        // Questions are grouped by principal: one request speaks for one caller.
        const groups = new Map<string, number[]>();
        contexts.forEach((context, index) => {
            const principal = context.actor.principal;
            if (!principal) {
                // No handle from the broker means no way to ask on anyone's
                // behalf. Never fall back to an identity of our own.
                decisions[index] = { decision: "deny", reason: "no-caller-reference" };
                return;
            }
            const key = principal.type === "caller-ref" ? `ref:${principal.ref}` : "provider";
            const bucket = groups.get(key);
            if (bucket) bucket.push(index);
            else groups.set(key, [index]);
        });

        for (const indices of groups.values()) {
            const first = contexts[indices[0]];
            for (let offset = 0; offset < indices.length; offset += this._maxChecks) {
                const slice = indices.slice(offset, offset + this._maxChecks);
                const result = await this._channel.authorize({
                    principal: first.actor.principal!,
                    correlationId: first.requestContext.correlationId,
                    checks: slice.map((index) => this._check(contexts[index])),
                });
                if (!Array.isArray(result?.decisions) || result.decisions.length !== slice.length) {
                    throw new Error(`broker/authorize answered ${result?.decisions?.length ?? 0} decisions for ${slice.length} checks`);
                }
                slice.forEach((index, position) => {
                    decisions[index] = this._map(result.decisions[position]);
                });
            }
        }
        return decisions;
    }

    private _check(context: IScadaPolicyContext): IAuthorizeCheck {
        const path = UnsPath.parse(context.resource);
        const attributes: Record<string, unknown> = { operation: context.operation, provider: context.provider };
        if (context.destination) attributes.destination = context.destination;
        if (context.consistency) attributes.consistency = context.consistency;
        if (context.effect) attributes.effect = context.effect;
        if (context.requestedValue !== undefined) attributes.requestedValue = redact(context.requestedValue);
        for (const [key, value] of Object.entries(context.plantContext ?? {})) attributes[`plant.${key}`] = value;
        return { capability: capabilityOf(context.operationClass), resource: path.id, resourcePath: path.resourcePath, attributes };
    }

    private _map(decision: IBrokerDecision): IScadaDecision {
        const effect = decision?.effect;
        if (effect !== "allow" && effect !== "deny" && effect !== "require-approval" && effect !== "allow-with-constraints") {
            // An effect we do not know is not an allow.
            return { decision: "deny", reason: `unrecognized-effect:${String(effect)}`, ...(decision?.decisionId ? { decisionId: decision.decisionId } : {}) };
        }
        const obligations = decision.obligations;
        const constraints: IScadaConstraints | undefined =
            obligations?.constraints || obligations?.notAfter
                ? {
                      ...(obligations.constraints?.minValue !== undefined ? { minValue: obligations.constraints.minValue } : {}),
                      ...(obligations.constraints?.maxValue !== undefined ? { maxValue: obligations.constraints.maxValue } : {}),
                      ...(obligations.constraints?.allowedValues ? { allowedValues: obligations.constraints.allowedValues } : {}),
                      ...(obligations.constraints?.destinations ? { destinations: obligations.constraints.destinations as Destination[] } : {}),
                      ...(obligations.notAfter ? { notAfter: obligations.notAfter } : {}),
                  }
                : undefined;
        // An allow that carries obligations is applied as constrained, whatever label it came with.
        const kind = effect === "allow" && constraints ? "allow-with-constraints" : effect;
        return {
            decision: kind,
            reason: decision.reason,
            decisionId: decision.decisionId,
            ...(decision.policies ? { policies: decision.policies } : {}),
            ...(constraints ? { constraints } : {}),
        };
    }

    private _refuse(problems: readonly string[]): never {
        this._state = { status: "refused", problems };
        throw new ScadaError("authorization_unavailable", `the MCP Broker did not accept the SCADA declaration: ${problems.join("; ")}`, { detail: { problems } });
    }

    private _withOptionalTimeout<T>(promise: Promise<T>): Promise<T> {
        const timeoutMs = this._declareTimeoutMs;
        if (timeoutMs === undefined) return promise;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }
}
