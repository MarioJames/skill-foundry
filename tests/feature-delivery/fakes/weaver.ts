// 测试用 weaver 替身：记录参数；退出码由 FAKE_WEAVER_EXIT 控制。
import { appendFileSync } from 'node:fs';

appendFileSync(process.env.FAKE_WEAVER_LOG!, JSON.stringify(process.argv.slice(2)) + '\n');
if (Number(process.env.FAKE_WEAVER_EXIT ?? '0') !== 0) {
  console.error('fake weaver: artifact add failed');
  process.exit(Number(process.env.FAKE_WEAVER_EXIT));
}
console.log(JSON.stringify({ ok: true }));
