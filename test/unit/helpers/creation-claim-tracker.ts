/**
 * For Prisma doubles whose `updateMany` deliberately does NOT change the stored
 * row: remembers the Gumlet creation claim (`gumletStatus = 'creating'`) so a
 * later re-read sees it, as a real database would. `adopt()` re-reads the row
 * right before creating an asset to confirm it still owns its claim.
 */
export function creationClaimTracker() {
  let claim: { gumletStatus: string; gumletUpdatedAt: unknown } | null = null;
  return {
    observe(args: { where?: Record<string, unknown>; data?: Record<string, unknown> }): void {
      const data = args.data ?? {};
      if (data.gumletStatus === 'creating') {
        claim = { gumletStatus: 'creating', gumletUpdatedAt: data.gumletUpdatedAt };
      } else if ('gumletAssetId' in data || args.where?.gumletStatus === 'creating') {
        claim = null; // recorded an asset, or released the claim
      }
    },
    view<T extends object>(row: T): T {
      return claim ? { ...row, ...claim } : row;
    },
  };
}
