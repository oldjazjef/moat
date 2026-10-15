import { HttpErrorResponse } from '@angular/common/http';
import { API_ERROR_CODES, apiErrorCode, apiErrorKey } from './api-error';

const failure = (status: number, error: unknown) =>
  new HttpErrorResponse({ status, error });

describe('apiErrorCode', () => {
  it("takes the API's stable code, for every code on the closed list", () => {
    for (const code of API_ERROR_CODES.filter(
      (c) => c !== 'network' && c !== 'unknown' && c !== 'not_found',
    )) {
      expect(apiErrorCode(failure(422, { statusCode: 422, error: code }))).toBe(
        code,
      );
    }
  });

  it('never lets a server text, a stack or an unlisted code reach the page', () => {
    expect(
      apiErrorCode(
        failure(500, {
          error: 'Error: password hunter2 failed at /srv/app.js',
        }),
      ),
    ).toBe('unknown');
    expect(
      apiErrorCode(failure(400, { message: ['email must be a string'] })),
    ).toBe('unknown');
    expect(apiErrorCode(failure(422, 'html page'))).toBe('unknown');
    expect(apiErrorCode(failure(422, { error: { nested: 1 } }))).toBe(
      'unknown',
    );
    expect(apiErrorCode(new Error('boom'))).toBe('unknown');
  });

  it('tells an unreachable server and a plain 404 (SEC-50) apart', () => {
    expect(apiErrorCode(failure(0, null))).toBe('network');
    expect(
      apiErrorCode(failure(404, { statusCode: 404, message: 'Not Found' })),
    ).toBe('not_found');
  });

  it('maps a code to its message key', () => {
    expect(apiErrorKey('last_owner')).toBe('errors.api.last_owner');
  });
});
