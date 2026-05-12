#!/usr/bin/env python3
"""
pool-memory.json Deploy Analysis
Extracts all deploys, computes summary statistics, outputs CSV + structured report.
"""
import json, csv, sys, math
from collections import defaultdict, Counter

with open('pool-memory.json', 'r') as f:
    data = json.load(f)

# --- Extract all deploys ---
all_deploys = []
for pool_addr, pool_data in data.items():
    pool_name = pool_data.get('name', 'unknown')
    base_mint = pool_data.get('base_mint', 'unknown')
    for deploy in pool_data.get('deploys', []):
        d = dict(deploy)
        d['pool_address'] = pool_addr
        d['pool_name'] = pool_name
        d['base_mint'] = base_mint
        all_deploys.append(d)

n = len(all_deploys)

def extract_band(cr):
    if not cr: return 'unknown'
    cr = cr.lower()
    for b in ['band a', 'band b', 'band c']:
        if b in cr:
            return b[-1].upper()
    return 'unknown'

def categorize_close(cr):
    if not cr: return 'unknown'
    cr = cr.lower()
    if 'stop loss' in cr:          return 'Stop Loss'
    if 'trailing tp' in cr:        return 'Trailing TP'
    if 'harvest close' in cr:      return 'Harvest Close'
    if 'protective close' in cr:   return 'Protective Close'
    if 'oor' in cr or 'out of range' in cr: return 'OOR'
    if 'low yield' in cr:          return 'Low Yield'
    return 'Other'

def mean(lst):
    return sum(lst)/len(lst) if lst else 0

def median(lst):
    if not lst: return 0
    s = sorted(lst)
    n = len(s)
    return s[n//2] if n%2==1 else (s[n//2-1]+s[n//2])/2

def stdev(lst):
    if len(lst)<2: return 0
    m=mean(lst)
    return math.sqrt(sum((x-m)**2 for x in lst)/(len(lst)-1))

def corr(xs,ys):
    pairs=[(x,y) for x,y in zip(xs,ys) if x is not None and y is not None]
    if len(pairs)<3: return None
    mx,my=mean([p[0] for p in pairs]),mean([p[1] for p in pairs])
    num=sum((x-mx)*(y-my) for x,y in pairs)
    dx=math.sqrt(sum((x-mx)**2 for x,y in pairs))
    dy=math.sqrt(sum((y-my)**2 for x,y in pairs))
    if dx==0 or dy==0: return None
    return num/(dx*dy)

# Build rows
rows = []
for d in all_deploys:
    cr = d.get('close_reason','')
    rows.append({
        'pool_name': d['pool_name'],
        'base_mint': d['base_mint'],
        'pool_address': d['pool_address'],
        'deployed_at': d.get('deployed_at',''),
        'closed_at': d.get('closed_at',''),
        'pnl_pct': d.get('pnl_pct'),
        'pnl_usd': d.get('pnl_usd'),
        'fees_earned_usd': d.get('fees_earned_usd'),
        'fees_earned_sol': d.get('fees_earned_sol'),
        'fee_earned_pct': d.get('fee_earned_pct'),
        'range_efficiency': d.get('range_efficiency'),
        'minutes_held': d.get('minutes_held'),
        'close_reason': cr,
        'close_category': categorize_close(cr),
        'band': extract_band(cr),
        'strategy': d.get('strategy',''),
        'volatility_at_deploy': d.get('volatility_at_deploy'),
        'fee_tvl_ratio': d.get('fee_tvl_ratio'),
        'initial_fee_tvl_24h': d.get('initial_fee_tvl_24h'),
        'organic_score': d.get('organic_score'),
    })

# ===== CSV OUTPUT (stdout) =====
fields = list(rows[0].keys())
writer = csv.DictWriter(sys.stdout, fieldnames=fields)
writer.writeheader()
for r in rows: writer.writerow(r)

# ===== STATS (stderr) =====
O = sys.stderr
pnl  = [r['pnl_pct'] for r in rows if r['pnl_pct'] is not None]
fusd = [r['fees_earned_usd'] for r in rows if r['fees_earned_usd'] is not None]
fpct = [r['fee_earned_pct'] for r in rows if r['fee_earned_pct'] is not None]
mins = [r['minutes_held'] for r in rows if r['minutes_held'] is not None]
vols = [r['volatility_at_deploy'] for r in rows if r['volatility_at_deploy'] is not None]
ftvl = [r['fee_tvl_ratio'] for r in rows if r['fee_tvl_ratio'] is not None]
re_vals = [r['range_efficiency'] for r in rows if r['range_efficiency'] is not None]

wins   = sum(1 for p in pnl if p >= 0)
losses = sum(1 for p in pnl if p < 0)

print("=" * 72, file=O)
print("        POOL-MEMORY DEPLOY ANALYSIS  —  STRUCTURED SUMMARY", file=O)
print("=" * 72, file=O)

# Overall
print(f"\n═══ OVERALL ═══", file=O)
print(f"  Total deploys:        {n}", file=O)
print(f"  Total pools:          {len(data)}", file=O)
print(f"  Win rate (pnl>=0):    {wins}/{len(pnl)} = {wins/len(pnl)*100:.1f}%", file=O)
print(f"  Mean PnL%:            {mean(pnl):.4f}%", file=O)
print(f"  Median PnL%:          {median(pnl):.4f}%", file=O)
print(f"  StdDev PnL%:          {stdev(pnl):.4f}%", file=O)
print(f"  Min PnL%:             {min(pnl):.4f}%", file=O)
print(f"  Max PnL%:             {max(pnl):.4f}%", file=O)
print(f"  Mean fees USD:        ${mean(fusd):.6f}" if fusd else "  Mean fees USD:        N/A", file=O)
print(f"  Median fees USD:      ${median(fusd):.6f}" if fusd else "  Median fees USD:      N/A", file=O)
print(f"  Total fees USD:       ${sum(fusd):.4f}" if fusd else "  Total fees USD:       N/A", file=O)
print(f"  Mean fee_earned_pct:  {mean(fpct):.4f}%" if fpct else "  Mean fee_earned_pct:  N/A", file=O)
print(f"  Mean duration (min):  {mean(mins):.1f}" if mins else "  Mean duration (min):  N/A", file=O)
print(f"  Median duration (min):{median(mins):.1f}" if mins else "  Median duration (min):N/A", file=O)
print(f"  Strategy:             {set(r['strategy'] for r in rows)}", file=O)

# By Band
print(f"\n═══ BY MANAGEMENT BAND ═══", file=O)
bands = defaultdict(list)
for r in rows: bands[r['band']].append(r)
for bn in ['A','B','C','unknown']:
    if bn not in bands: continue
    dl = bands[bn]
    pp = [d['pnl_pct'] for d in dl if d['pnl_pct'] is not None]
    ff = [d['fees_earned_usd'] for d in dl if d['fees_earned_usd'] is not None]
    fp = [d['fee_earned_pct'] for d in dl if d['fee_earned_pct'] is not None]
    w  = sum(1 for p in pp if p >= 0)
    label = f"Band {bn}" if bn != 'unknown' else "Band unknown (no band in close_reason)"
    print(f"\n  {label}:", file=O)
    print(f"    Count:             {len(dl)}", file=O)
    if pp:
        print(f"    Win rate:          {w}/{len(pp)} = {w/len(pp)*100:.1f}%", file=O)
        print(f"    Mean PnL%:         {mean(pp):.4f}%", file=O)
        print(f"    Median PnL%:       {median(pp):.4f}%", file=O)
    if ff:
        print(f"    Mean fees USD:     ${mean(ff):.6f}", file=O)
        print(f"    Total fees USD:    ${sum(ff):.4f}", file=O)
    if fp:
        print(f"    Mean fee_earned%:  {mean(fp):.4f}%", file=O)

# Close Reason Distribution
print(f"\n═══ CLOSE REASON DISTRIBUTION ═══", file=O)
cats = Counter()
cat_pnl = defaultdict(list)
cat_w = defaultdict(int)
cat_n = defaultdict(int)
for r in rows:
    c = r['close_category']
    cats[c] += 1
    if r['pnl_pct'] is not None:
        cat_pnl[c].append(r['pnl_pct'])
        cat_n[c] += 1
        if r['pnl_pct'] >= 0: cat_w[c] += 1
for cat, cnt in cats.most_common():
    pp = cat_pnl.get(cat,[])
    t = cat_n.get(cat,0)
    w = cat_w.get(cat,0)
    wr = f"{w}/{t}={w/t*100:.0f}%" if t else "N/A"
    mp = f"{mean(pp):.4f}%" if pp else "N/A"
    print(f"  {cat:20s}  {cnt:3d} deploys  Win: {wr:>10s}  MeanPnL: {mp:>10s}", file=O)

# Raw close reasons
print(f"\n═══ RAW CLOSE REASONS (frequency) ═══", file=O)
raw = Counter(r['close_reason'] for r in rows)
for reason, cnt in raw.most_common():
    print(f"  [{cnt:2d}] {reason[:130]}", file=O)

# Correlations
print(f"\n═══ CORRELATIONS ═══", file=O)
pairs_ftv = [(r['fee_tvl_ratio'],r['pnl_pct']) for r in rows if r['fee_tvl_ratio'] is not None and r['pnl_pct'] is not None]
pairs_vol = [(r['volatility_at_deploy'],r['pnl_pct']) for r in rows if r['volatility_at_deploy'] is not None and r['pnl_pct'] is not None]
pairs_re  = [(r['range_efficiency'],r['pnl_pct']) for r in rows if r['range_efficiency'] is not None and r['pnl_pct'] is not None]
pairs_min = [(r['minutes_held'],r['pnl_pct']) for r in rows if r['minutes_held'] is not None and r['pnl_pct'] is not None]

def show_corr(label, pairs):
    if len(pairs) >= 3:
        c = corr([p[0] for p in pairs],[p[1] for p in pairs])
        print(f"  {label:35s}  r = {c:+.4f}  (n={len(pairs)})", file=O)
    else:
        print(f"  {label:35s}  Insufficient data (n={len(pairs)})", file=O)

show_corr("fee_tvl_ratio vs pnl_pct", pairs_ftv)
show_corr("volatility_at_deploy vs pnl_pct", pairs_vol)
show_corr("range_efficiency vs pnl_pct", pairs_re)
show_corr("minutes_held vs pnl_pct", pairs_min)

# Fee-only profitability
print(f"\n═══ FEE-ONLY PROFITABILITY ═══", file=O)
fw = sum(1 for r in rows if r['fee_earned_pct'] is not None and r['fee_earned_pct'] > 0)
ft = sum(1 for r in rows if r['fee_earned_pct'] is not None)
print(f"  Earned any fees:            {fw}/{ft} = {fw/ft*100:.1f}%", file=O)
fc = sum(1 for r in rows if r['pnl_pct'] is not None and r['fee_earned_pct'] is not None and r['pnl_pct'] < 0 and r['fee_earned_pct'] > abs(r['pnl_pct']))
tl = sum(1 for r in rows if r['pnl_pct'] is not None and r['pnl_pct'] < 0)
if tl: print(f"  Fee covers full loss:       {fc}/{tl} losers = {fc/tl*100:.1f}%", file=O)

# Duration analysis
print(f"\n═══ DURATION ANALYSIS ═══", file=O)
for bn in ['A','B','C','unknown']:
    if bn not in bands: continue
    mm = [d['minutes_held'] for d in bands[bn] if d['minutes_held'] is not None]
    if mm:
        label = f"Band {bn}" if bn != 'unknown' else "Band unknown"
        print(f"  {label:15s}  mean={mean(mm):6.1f}m  median={median(mm):6.1f}m  min={min(mm)}m  max={max(mm)}m  n={len(mm)}", file=O)

# Per-pool summary
print(f"\n═══ PER-POOL SUMMARY (top 15 by deploy count) ═══", file=O)
pools = defaultdict(lambda: {'n':0,'pnl':[],'fees':0})
for r in rows:
    pn=r['pool_name']
    pools[pn]['n']+=1
    if r['pnl_pct'] is not None: pools[pn]['pnl'].append(r['pnl_pct'])
    if r['fees_earned_usd'] is not None: pools[pn]['fees']+=r['fees_earned_usd']
print(f"  {'Pool':25s} {'Dep':>4s} {'WinRate':>10s} {'MeanPnL':>10s} {'TotFees$':>10s}", file=O)
for pn,s in sorted(pools.items(), key=lambda x:-x[1]['n'])[:15]:
    pp=s['pnl']; w=sum(1 for p in pp if p>=0); t=len(pp)
    wr=f"{w}/{t}={w/t*100:.0f}%" if t else "N/A"
    mp=f"{mean(pp):.3f}%" if t else "N/A"
    print(f"  {pn:25s} {s['n']:4d} {wr:>10s} {mp:>10s} ${s['fees']:9.4f}", file=O)

print(f"\n{'='*72}", file=O)
print(f"CSV on stdout | Stats on stderr | {n} deploys across {len(data)} pools", file=O)
print(f"{'='*72}", file=O)
