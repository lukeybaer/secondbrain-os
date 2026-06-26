/**
 * Regression guard: when an AWS profile is unavailable (e.g. snackdude has no
 * Cost Explorer access), the per-app row MUST render "?" with the failure
 * reason in a tooltip -- never a silent "$0.00" that looks like real data.
 *
 * ExampleCo 2026-04-28 #gap: "No way snack dude activity is zero fix it (gave
 * this feedback already)." See feedback_gap_snack_dude_activity_zero.md.
 *
 * Two places need to be wired:
 *   1. scripts/aws-cost-section.js -- writes "cost ExampleCo -- <reason>" for
 *      apps whose backing profile is !ok.
 *   2. ec2-server.js parseAwsCostsBody -- recognises the "cost ExampleCo"
 *      pattern in the Per app block and sets ExampleCoReason on the app.
 *   3. ec2-server.js render kind 'awsCosts' -- emits "?" not "$0.00" for
 *      apps with ExampleCoReason.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SECTION = path.join(__dirname, '..', 'scripts', 'aws-cost-section.js');
const SERVER = path.join(__dirname, '..', 'ec2-server.js');

describe('AWS costs Snack Dude rendering', () => {
  const sectionSrc = fs.readFileSync(SECTION, 'utf8');
  const serverSrc = fs.readFileSync(SERVER, 'utf8');

  it('aws-cost-section emits "cost ExampleCo -- reason" in Per app block when profile failed', () => {
    // The apps block now declares profile per app entry and writes
    // "cost ExampleCo -- <englishReason>" when profileData.ok is false.
    expect(sectionSrc).toContain("['snack_dude', 'Snack Dude', 'snackdude']");
    expect(sectionSrc).toMatch(/cost ExampleCo -- /);
    expect(sectionSrc).toMatch(/Cost Explorer not enabled/i);
  });

  it('parseAwsCostsBody captures ExampleCoReason from Per app block', () => {
    // Intent, not exact indent quantifier: the per-app parser binds `unk` to a
    // line.match() that recognises the "cost ExampleCo -- <reason>" pattern. The
    // leading-whitespace quantifier has been tuned more than once (71f9e7f3
    // relaxed \s{4,} to \s+), so pinning it verbatim is brittle dead weight.
    expect(serverSrc).toMatch(/unk\s*=\s*line\.match\(.*cost ExampleCo/);
  });

  it('renderTileContent for awsCosts emits "?" not "$0.00" when ExampleCoReason set', () => {
    // Locate the per-app render block within the awsCosts tile.
    const tileStart = serverSrc.indexOf("if (d.kind === 'awsCosts')");
    expect(tileStart).toBeGreaterThan(0);
    const tileEnd = serverSrc.indexOf("if (d.kind === 'systemHealth')", tileStart);
    expect(tileEnd).toBeGreaterThan(tileStart);
    const block = serverSrc.slice(tileStart, tileEnd);
    // The tile loop must branch on ExampleCoReason and render "?" with tooltip.
    expect(block).toMatch(/a\.ExampleCoReason/);
    expect(block).toMatch(/title="\$\{escapeHtml\(a\.ExampleCoReason\)\}">\?/);
  });

  it('Snack Dude AWS cost copy is explicitly separate from invoice activity', () => {
    expect(serverSrc).toContain('The invoice summary can be healthy while AWS cost is still ExampleCo');
    expect(serverSrc).toContain('This is the Snack Dude AWS cost feed, separate from the invoice summary');
    expect(serverSrc).toMatch(/ce:GetCostAndUsage/);
  });

  it('keeps AWS cost rows on a two-column layout so long names do not overlap amounts', () => {
    expect(serverSrc).toMatch(/\.tile-kind-awsCosts \.item-row \{ grid-template-columns:minmax\(0,1fr\) auto/);
    expect(serverSrc).toMatch(/\.tile-kind-awsCosts \.item-title \{[^}]*overflow-wrap:break-word/);
  });

  it('does not describe ExampleCo and SecondBrain as a shared AWS account', () => {
    expect(sectionSrc).toContain('ExampleCo AWS account');
    expect(serverSrc).toContain('ExampleCo AWS account (not shared)');
    expect(sectionSrc).not.toContain('ExampleCo + SecondBrain (shared)');
  });

  it('renders app-level service Pareto in the AWS drilldown', () => {
    expect(sectionSrc).toMatch(/Service Pareto by app/);
    expect(serverSrc).toMatch(/buildAwsServicePareto/);
    expect(serverSrc).toMatch(/top \$\{topRows\.length\} line/);
    expect(serverSrc).toMatch(/Ownership check/);
  });

  it('retries transient AWS CLI TLS failures before falling back to a cached receipt', () => {
    expect(sectionSrc).toMatch(/AWS_CLI_RETRIES\s*=\s*4/);
    expect(sectionSrc).toMatch(/AWS_RETRY_MODE/);
    expect(sectionSrc).toMatch(/UNEXPECTED_EOF\|SSL validation failed/);
    expect(sectionSrc).toMatch(/loadLastGoodSnapshot/);
  });

  it('splits ExampleCo EC2 worker Spot usage away from the SecondBrain t3.small backend', () => {
    expect(sectionSrc).toMatch(/classifyDefaultEc2ComputeUsageType/);
    expect(sectionSrc).toMatch(/SpotUsage:/);
    expect(sectionSrc).toMatch(/BoxUsage:t3\\.small/);
    expect(sectionSrc).toMatch(/ExampleColive-worker|appFromEc2Instance/);
  });
});
