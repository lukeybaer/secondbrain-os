export function hasChargedLlmApiApproval(explicitApproval = false): boolean {
  void explicitApproval;
  return false;
}

export function hasCodexDownProof(explicitCodexDown = false): boolean {
  if (explicitCodexDown === true) return true;
  return /^(1|true|yes)$/i.test(process.env.AMY_CODEX_DOWN_PROVEN || '');
}

export function canUseChargedLlmApi({
  codexDown = false,
  explicitApproval = false,
  surface = 'unknown',
}: {
  codexDown?: boolean;
  explicitApproval?: boolean;
  surface?: string;
} = {}): boolean {
  void codexDown;
  void explicitApproval;
  console.warn(
    `[charged-llm-api] ${surface}: paid-model-api-disabled:owner-policy-2026-08-05`,
  );
  return false;
}
