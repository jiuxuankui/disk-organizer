import type { ReactNode } from 'react';
import { Typography } from 'antd';

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  extra?: ReactNode;
}

export default function PageHeader({ title, subtitle, extra }: PageHeaderProps): React.JSX.Element {
  return (
    <div className="page-header">
      <div className="page-header-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {subtitle ? <div className="page-header-subtitle">{subtitle}</div> : null}
      </div>
      {extra ? <div className="page-header-extra">{extra}</div> : null}
    </div>
  );
}
