import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkAdvert, checkAdverts, classifyStatus, isGenericIndexUrl, looksClosed, partitionLiveCandidates, redirectedToIndex,
} from './advertLiveness.mjs';

const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];

function response({ status = 200, url, body = '<html><body>Apply now</body></html>' } = {}) {
  return {
    status,
    url,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : null },
    text: async () => body,
  };
}

// A fetch stub that answers per URL and records how it was called.
function stubFetch(routes, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url, method: options.method });
    const route = routes[url];
    if (!route) throw new Error(`unexpected url ${url}`);
    const value = typeof route === 'function' ? route(options) : route;
    if (value instanceof Error) throw value;
    return { ...value, url: value.url ?? url };
  };
}

test('status codes only close an advert on a definite not-found', () => {
  assert.equal(classifyStatus(404), 'gone');
  assert.equal(classifyStatus(410), 'gone');
  assert.equal(classifyStatus(200), 'live');
  for (const status of [401, 403, 429, 500, 502, 503]) {
    assert.equal(classifyStatus(status), 'unverified', `HTTP ${status} says nothing about the advert`);
  }
});

test('closed-advert phrasing is detected regardless of spacing and case', () => {
  assert.equal(looksClosed('This job is\n  NO LONGER ACCEPTING   Applications.'), true);
  assert.equal(looksClosed('The position has been filled.'), true);
  assert.equal(looksClosed('We are hiring a platform engineer. Apply now.'), false);
});

test('a redirect to the board index is treated as gone, other redirects are not', () => {
  assert.equal(redirectedToIndex('https://board.test/jobs/123', 'https://board.test/jobs'), true);
  assert.equal(redirectedToIndex('https://board.test/jobs/123', 'https://board.test/'), true);
  assert.equal(redirectedToIndex('https://board.test/jobs/123', 'https://board.test/jobs/456'), false);
  assert.equal(redirectedToIndex('https://board.test/jobs/123', 'https://other.test/jobs'), false);
  assert.equal(redirectedToIndex('https://board.test/jobs', 'https://board.test/jobs'), false);
});

test('generic board and careers indexes are never accepted as verified adverts', async () => {
  assert.equal(isGenericIndexUrl('https://example.test/careers'), true);
  assert.equal(isGenericIndexUrl('https://example.test/jobs-in-f1/'), true);
  assert.equal(isGenericIndexUrl('https://example.test/en/jobs/233355463f-electronics-support-engineer'), false);
  let fetched = false;
  const result = await checkAdvert('https://example.test/jobs-in-f1/', {
    fetchFn: async () => { fetched = true; throw new Error('should not fetch'); },
  });
  assert.equal(result.state, 'gone');
  assert.match(result.reason, /not an individual advert/);
  assert.equal(fetched, false);
});

test('a 404 advert is closed without fetching its body', async () => {
  const calls = [];
  const url = 'https://board.test/jobs/1';
  const result = await checkAdvert(url, {
    fetchFn: stubFetch({ [url]: response({ status: 404 }) }, calls),
    lookupFn: publicLookup,
  });
  assert.equal(result.state, 'gone');
  assert.match(result.reason, /404/);
  assert.deepEqual(calls.map((call) => call.method), ['HEAD']);
});

test('a 200 advert that says it is closed is caught by the body check', async () => {
  const url = 'https://board.test/jobs/2';
  const result = await checkAdvert(url, {
    fetchFn: stubFetch({ [url]: response({ body: '<p>This role has been filled.</p>' }) }),
    lookupFn: publicLookup,
  });
  assert.equal(result.state, 'gone');
  assert.equal(result.reason, 'advert says it is closed');
});

test('an open advert is live and confirmed with a GET after HEAD', async () => {
  const calls = [];
  const url = 'https://board.test/jobs/3';
  const result = await checkAdvert(url, {
    fetchFn: stubFetch({ [url]: response({}) }, calls),
    lookupFn: publicLookup,
  });
  assert.equal(result.state, 'live');
  assert.deepEqual(calls.map((call) => call.method), ['HEAD', 'GET']);
  assert.ok(result.checkedAt);
});

test('a HEAD that fails still allows the GET to decide', async () => {
  const url = 'https://board.test/jobs/4';
  const fetchFn = async (target, options) => {
    if (options.method === 'HEAD') throw new Error('HEAD not supported');
    return { ...response({}), url: target };
  };
  assert.equal((await checkAdvert(url, { fetchFn, lookupFn: publicLookup })).state, 'live');
});

test('network failures are unverified and never close an advert', async () => {
  const url = 'https://board.test/jobs/5';
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const timedOut = await checkAdvert(url, {
    fetchFn: stubFetch({ [url]: timeout }), lookupFn: publicLookup,
  });
  assert.equal(timedOut.state, 'unverified');
  assert.equal(timedOut.reason, 'timed out');

  const dns = await checkAdvert(url, {
    fetchFn: stubFetch({ [url]: new Error('getaddrinfo ENOTFOUND') }),
    lookupFn: publicLookup,
  });
  assert.equal(dns.state, 'unverified');
  assert.notEqual(dns.state, 'gone');
});

test('private advert destinations and DNS rebinding answers are never requested', async () => {
  let requests = 0;
  for (const [url, lookupFn] of [
    ['http://127.0.0.1/jobs/5', publicLookup],
    ['http://[::1]/jobs/5', publicLookup],
    ['https://board.test/jobs/5', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]],
  ]) {
    const result = await checkAdvert(url, {
      fetchFn: async () => { requests += 1; return response({}); },
      lookupFn,
    });
    assert.equal(result.state, 'unverified');
    assert.equal(result.reason, 'destination is not public');
  }
  assert.equal(requests, 0);
});

test('liveness failures expose bounded reasons, not internal DNS or socket details', async () => {
  const result = await checkAdvert('https://board.test/jobs/5', {
    lookupFn: async () => { throw new Error('ENOTFOUND database.service.internal 10.0.0.3'); },
    fetchFn: async () => { throw new Error('must not request'); },
  });
  assert.equal(result.state, 'unverified');
  assert.equal(result.reason, 'destination could not be verified');
  assert.doesNotMatch(result.reason, /database|10\\.0\\.0\\.3|ENOTFOUND/);
});

test('concurrency is bounded and each host is paced', async () => {
  const urls = Array.from({ length: 8 }, (_, index) => `https://board.test/jobs/${index}`);
  let inFlight = 0;
  let peak = 0;
  const fetchFn = async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return { ...response({}), url };
  };
  const waits = [];
  const results = await checkAdverts(urls, {
    fetchFn, lookupFn: publicLookup, concurrency: 3, hostDelayMs: 5,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(results.size, 8);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
  assert.ok(waits.length > 0, 'same-host requests should be paced');
});

test('an exhausted time budget leaves the rest unverified rather than stalling', async () => {
  const urls = ['https://a.test/1', 'https://b.test/2', 'https://c.test/3'];
  let clock = 0;
  const results = await checkAdverts(urls, {
    fetchFn: async (url) => { clock += 1000; return { ...response({}), url }; },
    lookupFn: publicLookup,
    concurrency: 1, budgetMs: 1500, hostDelayMs: 0, now: () => clock,
  });
  const states = urls.map((url) => results.get(url).state);
  assert.equal(states[0], 'live');
  assert.ok(states.slice(1).includes('unverified'));
  assert.match(results.get(urls[2]).reason, /budget/);
});

test('only definitely closed candidates are removed from a scan', async () => {
  const candidates = [
    { candidateId: 'candidate-001', url: 'https://board.test/open' },
    { candidateId: 'candidate-002', url: 'https://board.test/closed' },
    { candidateId: 'candidate-003', url: 'https://board.test/unreachable' },
  ];
  const fetchFn = stubFetch({
    'https://board.test/open': response({}),
    'https://board.test/closed': response({ status: 410 }),
    'https://board.test/unreachable': new Error('socket hang up'),
  });
  const result = await partitionLiveCandidates(candidates, {
    fetchFn, lookupFn: publicLookup, hostDelayMs: 0,
  });
  assert.deepEqual(result.live.map((item) => item.candidateId), ['candidate-001', 'candidate-003']);
  assert.deepEqual(result.removed.map((item) => item.candidateId), ['candidate-002']);
  assert.equal(result.summary.gone, 1);
  assert.equal(result.summary.unverified, 1);
});
