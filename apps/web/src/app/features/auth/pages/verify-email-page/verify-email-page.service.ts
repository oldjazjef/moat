import { Injectable, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { tokenFromFragment } from '../../domain/link-token';

/**
 * «E-Mail-Adresse bestätigen». The link only opens this page; the token is used when the person
 * presses the button, so a mail scanner that opens links cannot use it up. The token stays in
 * this service's field (it is a one-time link token, not a credential) and is dropped once used.
 */
@Injectable()
export class VerifyEmailPageService {
  private readonly session = inject(AccountSession);
  private token: string | null = tokenFromFragment(
    inject(ActivatedRoute).snapshot.fragment,
  );

  readonly hasToken = this.token !== null;
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);

  async confirm(): Promise<void> {
    const token = this.token;
    if (token === null) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.verifyEmail(token);
      this.token = null;
      this.done.set(true);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
