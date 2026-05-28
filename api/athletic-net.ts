import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse } from 'node-html-parser';

// Fetch a URL pretending to be a real browser to get past Cloudflare
async function fetchWithBrowserHeaders(url: string, referer?: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': referer ?? 'https://www.athletic.net/',
      'Origin': 'https://www.athletic.net',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
    },
  });
}

// Try athletic.net's internal Next.js data API
async function tryNextDataApi(athleteId: string, sport: string): Promise<AthleticNetPR[] | null> {
  // athletic.net uses Next.js — try the _next/data endpoint which is less protected
  const searchUrl = `https://www.athletic.net/api/v1/athlete/${athleteId}/prs?sport=${sport}`;
  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': `https://www.athletic.net/athlete/${athleteId}/${sport}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data)) {
      return data.map((r: any) => ({
        event: r.event ?? r.EventName ?? r.eventName ?? '',
        mark: r.mark ?? r.Result ?? r.result ?? '',
        date: r.date ?? undefined,
        meet: r.meet ?? r.meetName ?? undefined,
      })).filter((r: AthleticNetPR) => r.event && r.mark);
    }
  } catch {
    // ignore
  }
  return null;
}

export interface AthleticNetPR {
  event: string;
  mark: string;
  date?: string;
  meet?: string;
}

export interface AthleticNetAthlete {
  id: string;
  name: string;
  prs: AthleticNetPR[];
}

// Parse PRs from the __NEXT_DATA__ JSON embedded in the page
function parsePRsFromNextData(nextData: any): AthleticNetPR[] {
  const prs: AthleticNetPR[] = [];
  try {
    // Navigate the Next.js page props — structure may vary; try common paths
    const props =
      nextData?.props?.pageProps ??
      nextData?.props ??
      {};

    // athletic.net embeds results as arrays under various keys
    const resultSources = [
      props?.athlete?.prs,
      props?.athlete?.PRs,
      props?.prs,
      props?.personalRecords,
      props?.results,
    ];

    for (const source of resultSources) {
      if (Array.isArray(source) && source.length > 0) {
        for (const r of source) {
          const event = r.event ?? r.EventName ?? r.eventName ?? r.Event;
          const mark = r.mark ?? r.Result ?? r.result ?? r.time ?? r.Time;
          if (event && mark) {
            prs.push({
              event: String(event),
              mark: String(mark),
              date: r.date ?? r.Date ?? undefined,
              meet: r.meet ?? r.Meet ?? r.meetName ?? undefined,
            });
          }
        }
        if (prs.length > 0) break;
      }
    }
  } catch {
    // ignore parse errors — fall through to HTML parsing
  }
  return prs;
}

// Fallback: parse PRs from HTML tables
function parsePRsFromHTML(root: ReturnType<typeof parse>): AthleticNetPR[] {
  const prs: AthleticNetPR[] = [];

  // athletic.net uses tables with class "histEvent" for PR history
  const tables = root.querySelectorAll('table.histEvent, table[class*="hist"], .pr-table, [class*="PR"]');

  for (const table of tables) {
    const eventHeader = table.closest('section, div')?.querySelector('h5, h4, h3, .event-name');
    const eventName = eventHeader?.text?.trim();
    const rows = table.querySelectorAll('tr');

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) continue;
      const mark = cells[0]?.text?.trim();
      const date = cells[1]?.text?.trim();
      const meet = cells[2]?.text?.trim();
      if (mark && mark !== 'Mark' && mark !== 'Time') {
        prs.push({
          event: eventName ?? 'Unknown',
          mark,
          date,
          meet,
        });
        break; // only take the PR (first/best row per event)
      }
    }
  }

  // Alternative: look for PR anchor tags (athletic.net marks PRs with class "PR")
  if (prs.length === 0) {
    const prLinks = root.querySelectorAll('a.PR, a[class~="PR"], span.PR');
    for (const el of prLinks) {
      const mark = el.text.trim();
      if (mark) {
        const row = el.closest('tr');
        const section = el.closest('section, div[class*="event"], div[class*="Event"]');
        const eventName = section?.querySelector('h5, h4, .event-name')?.text?.trim() ?? 'Unknown';
        prs.push({ event: eventName, mark });
      }
    }
  }

  return prs;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { athleteId, sport = 'track-and-field' } = req.query;

  if (!athleteId || typeof athleteId !== 'string') {
    return res.status(400).json({ error: 'Missing athleteId query parameter' });
  }

  const url = `https://www.athletic.net/athlete/${athleteId}/${sport}`;

  try {
    // Try internal API first (less Cloudflare protection)
    const apiPrs = await tryNextDataApi(athleteId, typeof sport === 'string' ? sport : 'track-and-field');
    if (apiPrs && apiPrs.length > 0) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).json({ athleteId, name: '', sport, prs: apiPrs, source: 'api' });
    }

    const response = await fetchWithBrowserHeaders(url);

    if (!response.ok) {
      return res.status(502).json({
        error: `athletic.net returned ${response.status}`,
        url,
      });
    }

    const html = await response.text();
    const root = parse(html);

    // Try Next.js embedded data first
    const nextDataScript = root.querySelector('#__NEXT_DATA__');
    let prs: AthleticNetPR[] = [];
    let athleteName = '';

    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript.text);
        prs = parsePRsFromNextData(nextData);

        // Try to get athlete name from Next.js data
        const props = nextData?.props?.pageProps ?? nextData?.props ?? {};
        athleteName =
          props?.athlete?.name ??
          props?.athlete?.fullName ??
          props?.name ??
          '';
      } catch {
        // fall through
      }
    }

    // Fallback to HTML parsing
    if (prs.length === 0) {
      prs = parsePRsFromHTML(root);
    }

    // Try to get name from HTML if not found in JSON
    if (!athleteName) {
      athleteName =
        root.querySelector('h1, .athlete-name, [class*="athleteName"]')?.text?.trim() ?? '';
    }

    // Cache for 1 hour on Vercel edge
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.status(200).json({
      athleteId,
      name: athleteName,
      sport,
      prs,
      // Pass raw Next.js data in dev so we can inspect the actual structure
      ...(process.env.NODE_ENV !== 'production' && nextDataScript
        ? { _nextDataKeys: Object.keys(JSON.parse(nextDataScript.text)?.props?.pageProps ?? {}) }
        : {}),
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to fetch from athletic.net',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}
