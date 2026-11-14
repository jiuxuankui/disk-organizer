import React from 'react';
import ReactDOM from 'react-dom/client';
import ThemeRoot from './components/ThemeRoot';
import './styles/tokens.css';
import './styles/global.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少根节点');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ThemeRoot />
  </React.StrictMode>,
);
