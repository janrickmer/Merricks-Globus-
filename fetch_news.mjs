/* Merricks Globus – Nachrichten-Abruf für GitHub Actions
   Holt die RSS-Feeds der Zeitungen + HNA sowie Google News für die wichtigen
   Regionen (NATO-Mitgliedstaaten, Russland, China) und schreibt:
     data/news.json   – Zeitungs-Feeds  { generated, feeds:{ url:{ outlet, items:[{t,l,d,s}] } } }
     data/gnews.json  – Google News     { generated, regions:{ suchbegriff:[{t,l,d,src}] } }
   Grundsatz: Schlägt eine Quelle fehl, bleibt ihr letzter guter Stand erhalten. */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const UA = "Mozilla/5.0 (compatible; MerricksGlobus/1.0; +https://merricks-globus.janrickmer.de)";
const MAX_FEED_ITEMS = 40;   // je Zeitungs-Feed
const MAX_GN_ITEMS   = 15;   // je Google-News-Region

/* Zeitungs-Feeds – identisch mit der Seite (index.html) */
const FEEDS = [
  { url: "https://www.tagesschau.de/xml/rss2",                          outlet: "Tagesschau" },
  { url: "https://www.tagesschau.de/ausland/index~rss2.xml",            outlet: "Tagesschau" },
  { url: "https://www.spiegel.de/schlagzeilen/index.rss",               outlet: "Spiegel" },
  { url: "https://www.spiegel.de/ausland/index.rss",                    outlet: "Spiegel" },
  { url: "https://rss.sueddeutsche.de/rss/Alles",                       outlet: "Süddeutsche Zeitung" },
  { url: "https://rss.sueddeutsche.de/rss/Politik",                     outlet: "Süddeutsche Zeitung" },
  { url: "https://www.faz.net/rss/aktuell",                             outlet: "FAZ" },
  { url: "https://www.faz.net/rss/aktuell/politik",                     outlet: "FAZ" },
  { url: "https://www.handelsblatt.com/contentexport/feed/schlagzeilen",outlet: "Handelsblatt" },
  { url: "https://www.handelsblatt.com/contentexport/feed/politik",     outlet: "Handelsblatt" },
  { url: "https://taz.de/!p4608;rss/",                                  outlet: "taz" },
  { url: "https://taz.de/Politik/!p4615;rss/",                          outlet: "taz" },
  { url: "https://www.noz.de/rss/ressort/Deutschland-Welt",             outlet: "Neue Osnabrücker Zeitung" },
  { url: "https://www.noz.de/rss/ressort/Politik",                      outlet: "Neue Osnabrücker Zeitung" },
  { url: "https://www.noz.de/rss/ressort/Osnabr%C3%BCck",               outlet: "Neue Osnabrücker Zeitung" },
  { url: "https://feeds.feedburner.com/hna/kassel",                     outlet: "HNA" },
  { url: "https://feeds.feedburner.com/hna/goettingen",                 outlet: "HNA" },
  { url: "https://feeds.feedburner.com/hna/northeim",                   outlet: "HNA" },
  { url: "https://feeds.feedburner.com/hna/frankenberg",                outlet: "HNA" }
];

/* Google-News-Suchbegriffe: exakt die Strings, die die Seite je Region bildet
   (32 NATO-Mitgliedstaaten + Russland + China; Deutschland mit Bundespolitik;
   dazu Bundesland Hessen und Kassel – „Kassel" deckt Landkreis und
   kreisfreie Stadt ab, weil beide denselben Suchbegriff erzeugen). */
const GN_QUERIES = ["Albanien","Belgien","Bulgarien","Kanada","Kroatien","Tschechien","Dänemark","Estland","Finnland","Frankreich","Deutschland OR Bundesregierung OR Bundestag","Griechenland","Ungarn","Island","Italien","Lettland","Litauen","Luxemburg","Montenegro","Niederlande","Nordmazedonien","Norwegen","Polen","Portugal","Rumänien","Slowakei","Slowenien","Spanien","Schweden","Türkei","Großbritannien","USA","Russland","China","Hessen","Kassel"];

/* ---------------- Hilfen ---------------- */

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
function stripCdata(s) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}
function cleanText(s) {
  if (!s) return "";
  s = stripCdata(s);
  s = s.replace(/<[^>]+>/g, " ");          // HTML-Reste entfernen
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

/* RSS 2.0 und (rudimentär) Atom parsen */
function parseFeed(xml) {
  const out = [];
  let blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi);
  let atom = false;
  if (!blocks || !blocks.length) { blocks = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi); atom = true; }
  if (!blocks) return out;
  for (const b of blocks) {
    const title = cleanText(tag(b, "title"));
    let link = "";
    if (atom) {
      const lm = b.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      link = lm ? lm[1] : "";
    } else {
      link = cleanText(tag(b, "link")) || (b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? "");
      link = cleanText(link);
    }
    const dateStr = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || tag(b, "dc:date");
    const d = new Date(cleanText(dateStr));
    const desc = cleanText(tag(b, "content:encoded")) || cleanText(tag(b, "description")) || cleanText(tag(b, "summary"));
    if (!title || !link) continue;
    out.push({ t: title, l: link.trim(), d: isNaN(d) ? 0 : d.getTime(), s: desc.slice(0, 300) });
  }
  return out;
}

async function fetchText(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" }, redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(to); }
}

function readJsonIfAny(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/* Begrenzte Parallelität */
async function withPool(jobs, size) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (i < jobs.length) { const j = jobs[i++]; await j(); }
  });
  await Promise.all(workers);
}

/* ---------------- Hauptlauf ---------------- */

const oldNews  = readJsonIfAny("data/news.json");
const oldGnews = readJsonIfAny("data/gnews.json");

const feeds = {};
let feedOk = 0, feedKept = 0, feedFail = 0;
await withPool(FEEDS.map(f => async () => {
  try {
    const xml = await fetchText(f.url);
    const items = parseFeed(xml).slice(0, MAX_FEED_ITEMS);
    if (!items.length) throw new Error("keine Einträge");
    feeds[f.url] = { outlet: f.outlet, items };
    feedOk++;
    console.log("OK   " + f.outlet + "  " + f.url + "  (" + items.length + ")");
  } catch (e) {
    const prev = oldNews && oldNews.feeds && oldNews.feeds[f.url];
    if (prev && prev.items && prev.items.length) {
      feeds[f.url] = prev; feedKept++;
      console.log("ALT  " + f.outlet + "  " + f.url + "  (" + String(e.message || e) + " – letzter Stand übernommen)");
    } else {
      feedFail++;
      console.log("FEHL " + f.outlet + "  " + f.url + "  (" + String(e.message || e) + ")");
    }
  }
}), 5);

const regions = {};
let gnOk = 0, gnKept = 0, gnFail = 0;
await withPool(GN_QUERIES.map(q => async () => {
  const rss = "https://news.google.com/rss/search?q=" + encodeURIComponent(q + " when:1y") + "&hl=de&gl=DE&ceid=DE:de";
  try {
    const xml = await fetchText(rss);
    const items = parseFeed(xml)
      .map(it => {
        // Google News hängt " - Quelle" an den Titel; Quelle steckt im <source>-Tag
        const src = "";
        return { t: it.t, l: it.l, d: it.d, src };
      })
      .slice(0, MAX_GN_ITEMS);
    // Quellennamen nachziehen (source-Tag je Item)
    const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    blocks.slice(0, items.length).forEach((b, i) => {
      const src = cleanText(tag(b, "source"));
      if (src) {
        items[i].src = src;
        if (items[i].t.endsWith(" - " + src)) items[i].t = items[i].t.slice(0, -(src.length + 3));
      }
    });
    if (!items.length) throw new Error("keine Einträge");
    regions[q] = items;
    gnOk++;
    console.log("OK   Google News: " + q + "  (" + items.length + ")");
  } catch (e) {
    const prev = oldGnews && oldGnews.regions && oldGnews.regions[q];
    if (prev && prev.length) {
      regions[q] = prev; gnKept++;
      console.log("ALT  Google News: " + q + "  (" + String(e.message || e) + " – letzter Stand übernommen)");
    } else {
      gnFail++;
      console.log("FEHL Google News: " + q + "  (" + String(e.message || e) + ")");
    }
  }
  await new Promise(r => setTimeout(r, 150));   // Google News nicht bedrängen
}), 4);

mkdirSync("data", { recursive: true });
const now = new Date().toISOString();
writeFileSync("data/news.json",  JSON.stringify({ generated: now, feeds }));
writeFileSync("data/gnews.json", JSON.stringify({ generated: now, regions }));

console.log("\nZusammenfassung:");
console.log("  Zeitungs-Feeds: " + feedOk + " frisch, " + feedKept + " alter Stand, " + feedFail + " ohne Daten (von " + FEEDS.length + ")");
console.log("  Google News:    " + gnOk + " frisch, " + gnKept + " alter Stand, " + gnFail + " ohne Daten (von " + GN_QUERIES.length + ")");
