import { CACHE_MODES, CONSISTENCY_MODES, DESTINATIONS, SCADA_INTERFACE_VERSION, SOURCE_LEVELS, type Destination, type IScadaCapabilities } from "./scada.types";

/**
 * Checks a provider declaration when it registers.
 *
 * A declaration cannot be proven against the plant, but it can be proven
 * coherent: a provider without a cache cannot claim a cache level, a provider
 * cannot claim the broker tier `local`, and every value must belong to the
 * SCADA v1 vocabulary. An incoherent declaration is refused rather than
 * trusted, because every later routing decision reads it.
 *
 * Returns the list of problems; an empty list means the declaration is valid.
 */
export function validateCapabilities(providerId: string, declared: IScadaCapabilities): string[] {
    const problems: string[] = [];
    const caps = declared?.capabilities;

    if (declared?.interface !== SCADA_INTERFACE_VERSION) problems.push(`interface must be "${SCADA_INTERFACE_VERSION}", got "${String(declared?.interface)}"`);
    if (declared?.provider !== providerId) problems.push(`provider id "${String(declared?.provider)}" does not match the registered id "${providerId}"`);
    if (!SOURCE_LEVELS.includes(declared?.source)) problems.push(`source must be one of ${SOURCE_LEVELS.join(", ")}`);
    if (!CACHE_MODES.includes(declared?.cachePolicy?.mode)) problems.push(`cachePolicy.mode must be one of ${CACHE_MODES.join(", ")}`);
    if (!caps) {
        problems.push("capabilities are missing");
        return problems;
    }

    const hasCache = declared.cachePolicy?.mode !== undefined && declared.cachePolicy.mode !== "none";

    const checkDestinations = (label: string, destinations: readonly Destination[] | undefined): void => {
        if (!Array.isArray(destinations)) {
            problems.push(`${label}.destinations must be an array`);
            return;
        }
        for (const destination of destinations) {
            if (!DESTINATIONS.includes(destination)) problems.push(`${label}: unknown destination "${String(destination)}"`);
            else if (destination === "local") problems.push(`${label}: "local" is the mcp-scada cache and cannot be declared by a provider`);
            else if (destination === "provider" && !hasCache) problems.push(`${label}: "provider" requires a provider cache, but cachePolicy.mode is "none"`);
            else if (destination !== "provider" && destination !== "source" && destination !== declared.source) {
                // A provider only distinguishes its own source level. Claiming
                // `device` while the source is a gateway is exactly the lie the
                // contract forbids.
                problems.push(`${label}: "${destination}" is not distinguishable, the declared source level is "${declared.source}"`);
            }
        }
        if (new Set(destinations).size !== destinations.length) problems.push(`${label}: duplicate destinations`);
    };

    checkDestinations("read", caps.read?.destinations);
    for (const mode of caps.read?.consistency ?? []) {
        if (!CONSISTENCY_MODES.includes(mode)) problems.push(`read: unknown consistency "${String(mode)}"`);
        else if (mode === "cached" && !hasCache) problems.push(`read: "cached" consistency requires a provider cache`);
    }
    if (caps.write?.supported) checkDestinations("write", caps.write.destinations);
    if (caps.write?.supported && (caps.write.destinations?.length ?? 0) === 0) problems.push("write: supported but no destination declared");

    return problems;
}
