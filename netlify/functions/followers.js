// netlify/functions/followers.js
// CommonJS — Follower sayısı toplayıcı (Instagram/FB), multi-handle destekli.

const UA_MOBILE  = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
const proxify = (url) => `https://r.jina.ai/http://${url.replace(/^https?:\/\//i,"")}`;

function toInt(s){
  if(!s) return 0;
  s = String(s).trim()
    .replace(/\u00A0/g,' ')
    // Lokal suffix normalizasyonu
    .replace(/milyon/gi, 'M')
    .replace(/\bmn\b/gi, 'M')     // 1,4 Mn
    .replace(/\bm\.?n\b/gi, 'M')  // m.n varyantları
    .replace(/\bbin\b/gi, 'K')
    .replace(/bilyon/gi, 'B')
    .replace(/\bbn\b/gi, 'B');

  const m = s.match(/([\d.,]+)\s*([KkMmBb])?/);
  if(!m) return parseInt(s.replace(/[^\d]/g,''),10)||0;

  let n = parseFloat(m[1].replace(/\./g,'').replace(',', '.'));
  const suf = (m[2]||'').toUpperCase();
  if(suf==='K') n*=1e3;
  if(suf==='M') n*=1e6;
  if(suf==='B') n*=1e9;
  return Math.round(n);
}

/* ---- Instagram followers */
function igFollowersFromHtml(html){
  // JSON gömülü alan
  let m = html.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
  if(m) return parseInt(m[1],10);
  m = html.match(/"follower_count"\s*:\s*(\d+)/);
  if(m) return parseInt(m[1],10);
  // meta description: "... 12,345 Followers, ..."
  m = html.match(/content="([\d.,KMB]+)\s+Followers/i) || html.match(/content="([\d.,KMB]+)\s+Takipçi/i);
  if(m) return toInt(m[1]);
  // düz metinde "Followers" / "Takipçi"
  m = html.match(/([\d.,KMB]+)\s+Followers/i) || html.match(/([\d.,KMB]+)\s+Takipçi/i);
  if(m) return toInt(m[1]);
  return null;
}
async function getIgFollowers(name){
  // 1) HTML (direct)
  try{
    const html = await fetchText(`https://www.instagram.com/${name}/`, { "User-Agent": UA_MOBILE });
    const v = igFollowersFromHtml(html);
    if(v!=null) return { followers: v, source: "ig-html-direct" };
  }catch(_){}
  // 2) HTML (proxy)
  try{
    const html = await fetchText(proxify(`https://www.instagram.com/${name}/`), { "User-Agent": UA_MOBILE });
    const v = igFollowersFromHtml(html);
    if(v!=null) return { followers: v, source: "ig-html-proxy" };
  }catch(_){}
  // 3) JSON (direct only)
  try{
    const j = await fetchText(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(name)}`, { "User-Agent": UA_MOBILE, "X-IG-App-ID":"936619743392459", "Accept":"*/*" });
    const data = JSON.parse(j);
    const v = data?.data?.user?.edge_followed_by?.count;
    if(typeof v === "number") return { followers: v, source: "ig-json-direct" };
  }catch(_){}
  return { followers: null, source: "ig-none" };
}

/* ---- Facebook followers (m/mbasic + proxy) */
function fbFollowersFromHtml(html){
  // "X followers" / "X kişi takip ediyor"
  let m = html.match(/([\d.,KMB]+)\s+followers/i) || html.match(/([\d.,KMB]+)\s+people follow/i);
  if(m) return toInt(m[1]);
  m = html.match(/([\d.,KMB]+)\s+kişi\s+t[aâ]kip ediyor/i) || html.match(/([\d.,KMB]+)\s+kişi takip ediyor/i);
  if(m) return toInt(m[1]);
  // bazı sayfalarda "likes" daha belirgin olabilir
  m = html.match(/([\d.,KMB]+)\s+likes/i) || html.match(/([\d.,KMB]+)\s+beğeni/i);
  if(m) return toInt(m[1]);
  return null;
}
async function getFbFollowers(name){
  const tries = [
    { url:`https://m.facebook.com/${name}`, ua: UA_ANDROID, tag:"fb-m-direct" },
    { url:proxify(`https://m.facebook.com/${name}`), ua: UA_ANDROID, tag:"fb-m-proxy" },
    { url:`https://mbasic.facebook.com/${name}`, ua: UA_ANDROID, tag:"fb-mbasic-direct" },
    { url:proxify(`https://mbasic.facebook.com/${name}`), ua: UA_ANDROID, tag:"fb-mbasic-proxy" },
  ];
  for(const t of tries){
    try{
      const html = await fetchText(t.url, { "User-Agent": t.ua });
      const v = fbFollowersFromHtml(html);
      if(v!=null) return { followers: v, source: t.tag };
    }catch(_){}
  }
  return { followers: null, source: "fb-none" };
}

/* ---- Router */
async function getFollowers(platform, name){
  return platform === "instagram" ? await getIgFollowers(name) : await getFbFollowers(name);
}

exports.handler = async (event) => {
  try{
    const raw = (event.queryStringParameters?.list || "").trim();
    if(!raw) return respond(400, { error: "Provide ?list=bbc,odakreport,stargazete or space-separated." });

    const tokens = raw.split(/[,\s]+/).filter(Boolean).slice(0, 25);
    const items = [];
    for(const token of tokens){
      const { platform, name } = parseHandle(token);
      let followers=null, source=null, ok=false, error=null;
      try{
        const r = await getFollowers(platform, name);
        followers = r.followers; source = r.source; ok = followers!=null;
      }catch(e){ error = String(e); }
      items.push({ input: token, platform, handle: `${platform}:@${name}`, followers, ok, source, error });
      // hafif throttle
      await new Promise(res=>setTimeout(res, 120));
    }
    return respond(200, { items, ts: Date.now() });
  }catch(err){
    return respond(500, { error: String(err) });
  }
};

function respond(status, obj){
  return { statusCode: status, headers: { "Content-Type":"application/json; charset=utf-8" }, body: JSON.stringify(obj) };
}
