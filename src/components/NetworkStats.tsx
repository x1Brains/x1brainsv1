import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { fmtNum } from '../utils/v2format';

type Stat = { label: string; value: string; up?: boolean };

export default function NetworkStats() {
  const { connection } = useConnection();
  const [slot, setSlot] = useState<number | null>(null);
  const [tps, setTps]   = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval>;

    const load = async () => {
      try {
        const [s, perf] = await Promise.all([
          connection.getSlot(),
          connection.getRecentPerformanceSamples(1).catch(() => []),
        ]);
        if (!alive) return;
        setSlot(s);
        const sample = perf?.[0];
        if (sample && sample.samplePeriodSecs > 0) {
          setTps(sample.numTransactions / sample.samplePeriodSecs);
        }
      } catch { /* keep last good values */ }
    };

    load();
    timer = setInterval(load, 6_000);
    return () => { alive = false; clearInterval(timer); };
  }, [connection]);

  const stats: Stat[] = [
    { label: 'CHAIN', value: 'X1 SVM' },
    { label: 'SLOT',  value: slot != null ? slot.toLocaleString() : '…' },
    { label: 'TPS',   value: tps  != null ? fmtNum(tps, 0) : '…', up: tps != null && tps > 0 },
    { label: 'AGENT', value: 'X1B v1' },
  ];

  return (
    <div className="info-card">
      <div className="title">Network</div>
      <div className="network-grid">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="label">{s.label}</div>
            <div className={`value${s.up ? ' up' : ''}`}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
