import fs from "fs";
import zlib from "zlib";

const EPG_SOURCES = [
  "https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/guide.xml.gz",
  "https://www.open-epg.com/files/egypt.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_BEIN1.xml.gz"
];

function cleanKey(str) {
  if (!str) return "";
  return str.toLowerCase()
    .replace(/\.(ae|sa|eg|qa|kw|net|com|tv|org|uk|us)$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function parseXmltvDate(raw) {
  if (!raw || raw.length < 14) return null;
  const y = raw.slice(0, 4), mo = raw.slice(4, 6), d = raw.slice(6, 8);
  const h = raw.slice(8, 10), mi = raw.slice(10, 12), s = raw.slice(12, 14);
  const tzMatch = raw.trim().match(/([+-]\d{2}):?(\d{2})$/);
  const offset = tzMatch ? `${tzMatch[1]}:${tzMatch[2]}` : "+00:00";
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

async function run() {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Starting EPG build at ${new Date().toISOString()} (now=${nowSec})`);
  const combined = {};

  for (const url of EPG_SOURCES) {
    console.log(`\nFetching: ${url}`);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        console.warn(`Failed with status: ${res.status}`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB compressed`);
      
      const xml = url.endsWith(".gz") ? zlib.gunzipSync(buffer).toString("utf-8") : buffer.toString("utf-8");
      console.log(`Decompressed to ${(xml.length / 1024 / 1024).toFixed(2)} MB text. Parsing...`);
      
      const programmesByChannel = new Map();
      let pos = 0;
      let count = 0;
      
      while ((pos = xml.indexOf("<programme", pos)) !== -1) {
        const endTag = xml.indexOf("</programme>", pos);
        if (endTag === -1) break;
        const progXml = xml.slice(pos, endTag);
        pos = endTag + 12;

        const chMatch = progXml.match(/channel="([^"]+)"/);
        const stMatch = progXml.match(/start="([^"]+)"/);
        const spMatch = progXml.match(/stop="([^"]+)"/);
        if (!chMatch || !stMatch || !spMatch) continue;

        const channelId = chMatch[1];
        const startSec = parseXmltvDate(stMatch[1]);
        const stopSec = parseXmltvDate(spMatch[1]);
        if (!startSec || !stopSec) continue;
        
        // Keep programmes relevant for the next 12 hours
        if (stopSec < nowSec || startSec > nowSec + 12 * 3600) continue;

        const tMatch = progXml.match(/<title[^>]*>([^<]+)<\/title>/);
        const title = tMatch ? tMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "Untitled";

        if (!programmesByChannel.has(channelId)) programmesByChannel.set(channelId, []);
        programmesByChannel.get(channelId).push({ title, start: startSec, stop: stopSec });
        count++;
      }

      console.log(`Parsed ${count} programmes for ${programmesByChannel.size} channels`);

      for (const [chId, list] of programmesByChannel.entries()) {
        list.sort((a, b) => a.start - b.start);
        const cur = list.find((p) => p.start <= nowSec && nowSec < p.stop) || null;
        const nxt = list.find((p) => p.start >= (cur ? cur.stop : nowSec)) || null;
        const entry = { now: cur, next: nxt };

        combined[chId] = entry;
        const norm = cleanKey(chId);
        if (norm) {
          combined[norm] = entry;
          if (norm.startsWith("osntv")) combined["osn" + norm.slice(5)] = entry;
        }
      }
    } catch (err) {
      console.error(`Error processing ${url}:`, err);
    }
  }

  const out = {
    updatedAt: nowSec,
    count: Object.keys(combined).length,
    channels: combined
  };

  fs.mkdirSync("dist", { recursive: true });
  fs.writeFileSync("dist/epg.json", JSON.stringify(out));
  
  // Also create a root index.html so visiting the URL shows status
  fs.writeFileSync("dist/index.html", `<!DOCTYPE html>
<html>
<head><title>Stremio Origin EPG</title><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem;">
  <h2>Stremio Origin EPG Feed</h2>
  <p>Status: Active</p>
  <p>Last Updated: ${new Date(nowSec * 1000).toUTCString()}</p>
  <p>Total Channels Indexed: ${out.count}</p>
  <p><a href="epg.json" style="color:#6cf;">Download / View epg.json</a></p>
</body>
</html>`);

  const stat = fs.statSync("dist/epg.json");
  console.log(`\nSuccessfully generated dist/epg.json! Size: ${(stat.size / 1024).toFixed(1)} KB with ${out.count} channel keys.`);
}

run();
