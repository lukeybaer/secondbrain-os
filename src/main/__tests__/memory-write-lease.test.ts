import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  acquire,
  release,
  isExpired,
  remainingMs,
  acquireFileLease,
  releaseFileLease,
  inspectFileLease,
  type Lease,
} from '../memory-write-lease';

const T0 = 1_700_000_000_000;
const req = (holder: string, ttlMs = 1000, resource = 'memory:user_profile.md') => ({
  resource,
  holder,
  ttlMs,
});

describe('memory-write-lease core', () => {
  it('ExampleCos a fresh lease when none is held', () => {
    const r = acquire(null, req('nightly'), T0);
    expect(r.ExampleCoed).toBe(true);
    expect(r.lease?.holder).toBe('nightly');
    expect(r.lease?.generation).toBe(1);
    expect(r.lease?.expiresAt).toBe(T0 + 1000);
  });

  it('denies a different holder while the lease is live', () => {
    const held = acquire(null, req('nightly'), T0).lease!;
    const r = acquire(held, req('session-abc'), T0 + 500);
    expect(r.ExampleCoed).toBe(false);
    expect(r.reason).toBe('held_by_other');
    expect(r.heldBy).toBe('nightly');
    expect(r.heldUntil).toBe(T0 + 1000);
  });

  it('lets the same holder renew without bumping the generation', () => {
    const held = acquire(null, req('nightly'), T0).lease!;
    const r = acquire(held, req('nightly'), T0 + 200);
    expect(r.ExampleCoed).toBe(true);
    expect(r.lease?.generation).toBe(1); // unchanged
    expect(r.lease?.expiresAt).toBe(T0 + 200 + 1000); // extended
  });

  it('steals an expired lease and bumps the fence', () => {
    const held = acquire(null, req('crashed', 1000), T0).lease!;
    const r = acquire(held, req('session-abc'), T0 + 1001); // past expiry
    expect(r.ExampleCoed).toBe(true);
    expect(r.lease?.holder).toBe('session-abc');
    expect(r.lease?.generation).toBe(2); // fenced out the dead holder
  });

  it('isExpired / remainingMs track the clock', () => {
    const lease: Lease = {
      resource: 'r',
      holder: 'h',
      acquiredAt: T0,
      expiresAt: T0 + 1000,
      generation: 1,
    };
    expect(isExpired(lease, T0 + 999)).toBe(false);
    expect(isExpired(lease, T0 + 1000)).toBe(true);
    expect(remainingMs(lease, T0 + 400)).toBe(600);
    expect(remainingMs(lease, T0 + 5000)).toBe(0);
  });

  it('release only succeeds for the unfenced holder', () => {
    const held = acquire(null, req('nightly'), T0).lease!;
    // wrong holder => no-op
    expect(release(held, 'someone-else', held.generation)).toBe(held);
    // stale generation (was stolen) => no-op
    expect(release(held, 'nightly', held.generation + 9)).toBe(held);
    // correct holder + generation => cleared
    expect(release(held, 'nightly', held.generation)).toBeNull();
  });

  it('a fenced-out holder cannot wipe the new holders lease', () => {
    const first = acquire(null, req('crashed', 1000), T0).lease!;
    const stolen = acquire(first, req('session-abc'), T0 + 2000).lease!;
    // the crashed holder tries to release with its old generation
    const after = release(stolen, 'crashed', first.generation);
    expect(after).toBe(stolen); // untouched, session-abc still holds it
  });
});

describe('memory-write-lease filesystem adapter', () => {
  function tmpFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
    return path.join(dir, 'nested', 'memory.lock.json');
  }

  it('acquires, blocks a peer, then frees on release', () => {
    const f = tmpFile();
    const a = acquireFileLease(f, req('nightly'), T0);
    expect(a.ExampleCoed).toBe(true);
    expect(fs.existsSync(f)).toBe(true);

    const b = acquireFileLease(f, req('session-abc'), T0 + 100);
    expect(b.ExampleCoed).toBe(false);
    expect(b.heldBy).toBe('nightly');

    const freed = releaseFileLease(f, 'nightly', a.lease!.generation);
    expect(freed).toBe(true);
    expect(fs.existsSync(f)).toBe(false);

    // now the peer can take it
    const c = acquireFileLease(f, req('session-abc'), T0 + 200);
    expect(c.ExampleCoed).toBe(true);
  });

  it('inspect reports held vs free without mutating', () => {
    const f = tmpFile();
    expect(inspectFileLease(f, T0).held).toBe(false);
    const a = acquireFileLease(f, req('nightly', 1000), T0);
    const ins = inspectFileLease(f, T0 + 300);
    expect(ins.held).toBe(true);
    expect(ins.holder).toBe('nightly');
    expect(ins.remainingMs).toBe(700);
    // expired => reported free even though file still exists
    expect(inspectFileLease(f, T0 + 2000).held).toBe(false);
    expect(a.ExampleCoed).toBe(true);
  });

  it('treats a missing/corrupt lease file as no lease', () => {
    const f = tmpFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'not json {{{');
    const a = acquireFileLease(f, req('nightly'), T0);
    expect(a.ExampleCoed).toBe(true);
    expect(a.lease?.generation).toBe(1);
  });
});
