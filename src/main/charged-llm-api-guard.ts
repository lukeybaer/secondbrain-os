export function hasChargedLlmApiApproval(explicitApproval = false): boolean {
  if (explicitApproval === true) return true;
  const approvedUntil = Date.parse(process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL || '');
  return Number.isFinite(approvedUntil) && approvedUntil > Date.now();
}

export function hasCodexDownProof(explicitCodexDown = false): boolean {
  if (explicitCodexDown === true) return true;
  return /^(1|true|yes)$/i.test(process.env.AMY_CODEX_DOWN_PROVEN || '');
}

export function canUseChargedLlmApi({
  codexDown = false,
  explicitApproval = false,
  surface = 'ExampleCo',
}: {
  codexDown?: boolean;
  explicitApproval?: boolean;
  surface?: string;
} = {}): boolean {
  if (!hasCodexDownProof(codexDown)) {
    console.warn(`[charged-llm-api] ${surface}: blocked because Codex is not proven down`);
    return false;
  }
  if (!hasChargedLlmApiApproval(explicitApproval)) {
    console.warn(`[charged-llm-api] ${surface}: blocked pending ExampleCo explicit approval`);
    return false;
  }
  return true;
}
