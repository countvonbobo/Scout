import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadChat, saveChat, emptyChat, appendMessage, addFilesTouched, recordHandoff, chatPurpose,
} from './chatStore.mjs';
import { buildClaudeArgs, parseClaudeLine } from './chatClaude.mjs';
import { buildCodexArgs, parseCodexLine } from './chatCodex.mjs';
import { runTurn } from './chatRun.mjs';
import { buildPrefills, HANDOFF_SUMMARY_PROMPT, handoffOpening, slugOf } from './chatPrompts.mjs';
import { runCvQuality } from './cvQuality.mjs';
import { artifactSlugFor, chooseArtifactSlug } from './cvArtifacts.mjs';
import { listCvFiles } from './cv.mjs';
import { readUsage } from './usage.mjs';
import {
  detectedModels, effectiveProviderModel, isSafeModelId, providerModelCatalogue,
} from './providerModels.mjs';
import { loadWorkspaceConfig, modelForProvider } from './workspace.mjs';
import { detectProviderModelCataloguesAsync, providerStatus } from './providers.mjs';
import { runStructuredTurn } from './structuredTurn.mjs';
import {
  interviewPrepAgentPrompt, interviewPrepPrefills, readInterviewPrep,
} from './interviewPrep.mjs';

export const ENGINES = {
  claude: { build: buildClaudeArgs, parse: parseClaudeLine },
  codex: { build: buildCodexArgs, parse: parseCodexLine },
};

const running = new Map(); // opportunity id -> { stop() }

export function activeChatTurnCount() { return running.size; }
export const ONBOARDING_CHAT_ID = 'setup-onboarding';

const FIT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' }, strengths: { type: 'array', items: { type: 'string' } },
    evidenceGaps: { type: 'array', items: { type: 'string' } },
    mandatoryGaps: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string' },
  }, required: ['summary', 'strengths', 'evidenceGaps', 'mandatoryGaps', 'recommendation'],
});

function replyJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function sseStart(res) {
  res.on('error', () => { /* client disconnected mid-stream - writes are guarded */ });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function sseSend(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseEnd(res) {
  if (res.destroyed || res.writableEnded) return;
  res.end();
}

function parseBody(body) {
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

function nowIso() { return new Date().toISOString(); }

function assistantUpdates(result) {
  const updates = (result?.updates || []).map((value) => String(value || '').trim()).filter(Boolean);
  return updates.length ? updates : (result?.text ? [result.text] : []);
}

function stopTurnOnDisconnect(req, res, id) {
  const stop = () => {
    if (res.writableEnded) return;
    const turn = running.get(id);
    if (turn) turn.stop();
  };
  req.on('aborted', stop);
  res.on('close', stop);
}

export function registerChatRoutes({
  routes, repoRoot, readTracker, runTurnFn = runTurn, saveChatFn = saveChat, providerStatusFn = providerStatus,
  providerCataloguesFn = detectProviderModelCataloguesAsync,
  runCvQualityFn = runCvQuality, runStructuredTurnFn = runStructuredTurn, onCheckpoint = () => {},
}) {
  function checkpoint(reason) { Promise.resolve(onCheckpoint(reason)).catch(() => {}); }
  // A conversation may pin its own model. Without one it follows the provider
  // default from settings, so existing chats keep working unchanged.
  function engineStatus(engine, modelOverride = null) {
    const config = loadWorkspaceConfig(repoRoot);
    const status = providerStatusFn(engine);
    if (!status.installed || !status.authenticated) throw new Error(`${engine} CLI is not installed and signed in`);
    return { config, status, model: modelOverride || modelForProvider(config, engine) };
  }

  function engineBuild(engine, resumeId, modelOverride = null) {
    const { status, model } = engineStatus(engine, modelOverride);
    return ENGINES[engine].build(resumeId, {
      model, command: status.executable, env: status.env,
      ...(engine === 'codex' ? { reasoningEffort: 'medium' } : {}),
    });
  }
  function entryOf(id) {
    if (id === ONBOARDING_CHAT_ID) {
      return { id, company: 'Scout', role: 'Workspace setup', sources: [], notes: '' };
    }
    return (readTracker().opportunities || []).find((o) => o.id === id) || null;
  }

  function selectedEntryContext(entry) {
    if (!entry || entry.id === ONBOARDING_CHAT_ID) return '';
    const selected = {
      id: entry.id, company: entry.company, role: entry.role, status: entry.status, score: entry.score,
      scoreBreakdown: entry.scoreBreakdown || {}, eligibility: entry.eligibility || null,
      mandatoryRequirements: entry.mandatoryRequirements || [], location: entry.location || entry.commute || null,
      salary: entry.salary || null, sources: (entry.sources || []).slice(0, 5), notes: String(entry.notes || '').slice(0, 4000),
      application: entry.application || null, contacts: (entry.contacts || []).slice(0, 20),
    };
    return `Selected opportunity (authoritative; do not choose another tracker entry):\n${JSON.stringify(selected)}`;
  }

  function boundedFile(relative, maximum = 30_000) {
    const file = path.join(repoRoot, relative);
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').slice(0, maximum);
  }

  // The folder the agent must write into. The browser prompts the user when an
  // existing legacy company folder could be reused, and passes their answer back
  // as `requested`; chooseArtifactSlug only honours it if it matches a slug this
  // server would itself resolve for this opportunity, so an arbitrary path from a
  // request body can never redirect a write.
  function artifactSlugForEntry(entry, requested = '') {
    let existing = [];
    try { existing = listCvFiles(repoRoot).applications || []; } catch { existing = []; }
    let opportunities = [];
    try { opportunities = readTracker().opportunities || []; } catch { opportunities = []; }
    return chooseArtifactSlug(existing, entry, slugOf, opportunities, requested);
  }

  // After a turn, review whichever of this opportunity's own folders the agent
  // actually touched - the per-role folder, or a legacy company folder the user
  // explicitly chose to reuse. Never any other role's folder.
  function refreshCvQuality(entry, filesTouched = []) {
    if (!entry || entry.id === ONBOARDING_CHAT_ID) return [];
    const touched = (filesTouched || []).map((file) => String(file));
    const candidates = [artifactSlugFor(entry), slugOf(entry.company)].filter(Boolean);
    const slug = candidates.find((value) => touched.some((file) => file.startsWith(`applications/${value}/`)));
    if (!slug) return [];
    const source = path.join(repoRoot, 'applications', slug, 'cv.typ');
    const evidence = path.join(repoRoot, 'applications', slug, 'cv-evidence.json');
    if (!fs.existsSync(source) || !fs.existsSync(evidence)) return [];
    const config = loadWorkspaceConfig(repoRoot);
    try {
      runCvQualityFn(repoRoot, slug, { locale: config.locale });
      return [`applications/${slug}/cv-quality.json`, `applications/${slug}/cv.pdf`];
    } catch {
      return [];
    }
  }

  function onboardingPrefill(config) {
    const interests = [...(config.search?.roleFamilies || []), ...(config.search?.sectors || [])];
    return [
      'Use $onboard-scout to finish setting up and tuning my private Scout workspace.',
      `Workspace: ${repoRoot}`,
      `Selected AI provider: ${config.ai?.provider || 'not selected'}`,
      interests.length ? `Initial interests: ${interests.join(', ')}.` : '',
      'Interview me one focused question at a time about missing career evidence, roles, sectors, compensation, locations, commute, dealbreakers, tone, and employer preferences.',
      'Never invent facts. Stage every proposed profile, calibration, CV, lane, and source change under .scout/onboarding for review. Explain the staged changes and wait for my explicit approval before activation.',
      'Remain local-first and never submit an application or send outreach.',
    ].filter(Boolean).join('\n\n');
  }

  routes['GET /api/chat'] = (req, res, body, url) => {
    const id = url.searchParams.get('id') || '';
    let purpose;
    try { purpose = chatPurpose(url.searchParams.get('purpose') || 'job'); }
    catch (e) { return replyJson(res, 400, { error: e.message }); }
    let entry;
    try { entry = entryOf(id); } catch (e) { return replyJson(res, 500, { error: `tracker unreadable: ${e.message}` }); }
    if (!entry) return replyJson(res, 404, { error: 'no such opportunity' });
    let chat;
    try { chat = loadChat(repoRoot, id, purpose); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    // A failed cold start has no resumable CLI session. Keep its error history,
    // but expose an unset engine so the other installed CLI remains selectable.
    const visibleChat = chat && !chat.cliSessionId && !chat.bounded ? { ...chat, engine: null } : chat;
    const config = loadWorkspaceConfig(repoRoot);
    const cvOptions = {
      xyz: url.searchParams.get('xyz') !== '0',
      humanize: url.searchParams.get('humanize') !== '0',
    };
    return replyJson(res, 200, {
      exists: !!chat,
      chat: visibleChat,
      purpose,
      artifact: purpose === 'interview-prep' ? readInterviewPrep(repoRoot, entry) : null,
      prefills: id === ONBOARDING_CHAT_ID
        ? { ask: onboardingPrefill(config), review: 'Review the currently staged onboarding changes. Summarise each proposed change, flag any unsupported claims or missing evidence, and do not activate anything.', approve: 'I have reviewed the staged onboarding changes. Validate them once more, show me the exact files that will be activated, and ask for final confirmation before activation.' }
        : purpose === 'interview-prep'
          ? interviewPrepPrefills(entry)
          : buildPrefills(entry, {
            locale: config.locale,
            tone: config.profile?.tone,
            cvOptions,
            artifactSlug: artifactSlugForEntry(entry, url.searchParams.get('artifact') || ''),
          }),
      busy: running.has(id),
    });
  };

  routes['GET /api/usage'] = (req, res) => {
    try { return replyJson(res, 200, readUsage(os.homedir())); } catch (e) { return replyJson(res, 500, { error: e.message }); }
  };

  // The public picker receives normalized catalogue records only. Raw provider
  // output, executable locations, account metadata and diagnostics stay behind
  // the provider boundary.
  routes['GET /api/engines'] = async (req, res) => {
    try {
      const usage = readUsage(os.homedir());
      const config = loadWorkspaceConfig(repoRoot);
      const detected = detectedModels(usage);
      let providerCatalogues;
      try { providerCatalogues = await providerCataloguesFn(); }
      catch {
        providerCatalogues = {
          codex: { state: 'failed', reasonCode: 'catalogue-check-failed', models: [] },
          claude: { state: 'unsupported', reasonCode: 'enumeration-unsupported', models: [] },
        };
      }
      const engines = Object.fromEntries(Object.keys(ENGINES).map((engine) => {
        const configured = modelForProvider(config, engine);
        const rawCatalogue = providerCatalogues?.[engine] || {
          state: 'unsupported', reasonCode: 'enumeration-unsupported', models: [],
        };
        const models = providerModelCatalogue(engine, {
          ...rawCatalogue,
          configured,
          detected: detected[engine] || [],
        });
        const effectiveModel = effectiveProviderModel(engine, { configured }, models);
        return [engine, {
          usage: usage[engine] || { unknown: true },
          models,
          defaultModel: configured && effectiveModel.available !== false ? configured : null,
          effectiveModel,
          catalogue: {
            state: rawCatalogue.state === 'refreshed' ? 'refreshed' : 'fallback',
            reasonCode: rawCatalogue.reasonCode || null,
            checkedAt: rawCatalogue.checkedAt || null,
          },
        }];
      }));
      return replyJson(res, 200, { engines, checkedAt: usage.checkedAt });
    } catch (e) { return replyJson(res, 500, { error: e.message }); }
  };

  routes['POST /api/chat/stop'] = (req, res, body) => {
    const b = parseBody(body);
    if (!b) return replyJson(res, 400, { error: 'bad json' });
    try { chatPurpose(b.purpose || 'job'); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    const turn = running.get(b.id || '');
    if (turn) turn.stop();
    return replyJson(res, 200, { ok: true, stopped: !!turn });
  };

  routes['POST /api/chat/send'] = (req, res, body) => {
    const b = parseBody(body);
    if (!b) return replyJson(res, 400, { error: 'bad json' });
    handleSend(req, res, b);
  };

  routes['POST /api/chat/handoff'] = (req, res, body) => {
    const b = parseBody(body);
    if (!b) return replyJson(res, 400, { error: 'bad json' });
    handleHandoff(req, res, b).catch((e) => {
      const id = b.id || '';
      const turn = running.get(id);
      if (turn) turn.stop();
      running.delete(id);
      const message = `handoff failed: ${e.message}`;
      if (res.headersSent) {
        sseSend(res, 'error', { message });
        sseEnd(res);
      } else {
        replyJson(res, 500, { error: message });
      }
    });
  };

  async function handleHandoff(req, res, b) {
    const id = b.id || '';
    let purpose;
    try { purpose = chatPurpose(b.purpose || 'job'); }
    catch (e) { return replyJson(res, 400, { error: e.message }); }
    if (running.has(id)) return replyJson(res, 409, { error: 'a turn is already running for this job' });
    let chat;
    try { chat = loadChat(repoRoot, id, purpose); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    if (!chat || !chat.cliSessionId) return replyJson(res, 400, { error: 'no conversation to hand off yet' });
    const from = chat.engine;
    if (!ENGINES[from]) return replyJson(res, 400, { error: 'saved chat engine must be claude or codex' });
    const to = from === 'claude' ? 'codex' : 'claude';

    sseStart(res);
    stopTurnOnDisconnect(req, res, id);

    sseSend(res, 'status', { message: `asking ${from} for a handoff summary…` });
    let t1;
    try {
      t1 = runTurnFn({
        ...engineBuild(from, chat.cliSessionId),
        prompt: HANDOFF_SUMMARY_PROMPT,
        cwd: repoRoot,
        parseLine: ENGINES[from].parse,
        onEvent: () => {},
      });
    } catch (e) {
      sseSend(res, 'error', { message: `summary failed: ${e.message}` });
      return sseEnd(res);
    }
    running.set(id, t1);
    let r1;
    try {
      r1 = await t1.finished;
    } catch (e) {
      r1 = { ok: false, error: `summary failed: ${e.message}` };
    } finally {
      if (running.get(id) === t1) running.delete(id);
    }
    if (!r1.ok || !r1.text) {
      const message = `summary failed: ${r1.error || 'empty summary'}`;
      addFilesTouched(chat, r1.filesTouched);
      appendMessage(chat, 'system', message, nowIso());
      try { saveChatFn(repoRoot, id, chat, purpose); } catch (e) {
        sseSend(res, 'error', { message: `${message}; transcript save failed: ${e.message}` });
        return sseEnd(res);
      }
      sseSend(res, 'error', { message, sessionId: chat.cliSessionId, filesTouched: chat.filesTouched });
      return sseEnd(res);
    }

    addFilesTouched(chat, r1.filesTouched);
    recordHandoff(chat, to, nowIso());
    appendMessage(chat, 'system', `handoff summary:\n${r1.text}`, nowIso());
    try { saveChatFn(repoRoot, id, chat, purpose); } catch (e) {
      sseSend(res, 'error', { message: `handoff transcript save failed: ${e.message}` });
      return sseEnd(res);
    }
    checkpoint(`save chat handoff - ${id}`);

    sseSend(res, 'status', { message: `starting ${to} with the summary…` });
    const selected = entryOf(id);
    const handoff = handoffOpening(r1.text);
    const opening = purpose === 'interview-prep'
      ? `${selectedEntryContext(selected)}\n\n${interviewPrepAgentPrompt(selected, handoff)}`
      : `${selectedEntryContext(selected)}\n\n${handoff}`;
    let t2;
    try {
      t2 = runTurnFn({
        ...engineBuild(to, null),
        prompt: opening,
        cwd: repoRoot,
        parseLine: ENGINES[to].parse,
        onEvent: (ev) => { if (ev.kind === 'delta') sseSend(res, 'delta', { text: ev.text }); },
      });
    } catch (e) {
      const message = `handoff turn failed: ${e.message}`;
      appendMessage(chat, 'system', message, nowIso());
      try { saveChatFn(repoRoot, id, chat, purpose); } catch { /* the earlier handoff state is already persisted */ }
      sseSend(res, 'error', { message, engine: to, sessionId: chat.cliSessionId });
      return sseEnd(res);
    }
    running.set(id, t2);
    let r2;
    try {
      r2 = await t2.finished;
    } catch (e) {
      r2 = { ok: false, error: `handoff turn failed: ${e.message}` };
    } finally {
      if (running.get(id) === t2) running.delete(id);
    }

    appendMessage(chat, 'user', opening, nowIso());
    if (r2.sessionId) chat.cliSessionId = r2.sessionId;
    addFilesTouched(chat, r2.filesTouched);
    addFilesTouched(chat, refreshCvQuality(entryOf(id), r2.filesTouched));
    if (r2.ok) {
      for (const update of assistantUpdates(r2)) appendMessage(chat, 'assistant', update, nowIso());
    } else {
      appendMessage(chat, 'system', r2.error || 'handoff turn failed', nowIso());
    }
    try { saveChatFn(repoRoot, id, chat, purpose); } catch (e) {
      sseSend(res, 'error', { message: `handoff transcript save failed: ${e.message}` });
      return sseEnd(res);
    }
    checkpoint(`save completed handoff - ${id}`);
    if (r2.ok) sseSend(res, 'done', { engine: to });
    else sseSend(res, 'error', {
      message: r2.error || 'handoff turn failed',
      engine: to,
      sessionId: chat.cliSessionId,
      filesTouched: chat.filesTouched,
    });
    sseEnd(res);
  }

  async function handleSend(req, res, b) {
    const id = b.id || '';
    let purpose;
    try { purpose = chatPurpose(b.purpose || 'job'); }
    catch (e) { return replyJson(res, 400, { error: e.message }); }
    let entry;
    try { entry = entryOf(id); } catch (e) { return replyJson(res, 500, { error: `tracker unreadable: ${e.message}` }); }
    if (!entry) return replyJson(res, 404, { error: 'no such opportunity' });
    if (id === ONBOARDING_CHAT_ID) return replyJson(res, 410, { error: 'use Scout’s bounded setup proposal control for onboarding' });
    if (running.has(id)) return replyJson(res, 409, { error: 'a turn is already running for this job' });
    let chat;
    try { chat = loadChat(repoRoot, id, purpose); } catch (e) { return replyJson(res, 400, { error: e.message }); }
    const engine = chat && chat.cliSessionId ? chat.engine : b.engine;
    if (!ENGINES[engine]) return replyJson(res, 400, { error: 'engine must be claude or codex' });
    // The model is locked for the same reason the engine is: a resumed CLI
    // session is already bound to the model it started with.
    const requestedModel = b.model === null || b.model === undefined ? null : String(b.model).trim() || null;
    if (requestedModel && !isSafeModelId(requestedModel)) return replyJson(res, 400, { error: 'model is invalid' });
    const model = chat && chat.cliSessionId ? (chat.model || null) : requestedModel;
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) return replyJson(res, 400, { error: 'text required' });
    if (!chat) chat = emptyChat(engine, model);
    else { chat.engine = engine; chat.model = model; }

    if (b.mode === 'fit-assessment') {
      if (purpose !== 'job') return replyJson(res, 400, { error: 'fit assessment belongs to the job conversation' });
      return handleFitAssessment(req, res, { id, entry, engine, text, chat });
    }

    sseStart(res);
    let built;
    try { built = engineBuild(engine, chat.cliSessionId, model); } catch (e) {
      sseSend(res, 'error', { message: e.message });
      return sseEnd(res);
    }
    const turn = runTurnFn({
      ...built,
      prompt: entry.id === ONBOARDING_CHAT_ID
        ? text
        : purpose === 'interview-prep'
          ? `${selectedEntryContext(entry)}\n\n${interviewPrepAgentPrompt(entry, text)}`
          : `${selectedEntryContext(entry)}\n\nUser request:\n${text}`,
      cwd: repoRoot,
      parseLine: ENGINES[engine].parse,
      onEvent: (ev) => {
        if (ev.kind === 'delta') sseSend(res, 'delta', { text: ev.text });
        if (ev.kind === 'tool') sseSend(res, 'tool', { label: ev.label, file: ev.file, activity: ev.activity || 'thinking' });
      },
    });
    running.set(id, turn);
    stopTurnOnDisconnect(req, res, id);
    let r;
    try {
      r = await turn.finished;
    } catch (e) {
      r = { ok: false, error: `turn failed: ${e.message}` };
    } finally {
      running.delete(id);
    }

    appendMessage(chat, 'user', text, nowIso());
    if (r.sessionId) chat.cliSessionId = r.sessionId;
    addFilesTouched(chat, r.filesTouched);
    addFilesTouched(chat, refreshCvQuality(entry, r.filesTouched));
    if (r.ok) {
      for (const update of assistantUpdates(r)) appendMessage(chat, 'assistant', update, nowIso());
    } else {
      appendMessage(chat, 'system', r.error || 'turn failed', nowIso());
    }
    try { saveChatFn(repoRoot, id, chat, purpose); } catch (e) {
      console.error('chat transcript save failed:', e.message); // transcript loss only - agent session still resumable
    }
    checkpoint(`save chat - ${id}`);

    if (r.ok) {
      sseSend(res, 'done', {
        text: r.text, updates: assistantUpdates(r), sessionId: chat.cliSessionId, usage: r.usage, filesTouched: chat.filesTouched,
      });
    } else {
      sseSend(res, 'error', {
        message: r.error || 'turn failed',
        sessionId: chat.cliSessionId,
        filesTouched: chat.filesTouched,
      });
    }
    sseEnd(res);
  }

  async function handleFitAssessment(req, res, { id, entry, engine, text, chat }) {
    sseStart(res);
    const marker = { stop() {} };
    running.set(id, marker);
    stopTurnOnDisconnect(req, res, id);
    try {
      const { status, model } = engineStatus(engine);
      const context = {
        selectedOpportunity: JSON.parse(selectedEntryContext(entry).split('\n').slice(1).join('\n')),
        profile: boundedFile(path.join('profile', 'context.md')),
        calibration: boundedFile(path.join('profile', 'calibration.md')),
        masterCv: boundedFile(path.join('cv', 'master-cv.md')),
      };
      const prompt = [
        'Assess only the selected opportunity using only the supplied synthetic/private evidence.',
        'Identify unsupported and employer-declared mandatory gaps. Invent nothing. Do not access files, use tools, apply, or send outreach.',
        `User request: ${text}`, JSON.stringify(context),
      ].join('\n\n');
      const result = await runStructuredTurnFn({ provider: engine, status, schema: FIT_SCHEMA, prompt, model, maxInputTokens: 50_000 });
      const value = result.value;
      const answer = [
        value.summary, '', `Strengths: ${value.strengths.length ? value.strengths.join('; ') : 'none evidenced'}`,
        `Evidence gaps: ${value.evidenceGaps.length ? value.evidenceGaps.join('; ') : 'none identified'}`,
        `Mandatory gaps: ${value.mandatoryGaps.length ? value.mandatoryGaps.join('; ') : 'none identified'}`,
        `Recommendation: ${value.recommendation}`,
      ].join('\n');
      chat.bounded = true;
      appendMessage(chat, 'user', text, nowIso());
      appendMessage(chat, 'assistant', answer, nowIso());
      saveChatFn(repoRoot, id, chat);
      checkpoint(`save fit assessment - ${id}`);
      sseSend(res, 'delta', { text: answer });
      sseSend(res, 'done', { text: answer, engine, usage: result.usage, filesTouched: chat.filesTouched });
    } catch (error) {
      appendMessage(chat, 'user', text, nowIso());
      appendMessage(chat, 'system', error.message, nowIso());
      try { saveChatFn(repoRoot, id, chat); } catch { /* preserve the primary provider error */ }
      checkpoint(`save failed chat - ${id}`);
      sseSend(res, 'error', { message: error.message, engine, filesTouched: chat.filesTouched });
    } finally {
      running.delete(id);
      sseEnd(res);
    }
  }
}
