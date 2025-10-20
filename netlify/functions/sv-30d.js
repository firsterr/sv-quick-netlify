// netlify/functions/sv-30d.js
const UA_MOBILE  = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const BM = {
  instagram: { epr:[0.025,0.050,0.075], ipr:[1.05,1.20,1.35], cap:1.5 },
  facebook : { epr:[0.008,0.015,0.025], ipr:[1.02,1.10,1.20], cap:1.2 },
};

// ---------- utils
const proxify = (url) => {
  const bare = url.replace(/^https?:\/\//i, "");
  return `https://r.jina.ai/http://${bare}`; // reader proxy
};

async function fetchText(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return await r.text();
}

function toInt(s){
  if(!s) return 0;
  s = String(s).trim().replace(/\u00A0/g,' ').replace(/[^\d.,KMB]/gi,'');
  const m = s.match(/([\d.,]+)\s*([KMB])?/i);
  if(!m) return parseInt(s.replace(/[^\d]/g,''),10)||0;
  let n = parseFloat(m[1].replace('.','').replace(',','.'));
  const suf = (m[2]||'').toUpperCase();
  if(suf==='K') n*=1000; if(suf==='M') n*=1000000; if(suf==='B') n*=1000000000;
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

// ---------- Instagram (direct → proxy; 3 yöntem × 2 kanal)
async function igViaWebProfile(username, useProxy=false){
  const base = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const url  = useProxy ? proxify(base) : base;
  const txt  = await fetchText(url, { "User-Agent": UA_MOBILE, "X-IG-App-ID":"936619743392459", "Accept":"*/*" });
  const j    = JSON.parse(txt);
  const edges = j?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map(e => ({
    ts: e?.node?.taken_at_timestamp,
    likes: e?.node?.edge_liked_by?.count || 0,
    comments: e?.node?.edge_media_to_parent_comment?.count || 0,
    shares: 0,
  }));
}
async function igViaAParam(username, useProxy=false){
  const base = `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const url  = useProxy ? proxify(base) : base;
  const txt  = await fetchText(url, { "User-Agent": UA_MOBILE, "Accept":"application/json" });
  const j    = JSON.parse(txt);
  const edges = j?.graphql?.user?.edge_owner_to_timeline_media?.edges || j?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map(e => ({
    ts: e?.node?.taken_at_timestamp,
    likes: e?.node?.edge_liked_by?.count || 0,
    comments: e?.node?.edge_media_to_parent_comment?.count || 0,
    shares: 0,
  }));
}
async function igViaHTML(username, useProxy=false){
  const base = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const url  = useProxy ? proxify(base) : base;
  const html = await fetchText(url, { "User-Agent": UA_MOBILE });
  let src = "";
  const m1 = html.match(/"edge_owner_to_timeline_media"\s*:\s*\{[^}]*"edges"\s*:\s*\[(.*?)\]\s*,/s);
  src = m1 ? m1[1] : (html.match(/"graphql"\s*:\s*\{[\s\S]*?\}/s)?.[0] || "");
  const re = /"taken_at_timestamp"\s*:\s*(\d+)[\s\S]*?"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}[\s\S]*?(?:"edge_media_to_parent_comment"|"edge_media_to_comment")\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/g;
  const out = []; let m;
  while((m = re.exec(src))){ out.push({ ts:+m[1], likes:+m[2], comments:+m[3], shares:0 }); }
  return out;
}
async function scrapeInstagram(username){
  for (const fn of [
    () => igViaWebProfile(username, false),
    () => igViaAParam(username, false),
    () => igViaHTML(username, false),
    () => igViaWebProfile(username, true),
    () => igViaAParam(username, true),
    () => igViaHTML(username, true),
  ]) {
    try {
      const list = await fn();
      if (list && list.length) return list;
    } catch (_) {}
  }
  return [];
}

// ---------- Facebook (mbasic → m → proxy)
async function scrapeFacebook(handle){
  const variants = [
    { url:`https://mbasic.facebook.com/${handle}`, headers:{ "User-Agent": UA_ANDROID }},
    { url:`https://m.facebook.com/${handle}`,      headers:{ "User-Agent": UA_ANDROID }},
    { url:proxify(`https://mbasic.facebook.com/${handle}`), headers:{ "User-Agent": UA_ANDROID }},
    { url:proxify(`https://m.facebook.com/${handle}`),      headers:{ "User-Agent": UA_ANDROID }},
  ];
  for(const v of variants){
    try{
      const html = await fetchText(v.url, v.headers);
      const chunks = html.split(/<article[^>]*>/i).slice(1);
      const posts = [];
      for(const ch of chunks){
        const tsMatch = ch.match(/data-utime="(\d+)"/) || ch.match(/data-utime=&quot;(\d+)&quot;/);
        if(!tsMatch) continue;
        const ts = parseInt(tsMatch[1],10);
        const likes    = [/>\s*([\d.,KMB]+)\s*(?:likes?|beğen[^<]*)</i, /aria-label="([\d.,KMB]+)\s*(?:beğen|like)/i].reduce((a,r)=>a|| (ch.match(r)?.[1]),0); 
        const comments = [/>\s*([\d.,KMB]+)\s*(?:comments?|yorum[^<]*)</i, /aria-label="([\d.,KMB]+)\s*(?:yorum|comment)/i].reduce((a,r)=>a|| (ch.match(r)?.[1]),0);
        const shares   = [/>\s*([\d.,KMB]+)\s*(?:shares?|paylaş[^<]*)</i, /aria-label="([\d.,KMB]+)\s*(?:paylaş|share)/i].reduce((a,r)=>a|| (ch.match(r)?.[1]),0);
        posts.push({ ts, likes:toInt(likes), comments:toInt(comments), shares:toInt(shares) });
      }
      if(posts.length) return posts;
    }catch(_){}
  }
  return [];
}

// ---------- main
export default async (req) => {
  try{
    const u = new URL(req.url);
    let handle = (u.searchParams.get('handle')||'').trim();
    const followers = parseInt(u.searchParams.get('followers')||"", 10) || undefined;

    if(!handle) return new Response(JSON.stringify({ error:"Missing handle. Use handle=instagram:@name or facebook:@name" }), { status:400 });

    let platform=null, name=null;
    const m = handle.toLowerCase().match(/^(instagram|facebook):@?([a-z0-9_.\-]+)/i);
    if(m){ platform=m[1]; name=m[2]; } 
    else { const mm = handle.match(/^@?([a-z0-9_.\-]+)$/i); platform="instagram"; name=mm?mm[1]:null; }
    if(!name) return new Response(JSON.stringify({ error:"Could not parse handle" }), { status:400 });

    const posts = platform==="instagram" ? await scrapeInstagram(name) : await scrapeFacebook(name);
    if(!posts.length) return new Response(JSON.stringify({ platform, handle:name, error:"No posts parsed (profile may be private/login-walled)." }), { headers:{ "Content-Type":"application/json" } });

    const now = Math.floor(Date.now()/1000), cutoff = now - 30*24*3600;
    const last30 = posts.filter(p => p.ts && p.ts >= cutoff);

    const totals = last30.reduce((a,p)=>{ a.likes+=p.likes||0; a.comments+=p.comments||0; a.shares+=p.shares||0; a.posts+=1; return a; }, {likes:0,comments:0,shares:0,posts:0});
    const est = estimate(platform, totals, followers);

    return new Response(JSON.stringify({
      platform, handle:name, window_days:30,
      posts_counted: totals.posts, totals,
      estimate: est
    }), { headers:{ "Content-Type":"application/json" } });

  }catch(err){
    return new Response(JSON.stringify({ error:String(err) }), { status:500, headers:{ "Content-Type":"application/json" } });
  }
};
