import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, List, Modal, Progress, Space, Typography } from 'antd';
import type { DeletePreview } from '@shared/types';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount } from '@shared/format';
import { useAppStore } from '../store/useAppStore';

export default function DeleteFlow(): React.JSX.Element {
  const phase = useAppStore((state) => state.deletePhase);
  const preview = useAppStore((state) => state.deletePreview);
  const progress = useAppStore((state) => state.deleteProgress);
  const result = useAppStore((state) => state.deleteResult);
  const confirmDelete = useAppStore((state) => state.confirmDelete);
  const cancelDelete = useAppStore((state) => state.cancelDelete);
  const closeDeleteResult = useAppStore((state) => state.closeDeleteResult);
  const setPage = useAppStore((state) => state.setPage);
  const pushNotice = useAppStore((state) => state.pushNotice);

  const [wholeConfirmedFor, setWholeConfirmedFor] = useState<DeletePreview | null>(null);
  const wholeConfirmed = preview !== null && wholeConfirmedFor === preview;

  const requireWholeConfirm = (preview?.groupsAllDeleted ?? 0) > 0;
  const canConfirm =
    Boolean(preview?.canDelete) && (!requireWholeConfirm || wholeConfirmed);

  const blockedMessage = useMemo(() => {
    if (!preview || preview.blockedCount === 0) return null;
    if (preview.recycleMessage) return preview.recycleMessage;
    return '部分文件超过 Windows 回收站容量上限，无法保证可还原，已暂停删除这些文件。';
  }, [preview]);

  const handleOpenRecycleBin = async (): Promise<void> => {
    try {
      const response = await window.api.openRecycleBin();
      if (!response.ok) pushNotice('error', response.error ?? '无法打开回收站');
    } catch (error) {
      pushNotice('error', error instanceof Error ? error.message : String(error));
    }
  };

  const progressPercent =
    progress && progress.total > 0
      ? Math.min(100, Math.floor((progress.processed / progress.total) * 100))
      : 0;

  const resultTitle = result?.stopped
    ? '已停止删除'
    : result && result.succeeded > 0
      ? result.quarantined > 0
        ? '删除完成'
        : '已移到回收站'
      : '删除未完成';

  const openLongTrash = (): void => {
    closeDeleteResult();
    setPage('settings');
  };

  return (
    <>
      <Modal
        open={phase === 'preview'}
        title={COPY.deleteConfirmTitle}
        okText={COPY.deleteAction}
        cancelText={COPY.cancelAction}
        okButtonProps={{ danger: true, disabled: !canConfirm }}
        cancelButtonProps={{ autoFocus: true }}
        onOk={() => void confirmDelete()}
        onCancel={closeDeleteResult}
        maskClosable={false}
        destroyOnHidden
      >
        {preview ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {preview.okCount > 0 ? (
              <Typography.Text>
                将把 <strong>{formatCount(preview.okCount)}</strong> 个文件（共{' '}
                <strong>{formatBytes(preview.okBytes)}</strong>）移到 Windows 回收站，可在回收站还原。
                清空回收站后才会释放空间。
              </Typography.Text>
            ) : null}
            {preview.longPathCount > 0 ? (
              <Typography.Text>
                将把 <strong>{formatCount(preview.longPathCount)}</strong> 个长路径文件（共{' '}
                <strong>{formatBytes(preview.longPathBytes)}</strong>）移入软件回收区，可在
                “设置 → 长路径回收区”还原。
              </Typography.Text>
            ) : null}
            {preview.longPathCount > 0 ? (
              <Alert
                type="info"
                showIcon
                message="Windows 回收站不支持超过 260 字符的路径"
                description="这些文件会移动到所在硬盘的软件回收区，不会被永久删除，也不会出现在 Windows 回收站中。"
              />
            ) : null}
            {preview.previewNames.length > 0 ? (
              <List
                size="small"
                bordered
                dataSource={preview.previewNames}
                renderItem={(name) => (
                  <List.Item className="delete-preview-name">{name}</List.Item>
                )}
              />
            ) : null}
            {preview.missingCount > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`${formatCount(preview.missingCount)} 个文件已不存在，将跳过`}
                description="这些文件可能已被移动或删除，索引会在重新扫描后更新。"
              />
            ) : null}
            {blockedMessage ? (
              <Alert type="warning" showIcon message={blockedMessage} />
            ) : null}
            {requireWholeConfirm ? (
              <Alert
                type="error"
                showIcon
                message={`${preview.groupsAllDeleted} 个重复组的所有副本都在待删列表中`}
                description={
                  <Checkbox
                    checked={wholeConfirmed}
                    onChange={(event) =>
                      setWholeConfirmedFor(event.target.checked ? preview : null)
                    }
                  >
                    我确认这些文件都不需要保留
                  </Checkbox>
                }
              />
            ) : null}
            {!preview.canDelete ? (
              <Alert type="info" showIcon message="当前没有可以安全移到回收站的文件" />
            ) : null}
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={phase === 'running'}
        title="正在移到回收站"
        footer={
          <Button onClick={() => void cancelDelete()} disabled={!progress || progress.status !== 'running'}>
            停止
          </Button>
        }
        closable={false}
        maskClosable={false}
        keyboard={false}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Progress percent={progressPercent} status="active" />
          <Typography.Text>
            已处理 {formatCount(progress?.processed ?? 0)} / {formatCount(progress?.total ?? 0)} 个文件，
            成功 {formatCount(progress?.succeeded ?? 0)} 个
            {progress && progress.quarantined > 0
              ? `（其中 ${formatCount(progress.quarantined)} 个移入长路径回收区）`
              : ''}
            {progress && progress.failed > 0 ? `，失败 ${formatCount(progress.failed)} 个` : ''}
          </Typography.Text>
          <Typography.Text type="secondary" className="selectable-text" ellipsis>
            {progress?.currentPath || '准备中…'}
          </Typography.Text>
          <Typography.Text type="secondary">
            文件会先进入 Windows 回收站，清空回收站后才会释放磁盘空间。
          </Typography.Text>
        </Space>
      </Modal>

      <Modal
        open={phase === 'result' && result !== null}
        title={resultTitle}
        onCancel={closeDeleteResult}
        footer={[
          result && result.quarantined > 0 ? (
            <Button key="long-trash" onClick={openLongTrash}>
              长路径回收区
            </Button>
          ) : null,
          <Button key="recycle" onClick={() => void handleOpenRecycleBin()}>
            打开回收站
          </Button>,
          <Button key="close" type="primary" onClick={closeDeleteResult}>
            关闭
          </Button>,
        ]}
        maskClosable={false}
      >
        {result ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text>
              {result.succeeded - result.quarantined > 0 ? (
                <>
                  已移到回收站{' '}
                  <strong>{formatCount(result.succeeded - result.quarantined)}</strong> 个文件（
                  <strong>{formatBytes(result.bytes - result.quarantineBytes)}</strong>）
                </>
              ) : null}
              {result.quarantined > 0 ? (
                <>
                  {result.succeeded - result.quarantined > 0 ? '，另有 ' : '已将 '}
                  <strong>{formatCount(result.quarantined)}</strong> 个长路径文件（
                  <strong>{formatBytes(result.quarantineBytes)}</strong>）移入软件回收区
                </>
              ) : null}
              {result.failed > 0 ? `，${formatCount(result.failed)} 个失败` : ''}
              {result.stopped ? '。已按你的要求停止后续文件。' : '。'}
            </Typography.Text>
            {result.succeeded - result.quarantined > 0 ? (
              <Alert
                type="info"
                showIcon
                message="清空回收站后才会释放磁盘空间"
                description="文件现在仍在回收站中，可在回收站还原。"
              />
            ) : null}
            {result.quarantined > 0 ? (
              <Alert
                type="info"
                showIcon
                message="长路径文件已移入软件回收区"
                description="可在“设置 → 长路径回收区”还原，文件不会被永久删除。"
              />
            ) : null}
            {result.failures.length > 0 ? (
              <Alert
                type="error"
                showIcon
                message={`${formatCount(result.failed)} 个文件没有删除`}
                description={
                  <ul className="delete-failure-list">
                    {result.failures.slice(0, 5).map((failure, index) => (
                      <li key={`${failure.fileId}-${index}`}>
                        {failure.name || failure.path || failure.fileId}：{failure.reason}
                      </li>
                    ))}
                    {result.failures.length > 5 ? (
                      <li>另有 {formatCount(result.failures.length - 5)} 个失败项</li>
                    ) : null}
                  </ul>
                }
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </>
  );
}
