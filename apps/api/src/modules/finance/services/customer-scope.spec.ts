import { errors } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { declaredNotImplemented } from '../../../kernel';
import type { PersonDirectoryPort } from '../../identity';
import { personIdsOf } from './customer-scope';

// FIN-01, FIN-03 (IF-09, SPK-IAM-007): the person ids whose financial facts are a person's.

function directory(answer: () => Promise<string[]>): PersonDirectoryPort {
  return { personIdsResolvingTo: answer } as unknown as PersonDirectoryPort;
}

describe('personIdsOf', () => {
  it('SPK-IAM-007: returns the survivor and every person merged into it', async () => {
    const ids = await personIdsOf(
      directory(async () => ['a', 'b', 'c']),
      'org',
      'a',
    );
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('answers the person itself for an id the directory does not know', async () => {
    expect(
      await personIdsOf(
        directory(async () => []),
        'org',
        'x',
      ),
    ).toEqual(['x']);
  });

  it('answers the person itself while the directory member is declared but not implemented', async () => {
    const pending = directory(async () =>
      declaredNotImplemented('PersonDirectoryPort.personIdsResolvingTo', 'ID-01'),
    );
    expect(await personIdsOf(pending, 'org', 'x')).toEqual(['x']);
  });

  it('propagates any other failure', async () => {
    const failing = directory(async () => {
      throw errors.internal('connection lost');
    });
    await expect(personIdsOf(failing, 'org', 'x')).rejects.toThrow('connection lost');
  });
});
