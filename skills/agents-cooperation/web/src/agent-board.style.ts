import {createStaticStyles} from 'antd-style';

export const styles = createStaticStyles(({css, cssVar, responsive}) => ({
  header: css`> div {flex-wrap: wrap;} > div > div {max-inline-size: 100%;}`,
  stack: css`display: flex; flex-direction: column; gap: 16px; min-width: 0;`,
  surface: css`padding: 24px; min-width: 0; ${responsive.sm} {padding: 16px;}`,
  head: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0;`,
  heading: css`font-size: 16px; font-weight: 600; margin: 0; min-width: 0; overflow-wrap: anywhere;`,
  ownerTitle: css`font-size: 14px; font-weight: 600; margin: 0; min-width: 0; overflow-wrap: anywhere;`,
  workerTitle: css`font-size: 13px; font-weight: 600; margin: 0; min-width: 0; overflow-wrap: anywhere;`,
  meta: css`color: ${cssVar.colorTextSecondary}; font-size: 12px; line-height: 1.7; margin: 4px 0 0; overflow-wrap: anywhere;`,
  owner: css`margin-top: 16px; padding-top: 12px; border-top: 1px solid ${cssVar.colorBorderSecondary}; min-width: 0;`,
  worker: css`margin-top: 12px; margin-inline-start: 12px; padding-inline-start: 12px; border-inline-start: 2px solid ${cssVar.colorBorderSecondary}; min-width: 0;`,
  error: css`color: ${cssVar.colorErrorText}; font-size: 13px; margin: 8px 0 0; overflow-wrap: anywhere;`,
  note: css`color: ${cssVar.colorText}; font-size: 13px; margin: 8px 0 0; overflow-wrap: anywhere;`,
  status: css`font-size: 13px; color: ${cssVar.colorTextSecondary};`,
  history: css`min-width: 0;`,
  summary: css`cursor: pointer; font-size: 14px; font-weight: 600; color: ${cssVar.colorText};`,
  historyBody: css`display: flex; flex-direction: column; gap: 16px; margin-top: 12px; min-width: 0;`,
}));
