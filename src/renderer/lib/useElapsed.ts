import { useEffect, useState } from 'react';

export function useElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt, running]);

  if (startedAt === null) return 0;
  return Math.max(0, now - startedAt);
}
