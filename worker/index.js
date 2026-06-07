const SYSTEM_PROMPT = `You are a helpful AI assistant built into Voxel Client, a Minecraft launcher.
You help users with:
- Minecraft gameplay: crafting recipes (show the 3x3 grid pattern), commands, biomes, mobs, mechanics, seeds, farms
- Voxel Client features: launching games, installing mods/modpacks, hosting servers, cosmetics, skins, friends, global chat
- Troubleshooting: crashes, Java errors, server connection issues, mod conflicts
Keep answers concise and practical. Use bullet points. For crafting recipes use a grid like:
[Wood][Wood][Wood]
[   ][Stick][   ]
[   ][Stick][   ]
Key facts to always get right:
- Nether portal minimum = 10 obsidian (corners optional). Full frame with corners = 14.
- Nether portal size: minimum 4 wide x 5 tall (inside 2x3), max 23x23.
- Never make up features that don't exist.`;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ ok: false, error: 'No messages provided' }, 400);
    }

    // Convert Claude-style messages to Gemini format
    // Gemini requires alternating user/model turns — merge consecutive same-role messages
    const contents = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += '\n' + m.content;
      } else {
        contents.push({ role, parts: [{ text: m.content }] });
      }
    }

    // Gemini requires first message to be user
    if (contents[0]?.role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: '(start)' }] });
    }

    const geminiBody = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
      ],
    };

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(geminiBody),
        }
      );

      const data = await resp.json();

      if (!resp.ok) {
        const msg = data.error?.message || `Gemini error ${resp.status}`;
        return json({ ok: false, error: msg });
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) return json({ ok: false, error: 'No response from AI' });

      return json({ ok: true, text });
    } catch (err) {
      return json({ ok: false, error: err.message || 'Request failed' });
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
