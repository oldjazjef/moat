/**
 * TEST ONLY: a minimal FTPS server for `ftps-client.spec.ts` (T-69), over a temp folder, with a
 * throwaway self-signed certificate made at run time (nothing secret in the repository). Just
 * enough FTP for Moat's upload: AUTH TLS, USER/PASS, TYPE, PBSZ, PROT, EPSV/PASV, MKD, CWD,
 * SIZE, LIST, STOR, QUIT. Never imported by the app.
 */
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { join } from 'node:path';
import { createSecureContext, type SecureContext, TLSSocket } from 'node:tls';

export interface TestCertificate {
  readonly key: string;
  readonly cert: string;
  /** `SHA256:AB:…` as the client pins it. */
  readonly fingerprint: string;
}

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (...bytes: number[]) => der(0x06, Buffer.from(bytes));
const ED25519 = seq(oid(0x2b, 0x65, 0x70));
const name = (cn: string) =>
  seq(der(0x31, seq(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(cn)))));
const utcTime = (date: Date) =>
  der(
    0x17,
    Buffer.from(
      `${date.toISOString().slice(2, 19).replace(/[-T:]/g, '')}Z`,
      'latin1',
    ),
  );

/**
 * A self-signed Ed25519 certificate for 127.0.0.1 and localhost, built with Node's own key
 * generation and signature (the DER around it by hand: Node cannot issue certificates).
 */
export function testCertificate(
  cn = 'ftps.test',
  /** false: no subjectAltName, so it names no address Moat connects to. */
  names = true,
): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const san = seq(
    oid(0x55, 0x1d, 0x11),
    der(
      0x04,
      seq(
        der(0x87, Buffer.from([127, 0, 0, 1])),
        der(0x82, Buffer.from('localhost')),
      ),
    ),
  );
  const serial = Buffer.from(
    Array.from({ length: 8 }, (_, i) => (i === 0 ? 0x11 : (now >> i) & 0xff)),
  );
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ED25519,
    name(cn),
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    ...(names ? [der(0xa3, seq(san))] : []),
  );
  const signature = sign(null, tbs, privateKey);
  const certificate = seq(
    tbs,
    ED25519,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const cert = `-----BEGIN CERTIFICATE-----\n${
    certificate
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  }\n-----END CERTIFICATE-----\n`;
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert,
    fingerprint: `SHA256:${new X509Certificate(cert).fingerprint256}`,
  };
}

export interface TestServerOptions {
  readonly root: string;
  readonly password: string;
  /** TLS from the first byte (implicit FTPS). */
  readonly implicit?: boolean;
  /** Plain FTP only: AUTH TLS is refused. */
  readonly plain?: boolean;
  /** Refuse EPSV, so the client must use PASV. */
  readonly noEpsv?: boolean;
  /** The address the PASV answer names (the real data port is on 127.0.0.1 regardless). */
  readonly pasvAddress?: string;
  /** Refuse SIZE (502), so the client must list the folder. */
  readonly noSize?: boolean;
  /** Refuse PROT P. */
  readonly noProt?: boolean;
}

/** One FTPS server on 127.0.0.1; `commands` logs every command (PASS without its value). */
export class TestFtpsServer {
  readonly commands: string[] = [];
  /** File names whose STOR fails (to break an upload halfway). */
  readonly refuse = new Set<string>();
  /** Whether each protected data connection resumed the control connection's TLS session. */
  readonly dataResumed: boolean[] = [];
  private context: SecureContext;
  private dataContext: SecureContext | null = null;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  constructor(
    private certificate: TestCertificate,
    private readonly options: TestServerOptions,
  ) {
    this.context = this.contextOf(certificate);
    this.server = createServer((socket) => this.accept(socket));
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  use(certificate: TestCertificate): void {
    this.certificate = certificate;
    this.context = this.contextOf(certificate);
  }

  listen(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, '127.0.0.1', () => resolve()),
    );
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private contextOf(
    certificate: TestCertificate,
    ticketKey = 7,
  ): SecureContext {
    const context = createSecureContext({
      key: certificate.key,
      cert: certificate.cert,
    });
    // Session tickets need keys on the context (a tls.Server would set them).
    context.context.setTicketKeys(Buffer.alloc(48, ticketKey));
    return context;
  }

  private secure(socket: Socket, context = this.context): TLSSocket {
    const secured = new TLSSocket(socket, {
      isServer: true,
      secureContext: context,
    });
    this.sockets.add(secured);
    secured.on('error', () => secured.destroy());
    return secured;
  }

  private accept(raw: Socket): void {
    this.sockets.add(raw);
    raw.on('error', () => raw.destroy());
    let socket: Socket = this.options.implicit ? this.secure(raw) : raw;
    let protectedData = false;
    let data: Promise<{ socket: Socket; bytes: Buffer }> | null = null;
    let buffer = '';
    const reply = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };
    const inside = (path: string) =>
      join(this.options.root, path.replace(/^\/+/, ''));
    const passive = (): Promise<number> =>
      new Promise((resolve) => {
        const server = createServer();
        let resolveData: (value: {
          socket: Socket;
          bytes: Buffer;
        }) => void = () => undefined;
        data = new Promise((done) => {
          resolveData = done;
        });
        server.once('connection', (rawData) => {
          server.close();
          this.sockets.add(rawData);
          rawData.on('error', () => rawData.destroy());
          const stream = protectedData
            ? this.secure(rawData, this.dataContext ?? this.context)
            : rawData;
          if (stream instanceof TLSSocket)
            stream.once('secure', () =>
              this.dataResumed.push(stream.isSessionReused()),
            );
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => stream.end());
          stream.on('close', () =>
            resolveData({ socket: stream, bytes: Buffer.concat(chunks) }),
          );
          // LIST writes through it before the client ends it.
          resolveDataSocket(stream);
        });
        let resolveDataSocket: (stream: Socket) => void = () => undefined;
        dataSocket = new Promise((done) => {
          resolveDataSocket = done;
        });
        server.listen(0, '127.0.0.1', () =>
          resolve((server.address() as AddressInfo).port),
        );
      });
    let dataSocket: Promise<Socket> | null = null;

    const handle = async (line: string) => {
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const arg = space < 0 ? '' : line.slice(space + 1);
      this.commands.push(verb === 'PASS' ? 'PASS' : line);
      switch (verb) {
        case 'AUTH':
          if (this.options.plain || socket instanceof TLSSocket)
            return reply('500 AUTH not understood');
          reply('234 AUTH TLS ok');
          socket.removeAllListeners('data');
          socket = this.secure(raw);
          socket.on('data', onData);
          return;
        case 'USER':
          return reply('331 Password required');
        case 'PASS':
          return reply(
            arg === this.options.password
              ? '230 Logged in'
              : '530 Login incorrect',
          );
        case 'TYPE':
        case 'PBSZ':
          return reply('200 OK');
        case 'PROT':
          if (this.options.noProt) return reply('534 Not supported');
          protectedData = arg.toUpperCase() === 'P';
          return reply('200 OK');
        case 'EPSV':
          if (this.options.noEpsv) return reply('502 Not implemented');
          return reply(
            `229 Entering Extended Passive Mode (|||${await passive()}|)`,
          );
        case 'PASV': {
          const port = await passive();
          const address = (this.options.pasvAddress ?? '127.0.0.1').replace(
            /\./g,
            ',',
          );
          return reply(
            `227 Entering Passive Mode (${address},${port >> 8},${port & 0xff})`,
          );
        }
        case 'MKD':
          try {
            mkdirSync(inside(arg));
            return reply(`257 "${arg}" created`);
          } catch {
            return reply('550 Cannot create');
          }
        case 'CWD':
          return existsSync(inside(arg)) && statSync(inside(arg)).isDirectory()
            ? reply('250 OK')
            : reply('550 No such folder');
        case 'SIZE':
          if (this.options.noSize) return reply('502 Not implemented');
          return existsSync(inside(arg)) && statSync(inside(arg)).isFile()
            ? reply(`213 ${statSync(inside(arg)).size}`)
            : reply('550 No such file');
        case 'LIST': {
          const path = arg.replace(/^-a\s*/, '');
          const stream = await dataSocket;
          if (stream === null) return reply('425 No data connection');
          reply('150 Listing');
          const names = existsSync(inside(path))
            ? readdirSync(inside(path))
            : [];
          stream.end(
            names
              .map((entry) => `-rw-r--r-- 1 u g 1 Jan 01 2026 ${entry}\r\n`)
              .join(''),
          );
          await data;
          return reply('226 Done');
        }
        case 'STOR': {
          const file = inside(arg);
          if (this.refuse.has(arg.split('/').pop() ?? '')) {
            (await dataSocket)?.destroy();
            return reply('550 Refused');
          }
          reply('150 Ready');
          const received = await data;
          if (received === null) return reply('425 No data');
          try {
            writeFileSync(file, received.bytes, { flag: 'wx' });
            return reply('226 Stored');
          } catch {
            return reply('550 Cannot store');
          }
        }
        case 'QUIT':
          reply('221 Bye');
          return socket.end();
        default:
          return reply('502 Not implemented');
      }
    };
    let queue = Promise.resolve();
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        queue = queue.then(async () => {
          await handle(line);
        });
      }
    };
    socket.on('data', onData);
    reply('220 Moat test FTPS');
  }

  /**
   * Data connections show `certificate` instead of the control connection's, and cannot resume
   * its session (other ticket keys): an impostor on the data port.
   */
  useOnData(certificate: TestCertificate): void {
    this.dataContext = this.contextOf(certificate, 9);
  }
}
