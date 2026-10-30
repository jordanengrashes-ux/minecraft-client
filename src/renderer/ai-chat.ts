interface AiSession { id: string; name: string; history: { role: string; content: string }[]; }

const sessions: AiSession[] = [{ id: 's1', name: 'Chat 1', history: [] }];
let activeSessId = 's1';
let chatBusy = false;
let sessCounter = 1;

const sessionBar = document.getElementById('session-bar')!;
const newSessBtn  = document.getElementById('new-sess')!;
const messagesEl  = document.getElementById('messages')!;
const aiInput     = document.getElementById('ai-input') as HTMLInputElement;
const clearBtn    = document.getElementById('clear-btn')!;
const sendBtn     = document.getElementById('send-btn') as HTMLButtonElement;

function currentSess(): AiSession { return sessions.find(s => s.id === activeSessId)!; }

function renderTabs() {
  sessionBar.querySelectorAll('.stab').forEach(el => el.remove());
  sessions.forEach(sess => {
    const btn = document.createElement('button');
    btn.className = 'stab' + (sess.id === activeSessId ? ' active' : '');
    btn.innerHTML = `<span>${sess.name}</span>` +
      (sessions.length > 1 ? `<span class="stab-x" data-del="${sess.id}" title="Close chat"><svg class="icon" aria-hidden="true"><use href="#i-x"/></svg></span>` : '');
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
    addBubble('Ask anything about Minecraft: crafting recipes, where to find ores, mobs, enchantments, potions or commands.', false).classList.add('intro');
    return;
  }
  sess.history.forEach(m => addBubble(m.content, m.role === 'user'));
}

function switchSession(id: string) { activeSessId = id; renderTabs(); renderMessages(); }

function deleteSession(id: string) {
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return;
  sessions.splice(idx, 1);
  if (sessions.length === 0) { sessCounter++; sessions.push({ id: `s${sessCounter}`, name: `Chat ${sessCounter}`, history: [] }); }
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
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Turns 3×3 "[a][b][c]" rows into grid HTML. Each grid is returned separately
// and left in the text as a placeholder, so the markdown pass below can't cut
// into it (finding a grid's end by its closing tags stopped after the first row).
function renderCraftingGrids(text: string): { text: string; grids: string[] } {
  const rowPat = /^\s*(\[[^\]]*\]){3}\s*$/;
  const lines = text.split('\n');
  const out: string[] = [];
  const grids: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (rowPat.test(lines[i]) && rowPat.test(lines[i+1] ?? '') && rowPat.test(lines[i+2] ?? '')) {
      const rows = [lines[i], lines[i+1], lines[i+2]];
      const html = rows.map(row => {
        const cells: string[] = [];
        const re = /\[([^\]]*)\]/g; let m;
        while ((m = re.exec(row)) !== null) cells.push(m[1].trim());
        return `<div class="craft-row">${cells.map(c => `<div class="craft-slot">${escHtml(c)}</div>`).join('')}</div>`;
      }).join('');
      grids.push(`<div class="craft-grid"><div class="craft-label">Crafting</div>${html}</div>`);
      out.push(`\u0000GRID${grids.length - 1}\u0000`);
      i += 3;
    } else { out.push(lines[i]); i++; }
  }
  return { text: out.join('\n'), grids };
}

function addBubble(text: string, isUser: boolean): HTMLElement {
  const div = document.createElement('div');
  div.className = 'bubble ' + (isUser ? 'user' : 'ai');
  if (isUser) {
    div.textContent = text;
  } else {
    const { text: withGrids, grids } = renderCraftingGrids(text);
    const parts = withGrids.split(/\u0000GRID(\d+)\u0000/);
    div.innerHTML = parts.map((p, i) => {
      if (i % 2 === 1) return grids[Number(p)];
      return escHtml(p)
        .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '• $1')
        .replace(/\n/g, '<br>');
    }).join('');
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function sendChat(q: string) {
  if (chatBusy || !q.trim()) return;
  chatBusy = true;
  sendBtn.disabled = true;

  addBubble(q, true);
  const typing = addBubble('Thinking…', false);
  typing.classList.add('typing');

  const sess = currentSess();
  sess.history.push({ role: 'user', content: q });
  if (sess.history.length > 20) sess.history.splice(0, sess.history.length - 20);

  try {
    const res = await (window as any).ai.chat(sess.history);
    typing.remove();
    if (!res.ok) throw new Error(res.error);
    sess.history.push({ role: 'assistant', content: res.text });
    addBubble(res.text, false);
  } catch (err: any) {
    typing.remove();
    addBubble("The assistant didn't answer. Wait a moment, then send your question again.", false).classList.add('error');
  }

  chatBusy = false;
  sendBtn.disabled = false;
  aiInput.focus();
}

clearBtn.addEventListener('click', () => { currentSess().history = []; renderMessages(); });
sendBtn.addEventListener('click', () => { const q = aiInput.value.trim(); if (q) { aiInput.value = ''; sendChat(q); } });
aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = aiInput.value.trim(); if (q) { aiInput.value = ''; sendChat(q); } } });

renderTabs();
renderMessages();
