import * as THREE from 'three';
import { rtdb } from './firebase';
import { ref, set, onValue, onDisconnect } from 'firebase/database';

// ── Block types ────────────────────────────────────────────────────────────────
const BLOCKS = {
  0: null,
  1: { name:'Stone',     color:0x888888 },
  2: { name:'Dirt',      color:0x8B5E3C },
  3: { name:'Grass',     color:0x4CAF50 },
  4: { name:'Wood',      color:0x8B6914 },
  5: { name:'Sand',      color:0xE8D5A3 },
  6: { name:'Glass',     color:0xaaddff },
  7: { name:'Glowstone', color:0xffee88 },
  8: { name:'Lava',      color:0xff4400 },
  9: { name:'Leaves',    color:0x2d7a2d },
} as Record<number, {name:string;color:number}|null>;

const HOTBAR = [1,2,3,4,5,6,7,8,9];
const CHUNK  = 16;
const WORLD_HEIGHT = 64;
const RENDER_DIST  = 4;

// ── Noise ──────────────────────────────────────────────────────────────────────
function noise2d(x:number,z:number):number{
  const X=Math.floor(x)&255,Z=Math.floor(z)&255;
  const xf=x-Math.floor(x),zf=z-Math.floor(z);
  const u=fade(xf),v=fade(zf);
  const a=hash(X,Z),b=hash(X+1,Z),c=hash(X,Z+1),d=hash(X+1,Z+1);
  return lerp(v,lerp(u,grad(a,xf,zf),grad(b,xf-1,zf)),lerp(u,grad(c,xf,zf-1),grad(d,xf-1,zf-1)));
}
function fade(t:number){return t*t*t*(t*(t*6-15)+10);}
function lerp(t:number,a:number,b:number){return a+t*(b-a);}
function grad(h:number,x:number,z:number){const v=h&3;return((v&1)?-x:x)+((v&2)?-z:z);}
function hash(x:number,z:number){let n=(x*73856093)^(z*19349663);n=((n>>16)^n)*0x45d9f3b;n=((n>>16)^n)*0x45d9f3b;return((n>>16)^n)&255;}
function getHeight(wx:number,wz:number):number{
  const s=0.015;
  const h=(noise2d(wx*s,wz*s)*0.5+noise2d(wx*s*2.1,wz*s*2.1)*0.25+noise2d(wx*s*4.3,wz*s*4.3)*0.125);
  return Math.floor(32+h*28);
}

// ── World storage ──────────────────────────────────────────────────────────────
const worldData=new Map<string,number>();
const chunkMeshes=new Map<string,any>();
function bkey(x:number,y:number,z:number){return`${x},${y},${z}`;}
function ckey(cx:number,cz:number){return`${cx},${cz}`;}

function getBlock(x:number,y:number,z:number):number{
  const k=bkey(x,y,z);
  if(worldData.has(k))return worldData.get(k)!;
  if(y<0||y>=WORLD_HEIGHT)return y<0?1:0;
  const h=getHeight(x,z);
  if(y>h)return 0;
  if(y===h)return 3;
  if(y>=h-3)return 2;
  return 1;
}
function setBlock(x:number,y:number,z:number,id:number){
  worldData.set(bkey(x,y,z),id);
  rebuildChunk(Math.floor(x/CHUNK),Math.floor(z/CHUNK));
}

// ── Chunk mesh builder ─────────────────────────────────────────────────────────
const matCache=new Map<number,THREE.MeshLambertMaterial>();
function getMat(color:number,transparent=false):THREE.MeshLambertMaterial{
  if(!matCache.has(color))matCache.set(color,new THREE.MeshLambertMaterial({color,transparent,opacity:transparent?0.55:1}));
  return matCache.get(color)!;
}

function rebuildChunk(cx:number,cz:number){
  const key=ckey(cx,cz);
  const old=chunkMeshes.get(key);
  if(old){scene.remove(old);chunkMeshes.delete(key);}

  const group=new THREE.Group();
  const groups=new Map<number,number[]>();

  for(let lx=0;lx<CHUNK;lx++)for(let lz=0;lz<CHUNK;lz++)for(let y=0;y<WORLD_HEIGHT;y++){
    const wx=cx*CHUNK+lx,wz=cz*CHUNK+lz;
    const id=getBlock(wx,y,wz);
    if(!id)continue;
    const def=BLOCKS[id];if(!def)continue;
    for(const [dx,dy,dz] of [[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]] as [number,number,number][]){
      if(getBlock(wx+dx,y+dy,wz+dz)!==0)continue;
      if(!groups.has(id))groups.set(id,[]);
      pushFace(groups.get(id)!,wx,y,wz,dx,dy,dz);
    }
  }

  for(const [id,verts] of groups){
    const def=BLOCKS[id]!;
    const geo=new THREE.BufferGeometry();
    const pos2:number[]=[],nrm:number[]=[],idx:number[]=[];
    let vb=0;
    for(let i=0;i<verts.length;i+=24){
      pos2.push(...verts.slice(i,i+12));
      nrm.push(...verts.slice(i+12,i+24));
      idx.push(vb,vb+1,vb+2,vb,vb+2,vb+3);vb+=4;
    }
    geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(pos2),3));
    geo.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(nrm),3));
    geo.setIndex(idx);
    group.add(new THREE.Mesh(geo,getMat(def.color,id===6)));
  }
  if(group.children.length){scene.add(group);chunkMeshes.set(key,group);}
}

function pushFace(out:number[],x:number,y:number,z:number,nx:number,ny:number,nz:number){
  const hx=0.5,hy=0.5,hz=0.5;
  let verts:number[][]=[];
  if(ny===1)  verts=[[x-hx,y+hy,z-hz],[x+hx,y+hy,z-hz],[x+hx,y+hy,z+hz],[x-hx,y+hy,z+hz]];
  else if(ny===-1)verts=[[x-hx,y-hy,z+hz],[x+hx,y-hy,z+hz],[x+hx,y-hy,z-hz],[x-hx,y-hy,z-hz]];
  else if(nx===1) verts=[[x+hx,y-hy,z+hz],[x+hx,y+hy,z+hz],[x+hx,y+hy,z-hz],[x+hx,y-hy,z-hz]];
  else if(nx===-1)verts=[[x-hx,y-hy,z-hz],[x-hx,y+hy,z-hz],[x-hx,y+hy,z+hz],[x-hx,y-hy,z+hz]];
  else if(nz===1) verts=[[x-hx,y-hy,z+hz],[x+hx,y-hy,z+hz],[x+hx,y+hy,z+hz],[x-hx,y+hy,z+hz]];
  else            verts=[[x+hx,y-hy,z-hz],[x-hx,y-hy,z-hz],[x-hx,y+hy,z-hz],[x+hx,y+hy,z-hz]];
  for(const v of verts){out.push(...v);out.push(nx,ny,nz);}
}

// ── Scene setup ────────────────────────────────────────────────────────────────
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;
document.body.appendChild(renderer.domElement);

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x87ceeb);
scene.fog=new THREE.FogExp2(0x87ceeb,0.018);

const camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,0.1,400);
scene.add(new THREE.AmbientLight(0xffffff,0.6));
const sun=new THREE.DirectionalLight(0xfffbe0,1.2);
sun.position.set(50,120,30);sun.castShadow=true;scene.add(sun);

window.addEventListener('resize',()=>{
  renderer.setSize(innerWidth,innerHeight);
  camera.aspect=innerWidth/innerHeight;
  camera.updateProjectionMatrix();
});

// ── Game state ─────────────────────────────────────────────────────────────────
const pos=new THREE.Vector3(0,70,0);
const vel=new THREE.Vector3();
const SPEED=5,JUMP=9,GRAV=22;
let yaw=0,pitch=0,onGround=false,flying=false;
let hotbarSlot=0;
const keys:Record<string,boolean>={};
let locked=false,chatOpen=false;
let playerName='Player';
let mode:'menu'|'local'|'mc'='menu'; // current game mode
let mcConnected=false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const mainMenu   =document.getElementById('main-menu')!;
const serverBrowser=document.getElementById('server-browser')!;
const disconnectedEl=document.getElementById('disconnected')!;
const crosshair  =document.getElementById('crosshair')!;
const hudEl      =document.getElementById('hud')!;
const infoEl     =document.getElementById('info')!;
const chatBox    =document.getElementById('chat-box')!;
const chatLog    =document.getElementById('chat-log')!;
const chatInput  =document.getElementById('chat-input') as HTMLInputElement;
const serverBar  =document.getElementById('server-bar')!;
const clickToPlay=document.getElementById('click-to-play')!;

// ── Menu wiring ───────────────────────────────────────────────────────────────
document.getElementById('btn-local')!.addEventListener('click',()=>startLocalMode());
document.getElementById('btn-multiplayer')!.addEventListener('click',()=>{
  mainMenu.style.display='none';
  serverBrowser.style.display='flex';
});
document.getElementById('sb-back')!.addEventListener('click',()=>{
  serverBrowser.style.display='none';
  mainMenu.style.display='flex';
});
document.getElementById('btn-reconnect')!.addEventListener('click',()=>{
  disconnectedEl.style.display='none';
  mainMenu.style.display='flex';
  if(mcConnected){(window as any).mc?.disconnect();mcConnected=false;}
});

// ── Server browser connect ─────────────────────────────────────────────────────
const sbStatus     =document.getElementById('sb-status')!;
const deviceCodeBox=document.getElementById('device-code-box')!;
const deviceCodeUrl=document.getElementById('device-code-url')!;
const deviceCodeVal=document.getElementById('device-code-val')!;

document.getElementById('sb-connect')!.addEventListener('click',async()=>{
  const rawHost=(document.getElementById('sb-host') as HTMLInputElement).value.trim();
  const portRaw=(document.getElementById('sb-port') as HTMLInputElement).value.trim();
  const username=(document.getElementById('sb-user') as HTMLInputElement).value.trim();
  if(!rawHost){setStatus('Enter a server address','error');return;}
  if(!username){setStatus('Enter your Microsoft account email','error');return;}

  const [host,hostPort]=rawHost.includes(':') ? rawHost.split(':') : [rawHost,portRaw||'25565'];
  const port=parseInt(hostPort||portRaw||'25565',10)||25565;

  setStatus(`Connecting to ${host}:${port}…`,'warn');
  deviceCodeBox.style.display='none';

  const mcAPI=(window as any).mc;
  if(!mcAPI){setStatus('MC bridge not available (run as Electron app)','error');return;}

  const res=await mcAPI.connect(host,port,username);
  if(res && !res.ok){
    setStatus(res.error||'Connection failed','error');
  }
  // status updated by events below
});

function setStatus(msg:string,cls?:'error'|'ok'|'warn'){
  sbStatus.textContent=msg;
  sbStatus.className=cls||'';
}

// ── MC event listeners ────────────────────────────────────────────────────────
const mcAPI=(window as any).mc;
if(mcAPI){
  mcAPI.onDeviceCode((data:{userCode:string;verificationUri:string})=>{
    deviceCodeBox.style.display='block';
    deviceCodeUrl.textContent=data.verificationUri;
    deviceCodeVal.textContent=data.userCode;
    setStatus('Waiting for Microsoft sign-in…','warn');
  });

  mcAPI.onLogin((data:{username:string})=>{
    mcConnected=true;
    serverBrowser.style.display='none';
    startMCMode(data.username);
  });

  mcAPI.onChat((msg:string)=>{
    addChat(msg,true);
  });

  mcAPI.onKicked((reason:string)=>{
    showDisconnect(`Kicked: ${reason}`);
  });

  mcAPI.onError((err:string)=>{
    if(serverBrowser.style.display==='flex'){
      setStatus(`Error: ${err}`,'error');
    } else {
      showDisconnect(`Error: ${err}`);
    }
  });

  mcAPI.onEnd((reason:string)=>{
    if(mcConnected) showDisconnect(reason||'Connection closed');
  });
}

function showDisconnect(reason:string){
  mcConnected=false;
  document.getElementById('disconnect-reason')!.textContent=reason;
  disconnectedEl.style.display='flex';
  serverBar.style.display='none';
  crosshair.style.display='none';
  chatBox.style.display='none';
}

// ── Start local world mode ────────────────────────────────────────────────────
const loadedChunks=new Set<string>();
let localStarted=false;

function startLocalMode(){
  mode='local';
  mainMenu.style.display='none';
  clickToPlay.style.display='flex';
  crosshair.style.display='block';
  hudEl.style.display='flex';
  infoEl.style.display='block';
  chatBox.style.display='block';
  if(localStarted)return;
  localStarted=true;
  const spawnH=getHeight(0,0);
  pos.set(0,spawnH+3,0);
  updateChunks();
  initLocalMultiplayer();
  loop();
}

// ── Start MC connected mode ────────────────────────────────────────────────────
function startMCMode(username:string){
  mode='mc';
  crosshair.style.display='none';
  hudEl.style.display='none';
  infoEl.style.display='none';
  chatBox.style.display='block';
  serverBar.style.display='flex';
  (document.getElementById('server-bar-host')as HTMLElement).textContent=
    (document.getElementById('sb-host') as HTMLInputElement).value.trim();
  (document.getElementById('server-bar-user')as HTMLElement).textContent=username;
  addChat(`✅ Connected as ${username}. Press T to chat, Escape to disconnect.`,false);
}

// ── Chat helpers ───────────────────────────────────────────────────────────────
function addChat(text:string,isMC:boolean){
  const d=document.createElement('div');
  d.className='chat-msg'+(isMC?' mc':'');
  d.textContent=text;
  chatLog.appendChild(d);
  chatLog.scrollTop=chatLog.scrollHeight;
  // keep last 50 messages
  while(chatLog.children.length>50)chatLog.removeChild(chatLog.firstChild!);
}

// ── Pointer lock (local mode only) ────────────────────────────────────────────
clickToPlay.addEventListener('click',()=>{renderer.domElement.requestPointerLock();});
document.addEventListener('pointerlockchange',()=>{
  locked=document.pointerLockElement===renderer.domElement;
  if(mode==='local')clickToPlay.style.display=locked?'none':'flex';
});
document.addEventListener('mousemove',e=>{
  if(!locked||chatOpen||mode!=='local')return;
  yaw-=e.movementX*0.002;
  pitch=Math.max(-Math.PI/2+0.01,Math.min(Math.PI/2-0.01,pitch-e.movementY*0.002));
});

// ── Input ──────────────────────────────────────────────────────────────────────
window.addEventListener('keydown',e=>{
  if(chatOpen){
    if(e.key==='Escape')closeChatInput();
    if(e.key==='Enter')sendChat();
    return;
  }
  keys[e.code]=true;
  if(mode==='local'){
    if(e.code==='Space'&&onGround){vel.y=JUMP;onGround=false;}
    if(e.code==='KeyF')flying=!flying;
    if(e.code==='Escape')document.exitPointerLock();
  }
  if(e.code==='KeyT'&&(mode==='local'||mode==='mc')){e.preventDefault();openChatInput();}
  if(mode==='mc'&&e.code==='Escape'){
    (window as any).mc?.disconnect();
    showDisconnect('You left the server.');
  }
  for(let i=0;i<9;i++)if(e.code===`Digit${i+1}`)setHotbar(i);
});
window.addEventListener('keyup',e=>{keys[e.code]=false;});

function openChatInput(){chatOpen=true;chatInput.style.display='block';chatInput.focus();if(mode==='local')document.exitPointerLock();}
function closeChatInput(){chatOpen=false;chatInput.style.display='none';chatInput.value='';}
function sendChat(){
  const msg=chatInput.value.trim();
  if(msg){
    if(mode==='mc'&&mcConnected){
      (window as any).mc?.chat(msg);
      addChat(`<${playerName}> ${msg}`,false);
    } else if(mode==='local'){
      set(ref(rtdb,`voxel/chat/${Date.now()}`),{name:playerName,msg,ts:Date.now()});
    }
  }
  closeChatInput();
}

function setHotbar(i:number){
  document.getElementById(`slot-${hotbarSlot}`)?.classList.remove('active');
  hotbarSlot=i;
  document.getElementById(`slot-${hotbarSlot}`)?.classList.add('active');
}
window.addEventListener('wheel',e=>{setHotbar((hotbarSlot+(e.deltaY>0?1:-1)+9)%9);});

// ── Block interaction ──────────────────────────────────────────────────────────
const raycaster=new THREE.Raycaster();
window.addEventListener('mousedown',e=>{
  if(!locked||mode!=='local')return;
  raycaster.setFromCamera(new THREE.Vector2(0,0),camera);
  const hit=raycastBlock(raycaster.ray.origin,raycaster.ray.direction,6);
  if(!hit)return;
  if(e.button===0){setBlock(hit.x,hit.y,hit.z,0);publishBlockChange(hit.x,hit.y,hit.z,0);}
  else if(e.button===2){
    const nx=hit.x+hit.nx,ny=hit.y+hit.ny,nz=hit.z+hit.nz;
    const id=HOTBAR[hotbarSlot];setBlock(nx,ny,nz,id);publishBlockChange(nx,ny,nz,id);
  }
});
window.addEventListener('contextmenu',e=>e.preventDefault());

function raycastBlock(origin:THREE.Vector3,dir:THREE.Vector3,maxDist:number){
  const step=0.05;let px=origin.x,py=origin.y,pz=origin.z,lastX=0,lastY=0,lastZ=0;
  for(let d=0;d<maxDist;d+=step){
    const bx=Math.floor(px),by=Math.floor(py),bz=Math.floor(pz);
    if(getBlock(bx,by,bz)!==0)return{x:bx,y:by,z:bz,nx:bx-lastX,ny:by-lastY,nz:bz-lastZ};
    lastX=bx;lastY=by;lastZ=bz;px+=dir.x*step;py+=dir.y*step;pz+=dir.z*step;
  }
  return null;
}

// ── Physics ────────────────────────────────────────────────────────────────────
function updatePhysics(dt:number){
  if(mode!=='local')return;
  if(flying){
    const spd=keys['ShiftLeft']?SPEED*3:SPEED*1.5;
    const fwd=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
    const right=new THREE.Vector3(-Math.sin(yaw-Math.PI/2),0,-Math.cos(yaw-Math.PI/2));
    if(keys['KeyW'])pos.addScaledVector(fwd,spd*dt);
    if(keys['KeyS'])pos.addScaledVector(fwd,-spd*dt);
    if(keys['KeyA'])pos.addScaledVector(right,-spd*dt);
    if(keys['KeyD'])pos.addScaledVector(right,spd*dt);
    if(keys['Space'])pos.y+=spd*dt;
    if(keys['ShiftLeft'])pos.y-=spd*dt;
    vel.set(0,0,0);return;
  }
  vel.y-=GRAV*dt;
  const spd=keys['ShiftLeft']?SPEED*1.6:SPEED;
  const fwd=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw));
  const right=new THREE.Vector3(-Math.sin(yaw-Math.PI/2),0,-Math.cos(yaw-Math.PI/2));
  const move=new THREE.Vector3();
  if(keys['KeyW'])move.addScaledVector(fwd,1);
  if(keys['KeyS'])move.addScaledVector(fwd,-1);
  if(keys['KeyA'])move.addScaledVector(right,-1);
  if(keys['KeyD'])move.addScaledVector(right,1);
  if(move.lengthSq()>0)move.normalize().multiplyScalar(spd);
  vel.x=move.x;vel.z=move.z;
  pos.y+=vel.y*dt;
  const foot=Math.floor(pos.y-1.8),head=Math.floor(pos.y+0.1);
  const bx=Math.floor(pos.x),bz=Math.floor(pos.z);
  if(vel.y<0&&getBlock(bx,foot,bz)!==0){pos.y=foot+1+1.8;vel.y=0;onGround=true;}
  else if(vel.y>0&&getBlock(bx,head,bz)!==0){pos.y=head-0.1;vel.y=0;}
  else onGround=false;
  pos.x+=vel.x*dt;
  if(getBlock(Math.floor(pos.x),Math.floor(pos.y-0.9),bz)!==0||getBlock(Math.floor(pos.x),Math.floor(pos.y-1.7),bz)!==0)pos.x-=vel.x*dt;
  pos.z+=vel.z*dt;
  if(getBlock(bx,Math.floor(pos.y-0.9),Math.floor(pos.z))!==0||getBlock(bx,Math.floor(pos.y-1.7),Math.floor(pos.z))!==0)pos.z-=vel.z*dt;
}

// ── Chunk loading ──────────────────────────────────────────────────────────────
function updateChunks(){
  if(mode!=='local')return;
  const cx=Math.floor(pos.x/CHUNK),cz=Math.floor(pos.z/CHUNK);
  for(let dx=-RENDER_DIST;dx<=RENDER_DIST;dx++)for(let dz=-RENDER_DIST;dz<=RENDER_DIST;dz++){
    const k=ckey(cx+dx,cz+dz);
    if(!loadedChunks.has(k)){loadedChunks.add(k);rebuildChunk(cx+dx,cz+dz);}
  }
  for(const k of [...loadedChunks]){
    const [kcx,kcz]=k.split(',').map(Number);
    if(Math.abs(kcx-cx)>RENDER_DIST+1||Math.abs(kcz-cz)>RENDER_DIST+1){
      const m=chunkMeshes.get(k);if(m)scene.remove(m);chunkMeshes.delete(k);loadedChunks.delete(k);
    }
  }
}

// ── Local multiplayer (Firebase) ───────────────────────────────────────────────
const sessionId=Math.random().toString(36).slice(2,12);
const remotePlayers=new Map<string,{mesh:THREE.Mesh,label:HTMLDivElement}>();
let publishTimer=0;

function publishPlayer(){
  set(ref(rtdb,`voxel/players/${sessionId}`),{
    x:Math.round(pos.x*10)/10,y:Math.round(pos.y*10)/10,z:Math.round(pos.z*10)/10,
    yaw:Math.round(yaw*100)/100,name:playerName,ts:Date.now(),
  }).catch(()=>{});
}

function initLocalMultiplayer(){
  try{onDisconnect(ref(rtdb,`voxel/players/${sessionId}`)).remove();}catch{}
  onValue(ref(rtdb,'voxel/players'),snap=>{
    const data=snap.val() as Record<string,any>|null;
    const seen=new Set<string>();
    if(data)for(const [id,s] of Object.entries(data)){
      if(id===sessionId)continue;seen.add(id);
      if(!remotePlayers.has(id))addRemotePlayer(id,s);else updateRemotePlayer(id,s);
    }
    for(const [id] of remotePlayers)if(!seen.has(id))removeRemotePlayer(id);
  });
  onValue(ref(rtdb,'voxel/blocks'),snap=>{
    const data=snap.val() as Record<string,any>|null;
    if(!data)return;
    for(const [k,v] of Object.entries(data)){
      const [x,,z]=k.split(',').map(Number);
      worldData.set(k,v as number);rebuildChunk(Math.floor(x/CHUNK),Math.floor(z/CHUNK));
    }
  });
  onValue(ref(rtdb,'voxel/chat'),snap=>{
    const data=snap.val() as Record<string,any>|null;
    if(!data)return;
    chatLog.innerHTML='';
    const msgs=Object.values(data).sort((a:any,b:any)=>a.ts-b.ts).slice(-20);
    for(const m of msgs as any[]){addChat(`<${m.name}> ${m.msg}`,false);}
  });
}

function publishBlockChange(x:number,y:number,z:number,id:number){
  set(ref(rtdb,`voxel/blocks/${x},${y},${z}`),id).catch(()=>{});
}

function addRemotePlayer(id:string,s:any){
  const mesh=new THREE.Mesh(new THREE.CapsuleGeometry(0.3,1.2,4,8),new THREE.MeshLambertMaterial({color:0x4488ff}));
  scene.add(mesh);
  const label=document.createElement('div');
  label.style.cssText='position:fixed;transform:translate(-50%,-100%);background:rgba(0,0,0,0.6);color:#fff;font-family:monospace;font-size:11px;padding:2px 7px;border-radius:5px;pointer-events:none;z-index:20';
  label.textContent=s.name||'Player';document.body.appendChild(label);
  mesh.position.set(s.x||0,s.y||0,s.z||0);
  remotePlayers.set(id,{mesh,label});
}
function updateRemotePlayer(id:string,s:any){const rp=remotePlayers.get(id)!;rp.mesh.position.set(s.x||0,s.y||0,s.z||0);rp.label.textContent=s.name||'Player';}
function removeRemotePlayer(id:string){const rp=remotePlayers.get(id);if(!rp)return;scene.remove(rp.mesh);rp.label.remove();remotePlayers.delete(id);}
function updateRemoteLabels(){
  for(const{mesh,label}of remotePlayers.values()){
    const v=mesh.position.clone().project(camera);
    if(v.z>1){label.style.display='none';continue;}
    label.style.display='';
    label.style.left=`${(v.x*0.5+0.5)*innerWidth}px`;
    label.style.top=`${(-v.y*0.5+0.5)*innerHeight}px`;
  }
}

// ── HUD ────────────────────────────────────────────────────────────────────────
let fps=0,fpsTimer=0,fpsCount=0;
function updateHUD(dt:number){
  fpsCount++;fpsTimer+=dt;
  if(fpsTimer>=0.5){fps=Math.round(fpsCount/fpsTimer);fpsCount=0;fpsTimer=0;}
  if(mode==='local'){
    (document.getElementById('info-pos')as HTMLElement).textContent=`XYZ: ${pos.x.toFixed(1)} / ${pos.y.toFixed(1)} / ${pos.z.toFixed(1)}`;
    (document.getElementById('info-fps')as HTMLElement).textContent=`FPS: ${fps}`;
    (document.getElementById('info-player')as HTMLElement).textContent=`${playerName}  ${flying?'[FLY]':''}`;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────────
function init(data:{uid:string;name:string}){
  playerName=data.name;
  // Show main menu — user picks local or MC
  mainMenu.style.display='flex';
  // Render loop runs regardless (needed for when local mode starts)
  loop();
}

if((window as any).electron){
  (window as any).electron.onUserData((d:any)=>init(d));
} else {
  const stored=sessionStorage.getItem('userData');
  if(stored)init(JSON.parse(stored));
  else init({uid:'guest',name:'Guest'});
}

// ── Main loop ──────────────────────────────────────────────────────────────────
let last=0;
function loop(now=0){
  requestAnimationFrame(loop);
  const dt=Math.min((now-last)/1000,0.05);last=now;
  if(mode==='local'){
    updatePhysics(dt);
    camera.position.set(pos.x,pos.y,pos.z);
    camera.setRotationFromEuler(new THREE.Euler(pitch,yaw,0,'YXZ'));
    updateChunks();
    publishTimer+=dt;if(publishTimer>0.1){publishTimer=0;publishPlayer();}
    updateRemoteLabels();
  }
  updateHUD(dt);
  renderer.render(scene,camera);
}
