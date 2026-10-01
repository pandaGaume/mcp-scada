import type { BrokerPrincipal } from "../broker/broker.protocol";
import type { ConsistencyMode, Destination, Operation, OperationClass, ResourceEffect, UnsId } from "../contract/scada.types";

/**
 * Who an operation is for.
 *
 * With the broker as the only decision point, mcp-scada never knows the
 * caller's identity: it holds `principal`, the handle the broker gave it, and
 * hands it back with each question. `id` is a label for logs only.
 *
 * `subjects` serves the local `BrokerPolicyGate` only, the interim mode used
 * until the broker exposes `broker/authorize`. The broker decision client
 * never reads it and never sends it.
 */
export interface IScadaActor {
    readonly id: string;
    readonly subjects: readonly string[];
    readonly principal?: BrokerPrincipal;
    /** Correlation id the broker assigned to the request, when there is one. */
    readonly correlationId?: string;
}

/**
 * The industrial attributes mcp-scada hands to the MCP Broker for one
 * operation on one resource. It is an input to the broker's policy engine,
 * not a policy language of its own.
 */
export interface IScadaPolicyContext {
    readonly actor: IScadaActor;
    readonly operation: Operation;
    readonly operationClass: OperationClass;
    readonly resource: UnsId;
    readonly destination?: Destination;
    readonly consistency?: ConsistencyMode;
    readonly requestedValue?: unknown;
    readonly effect?: ResourceEffect;
    readonly provider: string;
    readonly plantContext?: Readonly<Record<string, string>>;
    readonly requestContext: { readonly correlationId: string };
}

/** Limits attached to an allow. Constraints only ever narrow. */
export interface IScadaConstraints {
    readonly minValue?: number;
    readonly maxValue?: number;
    readonly allowedValues?: readonly (string | number | boolean | null)[];
    readonly destinations?: readonly Destination[];
    /** ISO timestamp after which the decision no longer holds. */
    readonly notAfter?: string;
}

export type ScadaDecisionKind = "allow" | "deny" | "require-approval" | "allow-with-constraints";

export interface IScadaDecision {
    readonly decision: ScadaDecisionKind;
    /** Stable reason, e.g. the broker's `role-grant` or `explicit-deny`. */
    readonly reason: string;
    /** Broker policy ids that produced the decision. */
    readonly policies?: readonly string[];
    readonly constraints?: IScadaConstraints;
    /** Broker audit id of this decision; execution results are reported against it. */
    readonly decisionId?: string;
}

/**
 * The single enforcement point mcp-scada consults before any provider call.
 * The production implementation delegates to the MCP Broker policy engine.
 */
export interface IScadaPolicyGate {
    evaluate(context: IScadaPolicyContext): IScadaDecision | Promise<IScadaDecision>;
    /**
     * Several questions at once, answered in order. A browse asks one per
     * node; a remote decision point answers them in one round trip.
     */
    evaluateMany?(contexts: readonly IScadaPolicyContext[]): readonly IScadaDecision[] | Promise<readonly IScadaDecision[]>;
}
