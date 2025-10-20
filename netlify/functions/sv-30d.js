// netlify/functions/sv-30d.js  (CommonJS handler + IG/FB proxy fallback + debug)
const UA_MOBILE  = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const BM = {
  instagram: { epr:[0.025,0.050,0.075], ipr:[1.05,1.20,1.35], cap:1.5 },
  facebook : { epr:[0.008,0.015,0.025], ipr:[1.02,1.10,1.20], cap:1.2 },
};

// ---------- utils
const proxify = (url) => `https://r.jina.ai/http://${url.replace(/^https?:\/\//i,"")}`;

async function fetchText(url, headers, dbg){
  const r = await fetch(url, { headers });
  const t = await r.text().catch(()=> "");
  dbg && dbg.push({step:"fetch", url, status:r.status, ok:r.ok});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return t;
}

function toInt(s){
  if(!s) return 0;
  s = String(s).trim().replace(/\u00A0/g,' ').replace(/[^\d.,KMB]/gi,'');
  const m = s.match(/([\d.,]+)\s*([KMB])?/i);
  if(!m) return parseInt(s.replace(/[^\d]/g,''),10)||0;
  let n = parseFloat(m[1].replace('.','').replace(',','.'));
  const u = (m[2]||'').toUpperCase();
  if(u==='K') n*=1e3; if(u==='M') n*=1e6; if(u==='B') n*=1e9;
  return Math.round(n);
}

function estimate(platform, totals, followers){
  const b = BM[platform];
  const E = (totals.likes||0)+(totals.comments||0)+(totals.shares||0);
  const cap = followers ? Math.floor(followers * b.cap) : Infinity;
  const [el,em,eh] = b.epr, [il,im,ih] = b.ipr;
  const reach = {
    low:  Math.min(Math.floor(E/eh), cap),
    mid:  Math.min(Math.floor(E/em), cap),
    high: Math.min(Math.floor(E/el), cap),
  };
  const impr = {
    low:  Math.floor(reach.low  * il),
    mid:  Math.floor(reach.mid  * im),
    high: Math.floor(reach.high * ih),
  };
  return { engagement:E, reach, impr };
}

// ---------- Instagram (3 yöntem × direct/proxy)
async function igWebProfile(username, useProxy, dbg){
  const base=`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const url = useProxy?proxify(base):base;
  const txt = await fetchText(url, { "User-Agent":UA_MOBILE, "X-IG-App-ID":"936619743392459", "Accept":"*/*" }, dbg);
  const j = JSON.parse(txt);
  const edges = j?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map(e=>({ ts:e?.node?.taken_at_timestamp, likes:e?.node?.edge_liked_by?.count||0, comments:e?.node?.edge_media_to_parent_comment?.count||0, shares:0 }));
}
async function igAParam(username, useProxy, dbg){
  const base=`https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const url = useProxy?proxify(base):base;
  const txt = await fetchText(url, { "User-Agent":UA_MOBILE, "Accept":"application/json" }, dbg);
  const j = JSON.parse(txt);
  const edges = j?.graphql?.user?.edge_owner_to_timeline_media?.edges || j?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map(e=>({ ts:e?.node?.taken_at_timestamp, likes:e?.node?.edge_liked_by?.count||0, comments:e?.node?.edge_media_to_parent_comment?.count||0, shares:0 }));
}
async function igHTML(username, useProxy, dbg){
  const base=`https://www.instagram.com/${encodeURIComponent(username)}/`;
  const url = useProxy?proxify(base):base;
  const html= await fetchText(url, { "User-Agent":UA_MOBILE }, dbg);
  const src = (html.match(/"edge_owner_to_timeline_media"\s*:\s*\{[^}]*"edges"\s*:\s*\[(.*?)\]\s*,/s)?.[1])
          ||  (html.match(/"graphql"\s*:\s*\{[\s\S]*?\}/s)?.[0]) || "";
  const re  = /"taken_at_timestamp"\s*:\s*(\d+)[\s\S]*?"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}[\s\S]*?(?:"edge_media_to_parent_comment"|"edge_media_to_comment")\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/g;
  const out=[]; let m; while((m=re.exec(src))){ out.push({ ts:+m[1], likes:+m[2], comments:+m[3], shares:0 }); }
  return out;
}
async function scrapeInstagram(username, forceProxy, dbg){
  const seq = [
    (p)=>igWebProfile(username,p,dbg),
    (p)=>igAParam(username,p,dbg),
    (p)=>igHTML(username,p,dbg),
  ];
  if(!forceProxy){
    for(const fn of seq){ try{ const r=await fn(false); if(r.length) return r; }catch(e){ dbg.push({step:"ig-direct-fail", err:String(e)}); } }
  }
  for(const fn of seq){ try{ const r=await fn(true); if(r.length) return r; }catch(e){ dbg.push({step:"ig-proxy-fail", err:String(e)}); } }
  return [];
}

// ---------- Facebook (mbasic → m → proxy)
async function scrapeFacebook(handle, forceProxy, dbg){
  const bases = [`https://mbasic.facebook.com/${handle}`, `https://m.facebook.com/${handle}`];
  for(const raw of bases){
    const urls = forceProxy ? [proxify(raw)] : [raw, proxify(raw)];
    for(const u of urls){
      try{
        const html = await fetchText(u, { "User-Agent":UA_ANDROID }, dbg);
        const chunks = html.split(/<article[^>]*>/i).slice(1);
        const posts=[];
        for(const ch of chunks){
          const tsMatch = ch.match(/data-utime="(\d+)"/) || ch.match(/data-utime=&quot;(\d+)&quot;/);
          if(!tsMatch) continue;
          const ts = parseInt(tsMatch[1],10);
          const likes    = [/>\s*([\d.,KMB]+)\s*(?:likes?|beğen[^<]*)</i,/aria-label="([\d.,KMB]+)\s*(?:beğen|like)/i].reduce((a,r)=>a||(ch.match(r)?.[1]),0);
          const comments = [/>\s*([\d.,KMB]+)\s*(?:comments?|yorum[^<]*)</i,/aria-label="([\d.,KMB]+)\s*(?:yorum|comment)/i].reduce((a,r)=>a||(ch.match(r)?.[1]),0);
          const shares   = [/>\s*([\d.,KMB]+)\s*(?:shares?|paylaş[^<]*)</i,/aria-label="([\d.,KMB]+)\s*(?:paylaş|share)/i].reduce((a,r)=>a||(ch.match(r)?.[1]),0);
          posts.push({ ts, likes:toInt(likes), comments:toInt(comments), shares:toInt(shares) });
        }
        if(posts.length) return posts;
      }catch(e){ dbg.push({step:"fb-fail", url:u, err:String(e)}); }
    }
  }
  return [];
}

// ---------- CommonJS handler
exports.handler = async (event) => {
  const dbg = [];
  try{
    const qs = event.queryStringParameters || {};
    let handle = (qs.handle || "").trim();
    const followers = parseInt(qs.followers || "", 10) || undefined;
    const forceProxy = (qs.force || "").toLowerCase() === "proxy";
    const wantDebug  = (qs.debug || "") === "1";

    if(!handle) return respond(400, { error:"Missing handle. Use handle=instagram:@name or facebook:@name" });

    let platform=null, name=null;
    const m = handle.toLowerCase().match(/^(instagram|facebook):@?([a-z0-9_.\-]+)/i);
    if(m){ platform=m[1]; name=m[2]; } else { const mm = handle.match(/^@?([a-z0-9_.\-]+)$/i); platform="instagram"; name=mm?mm[1]:null; }
    if(!name) return respond(400, { error:"Could not parse handle" });

    const posts = platform==="instagram"
      ? await scrapeInstagram(name, forceProxy, dbg)
      : await scrapeFacebook(name, forceProxy, dbg);

    if(!posts.length){
      return respond(200, { platform, handle:name, error:"No posts parsed (profile may be private/login-walled). Try force=proxy&debug=1", debug: wantDebug?dbg:undefined });
    }

    const now = Math.floor(Date.now()/1000), cutoff = now - 30*24*3600;
    const last30 = posts.filter(p => p.ts && p.ts >= cutoff);
    if(!last30.length){
      return respond(200, { platform, handle:name, error:"No posts in last 30 days.", debug: wantDebug?dbg:undefined });
    }

    const totals = last30.reduce((a,p)=>{ a.likes+=p.likes||0; a.comments+=p.comments||0; a.shares+=p.shares||0; a.posts+=1; return a; }, {likes:0,comments:0,shares:0,posts:0});
    const est = estimate(platform, totals, followers);
    const res = { platform, handle:name, window_days:30, posts_counted: totals.posts, totals, estimate: est };
    if(wantDebug) res.debug = dbg;
    return respond(200, res);
  }catch(err){
    return respond(500, { error:String(err), debug:dbg });
  }
};

function respond(status, obj){
  return { statusCode: status, headers: { "Content-Type":"application/json" }, body: JSON.stringify(obj) };
}
