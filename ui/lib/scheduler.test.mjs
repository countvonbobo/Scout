import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProviderHealthMonitor, describeScheduleDays, isEveryDay, linuxSystemdUnits, macLaunchAgent, nativeScheduleNames, nextScheduledRun, normaliseScheduleDays, registerDailySchedule, scheduleSummary, scheduledLogicalWindow, scheduledProviderPreflight, scheduledRequestExpiry, schedulerRegistrationScript, taskXml } from './scheduler.mjs';

test('scheduled task is catch-up enabled, non-overlapping and time limited', () => {
  const xml = taskXml({ command: 'node.exe', args: ['tools/scout.mjs', 'scan'], workingDirectory: 'C:\\Scout', time: '07:30', userId: 'user', now: new Date(2026, 6, 11, 8, 0) });
  assert.match(xml, /<StartBoundary>2026-07-12T07:30:00<\/StartBoundary>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT45M<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test('scheduled task rejects invalid times', () => {
  assert.throws(() => taskXml({ command: 'node', workingDirectory: '.', time: '25:00' }), /HH:MM/);
});

test('nextScheduledRun chooses today or tomorrow in local time', () => {
  const before = new Date(2026, 6, 11, 6, 0);
  const sameDay = new Date(nextScheduledRun('07:30', before));
  assert.deepEqual([sameDay.getDate(), sameDay.getHours(), sameDay.getMinutes()], [11, 7, 30]);
  const after = new Date(2026, 6, 11, 8, 0);
  const nextDay = new Date(nextScheduledRun('07:30', after));
  assert.deepEqual([nextDay.getDate(), nextDay.getHours(), nextDay.getMinutes()], [12, 7, 30]);
});

test('scheduleSummary distinguishes saved configuration from a live task', () => {
  const config = { ai: { provider: 'claude' }, schedule: { jobs: [
    { id: 'claude-primary', enabled: true, time: '07:30', provider: 'claude', mode: 'primary' },
    { id: 'codex-second-pass', enabled: true, time: '08:30', provider: 'codex', mode: 'second-pass' },
  ] } };
  const missing = scheduleSummary(config, { lastRunAt: null }, [{ ok: false, supported: true }, { ok: false, supported: true }], new Date('2026-07-11T06:00:00.000Z'));
  assert.equal(missing.configured, true);
  assert.equal(missing.enabled, false);
  const live = scheduleSummary(config, { lastRunAt: '2026-07-11T05:00:00Z', healthy: false, degraded: true }, [{ ok: true, supported: true }, { ok: true, supported: true }], new Date('2026-07-11T06:00:00.000Z'));
  assert.equal(live.enabled, true);
  assert.equal(live.runs.length, 2);
  assert.equal(live.lastResult, 'degraded');
  const next = new Date(live.nextRunAt);
  assert.deepEqual([next.getHours(), next.getMinutes()], [7, 30]);
});

test('nextScheduledRun honours Europe/London across daylight saving time', () => {
  assert.equal(nextScheduledRun('07:30', new Date('2026-07-11T06:00:00.000Z'), 'Europe/London'), '2026-07-11T06:30:00.000Z');
  assert.equal(nextScheduledRun('07:30', new Date('2026-12-11T06:00:00.000Z'), 'Europe/London'), '2026-12-11T07:30:00.000Z');
  assert.throws(() => nextScheduledRun('07:30', new Date(), 'Europe/London; reboot'), /valid IANA timezone/);
});

test('scheduled logical window identifies the current configured occurrence separately from next expiry', () => {
  assert.equal(
    scheduledLogicalWindow('07:30', new Date('2026-07-27T08:05:00.000Z'), 'Europe/London', [1, 2, 3, 4, 5]),
    '2026-07-27T06:30:00.000Z',
  );
  assert.equal(
    nextScheduledRun('07:30', new Date('2026-07-27T08:05:00.000Z'), 'Europe/London', [1, 2, 3, 4, 5]),
    '2026-07-28T06:30:00.000Z',
  );
});

test('scheduled queue expiry is the earlier of the next window and 12 hours', () => {
  assert.equal(scheduledRequestExpiry('2026-07-27T08:00:00.000Z', '2026-07-27T10:00:00.000Z'), '2026-07-27T10:00:00.000Z');
  assert.equal(scheduledRequestExpiry('2026-07-27T08:00:00.000Z', '2026-07-28T09:00:00.000Z'), '2026-07-27T20:00:00.000Z');
});

test('each named job receives a distinct native scheduler identity', () => {
  assert.notDeepEqual(nativeScheduleNames('claude-primary'), nativeScheduleNames('codex-second-pass'));
  assert.equal(nativeScheduleNames('codex-second-pass').linux, 'scout-daily-scan-codex-second-pass');
});

test('native registration creates a persistent least-privilege daily task', () => {
  const script = schedulerRegistrationScript();
  assert.match(script, /New-ScheduledTaskTrigger -Daily/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /Register-ScheduledTask/);
  let call;
  const result = registerDailySchedule({ scriptFile: 'register.ps1', command: 'node.exe', argumentsText: 'scan', workingDirectory: 'C:\\Scout', time: '07:30', spawn(command, args) { call = { command, args }; return { status: 0, stdout: '' }; } });
  assert.equal(result.ok, process.platform === 'win32');
  if (process.platform === 'win32') { assert.equal(call.command, 'powershell.exe'); assert.ok(call.args.includes('07:30')); }
});

test('macOS launch agent uses a daily calendar and argument array', () => {
  const plist = macLaunchAgent({ command: '/app/node', args: ['/app/scout.mjs', 'scan', '--workspace', ['', 'Users', 'A User', 'Scout'].join('/')], workingDirectory: '/app', time: '07:30' });
  assert.match(plist, /app\.scout\.daily-scan/); assert.match(plist, /<key>Hour<\/key><integer>7<\/integer>/); assert.match(plist, /<key>Minute<\/key><integer>30<\/integer>/); assert.match(plist, /\/Users\/A User\/Scout/);
});

test('Linux user timer is persistent, bounded and safely quoted', () => {
  const units = linuxSystemdUnits({ command: '/opt/scout/runtime/node', args: ['/opt/scout/app/tools/scout.mjs', 'scan', '--workspace', ['', 'home', 'a', 'Scout Workspace'].join('/')], workingDirectory: '/opt/Scout App', time: '07:30' });
  assert.match(units.timer, /OnCalendar=\*-\*-\* 07:30:00 Europe\/London/); assert.match(units.timer, /Persistent=true/); assert.match(units.service, /RuntimeMaxSec=2700/); assert.match(units.service, /"\/home\/a\/Scout Workspace"/);
  assert.match(units.service, /Type=exec/);
  assert.match(units.service, /WorkingDirectory=\/opt\/Scout\\x20App/);
});

const MON_WED_FRI = [1, 3, 5];
const TUE_THU_SAT = [2, 4, 6];

test('an absent or empty day selection keeps the every-day behaviour', () => {
  assert.deepEqual(normaliseScheduleDays(null), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normaliseScheduleDays(undefined), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(normaliseScheduleDays([]), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(isEveryDay([]), true);
});

test('day selections are de-duplicated, sorted and bounded', () => {
  assert.deepEqual(normaliseScheduleDays([5, 1, 5, 3]), MON_WED_FRI);
  assert.deepEqual(normaliseScheduleDays([1, 9, -2, 'x', 3, 5]), MON_WED_FRI);
  assert.equal(isEveryDay(MON_WED_FRI), false);
});

test('day selections are described for the interface', () => {
  assert.equal(describeScheduleDays([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(describeScheduleDays([1, 2, 3, 4, 5]), 'Weekdays');
  assert.equal(describeScheduleDays(MON_WED_FRI), 'Mon, Wed, Fri');
  assert.equal(describeScheduleDays(TUE_THU_SAT), 'Tue, Thu, Sat');
});

test('Windows uses a weekly trigger only for a day subset', () => {
  const everyDay = taskXml({ command: 'node.exe', workingDirectory: 'C:\Scout', time: '07:30', userId: 'user', now: new Date(2026, 6, 11, 8, 0) });
  assert.match(everyDay, /<ScheduleByDay><DaysInterval>1<\/DaysInterval><\/ScheduleByDay>/);

  const subset = taskXml({ command: 'node.exe', workingDirectory: 'C:\Scout', time: '07:30', userId: 'user', days: MON_WED_FRI, now: new Date(2026, 6, 11, 8, 0) });
  assert.match(subset, /<ScheduleByWeek><WeeksInterval>1<\/WeeksInterval><DaysOfWeek><Monday \/><Wednesday \/><Friday \/><\/DaysOfWeek><\/ScheduleByWeek>/);
  // 2026-07-11 is a Saturday, so the first Mon/Wed/Fri run is Monday the 13th.
  assert.match(subset, /<StartBoundary>2026-07-13T07:30:00<\/StartBoundary>/);
});

test('systemd restricts OnCalendar to the selected days', () => {
  const everyDay = linuxSystemdUnits({ id: 'claude-primary', command: '/usr/bin/node', args: ['scan'], workingDirectory: ['', 'home', 'user', 'Scout'].join('/'), time: '07:30', timezone: 'Europe/London' });
  assert.match(everyDay.timer, /OnCalendar=\*-\*-\* 07:30:00 Europe\/London/);

  const subset = linuxSystemdUnits({ id: 'claude-primary', command: '/usr/bin/node', args: ['scan'], workingDirectory: ['', 'home', 'user', 'Scout'].join('/'), time: '07:30', timezone: 'Europe/London', days: MON_WED_FRI });
  assert.match(subset.timer, /OnCalendar=Mon,Wed,Fri \*-\*-\* 07:30:00 Europe\/London/);
  assert.match(subset.timer, /Persistent=true/);
});

test('launchd repeats daily for every day and lists weekdays for a subset', () => {
  const everyDay = macLaunchAgent({ id: 'claude-primary', command: '/usr/bin/node', args: ['scan'], workingDirectory: ['', 'Users', 'user', 'Scout'].join('/'), time: '07:30' });
  assert.match(everyDay, /<key>StartCalendarInterval<\/key><dict><key>Hour<\/key><integer>7<\/integer>/);

  const subset = macLaunchAgent({ id: 'codex-second-pass', command: '/usr/bin/node', args: ['scan'], workingDirectory: ['', 'Users', 'user', 'Scout'].join('/'), time: '08:30', days: TUE_THU_SAT });
  assert.match(subset, /<key>StartCalendarInterval<\/key><array>/);
  for (const day of TUE_THU_SAT) {
    assert.match(subset, new RegExp(`<dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>30</integer></dict>`));
  }
});

test('the Windows registration script takes a weekly trigger only when days are given', () => {
  const script = schedulerRegistrationScript();
  assert.match(script, /New-ScheduledTaskTrigger -Daily -At \$at/);
  assert.match(script, /New-ScheduledTaskTrigger -Weekly -DaysOfWeek \$selected -At \$at/);
  assert.match(script, /\[Parameter\(Mandatory=\$false\)\]\[string\]\$Days/);
});

test('nextScheduledRun skips days that are not selected', () => {
  // Saturday 2026-07-11 08:00 local.
  const saturday = new Date(2026, 6, 11, 8, 0);
  assert.equal(new Date(nextScheduledRun('07:30', saturday, null, MON_WED_FRI)).getDay(), 1);
  assert.equal(new Date(nextScheduledRun('07:30', saturday, null, TUE_THU_SAT)).getDay(), 2);
  // Later the same day still counts when that day is selected.
  const mondayEarly = new Date(2026, 6, 13, 6, 0);
  const next = new Date(nextScheduledRun('07:30', mondayEarly, null, MON_WED_FRI));
  assert.equal(next.getDate(), 13);
  assert.equal(next.getHours(), 7);
});

test('two alternating jobs never fall on the same day', () => {
  const now = new Date(2026, 6, 11, 8, 0);
  const primary = [];
  const second = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const at = new Date(now.getTime() + offset * 86400000);
    primary.push(new Date(nextScheduledRun('07:30', at, null, MON_WED_FRI)).toDateString());
    second.push(new Date(nextScheduledRun('08:30', at, null, TUE_THU_SAT)).toDateString());
  }
  assert.equal(primary.some((day) => second.includes(day)), false);
});

test('scheduleSummary reports the selected days and the next matching run', () => {
  const config = {
    timezone: 'Europe/London',
    schedule: { jobs: [{ id: 'claude-primary', enabled: true, time: '07:30', days: MON_WED_FRI, provider: 'claude', mode: 'primary' }] },
  };
  const summary = scheduleSummary(config, null, [{ ok: true, supported: true }], new Date('2026-07-11T08:00:00Z'));
  assert.deepEqual(summary.runs[0].days, MON_WED_FRI);
  assert.equal(summary.runs[0].daysLabel, 'Mon, Wed, Fri');
  assert.equal(new Date(summary.runs[0].nextRunAt).getUTCDay(), 1);
});

test('scheduled provider preflight checks enabled jobs only with a bounded identity', async () => {
  const calls = [];
  const preflight = async (...args) => {
    calls.push(args);
    return { ok: true, provider: args[1], state: 'ready', purpose: args[2], verified: true };
  };
  assert.deepEqual(
    await scheduledProviderPreflight('/synthetic/workspace', {
      id: 'codex-second-pass',
      enabled: true,
      provider: 'codex',
    }, { preflight }),
    { ok: true, provider: 'codex', state: 'ready', purpose: 'scheduled-job', jobId: 'codex-second-pass', verified: true },
  );
  assert.deepEqual(calls, [['/synthetic/workspace', 'codex', 'scheduled-job', { source: 'scheduled-preflight' }]]);

  assert.deepEqual(
    await scheduledProviderPreflight('/synthetic/workspace', {
      id: 'claude-primary',
      enabled: false,
      provider: 'claude',
    }, { preflight }),
    { ok: false, provider: 'claude', purpose: 'scheduled-job', state: 'checking', jobId: 'claude-primary', reasonCode: 'schedule-disabled' },
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    scheduledProviderPreflight('/synthetic/workspace', {
      id: `codex-${'x'.repeat(65)}`,
      enabled: true,
      provider: 'codex',
    }, { preflight }),
    /job id/,
  );
});

test('scheduled provider preflight returns only bounded allowlisted health evidence', async () => {
  const result = await scheduledProviderPreflight('/synthetic/workspace', {
    id: 'claude-primary',
    enabled: true,
    provider: 'claude',
  }, {
    preflight: async () => ({
      ok: false,
      provider: 'claude',
      purpose: 'scheduled-job',
      state: 'sign-in-required',
      reasonCode: 'authentication-required',
      checkedAt: '2026-07-29T08:30:00.000Z',
      alertId: 'provider-health:claude:sign-in-required',
      shouldNotify: true,
      raw: `token=${'secret'} person@example.test ${['', 'Users', 'example'].join('/')}`,
    }),
  });
  assert.deepEqual(result, {
    ok: false,
    provider: 'claude',
    purpose: 'scheduled-job',
    state: 'sign-in-required',
    jobId: 'claude-primary',
    reasonCode: 'authentication-required',
    checkedAt: '2026-07-29T08:30:00.000Z',
    alertId: 'provider-health:claude:sign-in-required',
    shouldNotify: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|person@|Users|raw/);

  const redacted = await scheduledProviderPreflight('/synthetic/workspace', {
    id: 'codex-primary',
    enabled: true,
    provider: 'codex',
  }, {
    preflight: async () => ({
      ok: false,
      state: 'provider-error',
      reasonCode: 'token-secret',
      alertId: 'private-user',
    }),
  });
  assert.equal(redacted.reasonCode, 'preflight-failed');
  assert.equal('alertId' in redacted, false);
});

test('periodic provider monitor coalesces enabled jobs and isolates providers', async () => {
  const calls = [];
  const monitor = createProviderHealthMonitor({
    root: '/synthetic/workspace',
    getScheduleJobs: () => [
      { id: 'claude-primary', enabled: true, provider: 'claude' },
      { id: 'claude-second', enabled: true, provider: 'claude' },
      { id: 'codex-second-pass', enabled: true, provider: 'codex' },
      { id: 'codex-disabled', enabled: false, provider: 'codex' },
    ],
    preflight: async (root, provider, purpose) => {
      calls.push([root, provider, purpose]);
      if (provider === 'claude') throw new Error('synthetic provider failure with private body');
      return { ok: true, provider, state: 'ready', purpose };
    },
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
  });

  const results = await monitor.runNow();
  assert.deepEqual(calls, [
    ['/synthetic/workspace', 'claude', 'periodic'],
    ['/synthetic/workspace', 'codex', 'periodic'],
  ]);
  assert.deepEqual(results, [
    { ok: false, provider: 'claude', purpose: 'periodic', state: 'provider-error', reasonCode: 'preflight-failed' },
    { ok: true, provider: 'codex', purpose: 'periodic', state: 'ready' },
  ]);
  assert.doesNotMatch(JSON.stringify(results), /private body/);
  monitor.stop();
});

test('periodic provider monitor is single-flight, supports runNow and stops cleanly', async () => {
  let calls = 0;
  let release;
  let scheduledTick;
  let scheduledCount = 0;
  let cleared = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const monitor = createProviderHealthMonitor({
    root: '/synthetic/workspace',
    getScheduleJobs: () => [{ id: 'codex-primary', enabled: true, provider: 'codex' }],
    preflight: async () => {
      calls += 1;
      await pending;
      return { ok: true, provider: 'codex', state: 'ready' };
    },
    intervalMs: 60_000,
    setInterval: (callback, interval) => {
      assert.equal(interval, 60_000);
      scheduledCount += 1;
      scheduledTick = callback;
      return { unref() {} };
    },
    clearInterval: () => { cleared = true; },
  });

  const first = monitor.runNow();
  const shared = monitor.runNow();
  scheduledTick();
  assert.equal(first, shared);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, [{ ok: true, provider: 'codex', purpose: 'periodic', state: 'ready' }]);

  monitor.stop();
  assert.equal(cleared, true);
  assert.deepEqual(await monitor.runNow(), []);
  assert.equal(calls, 1);
  monitor.resume();
  assert.equal(scheduledCount, 2);
  assert.deepEqual(await monitor.runNow(), [{
    ok: true, provider: 'codex', purpose: 'periodic', state: 'ready',
  }]);
  assert.equal(calls, 2);
  monitor.stop();
});

test('provider monitor drainage waits for in-flight provider work to release', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const monitor = createProviderHealthMonitor({
    root: '/synthetic/workspace',
    getScheduleJobs: () => [{ id: 'codex-primary', enabled: true, provider: 'codex' }],
    preflight: async () => {
      await pending;
      return { ok: true, provider: 'codex', state: 'ready' };
    },
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
  });
  const run = monitor.runNow();
  const drain = monitor.drain();
  let drained = false;
  void drain.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await Promise.all([run, drain]);
  assert.equal(drained, true);
});

test('provider monitor never invokes scan or queue work', async () => {
  const forbidden = () => { throw new Error('scan or queue invocation is forbidden'); };
  const monitor = createProviderHealthMonitor({
    root: '/synthetic/workspace',
    getScheduleJobs: () => [{ id: 'claude-primary', enabled: true, provider: 'claude' }],
    preflight: async () => ({ ok: true, provider: 'claude', state: 'ready' }),
    scan: forbidden,
    enqueue: forbidden,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
  });
  assert.deepEqual(await monitor.runNow(), [{ ok: true, provider: 'claude', purpose: 'periodic', state: 'ready' }]);
  monitor.stop();
});
