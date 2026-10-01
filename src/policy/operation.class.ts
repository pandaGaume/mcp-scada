import type { ConsistencyMode, Destination, Operation, OperationClass } from "../contract/scada.types";

/**
 * Classifies an operation for policy evaluation.
 *
 * A read is `observe` only when it is guaranteed to cause no downstream
 * traffic: the mcp-scada cache, or a provider cache read with `cached`
 * consistency. Every other read may reach a gateway or the source and is
 * `acquire`, which is what lets a policy rate-limit or refuse forced reads
 * without touching plain observation.
 */
export function classifyOperation(operation: Operation, destination?: Destination, consistency?: ConsistencyMode): OperationClass {
    switch (operation) {
        case "browse":
            return "observe";
        case "read":
        case "subscribe":
            if (destination === "local") return "observe";
            if (destination === "provider" && consistency === "cached") return "observe";
            return "acquire";
        case "write":
            return "control";
        case "invoke":
            return "execute";
    }
}

/** The broker capability evaluated for a class, e.g. `scada.control`. */
export function capabilityOf(operationClass: OperationClass, prefix = "scada"): string {
    return `${prefix}.${operationClass}`;
}
