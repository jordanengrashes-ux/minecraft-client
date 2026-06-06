interface AiSession { id: string; name: string; history: { role: string; content: string }[]; }

const sessions: AiSession[] = [{ id: 's1', name: 'Chat 1', history: [] }];
let activeSessId = 's1';
let chatBusy = false;
let sessCounter = 1;

const sessionBar = document.getElementById('session-bar')!;
const newSessBtn = document.getElementById('new-sess')!;
const messagesEl = document.getElementById('messages')!;
const aiInput    = document.getElementById('ai-input') as HTMLInputElement;
const webBadge   = document.getElementById('web-badge')!;
const clearBtn   = document.getElementById('clear-btn')!;
const sendBtn    = document.getElementById('send-btn') as HTMLButtonElement;
const ai         = (window as any).ai;

function currentSess(): AiSession { return sessions.find(s => s.id === activeSessId)!; }

function renderTabs() {
  sessionBar.querySelectorAll('.stab').forEach(el => el.remove());
  sessions.forEach(sess => {
    const btn = document.createElement('button');
    btn.className = 'stab' + (sess.id === activeSessId ? ' active' : '');
    btn.innerHTML = `<span>${sess.name}</span>` +
      (sessions.length > 1 ? `<span class="stab-x" data-del="${sess.id}">✕</span>` : '');
    btn.addEventListener('click', e => {
      const del = (e.target as HTMLElement).dataset.del;
      if (del) deleteSession(del); else switchSession(sess.id);
    });
    newSessBtn.insertAdjacentElement('afterend', btn);
  });
}

function renderMessages() {
  messagesEl.innerHTML = '';
  const sess = currentSess();
  if (sess.history.length === 0) {
    addBubble('Ask me anything about Minecraft — crafting, commands, biomes, mobs, strategies, or Voxel Client features!', false);
    return;
  }
  sess.history.forEach(m => addBubble(m.content, m.role === 'user'));
}

function switchSession(id: string) {
  activeSessId = id;
  renderTabs();
  renderMessages();
}

function deleteSession(id: string) {
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  sessions.splice(idx, 1);
  if (sessions.length === 0) {
    sessCounter++;
    sessions.push({ id: `s${sessCounter}`, name: `Chat ${sessCounter}`, history: [] });
  }
  if (activeSessId === id) activeSessId = sessions[Math.min(idx, sessions.length - 1)].id;
  switchSession(activeSessId);
}

newSessBtn.addEventListener('click', () => {
  sessCounter++;
  const id = `s${sessCounter}`;
  sessions.push({ id, name: `Chat ${sessCounter}`, history: [] });
  activeSessId = id;
  switchSession(id);
});

function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdToHtml(text: string): string {
  return escHtml(text)
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

function addBubble(text: string, isUser: boolean): HTMLElement {
  const div = document.createElement('div');
  div.className = 'bubble ' + (isUser ? 'user' : 'ai');
  div.innerHTML = isUser ? escHtml(text) : mdToHtml(text);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function fetchWebContext(q: string): Promise<string> {
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`);
    const data = await r.json();
    const snippet = (data.AbstractText || data.Answer || '') as string;
    if (snippet.length > 20) {
      webBadge.style.display = 'inline';
      setTimeout(() => { webBadge.style.display = 'none'; }, 4000);
      return `[Web context: ${snippet.slice(0, 300)}]\n\nUser question: `;
    }
  } catch { /* no web context */ }
  return '';
}

async function sendChat(q: string) {
  if (chatBusy || !q.trim()) return;
  chatBusy = true;
  sendBtn.disabled = true;

  addBubble(q, true);
  const typing = addBubble('…', false);
  typing.classList.add('typing');

  let webCtx = '';
  if (/what|how|when|where|which|who|latest|new|update/i.test(q)) {
    webCtx = await fetchWebContext(q);
  }

  const sess = currentSess();
  sess.history.push({ role: 'user', content: q });
  if (sess.history.length > 30) sess.history.splice(0, sess.history.length - 30);

  const toSend = sess.history.map((m, i) =>
    (m.role === 'user' && i === sess.history.length - 1 && webCtx)
      ? { role: 'user', content: webCtx + q }
      : m
  );

  const res = await ai.chat(toSend);
  typing.remove();

  if (res.ok && res.text) {
    sess.history.push({ role: 'assistant', content: res.text });
    addBubble(res.text, false);
  } else {
    addBubble('Sorry, something went wrong. Try again.', false);
    sess.history.pop();
  }

  chatBusy = false;
  sendBtn.disabled = false;
  aiInput.focus();
}

clearBtn.addEventListener('click', () => { currentSess().history = []; renderMessages(); });

sendBtn.addEventListener('click', () => {
  const q = aiInput.value.trim();
  if (q) { aiInput.value = ''; sendChat(q); }
});

aiInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const q = aiInput.value.trim();
    if (q) { aiInput.value = ''; sendChat(q); }
  }
});

renderTabs();
renderMessages();
