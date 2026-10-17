import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../config/runtime-env';
import type { AccountView, SessionAnswer } from './account.types';

/**
 * Who is signed in (Moat Cloud only). The session itself is the `HttpOnly` cookie the API sets —
 * this app never sees it. What it keeps, in memory only, is the account and the CSRF token the API
 * hands out on sign-in and on `GET /auth/me`, which `csrfInterceptor` sends with every unsafe
 * request (T-78). Nothing here goes to `localStorage` or `sessionStorage`, and no password is
 * kept: the methods take it as an argument and forget it.
 */
@Injectable({ providedIn: 'root' })
export class AccountSession {
  private readonly http = inject(HttpClient);
  private readonly current = signal<AccountView | null>(null);
  private csrf: string | null = null;
  private checked = false;
  private loading: Promise<AccountView | null> | null = null;

  readonly account = this.current.asReadonly();
  readonly signedIn = computed(() => this.current() !== null);

  /** The CSRF token for the interceptor; null when nobody is signed in. */
  csrfToken(): string | null {
    return this.csrf;
  }

  /** The account of the cookie's session (cached; `force` asks again). Null when signed out. */
  load(force = false): Promise<AccountView | null> {
    if (this.checked && !force) return Promise.resolve(this.current());
    this.loading ??= firstValueFrom(
      this.http.get<SessionAnswer>(apiUrl('/auth/me')),
    )
      .then((answer) => this.adopt(answer))
      .catch(() => {
        this.clear();
        return null;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** Always answers the same, whether or not the address was new (T-79). */
  async register(email: string, password: string): Promise<void> {
    await firstValueFrom(
      this.http.post(apiUrl('/auth/register'), { email, password }),
    );
  }

  /** One use of the link token from the mail; rejects with `invalid_token` for any bad one. */
  async verifyEmail(token: string): Promise<void> {
    await firstValueFrom(
      this.http.post(apiUrl('/auth/verify-email'), { token }),
    );
  }

  /** Always answers the same, whether or not the address has an account (T-79). */
  async resendVerification(email: string): Promise<void> {
    await firstValueFrom(
      this.http.post(apiUrl('/auth/resend-verification'), { email }),
    );
  }

  /** Always answers the same, whether or not the address has an account (T-79). */
  async forgotPassword(email: string): Promise<void> {
    await firstValueFrom(
      this.http.post(apiUrl('/auth/forgot-password'), { email }),
    );
  }

  /** Nobody is signed in by it: the person signs in with the new password afterwards. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await firstValueFrom(
      this.http.post(apiUrl('/auth/reset-password'), { token, newPassword }),
    );
  }

  /** Rejects with the API's error; `mfa_required` asks for `code`. */
  async login(email: string, password: string, code?: string): Promise<void> {
    const body: { email: string; password: string; code?: string } = {
      email,
      password,
    };
    if (code !== undefined && code !== '') body.code = code;
    const answer = await firstValueFrom(
      this.http.post<SessionAnswer>(apiUrl('/auth/login'), body),
    );
    this.adopt(answer);
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(apiUrl('/auth/logout'), {}));
    } finally {
      // Whatever the server said, this browser forgets the account.
      this.clear();
    }
  }

  /** A password change ends every session and answers with a fresh CSRF token for this one. */
  adoptCsrf(csrfToken: string): void {
    this.csrf = csrfToken;
  }

  /** The 'two-factor enabled' flag changed on the account page. */
  setTotp(enabled: boolean): void {
    const account = this.current();
    if (account) this.current.set({ ...account, totpEnabled: enabled });
  }

  /** The API said the session is gone. */
  expire(): void {
    this.clear();
  }

  private adopt(answer: SessionAnswer): AccountView {
    this.current.set(answer.account);
    this.csrf = answer.csrfToken;
    this.checked = true;
    return answer.account;
  }

  private clear(): void {
    this.current.set(null);
    this.csrf = null;
    this.checked = true;
  }
}
