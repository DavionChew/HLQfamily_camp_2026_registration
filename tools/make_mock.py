#!/usr/bin/env python3
"""Generate a realistic-scale MOCK attendee import (~280 people) for load/scale testing.
Families share a RoomGroup; ~half take the bus; a handful are Organisers/Leaders.
Run:  python3 make_mock.py            ->  ../samples/mock_280_import.xlsx
Paste columns A:L into a TEST copy of the Sheet's Attendees tab, then run the load test.
IDs are C001..C280 with random tokens (the load test sends just the IDs).
"""
import random
from openpyxl import Workbook

random.seed(42)
PROFILE = ['ID','Token','Name','Phone','Emergency','Role','Group','CampGroup','BusTo','BusBack','RoomGroup','Room','RoomNote','Notes']
ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
GROUPS = ['青年组', '弟兄组', '姐妹组', '夫妻组', '长青组', '少年组']
N = 280

def token(): return ''.join(random.choice(ALPHA) for _ in range(4))

rows = []
i = 1; room = 1
while i <= N:
    fam = random.choice([1, 2, 2, 3, 4, 4])          # family/room size
    fam = min(fam, N - i + 1)
    rg = 'R%03d' % room; room += 1
    grp = random.choice(GROUPS)
    bus_to = 'Y' if random.random() < 0.5 else 'N'
    bus_back = 'Y' if random.random() < 0.45 else 'N'
    for _ in range(fam):
        rid = 'C%03d' % i
        role = 'Attendee'
        if i <= 18: role = 'Organiser'
        elif i <= 36: role = 'Leader'
        rows.append([rid, token(), 'Tester %03d' % i, '01%08d' % (10000000 + i),
                     '紧急 09%07d' % i, role, grp, '', bus_to, bus_back, rg, '', '', ''])
        i += 1

wb = Workbook(); ws = wb.active; ws.title = 'Attendees'
ws.append(PROFILE)
for r in rows: ws.append(r)
wb.save('../samples/mock_280_import.xlsx')
print('Wrote ../samples/mock_280_import.xlsx  ·  people=%d  rooms=%d' % (len(rows), room - 1))
bi, ri = PROFILE.index('BusTo'), PROFILE.index('Role')
print('Bus-to=%d  Organisers/Leaders=%d' % (sum(1 for r in rows if r[bi]=='Y'), sum(1 for r in rows if r[ri]!='Attendee')))
