import React from 'react';
import {createRoot} from 'react-dom/client';
import {ConfigProvider, ThemeProvider} from '@lobehub/ui';
import {zhCn} from '@lobehub/ui/i18n';
import {motion} from 'motion/react';
import App from './App';

function Root() {
  const [appearance, setAppearance] = React.useState<'light'|'dark'>('light');
  return <ConfigProvider locale="zh-CN" motion={motion} resources={zhCn}>
    <ThemeProvider appearance={appearance} enableCustomFonts={false} enableGlobalStyle>
      <App appearance={appearance} onAppearanceChange={() => setAppearance(value => value === 'light' ? 'dark' : 'light')} />
    </ThemeProvider>
  </ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Root />);
