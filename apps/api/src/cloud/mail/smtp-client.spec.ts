import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MailError } from './mail.ports';
import {
  buildMessage,
  isLoopbackHost,
  isMailbox,
  sendSmtp,
} from './smtp-client';

/** A scripted SMTP server on this machine: it records every line and answers by `reply`. */
interface Fake {
  readonly port: number;
  readonly lines: string[];
  readonly data: string[];
  readonly server: Server;
}

type Reply = (line: string, socket: Socket) => string | null | undefined;

async function fake(options: {
  greeting?: string;
  ehlo?: string[];
  reply?: Reply;
  silent?: boolean;
}): Promise<Fake> {
  const lines: string[] = [];
  const data: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding('latin1');
    let inData = false;
    let buffer = '';
    if (options.silent !== true)
      socket.write(options.greeting ?? '220 fake ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        lines.push(line);
        const custom = options.reply?.(line, socket);
        if (custom === null) continue;
        if (custom !== undefined) {
          socket.write(custom);
          continue;
        }
        if (line.startsWith('EHLO'))
          socket.write(
            [
              '250-fake',
              ...(options.ehlo ?? []).map((c) => `250-${c}`),
              '250 8BITMIME',
            ].join('\r\n') + '\r\n',
          );
        else if (line.startsWith('AUTH')) socket.write('235 ok\r\n');
        else if (line.startsWith('MAIL') || line.startsWith('RCPT'))
          socket.write('250 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 what\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return { port: address.port, lines, data, server };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const start = async (options: Parameters<typeof fake>[0]) => {
  const f = await fake(options);
  servers.push(f.server);
  return f;
};

const MESSAGE = {
  to: 'person@example.ch',
  subject: 'Moat: Passwort zurücksetzen',
  text: 'Hello\n.\n..leading dots\n',
};
const settings = (port: number, extra = {}) => ({
  host: '127.0.0.1',
  port,
  security: 'none' as const,
  from: 'noreply@moat.example.org',
  timeoutMs: 1000,
  ...extra,
});
const failure = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MailError) return error.failure;
    throw error;
  }
  return 'sent';
};

describe('sendSmtp', () => {
  it('speaks the envelope and sends the body as base64, so no line can end the message', async () => {
    const f = await start({});
    await sendSmtp(settings(f.port), MESSAGE);
    expect(f.lines).toContain('MAIL FROM:<noreply@moat.example.org>');
    expect(f.lines).toContain('RCPT TO:<person@example.ch>');
    const mail = f.data[0] ?? '';
    const [head, body] = mail.split('\r\n\r\n');
    expect(head).toContain('From: <noreply@moat.example.org>');
    expect(head).toContain('To: <person@example.ch>');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(
      Buffer.from((body ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8'),
    ).toBe('Hello\r\n.\r\n..leading dots\r\n');
    // Not one body line starts with a dot.
    expect((body ?? '').split('\r\n').some((l) => l.startsWith('.'))).toBe(
      false,
    );
  });

  it('signs in with AUTH PLAIN only when there is a password, and not to a stranger in the clear', async () => {
    const f = await start({});
    await sendSmtp(settings(f.port, { user: 'u', password: 'p' }), MESSAGE);
    const auth = f.lines.find((l) => l.startsWith('AUTH PLAIN '));
    expect(Buffer.from((auth ?? '').slice(11), 'base64').toString()).toBe(
      '\0u\0p',
    );
    // A remote host without TLS never gets as far as connecting.
    expect(
      await failure(
        sendSmtp(
          {
            ...settings(1),
            host: 'smtp.example.org',
            user: 'u',
            password: 'p',
          },
          MESSAGE,
        ),
      ),
    ).toBe('starttls_unavailable');
  });

  it('refuses to go on in the clear when STARTTLS is chosen and not offered', async () => {
    const f = await start({});
    expect(
      await failure(
        sendSmtp(
          settings(f.port, {
            security: 'starttls',
            user: 'u',
            password: 'secret-pw',
          }),
          MESSAGE,
        ),
      ),
    ).toBe('starttls_unavailable');
    // The password and the recipient never left.
    expect(
      f.lines.some((l) => l.startsWith('AUTH') || l.startsWith('RCPT')),
    ).toBe(false);
    expect(f.lines.join('\n')).not.toContain('secret-pw');
  });

  it('names a rejected recipient, a failed login, a silent server and nonsense — and nothing else', async () => {
    const rejected = await start({
      reply: (l) =>
        l.startsWith('RCPT')
          ? '550 no such user person@example.ch\r\n'
          : undefined,
    });
    const refusedRcpt = sendSmtp(settings(rejected.port), MESSAGE).catch(
      (e: Error) => e,
    );
    const e1 = await refusedRcpt;
    expect(e1).toBeInstanceOf(MailError);
    expect((e1 as MailError).failure).toBe('rejected');
    // The server's text and the address are not in the error.
    expect((e1 as Error).message).toBe('rejected');

    const badAuth = await start({
      reply: (l) => (l.startsWith('AUTH') ? '535 nope\r\n' : undefined),
    });
    expect(
      await failure(
        sendSmtp(settings(badAuth.port, { user: 'u', password: 'p' }), MESSAGE),
      ),
    ).toBe('auth_failed');

    const silent = await start({ silent: true });
    expect(
      await failure(
        sendSmtp(settings(silent.port, { timeoutMs: 150 }), MESSAGE),
      ),
    ).toBe('timeout');

    const garbage = await start({ greeting: 'HELLO THERE\r\n' });
    expect(await failure(sendSmtp(settings(garbage.port), MESSAGE))).toBe(
      'protocol',
    );

    const huge = await start({ greeting: `220-${'x'.repeat(70_000)}\r\n` });
    expect(await failure(sendSmtp(settings(huge.port), MESSAGE))).toBe(
      'protocol',
    );
  });

  it('refuses to connect when nothing listens', async () => {
    const f = await start({});
    const port = f.port;
    f.server.close();
    expect(await failure(sendSmtp(settings(port), MESSAGE))).toBe('connect');
  });

  it('does not open a connection for a message that could inject a command or a header', async () => {
    const f = await start({});
    for (const bad of [
      { ...MESSAGE, subject: 'a\r\nBcc: x@example.ch' },
      { ...MESSAGE, to: 'a@example.ch\r\nRCPT TO:<b@example.ch>' },
      { ...MESSAGE, to: 'a@example.ch>\r\n' },
      { ...MESSAGE, to: '<a@example.ch>' },
      { ...MESSAGE, to: 'a b@example.ch' },
    ])
      expect(await failure(sendSmtp(settings(f.port), bad))).toBe(
        'invalid_message',
      );
    expect(f.lines).toHaveLength(0);
    expect(
      await failure(
        sendSmtp(settings(f.port, { from: 'x@example.ch>\r\nRCPT' }), MESSAGE),
      ),
    ).toBe('invalid_message');
  });
});

describe('message building', () => {
  it('encodes a non-ASCII subject in words that stay within the line limit', () => {
    const text = buildMessage(
      { from: 'noreply@moat.example.org' },
      { ...MESSAGE, subject: 'Zurücksetzen '.repeat(10) },
    );
    for (const line of text.split('\r\n'))
      expect(line.length).toBeLessThanOrEqual(78);
    expect(text).not.toContain('ü');
  });

  it('knows a mailbox from something that is not', () => {
    expect(isMailbox('a.b+c@example.ch')).toBe(true);
    for (const bad of [
      '',
      'a@b',
      'a@@b.ch',
      'a b@c.ch',
      'a@c.ch\n',
      '<a@c.ch>',
      `${'a'.repeat(65)}@c.ch`,
    ])
      expect(isMailbox(bad)).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.example.org')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});
