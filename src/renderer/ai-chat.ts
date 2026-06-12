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
    addBubble('Ask me anything about Minecraft — crafting recipes, ore locations, mobs, enchantments, potions, commands, and more!', false);
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

function renderCraftingGrids(text: string): string {
  const rowPat = /^\s*(\[[^\]]*\]){3}\s*$/;
  const lines = text.split('\n');
  const out: string[] = [];
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
      out.push(`<div class="craft-grid"><div class="craft-label">Crafting</div>${html}</div>`);
      i += 3;
    } else { out.push(lines[i]); i++; }
  }
  return out.join('\n');
}

function addBubble(text: string, isUser: boolean): HTMLElement {
  const div = document.createElement('div');
  div.className = 'bubble ' + (isUser ? 'user' : 'ai');
  if (isUser) {
    div.textContent = text;
  } else {
    const withGrids = renderCraftingGrids(text);
    const parts = withGrids.split(/(<div class="craft-grid">[\s\S]*?<\/div><\/div>)/);
    div.innerHTML = parts.map(p => {
      if (p.startsWith('<div class="craft-grid">')) return p;
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

// ── Local Minecraft Knowledge Base ────────────────────────────────────────────

type G = [string,string,string,string,string,string,string,string,string];
const _ = '';

const RECIPES: Record<string, { g: G; note?: string }> = {
  // Pickaxes
  'wooden pickaxe':  { g:['Wood','Wood','Wood',_,'Stick',_,_,'Stick',_] },
  'stone pickaxe':   { g:['Stone','Stone','Stone',_,'Stick',_,_,'Stick',_] },
  'iron pickaxe':    { g:['Iron','Iron','Iron',_,'Stick',_,_,'Stick',_] },
  'golden pickaxe':  { g:['Gold','Gold','Gold',_,'Stick',_,_,'Stick',_] },
  'diamond pickaxe': { g:['Diamond','Diamond','Diamond',_,'Stick',_,_,'Stick',_] },
  // Swords
  'wooden sword':  { g:[_,'Wood',_,_,'Wood',_,_,'Stick',_] },
  'stone sword':   { g:[_,'Stone',_,_,'Stone',_,_,'Stick',_] },
  'iron sword':    { g:[_,'Iron',_,_,'Iron',_,_,'Stick',_] },
  'golden sword':  { g:[_,'Gold',_,_,'Gold',_,_,'Stick',_] },
  'diamond sword': { g:[_,'Diamond',_,_,'Diamond',_,_,'Stick',_] },
  // Axes
  'wooden axe':  { g:['Wood','Wood',_,'Wood','Stick',_,_,'Stick',_] },
  'stone axe':   { g:['Stone','Stone',_,'Stone','Stick',_,_,'Stick',_] },
  'iron axe':    { g:['Iron','Iron',_,'Iron','Stick',_,_,'Stick',_] },
  'golden axe':  { g:['Gold','Gold',_,'Gold','Stick',_,_,'Stick',_] },
  'diamond axe': { g:['Diamond','Diamond',_,'Diamond','Stick',_,_,'Stick',_] },
  // Shovels
  'wooden shovel':  { g:[_,'Wood',_,_,'Stick',_,_,'Stick',_] },
  'stone shovel':   { g:[_,'Stone',_,_,'Stick',_,_,'Stick',_] },
  'iron shovel':    { g:[_,'Iron',_,_,'Stick',_,_,'Stick',_] },
  'golden shovel':  { g:[_,'Gold',_,_,'Stick',_,_,'Stick',_] },
  'diamond shovel': { g:[_,'Diamond',_,_,'Stick',_,_,'Stick',_] },
  // Hoes
  'wooden hoe':  { g:['Wood','Wood',_,_,'Stick',_,_,'Stick',_] },
  'stone hoe':   { g:['Stone','Stone',_,_,'Stick',_,_,'Stick',_] },
  'iron hoe':    { g:['Iron','Iron',_,_,'Stick',_,_,'Stick',_] },
  'golden hoe':  { g:['Gold','Gold',_,_,'Stick',_,_,'Stick',_] },
  'diamond hoe': { g:['Diamond','Diamond',_,_,'Stick',_,_,'Stick',_] },
  // Armor - Iron
  'iron helmet':     { g:['Iron','Iron','Iron','Iron',_,'Iron',_,_,_] },
  'iron chestplate': { g:['Iron',_,'Iron','Iron','Iron','Iron','Iron','Iron','Iron'] },
  'iron leggings':   { g:['Iron','Iron','Iron','Iron',_,'Iron','Iron',_,'Iron'] },
  'iron boots':      { g:[_,_,_,'Iron',_,'Iron','Iron',_,'Iron'] },
  // Armor - Diamond
  'diamond helmet':     { g:['Dia','Dia','Dia','Dia',_,'Dia',_,_,_] },
  'diamond chestplate': { g:['Dia',_,'Dia','Dia','Dia','Dia','Dia','Dia','Dia'] },
  'diamond leggings':   { g:['Dia','Dia','Dia','Dia',_,'Dia','Dia',_,'Dia'] },
  'diamond boots':      { g:[_,_,_,'Dia',_,'Dia','Dia',_,'Dia'] },
  // Armor - Gold
  'golden helmet':     { g:['Gold','Gold','Gold','Gold',_,'Gold',_,_,_] },
  'golden chestplate': { g:['Gold',_,'Gold','Gold','Gold','Gold','Gold','Gold','Gold'] },
  'golden leggings':   { g:['Gold','Gold','Gold','Gold',_,'Gold','Gold',_,'Gold'] },
  'golden boots':      { g:[_,_,_,'Gold',_,'Gold','Gold',_,'Gold'] },
  // Armor - Leather
  'leather helmet':     { g:['Leath','Leath','Leath','Leath',_,'Leath',_,_,_] },
  'leather chestplate': { g:['Leath',_,'Leath','Leath','Leath','Leath','Leath','Leath','Leath'] },
  'leather leggings':   { g:['Leath','Leath','Leath','Leath',_,'Leath','Leath',_,'Leath'] },
  'leather boots':      { g:[_,_,_,'Leath',_,'Leath','Leath',_,'Leath'] },
  // Core blocks
  'crafting table': { g:['Plank','Plank',_,'Plank','Plank',_,_,_,_] },
  'furnace':   { g:['Stone','Stone','Stone','Stone',_,'Stone','Stone','Stone','Stone'] },
  'chest':     { g:['Plank','Plank','Plank','Plank',_,'Plank','Plank','Plank','Plank'] },
  'torch':     { g:[_,'Coal',_,_,'Stick',_,_,_,_], note:'Coal or Charcoal. Makes 4.' },
  'stick':     { g:[_,'Plank',_,_,'Plank',_,_,_,_], note:'Makes 4 sticks.' },
  'ladder':    { g:['Stick',_,'Stick','Stick','Stick','Stick','Stick',_,'Stick'], note:'Makes 3.' },
  'planks':    { g:[_,'Log',_,_,_,_,_,_,_], note:'Any log → 4 planks (shapeless).' },
  // Weapons / ranged
  'bow':       { g:[_,'Stick','String','Stick',_,'String',_,'Stick','String'] },
  'arrow':     { g:[_,'Flint',_,_,'Stick',_,_,'Feather',_], note:'Makes 4.' },
  'crossbow':  { g:['Stick','Iron','Stick','String','Hook','String',_,'Stick',_], note:'Hook = Tripwire Hook.' },
  'shield':    { g:['Plank','Iron','Plank','Plank','Plank','Plank',_,'Plank',_] },
  'fishing rod':{ g:[_,_,'Stick',_,'Stick','String',_,'String',_] },
  'flint and steel': { g:[_,'Iron',_,_,_,'Flint',_,_,_] },
  'shears':    { g:[_,'Iron',_,'Iron',_,_,_,_,_] },
  // Bed / Door
  'bed':       { g:[_,_,_,'Wool','Wool','Wool','Plank','Plank','Plank'], note:'Any wool color.' },
  'wooden door': { g:['Plank','Plank',_,'Plank','Plank',_,'Plank','Plank',_], note:'Makes 3.' },
  'iron door': { g:['Iron','Iron',_,'Iron','Iron',_,'Iron','Iron',_], note:'Needs button/pressure plate to open.' },
  // Redstone
  'redstone torch':      { g:[_,'Dust',_,_,'Stick',_,_,_,_], note:'Dust = Redstone Dust.' },
  'redstone repeater':   { g:[_,_,_,'R.Torch','Dust','R.Torch','Stone','Stone','Stone'], note:'R.Torch = Redstone Torch.' },
  'redstone comparator': { g:[_,_,_,'R.Torch','Quartz','R.Torch','Stone','Stone','Stone'], note:'Quartz = Nether Quartz.' },
  'lever':     { g:[_,'Stick',_,_,'Cobble',_,_,_,_] },
  'piston':    { g:['Plank','Plank','Plank','Cobble','Iron','Cobble','Cobble','Dust','Cobble'] },
  'sticky piston': { g:[_,'Slime',_,_,'Piston',_,_,_,_] },
  'observer':  { g:['Cobble','Cobble','Cobble','Quartz','Quartz','Cobble','Dust','Dust','Cobble'] },
  'hopper':    { g:['Iron',_,'Iron','Iron','Chest','Iron',_,'Iron',_] },
  'dropper':   { g:['Cobble','Cobble','Cobble','Cobble',_,'Cobble','Cobble','Dust','Cobble'] },
  'dispenser': { g:['Cobble','Cobble','Cobble','Cobble','Bow','Cobble','Cobble','Dust','Cobble'] },
  'tnt':       { g:['Sand','Powder','Sand','Powder','Sand','Powder','Sand','Powder','Sand'], note:'Powder = Gunpowder.' },
  // Utility
  'bucket':    { g:['Iron',_,'Iron',_,'Iron',_,_,_,_] },
  'compass':   { g:[_,'Iron',_,'Iron','Dust','Iron',_,'Iron',_] },
  'clock':     { g:[_,'Gold',_,'Gold','Dust','Gold',_,'Gold',_] },
  'map':       { g:['Paper','Paper','Paper','Paper','Compass','Paper','Paper','Paper','Paper'] },
  // Enchanting / storage
  'enchanting table': { g:[_,'Book',_,'Diamond','Obsidian','Diamond','Obsidian','Obsidian','Obsidian'] },
  'anvil':     { g:['Iron Blk','Iron Blk','Iron Blk','Iron','Iron','Iron','Iron','Iron','Iron'], note:'Iron Blk = Iron Block (9 iron ingots each).' },
  'grindstone': { g:['Stick','Stone Slab','Stick','Plank',_,'Plank',_,_,_] },
  'ender chest': { g:['Obsidian','Obsidian','Obsidian','Obsidian','Eye','Obsidian','Obsidian','Obsidian','Obsidian'], note:'Eye = Eye of Ender.' },
  // Brewing / potions
  'brewing stand': { g:[_,_,_,_,'Blaze Rod',_,'Cobble','Cobble','Cobble'] },
  'cauldron':  { g:['Iron',_,'Iron','Iron',_,'Iron','Iron','Iron','Iron'] },
  'blaze powder': { g:[_,'Blaze Rod',_,_,_,_,_,_,_], note:'Makes 2. Needed to fuel Brewing Stands and craft Eyes of Ender.' },
  'eye of ender': { g:[_,'E.Pearl',_,_,'B.Powder',_,_,_,_], note:'E.Pearl = Ender Pearl, B.Powder = Blaze Powder.' },
  // Books
  'book':      { g:[_,'Paper',_,_,'Paper',_,_,'Leather',_] },
  'bookshelf': { g:['Plank','Plank','Plank','Book','Book','Book','Plank','Plank','Plank'] },
  'lectern':   { g:['Plank','Plank','Plank',_,'Bookshelf',_,_,'Plank',_] },
  // Misc
  'painting':    { g:['Stick','Stick','Stick','Stick','Wool','Stick','Stick','Stick','Stick'] },
  'item frame':  { g:['Stick','Stick','Stick','Stick','Leather','Stick','Stick','Stick','Stick'] },
  'armor stand': { g:['Stick','Stick','Stick',_,'Stick',_,'Plank','Stick','Plank'] },
  'beacon':      { g:['Glass','Glass','Glass','Glass','Nether Star','Glass','Obsidian','Obsidian','Obsidian'], note:'Nether Star is dropped by the **Wither** boss.' },
  // Non-craftable
  'elytra':     { g:[_,_,_,_,_,_,_,_,_], note:'**Elytra** cannot be crafted. Find them in **End Ship chests** inside End Cities (after defeating the Ender Dragon).' },
  'trident':    { g:[_,_,_,_,_,_,_,_,_], note:'**Tridents** cannot be crafted. Dropped by **Drowned** that spawn holding one (~8.5% chance, higher with Looting).' },
  'totem of undying': { g:[_,_,_,_,_,_,_,_,_], note:'**Totems** cannot be crafted. Always dropped by **Evokers** (Woodland Mansions and Raids).' },
  'saddle':     { g:[_,_,_,_,_,_,_,_,_], note:'**Saddles** cannot be crafted. Find in chests (villages, dungeons, Nether fortresses, bastions) or via **fishing**.' },
  'name tag':   { g:[_,_,_,_,_,_,_,_,_], note:'**Name Tags** cannot be crafted. Found in dungeon/mineshaft/bastion chests, or via **fishing** (rare).' },
};

const ALIASES: Record<string,string> = {
  'pickaxe':'iron pickaxe','sword':'iron sword','axe':'iron axe','shovel':'iron shovel','hoe':'iron hoe',
  'helmet':'iron helmet','chestplate':'iron chestplate','leggings':'iron leggings','boots':'iron boots',
  'door':'wooden door','workbench':'crafting table','crafting bench':'crafting table','wood planks':'planks',
  'wooden planks':'planks','oak planks':'planks','plank':'planks',
};

function gridText(g: G): string {
  const c = g.map(x => x || '   ');
  return `[${c[0]}][${c[1]}][${c[2]}]\n[${c[3]}][${c[4]}][${c[5]}]\n[${c[6]}][${c[7]}][${c[8]}]`;
}

function lookupRecipe(item: string): string | null {
  const key = item.toLowerCase().trim().replace(/^(a |an |the )/, '');
  const r = RECIPES[key] ?? RECIPES[ALIASES[key]];
  if (!r) {
    // fuzzy
    const match = Object.keys(RECIPES).find(k => k.includes(key) || key.includes(k));
    if (!match) return null;
    return lookupRecipe(match);
  }
  const name = key.charAt(0).toUpperCase() + key.slice(1);
  if (!r.g.some(c => c.trim())) return r.note ?? `**${name}** cannot be crafted.`;
  return `**${name}**\n${gridText(r.g)}${r.note ? '\n\n' + r.note : ''}`;
}

// Knowledge base
interface KB { tags: string[]; ans: string; }
const KB: KB[] = [
  { tags:['diamond','find','where','mine','y level','depth','ore'],
    ans:`**Diamonds** spawn Y **-64 to 16**, most at **Y -58**.
- Strip mine at Y -58 for best results
- Exposed in deep cave systems — explore them too
- Use **Fortune III** pickaxe: up to 4 diamonds per ore` },

  { tags:['iron','find','where','mine','y level','ore'],
    ans:`**Iron Ore** spawns Y **-64 to 320**. Two peak zones:
- **Y 15** — underground mining
- **Y 232** — mountain biomes (Windswept Peaks especially)
- Very common; smelt into ingots before use` },

  { tags:['gold','find','where','mine','y level','ore'],
    ans:`**Gold Ore** spawns Y **-64 to 32**, peak at **Y -16**.
- **Badlands biome**: gold spawns all the way to Y 256
- **Nether**: Nether Gold Ore at any Y level in Nether Wastes
- Fortune III gives more raw gold` },

  { tags:['netherite','ancient debris','find','where','mine','y level','upgrade'],
    ans:`**Ancient Debris** — Nether only, **Y 8–22**, peak at **Y 15**.
- TNT mining at Y 15 is fastest
- Smelt Ancient Debris → **Netherite Scrap**
- At a **Smithing Table**: 4 Scraps + 4 Gold Ingots + Smithing Template → **Netherite Ingot**
- Use the ingot to upgrade diamond gear (template found in bastion chests)` },

  { tags:['emerald','find','where','mine','ore'],
    ans:`**Emeralds** only spawn in **mountain biomes** (Windswept Hills, Frozen Peaks, Jagged Peaks, etc.).
- Y **-16 to 320**, peak around Y 232
- Best source: **trading with Villagers** — much more efficient than mining` },

  { tags:['lapis','find','where','mine','y level'],
    ans:`**Lapis Lazuli** spawns Y **-64 to 64**, peak at **Y 0**.
- Required for enchanting (costs lapis per enchant)
- Keep a good supply — you'll use a lot at the enchanting table` },

  { tags:['redstone','find','where','mine','y level','ore'],
    ans:`**Redstone Ore** spawns Y **-64 to 16**, peak at **Y -58** (same as diamonds).
- Fortune III gives more dust per ore
- Used for circuits, mechanisms, and extending potion duration` },

  { tags:['coal','find','where','mine','ore'],
    ans:`**Coal** spawns Y **0 to 320**, most common around **Y 95**.
- Also visible on cliff faces and mountain sides
- **Charcoal** alternative: smelt any log in a furnace — identical to coal` },

  { tags:['copper','find','where','mine','ore'],
    ans:`**Copper Ore** spawns Y **-16 to 112**, peak at **Y 48**.
- Most common in **Dripstone Cave** biomes
- Smelt into Copper Ingots → craft spyglass, lightning rod, copper blocks` },

  { tags:['ender dragon','kill','fight','boss','end','dragon'],
    ans:`**Killing the Ender Dragon:**
1. **Destroy End Crystals** on obsidian pillars (shoot with bow — some are caged, shoot through bars)
2. Dragon perches on the fountain — **sword attack** it there for max damage
3. Avoid the purple breath (deals Dragon damage that ignores armor)
4. Use a **bed in the End** as a cheap explosive if you're brave
5. Drops 12,000 XP + opens exit portal with **dragon egg** on top` },

  { tags:['wither','summon','kill','fight','boss','nether star'],
    ans:`**Wither Boss:**

**Summon:** 4 Soul Sand/Soil in T-shape + 3 Wither Skeleton Skulls on top row.

**Tips:**
- Fight underground — ceiling limits its movement
- At 50% HP it turns blue (immune to arrows) — switch to sword
- **Smite V** sword deals extra damage (Wither is undead)
- Bring **Milk** to cure the Wither effect
- Drops: **Nether Star** → craft a Beacon` },

  { tags:['warden','ancient city','avoid','fight','deep dark','sculk','sonic'],
    ans:`**Warden (Ancient City):**
- 250 HP, Sonic Boom pierces all armor — **do not fight it**
- **Sneak** everywhere in the Deep Dark to minimize noise
- Throw **snowballs** elsewhere to distract it
- Skulk sensors detect vibration — avoid walking on them
- Goal: sneak to the Ancient City chests for **Swift Sneak** books, echo shards, and loot` },

  { tags:['creeper','explosion','avoid','kill'],
    ans:`**Creeper tips:**
- Spawns at light level 0 (light up your base with torches)
- **1.5 seconds** between hiss and explosion — back away and hit it
- **Cats** scare creepers — keep one in your base
- Charged creeper (lightning-struck) = massive explosion + drops mob heads
- Drops: Gunpowder, and music discs if killed by a skeleton arrow` },

  { tags:['enderman','pearl','fight','look','attack'],
    ans:`**Enderman tips:**
- Don't look at their eyes — triggers aggro
- **Pumpkin on head** lets you stare at them safely
- Stand in water — they teleport away and take damage
- Build an Enderman farm in The End for XP + Ender Pearls
- Drops: Ender Pearl (0–1)` },

  { tags:['blaze','blaze rod','nether fortress','fight'],
    ans:`**Blaze tips:**
- Found in **Nether Fortresses** — spawns from Blaze Spawners
- Immune to fire; throws fireballs in groups of 3
- **Snowballs** deal 3 damage each — easy way to kill them
- Drops: **Blaze Rod** (0–1) — needed for Eyes of Ender and brewing
- Build a farm around the spawner for bulk Blaze Rod farming` },

  { tags:['nether','how to get','portal','go to','enter','obsidian','make portal'],
    ans:`**Getting to the Nether:**
1. Mine **Obsidian** (pour water on lava source blocks, mine with diamond+ pickaxe)
2. Build frame: minimum **4 wide × 5 tall** (2×3 inside, corners optional)
3. Light with **Flint and Steel**
4. Walk in

**Nether tips:**
- Bring **Fire Resistance potions** (lava is everywhere)
- Wear **gold armor** — Piglins ignore you if you do
- Find **Nether Fortresses** (blazes, wither skeletons, chests) and **Bastion Remnants** (piglin trades, netherite loot)` },

  { tags:['end','how to get','stronghold','end portal','eye of ender','locate'],
    ans:`**Getting to The End:**
1. Craft **Eyes of Ender** (Ender Pearl + Blaze Powder)
2. Throw them — they float toward the nearest **Stronghold** (use ~10–12)
3. Dig down where the eye hovers; explore the stronghold to find the **End Portal room**
4. Fill all 12 frames with Eyes of Ender
5. Jump in

After the Dragon: End Gateways → **End Cities** → **Elytra** + **Shulker Boxes**` },

  { tags:['enchanting','how to','bookshelf','bookshelves','setup','levels','xp'],
    ans:`**Enchanting Setup:**
- Craft an **Enchanting Table** (Book + 2 Diamonds + 4 Obsidian)
- Place **15 Bookshelves** around it (1 block gap, same height or 1 above) for max level-30 enchants
- Place item + **Lapis Lazuli** in the table → pick from 3 options

**Best enchants:**
- **Sword**: Sharpness V, Looting III, Unbreaking III, Mending
- **Pickaxe**: Efficiency V, Fortune III (or Silk Touch), Unbreaking III, Mending
- **Armor**: Protection IV, Unbreaking III, Mending, Feather Falling IV (boots)
- **Bow**: Power V, Punch II, Flame, Infinity` },

  { tags:['mending','how to get','treasure','enchantment','repair'],
    ans:`**Mending** is a treasure enchantment — can't get it from the enchanting table.

**How to get it:**
- **Fishing** — most reliable (~1%, higher with Luck of the Sea III)
- **Librarian Villager** — break and replace the Lectern to re-roll their trades until they sell Mending
- **Chests** — dungeons, bastions, temples, strongholds

**How it works:** While the Mending item is held or equipped, XP orbs repair it instead of giving you levels.` },

  { tags:['fortune','silk touch','difference','vs','which','better'],
    ans:`**Fortune vs Silk Touch:**

**Fortune III**: More drops from ore
- Diamond/Emerald/Lapis/Redstone/Coal/Quartz → extra items per block
- Best for resource efficiency

**Silk Touch**: Pick up the block itself
- Diamond Ore block (smelt later — no Fortune bonus)
- Move glass, ice, bookshelves, beehives, coral
- Collect mushroom blocks, nylium, grass blocks

**Which?** Fortune III for mining. Silk Touch for specific collection.` },

  { tags:['brewing','potion','how to brew','ingredients','effect','recipe'],
    ans:`**Brewing Guide:**
1. Craft **Brewing Stand** (Blaze Rod + 3 Cobblestone)
2. Fuel with **Blaze Powder**
3. Make **Awkward Potion** first: Water Bottle + Nether Wart
4. Add ingredient to Awkward Potion:

- **Glistering Melon** → Healing
- **Magma Cream** → Fire Resistance ← bring to Nether!
- **Sugar** → Speed
- **Blaze Powder** → Strength
- **Spider Eye** → Poison
- **Golden Carrot** → Night Vision
- **Pufferfish** → Water Breathing
- **Ghast Tear** → Regeneration

Modifiers: **Redstone** = longer duration | **Glowstone** = Level II | **Gunpowder** = Splash Potion` },

  { tags:['villager','trade','librarian','profession','job','reset','emerald'],
    ans:`**Villager Trading Tips:**
- Each profession needs a **job site block** (Librarian = Lectern, Farmer = Composter, etc.)
- **Re-roll trades**: break and replace the job site block to reset (only works before the trade is locked)
- Level up by trading to unlock better items (Novice → Master)
- **Librarians** can sell any enchanted book — keep re-rolling for Mending, Silk Touch, etc.
- **Cure zombie villagers**: Splash Weakness Potion + Golden Apple → discounted trades forever` },

  { tags:['food','hunger','best food','saturation','eat'],
    ans:`**Best Food:**
- **Cooked Beef/Pork/Mutton** — great saturation, easy to farm
- **Golden Carrot** — highest saturation in the game
- **Bread** — cheap and reliable from wheat farms
- **Cooked Salmon** — good for early game / fishing

Eat before hunger bar drops below 3 icons for maximum efficiency. Saturation acts as a hidden buffer above the hunger bar.` },

  { tags:['xp','experience','farm','level up','grind','fastest'],
    ans:`**Best XP Sources:**
1. **Enderman farm** (The End) — fastest XP in game
2. **Mob spawner trap** — find dungeon spawner, build kill chamber
3. **Guardian farm** — ocean monument
4. **Auto smelter** — bamboo/cactus smelting gives XP per output
5. **Kelp farm** → dry kelp → tons of XP per stack

Use XP for: enchanting, anvil repairs. **Mending** gear means XP auto-repairs it while you play.` },

  { tags:['command','cheat','give','gamemode','teleport','tp','time','weather','commands'],
    ans:`**Common Commands** (enable cheats in world settings):

\`/gamemode creative\` — creative mode
\`/gamemode survival\` — back to survival
\`/give @s diamond 64\` — give 64 diamonds
\`/tp @s 0 64 0\` — teleport to X Y Z
\`/time set day\` or \`night\`
\`/weather clear\`
\`/effect give @s night_vision 99999 1\`
\`/kill @e[type=!player]\` — clear all mobs
\`/enchant @s sharpness 5\`
\`/gamerule keepInventory true\` — keep items on death
\`/seed\` — see your world seed` },

  { tags:['nether portal','coordinate','ratio','distance','scale','travel'],
    ans:`**Nether Portal Coordinates:**
- Nether is **8× compressed** — 1 block in Nether = 8 blocks in Overworld
- Overworld → Nether: divide X and Z by 8
- Nether → Overworld: multiply X and Z by 8

**Example**: Overworld (800, Y, 400) → build Nether portal at (~100, Y, ~50)

Great for long-distance fast travel — build linked portals for an instant highway!` },

  { tags:['spawn','set spawn','respawn','bed','anchor','where'],
    ans:`**Setting Spawn Point:**
- **Overworld**: sleep in a **Bed** to set spawn (right-click at night)
- **Nether**: craft a **Respawn Anchor** (6 Crying Obsidian + 3 Glowstone), charge with Glowstone (max 4 charges)
- **End**: no spawn setting possible here
- If your bed is destroyed → you respawn at world spawn
- \`/setworldspawn\` sets the default spawn for all players (requires cheats/op)` },

  { tags:['shulker box','shulker','how to get','storage','portable'],
    ans:`**Shulker Boxes:**
- Craft: 2 **Shulker Shells** + 1 **Chest**
- Shulker Shells drop from **Shulkers** in End Cities
- **Keep inventory when broken** — essential for transport
- Can be dyed any of 16 colors for organization
- Pro tip: fill a shulker box with 27 more shulker boxes → massive portable storage in one inventory slot` },

  { tags:['seed','world seed','find','check','what is','chunkbase'],
    ans:`**Finding Your World Seed:**
- Type \`/seed\` in chat (Java: always works; Bedrock: needs cheats)
- Or check **Settings → Game** in Bedrock

Use **Chunkbase.com** — enter your seed to see a full map with biomes, structures, ore veins, and slime chunks.` },

  { tags:['voxel client','features','mods','install','modpack','launcher'],
    ans:`**Voxel Client Features:**
- **Mod installer** — browse and install Modrinth mods in-app
- **Modpack installer** — one-click popular modpack setup
- **Server hosting** — run a local Minecraft server from the app
- **Voice chat** — proximity voice chat support
- **Cosmetics & skins** — custom capes, skin uploader
- **Friends & global chat** — Firebase-based social features
- **Bedrock launcher** — launch Minecraft Bedrock Edition
- **Multi-Java support** — Java 8, 17, 21 for different MC versions` },

  // ── Building Tips ──────────────────────────────────────────────────────────

  { tags:['building','tips','advice','how to build','better','improve','builds'],
    ans:`**Core Building Tips:**
- **Add depth** — push some blocks in/out by 1 block so walls aren't flat
- **Mix materials** — combine stone bricks + cobblestone + mossy stone bricks for texture
- **Use stairs & slabs** as detail: roofing, window ledges, furniture, pillars
- **Vary your roof** — a flat roof looks unfinished; try gabled, pyramid, or mansard shapes
- **Interior matters** — empty rooms feel hollow; add furniture using slabs, stairs, trapdoors, and item frames
- **Light everything** — hidden light sources (under slabs, behind walls) look better than torches everywhere
- **Plan before you build** — sketch the footprint first, then go up` },

  { tags:['house','build a house','starter house','basic house','home','cabin'],
    ans:`**How to Build a Good House:**

**Shape**: Start with an L-shape or split-level instead of a plain rectangle — instantly more interesting.

**Materials** (pick a palette of 3–4):
- Wood cottage: Oak Log + Oak Planks + Cobblestone + Stone Brick
- Stone keep: Stone Brick + Cobblestone + Deepslate Brick + Mossy Stone Brick
- Modern: Smooth Stone + White Concrete + Glass + Dark Oak

**Walls**: Don't go perfectly flat — offset some blocks, add pillars at corners, use logs/stone as framing.

**Roof tips**:
- Gabled roof: rows of stairs stepping up to a ridge
- Add **overhangs** (extend 1 block out from wall top) for depth
- Use **upside-down stairs** under the eaves for a curved underside

**Inside**: Sleeping loft above storage, separate crafting room from bedroom, trap door hatches to basement.` },

  { tags:['roof','roofing','how to build roof','gable','pyramid','mansard'],
    ans:`**Roof Types & How to Build Them:**

**Gabled (A-frame):**
- Row 1: full-width stairs pointing inward on both sides
- Row 2: walls 1 block narrower on each side, then stairs again
- Repeat until you meet at a ridge of upright blocks
- Add **overhangs**: extend bottom row 1 block past the wall

**Pyramid:**
- Each layer steps in 1 block on all 4 sides
- Use stairs on each layer edge
- Good for towers and square buildings

**Mansard (hip roof with flat top):**
- Use **upside-down stairs** angled outward on the first layer for a curved look
- Add a flat section at the top

**Curved/Dome:**
- Use a circle generator (Chunkbase has one)
- Layer circles of decreasing size with slabs for smoothing

**Tips:**
- Overhang 1–2 blocks past the wall for realism
- Mix stair types (oak + spruce) for colour variation
- **Trapdoors** on the roof edge add detail` },

  { tags:['wall','walls','depth','texture','flat','boring wall','detail'],
    ans:`**Adding Wall Depth & Texture:**
- **Pilasters**: place full blocks every 4–6 blocks along a flat wall (like columns)
- **Inset panels**: push a 2–3 block wide section 1 block inward between pilasters
- **Mixed materials**: alternate stone brick + cobblestone + cracked stone brick rows
- **Windows with frames**: surround glass with wood logs or stone brick, add **trapdoors** as shutters
- **Vines** on stone walls for a natural/aged look (bone meal to grow them)
- **Banners** hung between windows add color and life
- **Chiseled blocks** (chiseled stone brick, deepslate) as accent blocks at corners or above doorways` },

  { tags:['interior','inside','furniture','decoration','decorate','room','furnish'],
    ans:`**Interior Decoration Ideas:**

**Furniture with blocks:**
- **Sofa**: stairs facing outward + signs on the sides as armrests
- **Table**: fence post + pressure plate or carpet on top
- **Bookshelf wall**: actual bookshelves + item frames with books
- **Bed area**: use banners as curtains hanging from the ceiling
- **Kitchen**: trapdoor as cabinet door, barrel + item frames as pantry, cauldron as sink
- **Fireplace**: netherrack in a stone/brick surround — light it for a real fire
- **Chandelier**: fence chain hanging down + lanterns

**Lighting without torches:**
- **Glowstone/Shroomlight** hidden under slabs or behind walls
- **Lanterns** hanging from ceiling (fence + lantern)
- **Sea lanterns** in underwater or modern builds
- **Candles** for subtle mood lighting

**Floors**: Don't use just one material — try wood planks + carpet strips, or stone tile patterns with slabs` },

  { tags:['medieval','castle','knight','stone','fortress','tower','keep'],
    ans:`**Medieval / Castle Building:**

**Materials**: Stone Brick, Cobblestone, Mossy Stone Brick, Cracked Stone Brick, Deepslate Brick, Dark Oak

**Castle walls:**
- 5–8 blocks tall, 2 blocks thick
- Add **crenellations** (battlements): alternate full blocks and gaps of 1 block along the top
- Place **Torches/Lanterns** on the merlons (solid sections)
- Corner towers should be round (use a circle template) or octagonal

**Towers:**
- Taper slightly as they go up (step in 1 block every 5–6 floors)
- Add a **conical roof** (pyramid stairs) or **flat battlement** top
- Arrow slit windows: 1 block tall, 1 wide — use iron bars for a barred look

**Interior:**
- Great hall with long tables (fence + pressure plates), fireplace, banners
- Spiral staircase in towers (staircase blocks wrapping around a 3×3 core)
- Dungeon below with cobblestone, iron bar cells, and mossy cobblestone floor

**Courtyard**: Cobblestone path, a well (fence circle + bucket item frame), stables with hay bales` },

  { tags:['modern','house','contemporary','minimalist','sleek','city','urban'],
    ans:`**Modern Building Tips:**

**Materials**: Smooth Stone, White/Light Gray Concrete, Glass (full panes + blocks), Quartz, Polished Blackstone, Dark Oak or Spruce for accents

**Key techniques:**
- **Flat or low-slope roofs** — often fully flat, or a single slope
- **Large window walls**: 3–5 block tall glass sections with thin concrete frames
- **Cantilevers**: extend upper floors 2–3 blocks past the ground floor for a floating look
- **Mixed levels**: split-level floors (half-slabs for slight height changes)
- **Balconies**: extend floor 2–3 blocks out, railing with glass panes or iron bars

**Color palette**: Keep it to 2–3 neutral colors. Add one accent (dark oak trim, a colored concrete band)

**Landscaping**: Flat grass, gravel path, ornamental trees (birch or cherry), simple hedges with leaf blocks` },

  { tags:['medieval village','village','houses','town','buildings','settlement'],
    ans:`**Building a Village / Town:**
- **Vary building sizes** — not every house the same height or footprint
- **Use different styles** in the same village: one house timber-framed, one stone, one with a tower
- **Roads**: dirt path, gravel, or stone slab roads connecting buildings — curve them slightly
- **Town center**: well, notice board (sign on a post), small market stalls (trapdoor counters under awnings)
- **Lighting**: lanterns on fence posts lining roads
- **Gardens**: fenced plots with flowers, hay bales, barrels near farms
- **Height variation**: build on slight hills, use retaining walls for terracing
- **Details**: carts (trapdoor + fence wheels), barrels, boats near water` },

  { tags:['farm','barn','farmhouse','stable','agricultural','crops'],
    ans:`**Farm & Barn Building:**

**Barn exterior:**
- **Materials**: Spruce/Oak Planks, Stripped Log pillars, Cobblestone base, Red/Brown Terracotta roof
- Wide shape: 12–16 blocks wide, tall enough for a loft (8+ blocks)
- Large double doors centered on the front (4 blocks wide × 4 tall of trapdoors + fence framing)
- Hay bales stacked inside and out

**Farmhouse:**
- Stone or brick base (1–2 blocks high), wood frame above
- Covered porch: overhang on pillars (stripped logs), trapdoor railings
- Fenced vegetable garden beside the house

**Crop fields:**
- 9×9 hydrated plots (water in center) — plant wheat, carrots, potatoes, beetroot
- Scarecrow: fence post + carved pumpkin head + armor stand arms (trapdoor outstretched)
- Windmill: octagonal tower, sails made from trapdoors + fences` },

  { tags:['palace','mansion','grand','large','big house','estate','grand building'],
    ans:`**Grand / Mansion Building Tips:**
- **Symmetry** is key for formal/palatial buildings — plan a center axis and mirror both sides
- **Wings**: add side wings set back 2–4 blocks from the main facade
- **Columns**: 2×2 quartz or stone pillar columns with capitals (upside-down stair + slab on top)
- **Grand entrance**: raised platform with steps up to double doors, flanked by columns and torches
- **Tall windows**: floor-to-ceiling glass with decorative stone frames
- **Dormers**: small protruding roof sections with their own tiny peaked roofs
- **Grounds**: formal garden with symmetrical hedges (leaf blocks), fountain (blue terracotta + water), stone path` },

  { tags:['tree','trees','custom tree','organic','nature','forest','garden'],
    ans:`**Custom Tree Building:**

**Basic custom tree:**
1. Place a trunk of **logs** — vary the height and add slight bends (offset 1 block)
2. Branch out: at the top, extend 2–3 logs in different directions before placing leaf clusters
3. Leaf clusters: irregular oval/sphere shapes — no perfect cubes! Remove corner blocks

**Large oak style**: trunk 3×3 at base tapering to 1, branches angling upward and outward, large irregular leaf canopy

**Cherry/Sakura**: Pale Oak or Azalea Leaves in pink, drooping branches (hang logs slightly down), wide flat canopy

**Dead tree**: no leaves, gnarled bare branches, vines hanging down, great for spooky builds

**Jungle tree**: 2×2 trunk, very tall, vines covering the trunk, sprawling branches with jungle leaves

**Tips:**
- Use **multiple leaf types** (oak + birch) for color variation
- Let leaves **droop 1 block** past the last branch for realism
- Add **bee nests** or **bird nests** (trapdoor + egg item frame) for life` },

  { tags:['underground','bunker','underground base','cave base','hidden base','basement'],
    ans:`**Underground / Cave Base:**
- **Entrance**: hidden door (painting over door, piston door, waterfall entrance)
- **Lighting**: Shroomlight or Glowstone in ceiling for cave feel, or lanterns hanging from chains
- **Wall material**: Deepslate Brick or Polished Deepslate for a refined underground look; leave raw stone patches for organic feel
- **Multiple levels**: connect rooms via stairs, ladders, or spiral staircases
- **Stalactites**: hang Pointed Dripstone from ceiling for atmosphere
- **Storage room**: organized by material type with labeled item frames + barrels/chests
- **Secret exits**: pistons activated by a hidden lever that opens a 2-block passage` },

  { tags:['bridge','bridges','spanning','crossing','arch','river'],
    ans:`**Building Bridges:**

**Simple stone bridge:**
- 3–5 blocks wide, cobblestone/stone brick base
- Fence railings on each side
- Add lamp posts every 4–5 blocks (fence post + lantern)

**Arch bridge:**
- Build the arch first using blocks in an arc shape (count blocks: 1 up, 2 up, 3 up, 4 up, 3 up, 2 up, 1 up)
- Road surface level with or just above water
- Stone brick arch, cobblestone road

**Rope/suspension bridge:**
- Oak planks for the walkway
- Fences on the sides
- Hang fence chains from tall wooden/stone pylons on each end — fence going up diagonally to simulate cable sag

**Tips:**
- Vary width (wider in center, narrower at ends) for elegance
- Add supports: pillars down into the water` },

  { tags:['nether base','nether build','nether aesthetic','hell','dark build'],
    ans:`**Nether-Themed Building:**

**Materials**: Blackstone, Polished Blackstone Brick, Nether Brick, Chiseled Polished Blackstone, Soul Sand, Basalt, Crimson/Warped Planks

**Aesthetic tips:**
- **Basalt columns** as natural-looking pillars
- **Lava channels** incorporated into walls/floors (behind glass for safety)
- **Soul fire** (on Soul Sand) for eerie blue flames
- **Chains** hanging from ceilings with Lanterns/Soul Lanterns
- **Nether brick fences** as railing — they connect to the nether aesthetic perfectly
- **Crimson/Warped Stem** wood for contrast — warped is teal, crimson is red
- Blackstone bricks + lava = perfect brutalist nether castle feel
- Add **magma blocks** to floors (deal damage — use for decorative moats around the base)` },

  { tags:['material','palette','color','blocks','what blocks','combination','looks good'],
    ans:`**Good Block Combinations / Palettes:**

**Warm cottage**: Oak Log + Stripped Oak + Oak Planks + Stone Brick + Cobblestone + White Terracotta
**Cold mountain**: Spruce Log + Spruce Planks + Stone + Deepslate + Blue/Cyan Terracotta
**Desert temple**: Sandstone + Smooth Sandstone + Chiseled Sandstone + Terracotta + Orange Concrete
**Modern luxury**: Quartz + Smooth Quartz + White Concrete + Dark Oak + Glass
**Nether fortress**: Nether Brick + Blackstone + Polished Blackstone Brick + Chains
**Underwater**: Prismarine + Dark Prismarine + Prismarine Brick + Sea Lantern + Blue Terracotta
**Fantasy/magic**: Purple Concrete + End Stone Brick + Purpur + Chorus Plant + Amethyst
**Rustic farmhouse**: Stripped Spruce + Spruce Planks + Cobblestone + Red Terracotta + Hay Bale

**General rule**: 1 dominant material (60%), 1 secondary (30%), 1 accent (10%)` },

  { tags:['lighting','light','torches','hidden light','ambiance','glow','dark'],
    ans:`**Creative Lighting in Builds:**

**Hidden sources** (light without visible torches):
- **Glowstone/Shroomlight** under stair blocks or trapdoors (the block lights the area, you don't see it)
- **Sea Lanterns** hidden inside walls behind a 1-block gap
- **Carpet over Glowstone** — light passes through carpet
- **Jack-o-Lanterns** facing away/into walls

**Decorative sources:**
- **Lanterns** hanging from fence/chain — great for medieval
- **Candles** (1–4 per block, can be lit) — subtle ambient glow, great indoors
- **Soul Lanterns** — blue tint, spooky/nether builds
- **Campfires** — warm glow, use as fireplaces or village fire pits
- **Glow Berries** on cave vines — organic cave lighting
- **Amethyst clusters** — not a light source but visually atmospheric

**Avoid**: torches pasted randomly on walls — break immersion` },

  { tags:['tower','towers','lighthouse','obelisk','tall','spire'],
    ans:`**Building Towers:**

**Circular tower** (most impressive):
- Use a circle template (Chunkbase circle generator) for the floor plan
- 7×7 or 9×9 outer diameter is a good size
- Walls 1 block thick, leave space for a spiral staircase inside
- Spiral staircase: stair blocks wrapping clockwise around a 1×1 center pole

**Square tower:**
- 5×5 to 7×7 footprint
- Taper 1 block inward every 8–10 blocks up
- Battlements at the top (alternating full/gap crenellations)
- Conical or pyramid roof on top using stairs

**Lighthouse:**
- Tall narrow cylinder or octagon
- Red + White stripes (alternating terracotta bands)
- Glass observation room near top
- Sea Lantern or Glowstone beacon light at very top
- Fenced walkway around the light room` },

  { tags:['path','road','street','paving','walkway','floor'],
    ans:`**Paths & Roads:**
- **Dirt path** (right-click dirt with shovel) — natural, worn look for villages
- **Gravel** — classic road material, slightly rough
- **Stone slabs** — clean, good for towns (mix cobblestone slab + stone slab for texture)
- **Cobblestone + Mossy Cobblestone** — aged, worn street
- **Brick paths**: Brick blocks for formal gardens/palaces
- **Polished Blackstone** — sleek modern/dark aesthetic

**Making paths interesting:**
- Vary width (wider at intersections)
- Curve gently instead of straight lines
- Add **grass blocks** or **flower patches** between path sections
- Border with **fences**, **flower pots**, or **slabs** as curbs
- Lamp posts every 6–8 blocks (fence post + lantern)` },

  { tags:['window','windows','glass','openings'],
    ans:`**Building Better Windows:**
- **Frame every window** — surround glass with wood, stone, or brick blocks for definition
- **Variety**: small square windows (1×1) for rustic, tall narrow windows for gothic, wide horizontal for modern
- **Trapdoor shutters**: place oak or spruce trapdoors beside windows — open or closed as decoration
- **Arch windows**: build a stone/wood arch above a window using stairs pointing upward
- **Bay windows**: extend the window section 1 block out from the wall with a small angled or flat top
- **Window ledge**: a slab below each window adds depth and realism
- **Iron bars** instead of glass for dungeons, prisons, or rustic looks` },

  { tags:['beginner build','first build','starter','what to build','simple build'],
    ans:`**Good First Builds (by difficulty):**

**Easy:**
- 10×10 starter cottage (oak + cobblestone, gabled roof)
- Underground bunker (Deepslate Brick, 3 connected rooms)
- Small garden/park with custom trees, paths, and benches

**Medium:**
- Multi-room house with basement + upstairs loft
- Small village with 3–4 different house styles
- Barn with actual crop farm attached

**Harder:**
- Castle with outer wall, gatehouse, keep, and courtyard
- Modern glass villa with pool and flat roof
- Treehouse connected by rope bridges

**Build order tip**: Always finish the **exterior** completely before decorating the interior. Shape → materials → roof → windows → doors → interior → landscaping.` },
];

function score(q: string, entry: KB): number {
  let s = 0;
  for (const tag of entry.tags) {
    if (q.includes(tag)) s += tag.split(' ').length * 2;
  }
  return s;
}

function localAnswer(q: string, history: {role:string,content:string}[]): string {
  const lower = q.toLowerCase().replace(/[?!]/g, '').trim();

  // 1. Crafting recipe lookup
  const craftPat = /(?:how (?:do (?:i|you)|to) (?:craft|make|create|build)|(?:craft|make)(?:ing)?(?: a| an| the)?(?:\s+recipe(?:\s+for)?)?|recipe(?:\s+for)?(?: a| an| the)?)\s+(.+)/i;
  const cm = lower.match(craftPat);
  if (cm) {
    const r = lookupRecipe(cm[2].trim());
    if (r) return r;
  }

  // 2. Direct item lookup ("what is a torch" / "iron sword" / "diamond pickaxe recipe")
  const directPat = /^(?:what(?:'s| is)(?: a| an| the)?|how (?:do i get|to get)(?: a| an| the)?|)\s*(.+?)(?:\s+recipe)?$/i;
  const dm = lower.match(directPat);
  if (dm && dm[1].length > 2) {
    const r = lookupRecipe(dm[1].trim());
    if (r) return r;
  }

  // 3. Knowledge base
  const scored = KB.map(e => ({ e, s: score(lower, e) })).filter(x => x.s >= 2).sort((a,b) => b.s - a.s);
  if (scored.length > 0) return scored[0].e.ans;

  // 4. Fallback
  return `I'm not sure about that. Try asking:
- **Crafting** — "how to craft diamond sword"
- **Finding ores** — "where to find diamonds"
- **Mobs** — "how to kill warden"
- **Progression** — "how to get to the nether"
- **Enchanting** — "best enchantments for armor"
- **Commands** — "how to use commands"`;
}

async function sendChat(q: string) {
  if (chatBusy || !q.trim()) return;
  chatBusy = true;
  sendBtn.disabled = true;

  addBubble(q, true);
  const typing = addBubble('…', false);
  typing.classList.add('typing');

  const sess = currentSess();
  sess.history.push({ role: 'user', content: q });
  if (sess.history.length > 20) sess.history.splice(0, sess.history.length - 20);

  await new Promise(r => setTimeout(r, 180));

  const answer = localAnswer(q, sess.history);
  typing.remove();
  sess.history.push({ role: 'assistant', content: answer });
  addBubble(answer, false);

  chatBusy = false;
  sendBtn.disabled = false;
  aiInput.focus();
}

clearBtn.addEventListener('click', () => { currentSess().history = []; renderMessages(); });
sendBtn.addEventListener('click', () => { const q = aiInput.value.trim(); if (q) { aiInput.value = ''; sendChat(q); } });
aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = aiInput.value.trim(); if (q) { aiInput.value = ''; sendChat(q); } } });

renderTabs();
renderMessages();
