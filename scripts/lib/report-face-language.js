'use strict';

const REPORT_FACE_JARGON_RE =
  /\b(?:open_critical|receipts?|workers?|cron|ec2|s3|queue=|cold start|execution=|handoff=|closure=|scoped live qc|targeted refresh|producer contract|prompt envelope|repair ledger|last tactic|pm2|controller source command|current source proof|health receipt|sourceok|coordinator integration)\b|(?:^|\s)\/opt\/|\bnode\s+scripts\//i;

function hasReportFaceJargon(value) {
  return REPORT_FACE_JARGON_RE.test(String(value || ''));
}

module.exports = { REPORT_FACE_JARGON_RE, hasReportFaceJargon };
