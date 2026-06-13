// Shared local Minecraft knowledge base — no API key needed

type G = [string,string,string,string,string,string,string,string,string];
const _ = '';

const RECIPES: Record<string, { g: G; note?: string }> = {
  'wooden pickaxe':  { g:['Wood','Wood','Wood',_,'Stick',_,_,'Stick',_] },
  'stone pickaxe':   { g:['Stone','Stone','Stone',_,'Stick',_,_,'Stick',_] },
  'iron pickaxe':    { g:['Iron','Iron','Iron',_,'Stick',_,_,'Stick',_] },
  'golden pickaxe':  { g:['Gold','Gold','Gold',_,'Stick',_,_,'Stick',_] },
  'diamond pickaxe': { g:['Diamond','Diamond','Diamond',_,'Stick',_,_,'Stick',_] },
  'wooden sword':  { g:[_,'Wood',_,_,'Wood',_,_,'Stick',_] },
  'stone sword':   { g:[_,'Stone',_,_,'Stone',_,_,'Stick',_] },
  'iron sword':    { g:[_,'Iron',_,_,'Iron',_,_,'Stick',_] },
  'golden sword':  { g:[_,'Gold',_,_,'Gold',_,_,'Stick',_] },
  'diamond sword': { g:[_,'Diamond',_,_,'Diamond',_,_,'Stick',_] },
  'wooden axe':  { g:['Wood','Wood',_,'Wood','Stick',_,_,'Stick',_] },
  'stone axe':   { g:['Stone','Stone',_,'Stone','Stick',_,_,'Stick',_] },
  'iron axe':    { g:['Iron','Iron',_,'Iron','Stick',_,_,'Stick',_] },
  'golden axe':  { g:['Gold','Gold',_,'Gold','Stick',_,_,'Stick',_] },
  'diamond axe': { g:['Diamond','Diamond',_,'Diamond','Stick',_,_,'Stick',_] },
  'wooden shovel':  { g:[_,'Wood',_,_,'Stick',_,_,'Stick',_] },
  'stone shovel':   { g:[_,'Stone',_,_,'Stick',_,_,'Stick',_] },
  'iron shovel':    { g:[_,'Iron',_,_,'Stick',_,_,'Stick',_] },
  'golden shovel':  { g:[_,'Gold',_,_,'Stick',_,_,'Stick',_] },
  'diamond shovel': { g:[_,'Diamond',_,_,'Stick',_,_,'Stick',_] },
  'wooden hoe':  { g:['Wood','Wood',_,_,'Stick',_,_,'Stick',_] },
  'stone hoe':   { g:['Stone','Stone',_,_,'Stick',_,_,'Stick',_] },
  'iron hoe':    { g:['Iron','Iron',_,_,'Stick',_,_,'Stick',_] },
  'golden hoe':  { g:['Gold','Gold',_,_,'Stick',_,_,'Stick',_] },
  'diamond hoe': { g:['Diamond','Diamond',_,_,'Stick',_,_,'Stick',_] },
  'iron helmet':     { g:['Iron','Iron','Iron','Iron',_,'Iron',_,_,_] },
  'iron chestplate': { g:['Iron',_,'Iron','Iron','Iron','Iron','Iron','Iron','Iron'] },
  'iron leggings':   { g:['Iron','Iron','Iron','Iron',_,'Iron','Iron',_,'Iron'] },
  'iron boots':      { g:[_,_,_,'Iron',_,'Iron','Iron',_,'Iron'] },
  'diamond helmet':     { g:['Dia','Dia','Dia','Dia',_,'Dia',_,_,_] },
  'diamond chestplate': { g:['Dia',_,'Dia','Dia','Dia','Dia','Dia','Dia','Dia'] },
  'diamond leggings':   { g:['Dia','Dia','Dia','Dia',_,'Dia','Dia',_,'Dia'] },
  'diamond boots':      { g:[_,_,_,'Dia',_,'Dia','Dia',_,'Dia'] },
  'golden helmet':     { g:['Gold','Gold','Gold','Gold',_,'Gold',_,_,_] },
  'golden chestplate': { g:['Gold',_,'Gold','Gold','Gold','Gold','Gold','Gold','Gold'] },
  'golden leggings':   { g:['Gold','Gold','Gold','Gold',_,'Gold','Gold',_,'Gold'] },
  'golden boots':      { g:[_,_,_,'Gold',_,'Gold','Gold',_,'Gold'] },
  'leather helmet':     { g:['Leath','Leath','Leath','Leath',_,'Leath',_,_,_] },
  'leather chestplate': { g:['Leath',_,'Leath','Leath','Leath','Leath','Leath','Leath','Leath'] },
  'leather leggings':   { g:['Leath','Leath','Leath','Leath',_,'Leath','Leath',_,'Leath'] },
  'leather boots':      { g:[_,_,_,'Leath',_,'Leath','Leath',_,'Leath'] },
  'crafting table': { g:['Plank','Plank',_,'Plank','Plank',_,_,_,_] },
  'furnace':   { g:['Stone','Stone','Stone','Stone',_,'Stone','Stone','Stone','Stone'] },
  'chest':     { g:['Plank','Plank','Plank','Plank',_,'Plank','Plank','Plank','Plank'] },
  'torch':     { g:[_,'Coal',_,_,'Stick',_,_,_,_], note:'Coal or Charcoal. Makes 4.' },
  'stick':     { g:[_,'Plank',_,_,'Plank',_,_,_,_], note:'Makes 4 sticks.' },
  'ladder':    { g:['Stick',_,'Stick','Stick','Stick','Stick','Stick',_,'Stick'], note:'Makes 3.' },
  'planks':    { g:[_,'Log',_,_,_,_,_,_,_], note:'Any log → 4 planks (shapeless).' },
  'bow':       { g:[_,'Stick','String','Stick',_,'String',_,'Stick','String'] },
  'arrow':     { g:[_,'Flint',_,_,'Stick',_,_,'Feather',_], note:'Makes 4.' },
  'crossbow':  { g:['Stick','Iron','Stick','String','Hook','String',_,'Stick',_], note:'Hook = Tripwire Hook.' },
  'shield':    { g:['Plank','Iron','Plank','Plank','Plank','Plank',_,'Plank',_] },
  'fishing rod':{ g:[_,_,'Stick',_,'Stick','String',_,'String',_] },
  'flint and steel': { g:[_,'Iron',_,_,_,'Flint',_,_,_] },
  'shears':    { g:[_,'Iron',_,'Iron',_,_,_,_,_] },
  'bed':       { g:[_,_,_,'Wool','Wool','Wool','Plank','Plank','Plank'], note:'Any wool color.' },
  'wooden door': { g:['Plank','Plank',_,'Plank','Plank',_,'Plank','Plank',_], note:'Makes 3.' },
  'iron door': { g:['Iron','Iron',_,'Iron','Iron',_,'Iron','Iron',_], note:'Needs button/pressure plate to open.' },
  'redstone torch':      { g:[_,'Dust',_,_,'Stick',_,_,_,_], note:'Dust = Redstone Dust.' },
  'redstone repeater':   { g:[_,_,_,'R.Torch','Dust','R.Torch','Stone','Stone','Stone'] },
  'redstone comparator': { g:[_,_,_,'R.Torch','Quartz','R.Torch','Stone','Stone','Stone'] },
  'lever':     { g:[_,'Stick',_,_,'Cobble',_,_,_,_] },
  'piston':    { g:['Plank','Plank','Plank','Cobble','Iron','Cobble','Cobble','Dust','Cobble'] },
  'sticky piston': { g:[_,'Slime',_,_,'Piston',_,_,_,_] },
  'observer':  { g:['Cobble','Cobble','Cobble','Quartz','Quartz','Cobble','Dust','Dust','Cobble'] },
  'hopper':    { g:['Iron',_,'Iron','Iron','Chest','Iron',_,'Iron',_] },
  'dropper':   { g:['Cobble','Cobble','Cobble','Cobble',_,'Cobble','Cobble','Dust','Cobble'] },
  'dispenser': { g:['Cobble','Cobble','Cobble','Cobble','Bow','Cobble','Cobble','Dust','Cobble'] },
  'tnt':       { g:['Sand','Powder','Sand','Powder','Sand','Powder','Sand','Powder','Sand'], note:'Powder = Gunpowder.' },
  'bucket':    { g:['Iron',_,'Iron',_,'Iron',_,_,_,_] },
  'compass':   { g:[_,'Iron',_,'Iron','Dust','Iron',_,'Iron',_] },
  'clock':     { g:[_,'Gold',_,'Gold','Dust','Gold',_,'Gold',_] },
  'map':       { g:['Paper','Paper','Paper','Paper','Compass','Paper','Paper','Paper','Paper'] },
  'enchanting table': { g:[_,'Book',_,'Diamond','Obsidian','Diamond','Obsidian','Obsidian','Obsidian'] },
  'anvil':     { g:['Iron Blk','Iron Blk','Iron Blk','Iron','Iron','Iron','Iron','Iron','Iron'], note:'Iron Blk = Iron Block (9 iron ingots each).' },
  'grindstone': { g:['Stick','Stone Slab','Stick','Plank',_,'Plank',_,_,_] },
  'ender chest': { g:['Obsidian','Obsidian','Obsidian','Obsidian','Eye','Obsidian','Obsidian','Obsidian','Obsidian'], note:'Eye = Eye of Ender.' },
  'brewing stand': { g:[_,_,_,_,'Blaze Rod',_,'Cobble','Cobble','Cobble'] },
  'cauldron':  { g:['Iron',_,'Iron','Iron',_,'Iron','Iron','Iron','Iron'] },
  'blaze powder': { g:[_,'Blaze Rod',_,_,_,_,_,_,_], note:'Makes 2.' },
  'eye of ender': { g:[_,'E.Pearl',_,_,'B.Powder',_,_,_,_] },
  'book':      { g:[_,'Paper',_,_,'Paper',_,_,'Leather',_] },
  'bookshelf': { g:['Plank','Plank','Plank','Book','Book','Book','Plank','Plank','Plank'] },
  'lectern':   { g:['Plank','Plank','Plank',_,'Bookshelf',_,_,'Plank',_] },
  'beacon':      { g:['Glass','Glass','Glass','Glass','Nether Star','Glass','Obsidian','Obsidian','Obsidian'], note:'Nether Star dropped by the Wither boss.' },
  'elytra':     { g:[_,_,_,_,_,_,_,_,_], note:'Cannot be crafted. Find in End Ship chests inside End Cities.' },
  'trident':    { g:[_,_,_,_,_,_,_,_,_], note:'Cannot be crafted. Dropped by Drowned holding one (~8.5% chance).' },
  'totem of undying': { g:[_,_,_,_,_,_,_,_,_], note:'Cannot be crafted. Dropped by Evokers.' },
  'saddle':     { g:[_,_,_,_,_,_,_,_,_], note:'Cannot be crafted. Find in village/dungeon/nether fortress chests or fishing.' },
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
    const match = Object.keys(RECIPES).find(k => k.includes(key) || key.includes(k));
    if (!match) return null;
    return lookupRecipe(match);
  }
  const name = key.charAt(0).toUpperCase() + key.slice(1);
  if (!r.g.some(c => c.trim())) return r.note ?? `**${name}** cannot be crafted.`;
  return `**${name}**\n${gridText(r.g)}${r.note ? '\n\n' + r.note : ''}`;
}

interface KBEntry { tags: string[]; ans: string; }
const KB: KBEntry[] = [
  { tags:['diamond','find','where','mine','y level','depth','ore'],
    ans:`**Diamonds** spawn Y **-64 to 16**, most at **Y -58**.\n- Strip mine at Y -58 for best results\n- Use **Fortune III** pickaxe: up to 4 diamonds per ore` },
  { tags:['iron','find','where','mine','y level','ore'],
    ans:`**Iron Ore** spawns Y **-64 to 320**. Two peak zones:\n- **Y 15** — underground\n- **Y 232** — mountain biomes` },
  { tags:['gold','find','where','mine','y level','ore'],
    ans:`**Gold Ore** spawns Y **-64 to 32**, peak at **Y -16**.\n- Badlands biome: gold up to Y 256\n- Nether: Nether Gold Ore at any Y level` },
  { tags:['netherite','ancient debris','find','where','mine','y level','upgrade'],
    ans:`**Ancient Debris** — Nether only, **Y 8–22**, peak at **Y 15**.\n- Smelt → Netherite Scrap\n- 4 Scraps + 4 Gold + Smithing Template → Netherite Ingot (at Smithing Table)` },
  { tags:['emerald','find','where','mine','ore'],
    ans:`**Emeralds** only spawn in **mountain biomes**, Y -16 to 320.\n- Best source: trading with Villagers` },
  { tags:['lapis','find','where','mine','y level'],
    ans:`**Lapis Lazuli** spawns Y **-64 to 64**, peak at **Y 0**.\n- Required for enchanting` },
  { tags:['redstone','find','where','mine','y level','ore'],
    ans:`**Redstone** spawns Y **-64 to 16**, peak at **Y -58**.\n- Fortune III gives more dust per ore` },
  { tags:['coal','find','where','mine','ore'],
    ans:`**Coal** spawns Y **0 to 320**, most common around **Y 95**.\n- Charcoal alternative: smelt any log` },
  { tags:['copper','find','where','mine','ore'],
    ans:`**Copper** spawns Y **-16 to 112**, peak at **Y 48**.\n- Most common in Dripstone Cave biomes` },
  { tags:['ender dragon','kill','fight','boss','end','dragon'],
    ans:`**Killing the Ender Dragon:**\n1. Destroy End Crystals on obsidian pillars (bow)\n2. Dragon perches on fountain — sword attack for max damage\n3. Avoid the purple breath\n4. Drops 12,000 XP + opens exit portal` },
  { tags:['wither','summon','kill','fight','boss','nether star'],
    ans:`**Wither Boss:**\nSummon: 4 Soul Sand in T-shape + 3 Wither Skeleton Skulls.\n- Fight underground — ceiling limits movement\n- At 50% HP (blue) — immune to arrows, switch to sword\n- Drops: **Nether Star** → Beacon` },
  { tags:['warden','ancient city','avoid','fight','deep dark','sculk'],
    ans:`**Warden:** 250 HP, Sonic Boom pierces armor — **don't fight it**.\n- Sneak everywhere in the Deep Dark\n- Throw snowballs to distract it\n- Goal: loot Ancient City chests (Swift Sneak books)` },
  { tags:['creeper','explosion','avoid','kill'],
    ans:`**Creeper tips:**\n- 1.5 seconds between hiss and explosion — back away and hit\n- Cats scare creepers\n- Charged creeper = massive explosion + mob head drops` },
  { tags:['enderman','pearl','fight','look','attack'],
    ans:`**Enderman tips:**\n- Don't look at their eyes\n- Pumpkin on head lets you stare safely\n- Stand in water — they teleport away and take damage` },
  { tags:['blaze','blaze rod','nether fortress','fight'],
    ans:`**Blaze tips:**\n- Found in Nether Fortresses\n- Snowballs deal 3 damage each\n- Drops: Blaze Rod — needed for Eyes of Ender and brewing` },
  { tags:['nether','how to get','portal','go to','enter','obsidian','make portal'],
    ans:`**Getting to the Nether:**\n1. Build obsidian frame: 4 wide × 5 tall minimum\n2. Light with Flint and Steel\n- Bring Fire Resistance potions\n- Wear gold armor — Piglins ignore you` },
  { tags:['end','how to get','stronghold','end portal','eye of ender','locate'],
    ans:`**Getting to The End:**\n1. Craft Eyes of Ender (Ender Pearl + Blaze Powder)\n2. Throw them — follow to nearest Stronghold\n3. Fill all 12 End Portal frames with Eyes\n4. Jump in` },
  { tags:['enchanting','how to','bookshelf','bookshelves','setup','levels','xp'],
    ans:`**Enchanting Setup:**\n- Enchanting Table + 15 Bookshelves around it (1-block gap) = max level 30\n- Best enchants:\n  Sword: Sharpness V, Looting III, Mending\n  Pickaxe: Efficiency V, Fortune III, Mending\n  Armor: Protection IV, Feather Falling IV (boots), Mending` },
  { tags:['mending','how to get','treasure','enchantment','repair'],
    ans:`**Mending** is a treasure enchant — can't get from enchanting table.\n- Fishing (most reliable)\n- Librarian Villager — re-roll trades until they sell it\n- Dungeon/bastion chests` },
  { tags:['fortune','silk touch','difference','vs','which','better'],
    ans:`**Fortune III**: More drops per ore block (best for mining)\n**Silk Touch**: Pick up the block itself (move glass, ice, beehives, ores)\nWhich? Fortune for resources. Silk Touch for specific collection.` },
  { tags:['brewing','potion','how to brew','ingredients','effect','recipe'],
    ans:`**Brewing:** Brewing Stand + Blaze Powder fuel + Water Bottle + Nether Wart = Awkward Potion\nThen add:\n- Glistering Melon → Healing\n- Magma Cream → Fire Resistance\n- Sugar → Speed\n- Blaze Powder → Strength\n- Golden Carrot → Night Vision\nRedstone = longer | Glowstone = Level II | Gunpowder = Splash` },
  { tags:['villager','trade','librarian','profession','job','reset','emerald'],
    ans:`**Villager Trading:**\n- Re-roll trades: break and replace job site block (before locking)\n- Librarians sell enchanted books — re-roll for Mending, Silk Touch\n- Cure zombie villagers: Splash Weakness + Golden Apple → permanent discounts` },
  { tags:['xp','experience','farm','level up','grind','fastest'],
    ans:`**Best XP Sources:**\n1. Enderman farm (The End) — fastest\n2. Mob spawner trap\n3. Guardian farm\n4. Auto smelter (bamboo/cactus)\nMending gear auto-repairs from XP while you play.` },
  { tags:['command','cheat','give','gamemode','teleport','tp','time','weather','commands'],
    ans:`**Common Commands:**\n\`/gamemode creative\` | \`/gamemode survival\`\n\`/give @s diamond 64\`\n\`/tp @s 0 64 0\`\n\`/time set day\`\n\`/gamerule keepInventory true\`\n\`/seed\`` },
  { tags:['nether portal','coordinate','ratio','distance','scale','travel'],
    ans:`**Nether Coordinates:** 1 block Nether = 8 blocks Overworld\nOverworld → Nether: divide X and Z by 8\nBuild linked portals for an instant fast-travel highway!` },
  { tags:['shulker box','shulker','how to get','storage','portable'],
    ans:`**Shulker Boxes:** 2 Shulker Shells + Chest\n- Shells drop from Shulkers in End Cities\n- Keep inventory when broken — essential for transport\n- Can be dyed 16 colors` },
  { tags:['voxel client','features','mods','install','modpack','launcher'],
    ans:`**Voxel Client Features:**\n- Mod/Modpack installer (Modrinth)\n- Server hosting from the app\n- Voice chat, cosmetics, skins\n- Friends & chat\n- Bedrock launcher\n- Multi-Java support (8, 17, 21)` },
  { tags:['building','tips','advice','how to build','better','improve','builds'],
    ans:`**Core Building Tips:**\n- Add depth — push blocks in/out by 1 block so walls aren't flat\n- Mix materials for texture\n- Use stairs & slabs for roofing, ledges, furniture\n- Interior matters — use slabs/stairs/trapdoors as furniture\n- Hidden lighting (under slabs) looks better than random torches` },
  { tags:['house','build a house','starter house','basic house','home','cabin'],
    ans:`**Good House Tips:**\nShape: L-shape or split-level beats a plain rectangle\nMaterials (pick 3–4): Oak + Cobblestone + Stone Brick for cottage; Stone Brick + Deepslate for keep\nRoof: gabled (stairs stepping up), add overhangs (extend 1 block past wall)\nInside: loft above storage, separate crafting from bedroom` },
  { tags:['roof','roofing','how to build roof','gable','pyramid','mansard'],
    ans:`**Roof Types:**\nGabled: rows of stairs stepping up to a ridge, overhang 1 block past wall\nPyramid: each layer steps in 1 block on all 4 sides\nMansard: upside-down stairs on first layer, flat top\nTip: mix stair types for color variation` },
  { tags:['medieval','castle','knight','stone','fortress','tower','keep'],
    ans:`**Medieval / Castle:**\nMaterials: Stone Brick, Cobblestone, Mossy Stone Brick, Deepslate Brick, Dark Oak\nWalls: 5–8 blocks tall, 2 thick, crenellations at top\nTowers: taper as they go up, conical roof\nCourty: cobblestone path, well, stables with hay bales` },
  { tags:['modern','house','contemporary','minimalist','sleek'],
    ans:`**Modern Building:**\nMaterials: Smooth Stone, White Concrete, Glass, Quartz, Dark Oak\nFlat/low-slope roofs, large window walls\nCantilevers (upper floor extends past lower), balconies\nKeep to 2–3 neutral colors + 1 accent` },
  { tags:['interior','inside','furniture','decoration','decorate','room'],
    ans:`**Interior Decoration:**\nSofa: stairs + signs as armrests\nTable: fence post + pressure plate\nKitchen: trapdoor cabinet, barrel pantry, cauldron sink\nFireplace: netherrack in stone surround\nLighting: Glowstone under slabs, lanterns on fence chains, candles` },
  { tags:['material','palette','color','blocks','combination','looks good'],
    ans:`**Block Palettes:**\nCottage: Oak Log + Cobblestone + Stone Brick + White Terracotta\nModern: Quartz + White Concrete + Dark Oak + Glass\nNether: Blackstone + Nether Brick + Chains\nRule: 60% dominant + 30% secondary + 10% accent` },
  { tags:['lighting','light','torches','hidden light','ambiance'],
    ans:`**Creative Lighting:**\nHidden: Glowstone/Shroomlight under stairs or trapdoors\nDecorative: Lanterns on fence chains (medieval), Candles (indoor), Soul Lanterns (spooky), Campfires\nAvoid: random torches pasted on walls — break immersion` },
  { tags:['tower','towers','lighthouse','obelisk','tall','spire'],
    ans:`**Building Towers:**\nCircular: use circle template (Chunkbase), 7×7 outer, spiral staircase inside\nSquare: 5×5–7×7, taper 1 block every 8–10 levels, battlements at top\nLighthouse: red/white terracotta stripes, glass observation room, Sea Lantern beacon` },
];

function kbScore(q: string, entry: KBEntry): number {
  let s = 0;
  for (const tag of entry.tags) {
    if (q.includes(tag)) s += tag.split(' ').length * 2;
  }
  return s;
}

export function localAnswer(q: string, _history: {role:string,content:string}[]): string {
  const lower = q.toLowerCase().replace(/[?!]/g, '').trim();

  const craftPat = /(?:how (?:do (?:i|you)|to) (?:craft|make|create|build)|(?:craft|make)(?:ing)?(?: a| an| the)?(?:\s+recipe(?:\s+for)?)?|recipe(?:\s+for)?(?: a| an| the)?)\s+(.+)/i;
  const cm = lower.match(craftPat);
  if (cm) {
    const r = lookupRecipe(cm[2].trim());
    if (r) return r;
  }

  const directPat = /^(?:what(?:'s| is)(?: a| an| the)?|how (?:do i get|to get)(?: a| an| the)?|)\s*(.+?)(?:\s+recipe)?$/i;
  const dm = lower.match(directPat);
  if (dm && dm[1].length > 2) {
    const r = lookupRecipe(dm[1].trim());
    if (r) return r;
  }

  const scored = KB.map(e => ({ e, s: kbScore(lower, e) })).filter(x => x.s >= 2).sort((a,b) => b.s - a.s);
  if (scored.length > 0) return scored[0].e.ans;

  return `I'm not sure about that. Try asking:\n- **Crafting** — "how to craft diamond sword"\n- **Finding ores** — "where to find diamonds"\n- **Mobs** — "how to kill warden"\n- **Progression** — "how to get to the nether"\n- **Enchanting** — "best enchantments for armor"\n- **Building** — "how to build a roof"`;
}
