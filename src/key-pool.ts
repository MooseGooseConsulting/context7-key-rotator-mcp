export type KeyLease = {
  index: number;
  value: string;
};

/**
 * Stateless with respect to MCP clients. The counter only keeps normal traffic
 * evenly distributed between the configured upstream keys in this process.
 */
export class RoundRobinKeyPool {
  private nextIndex = 0;

  public constructor(private readonly keys: readonly string[]) {
    if (keys.length !== 2) {
      throw new Error("CONTEXT7_API_KEYS must contain exactly two non-empty keys.");
    }
  }

  public next(): KeyLease {
    const index = this.nextIndex;
    this.nextIndex = (this.nextIndex + 1) % this.keys.length;
    return { index, value: this.keys[index] };
  }

  public alternate(lease: KeyLease): KeyLease {
    return { index: (lease.index + 1) % this.keys.length, value: this.keys[(lease.index + 1) % this.keys.length] };
  }

  public static fromEnvironment(value = process.env.CONTEXT7_API_KEYS): RoundRobinKeyPool {
    const keys = value?.split(",").map((key) => key.trim()).filter(Boolean) ?? [];
    return new RoundRobinKeyPool(keys);
  }
}
