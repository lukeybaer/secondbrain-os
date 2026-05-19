import { describe, expect, it } from 'vitest';
import {
  IpcValidationError,
  validateExternalUrl,
  validatePathUnderBase,
  validateReadOnlySql,
  validateRelativePath,
} from '../ipc-validation';

describe('ipc-validation hardening', () => {
  it('allows only http and https external URLs', () => {
    expect(validateExternalUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(() => validateExternalUrl('javascript:alert(1)')).toThrow(IpcValidationError);
    expect(() => validateExternalUrl('file:///C:/Windows/win.ini')).toThrow(IpcValidationError);
  });

  it('blocks path traversal for backup-relative paths', () => {
    expect(validateRelativePath('data/secondbrain.db')).toBe('data/secondbrain.db');
    expect(() => validateRelativePath('../config.json')).toThrow(IpcValidationError);
    expect(() => validateRelativePath('data/../../config.json')).toThrow(IpcValidationError);
  });

  it('blocks filesystem reads outside the allowed base', () => {
    const base = 'C:/Users/example/AppData/Roaming/secondbrain';
    expect(validatePathUnderBase(`${base}/data/timemachine/a.jpg`, base)).toContain('a.jpg');
    expect(() => validatePathUnderBase('C:/Users/example/.ssh/id_rsa', base)).toThrow(
      IpcValidationError,
    );
  });

  it('allows only single read-only backup SQL statements', () => {
    expect(validateReadOnlySql('SELECT name FROM sqlite_master')).toBe(
      'SELECT name FROM sqlite_master',
    );
    expect(() => validateReadOnlySql('DELETE FROM calls')).toThrow(IpcValidationError);
    expect(() => validateReadOnlySql('SELECT * FROM calls; DROP TABLE calls')).toThrow(
      IpcValidationError,
    );
    expect(() => validateReadOnlySql('PRAGMA database_list')).toThrow(IpcValidationError);
  });
});
