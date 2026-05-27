// notify-policy.ts
//
// The Telegram notification allowlist. Luke gets a Telegram for ONLY these
// categories; every other owner-bound message (service-down alerts,
// exceptions, error reports, per-item status chatter) is dropped.
//
// Kept as its own pure module so the policy is unit-testable without pulling
// in telegram.ts and its native-module dependencies.

export type NotifyCategory =
  | 'dispatch_complete' // a dispatched unit of work finished (batched per bundle)
  | 'video_regen' //       a video was regenerated (with a link)
  | 'briefing_ready' //    the daily briefing is available (with a link)
  | 'question_answer' //   an answer to a question Luke asked in Telegram
  | 'approval'; //         an interactive YES/NO prompt that needs Luke's reply

export const ALLOWED_CATEGORIES: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>([
  'dispatch_complete',
  'video_regen',
  'briefing_ready',
  'question_answer',
  'approval',
]);

/** True if a message carrying this category is allowed to reach the owner. */
export function isNotifyCategoryAllowed(category: string | undefined): boolean {
  return !!category && ALLOWED_CATEGORIES.has(category as NotifyCategory);
}
