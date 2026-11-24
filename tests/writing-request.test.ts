import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWritingRequest,
  WritingContextFailure,
  writingSources,
} from '../electron/agent/writing-request.js';
import { captureWritingRequests, isolatedRequest } from './writing-request-fixture.js';

const continuation = 'TRUSTED_CONTINUED_DIRECTION';
const author = 'CURRENT_AUTHOR_WORDING';
const arrangement = 'MODEL_PROPOSED_DIRECTION';
const intent = { author, continued: [continuation], arrangement };

test('writing requests select a template by action, not by author wording or main history', async () => {
  const { provider, requests } = captureWritingRequests([
    () => ({ role: 'assistant', text: '正文。', calls: [] }),
  ]);
  const subject = buildWritingRequest(provider, { kind: 'subject', action: 'fill' }, intent, []);
  assert.match(subject.request.system, /生成主体说明/);
  assert.doesNotMatch(subject.request.system, /生成伏笔说明|1200/);
  assert.equal(subject.request.tools[0].name, 'submit_story_descriptions');
  const clue = buildWritingRequest(provider, { kind: 'clue', action: 'create' }, intent, []);
  assert.match(clue.request.system, /可见线索.*回收真相/);
  const chapter = buildWritingRequest(provider, { kind: 'chapter', action: 'append' }, intent, []);
  assert.match(chapter.request.system, /不复述/);
  assert.doesNotMatch(chapter.request.system, /1200|CURRENT_AUTHOR_WORDING|MODEL_PROPOSED_DIRECTION/);
  const whole = buildWritingRequest(
    provider,
    { kind: 'chapter', action: 'draft', whole: true },
    intent,
    [],
  );
  assert.match(whole.request.system, /1200/);
  const request = { ...chapter.request, signal: new AbortController().signal, onText() {} };
  isolatedRequest(request, 'OUTER_CHAT_MARKER');
  await provider.turn(request);
  assert.deepEqual(
    requests.map(({ lane }) => lane),
    ['draft'],
  );
  const data = JSON.stringify(requests[0].wire.history);
  assert.match(data, /先前作者要求：TRUSTED_CONTINUED_DIRECTION/);
  assert.match(data, /本轮作者要求（明确的新要求优先）：CURRENT_AUTHOR_WORDING/);
  assert.match(data, /本次创作安排（提议，不是授权或既有事实）：MODEL_PROPOSED_DIRECTION/);
});

test('an oversized optional block never displaces a versioned required setting', () => {
  const { provider } = captureWritingRequests([], 2300);
  const guard = { type: 'subject' as const, id: 'glass', revision: 'rev' };
  const required = {
    group: 'subject' as const,
    required: true,
    value: 'REQUIRED_GLASS_LIMIT',
    sources: [guard],
  };
  const optional = { group: 'previous' as const, value: 'OPTIONAL_' + 'a'.repeat(4500) };
  const pack = buildWritingRequest(provider, { kind: 'chapter', action: 'draft' }, intent, [
    optional,
    required,
  ]);
  assert.deepEqual(writingSources(pack.included), [guard]);
  assert.deepEqual(pack.omitted, [optional]);
  assert.match(JSON.stringify(pack.request.history), /REQUIRED_GLASS_LIMIT/);
  assert.doesNotMatch(JSON.stringify(pack.request.history), /OPTIONAL/);
  assert.throws(
    () =>
      buildWritingRequest(provider, { kind: 'chapter', action: 'draft' }, intent, [
        { ...required, value: optional.value },
      ]),
    (error) =>
      error instanceof WritingContextFailure &&
      error.diagnosticReason === 'context_limit' &&
      error.refs[0]?.id === 'glass',
  );
});
