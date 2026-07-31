import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchPublicResource, isPublicIpAddress, PublicHttpError, resolvePublicDestination,
} from './publicHttp.mjs';

function response({
  status = 200, url, body = '<html>ok</html>', type = 'text/html', location = null,
} = {}) {
  return {
    status,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return type;
        if (name.toLowerCase() === 'location') return location;
        return null;
      },
    },
    text: async () => body,
  };
}

test('non-public IPv4 and IPv6 destinations are rejected before a request', async () => {
  for (const address of [
    '0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.20.0.1', '192.168.1.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1',
    'fec0::1', '64:ff9b::7f00:1', '64:ff9b::101:101', '4000::1', '5f00::1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('1.1.1.1'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);

  let requests = 0;
  for (const url of [
    'http://127.0.0.1/jobs/1',
    'http://[::1]/jobs/1',
    'http://user:secret@example.com/jobs/1',
  ]) {
    await assert.rejects(fetchPublicResource(url, {
      requestImpl: async () => { requests += 1; return response(); },
    }), (error) => error instanceof PublicHttpError
      && ['unsafe-destination', 'url-invalid'].includes(error.reasonCode));
  }
  assert.equal(requests, 0);
});

test('all hostname answers are checked and mixed public/private DNS is rejected', async () => {
  const answers = [
    { address: '1.1.1.1', family: 4 },
    { address: '10.0.0.8', family: 4 },
  ];
  await assert.rejects(resolvePublicDestination('https://careers.example.test/jobs', {
    lookupFn: async (hostname, options) => {
      assert.equal(hostname, 'careers.example.test');
      assert.deepEqual(options, { all: true, verbatim: true });
      return answers;
    },
  }), (error) => error.reasonCode === 'unsafe-destination');
});

test('redirect hops are manually re-resolved and a public-to-private hop is blocked', async () => {
  const lookups = [];
  let requests = 0;
  await assert.rejects(fetchPublicResource('https://public.example.test/jobs/1', {
    lookupFn: async (hostname) => {
      lookups.push(hostname);
      return hostname === 'public.example.test'
        ? [{ address: '1.1.1.1', family: 4 }]
        : [{ address: '192.168.1.20', family: 4 }];
    },
    requestImpl: async (url, options) => {
      requests += 1;
      assert.equal(options.redirect, 'manual');
      return response({
        status: 302,
        url,
        location: 'https://internal.example.test/admin',
      });
    },
  }), (error) => error.reasonCode === 'unsafe-destination');
  assert.deepEqual(lookups, ['public.example.test', 'internal.example.test']);
  assert.equal(requests, 1);
});

test('ordinary public HTTPS responses remain usable under bounded policies', async () => {
  const result = await fetchPublicResource('https://careers.example.test/jobs/1', {
    lookupFn: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ],
    requestImpl: async (url) => response({ url, body: '<html>Apply now</html>' }),
    allowedContentTypes: ['text/html'],
    maxBytes: 100,
  });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), '<html>Apply now</html>');
});

test('bounded failures use public reason codes without leaking DNS or addresses', async () => {
  for (const [options, reasonCode] of [
    [{ lookupFn: async () => { throw new Error('ENOTFOUND secret.internal'); } }, 'dns-failed'],
    [{
      lookupFn: async () => [{ address: '1.1.1.1', family: 4 }],
      requestImpl: async () => response({ body: 'x'.repeat(20) }),
      maxBytes: 10,
    }, 'response-too-large'],
    [{
      lookupFn: async () => [{ address: '1.1.1.1', family: 4 }],
      requestImpl: async () => response({ type: 'application/octet-stream' }),
      allowedContentTypes: ['text/html'],
    }, 'content-type-invalid'],
  ]) {
    await assert.rejects(fetchPublicResource('https://public.example.test/jobs/1', options),
      (error) => error instanceof PublicHttpError
        && error.reasonCode === reasonCode
        && !error.message.includes('secret.internal'));
  }
});

test('DNS resolution is covered by the request timeout budget', async () => {
  await assert.rejects(resolvePublicDestination('https://public.example.test/jobs/1', {
    lookupFn: async () => new Promise(() => {}),
    timeoutMs: 5,
  }), (error) => error.reasonCode === 'request-timeout');
});
