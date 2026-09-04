/** Port owned by accounts; Plan 3 supplies the Plaid-backed implementation. */
export type ActiveItemUnlinker = Readonly<{
  unlinkActiveItem: (input: {
    userId: string;
    itemId: string;
  }) => Promise<boolean>;
}>;

/** Safe pre-Plan-3 default: no upstream or database work is attempted. */
export const noOpActiveItemUnlinker: ActiveItemUnlinker = {
  unlinkActiveItem: async () => false,
};
