import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatDrawerState, reduceChatDrawer } from './chatDrawerState.mjs';

function requestBoth(chatId = 'chat-a', generation = 1) {
  let state = createChatDrawerState(chatId, generation);
  state = reduceChatDrawer(state, {
    type: 'engines/requested', chatId, generation, requestGeneration: 1,
  });
  return reduceChatDrawer(state, {
    type: 'usage/requested', chatId, generation, requestGeneration: 1,
  });
}

test('usage resolving before engines retains both values', () => {
  const pending = requestBoth();
  const usageReady = reduceChatDrawer(pending, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { claude: { availability: 'estimate' } },
  });
  const complete = reduceChatDrawer(usageReady, {
    type: 'engines/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { engines: { codex: { models: [] } } },
  });
  assert.deepEqual(complete.usage.value, usageReady.usage.value);
  assert.deepEqual(complete.engines.value, { engines: { codex: { models: [] } } });
});

test('engines resolving before usage retains both values', () => {
  const pending = requestBoth();
  const enginesReady = reduceChatDrawer(pending, {
    type: 'engines/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { engines: { claude: { models: [] } } },
  });
  const complete = reduceChatDrawer(enginesReady, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { codex: { windows: [] } },
  });
  assert.deepEqual(complete.engines.value, enginesReady.engines.value);
  assert.deepEqual(complete.usage.value, { codex: { windows: [] } });
});

test('responses for a previous chat are ignored after switching chats', () => {
  const pendingA = requestBoth('chat-a', 1);
  const openedB = reduceChatDrawer(pendingA, {
    type: 'chat/opened', chatId: 'chat-b', generation: 2,
  });
  const afterEngines = reduceChatDrawer(openedB, {
    type: 'engines/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { engines: { codex: { models: ['stale'] } } },
  });
  const afterUsage = reduceChatDrawer(afterEngines, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { private: 'stale' },
  });
  assert.deepEqual(afterUsage, openedB);
});

test('an older usage refresh cannot replace the newest result', () => {
  let state = createChatDrawerState('chat-a', 1);
  state = reduceChatDrawer(state, {
    type: 'usage/requested', chatId: 'chat-a', generation: 1, requestGeneration: 1,
  });
  state = reduceChatDrawer(state, {
    type: 'usage/requested', chatId: 'chat-a', generation: 1, requestGeneration: 2,
  });
  const newest = reduceChatDrawer(state, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 2,
    value: { checkedAt: 'newest' },
  });
  const stale = reduceChatDrawer(newest, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { checkedAt: 'oldest' },
  });
  assert.deepEqual(stale, newest);
});

test('closing the drawer makes later responses inert', () => {
  const pending = requestBoth();
  const closed = reduceChatDrawer(pending, {
    type: 'chat/closed', chatId: 'chat-a', generation: 1,
  });
  const late = reduceChatDrawer(closed, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { checkedAt: 'late' },
  });
  assert.deepEqual(late, closed);
  assert.equal(late.chatId, null);
});

test('an engines error preserves valid usage', () => {
  const pending = requestBoth();
  const usageReady = reduceChatDrawer(pending, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { checkedAt: 'ready' },
  });
  const failed = reduceChatDrawer(usageReady, {
    type: 'engines/rejected', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    error: 'models unavailable',
  });
  assert.deepEqual(failed.usage, usageReady.usage);
  assert.equal(failed.engines.status, 'error');
});

test('a usage error preserves model choices', () => {
  const pending = requestBoth();
  const enginesReady = reduceChatDrawer(pending, {
    type: 'engines/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { engines: { codex: { models: [{ id: 'synthetic-model' }] } } },
  });
  const failed = reduceChatDrawer(enginesReady, {
    type: 'usage/rejected', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    error: 'usage unavailable',
  });
  assert.deepEqual(failed.engines, enginesReady.engines);
  assert.equal(failed.usage.status, 'error');
});

test('Codex link capability resolves independently without erasing models or usage', () => {
  let state = requestBoth();
  state = reduceChatDrawer(state, {
    type: 'engines/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { engines: { codex: { models: [{ id: 'safe-model' }] } } },
  });
  state = reduceChatDrawer(state, {
    type: 'usage/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { checkedAt: 'usage-ready' },
  });
  state = reduceChatDrawer(state, {
    type: 'codexLink/requested', chatId: 'chat-a', generation: 1, requestGeneration: 1,
  });
  const complete = reduceChatDrawer(state, {
    type: 'codexLink/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { state: 'supported', canAttempt: true },
  });
  assert.deepEqual(complete.engines, state.engines);
  assert.deepEqual(complete.usage, state.usage);
  assert.equal(complete.codexLink.value.state, 'supported');
});
