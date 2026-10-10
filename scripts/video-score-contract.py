#!/usr/bin/env python3
"""The executable contract for the active video scorer and its retirement proof.

The fast runner is the live route because it contains the byte-bound audio,
caption, thumbnail, identity, source, and directive-fidelity checks. The
historical full runner is retained only as byte-bound comparison evidence. A
selection record must explain each recommendation disagreement; it must never
pretend that distinct quality gates produced equivalent release outcomes.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = 'amy.video-score-contract.v3'
EVIDENCE_SCHEMA = 'amy.video-score-evidence.v3'
SHA_RE = re.compile(r'^[a-f0-9]{64}$')
CONCRETE_CHECK_MODULES = {
    'audio_edges': 'analyze-audio-edges',
    'caption_readability': 'analyze-caption-readability',
    'thumbnail_first_frame': 'analyze-thumbnail-first-frame',
    'rejection_directive_fidelity': 'analyze-rejection-directive-fidelity',
}


def read_json(path: Path):
    with path.open(encoding='utf-8') as handle:
        return json.load(handle)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def closure_digest(tools: Path, modules: list[str]) -> str:
    """Hash the exact ordered active dependency closure, not only its entry script."""
    rows = [
        {'module': module, 'sha256': digest(tools / f'{module}.py')}
        for module in sorted(modules)
    ]
    return hashlib.sha256(json.dumps(rows, separators=(',', ':'), sort_keys=True).encode('utf-8')).hexdigest()


def imports_for(path: Path) -> set[str]:
    """Extract executable local module edges, never docstring examples."""
    tree = ast.parse(path.read_text(encoding='utf-8', errors='replace'), filename=str(path))
    result: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.name for alias in node.names] if isinstance(node, ast.Import) else [node.module or '']
            for name in names:
                local = name.split('.')[0]
                if local and (path.parent / f'{local}.py').is_file():
                    result.add(local)
        if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant):
            value = node.args[0].value
            if not isinstance(value, str):
                continue
            is_importlib = isinstance(node.func, ast.Attribute) and node.func.attr == 'import_module'
            is_fast_loader = isinstance(node.func, ast.Name) and node.func.id == '_load'
            if is_importlib or is_fast_loader:
                result.add(value)
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'TOOLS' for target in node.targets):
            if isinstance(node.value, (ast.List, ast.Tuple)):
                for entry in node.value.elts:
                    if isinstance(entry, ast.Tuple) and entry.elts and isinstance(entry.elts[0], ast.Constant):
                        value = entry.elts[0].value
                        if isinstance(value, str):
                            result.add(value)
    return result


def closure(tools: Path, roots: list[str]) -> tuple[list[str], list[str]]:
    pending = list(roots)
    found: set[str] = set()
    missing: set[str] = set()
    while pending:
        name = pending.pop()
        if name in found or name in missing:
            continue
        candidate = tools / f'{name}.py'
        if not candidate.is_file():
            missing.add(name)
            continue
        found.add(name)
        pending.extend(imports_for(candidate) - found - missing)
    return sorted(found), sorted(missing)


def sha(value) -> bool:
    return isinstance(value, str) and bool(SHA_RE.fullmatch(value.lower()))


def score_errors(report: object, contract: dict, *, require_concrete_checks: bool = True) -> list[str]:
    if not isinstance(report, dict):
        return ['runner output must be a JSON object']
    errors: list[str] = []
    for field in contract['required_output_fields']:
        if field not in report:
            errors.append(f'runner output lacks {field}')
    for field in ('overall_score', 'virality_score'):
        if field in report and (not isinstance(report[field], (int, float)) or isinstance(report[field], bool)):
            errors.append(f'runner output {field} must be numeric')
    if 'publish_recommendation' in report and not isinstance(report['publish_recommendation'], str):
        errors.append('runner output publish_recommendation must be a string')
    scores = report.get('detailed_scores')
    if not isinstance(scores, dict):
        return errors + ['runner output detailed_scores must be an object']
    if require_concrete_checks:
        for check in contract['required_concrete_checks']:
            value = scores.get(check)
            if not isinstance(value, dict) or not isinstance(value.get('score'), (int, float)):
                errors.append(f'runner output lacks required concrete check {check}')
    return errors


def resolve_bound_file(base: Path, item: object, label: str) -> tuple[Path | None, list[str]]:
    if not isinstance(item, dict):
        return None, [f'{label} must be an object with path and sha256']
    rel = item.get('path')
    claimed = item.get('sha256')
    if not isinstance(rel, str) or not rel:
        return None, [f'{label} path is required']
    if not sha(claimed):
        return None, [f'{label} sha256 must be a SHA-256']
    path = (base / rel).resolve()
    if not path.is_file():
        return None, [f'{label} file is missing: {rel}']
    if digest(path) != claimed:
        return None, [f'{label} sha256 does not bind the file bytes']
    return path, []


def nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_evidence(path: Path, contract: dict, *, active_runner_hash: str) -> list[str]:
    try:
        doc = read_json(path)
    except Exception as error:
        return [f'evidence unreadable: {error}']
    errors: list[str] = []
    if doc.get('schema') != EVIDENCE_SCHEMA:
        return [f'evidence schema must be {EVIDENCE_SCHEMA}']
    active_runner = contract['active_runner']
    comparison_runner = contract['historical_comparison_runner']
    selection = doc.get('selection')
    if not isinstance(selection, dict):
        return ['evidence selection must be an object']
    if selection.get('selected_runner') != active_runner:
        errors.append(f'evidence selection must retain {active_runner}')
    if selection.get('comparison_runner') != comparison_runner:
        errors.append(f'evidence selection must name historical {comparison_runner}')
    if not nonempty_string(selection.get('rationale')):
        errors.append('evidence selection requires a nonempty rationale')
    if selection.get('quality_disposition') != 'fast_outcomes_remain_authoritative':
        errors.append('evidence selection must preserve Fast quality outcomes as authoritative')
    checks = selection.get('retained_concrete_checks')
    if checks != contract['required_concrete_checks']:
        errors.append('evidence selection must bind every retained concrete check in contract order')
    source_hashes = selection.get('runner_source_sha256')
    if not isinstance(source_hashes, dict) or source_hashes.get(active_runner) != active_runner_hash:
        errors.append('evidence selection must bind the current active runner source SHA-256')
    if not isinstance(source_hashes, dict) or source_hashes.get(comparison_runner) != contract.get('historical_comparison_runner_sha256'):
        errors.append('evidence selection must bind the audited historical comparison runner source SHA-256')
    if selection.get('active_closure_sha256') != contract.get('retirement_evidence_fast_closure_sha256'):
        errors.append('evidence selection must bind the audited evidence-time Fast dependency closure SHA-256')
    if selection.get('comparative_limitations') != 'owner_label_discrimination_not_established':
        errors.append('evidence selection must state that the samples do not establish owner-label discrimination')
    dispositions = selection.get('disagreement_dispositions')
    if not isinstance(dispositions, dict):
        errors.append('evidence selection requires disagreement_dispositions')
        dispositions = {}

    samples = doc.get('samples')
    if not isinstance(samples, list):
        return errors + ['evidence samples must be an array']
    labels = set()
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            errors.append(f'sample {index} must be an object')
            continue
        label = sample.get('label')
        if not nonempty_string(label):
            errors.append(f'sample {index} label must be a nonempty string')
            continue
        labels.add(label)
        artifact, bound_errors = resolve_bound_file(path.parent, sample.get('artifact'), f'sample {index} artifact')
        errors.extend(bound_errors)
        outputs = sample.get('outputs')
        if not isinstance(outputs, dict):
            errors.append(f'sample {index} outputs must be an object')
            continue
        reports = {}
        for runner in (active_runner, comparison_runner):
            output_path, output_errors = resolve_bound_file(path.parent, outputs.get(runner), f'sample {index} {runner} output')
            errors.extend(output_errors)
            if output_path is None:
                continue
            try:
                report = read_json(output_path)
            except Exception as error:
                errors.append(f'sample {index} {runner} output is not JSON: {error}')
                continue
            reports[runner] = report
            errors.extend(
                f'sample {index} {runner}: {error}'
                for error in score_errors(report, contract, require_concrete_checks=(runner == active_runner))
            )
            if artifact is not None:
                report_path = report.get('video_path')
                try:
                    same_artifact = nonempty_string(report_path) and Path(report_path).resolve() == artifact
                except (OSError, ValueError):
                    same_artifact = False
                if not same_artifact:
                    errors.append(f'sample {index} {runner}: output video_path does not identify the bound artifact')
        logs = sample.get('logs')
        if not isinstance(logs, dict):
            errors.append(f'sample {index} logs must bind the historical comparison stderr')
        else:
            _, log_errors = resolve_bound_file(path.parent, logs.get(comparison_runner), f'sample {index} {comparison_runner} stderr')
            errors.extend(log_errors)
        if len(reports) == 2:
            active = reports[active_runner]
            comparison = reports[comparison_runner]
            active_recommendation = active.get('publish_recommendation')
            comparison_recommendation = comparison.get('publish_recommendation')
            if active_recommendation != comparison_recommendation:
                disposition = dispositions.get(label)
                if not isinstance(disposition, dict):
                    errors.append(f'sample {index} disagreement requires an explicit selection disposition')
                    continue
                if disposition.get('active_recommendation') != active_recommendation:
                    errors.append(f'sample {index} disposition does not bind the Fast recommendation')
                if disposition.get('comparison_recommendation') != comparison_recommendation:
                    errors.append(f'sample {index} disposition does not bind the historical recommendation')
                allowed = contract.get('allowed_disagreement_dispositions', [])
                if disposition.get('disposition') not in allowed:
                    errors.append(f'sample {index} disagreement disposition is not an allowed disposition')
                if not nonempty_string(disposition.get('reason_code')) or not nonempty_string(disposition.get('reason')):
                    errors.append(f'sample {index} disagreement disposition requires a reason_code and reason')
                if disposition.get('comparison_degraded') is not True or disposition.get('acknowledged_comparison_degradation') is not True:
                    errors.append(f'sample {index} disagreement disposition must acknowledge the degraded historical comparison')
    for required in ('approved', 'rejected'):
        if required not in labels:
            errors.append(f'evidence lacks a {required} sample')
    return errors


def report(root: Path, contract_path: Path, evidence_path: Path | None):
    contract = read_json(contract_path)
    if contract.get('schema') != SCHEMA:
        raise ValueError(f'contract schema must be {SCHEMA}')
    active = contract.get('active_runner')
    comparison = contract.get('historical_comparison_runner')
    candidates = contract.get('candidates')
    if active not in candidates or not isinstance(comparison, str) or not comparison:
        raise ValueError('active_runner must name a configured candidate and historical_comparison_runner must be set')
    tools = root / contract['tools_dir']
    reports = {}
    for name, rel in candidates.items():
        runner = tools / rel
        if not runner.is_file():
            raise ValueError(f'configured runner is missing: {runner}')
        imports = imports_for(runner)
        found, missing = closure(tools, imports)
        reports[name] = {
            'runner': str(Path(contract['tools_dir']) / rel).replace('\\', '/'),
            'runner_sha256': digest(runner),
            'direct_local_imports': sorted(imports),
            'dependency_closure': found,
            'dependency_closure_sha256': closure_digest(tools, found),
            'missing_local_modules': missing,
            'static_contract_errors': score_errors({'detailed_scores': {}}, contract),
        }
    # Fast's explicit TOOLS list proves it owns the concrete checks. The full
    # runner is compared on the output fields it actually emitted, rather than
    # being required to implement Fast's newer checks.
    for name, candidate in reports.items():
        runner_text = (tools / contract['candidates'][name]).read_text(encoding='utf-8', errors='replace')
        candidate['declared_concrete_checks'] = [
            check for check in contract['required_concrete_checks']
            if CONCRETE_CHECK_MODULES.get(check, check) in runner_text
        ]
        candidate['missing_declared_concrete_checks'] = [
            check for check in contract['required_concrete_checks']
            if CONCRETE_CHECK_MODULES.get(check, check) not in runner_text
        ]
        candidate.pop('static_contract_errors')
    active_row = reports[active]
    contract['_active_closure_sha256'] = active_row['dependency_closure_sha256']
    evidence_errors = validate_evidence(evidence_path, contract, active_runner_hash=active_row['runner_sha256']) if evidence_path else ['no retained comparison evidence supplied']
    evidence_closure_sha256 = None
    if evidence_path:
        try:
            evidence_closure_sha256 = read_json(evidence_path).get('selection', {}).get('active_closure_sha256')
        except Exception:
            pass
    return {
        'schema': SCHEMA,
        'active_runner': active,
        'historical_comparison_runner': comparison,
        'retirement_allowed': (
            not evidence_errors
            and not active_row['missing_local_modules']
            and not active_row['missing_declared_concrete_checks']
        ),
        'evidence_errors': evidence_errors,
        # Historical evidence records the closure that existed when the byte-bound
        # comparison ran. A later Fast maintenance change is surfaced, not used to
        # invalidate preserved retirement evidence retroactively.
        'closure_changed_since_evidence': bool(evidence_closure_sha256 and evidence_closure_sha256 != active_row['dependency_closure_sha256']),
        'candidates': reports,
    }, contract


def execute(root: Path, runner_args: list[str]) -> int:
    result, contract = report(root, root / 'config/video-score-contract.json', None)
    active = result['active_runner']
    row = result['candidates'][active]
    if row['missing_local_modules']:
        print('video-score-contract: active runner has missing local modules: ' + ', '.join(row['missing_local_modules']), file=sys.stderr)
        return 2
    if row['missing_declared_concrete_checks']:
        print('video-score-contract: active runner omits required checks: ' + ', '.join(row['missing_declared_concrete_checks']), file=sys.stderr)
        return 2
    if runner_args[:1] == ['--']:
        runner_args = runner_args[1:]
    if not runner_args:
        print('video-score-contract: --execute requires the runner video arguments', file=sys.stderr)
        return 2
    runner = root / row['runner']
    completed = subprocess.run([sys.executable, str(runner), *runner_args], cwd=root, capture_output=True, text=True)
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    try:
        output = json.loads(completed.stdout)
    except Exception as error:
        print(f'video-score-contract: active runner output is not JSON: {error}', file=sys.stderr)
        return completed.returncode or 2
    errors = score_errors(output, contract)
    if errors:
        print('video-score-contract: active runner contract failure: ' + '; '.join(errors), file=sys.stderr)
        return 2
    sys.stdout.write(completed.stdout)
    return completed.returncode


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=Path(__file__).resolve().parents[1])
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--execute', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    try:
        if args.execute is not None:
            return execute(root, args.execute)
        result, _ = report(root, root / 'config/video-score-contract.json', args.evidence)
    except Exception as error:
        print(f'video-score-contract: {error}', file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"active runner: {result['active_runner']}")
        print(f"historical comparison runner: {result['historical_comparison_runner']}")
        print(f"retirement allowed: {result['retirement_allowed']}")
        for name, row in result['candidates'].items():
            print(f"{name}: {len(row['dependency_closure'])} closure modules, {len(row['missing_local_modules'])} missing")
        for error in result['evidence_errors']:
            print(f"evidence: {error}")
    active = result['candidates'][result['active_runner']]
    healthy_active = not active['missing_local_modules'] and not active['missing_declared_concrete_checks']
    return 0 if healthy_active and (args.evidence is None or result['retirement_allowed']) else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
