import { parentPort } from 'node:worker_threads';
import { hashFile } from '../services/hashCore';
import type { HashWorkerInbound, HashWorkerOutbound } from './hashProtocols';

if (!parentPort) {
  throw new Error('哈希进程缺少父线程通信端口');
}

const port = parentPort;

function post(message: HashWorkerOutbound): void {
  port.postMessage(message);
}

port.on('message', (message: HashWorkerInbound) => {
  if (message.type !== 'hash') return;
  const { item } = message;
  void hashFile(item, { mode: item.mode })
    .then((result) => {
      post({ type: 'done', id: item.id, result });
    })
    .catch((error: unknown) => {
      post({
        type: 'failed',
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
});
