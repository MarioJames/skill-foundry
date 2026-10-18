import {createStaticStyles} from 'antd-style';

export const styles = createStaticStyles(({css, cssVar, responsive}) => ({
  header: css`> div {flex-wrap: wrap;} > div > div {max-inline-size: 100%;}`,
  stack: css`display: flex; flex-direction: column; gap: 16px; min-width: 0;`,
  head: css`display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0;`,
  columns: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    min-width: 0;
    ${responsive.sm} {grid-template-columns: minmax(0, 1fr);}
  `,
  column: css`display: flex; flex-direction: column; gap: 8px; min-width: 0;`,
  columnTitle: css`
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    color: ${cssVar.colorText};
    font-size: 14px;
    font-weight: 600;
  `,
  count: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  `,
  list: css`display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; min-width: 0; list-style: none;`,
  card: css`
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    width: 100%;
    margin: 0;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    color: ${cssVar.colorText};
    font: inherit;
    text-align: start;
    cursor: pointer;
    min-width: 0;

    &:hover {background: ${cssVar.colorFillQuaternary};}
  `,
  cardTitle: css`font-size: 14px; font-weight: 600; min-width: 0; overflow-wrap: anywhere;`,
  meta: css`color: ${cssVar.colorTextSecondary}; font-size: 12px; line-height: 1.7; margin: 0; overflow-wrap: anywhere;`,
  status: css`font-size: 13px; color: ${cssVar.colorTextSecondary};`,
  surface: css`padding: 24px; min-width: 0; ${responsive.sm} {padding: 16px;}`,
}));
