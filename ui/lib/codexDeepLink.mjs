const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32']);
const PUBLIC_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const REASON_CODES = new Set([
  'browser-device-required',
  'capability-unavailable',
  'handler-check-failed',
  'handler-missing',
  'handler-status-unknown',
  'launch-failed',
  'platform-unsupported',
]);
const SAFE_TASK_ID = /^[A-Za-z0-9-]{1,256}$/;
const RESUME_INSTRUCTION = 'If Codex does not open, copy this task ID and resume it in Codex on this device.';

function safeCheckedAt(value) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function capability(state, canAttempt, reasonCode, checkedAt, platform) {
  return {
    state,
    canAttempt,
    reasonCode,
    checkedAt: safeCheckedAt(checkedAt),
    platform,
  };
}

function safeReasonCode(value) {
  return REASON_CODES.has(value) ? value : 'capability-unavailable';
}

export function codexDeepLinkCapability(device = {}) {
  const checkedAt = device.checkedAt;
  if (device.requestAccess !== 'local') {
    return capability('remote', false, 'browser-device-required', checkedAt, null);
  }

  const platform = PUBLIC_PLATFORMS.has(device.platform) ? device.platform : 'unknown';
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return capability('unavailable', false, 'platform-unsupported', checkedAt, platform);
  }
  if (device.handler?.failed === true) {
    return capability('failed', false, 'handler-check-failed', checkedAt, platform);
  }
  if (device.handler?.registered === true) {
    return capability('supported', true, null, checkedAt, platform);
  }
  if (device.handler?.registered === false) {
    return capability('unavailable', false, 'handler-missing', checkedAt, platform);
  }
  return capability('unknown', false, 'handler-status-unknown', checkedAt, platform);
}

export function openCodexTask(task, publicCapability = {}) {
  const rawTaskId = task == null ? '' : String(task);
  const boundedTaskId = rawTaskId.length <= 256 ? rawTaskId : null;
  const valid = SAFE_TASK_ID.test(rawTaskId);
  const canNavigate = valid
    && publicCapability.state === 'supported'
    && publicCapability.canAttempt === true;
  if (canNavigate) {
    return {
      state: 'attempting',
      canNavigate: true,
      href: `codex://threads/${encodeURIComponent(rawTaskId)}`,
      taskId: rawTaskId,
      success: false,
      acknowledged: false,
      reasonCode: 'awaiting-device',
      resumeInstruction: RESUME_INSTRUCTION,
    };
  }
  return {
    state: 'fallback',
    canNavigate: false,
    href: null,
    taskId: boundedTaskId,
    success: false,
    acknowledged: false,
    reasonCode: valid ? safeReasonCode(publicCapability.reasonCode) : 'invalid-task-id',
    resumeInstruction: RESUME_INSTRUCTION,
  };
}
