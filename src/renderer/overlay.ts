const mc      = (window as any).mc;
const overlay = (window as any).overlay;

// Group headings and rows are plain text: status icons come from the row's
// class (active / busy / error) in overlay.html, not from emoji.
const PVP_GROUPS = [
  { label: 'Required', mods: [
    { slug: 'fabric-api',            name: 'Fabric API'           },
  ]},
  { label: 'HUD & info', mods: [
    { slug: 'keystrokes',            name: 'Keystrokes'            },
    { slug: 'appleskin',             name: 'AppleSkin'             },
    { slug: 'armor-status',          name: 'Armor Status'          },
    { slug: 'status-effect-bars',    name: 'Status Effect Bars'    },
    { slug: 'coordinates-display',   name: 'Coordinates'           },
    { slug: 'xaeros-minimap',        name: "Xaero's Minimap"       },
    { slug: 'betterf3',              name: 'BetterF3'              },
    { slug: 'zoomify',               name: 'Zoomify'               },
  ]},
  { label: 'Visual', mods: [
    { slug: 'custom-crosshair-mod',  name: 'Custom Crosshair'      },
    { slug: 'natural-motion-blur',   name: 'Motion Blur'           },
    { slug: 'not-enough-animations', name: 'NEA Animations'        },
    { slug: 'damage-tilt',           name: 'Damage Tilt'           },
    { slug: '3dskinlayers',          name: '3D Skin Layers'        },
    { slug: 'blur-plus',             name: 'Blur+'                 },
  ]},
  { label: 'Utility', mods: [
    { slug: 'toggle-sprint',           name: 'Toggle Sprint'         },
    { slug: 'no-chat-reports',       name: 'No Chat Reports'       },
    { slug: 'item-highlighter',      name: 'Item Highlighter'      },
    { slug: 'shulkerboxtooltip',     name: 'Shulker Tooltips'      },
    { slug: 'perspectivemod',        name: 'Perspective Mod'       },
  ]},
  { label: 'Performance', mods: [
    { slug: 'sodium',                name: 'Sodium'                },
    { slug: 'lithium',               name: 'Lithium'               },
    { slug: 'iris',                  name: 'Iris Shaders'          },
    { slug: 'entityculling',         name: 'Entity Culling'        },
    { slug: 'memoryleakfix',         name: 'Memory Leak Fix'       },
    { slug: 'ferrite-core',          name: 'Ferrite Core'          },
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
    label.textContent = group.label;
    listEl.appendChild(label);

    for (const mod of group.mods) {
      const on  = !!installed[mod.slug];
      const row = document.createElement('div');
      row.className = 'mod-row' + (on ? ' active' : '');
      row.innerHTML = `
        <div class="mod-info">
          <div class="mod-name">${mod.name}</div>
          <div class="mod-status">
            <svg class="icon st-ok" aria-hidden="true"><use href="#i-check"/></svg>
            <svg class="icon st-err" aria-hidden="true"><use href="#i-alert"/></svg>
            <span class="spinner" aria-hidden="true"></span>
            <span class="mod-sub">${on ? 'Installed' : 'Not installed'}</span>
          </div>
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
          subEl.textContent = 'Installing…';
          row.className = 'mod-row busy';
          try {
            const tryVersions = ['1.21.4', '1.21.1', '1.21', '1.20.4'];
            let versions: any[] = [];
            for (const tv of tryVersions) {
              const params = new URLSearchParams({ game_versions: `["${tv}"]`, loaders: '["fabric"]', limit: '5' });
              const data = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(mod.slug)}/version?${params}`).then(r => r.json());
              if (Array.isArray(data) && data.length) { versions = data; break; }
            }
            if (!versions.length) throw new Error('No Fabric build for 1.20.4 to 1.21.4 yet.');
            const file = versions[0].files.find((f: any) => f.primary) ?? versions[0].files[0];
            if (!file) throw new Error('Modrinth has no file to download for this mod.');
            const res = await mc?.installMod({ url: file.url, filename: file.filename });
            if (!res?.ok) throw new Error(res?.error || "Couldn't save the mod. Try again.");
            installed[mod.slug] = { filename: file.filename, name: mod.name };
            await overlay?.saveMods(installed);
            row.className = 'mod-row active';
            subEl.textContent = 'Installed';
          } catch (err: any) {
            input.checked = false;
            row.className = 'mod-row error';
            // fetch() network failures and non-JSON replies surface as TypeError / SyntaxError
            subEl.textContent = (err instanceof TypeError || err instanceof SyntaxError)
              ? "Couldn't reach Modrinth. Check your connection and try again."
              : (err?.message || "Couldn't install. Try again.");
            setTimeout(() => { row.className = 'mod-row'; subEl.textContent = 'Not installed'; }, 3000);
          }
        } else {
          subEl.textContent = 'Removing…';
          row.className = 'mod-row busy';
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
