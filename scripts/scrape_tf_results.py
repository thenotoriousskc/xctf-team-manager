"""
Scrape every Track & Field result for all athletes on a team from athletic.net.
Each athlete gets the full per-result history (with date, meet, PB flag),
the per-event PRs (best mark per event), and the list of seasons.

Usage:
    python scrape_tf_results.py --team_id 1031 --year 2026 --out ../public/prs.json
    python scrape_tf_results.py --team_id 1031 --year 2026 --athlete_id 21058688

Output: JSON file keyed by athletic.net athlete ID:
{
  "26371811": {
    "name": "Jane Doe",
    "prs": [{ "event": "1600 Meters", "mark": "4:32.15", "date": "Apr 12, 2026", "meet": "..." }],
    "history": [{ "event": "1600 Meters", "mark": "4:32.15", "date": "...", "meet": "...", "is_pb": true }, ...],
    "seasons": ["2026 Outdoor", "2025 Indoor", ...]
  }
}
"""

import argparse
import json
import random
import re
import time
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from bs4 import BeautifulSoup


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


def get_team_athlete_ids(driver, team_id, year):
    """Load the school T&F roster page and return dict of {athlete_id: name}."""
    url = f'https://www.athletic.net/TrackAndField/School.aspx?SchoolID={team_id}&S={year}'
    print(f'Loading team page: {url}')
    soup = get_page(driver, url, wait_seconds=5)

    athletes = {}
    for a in soup.find_all('a', href=True):
        href = a['href']
        m = re.search(r'/athlete/(\d+)', href)
        if m:
            athlete_id = m.group(1)
            name = a.get_text(strip=True)
            # Strip 2-letter initials prefix athletic.net adds (e.g. "APAidan" -> "Aidan")
            name = re.sub(r'^[A-Z]{2}(?=[A-Z])', '', name).strip()
            if athlete_id not in athletes and name and len(name) > 1:
                athletes[athlete_id] = name

    print(f'Found {len(athletes)} athletes')
    return athletes


def get_athlete_prs(driver, athlete_id, name):
    """Load an athlete's T&F profile and return their PRs and full history."""
    url = f'https://www.athletic.net/athlete/{athlete_id}/track-and-field'
    print(f'  {name} ({athlete_id})...')
    soup = get_page(driver, url, wait_seconds=3)

    lines = [l.strip() for l in soup.get_text(separator='\n').split('\n')]
    lines = [l for l in lines if l]  # drop blank lines

    # Whitelist pattern for standard T&F event names (avoids meet names like "5th Annual XYZ Relays")
    event_name_pattern = re.compile(
        r'^\d+\s*(meters?|miles?)$'                          # 800 Meters, 1 Mile
        r'|^\d+x\d+\s*(relay|medley relay)$'                # 4x400 Relay
        r'|^\d+\s*m\s+steeplechase$'                        # 3000m Steeplechase
        r'|^\d+\s*hurdles?$'                                 # 110 Hurdles
        r'|^\d+\s*(meters?|m)\s+hurdles?$'                  # 400 Meters Hurdles
        r'|^(high|long|triple)\s+jump$'                     # High/Long/Triple Jump
        r'|^pole\s+vault$'                                   # Pole Vault
        r'|^(shot\s*put|discus|javelin|hammer|weight)\s*(throw)?$'  # Throws
        r'|^(pentathlon|heptathlon|decathlon)$'              # Multi-events
        , re.IGNORECASE
    )
    # Track times must have a colon (2:39.21) or decimal sprint (58.39, 10.45)
    # Feet-inches field marks: 5-08, 18-03.25
    # Exclude bare integers (rank numbers) and years
    mark_pattern = re.compile(
        r'^\d+:\d+[\d\.]*h?$'            # time with colon: 2:39.21, 1:04.5h
        r'|^\d{2,}\.\d+h?$'              # decimal sprint/field: 58.39, 10.45, 13.45
        r"|^\d+'\s*\d+(?:\.\d+)?\"$"     # feet-inches quote: 17' 7", 13' 4.25"
    )
    season_pattern = re.compile(r'^\d{4}\s+(outdoor|indoor)', re.IGNORECASE)
    # athletic.net dates: "Mar 24, 2026"
    date_re = re.compile(r'^[A-Z][a-z]{2} \d{1,2}, \d{4}$')
    # Lines to skip after a mark: wind, pure integer (place/rank), single letter (round/type), asterisk lines,
    # weight suffixes (- 4kg, - 1kg), no-mark (ND), foul (F as standalone)
    skip_re = re.compile(r'^[+-]?\d+\.\d+$|^NWI$|^NWS$|^ND$|^\d+$|^[A-Z]$|^\*|^-\s+\S', re.IGNORECASE)

    # Start at 'Season Records'
    try:
        start = next(i for i, l in enumerate(lines) if 'Season Records' in l)
    except StopIteration:
        start = 0
    section = lines[start:]

    # ── Phase 1: collect season labels from the Season Records summary ──────────
    seasons_seen: list[str] = []
    for line in section:
        if season_pattern.match(line):
            label = line.strip()
            if label not in seasons_seen:
                seasons_seen.append(label)

    # ── Phase 2: parse Individual Results section (has dates) ───────────────────
    # The Individual Results section begins at the first occurrence of a date line.
    # Back up to the nearest event name before that date to catch the first result.
    first_date_idx = next((i for i, l in enumerate(section) if date_re.match(l)), None)
    if first_date_idx is not None:
        indiv_start = first_date_idx
        for j in range(first_date_idx - 1, max(0, first_date_idx - 15), -1):
            if event_name_pattern.match(section[j]):
                indiv_start = j
                break
        individual_section = section[indiv_start:]
    else:
        individual_section = []

    event_history: dict[str, list[dict]] = {}  # event -> [{mark, date, meet, is_pb}]
    current_event = None
    current_result: dict | None = None
    post_mark_count = 0
    MAX_POST_MARK = 6

    for line in individual_section:
        if event_name_pattern.match(line):
            current_event = line
            current_result = None
        elif current_event and mark_pattern.match(line):
            result = {'mark': line, 'date': None, 'meet': None, 'is_pb': False}
            event_history.setdefault(current_event, []).append(result)
            current_result = result
            post_mark_count = 0
        elif line == 'PB' and current_result is not None:
            current_result['is_pb'] = True
            post_mark_count += 1
        elif current_result is not None and post_mark_count < MAX_POST_MARK:
            post_mark_count += 1
            if date_re.match(line):
                current_result['date'] = line
            elif skip_re.match(line):
                pass  # wind, place/rank integer, round letter — ignore
            elif len(line) >= 4 and current_result['meet'] is None:
                current_result['meet'] = line
            if post_mark_count >= MAX_POST_MARK:
                current_result = None

    # prs = all-time best mark per event (best = lowest time, or highest for field events)
    def mark_to_val(mark: str) -> float:
        """Convert mark to a float for comparison (always lower=better after negating field)."""
        if ':' in mark:
            parts = mark.rstrip('h').split(':')
            return float(parts[0]) * 60 + float(parts[1])
        # Feet-inches with quotes: 17' 7", 13' 4.25"
        m = re.match(r"""^(\d+)'\s*(\d+(?:\.\d+)?)"$""", mark)
        if m:
            return -(float(m.group(1)) * 12 + float(m.group(2)))
        try:
            return float(mark.rstrip('h'))
        except ValueError:
            return float('inf')

    prs = []
    for event, marks in event_history.items():
        best = min(marks, key=lambda m: mark_to_val(m['mark']))
        prs.append({'event': event, 'mark': best['mark'], 'date': best.get('date'), 'meet': best.get('meet')})

    history = [
        {'event': event, 'mark': m['mark'], 'date': m.get('date'), 'meet': m.get('meet'), 'is_pb': m['is_pb']}
        for event, marks in event_history.items()
        for m in marks
    ]

    print(f'    {len(prs)} PRs: {[(p["event"], p["mark"], p.get("date")) for p in prs]}')
    print(f'    {len(history)} total results in history')
    print(f'    Seasons: {seasons_seen}')
    return prs, history, seasons_seen


def main():
    parser = argparse.ArgumentParser(description='Scrape T&F PRs from athletic.net')
    parser.add_argument('--team_id', type=int, required=True)
    parser.add_argument('--year', type=int, default=2025)
    parser.add_argument('--out', type=str, default='prs.json')
    parser.add_argument('--athlete_id', type=str, help='Single athlete ID for testing')
    parser.add_argument('--headless', action='store_true', help='Run headless (may be blocked by Cloudflare)')
    parser.add_argument('--chrome-version', type=int, default=None, help='Pin Chrome major version (default: auto-detect)')
    args = parser.parse_args()

    driver = make_driver(headless=args.headless, version_main=args.chrome_version)
    results = {}

    try:
        if args.athlete_id:
            athletes = {args.athlete_id: 'Athlete'}
        else:
            athletes = get_team_athlete_ids(driver, args.team_id, args.year)
            if not athletes:
                print('No athletes found.')
                return

        for athlete_id, name in athletes.items():
            prs, history, seasons = get_athlete_prs(driver, athlete_id, name)
            results[athlete_id] = {'name': name, 'prs': prs, 'history': history, 'seasons': seasons}
            delay = random.uniform(5, 30)
            print(f'    Waiting {delay:.1f}s...')
            time.sleep(delay)

    finally:
        driver.quit()

    with open(args.out, 'w') as f:
        json.dump(results, f, indent=2)

    print(f'\nWrote {len(results)} athletes to {args.out}')


if __name__ == '__main__':
    main()
