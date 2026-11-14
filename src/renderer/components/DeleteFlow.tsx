import { useMemo } from 'react';
import { Alert, Button, List, Modal, Progress, Space, Typography } from 'antd';
import { COPY } from '@shared/copy';
import { formatBytes, formatCount } from '@shared/format';
import { useAppStore } from '../store/useAppStore';
import { useBackClose } from '../lib/back';

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

  useBackClose(phase === 'preview', closeDeleteResult);
  useBackClose(phase === 'result', closeDeleteResult);

  const canConfirm = Boolean(preview?.canDelete);

  const blockedMessage = useMemo(() => {
    if (!preview || preview.blockedCount === 0) return null;
    return (
      preview.recycleMessage ??
      preview.blockedMessage ??
      '部分项目超过 Windows 回收站容量上限或无法安全删除，已暂停删除这些项目。'
    );
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

  const foldersSucceeded = result?.foldersSucceeded ?? 0;
  const folderFileCount = result?.folderFileCount ?? 0;
  const folderBytes = result?.folderBytes ?? 0;
  const filesRecycled = result
    ? Math.max(0, result.succeeded - result.foldersSucceeded - result.quarantined)
    : 0;
  const filesRecycledBytes = result
    ? Math.max(0, result.bytes - result.folderBytes - result.quarantineBytes)
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
            {preview.folderOkCount > 0 ? (
              <Typography.Text>
                将删除 <strong>{formatCount(preview.folderOkCount)}</strong> 个文件夹（其中已索引{' '}
                <strong>{formatCount(preview.folderOkFileCount)}</strong> 个文件、{' '}
                <strong>{formatBytes(preview.folderOkBytes)}</strong>
                ），文件夹会连同其中未被软件索引的文件一起移到 Windows 回收站。
              </Typography.Text>
            ) : null}
            {preview.okCount > 0 ? (
              <Typography.Text>
                {preview.folderOkCount > 0 ? '另将 ' : '将把 '}
                <strong>{formatCount(preview.okCount)}</strong> 个文件（共{' '}
                <strong>{formatBytes(preview.okBytes)}</strong>）移到 Windows 回收站。
              </Typography.Text>
            ) : null}
            {preview.folderOkCount > 0 || preview.okCount > 0 ? (
              <Alert
                type="info"
                showIcon
                message="全部移到 Windows 回收站，可在回收站还原"
                description="清空回收站后才会释放磁盘空间。"
              />
            ) : null}
            {preview.longPathCount > 0 ? (
              <Typography.Text>
                将把 <strong>{formatCount(preview.longPathCount)}</strong> 个长路径文件（共{' '}
                <strong>{formatBytes(preview.longPathBytes)}</strong>）移入软件回收区，可在 “设置 →
                长路径回收区”还原。
              </Typography.Text>
            ) : null}
            {preview.folderOkCount > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="删除文件夹会连同其中未被软件索引的文件一起移走"
                description="回收站中可还原整个文件夹，但仍请在确认前核对文件夹内容。"
              />
            ) : null}
            {preview.folderNames.length > 0 ? (
              <div>
                <Typography.Text strong>
                  文件夹（前 {preview.folderNames.length} 个）：
                </Typography.Text>
                <List
                  size="small"
                  bordered
                  dataSource={preview.folderNames}
                  renderItem={(name) => (
                    <List.Item className="delete-preview-name">{name}</List.Item>
                  )}
                />
              </div>
            ) : null}
            {preview.fileNames.length > 0 ? (
              <div>
                <Typography.Text strong>文件（前 {preview.fileNames.length} 个）：</Typography.Text>
                <List
                  size="small"
                  bordered
                  dataSource={preview.fileNames}
                  renderItem={(name) => (
                    <List.Item className="delete-preview-name">{name}</List.Item>
                  )}
                />
              </div>
            ) : null}
            {preview.longPathCount > 0 ? (
              <Alert
                type="info"
                showIcon
                message="Windows 回收站不支持超过 260 字符的路径"
                description="这些文件会移动到所在硬盘的软件回收区，不会被永久删除，也不会出现在 Windows 回收站中。"
              />
            ) : null}
            {preview.missingCount > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`${formatCount(preview.missingCount)} 个项目已不存在，将跳过`}
                description="这些项目可能已被移动或删除，索引会在重新扫描后更新。"
              />
            ) : null}
            {blockedMessage ? <Alert type="warning" showIcon message={blockedMessage} /> : null}
            {!preview.canDelete ? (
              <Alert type="info" showIcon message="当前没有可以安全移到回收站的项目" />
            ) : null}
          </Space>
        ) : null}
      </Modal>

      <Modal
        open={phase === 'running'}
        title="正在移到回收站"
        footer={
          <Button
            onClick={() => void cancelDelete()}
            disabled={!progress || progress.status !== 'running'}
          >
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
            已处理 {formatCount(progress?.processed ?? 0)} / {formatCount(progress?.total ?? 0)}{' '}
            项， 成功 {formatCount(progress?.succeeded ?? 0)} 项
            {progress && progress.foldersSucceeded > 0
              ? `（含 ${formatCount(progress.foldersSucceeded)} 个文件夹、共 ${formatCount(progress.folderFileCount)} 个文件）`
              : ''}
            {progress && progress.quarantined > 0
              ? `，其中 ${formatCount(progress.quarantined)} 个长路径文件移入软件回收区`
              : ''}
            {progress && progress.failed > 0 ? `，失败 ${formatCount(progress.failed)} 项` : ''}
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
              {foldersSucceeded > 0 ? (
                <>
                  已删除 <strong>{formatCount(foldersSucceeded)}</strong> 个文件夹（共{' '}
                  <strong>{formatCount(folderFileCount)}</strong> 个文件、
                  <strong>{formatBytes(folderBytes)}</strong>），全部在回收站可还原
                </>
              ) : null}
              {filesRecycled > 0 ? (
                <>
                  {foldersSucceeded > 0 ? '；另将 ' : '已把 '}
                  <strong>{formatCount(filesRecycled)}</strong> 个文件（
                  <strong>{formatBytes(filesRecycledBytes)}</strong>）移到回收站
                </>
              ) : null}
              {result.quarantined > 0 ? (
                <>
                  {foldersSucceeded > 0 || filesRecycled > 0 ? '；另将 ' : '已将 '}
                  <strong>{formatCount(result.quarantined)}</strong> 个长路径文件（
                  <strong>{formatBytes(result.quarantineBytes)}</strong>）移入软件回收区
                </>
              ) : null}
              {result.failed > 0 ? `；${formatCount(result.failed)} 项失败` : ''}
              {result.stopped ? '。已按你的要求停止后续项目。' : '。'}
            </Typography.Text>
            {foldersSucceeded + filesRecycled > 0 ? (
              <Alert
                type="info"
                showIcon
                message="清空回收站后才会释放磁盘空间"
                description="文件夹和文件现在仍在回收站中，可在回收站还原。"
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
                message={`${formatCount(result.failed)} 项没有删除`}
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
