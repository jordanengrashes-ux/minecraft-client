const mc      = (window as any).mc;
const overlay = (window as any).overlay;

const PVP_GROUPS = [
  { label: '📦 Required', color: '#d29922', mods: [
    { slug: 'fabric-api',           emoji: '🔧', name: 'Fabric API'          },
  ]},
  { label: '⌨️ HUD & Info', color: '#58a6ff', mods: [
    { slug: 'keystrokes',           emoji: '⌨️', name: 'Keystrokes'           },
    { slug: 'appleskin',            emoji: '🍎', name: 'AppleSkin'            },
    { slug: 'armor-status',         emoji: '🛡️', name: 'Armor Status'         },
    { slug: 'status-effect-bars',   emoji: '🧪', name: 'Status Effect Bars'   },
    { slug: 'coordinates-display',  emoji: '📍', name: 'Coordinates'          },
    { slug: 'xaeros-minimap',       emoji: '🗺️', name: "Xaero's Minimap"     },
    { slug: 'betterf3',             emoji: '📊', name: 'BetterF3'             },
  ]},
  { label: '✨ Visual', color: '#a371f7', mods: [
    { slug: 'custom-crosshair-mod', emoji: '🎯', name: 'Custom Crosshair'    },
    { slug: 'natural-motion-blur',  emoji: '💨', name: 'Motion Blur'          },
    { slug: 'not-enough-animations',emoji: '🏃', name: 'NEA Animations'       },
    { slug: 'damage-tilt',          emoji: '💥', name: 'Damage Tilt'          },
  ]},
  { label: '⚙️ Utility', color: '#3fb950', mods: [
    { slug: 'sprinthop',            emoji: '🏃', name: 'Toggle Sprint'        },
    { slug: 'no-chat-reports',      emoji: '🔇', name: 'No Chat Reports'      },
    { slug: 'item-highlighter',     emoji: '🔆', name: 'Item Highlighter'     },
  ]},
];

async function init() {
  const listEl = document.getElementById('mod-list')!;
  document.getElementById('close-btn')!.addEventListener('click', () => overlay?.close());

  let installed: Record<string, { filename: string; name: string }> = {};
  try { installed = (await overlay?.getMods()) || {}; } catch {}

  for (const group of PVP_GROUPS) {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.style.color = group.color;
    label.textContent = group.label;
    listEl.appendChild(label);

    for (const mod of group.mods) {
      const on  = !!installed[mod.slug];
      const row = document.createElement('div');
      row.className = 'mod-row' + (on ? ' active' : '');
      row.innerHTML = `
        <div class="mod-emoji">${mod.emoji}</div>
        <div class="mod-info">
          <div class="mod-name">${mod.name}</div>
          <div class="mod-sub">${on ? '✓ Installed' : 'Not installed'}</div>
        </div>
        <label class="toggle">
          <input type="checkbox" ${on ? 'checked' : ''}/>
          <span class="toggle-slider"></span>
        </label>`;

      const input   = row.querySelector('input') as HTMLInputElement;
      const subEl   = row.querySelector('.mod-sub') as HTMLElement;

      input.addEventListener('change', async () => {
        input.disabled = true;
        const checked = input.checked;

        if (checked) {
          subEl.textContent = '⏳ Installing…';
          row.className = 'mod-row';
          try {
            const tryVersions = ['1.21.4', '1.21.1', '1.21', '1.20.4'];
            let versions: any[] = [];
            for (const tv of tryVersions) {
              const params = new URLSearchParams({ game_versions: `["${tv}"]`, loaders: '["fabric"]', limit: '5' });
              const data = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(mod.slug)}/version?${params}`).then(r => r.json());
              if (Array.isArray(data) && data.length) { versions = data; break; }
            }
            if (!versions.length) throw new Error('No Fabric build found');
            const file = versions[0].files.find((f: any) => f.primary) ?? versions[0].files[0];
            if (!file) throw new Error('No file found');
            const res = await mc?.installMod({ url: file.url, filename: file.filename });
            if (!res?.ok) throw new Error(res?.error || 'Install failed');
            installed[mod.slug] = { filename: file.filename, name: mod.name };
            await overlay?.saveMods(installed);
            row.className = 'mod-row active';
            subEl.textContent = '✓ Installed';
          } catch (err: any) {
            input.checked = false;
            row.className = 'mod-row error';
            subEl.textContent = '✗ ' + (err.message || 'Failed');
            setTimeout(() => { row.className = 'mod-row'; subEl.textContent = 'Not installed'; }, 3000);
          }
        } else {
          subEl.textContent = 'Removing…';
          const info = installed[mod.slug];
          if (info && mc) await mc.removeMod({ filename: info.filename });
          delete installed[mod.slug];
          await overlay?.saveMods(installed);
          row.className = 'mod-row';
          subEl.textContent = 'Not installed';
        }

        input.disabled = false;
      });

      listEl.appendChild(row);
    }
  }
}

init();
