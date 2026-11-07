"""Import only the four supported transfers from the official MBTA GTFS feed."""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile

SOURCE = 'https://cdn.mbta.com/MBTA_GTFS.zip'
STOPS = {'70196', '70197', '70198', '70199'}

def extract_minima(rows):
    minima = {}
    for row in rows:
        stop = row['to_stop_id']
        if row['from_stop_id'] != '70075' or stop not in STOPS or row.get('from_trip_id') or row.get('to_trip_id'):
            continue
        if row['transfer_type'] != '2': raise ValueError('Transfer is no longer a published minimum')
        value = int(row['min_transfer_time'])
        if not 0 < value <= 3600: raise ValueError('Unexpected transfer allowance')
        if stop in minima and minima[stop] != value: raise ValueError('Conflicting transfer records')
        minima[stop] = value
    if set(minima) != STOPS: raise ValueError('Missing a supported transfer; refusing partial replacement')
    return minima

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='Previously downloaded official GTFS ZIP')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1]/'config/transfers.json')
    args = parser.parse_args()
    if args.archive:
        if args.archive.stat().st_size > 40_000_000: raise ValueError('Archive too large')
        raw = args.archive.read_bytes()
    else:
        with urllib.request.urlopen(SOURCE, timeout=60) as response: raw = response.read(40_000_001)
    if len(raw) > 40_000_000: raise ValueError('Archive too large')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for name in ['transfers.txt','feed_info.txt']:
            if archive.getinfo(name).file_size > 10_000_000: raise ValueError('GTFS member too large')
        rows = list(csv.DictReader(io.TextIOWrapper(archive.open('transfers.txt'),encoding='utf-8-sig')))
        feed = next(csv.DictReader(io.TextIOWrapper(archive.open('feed_info.txt'),encoding='utf-8-sig')))
        minima = extract_minima(rows)
    digest = hashlib.sha256(raw).hexdigest()
    document = {'version': 'mbta-gtfs-sha256:'+digest, 'source': SOURCE,
                'importedAt': datetime.now(timezone.utc).isoformat(), 'minima': minima,
                'feedVersion': feed['feed_version'], 'feedStartDate':feed['feed_start_date'],
                'feedEndDate':feed['feed_end_date'],
                'sourceRecords':[r for r in rows if r['from_stop_id']=='70075' and r['to_stop_id'] in STOPS]}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    temporary = args.output.with_suffix('.tmp')
    temporary.write_text(json.dumps(document,indent=2)+'\n')
    temporary.replace(args.output)
    print(f'Imported four complete transfers; source sha256={digest}')

if __name__ == '__main__': main()
