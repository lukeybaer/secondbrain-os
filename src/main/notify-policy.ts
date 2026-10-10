// notify-policy.ts
//
// The Telegram notification allowlist. ExampleCo gets a Telegram for ONLY these
// categories; every other owner-bound message (briefings, service-down alerts,
// exceptions, task-complete chatter, per-item status chatter) is dropped.
//
// Kept as its own pure module so the policy is unit-testable without pulling
// in telegram.ts and its native-module dependencies.

export type NotifyCategory =
  | 'question_answer' //   an answer to a question ExampleCo asked in Telegram
  | 'security' //          security or reputation risk that needs push urgency
  | 'pii' //               PII detection/access alert
  | 'video_ready' //       a video is ready for ExampleCo
  | 'voice_followup'; //   post-call Amy follow-up, one message

export const ALLOWED_CATEGORIES: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>([
  'question_answer',
  'security',
  'pii',
  'video_ready',
  'voice_followup',
]);

/** True if a message carrying this category is allowed to reach the owner. */
export function isNotifyCategoryAllowed(category: string | undefined): boolean {
  return !!category && ALLOWED_CATEGORIES.has(category as NotifyCategory);
}
