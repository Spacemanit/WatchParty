import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../public/chat.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function interfaceFixture({ lanUrls = ['http://192.168.1.10:3000'] } = {}) {
  const { document, window } = parseHTML(html);
  const calls = [], clipboard = [], responses = new Map(), handlers = new Map();
  const socket = {
    connected: true,
    on(event, callback) { const list = handlers.get(event) || []; list.push(callback); handlers.set(event, list); },
    timeout() { return this; },
    emit(event, data, callback) {
      calls.push({ event, data });
      queueMicrotask(() => {
        const response = responses.get(event);
        callback(null, typeof response === 'function' ? response(data) : response || { ok: true, serverNow: Date.now() });
      });
    }
  };
  const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
  const location = new URL('http://localhost:3000/');
  // Simulate browser-only primitives. This checks DOM behavior, not layout or decoding.
  Object.defineProperty(document, 'activeElement', { get: () => document._focused || document.body });
  window.HTMLElement.prototype.focus = function () { this.ownerDocument._focused = this; };
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
    dialog.showModal = () => { dialog.setAttribute('open', ''); dialog.querySelector('[autofocus], button, input')?.focus(); };
    dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  }
  const select = document.getElementById('invite-address');
  Object.defineProperty(select, 'value', {
    get: () => (select.querySelector('option[selected]') || select.querySelector('option'))?.value || '',
    set: value => { for (const option of select.children) option.toggleAttribute('selected', option.value === value); }
  });
  const input = document.getElementById('chat-input');
  input.setRangeText = (text, start, end) => { input.value = input.value.slice(0, start) + text + input.value.slice(end); };
  const video = document.getElementById('local-player');
  Object.assign(video, { duration: 120, readyState: 4, currentTime: 0, paused: true, muted: false, load() {}, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  window.isSecureContext = true;
  const context = vm.createContext({
    window, document, location, URL, console,
    localStorage: storage(), sessionStorage: storage(),
    history: { replaceState: (_, __, value) => { location.href = new URL(value, location).href; } },
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    io: () => socket, performance, matchMedia: () => ({ matches: true }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async () => ({ json: async () => ({ lanUrls, maxUploadBytes: 2 * 1024 ** 3 }) })
  });
  vm.runInContext(chatSource, context, { filename: 'chat.js' });
  vm.runInContext(appSource, context, { filename: 'app.js' });
  const byId = id => document.getElementById(id);
  const click = id => byId(id).click();
  const key = (element, value) => { const event = new window.Event('keydown', { bubbles: true, cancelable: true }); event.key = value; element.dispatchEvent(event); };
  const submit = id => byId(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const publish = state => { for (const callback of handlers.get('room:state') || []) callback({ state }); };
  const join = (state, selfId = 'host') => { context.session = { state, selfId, token: 'test-token', chat: { messages: [], sequence: 0 } }; vm.runInContext('adoptRoom(session)', context); };
  return { document, byId, click, key, submit, calls, clipboard, responses, socket, publish, join };
}

function roomState() {
  return { code: 'ABCD23', hostId: 'host', sequence: 1, playbackRevision: 0, media: null, playing: false, position: 0, updatedAt: Date.now(), members: [
    { id: 'host', name: 'Alex', online: true }, { id: 'guest', name: 'Maya', online: true }
  ] };
}

test('the redesigned interface boots with valid DOM targets, labels and local icon references', async () => {
  const { document } = interfaceFixture();
  await flush();
  const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of (appSource + chatSource).matchAll(/getElementById\('([^']+)'\)/g)) assert(document.getElementById(match[1]), `Missing DOM target ${match[1]}`);
  for (const use of document.querySelectorAll('use')) assert(document.querySelector(use.getAttribute('href')), 'Icon reference resolves');
  for (const label of document.querySelectorAll('label[for]')) assert(document.getElementById(label.getAttribute('for')));
  for (const button of document.querySelectorAll('button')) if (!button.textContent.trim()) assert(button.getAttribute('aria-label'), 'Icon button has a name');
  assert.equal(document.querySelector('footer'), null);
});

test('Create and Join dialogs support keyboard tabs and keep the correct fields and focus', () => {
  const ui = interfaceFixture();
  ui.click('create-open');
  assert(ui.byId('room-dialog').open);
  assert(ui.byId('join-code-field').hidden);
  assert.equal(ui.document.activeElement.id, 'display-name');
  ui.key(ui.byId('create-tab'), 'ArrowRight');
  assert.equal(ui.byId('join-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ui.byId('room-fields').getAttribute('aria-labelledby'), 'join-tab');
  assert.equal(ui.byId('join-code-field').hidden, false);
  assert.equal(ui.document.activeElement.id, 'join-tab');
  ui.key(ui.byId('join-tab'), 'Home');
  assert.equal(ui.byId('create-tab').getAttribute('aria-selected'), 'true');
  assert(ui.byId('join-code-field').hidden);
});

test('creating a room opens the watching view and keeps the participant list in its drawer', async () => {
  const ui = interfaceFixture();
  ui.responses.set('room:create', { ok: true, state: roomState(), selfId: 'host', token: 'test-token', chat: { messages: [], sequence: 0 } });
  ui.click('create-open'); ui.byId('display-name').value = 'Alex'; ui.submit('room-form');
  assert(ui.byId('room-submit').disabled);
  await flush();
  assert(ui.byId('home-view').hidden);
  assert.equal(ui.byId('party-view').hidden, false);
  assert.equal(ui.byId('room-dialog').open, false);
  assert.equal(ui.byId('source-actions').hidden, false);
  assert.equal(ui.document.activeElement.id, 'party-title');
  assert.equal(ui.document.querySelector('.workspace #member-list'), null);
  assert(ui.byId('people-dialog').contains(ui.byId('member-list')));
  ui.click('people-open'); assert(ui.byId('people-dialog').open);
  ui.document.querySelector('[data-close="people-dialog"]').click();
  assert.equal(ui.byId('people-dialog').open, false);
});

test('host transfer requires confirmation and updates guest permissions after the room broadcast', async () => {
  const ui = interfaceFixture(); const state = roomState(); ui.join(state);
  ui.click('people-open'); ui.document.querySelector('.transfer-button').click();
  assert(ui.byId('transfer-dialog').open);
  assert.equal(ui.calls.filter(call => call.event === 'host:transfer').length, 0);
  ui.responses.set('host:transfer', data => { ui.publish({ ...state, sequence: 2, hostId: data.memberId }); return { ok: true }; });
  ui.click('confirm-transfer'); await flush();
  assert.equal(ui.calls.find(call => call.event === 'host:transfer').data.memberId, 'guest');
  assert.equal(ui.byId('transfer-dialog').open, false);
  assert(ui.byId('source-actions').hidden);
  assert(ui.byId('youtube-open').disabled);
  assert.equal(ui.byId('control-label').textContent, 'The host controls playback.');
});

test('opening an invitation leaves the clipboard alone and explicit Copy copies the selected address', async () => {
  const ui = interfaceFixture({ lanUrls: ['http://192.168.1.10:3000', 'http://10.0.0.2:3000'] });
  await flush(); ui.join(roomState()); ui.click('invite-button');
  assert(ui.byId('invite-dialog').open);
  assert.equal(ui.clipboard.length, 0);
  assert.equal(ui.byId('invite-address-field').hidden, false);
  ui.byId('invite-address').value = 'http://10.0.0.2:3000';
  ui.byId('invite-address').dispatchEvent(new ui.document.defaultView.Event('change'));
  ui.click('copy-invite-dialog'); await flush();
  assert.deepEqual(ui.clipboard, ['http://10.0.0.2:3000/?room=ABCD23']);
  assert(ui.byId('invite-dialog').contains(ui.byId('toast-stack')), 'Copy feedback remains visible inside a modal');
});

test('a single invite address needs no picker and Leave can be cancelled before contacting the server', async () => {
  const ui = interfaceFixture(); await flush(); ui.join(roomState()); ui.click('invite-button');
  assert(ui.byId('invite-address-field').hidden);
  ui.byId('invite-dialog').close();
  ui.click('leave-button');
  assert(ui.byId('leave-dialog').open);
  ui.document.querySelector('[data-close="leave-dialog"][autofocus]').click();
  assert.equal(ui.calls.filter(call => call.event === 'room:leave').length, 0);
  assert.equal(ui.byId('party-view').hidden, false);
  ui.click('leave-button'); ui.responses.set('room:leave', { ok: true }); ui.click('confirm-leave');
  await flush();
  assert.equal(ui.calls.filter(call => call.event === 'room:leave').length, 1);
  assert(ui.byId('party-view').hidden);
  assert.equal(ui.byId('home-view').hidden, false);
});

test('chat retains emoji keyboard navigation, text safety, and unobtrusive limit feedback', async () => {
  const ui = interfaceFixture(); ui.join(roomState()); ui.click('emoji-toggle');
  const buttons = [...ui.byId('emoji-options').children];
  ui.key(buttons[0], 'ArrowDown'); assert.equal(ui.document.activeElement, buttons[6]);
  buttons[6].click(); assert.equal(ui.byId('chat-input').value, buttons[6].textContent);
  assert(ui.byId('chat-count').hidden);
  ui.byId('chat-input').value = 'a'.repeat(800);
  ui.byId('chat-input').dispatchEvent(new ui.document.defaultView.Event('input'));
  assert.equal(ui.byId('chat-count').hidden, false);
  ui.byId('chat-input').value = '<b>Hello</b> 👋';
  ui.responses.set('chat:send', data => ({ ok: true, message: { ...data, id: 'message-1', sequence: 1, senderId: 'host', name: 'Alex', sentAt: Date.now() } }));
  ui.submit('chat-form'); await flush();
  assert.equal(ui.byId('chat-messages').querySelector('b'), null);
  assert(ui.byId('chat-messages').textContent.includes('<b>Hello</b> 👋'));
  assert.equal(ui.byId('chat-input').value, '');
});

test('chat failures keep the draft and show useful feedback, while disconnection disables host actions', async () => {
  const ui = interfaceFixture(); ui.join(roomState());
  ui.byId('chat-input').value = 'Keep this message';
  ui.responses.set('chat:send', { ok: false, error: 'Please slow down.' });
  ui.submit('chat-form'); await flush();
  assert.equal(ui.byId('chat-input').value, 'Keep this message');
  assert.equal(ui.byId('chat-hint').classList.contains('visually-hidden'), false);
  assert.match(ui.byId('chat-hint').textContent, /Please slow down/);
  ui.socket.connected = false; ui.publish({ ...roomState(), sequence: 2 });
  assert(ui.byId('play-button').disabled);
  assert(ui.byId('upload-button').disabled);
  assert.equal(ui.byId('chat-state').hidden, false);
});

test('YouTube entry reports errors beside the URL and restores an editable, focused field', async () => {
  const ui = interfaceFixture(); ui.join(roomState()); ui.click('youtube-open');
  assert(ui.byId('youtube-dialog').open);
  ui.byId('youtube-url').value = 'https://example.com/not-youtube';
  ui.responses.set('media:youtube', { ok: false, error: 'Enter a valid YouTube video link.' });
  ui.submit('youtube-form');
  assert(ui.byId('youtube-submit').disabled);
  await flush();
  assert.equal(ui.byId('youtube-error').hidden, false);
  assert.match(ui.byId('youtube-error').textContent, /valid YouTube/);
  assert.equal(ui.byId('youtube-url').disabled, false);
  assert.equal(ui.document.activeElement.id, 'youtube-url');
  assert.equal(ui.byId('youtube-url').value, 'https://example.com/not-youtube');
});
