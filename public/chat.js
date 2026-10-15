'use strict';

// A small vanilla-JavaScript component, independent of the video player.
window.PartyChat = class PartyChat {
  constructor({ request, getContext }) {
    this.request = request;
    this.getContext = getContext;
    this.input = document.getElementById('chat-input');
    this.log = document.getElementById('chat-messages');
    this.timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    this.code = null;
    this.selfId = null;
    this.messages = [];
    this.sequence = 0;
    this.following = true;
    this.unread = 0;
    this.pending = null;
    this.sendingId = null;
    this.error = '';
    this.refreshing = null;
    this.incoming = [];

    const emojis = [
      ['😂', 'Laughing'], ['🤣', 'Rolling with laughter'], ['😍', 'Heart eyes'], ['🥹', 'Happy tears'],
      ['😮', 'Surprised'], ['😱', 'Shocked'], ['🤯', 'Mind blown'], ['😭', 'Crying'],
      ['😎', 'Cool'], ['🥳', 'Party'], ['🙌', 'Celebration'], ['👏', 'Applause'],
      ['👍', 'Thumbs up'], ['👎', 'Thumbs down'], ['❤️', 'Heart'], ['🔥', 'Fire'],
      ['💯', 'One hundred'], ['🎉', 'Confetti'], ['✨', 'Sparkles'], ['😴', 'Sleepy'],
      ['🤔', 'Thinking'], ['🤫', 'Quiet'], ['🫶', 'Heart hands'], ['🥰', 'Smiling with hearts'],
      ['🤩', 'Star eyes'], ['👀', 'Eyes'], ['💀', 'Skull'], ['🤝', 'Handshake'],
      ['🎬', 'Clapperboard'], ['🍿', 'Popcorn'], ['🍕', 'Pizza'], ['🛋️', 'Sofa']
    ];
    for (const [emoji, label] of emojis) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'emoji-option';
      button.textContent = emoji; button.setAttribute('aria-label', label);
      button.addEventListener('click', () => this.insertEmoji(emoji));
      document.getElementById('emoji-options').append(button);
    }
    document.getElementById('chat-form').addEventListener('submit', event => { event.preventDefault(); this.send(); });
    this.input.addEventListener('input', () => { this.error = ''; this.refreshStatus(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault(); this.send();
      }
    });
    document.getElementById('emoji-toggle').addEventListener('click', () => this.toggleEmoji(document.getElementById('emoji-picker').hidden));
    document.getElementById('emoji-close').addEventListener('click', () => this.toggleEmoji(false, true));
    document.getElementById('emoji-picker').addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.toggleEmoji(false, true); return; }
      const buttons = [...document.getElementById('emoji-options').children];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      const shifts = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };
      if (event.key in shifts) {
        event.preventDefault(); buttons[(index + shifts[event.key] + buttons.length) % buttons.length].focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus();
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!document.getElementById('emoji-picker').hidden && !document.getElementById('emoji-picker').contains(event.target) && !document.getElementById('emoji-toggle').contains(event.target)) this.toggleEmoji(false);
    });
    this.log.addEventListener('scroll', () => {
      this.following = this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop < 45;
      if (this.following) { this.unread = 0; this.updateUnread(); }
    });
    document.getElementById('chat-new-messages').addEventListener('click', () => {
      this.following = true; this.unread = 0; this.log.scrollTop = this.log.scrollHeight; this.updateUnread();
    });
    this.refreshStatus();
  }

  reset() {
    this.code = null; this.selfId = null; this.messages = []; this.sequence = 0;
    this.pending = null; this.sendingId = null; this.error = ''; this.refreshing = null; this.incoming = [];
    this.following = true; this.unread = 0; this.input.value = '';
    this.log.replaceChildren(); this.toggleEmoji(false); this.updateUnread(); this.refreshStatus();
  }

  join(code, selfId, history) {
    // A polling response may deliver messages before the join promise resumes.
    const waiting = this.incoming.filter(event => event.code === code);
    if (this.code !== code || this.selfId !== selfId) this.reset();
    this.code = code; this.selfId = selfId;
    if (history) this.hydrate(history);
    else this.refreshHistory();
    this.incoming = [];
    for (const event of waiting) this.receive(event.code, event.message);
    this.refreshStatus();
  }

  hydrate(history) {
    const previous = this.sequence;
    const newer = this.messages.filter(message => message.sequence > history.sequence);
    this.messages = [...new Map([...history.messages, ...newer].map(message => [message.id, message])).values()]
      .sort((a, b) => a.sequence - b.sequence).slice(-100);
    this.sequence = Math.max(history.sequence, ...this.messages.map(message => message.sequence));
    if (!this.following) this.unread += this.messages.filter(message => message.sequence > previous && message.senderId !== this.selfId).length;
    for (const message of this.messages) this.confirmDraft(message);
    this.renderMessages(); this.refreshStatus();
  }

  async refreshHistory() {
    if (this.refreshing || !this.code || !this.getContext().connected) return;
    const code = this.code;
    const task = this.request('chat:history'); this.refreshing = task;
    try {
      const response = await task;
      if (this.code === code) { this.error = ''; this.hydrate(response.chat); }
    } catch (error) { if (this.code === code) { this.error = error.message; this.refreshStatus(); } }
    finally { if (this.refreshing === task) this.refreshing = null; }
  }

  receive(code, message) {
    if (this.code !== code || this.getContext().roomCode !== code) {
      this.incoming.push({ code, message });
      this.incoming = this.incoming.slice(-100);
      return;
    }
    if (message.sequence > this.sequence + 1) this.refreshHistory();
    const duplicate = this.messages.some(item => item.id === message.id);
    const tooOld = this.messages.length >= 100 && message.sequence < this.messages[0].sequence;
    if (!duplicate && !tooOld) {
      this.messages.push(message);
      this.messages.sort((a, b) => a.sequence - b.sequence);
      this.messages = this.messages.slice(-100);
      if (message.senderId === this.selfId) { this.following = true; this.unread = 0; }
      else if (!this.following) this.unread += 1;
    }
    this.sequence = Math.max(this.sequence, message.sequence);
    this.confirmDraft(message);
    this.renderMessages(); this.refreshStatus();
  }

  confirmDraft(message) {
    if (!this.pending || this.pending.code !== this.code || message.clientId !== this.pending.clientId || message.senderId !== this.selfId) return;
    if (this.input.value.trim() === this.pending.text) this.input.value = '';
    if (this.sendingId === message.clientId) this.sendingId = null;
    this.pending = null; this.error = '';
  }

  async send() {
    const context = this.getContext();
    const text = this.input.value.trim();
    if (!context.connected || context.roomCode !== this.code || !this.code || this.sendingId || !text) return;
    if (Array.from(text).length > 1000) { this.error = 'Keep your message to 1,000 characters.'; this.refreshStatus(); return; }
    const code = this.code;
    const clientId = this.pending?.code === code && this.pending.text === text ? this.pending.clientId :
      (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
    this.pending = { code, text, clientId }; this.sendingId = clientId; this.error = ''; this.refreshStatus();
    try {
      const result = await this.request('chat:send', { text, clientId });
      if (this.code === code) this.receive(code, result.message);
    } catch (error) {
      if (this.code === code && !this.messages.some(message => message.clientId === clientId && message.senderId === this.selfId)) {
        this.error = `${error.message} Your message is kept here to retry.`;
      }
    } finally {
      if (this.sendingId === clientId) this.sendingId = null;
      this.refreshStatus();
    }
  }

  refreshStatus() {
    const context = this.getContext();
    const joined = Boolean(this.code && context.roomCode === this.code);
    const count = Array.from(this.input.value).length;
    this.input.disabled = !joined;
    document.getElementById('emoji-toggle').disabled = !joined;
    document.getElementById('chat-send').disabled = !joined || !context.connected || Boolean(this.sendingId) || !this.input.value.trim() || count > 1000;
    document.getElementById('chat-count').textContent = `${count} / 1000`;
    document.getElementById('chat-count').classList.toggle('over-limit', count > 1000);
    document.getElementById('chat-empty').hidden = this.messages.length > 0;
    document.getElementById('chat-state').textContent = joined ? context.connected ? 'LIVE' : 'RECONNECTING' : 'ROOM ONLY';
    const hint = this.error || (!joined ? 'Join a party to chat.' : !context.connected ? 'Reconnecting… your draft stays here.' : this.sendingId ? 'Sending…' : 'Enter to send · Shift+Enter for a new line');
    if (document.getElementById('chat-hint').textContent !== hint) document.getElementById('chat-hint').textContent = hint;
    document.getElementById('chat-hint').classList.toggle('chat-error', Boolean(this.error));
  }

  renderMessages() {
    const scrollTop = this.log.scrollTop;
    const wanted = new Set(this.messages.map(message => message.id));
    let removedHeight = 0;
    for (const node of [...this.log.children]) {
      if (!wanted.has(node.dataset.messageId)) { removedHeight += node.getBoundingClientRect().height + 12; node.remove(); }
    }
    const existing = new Map([...this.log.children].map(node => [node.dataset.messageId, node]));
    let cursor = this.log.firstChild;
    for (const message of this.messages) {
      const node = existing.get(message.id) || this.makeMessage(message);
      if (node === cursor) cursor = cursor.nextSibling;
      else this.log.insertBefore(node, cursor);
    }
    if (this.following) this.log.scrollTop = this.log.scrollHeight;
    else this.log.scrollTop = Math.max(0, scrollTop - removedHeight);
    this.updateUnread();
  }

  makeMessage(message) {
    const own = message.senderId === this.selfId;
    const row = document.createElement('div'); row.className = `chat-message${own ? ' chat-message-own' : ''}`; row.dataset.messageId = message.id;
    const meta = document.createElement('div'); meta.className = 'chat-message-meta';
    const name = document.createElement('span'); name.textContent = own ? `${message.name} (you)` : message.name;
    const timestamp = document.createElement('time'); timestamp.dateTime = new Date(message.sentAt).toISOString(); timestamp.textContent = this.timeFormat.format(new Date(message.sentAt));
    meta.append(name, timestamp);
    const body = document.createElement('p'); body.className = 'chat-message-text'; body.textContent = message.text;
    row.append(meta, body); return row;
  }

  updateUnread() {
    const button = document.getElementById('chat-new-messages'); button.hidden = !this.unread;
    button.textContent = `${this.unread} new ${this.unread === 1 ? 'message' : 'messages'} ↓`;
  }

  toggleEmoji(open, returnFocus = false) {
    document.getElementById('emoji-picker').hidden = !open;
    document.getElementById('emoji-toggle').setAttribute('aria-expanded', String(open));
    if (open) document.getElementById('emoji-options').firstElementChild.focus();
    else if (returnFocus) document.getElementById('emoji-toggle').focus();
  }

  insertEmoji(emoji) {
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    const next = this.input.value.slice(0, start) + emoji + this.input.value.slice(end);
    if (Array.from(next).length > 1000) { this.error = 'Your message is full. Remove a little text to add an emoji.'; this.refreshStatus(); return; }
    this.input.setRangeText(emoji, start, end, 'end');
    this.error = ''; this.toggleEmoji(false); this.input.focus(); this.refreshStatus();
  }
};
