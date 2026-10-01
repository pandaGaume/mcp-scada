import type { ConsistencyMode, Destination, Operation, OperationClass, ResourceEffect, UnsId } from "../contract/scada.types";

/**
 * Who is calling, as canonical MCP Broker subjects (`user:alice`,
 * `group:maintenance-area-a`, `client:assistant`, `service:mcp-scada`).
 * Subjects come from a validated identity, never from request arguments.
 */
export interface IScadaActor {
    readonly id: string;
    readonly subjects: readonly string[];
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
    readonly allowedValues?: readonly unknown[];
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
}

/**
 * The single enforcement point mcp-scada consults before any provider call.
 * The production implementation delegates to the MCP Broker policy engine.
 */
export interface IScadaPolicyGate {
    evaluate(context: IScadaPolicyContext): IScadaDecision | Promise<IScadaDecision>;
}
