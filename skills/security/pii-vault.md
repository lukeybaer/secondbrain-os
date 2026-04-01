# Skill: PII Vault

## Purpose
Govern access to the owner's personally identifiable information. All PII lives in the encrypted vault. Nothing leaves without an active approval.

## Vault Contents
| Category | Data | Alert Level |
|----------|------|-------------|
| home_address | (stored encrypted) | Immediate Telegram |
| phone_personal | (stored encrypted) | Immediate Telegram |
| phone_private_sim | (stored encrypted) | Immediate Telegram |
| email | (stored encrypted) | Telegram within 5 min |
| employer | (stored encrypted) | Telegram within 5 min |
| spouse_name | (stored encrypted) | Telegram within 5 min |
| ssn | (stored encrypted) | NEVER share, Immediate Telegram |
| financial | (stored encrypted) | NEVER share, Immediate Telegram |

## Access Rules
1. Any access to PII requires a resolved `request_approval` with `data_category` matching the requested field
2. Approvals are one-use, 5-minute expiry
3. Every access is logged to `pii_log` table with timestamp, caller, approval ID, data category
4. Even approved access triggers a Telegram audit message

## Vault Encryption
- AES-256-GCM
- Key stored in OS keychain (never in source code or config files)
- Key ID: `secondbrain.pii.vault.key`
- IV generated fresh per encryption — never reused

## Emergency Override
If the owner sends "VAULT LOCK" via Telegram: reject all PII requests, alert the owner, log event.

## Usage Count Tracking
- uses: 0
- last_evolved: never
