import { assertSafeModel, providerCommand } from './providers.mjs';

const SESSION_ID = /^[A-Za-z0-9-]+$/;

export function buildClaudeArgs(resumeId, options = {}) {
  const permissionMode = options.permissionMode || 'acceptEdits';
  if (!['acceptEdits', 'auto'].includes(permissionMode)) throw new Error(`invalid Claude permission mode: ${permissionMode}`);
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', permissionMode,
  ];
  const model = assertSafeModel(options.model);
  if (model) args.push('--model', model);
  if (resumeId) {
    if (!SESSION_ID.test(resumeId)) throw new Error(`invalid session id: ${resumeId}`);
    args.push('--resume', resumeId);
  }
  return { command: options.command || providerCommand('claude'), args, ...(options.env ? { env: options.env } : {}) };
}

function fileOfToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.path || input.notebook_path || null;
}

function mutatesFile(name) {
  return /^(?:write|edit|multiedit|notebookedit|applypatch)$/i.test(String(name || '').replace(/[^a-z]/gi, ''));
}

export function claudeToolActivity(name, file) {
  const value = `${name || ''} ${file || ''}`.toLowerCase();
  if (/web|search|read|fetch|browse/.test(value)) return 'searching';
  if (/write|edit|patch|notebook/.test(value)) return 'writing';
  return 'thinking';
}

export function parseClaudeLine(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return []; }
  if (!ev || typeof ev !== 'object') return [];
  const out = [];
  if (ev.type === 'system' && ev.session_id) {
    out.push({ kind: 'session', sessionId: ev.session_id });
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) {
        out.push({ kind: 'delta', text: block.text });
      } else if (block.type === 'tool_use') {
        const file = fileOfToolInput(block.input);
        const activity = claudeToolActivity(block.name, file);
        out.push({
          kind: 'tool',
          label: mutatesFile(block.name) ? 'Editing a file' : 'Using provider tools',
          file,
          mutatesFile: mutatesFile(block.name),
          activity,
        });
      }
    }
  }
  if (ev.type === 'result') {
    if (ev.session_id) out.push({ kind: 'session', sessionId: ev.session_id });
    const structured = ev.structured_output && typeof ev.structured_output === 'object'
      ? JSON.stringify(ev.structured_output)
      : null;
    out.push({
      kind: 'done',
      text: ev.is_error === true ? '' : (structured || (typeof ev.result === 'string' ? ev.result : '')),
      ok: ev.is_error !== true,
      usage: { costUsd: ev.total_cost_usd ?? null, ...(ev.usage || {}) },
    });
  }
  return out;
}
