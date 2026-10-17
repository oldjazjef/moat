import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { MailError, type MailMessage } from './mail.ports';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  /**
   * `tls`: TLS from the first byte (port 465). `starttls`: plain greeting, then the upgrade, which
   * is **required** (a server that does not offer it is refused, never used in the clear). `none`:
   * no TLS, only for a server on this machine.
   */
  readonly security: SmtpSecurity;
  readonly user?: string;
  readonly password?: string;
  /** The envelope and header sender. */
  readonly from: string;
  readonly timeoutMs?: number;
}

const MAX_REPLY_BYTES = 64 * 1024;
const MAILBOX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** A bare address with nothing that could end a command or a header (CR, LF, `<`, `>`, a space). */
export function isMailbox(address: string): boolean {
  return address.length <= 254 && MAILBOX.test(address);
}

/** `127.0.0.1`, `::1` and `localhost`: the only hosts that may be spoken to without TLS. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

const wrap76 = (base64: string): string =>
  base64.match(/.{1,76}/g)?.join('\r\n') ?? '';

/** RFC 2047 encoded words, split at character borders so that no word passes 75 characters. */
function encodeSubject(subject: string): string {
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk !== '') words.push(chunk);
  return words
    .map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`)
    .join('\r\n ');
}

/** The message as it goes over the wire (before dot-stuffing; base64 never starts a line with a dot). */
export function buildMessage(
  settings: Pick<SmtpSettings, 'from'>,
  message: MailMessage,
  now: Date = new Date(),
): string {
  if (
    !isMailbox(message.to) ||
    !isMailbox(settings.from) ||
    /[\r\n\0]/.test(message.subject) ||
    message.subject.length > 200 ||
    message.text.length > 20_000
  )
    throw new MailError('invalid_message');
  const domain = settings.from.split('@')[1] ?? 'localhost';
  return [
    `From: <${settings.from}>`,
    `To: <${message.to}>`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    wrap76(
      Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString(
        'base64',
      ),
    ),
    '',
  ].join('\r\n');
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** A line-oriented view of one connection, with a deadline on every wait. */
class Connection {
  private buffer = '';
  private waiter: (() => void) | null = null;
  private failure: MailError | null = null;

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_REPLY_BYTES) this.fail('protocol');
      this.waiter?.();
    });
    socket.on('error', () => this.fail('connect'));
    socket.on('close', () => this.fail('connect'));
  }

  private fail(failure: ConstructorParameters<typeof MailError>[0]): void {
    this.failure ??= new MailError(failure);
    this.waiter?.();
  }

  /** The buffer must be empty before a TLS upgrade: bytes sent early would be a plaintext injection. */
  get pending(): boolean {
    return this.buffer.length > 0;
  }

  upgrade(secure: Socket): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket = secure;
    this.buffer = '';
    this.attach(secure);
  }

  get raw(): Socket {
    return this.socket;
  }

  write(text: string): void {
    this.socket.write(text, 'latin1');
  }

  async reply(): Promise<Reply> {
    const deadline = Date.now() + this.timeoutMs;
    const lines: string[] = [];
    for (;;) {
      for (;;) {
        const end = this.buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (match === null) throw new MailError('protocol');
        lines.push(match[3] ?? '');
        if (match[2] === ' ') return { code: Number(match[1]), lines };
      }
      if (this.failure !== null) throw this.failure;
      const left = deadline - Date.now();
      if (left <= 0) throw new MailError('timeout');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = null;
    }
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.on('error', () => undefined);
    this.socket.destroy();
  }
}

async function expect(
  connection: Connection,
  accepted: readonly number[],
  failure: 'protocol' | 'rejected' | 'auth_failed' = 'rejected',
): Promise<Reply> {
  const reply = await connection.reply();
  if (!accepted.includes(reply.code)) throw new MailError(failure);
  return reply;
}

async function command(
  connection: Connection,
  line: string,
  accepted: readonly number[],
  failure: 'protocol' | 'rejected' | 'auth_failed' = 'rejected',
): Promise<Reply> {
  connection.write(`${line}\r\n`);
  return expect(connection, accepted, failure);
}

function open(settings: SmtpSettings, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      settings.security === 'tls'
        ? tlsConnect({
            host: settings.host,
            port: settings.port,
            servername: settings.host,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          })
        : netConnect({ host: settings.host, port: settings.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new MailError('timeout'));
    }, timeoutMs);
    socket.once(
      settings.security === 'tls' ? 'secureConnect' : 'connect',
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
    );
    socket.once('error', () => {
      clearTimeout(timer);
      reject(new MailError('connect'));
    });
  });
}

/**
 * Sends one message. Strict on purpose: TLS certificates are always verified, STARTTLS is required
 * where it is the chosen security, a password is only ever sent over TLS (or to this machine),
 * every wait has a deadline, replies are bounded, and a failure is one of a few fixed names.
 */
export async function sendSmtp(
  settings: SmtpSettings,
  message: MailMessage,
): Promise<void> {
  if (settings.security === 'none' && !isLoopbackHost(settings.host))
    throw new MailError('starttls_unavailable');
  const timeoutMs = settings.timeoutMs ?? 15_000;
  const body = buildMessage(settings, message);
  const socket = await open(settings, timeoutMs);
  const connection = new Connection(socket, timeoutMs);
  try {
    await expect(connection, [220], 'protocol');
    const hello = 'moat-cloud.invalid';
    let capabilities = await command(
      connection,
      `EHLO ${hello}`,
      [250],
      'protocol',
    );
    if (settings.security === 'starttls') {
      if (!capabilities.lines.some((l) => l.toUpperCase() === 'STARTTLS'))
        throw new MailError('starttls_unavailable');
      await command(connection, 'STARTTLS', [220], 'protocol');
      if (connection.pending) throw new MailError('protocol');
      const secure = await new Promise<Socket>((resolve, reject) => {
        const upgraded = tlsConnect({
          socket: connection.raw,
          servername: settings.host,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        });
        upgraded.once('secureConnect', () => resolve(upgraded));
        upgraded.once('error', () => reject(new MailError('connect')));
      });
      connection.upgrade(secure);
      capabilities = await command(
        connection,
        `EHLO ${hello}`,
        [250],
        'protocol',
      );
    }
    if (settings.user !== undefined && settings.password !== undefined) {
      const encrypted = settings.security !== 'none';
      if (!encrypted && !isLoopbackHost(settings.host))
        throw new MailError('starttls_unavailable');
      const credentials = Buffer.from(
        `\0${settings.user}\0${settings.password}`,
        'utf8',
      ).toString('base64');
      await command(
        connection,
        `AUTH PLAIN ${credentials}`,
        [235],
        'auth_failed',
      );
    }
    await command(connection, `MAIL FROM:<${settings.from}>`, [250]);
    await command(connection, `RCPT TO:<${message.to}>`, [250, 251]);
    await command(connection, 'DATA', [354]);
    connection.write(`${body}.\r\n`);
    await expect(connection, [250]);
    connection.write('QUIT\r\n');
  } finally {
    connection.close();
  }
}
