// Test stand-in for a chat CLI: reads the prompt from stdin, emits claude-style stream-json.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const prompt = input.trim();
  const command = ['FAIL', 'HANG', 'DONE_THEN_FAIL', 'OVER_OUTPUT'].find((value) =>
    prompt === value || prompt.endsWith(`User request:\n${value}`));
  if (command === 'FAIL') {
    process.stderr.write('fake failure detail\n');
    process.exit(3);
  }
  if (command === 'HANG') {
    // never emit a result; used for stop/timeout tests
    setInterval(() => {}, 1000);
    return;
  }
  if (command === 'DONE_THEN_FAIL') {
    console.log(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'not actually successful',
      session_id: 'fake-sess-1', usage: {},
    }));
    process.exit(3);
  }
  if (command === 'OVER_OUTPUT') {
    process.stdout.write(`${'x'.repeat(4096)}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-sess-1' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: `echo: ${prompt}` },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'applications/acme-role-2026-07/cv.typ' } },
      ],
    },
  }));
  console.log('this line is not json and must be skipped');
  console.log(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: `echo: ${prompt}`,
    session_id: 'fake-sess-1', total_cost_usd: 0.01, usage: { output_tokens: 5 },
  }));
});
