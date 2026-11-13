import { Button, Descriptions, Drawer, Space, Tooltip, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, FolderOpenOutlined } from '@ant-design/icons';
import type { FileRecord } from '@shared/types';
import { COPY } from '@shared/copy';
import { fileTypeLabel } from '@shared/fileTypes';
import { formatBytes, formatCount, formatDateTime } from '@shared/format';
import { describeError, isScanActive, useAppStore } from '../store/useAppStore';

export default function FileDetailDrawer(): React.JSX.Element {
  const file: FileRecord | null = useAppStore((state) => state.detailFile);
  const close = useAppStore((state) => state.closeDetail);
  const openInExplorer = useAppStore((state) => state.openInExplorer);
  const pushNotice = useAppStore((state) => state.pushNotice);
  const requestDelete = useAppStore((state) => state.requestDelete);
  const scanning = useAppStore((state) => isScanActive(state.scanState));
  const recycleUnavailable = useAppStore(
    (state) => state.recycleStatus?.available === false,
  );

  const copyPath = async (path: string): Promise<void> => {
    try {
      await window.api.copyText(path);
      pushNotice('success', '已复制完整路径');
    } catch (error) {
      pushNotice('error', `复制失败：${describeError(error)}`);
    }
  };

  return (
    <Drawer
      open={file !== null}
      onClose={close}
      width={480}
      title={file ? file.name : '文件详情'}
      destroyOnHidden
      extra={
        file ? (
          <Space>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void copyPath(file.path)}
            >
              {COPY.copyPathAction}
            </Button>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => void openInExplorer(file.path)}
            >
              {COPY.browseAction}
            </Button>
            <Tooltip
              title={
                scanning
                  ? '扫描完成后可删除文件'
                  : recycleUnavailable
                    ? COPY.recycleBinUnavailable
                    : undefined
              }
            >
              <span>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={scanning || recycleUnavailable}
                  onClick={() => void requestDelete([file.id])}
                >
                  {COPY.deleteAction}
                </Button>
              </span>
            </Tooltip>
          </Space>
        ) : null
      }
    >
      {file ? (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="文件名">
            <span className="selectable-text">{file.name}</span>
          </Descriptions.Item>
          <Descriptions.Item label="类型">{fileTypeLabel(file.type)}</Descriptions.Item>
          <Descriptions.Item label="大小">
            <span>
              {formatBytes(file.size)}（{formatCount(file.size)} 字节）
            </span>
          </Descriptions.Item>
          <Descriptions.Item label="所在文件夹">
            <Typography.Text copyable={{ text: file.dirPath }} className="selectable-text">
              {file.dirPath}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="完整路径">
            <Typography.Text copyable={{ text: file.path }} className="selectable-text break-all">
              {file.path}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="修改时间">
            {formatDateTime(file.mtimeMs)}
          </Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {formatDateTime(file.ctimeMs)}
          </Descriptions.Item>
          <Descriptions.Item label="硬盘">{file.drive}</Descriptions.Item>
          <Descriptions.Item label="顶层文件夹">
            {file.rootDir || '（硬盘根目录）'}
          </Descriptions.Item>
        </Descriptions>
      ) : null}
    </Drawer>
  );
}
