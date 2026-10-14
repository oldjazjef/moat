import { isIP } from 'node:net';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import {
  type ConnectionOptions,
  type PeerCertificate,
  TLSSocket,
  getCACertificates,
} from 'node:tls';
import { Client, FTPError, type FTPContext, type FTPResponse } from 'basic-ftp';
import {
  connectForPassiveTransfer,
  parseEpsvResponse,
  parsePasvResponse,
} from 'basic-ftp/dist/transfer';
import type { FtpsCertificate, FtpsMode } from '../../shared/ftps-dialog';
import type { DeployFile } from './deploy';

/** Where and as whom (DT-05). Always TLS: `mode` only says how it starts. */
export interface FtpsConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly mode: FtpsMode;
}

export type FtpsUploadResult =
  /**
   * First contact with a certificate no CA vouches for: TLS is up, nothing else was sent; the
   * person compares `certificate` first.
   */
  | {
      readonly status: 'certificate_unknown';
      readonly certificate: FtpsCertificate;
    }
  /** Another certificate than the one pinned (and no CA vouches for it): refused before USER. */
  | {
      readonly status: 'certificate_changed';
      readonly certificate: FtpsCertificate;
    }
  /** The server offers no TLS (plain FTP only), the handshake failed, or it refused `PROT P`. */
  | { readonly status: 'tls_failed' }
  | { readonly status: 'auth_failed' }
  | { readonly status: 'connect_failed' }
  /** The package's folder is on the server already; nothing was written. */
  | { readonly status: 'exists' }
  /** The remote folder is missing or not writable; nothing was written. */
  | { readonly status: 'upload_failed' }
  /** The package folder was created, then a step failed or timed out: it is incomplete. */
  | { readonly status: 'partial' }
  | { readonly status: 'uploaded' };

/** Enough for a slow shared host: the control connection's idle time and every data connect. */
export const FTPS_TIMEOUT_MS = 20_000;

/** `SHA256:AB:CD:…`, 32 bytes as Node's `fingerprint256`. */
export const FTPS_FINGERPRINT = /^SHA256(?::[0-9A-F]{2}){32}$/;

/**
 * The CAs a certificate may chain to: Node's bundled store plus the operating system's (where
 * the person's own CA would be). Read per upload; an older runtime has only the bundled ones.
 */
export function trustedCas(): string[] {
  const all = new Set<string>(getCACertificates('default'));
  try {
    for (const ca of getCACertificates('system')) all.add(ca);
  } catch {
    // No system store on this platform or runtime: the bundled CAs only.
  }
  return [...all];
}

/**
 * Connects over TLS only (explicit `AUTH TLS` or implicit), and decides about the certificate
 * before a user name or password is sent: one that chains to a trusted CA and names `host` is
 * accepted; any other must be exactly `pinned` (null: only learn it and stop). Then it logs in,
 * insists on protected data connections (`PROT P`) and writes the package as a new folder
 * `<remoteDir>/<folder>/`: `MKD` fails when it exists, and before each `STOR` the file must be
 * absent, so nothing on the server is ever replaced. Passive mode only, always to the control
 * connection's address (the address in a PASV answer is ignored: no FTP bounce), and every data
 * connection must show the same certificate. No other command.
 */
export async function uploadPackage(
  connection: FtpsConnection,
  pinned: string | null,
  remoteDir: string,
  files: readonly DeployFile[],
  cas: readonly string[] = trustedCas(),
): Promise<FtpsUploadResult> {
  // Never into a command line: a CR or LF would end the command early (command injection).
  if (/\p{Cc}/u.test(connection.password + connection.username))
    return { status: 'auth_failed' };
  const client = new Client(FTPS_TIMEOUT_MS);
  client.prepareTransfer = passiveToControlHost;
  const progress = { made: false };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FtpsUploadResult>((resolve) => {
    timer = setTimeout(() => {
      client.close();
      resolve({ status: 'connect_failed' });
    }, FTPS_TIMEOUT_MS * 3);
  });
  try {
    const work = run(
      client,
      connection,
      pinned,
      remoteDir,
      files,
      cas,
      progress,
    )
      // A lost connection, a refused transfer or the timeout's close: never its text (SEC-46).
      .catch((): FtpsUploadResult => ({ status: 'connect_failed' }));
    const result = await Promise.race([work, timeout]);
    return progress.made && result.status !== 'uploaded'
      ? { status: 'partial' }
      : result;
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

async function run(
  client: Client,
  connection: FtpsConnection,
  pinned: string | null,
  remoteDir: string,
  files: readonly DeployFile[],
  cas: readonly string[],
  progress: { made: boolean },
): Promise<FtpsUploadResult> {
  const tls: ConnectionOptions = {
    // The identity the certificate must name, and the one data connections resume under.
    host: connection.host,
    ...(isIP(connection.host) === 0 ? { servername: connection.host } : {}),
    ca: [...cas],
    minVersion: 'TLSv1.2',
    // Node would close the connection on a self-signed certificate before Moat can show it.
    // The decision is made below, before anything but the handshake is sent: CA-verified or
    // exactly the pinned certificate.
    rejectUnauthorized: false,
  };
  if (connection.mode === 'implicit') {
    try {
      await client.connectImplicitTLS(connection.host, connection.port, tls);
    } catch (error) {
      return { status: tlsError(error) ? 'tls_failed' : 'connect_failed' };
    }
  } else {
    try {
      await client.connect(connection.host, connection.port);
    } catch {
      return { status: 'connect_failed' };
    }
    try {
      // A server that answers AUTH TLS with an error offers plain FTP only: Moat stops here.
      await client.useTLS(tls);
    } catch {
      return { status: 'tls_failed' };
    }
  }

  const socket = client.ftp.socket;
  if (!(socket instanceof TLSSocket) || socket.getCipher() === undefined)
    return { status: 'tls_failed' };
  const certificate = certificateOf(socket.getPeerCertificate());
  if (certificate === null) return { status: 'tls_failed' };
  if (!socket.authorized) {
    if (pinned === null) return { status: 'certificate_unknown', certificate };
    if (certificate.fingerprint !== pinned)
      return { status: 'certificate_changed', certificate };
  }

  try {
    await client.login(connection.username, connection.password);
  } catch (error) {
    return {
      status:
        error instanceof FTPError && error.code === 530
          ? 'auth_failed'
          : 'connect_failed',
    };
  }
  try {
    await client.send('TYPE I');
    await client.send('PBSZ 0');
    // Unprotected data connections would carry the package in clear: refused, not ignored.
    await client.send('PROT P');
  } catch {
    return { status: 'tls_failed' };
  }

  const folder = files[0]?.name.split('/')[0];
  if (folder === undefined) return { status: 'upload_failed' };
  const target = posix.join(remoteDir, folder);
  const made = await client.sendIgnoringError(`MKD ${target}`);
  if (made.code !== 257 && made.code !== 250) {
    // FTP has no "exists" code for MKD: look whether a folder of that name is there.
    const there = await client.sendIgnoringError(`CWD ${target}`);
    return { status: there.code === 250 ? 'exists' : 'upload_failed' };
  }
  progress.made = true;
  let listed: Set<string> | null = null;
  for (const file of files) {
    const path = posix.join(remoteDir, file.name);
    const size = await client.sendIgnoringError(`SIZE ${path}`);
    if (size.code === 213) return { status: 'upload_failed' };
    if (size.code !== 550) {
      // SIZE not supported: the folder's listing says whether the name is taken.
      listed ??= new Set(
        (await client.list(target)).map((entry) => entry.name),
      );
      if (listed.has(posix.basename(path))) return { status: 'upload_failed' };
    }
    const data = Buffer.from(file.data);
    await client.uploadFrom(Readable.from([data]), path);
    const written = await client.sendIgnoringError(`SIZE ${path}`);
    if (
      written.code === 213 &&
      Number(written.message.slice(4).trim()) !== data.length
    )
      return { status: 'upload_failed' };
  }
  return { status: 'uploaded' };
}

/**
 * Passive mode to the control connection's address only: EPSV names just a port, and the
 * address in a PASV answer is ignored (an FTP server must not send Moat elsewhere: no FTP bounce,
 * no SSRF). The data connection is TLS with the control connection's session (basic-ftp reuses
 * it) and must show the same certificate, or it is closed before a byte is written.
 */
async function passiveToControlHost(ftp: FTPContext): Promise<FTPResponse> {
  const control = ftp.socket;
  const host = control.remoteAddress?.replace(/^::ffff:/i, '');
  if (!(control instanceof TLSSocket) || host === undefined)
    throw new Error('no TLS control connection');
  let response: FTPResponse;
  let port: number;
  try {
    response = await ftp.request('EPSV');
    port = parseEpsvResponse(response.message);
  } catch (error) {
    if (ftp.closed) throw error;
    response = await ftp.request('PASV');
    port = parsePasvResponse(response.message).port;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('bad passive port');
  await connectForPassiveTransfer(host, port, ftp);
  const data = ftp.dataSocket;
  const expected = control.getPeerCertificate().fingerprint256;
  if (!(data instanceof TLSSocket) || !expected) {
    data?.destroy();
    throw new Error('data connection without TLS');
  }
  // Registered before the transfer's own listener, so it runs first. A resumed session is the
  // control connection's own (only that server holds its secret); a new one must show the same
  // certificate.
  data.once('secureConnect', () => {
    if (
      !data.isSessionReused() &&
      data.getPeerCertificate().fingerprint256 !== expected
    )
      data.destroy(new Error('data connection shows another certificate'));
  });
  return response;
}

/** The certificate as the person compares it; null when the server showed none. */
export function certificateOf(cert: PeerCertificate): FtpsCertificate | null {
  const fingerprint = `SHA256:${cert.fingerprint256}`;
  if (!FTPS_FINGERPRINT.test(fingerprint)) return null;
  return {
    fingerprint,
    subject: distinguishedName(cert.subject),
    issuer: distinguishedName(cert.issuer),
    validTo: printable(String(cert.valid_to ?? '')),
  };
}

function distinguishedName(name: unknown): string {
  if (typeof name !== 'object' || name === null) return '';
  return printable(
    Object.entries(name as Record<string, unknown>)
      .map(
        ([key, value]) =>
          `${key}=${Array.isArray(value) ? value.join(' + ') : String(value)}`,
      )
      .join(', '),
  );
}

/** The server chooses these strings: printable characters only, and not too many. */
function printable(text: string): string {
  return text.replace(/[\p{C}]/gu, '').slice(0, 300);
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

/** Implicit TLS: the server was reached, but no TLS came up (a plain FTP server, a bad handshake). */
function tlsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return !(typeof code === 'string' && UNREACHABLE.has(code));
}
