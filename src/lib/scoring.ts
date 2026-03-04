export type MemberDailyScoreInput = {
  userId: string;
  maxAttemptsPerGame: Record<string, number>;
  attemptsByGame: Record<string, number | undefined>;
};

export function calculateDailyScore(input: MemberDailyScoreInput) {
  let total = 0;

  for (const [gameKey, maxAttempts] of Object.entries(input.maxAttemptsPerGame)) {
    const attempts = input.attemptsByGame[gameKey];
    if (typeof attempts === "number") {
      total += attempts;
    } else {
      total += maxAttempts + 2;
    }
  }

  return {
    userId: input.userId,
    score: total
  };
}
