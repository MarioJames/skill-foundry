import {createStaticStyles} from 'antd-style';

export const styles = createStaticStyles(({css, cssVar}) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
  `,
  meta: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    line-height: 1.7;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  `,
  disclosure: css`min-width: 0;`,
  summary: css`
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  disclosureBody: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
    min-width: 0;
  `,
  heading: css`
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  person: css`
    min-width: 0;
    padding-top: 12px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
  `,
  worker: css`
    min-width: 0;
    margin-top: 8px;
    margin-inline-start: 12px;
    padding-inline-start: 12px;
    border-inline-start: 2px solid ${cssVar.colorBorderSecondary};
  `,
  name: css`
    margin: 0;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  `,
  line: css`
    margin: 4px 0 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  `,
  error: css`
    margin: 4px 0 0;
    color: ${cssVar.colorErrorText};
    font-size: 13px;
    overflow-wrap: anywhere;
  `,
  note: css`
    margin: 0;
    color: ${cssVar.colorText};
    font-size: 13px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  `,
  timeline: css`
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    min-width: 0;
    list-style: none;
  `,
  event: css`
    position: relative;
    min-width: 0;
    padding: 0 0 16px 16px;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};

    &::before {
      content: '';
      position: absolute;
      inset-inline-start: -4px;
      inset-block-start: 6px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: ${cssVar.colorPrimary};
    }

    &:last-child {
      padding-bottom: 0;
      border-inline-start-color: transparent;
    }
  `,
  when: css`
    display: block;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    line-height: 1.6;
  `,
  actor: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
    margin-top: 2px;
  `,
  title: css`
    margin: 2px 0 0;
    color: ${cssVar.colorText};
    font-size: 14px;
    font-weight: 600;
    overflow-wrap: anywhere;
  `,
  detail: css`
    margin: 4px 0 0;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  `,
}));
