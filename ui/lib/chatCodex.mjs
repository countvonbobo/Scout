import { assertSafeModel, providerCommand } from './providers.mjs';

const SESSION_ID = /^[A-Za-z0-9-]+$/;

export function codexToolActivity(type, value = '') {
  const text = `${type || ''} ${value || ''}`.toLowerCase();
  if (/search|read|fetch|browse|source|advert/.test(text)) return 'searching';
  if (/file_change|edit|write|patch|cv\./.test(text)) return 'writing';
  return 'thinking';
}

export function buildCodexArgs(resumeId, options = {}) {
  const reasoningEffort = options.reasoningEffort || 'high';
  if (!['low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) throw new Error(`invalid reasoning effort: ${reasoningEffort}`);
  const args = [
    'exec', '--json',
    '-c', `model_reasoning_effort="${reasoningEffort}"`,
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
  ];
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const windowsSandbox = options.windowsSandbox || 'unelevated';
    if (!['elevated', 'unelevated'].includes(windowsSandbox)) throw new Error(`invalid Windows sandbox: ${windowsSandbox}`);
    args.push('-c', `windows.sandbox="${windowsSandbox}"`);
  }
  const model = assertSafeModel(options.model);
  if (model) args.push('--model', model);
  if (resumeId) {
    if (!SESSION_ID.test(resumeId)) throw new Error(`invalid session id: ${resumeId}`);
    // `resume` is an exec subcommand. Exec-level flags such as --sandbox must
    // precede it; current Codex releases reject those flags after the session id.
    args.push('resume', resumeId);
  }
  args.push('-'); // prompt arrives on stdin
  return { command: options.command || providerCommand('codex'), args, ...(options.env ? { env: options.env } : {}) };
}

export function parseCodexLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }
  if (!ev || typeof ev !== 'object') return [];

  // current `codex exec --json` shape
  if (ev.type === 'thread.started' && ev.thread_id) {
    return [{ kind: 'session', sessionId: ev.thread_id }];
  }
  if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
    const it = ev.item;
    if (it.type === 'agent_message' && it.text) return [{ kind: 'delta', text: it.text }];
    if (it.type === 'file_change') {
      return (it.changes || [])
        .map((c) => c && c.path)
        .filter(Boolean)
        .map((f) => ({ kind: 'tool', label: 'Editing a file', file: f, mutatesFile: true, activity: codexToolActivity('file_change', f) }));
    }
    if (it.type === 'command_execution') {
      return [{ kind: 'tool', label: 'Running a provider command', file: null, activity: codexToolActivity('command', it.command) }];
    }
    return [];
  }
  if (ev.type === 'turn.completed') {
    return [{ kind: 'done', text: '', ok: true, usage: ev.usage || {} }];
  }
  if (ev.type === 'turn.failed') {
    return [{ kind: 'done', text: '', ok: false, usage: {} }];
  }

  // legacy shape
  const m = ev.msg && typeof ev.msg === 'object' ? ev.msg : null;
  if (m) {
    if (m.type === 'session_configured' && m.session_id) return [{ kind: 'session', sessionId: m.session_id }];
    if (m.type === 'agent_message' && m.message) return [{ kind: 'delta', text: m.message }];
    if (m.type === 'task_complete') return [{ kind: 'done', text: m.last_agent_message || '', ok: true, usage: {} }];
    if (m.type === 'error') return [{ kind: 'done', text: '', ok: false, usage: {} }];
  }
  return [];
}
