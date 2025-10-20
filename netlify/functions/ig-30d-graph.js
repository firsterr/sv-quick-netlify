// Netlify Function: ig-30d-graph (Instagram Graph API)
const API = "https://graph.facebook.com/v20.0";
async function g(url){
  const r = await fetch(url, { headers: { "Accept":"application/json" } });
  if(!r.ok){ const t = await r.text(); throw new Error("Graph error "+r.status+": "+t); }
  return await r.json();
}
async function resolveBizIgId(token){
  const me = await g(`${API}/me/accounts?fields=id,name,instagram_business_account&limit=50&access_token=${encodeURIComponent(token)}`);
  for(const p of (me.data||[])){ const ig = p.instagram_business_account?.id; if(ig) return ig; }
  throw new Error("Could not resolve IG business account id. Set META_IG_BUSINESS_ID env.");
}
function summarize(media){
  const cutoff = Date.now() - 30*24*3600*1000;
  const within = media.filter(m => new Date(m.timestamp).getTime() >= cutoff);
  const totals = within.reduce((a,m)=>{ a.likes+=m.like_count||0; a.comments+=m.comments_count||0; a.posts+=1; return a; }, {likes:0,comments:0,shares:0,posts:0});
  const e = totals.likes + totals.comments;
  const reachMid = Math.floor(e / 0.050);
  const imprMid  = Math.floor(reachMid * 1.20);
  return { posts_counted: totals.posts, totals, estimate: { reach:{low:Math.floor(e/0.075), mid:reachMid, high:Math.floor(e/0.025)}, impr:{low:Math.floor((e/0.075)*1.05), mid:imprMid, high:Math.floor((e/0.025)*1.35)} } };
}
export default async (req, ctx) => {
  try{
   const u = new URL(req.url, "https://dummy.local");
    const handle = (u.searchParams.get("handle")||"").trim();
    const m = handle.toLowerCase().match(/^(instagram:)?@?([a-z0-9_.\-]+)/i);
    if(!m) return new Response(JSON.stringify({ error:"Bad handle" }), { status:400 });
    const username = m[2];
    const token = process.env.META_ACCESS_TOKEN;
    if(!token) return new Response(JSON.stringify({ error:"Missing META_ACCESS_TOKEN env" }), { status:500 });
    let igBizId = process.env.META_IG_BUSINESS_ID;
    if(!igBizId){ igBizId = await resolveBizIgId(token); }
    const fields = `business_discovery.username(${username}){id,username,media.limit(100){timestamp,comments_count,like_count,media_type}}`;
    const url = `${API}/${igBizId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
    const j = await g(url);
    const media = j?.business_discovery?.media?.data || [];
    if(!media.length) return new Response(JSON.stringify({ platform:"instagram", handle:username, error:"No media via Graph API (account must be public & business/creator discoverable)." }), { headers:{ "Content-Type":"application/json"} });
    const s = summarize(media);
    return new Response(JSON.stringify({ platform:"instagram", handle:username, window_days:30, ...s, source:"graph" }), { headers:{ "Content-Type":"application/json"} });
  }catch(err){
    return new Response(JSON.stringify({ error:String(err) }), { status:500, headers:{ "Content-Type":"application/json"} });
  }
};
