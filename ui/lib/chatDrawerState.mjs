function requestSlot() {
  return {
    requestGeneration: 0,
    status: 'idle',
    value: null,
    error: null,
  };
}

export function createChatDrawerState(chatId, generation = 1) {
  return {
    chatId,
    generation,
    engines: requestSlot(),
    usage: requestSlot(),
    codexLink: requestSlot(),
  };
}

function activeRequest(state, event) {
  return Boolean(
    state
    && state.chatId !== null
    && event.chatId === state.chatId
    && event.generation === state.generation
  );
}

function errorMessage(value) {
  return String(value || 'unavailable').slice(0, 160);
}

export function reduceChatDrawer(state, event) {
  if (!state || !event || typeof event.type !== 'string') return state;
  if (event.type === 'chat/opened') {
    if (!event.chatId || !Number.isInteger(event.generation)) return state;
    return createChatDrawerState(event.chatId, event.generation);
  }
  if (event.type === 'chat/closed') {
    if (!activeRequest(state, event)) return state;
    return {
      ...createChatDrawerState(null, state.generation),
      chatId: null,
    };
  }

  const match = /^(engines|usage|codexLink)\/(requested|resolved|rejected)$/.exec(event.type);
  if (!match || !activeRequest(state, event)) return state;
  const [, slotName, action] = match;
  const slot = state[slotName];
  if (!Number.isInteger(event.requestGeneration) || event.requestGeneration < 1) return state;

  if (action === 'requested') {
    if (event.requestGeneration <= slot.requestGeneration) return state;
    return {
      ...state,
      [slotName]: {
        requestGeneration: event.requestGeneration,
        status: 'loading',
        value: slot.value,
        error: null,
      },
    };
  }
  if (event.requestGeneration !== slot.requestGeneration) return state;
  if (action === 'resolved') {
    return {
      ...state,
      [slotName]: {
        requestGeneration: slot.requestGeneration,
        status: 'ready',
        value: event.value,
        error: null,
      },
    };
  }
  return {
    ...state,
    [slotName]: {
      requestGeneration: slot.requestGeneration,
      status: 'error',
      value: slot.value,
      error: errorMessage(event.error),
    },
  };
}
