import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const UA = "english-reel-bot/1.0 (personal learning project)";
const hid = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const unc = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const strip = (s) => s.replace(/<[^>]*>/g, " ");
export const clean = (s) => dec(strip(dec(unc(s || "")))).replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
const tag = (x, n) => {
  const m = x.match(new RegExp("<" + n + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + n + ">", "i"));
  return m ? m[1] : "";
};
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u.trim() : "");

export function parseFeed(xml) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return items.map((x) => {
    let link = clean(tag(x, "link"));
    if (!link) {
      const m = x.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : "";
    }
    const d = Date.parse(clean(tag(x, "pubDate") || tag(x, "published") || tag(x, "updated") || tag(x, "dc:date")));
    const text = clean(tag(x, "description") || tag(x, "summary") || tag(x, "content:encoded") || tag(x, "content"));
    return { title: clean(tag(x, "title")), url: safeUrl(link), date: isNaN(d) ? null : d, text };
  });
}

async function get(url, json) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(r.status + " " + url);
  return json ? r.json() : r.text();
}

async function main() {
  const cfg = JSON.parse(readFileSync("config.json", "utf8"));
  let extra = {};
  try { extra = JSON.parse(readFileSync("config.extra.json", "utf8")); } catch (e) {}
  for (const k of ["feeds", "steam", "wiki"]) cfg[k] = [...(cfg[k] || []), ...(extra[k] || [])];
  const maxAge = (cfg.maxAgeDays || 14) * 864e5, per = cfg.maxPerFeed || 8, now = Date.now();
  const out = [];
  const push = (o) => {
    if (!o.title || !o.text || o.text.length < 60) return;
    out.push({ id: hid(o.url || o.title), topic: o.topic, title: o.title, text: o.text.slice(0, 1500), url: o.url, source: o.source, lic: o.license || "", ok: o.ok !== false, date: o.date ? new Date(o.date).toISOString() : null });
  };

  for (const f of cfg.feeds || []) {
    try {
      const items = parseFeed(await get(f.url)).filter((i) => i.date && now - i.date < maxAge).slice(0, per);
      items.forEach((i) => push({ ...i, topic: f.topic, source: f.name, license: f.license, ok: f.ok }));
      console.log(f.name, items.length);
    } catch (e) { console.error("feed failed:", f.name, e.message); }
  }

  for (const g of cfg.steam || []) {
    try {
      const j = await get(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${g.appid}&count=${per}&maxlength=0`, true);
      const items = ((j.appnews && j.appnews.newsitems) || []).filter((i) => now - i.date * 1000 < maxAge);
      items.forEach((i) => push({ title: clean(i.title), text: clean(i.contents), url: safeUrl(i.url), date: i.date * 1000, topic: "遊戲版本", source: g.name + (i.feedlabel ? " · " + i.feedlabel : ""), license: "授權未確認（Steam）", ok: false }));
      console.log(g.name, items.length);
    } catch (e) { console.error("steam failed:", g.name, e.message); }
  }

  for (const w of cfg.wiki || []) {
    try {
      const j = await get(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(w.title)}`, true);
      const ex = (j.query.pages[0] || {}).extract || "";
      let m = null;
      for (const sec of [].concat(w.section || "Gameplay")) {
        if (sec === "lead") {
          const lead = ex.split(/\n==/)[0].trim();
          m = lead ? [null, lead] : null;
        } else {
          m = ex.match(new RegExp("\\n==\\s*" + sec + "\\s*==\\n([\\s\\S]*?)(?=\\n==[^=]|$)"));
        }
        if (m) break;
      }
      if (!m) { console.error("wiki section missing:", w.title, JSON.stringify(w.section)); continue; }
      const text = m[1].split("\n").filter((l) => !/^=/.test(l)).join(" ").replace(/\s+/g, " ").trim();
      push({ title: w.name + " - " + (w.label || [].concat(w.section || "Gameplay")[0]), text, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(w.title.replace(/ /g, "_")), date: null, topic: w.topic, source: "Wikipedia", license: w.license || "CC BY-SA 4.0", ok: true });
      console.log(w.name, "wiki ok");
    } catch (e) { console.error("wiki failed:", w.title, e.message); }
  }

  if (cfg.current) {
    try {
      const d = new Date(), p = (n) => String(n).padStart(2, "0");
      const j = await get(`https://en.wikipedia.org/api/rest_v1/feed/featured/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`, true);
      const news = (j.news || []).slice(0, cfg.current.count || 6);
      news.forEach((n) => {
        const ls = (n.links || []).filter((l) => l.extract).slice(0, 2);
        const story = clean(n.story || "");
        const first = ls[0] || (n.links || [])[0];
        const page = first ? (first.titles && first.titles.canonical) || first.title || "" : "";
        push({ title: story.slice(0, 120), text: story + " " + ls.map((l) => clean(l.extract)).join(" "), url: page ? "https://en.wikipedia.org/wiki/" + encodeURIComponent(page) : "https://en.wikipedia.org/wiki/Portal:Current_events", date: Date.now(), topic: cfg.current.topic, source: "Wikipedia In the news", license: "CC BY-SA 4.0", ok: true });
      });
      console.log("current", news.length);
    } catch (e) { console.error("current failed:", e.message); }
  }

  let links = [];
  if (cfg.hn) {
    try {
      const ids = (await get("https://hacker-news.firebaseio.com/v0/topstories.json", true)).slice(0, cfg.hn.count || 10);
      const its = await Promise.all(ids.map((id) => get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, true).catch(() => null)));
      const hnUrl = (i) => "https://news.ycombinator.com/item?id=" + i.id;
      links = its
        .filter((i) => i && i.title && !i.dead && !i.deleted)
        .map((i) => ({ title: dec(i.title).replace(/&#x27;/g, "'"), url: safeUrl(i.url) || hnUrl(i), hn: hnUrl(i), score: i.score || 0, comments: i.descendants || 0 }));
      console.log("hn", links.length);
    } catch (e) { console.error("hn failed:", e.message); }
  }

  const seen = new Set();
  const items = out.filter((i) => !seen.has(i.id) && seen.add(i.id)).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 200);
  writeFileSync("sources.json", JSON.stringify({ updated: new Date().toISOString(), items, links }, null, 1));
  console.log("total", items.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();