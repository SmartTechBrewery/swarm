import { describe, expect, it } from 'vitest';
import { passwordLinkUrl } from './password-link.js';

describe('passwordLinkUrl', () => {
	it('builds the set-password link on the given origin', () => {
		expect(passwordLinkUrl('https://swarm.example.com', 'abc_DEF-123')).toBe(
			'https://swarm.example.com/set-password?token=abc_DEF-123',
		);
	});

	it('encodes the token', () => {
		expect(passwordLinkUrl('http://localhost:5173', 'a+b/c=&d')).toBe(
			'http://localhost:5173/set-password?token=a%2Bb%2Fc%3D%26d',
		);
	});
});
