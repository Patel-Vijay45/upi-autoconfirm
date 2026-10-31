import type { EngineErrorCode } from '@autoconfirm/core';

export type ErrorType = 'invalid_request' | 'authentication' | 'permission' | 'not_found' | 'conflict' | 'rate_limit' | 'api_error';

export class ApiError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500,
		readonly type: ErrorType,
		readonly code: string,
		message: string,
		readonly param?: string,
	) {
		super(message);
	}
}

export const notFound = (what = 'resource') => new ApiError(404, 'not_found', 'not_found', `${what} not found`);
export const unauthorized = (message = 'invalid or missing credentials') => new ApiError(401, 'authentication', 'unauthorized', message);

export function fromEngine(code: EngineErrorCode | string, message: string): ApiError {
	switch (code) {
		case 'amount_too_small':
		case 'amount_too_large':
		case 'invalid_amount':
			return new ApiError(400, 'invalid_request', code, message, 'amount');
		case 'invalid_ttl':
			return new ApiError(400, 'invalid_request', code, message, 'expires_in');
		case 'not_found':
			return new ApiError(404, 'not_found', code, message);
		case 'replayed_nonce':
			return new ApiError(401, 'authentication', code, message);
		case 'slots_exhausted':
		case 'duplicate_id':
		case 'invalid_state':
		case 'undo_window_passed':
		case 'amount_in_use':
			return new ApiError(409, 'conflict', code, message);
		default:
			return new ApiError(500, 'api_error', 'internal', 'internal error');
	}
}
