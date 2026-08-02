import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 8_000;

export class PublicHttpError extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.name = 'PublicHttpError';
    this.reasonCode = reasonCode;
  }
}

function ipv4Number(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)
    || Number(part) > 255)) return null;
  return parts.reduce((number, part) => (number * 256) + Number(part), 0) >>> 0;
}

function ipv4In(value, base, prefix) {
  const number = ipv4Number(value);
  const start = ipv4Number(base);
  if (number === null || start === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (number & mask) === (start & mask);
}

const BLOCKED_IPV4 = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);

const blockedIpv6 = new net.BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) blockedIpv6.addSubnet(address, prefix, 'ipv6');
const globallyRoutableIpv6 = new net.BlockList();
globallyRoutableIpv6.addSubnet('2000::', 3, 'ipv6');

function mappedIpv4(value) {
  const match = String(value).toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (match) return match[1];
  const hex = String(value).toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPublicIpAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return !BLOCKED_IPV4.some(([base, prefix]) => ipv4In(address, base, prefix));
  if (family !== 6) return false;
  const mapped = mappedIpv4(address);
  if (mapped) return isPublicIpAddress(mapped);
  return globallyRoutableIpv6.check(address, 'ipv6')
    && !blockedIpv6.check(address, 'ipv6');
}

function hostnameValue(url) {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1) : url.hostname;
}

export function publicUrl(value, base) {
  let url;
  try { url = new URL(String(value), base); } catch { throw new PublicHttpError('url-invalid'); }
  if (url.toString().length > 4_096) throw new PublicHttpError('url-invalid');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PublicHttpError('url-invalid');
  }
  const hostname = hostnameValue(url);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new PublicHttpError('unsafe-destination');
  }
  const literal = net.isIP(hostname);
  if (literal && !isPublicIpAddress(hostname)) throw new PublicHttpError('unsafe-destination');
  url.hash = '';
  return url;
}

function normalizedAddresses(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => {
    const address = typeof entry === 'string' ? entry : entry?.address;
    const family = Number(typeof entry === 'object' ? entry?.family : net.isIP(address));
    return { address: String(address || ''), family };
  });
}

export async function resolvePublicDestination(value, {
  lookupFn = dns.lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const url = value instanceof URL ? publicUrl(value.toString()) : publicUrl(value);
  const hostname = hostnameValue(url);
  const literalFamily = net.isIP(hostname);
  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    let answer;
    let timer;
    try {
      answer = await Promise.race([
        lookupFn(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new PublicHttpError('request-timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      throw new PublicHttpError('dns-failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
    addresses = normalizedAddresses(answer);
  }
  if (!addresses.length
    || addresses.some(({ address, family }) => ![4, 6].includes(family)
      || net.isIP(address) !== family
      || !isPublicIpAddress(address))) {
    throw new PublicHttpError('unsafe-destination');
  }
  return { url, addresses };
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted);
  return Array.isArray(entry?.[1]) ? entry[1].join(', ') : entry?.[1] ?? null;
}

function publicResponse({ status, url, headers, body }) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => headerValue(headers, name) },
    text: async () => bytes.toString('utf8'),
    json: async () => JSON.parse(bytes.toString('utf8')),
  };
}

function requestPinned(url, {
  method, headers, signal, timeoutMs, address, family, maxBytes,
}) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reasonCode) => {
      if (settled) return;
      settled = true;
      reject(new PublicHttpError(reasonCode));
    };
    const request = client.request(url, {
      method,
      headers,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
      ...(url.protocol === 'https:' ? { servername: hostnameValue(url) } : {}),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          request.destroy();
          fail('response-too-large');
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(publicResponse({
          status: Number(response.statusCode || 0),
          url: url.toString(),
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      response.on('error', () => fail('request-failed'));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail('request-timeout');
    });
    request.on('error', () => fail('request-failed'));
    if (signal) {
      const abort = () => {
        request.destroy();
        fail('request-timeout');
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    request.end();
  });
}

function acceptableContentType(response, allowedContentTypes, method) {
  if (!allowedContentTypes?.length || method === 'HEAD') return true;
  const type = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  return type && allowedContentTypes.some((allowed) => (
    allowed.endsWith('/*') ? type.startsWith(allowed.slice(0, -1))
      : allowed.includes('*+') ? type.startsWith(allowed.split('*')[0])
        && type.endsWith(allowed.split('*')[1])
        : type === allowed
  ));
}

async function materializeInjectedResponse(response, url, maxBytes) {
  const body = await response.text();
  if (Buffer.byteLength(body) > maxBytes) throw new PublicHttpError('response-too-large');
  return publicResponse({
    status: Number(response.status || 0),
    url: response.url || url.toString(),
    headers: response.headers,
    body,
  });
}

export async function fetchPublicResource(value, {
  method = 'GET',
  headers = {},
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  allowedContentTypes = null,
  allowedOrigin = null,
  lookupFn = dns.lookup,
  requestImpl = null,
} = {}) {
  let target = publicUrl(value);
  const origin = allowedOrigin ? publicUrl(allowedOrigin).origin : null;
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (origin && target.origin !== origin) throw new PublicHttpError('external-redirect');
    const { addresses } = await resolvePublicDestination(target, { lookupFn, timeoutMs });
    const [{ address, family }] = addresses;
    let response;
    try {
      if (requestImpl) {
        const raw = await requestImpl(target.toString(), {
          method, headers, redirect: 'manual', signal: signal || AbortSignal.timeout(timeoutMs),
        });
        response = await materializeInjectedResponse(raw, target, maxBytes);
      } else {
        response = await requestPinned(target, {
          method, headers, signal, timeoutMs, address, family, maxBytes,
        });
      }
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new PublicHttpError('request-timeout');
      }
      throw new PublicHttpError('request-failed');
    }
    const reported = publicUrl(response.url || target.toString(), target);
    if (reported.toString() !== target.toString()) {
      await resolvePublicDestination(reported, { lookupFn, timeoutMs });
      if (origin && reported.origin !== origin) throw new PublicHttpError('external-redirect');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= maxRedirects) throw new PublicHttpError('redirect-limit');
      const location = response.headers.get('location');
      if (!location) throw new PublicHttpError('redirect-invalid');
      target = publicUrl(location, target);
      continue;
    }
    if (!acceptableContentType(response, allowedContentTypes, method)) {
      throw new PublicHttpError('content-type-invalid');
    }
    return response;
  }
}
