import type { UnsId } from "../contract/scada.types";

const SCHEME = "uns://";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A parsed Unified Namespace identity.
 *
 * The UNS id is the durable name of a resource: it carries no slot, host,
 * session or protocol address, so a provider reconnect or a slot rename never
 * changes it. Its path is also the MCP Broker resource path the policy engine
 * evaluates, which is what lets ISA-95 subtree assignments govern SCADA
 * resources without a second resource model.
 */
export class UnsPath {
    readonly segments: readonly string[];

    private constructor(segments: readonly string[]) {
        this.segments = Object.freeze([...segments]);
    }

    static parse(id: UnsId): UnsPath {
        if (typeof id !== "string" || !id.startsWith(SCHEME)) throw new Error(`UNS id "${String(id)}" must start with "${SCHEME}".`);
        const body = id.slice(SCHEME.length).replace(/\/$/, "");
        if (!body) throw new Error(`UNS id "${id}" has no path.`);
        const segments = body.split("/");
        for (const segment of segments) {
            if (!SEGMENT.test(segment) || segment === "." || segment === "..") throw new Error(`UNS id "${id}" has an invalid segment "${segment}".`);
        }
        return new UnsPath(segments);
    }

    static tryParse(id: UnsId): UnsPath | undefined {
        try {
            return UnsPath.parse(id);
        } catch {
            return undefined;
        }
    }

    /** The canonical id, without a trailing slash. */
    get id(): UnsId {
        return `${SCHEME}${this.segments.join("/")}`;
    }

    /** The MCP Broker resource path: `uns://a/b/c` is `/a/b/c`. */
    get resourcePath(): string {
        return `/${this.segments.join("/")}`;
    }

    child(...segments: string[]): UnsPath {
        return UnsPath.parse(`${this.id}/${segments.join("/")}`);
    }

    /** True when `other` is this path or one of its descendants. */
    contains(other: UnsPath): boolean {
        return other.segments.length >= this.segments.length && this.segments.every((segment, index) => other.segments[index] === segment);
    }

    toString(): string {
        return this.id;
    }
}
