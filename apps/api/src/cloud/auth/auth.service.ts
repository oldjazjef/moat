import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  type AcceptedResult,
  type AccountView,
  AuthenticateSessionQuery,
  ChangePasswordCommand,
  type ChangePasswordResult,
  ConfirmTotpCommand,
  type ConfirmTotpResult,
  DisableTotpCommand,
  type DisableTotpResult,
  EnrolTotpCommand,
  type EnrolTotpResult,
  ForgotPasswordCommand,
  GetMeQuery,
  LoginCommand,
  type LoginResult,
  LogoutCommand,
  type Principal,
  RegisterCommand,
  type RegisterResult,
  ResendVerificationCommand,
  ResetPasswordCommand,
  type ResetPasswordResult,
  VerifyEmailCommand,
  type VerifyEmailResult,
} from './application/auth.commands';

/** The façade the controller and the guards talk to (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class AuthService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  register(
    email: string,
    password: string,
    ip: string,
  ): Promise<RegisterResult> {
    return this.commands.execute(new RegisterCommand(email, password, ip));
  }

  login(
    email: string,
    password: string,
    code: string | undefined,
    ip: string,
    previousToken: string | null,
  ): Promise<LoginResult> {
    return this.commands.execute(
      new LoginCommand(email, password, code, ip, previousToken),
    );
  }

  logout(sessionId: string): Promise<void> {
    return this.commands.execute(new LogoutCommand(sessionId));
  }

  authenticate(token: string): Promise<Principal | null> {
    return this.queries.execute(new AuthenticateSessionQuery(token));
  }

  me(accountId: string): Promise<AccountView | null> {
    return this.queries.execute(new GetMeQuery(accountId));
  }

  changePassword(
    accountId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<ChangePasswordResult> {
    return this.commands.execute(
      new ChangePasswordCommand(accountId, currentPassword, newPassword),
    );
  }

  enrolTotp(accountId: string, password: string): Promise<EnrolTotpResult> {
    return this.commands.execute(new EnrolTotpCommand(accountId, password));
  }

  confirmTotp(accountId: string, code: string): Promise<ConfirmTotpResult> {
    return this.commands.execute(new ConfirmTotpCommand(accountId, code));
  }

  disableTotp(
    accountId: string,
    sessionId: string,
    password: string,
    code: string,
  ): Promise<DisableTotpResult> {
    return this.commands.execute(
      new DisableTotpCommand(accountId, sessionId, password, code),
    );
  }

  verifyEmail(token: string, ip: string): Promise<VerifyEmailResult> {
    return this.commands.execute(new VerifyEmailCommand(token, ip));
  }

  resendVerification(email: string, ip: string): Promise<AcceptedResult> {
    return this.commands.execute(new ResendVerificationCommand(email, ip));
  }

  forgotPassword(email: string, ip: string): Promise<AcceptedResult> {
    return this.commands.execute(new ForgotPasswordCommand(email, ip));
  }

  resetPassword(
    token: string,
    newPassword: string,
    ip: string,
  ): Promise<ResetPasswordResult> {
    return this.commands.execute(
      new ResetPasswordCommand(token, newPassword, ip),
    );
  }
}
