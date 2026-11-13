import { useEffect } from 'react';
import AppShell from './components/AppShell';
import { useAppStore } from './store/useAppStore';

export default function App(): React.JSX.Element {
  const initialize = useAppStore((state) => state.initialize);
  const handleScanEvent = useAppStore((state) => state.handleScanEvent);
  const handleDeleteEvent = useAppStore((state) => state.handleDeleteEvent);

  useEffect(() => {
    void initialize();
    const offScan = window.api.onScanEvent(handleScanEvent);
    const offDelete = window.api.onDeleteEvent(handleDeleteEvent);
    return () => {
      offScan();
      offDelete();
    };
  }, [initialize, handleScanEvent, handleDeleteEvent]);

  return <AppShell />;
}
