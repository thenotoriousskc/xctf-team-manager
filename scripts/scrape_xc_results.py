"""
Scrape the entire Cross Country history for a team from athletic.net.

Enumerates every athlete who ever ran for the team (by walking each season's
school XC page), then scrapes each athlete's full XC history — per-result
history (date, meet, PB flag), per-event PRs (best time per event), and the
list of seasons. Writes a JSON file and (optionally) upserts into Supabase.

Usage:
    # full team history -> JSON (logged in, so per-meet times unlock for all seasons)
    python scrape_xc_results.py --team_id 1031 --login --out ../public/xc-results.json

    # also push to Supabase
    python scrape_xc_results.py --team_id 1031 --login --supabase

    # tune the parser against one athlete (prints the raw profile text)
    python scrape_xc_results.py --athlete_id 21058688 --dump

Env (put in .env.local, then `set -a; source ../.env.local; set +a`):
    ATHLETICNET_EMAIL, ATHLETICNET_PASSWORD   # --login auto-fills the form
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   # --supabase upsert (service role)
    # Without the athletic.net creds, --login prompts for a manual browser login.

NOTE: athletic.net gates per-meet result TIMES behind a free login (logged out,
the Individual Results show "22:22.2" placeholders). So we parse the "Season
Records" block instead — the athlete's best time per event per season, which is
real and exactly what leaderboards need.

Output JSON, keyed by athletic.net athlete ID:
{
  "26371811": {
    "name": "Jane Doe",
    "prs": [{ "event": "5000 Meters", "mark": "18:42.3", "season": "2025" }],
    "history": [{ "event": "5000 Meters", "season": "2025", "grade": 12, "mark": "18:42.3", "is_pb": true }, ...],
    "seasons": ["2025", "2024", ...]
  }
}
"""

import argparse
import datetime
import json
import os
import random
import re
import time
import undetected_chromedriver as uc
from bs4 import BeautifulSoup, NavigableString
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

try:
    import requests
except ImportError:
    requests = None


def load_env_local():
    """Load KEY=VALUE pairs from the project's .env.local into os.environ so the
    script works without `source ../.env.local`. Existing env vars win. Strips
    surrounding quotes (the password is single-quoted because of shell chars)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env.local')
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            key, val = key.strip(), val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            os.environ.setdefault(key, val)


def make_driver(headless=False, version_main=None):
    options = uc.ChromeOptions()
    if headless:
        options.add_argument('--headless=new')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    # Don't hard-pin the Chrome major version — let undetected_chromedriver match
    # whatever Chrome is installed (Chrome auto-updates; pinning breaks on every
    # bump). Pass --chrome-version only if auto-detection ever misfires.
    kwargs = {'version_main': version_main} if version_main else {}
    return uc.Chrome(options=options, **kwargs)


def get_page(driver, url, wait_seconds=4):
    driver.get(url)
    time.sleep(wait_seconds)
    return BeautifulSoup(driver.page_source, 'html.parser')


def clean_name(name: str) -> str:
    # Strip the 2-letter initials prefix athletic.net adds (e.g. "APAidan" -> "Aidan")
    return re.sub(r'^[A-Z]{2}(?=[A-Z])', '', name).strip()


def _manual_login_prompt():
    print('\n' + '=' * 64)
    print('  Log in to athletic.net in the Chrome window that just opened.')
    print('  Once you see you are signed in, come back here and press Enter.')
    print('=' * 64)
    input('  Press Enter when logged in... ')


def login(driver):
    """Sign in to athletic.net so per-meet times unlock for all past seasons.

    Uses ATHLETICNET_EMAIL / ATHLETICNET_PASSWORD from the environment to fill
    the form automatically (unattended). If those aren't set, or the form can't
    be auto-filled, falls back to a manual login prompt."""
    driver.get('https://www.athletic.net/account/login')
    time.sleep(3)

    email = os.environ.get('ATHLETICNET_EMAIL')
    password = os.environ.get('ATHLETICNET_PASSWORD')
    if not (email and password):
        print('ATHLETICNET_EMAIL / ATHLETICNET_PASSWORD not set — manual login.')
        _manual_login_prompt()
        return

    def find_first(selectors):
        for sel in selectors:
            els = driver.find_elements(By.CSS_SELECTOR, sel)
            if els:
                return els[0]
        return None

    try:
        wait = WebDriverWait(driver, 20)
        wait.until(EC.presence_of_element_located(
            (By.CSS_SELECTOR, 'input[type="email"], input[type="text"], input[type="password"]')))
        email_el = find_first(['input[type="email"]', 'input[name="username"]',
                               'input[name="Email"]', 'input#Email', 'input#email', 'input[type="text"]'])
        pwd_el = find_first(['input[type="password"]', 'input[name="password"]', 'input#password'])
        if not email_el or not pwd_el:
            raise RuntimeError('login form fields not found')
        email_el.clear(); email_el.send_keys(email)
        pwd_el.clear(); pwd_el.send_keys(password)
        pwd_el.send_keys(Keys.RETURN)
        time.sleep(6)
        print('Submitted athletic.net login (env credentials).')
    except Exception as e:
        print(f'Auto-login failed ({e}); falling back to manual login.')
        _manual_login_prompt()


GENDER_HEADER_RE = re.compile(r'^(boys|girls|men|women)\b', re.IGNORECASE)


def extract_roster(soup) -> dict[str, dict]:
    """athlete_id -> {name, gender} from /athlete/<id> links on a team season page.

    Walks the page in document order, tracking the most recent Boys/Girls (or
    Men/Women) section header so each athlete inherits the gender of its section.
    The team page lists boys then girls, each under such a header."""
    out: dict[str, dict] = {}
    current = None
    for node in soup.descendants:
        if isinstance(node, NavigableString):
            t = node.strip()
            if t and len(t) <= 20 and GENDER_HEADER_RE.match(t):
                current = 'M' if t.lower().startswith(('boys', 'men')) else 'F'
            continue
        if getattr(node, 'name', None) == 'a':
            m = re.search(r'/athlete/(\d+)', node.get('href', ''))
            if not m:
                continue
            athlete_id = m.group(1)
            name = clean_name(node.get_text(strip=True))
            if athlete_id not in out and name and len(name) > 1:
                out[athlete_id] = {'name': name, 'gender': current}
    return out


def team_season_url(team_id, year) -> str:
    # Modern season-specific route. The legacy CrossCountry/School.aspx?...&S=year
    # ignores the season param (redirects to the SPA showing the CURRENT roster),
    # which is why prior years returned today's athletes only.
    return f'https://www.athletic.net/team/{team_id}/cross-country/{year}'


def get_team_athlete_ids(driver, team_id, start_year, end_year):
    """Walk every season's team page and union all athlete IDs ever seen.

    Stops early after MAX_EMPTY consecutive seasons with zero athletes (walked
    back past the team's first season on athletic.net)."""
    athletes: dict[str, dict] = {}
    team_school = None
    empty_streak = 0
    MAX_EMPTY = 3
    for year in range(end_year, start_year - 1, -1):
        url = team_season_url(team_id, year)
        print(f'Loading {year}: {url}')
        soup = get_page(driver, url, wait_seconds=6)

        # School name from the page title ("Bay School of San Francisco - High
        # School Cross Country 2025") — used to drop transfers' other-school times.
        if team_school is None and soup.title and soup.title.text:
            team_school = soup.title.text.split(' - ')[0].strip() or None

        roster = extract_roster(soup)
        found = sum(1 for aid in roster if aid not in athletes)
        for aid, info in roster.items():
            if aid in athletes:
                # Backfill gender if an earlier season didn't have a section header.
                if not athletes[aid].get('gender') and info.get('gender'):
                    athletes[aid]['gender'] = info['gender']
            else:
                athletes[aid] = info

        print(f'  {year}: {len(roster)} on page, +{found} new (total {len(athletes)})')
        empty_streak = empty_streak + 1 if not roster else 0
        if empty_streak >= MAX_EMPTY and athletes:
            print(f'  {MAX_EMPTY} empty seasons in a row — stopping at {year}.')
            break
        time.sleep(random.uniform(6, 16))

    print(f'Found {len(athletes)} athletes across {start_year}-{end_year}; team school: {team_school}')
    return athletes, team_school


# ── XC profile parsing ──────────────────────────────────────────────────────
# We parse the "Individual Results" section — every race with place, time, date,
# meet, and heat — which requires being LOGGED IN (logged out, athletic.net masks
# times for past seasons as "22:22.2"; run with --login). The section is grouped
# into season blocks; each block header carries the year and grade. The number
# of lines between the year and the grade VARIES (some athletes have an extra
# count line), so we find the "Nth Grade" line within a small window, not a
# fixed offset:
#     <year>                  "2025"
#     <school name>           "Bay School of San Francisco"
#     "HS"
#     ["15"]                  optional extra line (results count) on some athletes
#     "<n>th Grade"           "12th Grade" / "10th Grade"
# then, per event, one or more results:
#     <event>                 "3200 Meters" / "3 Miles" / "2.95 Miles"
#     <place>                 "11"
#     <mark>                  "9:41.8"
#     [PB|SB|*]               optional flags
#     <date>                  "Oct 18"  (no year — taken from the block)
#     <meet>                  "Grizzly 3200"
#     [(heat/division)]       optional, parenthesized
EVENT_NAME_RE = re.compile(
    r'^\d{1,2},?\d{3}\s*meters?$'        # 5,000 Meters / 5000 Meters / 3,200 Meters
    r'|^\d+\s*k$'                        # 5k, 4k, 3k
    r'|^\d+(?:\.\d+)?\s*miles?$'         # 3 Miles, 2.95 Miles, 1 Mile
    r'|^\d{3,4}\s*meters?$',             # 800 Meters, 1600 Meters (rare in XC)
    re.IGNORECASE,
)
MARK_RE = re.compile(r'^\d{1,3}:\d{2}(?:\.\d+)?$')   # 9:41.8, 16:04.7, 1:02:11
YEAR_RE = re.compile(r'^\d{4}$')
PLACE_RE = re.compile(r'^\d{1,4}$')
FLAG_RE = re.compile(r'^(PB|SB|\*)$')
DATE_MD_RE = re.compile(r'^[A-Z][a-z]{2} \d{1,2}$')          # "Oct 18"
HEAT_RE = re.compile(r'^\(.*\)$')
GRADE_LINE_RE = re.compile(r'^(\d+)(?:st|nd|rd|th) Grade$')   # "12th Grade"


def mark_to_secs(mark: str) -> float:
    """Clock time -> seconds (lower is better). inf if unparseable."""
    try:
        parts = [float(p) for p in mark.split(':')]
    except ValueError:
        return float('inf')
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def normalize_event(name: str) -> str:
    # "3,200 Meters" -> "3200 Meters"; collapse whitespace.
    return re.sub(r'\s+', ' ', name.replace(',', '')).strip()


def to_iso_date(month_day: str | None, year: str | None) -> str | None:
    if not month_day or not year:
        return None
    try:
        return datetime.datetime.strptime(f'{month_day} {year}', '%b %d %Y').strftime('%Y-%m-%d')
    except ValueError:
        return None


def _season_header(section, i):
    """If section[i] starts an Individual-Results season block, return
    (year, school, grade, content_start_index); else None.

    A block is a YEAR line, then the school name, then (within a few lines) an
    "Nth Grade" line. (Season Records also has year+grade sequences, but uses a
    bare grade NUMBER like "10", not "10th Grade", so this only matches
    Individual Results.) The grade line's position varies (some athletes have an
    extra count line), so search a small window. The school name is the line
    right after the year — needed to drop transfers' other-school results."""
    if not YEAR_RE.match(section[i]):
        return None
    for k in range(i + 2, min(i + 6, len(section))):
        m = GRADE_LINE_RE.match(section[k])
        if m:
            school = section[i + 1] if i + 1 < len(section) else ''
            return section[i], school, int(m.group(1)), k + 1
    return None


def _norm_school(s: str) -> str:
    return re.sub(r'\s+', ' ', (s or '').strip().lower())


def parse_athlete_profile(soup, team_school: str | None = None) -> tuple[list[dict], list[dict], list[str]]:
    lines = [l.strip() for l in soup.get_text(separator='\n').split('\n')]
    lines = [l for l in lines if l]

    # Individual Results begins at the first season-block header.
    start = next((i for i in range(len(lines)) if _season_header(lines, i)), None)
    if start is None:
        return [], [], []
    section = lines[start:]
    n = len(section)

    results: list[dict] = []   # per race
    seasons_seen: list[str] = []
    year = grade = school = current_event = None
    i = 0

    def is_result_start(k):
        return (current_event and PLACE_RE.match(section[k])
                and k + 1 < n and MARK_RE.match(section[k + 1]))

    while i < n:
        line = section[i]
        hdr = _season_header(section, i)
        if hdr:
            year, school, grade, content_start = hdr
            if year not in seasons_seen:
                seasons_seen.append(year)
            current_event = None
            i = content_start   # jump past the (variable-length) header to the events
            continue
        if EVENT_NAME_RE.match(line):
            current_event = normalize_event(line)
            i += 1
            continue
        if is_result_start(i):
            place, mark = int(section[i]), section[i + 1]
            is_pb = False
            date_md = meet = heat = None
            j = i + 2
            while j < n:
                s = section[j]
                if FLAG_RE.match(s):
                    if s == 'PB':
                        is_pb = True
                    j += 1
                elif DATE_MD_RE.match(s):
                    date_md = s
                    j += 1
                elif HEAT_RE.match(s):
                    heat = s
                    j += 1
                elif EVENT_NAME_RE.match(s) or _season_header(section, j) or is_result_start(j):
                    break                       # next race / event / season
                elif meet is None and len(s) >= 3:
                    meet = s
                    j += 1
                else:
                    break
            results.append({
                'event': current_event, 'season': year, 'grade': grade, 'place': place,
                'mark': mark, 'date': date_md, 'race_date': to_iso_date(date_md, year),
                'meet': meet, 'heat': heat, 'is_pb': is_pb, 'school': school,
            })
            i = j
            continue
        i += 1

    # Drop results from other schools (transfers' profiles list every school
    # they ran for; we only want their time as a team athlete).
    if team_school:
        ts = _norm_school(team_school)
        results = [r for r in results if _norm_school(r.get('school', '')) == ts]
        seasons_seen = sorted({r['season'] for r in results}, reverse=True)

    # PR = best (lowest seconds) per event across all races.
    by_event: dict[str, list[dict]] = {}
    for r in results:
        by_event.setdefault(r['event'], []).append(r)
    prs = []
    for e, rs in by_event.items():
        best = min(rs, key=lambda r: mark_to_secs(r['mark']))
        prs.append({'event': e, 'mark': best['mark'], 'date': best.get('date'),
                    'season': best.get('season'), 'meet': best.get('meet')})

    seasons_seen.sort(reverse=True)
    return prs, results, seasons_seen


def get_athlete_xc(driver, athlete_id, name, team_school=None, dump=False):
    url = f'https://www.athletic.net/athlete/{athlete_id}/cross-country'
    print(f'  {name} ({athlete_id})...')
    soup = get_page(driver, url, wait_seconds=3)

    if dump:
        lines = [l.strip() for l in soup.get_text(separator='\n').split('\n') if l.strip()]
        print('\n'.join(f'{i:3} | {l}' for i, l in enumerate(lines)))
        return name, [], [], []

    # Canonical name from the profile title ("Leor Hersh - CA Cross Country Bio").
    profile_name = ''
    if soup.title and soup.title.text:
        profile_name = soup.title.text.split(' - ')[0].strip()
    resolved = profile_name or name

    prs, history, seasons = parse_athlete_profile(soup, team_school=team_school)
    print(f'    {resolved}: {len(prs)} PRs, {len(history)} results, seasons={seasons}')
    return resolved, prs, history, seasons


# ── Supabase upsert ──────────────────────────────────────────────────────────
def slug(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', (s or '').lower()).strip('-')


def push_to_supabase(results: dict):
    if requests is None:
        print('SKIP supabase: `requests` not installed (pip install requests)')
        return
    url = os.environ.get('SUPABASE_URL')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    if not url or not key:
        print('SKIP supabase: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
        return

    rows = []
    for athlete_id, data in results.items():
        name = data.get('name', '')
        gender = data.get('gender')
        for h in data.get('history', []):  # one row per race
            secs = mark_to_secs(h['mark'])
            rows.append({
                # deterministic key -> re-runs upsert in place, no duplicates
                'result_key': f"{athlete_id}:{slug(h['event'])}:{h.get('race_date') or h['season']}:{h['mark']}:{h.get('place', '')}",
                'athlete_id': athlete_id,
                'athlete_name': name,
                'gender': gender,
                'event': h['event'],
                'mark': h['mark'],
                'mark_seconds': None if secs == float('inf') else round(secs, 2),
                'season': h['season'],
                'grade': h.get('grade'),
                'place': h.get('place'),
                'date': h.get('date'),
                'race_date': h.get('race_date'),
                'meet': h.get('meet'),
                'heat': h.get('heat'),
                'school': h.get('school'),
                'is_pb': bool(h.get('is_pb')),
            })

    if not rows:
        print('No rows to push to Supabase.')
        return

    headers = {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
    }
    pushed = 0
    for i in range(0, len(rows), 500):
        batch = rows[i:i + 500]
        r = requests.post(f'{url}/rest/v1/xc_results', headers=headers, data=json.dumps(batch))
        if not r.ok:
            print(f'  Supabase batch {i} failed {r.status_code}: {r.text[:300]}')
            break
        pushed += len(batch)
    print(f'Upserted {pushed}/{len(rows)} rows into xc_results')


def main():
    load_env_local()
    parser = argparse.ArgumentParser(description='Scrape full XC team history from athletic.net')
    parser.add_argument('--team_id', type=int, help='athletic.net SchoolID')
    parser.add_argument('--start_year', type=int, default=2004)
    parser.add_argument('--end_year', type=int, default=datetime.datetime.now().year)
    parser.add_argument('--out', type=str, default='xc-results.json')
    parser.add_argument('--athlete_id', type=str, help='Single athlete ID (testing)')
    parser.add_argument('--dump', action='store_true', help='Print raw profile text for the athlete and exit (parser tuning)')
    parser.add_argument('--dump_team', type=int, metavar='YEAR', help='Load one season team page and print the roster found, then exit (verify season URL)')
    parser.add_argument('--limit', type=int, help='Cap number of athletes (testing)')
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--chrome-version', type=int, default=None, help='Pin Chrome major version (default: auto-detect)')
    parser.add_argument('--login', action='store_true', help='Log in to athletic.net first (unlocks per-meet times for all past seasons). Uses ATHLETICNET_EMAIL/PASSWORD, else prompts for manual login.')
    parser.add_argument('--supabase', action='store_true', help='Also upsert results into the xc_results table')
    parser.add_argument('--school', type=str, default=None, help='Only keep results for this school name (default: auto-detected from team page; drops transfers\' other-school times)')
    args = parser.parse_args()

    if not args.team_id and not args.athlete_id:
        parser.error('provide --team_id (full team) or --athlete_id (single)')
    have_creds = bool(os.environ.get('ATHLETICNET_EMAIL') and os.environ.get('ATHLETICNET_PASSWORD'))
    if args.login and args.headless and not have_creds:
        parser.error('manual login needs a visible browser; set ATHLETICNET_EMAIL/PASSWORD or drop --headless')

    driver = make_driver(headless=args.headless, version_main=args.chrome_version)
    results = {}

    try:
        if args.login:
            login(driver)

        if args.dump_team:
            url = team_season_url(args.team_id, args.dump_team)
            print(f'Loading {url}')
            soup = get_page(driver, url, wait_seconds=6)
            roster = extract_roster(soup)
            print(f'{args.dump_team}: {len(roster)} athletes on this season page:')
            for aid, info in roster.items():
                print(f'  {aid}  [{info.get("gender") or "?"}]  {info["name"]}')
            # Page text too — so we can see how boys/girls are delineated.
            print('\n----- PAGE TEXT -----')
            lines = [l.strip() for l in soup.get_text(separator='\n').split('\n') if l.strip()]
            print('\n'.join(f'{i:3} | {l}' for i, l in enumerate(lines)))
            return

        team_school = args.school
        if args.athlete_id:
            athletes = {args.athlete_id: {'name': 'Athlete', 'gender': None}}
        else:
            athletes, detected_school = get_team_athlete_ids(driver, args.team_id, args.start_year, args.end_year)
            team_school = args.school or detected_school
            if not athletes:
                print('No athletes found.')
                return
            if args.limit:
                athletes = dict(list(athletes.items())[:args.limit])

        for athlete_id, info in athletes.items():
            resolved, prs, history, seasons = get_athlete_xc(driver, athlete_id, info['name'], team_school=team_school, dump=args.dump)
            if args.dump:
                return
            results[athlete_id] = {'name': resolved, 'gender': info.get('gender'),
                                   'prs': prs, 'history': history, 'seasons': seasons}
            delay = random.uniform(10, 60)
            print(f'    Waiting {delay:.1f}s...')
            time.sleep(delay)
    finally:
        driver.quit()

    with open(args.out, 'w') as f:
        json.dump(results, f, indent=2)
    print(f'\nWrote {len(results)} athletes to {args.out}')

    if args.supabase:
        push_to_supabase(results)


if __name__ == '__main__':
    main()
