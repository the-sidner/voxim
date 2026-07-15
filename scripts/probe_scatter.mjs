// One-off probe: did floor scatter load + place? Reads client state.
import { chromium } from 'playwright';
const CLIENT = 'http://localhost:14433/', GW = 'http://localhost:8081';
const EXE = process.env.CHROME || '/home/work/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';
const creds = { loginName: 'agentbot', password: 'agentbot-pass-123' };
async function auth(){for(const p of ['/account/login','/account/register']){const r=await fetch(GW+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(creds)}).catch(()=>null);if(r?.ok){const j=await r.json();if(j.token)return j.token;}}throw new Error('auth');}
const token = await auth();
const b = await chromium.launch({headless:true,executablePath:EXE,args:['--no-sandbox']});
const ctx = await b.newContext({viewport:{width:1280,height:800},ignoreHTTPSErrors:true});
await ctx.addInitScript((t)=>{globalThis.VOXIM_SESSION_TOKEN=t;},token);
const page = await ctx.newPage();
const errs=[]; page.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); }); page.on('pageerror',e=>errs.push('PAGEERR '+e.message));
await page.goto(CLIENT,{waitUntil:'domcontentloaded'});
await page.getByText('Enter the world',{exact:false}).click({timeout:8000}).catch(()=>{});
for(let i=0;i<60;i++){const ok=await page.evaluate(()=>{const g=globalThis._voxim_game;return !!(g&&g.playerId&&g.world?.get&&g.world.get(g.playerId));}).catch(()=>false);if(ok)break;await page.waitForTimeout(400);}
await page.waitForTimeout(3000);
const out = await page.evaluate(()=>{
  const g = globalThis._voxim_game;
  const r = {};
  r.gameKeys = Object.keys(g||{});
  const content = g.content || g.contentService || g.world?.content;
  r.hasContent = !!content;
  if (content?.scatter) r.scatter = [...content.scatter.keys()];
  if (content?.procModels) r.procModels = [...content.procModels.keys()];
  if (content?.materials) r.materialIds = [...content.materials.values()].map(m=>`${m.name}=${m.id}`);
  const rend = g.renderer;
  r.rendererKeys = rend ? Object.keys(rend) : null;
  if (rend?.instancePool) r.handleCount = rend.instancePool.handleCount;
  // material histogram around player
  const e = g.world.get(g.playerId);
  const px = e?.position?.x, py = e?.position?.y;
  r.playerPos = {px, py};
  if (g.world.getMaterialData) {
    const cx = Math.floor(px/32), cy = Math.floor(py/32);
    const md = g.world.getMaterialData(cx, cy);
    r.matDataChunk = `${cx},${cy}`;
    if (md){ const h={}; for(const v of md) h[v]=(h[v]||0)+1; r.matHistogram = h; } else r.matHistogram = 'null';
    // neighbours
    const nb={}; for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const m=g.world.getMaterialData(cx+dx,cy+dy);nb[`${cx+dx},${cy+dy}`]=m?[...new Set(m)].join('/'):'null';}
    r.neighbourMats = nb;
  }
  return r;
});
console.log(JSON.stringify(out,null,1));
if(errs.length) console.log('CONSOLE ERRORS:', JSON.stringify(errs.slice(0,8)));
await b.close();
