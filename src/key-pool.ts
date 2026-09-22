export type KeyLease = {
  index: number;
  value: string;
};

export type Clock = () => number;

/**
 * Stateless with respect to MCP clients. The counter only keeps normal traffic
 * evenly distributed between the configured upstream keys in this process, and
 * the cooldowns only steer ordinary selection away from a key that Context7 has
 * rate limited until its Retry-After window has passed.
 */
export class RoundRobinKeyPool {
  private nextIndex = 0;
  private readonly coolingUntil: number[];

  public constructor(
    private readonly keys: readonly string[],
    public readonly now: Clock = Date.now,
  ) {
    if (keys.length !== 2) {
      throw new Error("CONTEXT7_API_KEYS must contain exactly two non-empty keys.");
    }
    this.coolingUntil = keys.map(() => 0);
  }

  public next(): KeyLease {
    const index = this.nextIndex;
    this.nextIndex = (this.nextIndex + 1) % this.keys.length;
    const selected = this.lease(index);
    const alternate = this.alternate(selected);
    if (this.isCoolingDown(selected.index) && !this.isCoolingDown(alternate.index)) {
      return alternate;
    }
    return selected;
  }

  /** Every key in slot order, independent of the round-robin pointer. */
  public leases(): KeyLease[] {
    return this.keys.map((_, index) => this.lease(index));
  }

  public alternate(lease: KeyLease): KeyLease {
    return this.lease((lease.index + 1) % this.keys.length);
  }

  public coolDown(lease: KeyLease, durationMs: number): void {
    this.coolingUntil[lease.index] = Math.max(this.coolingUntil[lease.index], this.now() + durationMs);
  }

  public isCoolingDown(index: number): boolean {
    return this.coolingUntil[index] > this.now();
  }

  private lease(index: number): KeyLease {
    return { index, value: this.keys[index] };
  }

  public static fromEnvironment(value = process.env.CONTEXT7_API_KEYS): RoundRobinKeyPool {
    const keys = value?.split(",").map((key) => key.trim()).filter(Boolean) ?? [];
    return new RoundRobinKeyPool(keys);
  }
}
