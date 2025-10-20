// Netlify Function: sv-30d (improved)
const UA_MOBILE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const BM = {
  instagram: { epr:[0.025,0.050,0.075], ipr:[1.05,1.20,1.35] },
  facebook : { epr:[0.008,0.015,0.025], ipr:[1.02,1.10,1.20] }
};

function est(platform, likes, comments, shares){
  const e = (likes||0)+(comments||0)+(shares||0);
  const [el,em,eh] = BM[platform].epr;
  const [il,im,ih] = BM[platform].ipr;
  const rL = Math.floor(e/eh), rM = Math.floor(e/em), rH = Math.floor(e/el);
  const iL = Math.floor(rL*il), iM = Math.floor(rM*im), iH = Math.floor(rH*ih);
  return { engagement:e, reach:{low:rL, mid:rM, high:rH}, impr:{low:iL, mid:iM, high:iH} };
}
function toInt(s){
  if(!s) return 0;
  s = String(s).trim().replace(/\u00A0/g,' ').replace(/[^\d.,KMB]/gi,'');
  const m = s.match(/([\d.,]+)\s*([KMB])?/i);
  if(!m) return parseInt(s.replace(/[^\d]/g,''),10)||0;
  let n = parseFloat(m[1].replace('.','').replace(',','.'));
  const suf = (m[2]||'').toUpperCase();
  if(suf==='K') n*=1000;
  if(suf==='M') n*=1000000;
  if(suf==='B') n*=1000000000;
  return Math.round(n);
}

// ---- Instagram strategies ----
async function igViaWebProfile(username){
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA_MOBILE,
      "X-IG-App-ID": "936619743392459", // public web app id used by instagram web
      "Accept": "*/*"
    }
  });
  if(!resp.ok) throw new Error("IG web_profile_info HTTP "+resp.status);
  const j = await resp.json();
  const edges = j?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map(e => ({
    ts: e?.node?.taken_at_timestamp,
    likes: e?.node?.edge_liked_by?.count || 0,
    comments: e?.node?.edge_media_to_parent_comment?.count || 0,
    shares: 0
  }));
}
async function igViaAParam(username){
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/?__a=1&__d=dis`;
  const resp = await fetch(url, { headers: { "User-Agent": UA_MOBILE, "Accept": "application/json" } });
  if(!resp.ok) throw new Error("IG ?__a=1 HTTP "+resp.status);
  const j = await resp.json();
  const edges = j?.graphql?.user?.edge_owner_to_timeline_media?.edges || j?.data?.user?.edge_owner_to_timeline_media?.edges || [];
  return edges.map(e => ({
    ts: e?.node?.taken_at_timestamp,
    likes: e?.node?.edge_liked_by?.count || 0,
    comments: e?.node?.edge_media_to_parent_comment?.count || 0,
    shares: 0
  }));
}
async function igViaHTML(username){
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const resp = await fetch(url, { headers: { "User-Agent": UA_MOBILE } });
  const html = await resp.text();
  let edges = [];
  const m1 = html.match(/"edge_owner_to_timeline_media"\s*:\s*\{[^}]*"edges"\s*:\s*\[(.*?)\]\s*,/s);
  const src = m1 ? m1[1] : (html.match(/"graphql"\s*:\s*\{[\s\S]*?\}/s)?.[0] || "");
  const re = /"taken_at_timestamp"\s*:\s*(\d+)[\s\S]*?"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}[\s\S]*?(?:"edge_media_to_parent_comment"|"edge_media_to_comment")\s*:\s*\{\s*"count"\s*:\s*(\d+)\s*\}/g;
  let m; while((m = re.exec(src))){ edges.push({ ts:+m[1], likes:+m[2], comments:+m[3], shares:0 }); }
  return edges;
}
async function scrapeInstagram(username){
  // try multiple strategies with fallbacks
  try { const e = await igViaWebProfile(username); if(e.length) return e; } catch(_){}
  try { const e = await igViaAParam(username); if(e.length) return e; } catch(_){}
  try { const e = await igViaHTML(username); if(e.length) return e; } catch(_){}
  return [];
}

// ---- Facebook strategies ----
async function scrapeFacebook(handle){
  // prefer mbasic (light markup), fallback to m
  const urls = [
    `https://mbasic.facebook.com/${handle}`,
    `https://m.facebook.com/${handle}`
  ];
  for(const url of urls){
    try{
      const resp = await fetch(url, { headers: { "User-Agent": UA_ANDROID } });
      const html = await resp.text();
      const chunks = html.split(/<article[^>]*>/i).slice(1);
      const posts = [];
      for(const ch of chunks){
        const tsMatch = ch.match(/data-utime="(\d+)"/) || ch.match(/data-utime=&quot;(\d+)&quot;/);
        if(!tsMatch) continue;
        const ts = parseInt(tsMatch[1],10);
        function findCount(regexArr){
          for(const r of regexArr){
            const m = ch.match(r);
            if(m){ return toInt(m[1]); }
          }
          return 0;
        }
        const likes = findCount([/>([\d.,KMB]+)\s*(?:likes?|beğen[^<]*)</i, /aria-label="([\d.,KMB]+)\s*(?:beğen|like)/i]);
        const comments = findCount([/>([\d.,KMB]+)\s*(?:comments?|yorum[^<]*)</i, /aria-label="([\d.,KMB]+)\s*(?:yorum|comment)/i]);
        const shares = findCount([/>([\d.,KMB]+)\s*(?:shares?|paylaş[^<]*)</i, /aria-label="([\d.,KMB]+)\s*(?:paylaş|share)/i]);
        posts.push({ ts, likes, comments, shares });
      }
      if(posts.length) return posts;
    }catch(_){}
  }
  return [];
}

export default async (req, context) => {
  try {
    const u = new URL(req.url);
    let handle = (u.searchParams.get('handle')||'').trim();
    if(!handle){ return new Response(JSON.stringify({ error:"Missing handle. Use handle=instagram:@name or facebook:@name" }), { status: 400 }); }
    let platform=null, name=null;
    const m = handle.toLowerCase().match(/^(instagram|facebook):@?([a-z0-9_.\-]+)/i);
    if(m){ platform = m[1]; name = m[2]; }
    else { const mm = handle.match(/^@?([a-z0-9_.\-]+)$/i); platform = "instagram"; name = mm?mm[1]:null; }
    if(!name){ return new Response(JSON.stringify({ error:"Could not parse handle" }), { status: 400 }); }

    let posts = [];
    if(platform === "instagram"){ posts = await scrapeInstagram(name); }
    else { posts = await scrapeFacebook(name); }

    if(!posts || posts.length===0){
      return new Response(JSON.stringify({ platform, handle:name, error:"No posts parsed (profile may be private/login-walled or IG tightened access). Try again later or enter manual numbers." }), { headers: { "Content-Type":"application/json" } });
    }

    const now = Math.floor(Date.now()/1000);
    const cutoff = now - 30*24*3600;
    const filtered = posts.filter(p => p.ts && p.ts >= cutoff);
    const totals = filtered.reduce((a,p)=>{ a.likes+=p.likes||0; a.comments+=p.comments||0; a.shares+=p.shares||0; a.posts+=1; return a; }, {likes:0,comments:0,shares:0,posts:0});
    const estimate = est(platform, totals.likes, totals.comments, totals.shares);

    return new Response(JSON.stringify({ platform, handle:name, window_days:30, posts_counted: totals.posts, totals, estimate }), { headers: { "Content-Type":"application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error:String(err) }), { status: 500, headers: { "Content-Type":"application/json" } });
  }
};
