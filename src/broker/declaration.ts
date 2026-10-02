import type { IScadaConstraints } from "../policy/policy.types";
import type { ResourceEffect, UnsId } from "../contract/scada.types";
import { UnsPath } from "@cyanmycelium/mcp-uns";
import type { IDeclareParams, IDeclaredResource } from "./broker.protocol";

export const SCADA_DOMAIN = "scada";
export const SCADA_CAPABILITIES = ["scada.observe", "scada.acquire", "scada.control", "scada.execute"] as const;

/** Mutations: the broker expects their outcome, and flags a decision left without one. */
export const SCADA_RESULTS_REQUIRED = ["scada.control", "scada.execute"] as const;

export interface IScadaDeclarationInput {
    /** Version string of this declaration; the broker echoes it back. */
    readonly version: string;
    /** UNS subtree the deployment serves; every provider root must sit inside it. */
    readonly namespace: UnsId;
    /** UNS roots of the registered providers. */
    readonly roots: readonly UnsId[];
    /** Effect and engineering limits per resource (approved SCADA configuration). */
    readonly resources?: Readonly<Record<UnsId, { readonly effect?: ResourceEffect; readonly constraints?: IScadaConstraints }>>;
    /** Protocol slots only mcp-scada may call; each must already be in the broker's `protectedSlots`. */
    readonly protects?: readonly string[];
}

/**
 * Builds the `broker/authorization/declare` payload.
 *
 * The declaration is descriptive: an address space, a capability vocabulary,
 * per-resource effects and engineering limits, and the slots to protect. It
 * never carries a role, an assignment or a deny, so mcp-scada cannot
 * authorize itself. Every resource is given in both forms, the native UNS id
 * and the resource path the broker evaluates; the broker translates nothing.
 *
 * Throws when the input is incoherent, so a bad declaration fails here, in
 * the deployment that wrote it, rather than as a refusal from the broker.
 */
export function buildScadaDeclaration(input: IScadaDeclarationInput): IDeclareParams {
    const problems: string[] = [];
    const namespace = UnsPath.tryParse(input.namespace);
    if (!namespace) throw new Error(`declaration: namespace "${input.namespace}" is not a UNS id`);
    if (!input.version) problems.push("version is required");

    for (const root of input.roots) {
        const path = UnsPath.tryParse(root);
        if (!path || !namespace.contains(path)) problems.push(`provider root ${root} is outside the namespace ${namespace.id}`);
    }

    const resources: IDeclaredResource[] = [];
    for (const [id, config] of Object.entries(input.resources ?? {})) {
        const path = UnsPath.tryParse(id);
        if (!path || !namespace.contains(path)) {
            problems.push(`resource ${id} is outside the namespace ${namespace.id}`);
            continue;
        }
        const constraints = config.constraints;
        // `notAfter` belongs to a decision, not to an engineering limit.
        const limits = constraints
            ? {
                  ...(constraints.minValue !== undefined ? { minValue: constraints.minValue } : {}),
                  ...(constraints.maxValue !== undefined ? { maxValue: constraints.maxValue } : {}),
                  ...(constraints.allowedValues ? { allowedValues: constraints.allowedValues } : {}),
                  ...(constraints.destinations ? { destinations: constraints.destinations } : {}),
              }
            : undefined;
        resources.push({
            resource: path.id,
            resourcePath: path.resourcePath,
            ...(config.effect ? { effect: config.effect } : {}),
            ...(limits && Object.keys(limits).length > 0 ? { limits } : {}),
        });
    }

    const protects = [...new Set(input.protects ?? [])];
    for (const slot of protects) {
        if (!slot || slot.startsWith("_")) problems.push(`slot "${slot}" cannot be protected`);
    }

    if (problems.length > 0) throw new Error(`declaration refused locally: ${problems.join("; ")}`);
    return {
        version: input.version,
        domain: SCADA_DOMAIN,
        namespace: { resource: namespace.resourcePath },
        capabilities: [...SCADA_CAPABILITIES],
        resources,
        protects,
        resultsRequired: [...SCADA_RESULTS_REQUIRED],
    };
}
