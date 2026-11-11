import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// OWASP-recommended Argon2id parameters (19 MiB, 2 iterations, 1 lane) - same as the seed.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const PasswordPolicy = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: string | null = null;
/** Spends the same time as a real check so unknown emails cannot be detected by response time. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= await hashPassword('jfs-timing-equaliser-value-0');
  await verifyPassword(dummyHash, password);
}
