import * as path from 'path';

function basePrefix(baseResolved: string): string {
  const normalized = path.resolve(baseResolved);
  return normalized.endsWith(path.sep) ? normalized : normalized + path.sep;
}

function isInsideBase(candidate: string, baseResolved: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedBase = path.resolve(baseResolved);

  if (resolvedCandidate === resolvedBase) {
    return true;
  }

  const prefix = basePrefix(resolvedBase);
  if (resolvedCandidate.startsWith(prefix)) {
    return true;
  }

  // Windows: drive letter and path casing may differ from stored frame paths.
  if (process.platform === 'win32') {
    const lcCandidate = resolvedCandidate.toLowerCase();
    const lcPrefix = prefix.toLowerCase();
    if (lcCandidate === resolvedBase.toLowerCase() || lcCandidate.startsWith(lcPrefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve requestedPath against baseDir and throw if the result escapes baseDir.
 * Accepts relative segments, empty string (base itself), and absolute paths that
 * still lie under baseDir (e.g. frame.local_path from the Time Machine DB).
 */
export function resolvePathWithinBase(baseDir: string, requestedPath: string): string {
  const baseResolved = path.resolve(baseDir);

  let candidate: string;
  if (requestedPath === '' || requestedPath === '.') {
    candidate = baseResolved;
  } else if (path.isAbsolute(requestedPath)) {
    candidate = path.resolve(requestedPath);
  } else {
    candidate = path.resolve(baseResolved, requestedPath);
  }

  if (!isInsideBase(candidate, baseResolved)) {
    throw new Error(`Path escapes base directory: ${requestedPath}`);
  }

  return candidate;
}
