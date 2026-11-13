import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少根节点');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 8,
          fontFamily:
            '"Microsoft YaHei UI", "Microsoft YaHei", -apple-system, "Segoe UI", sans-serif',
        },
      }}
    >
      <AntApp message={{ maxCount: 3 }}>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
