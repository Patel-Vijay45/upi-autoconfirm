// Password hashing runs in a Durable Object: on the Workers Free plan a normal request gets only 10 ms of CPU,
// but a Durable Object request gets 30 s, so we can keep 100,000 PBKDF2 iterations at no cost.
// Stateless; calls are spread over a few instances.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

export class PasswordDO extends DurableObject<Env> {
	async hash(password: string): Promise<string> {
		return hashPassword(password);
	}

	async verify(password: string, stored: string | null): Promise<boolean> {
		return verifyPassword(password, stored);
	}
}

const SHARDS = 8;

export function passwordHasher(env: Env) {
	const pick = () => env.PASSWORDS.get(env.PASSWORDS.idFromName(`pw-${Math.floor(Math.random() * SHARDS)}`));
	return {
		hash: (password: string) => pick().hash(password),
		verify: (password: string, stored: string | null | undefined) => pick().verify(password, stored ?? null),
	};
}
