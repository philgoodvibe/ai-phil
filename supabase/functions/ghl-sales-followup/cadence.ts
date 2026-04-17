// Pure cadence calculator for ghl-sales-followup.
// No I/O, no Date.now(). All time inputs are passed explicitly.

export type TouchOutcome =
  | 'fu1-clarity'
  | 'fu2-objection'
  | 'fu3-soft-close'
  | 'nurture'
  | 'nurture-final'
  | 'done';

type NextSendAdvance = {
  action: 'advance';
  followUpNumber: number;
  nextSendAt: Date;
};

type NextSendDelete = {
  action: 'delete';
};

export type NextSendResult = NextSendAdvance | NextSendDelete;

const MS_PER_DAY = 86_400_000;

export function classifyTouch(followUpNumber: number): TouchOutcome {
  if (followUpNumber === 1) return 'fu1-clarity';
  if (followUpNumber === 2) return 'fu2-objection';
  if (followUpNumber === 3) return 'fu3-soft-close';
  if (followUpNumber >= 4 && followUpNumber <= 8) return 'nurture';
  if (followUpNumber === 9) return 'nurture-final';
  return 'done';
}

export function computeNextSendAt(
  justFiredFollowUpNumber: number,
  createdAt: Date,
  now: Date,
): NextSendResult {
  if (justFiredFollowUpNumber === 1) {
    return {
      action: 'advance',
      followUpNumber: 2,
      nextSendAt: new Date(createdAt.getTime() + 3 * MS_PER_DAY),
    };
  }
  if (justFiredFollowUpNumber === 2) {
    return {
      action: 'advance',
      followUpNumber: 3,
      nextSendAt: new Date(createdAt.getTime() + 7 * MS_PER_DAY),
    };
  }
  if (justFiredFollowUpNumber >= 3 && justFiredFollowUpNumber <= 8) {
    return {
      action: 'advance',
      followUpNumber: justFiredFollowUpNumber + 1,
      nextSendAt: new Date(now.getTime() + 30 * MS_PER_DAY),
    };
  }
  return { action: 'delete' };
}
