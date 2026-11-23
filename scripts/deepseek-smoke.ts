import { readFile } from 'node:fs/promises';
import { checkProvider } from '../electron/agent/provider.js';

if (!process.argv.includes('--live')) {
  console.error(
    'Pass --live to explicitly enable three small test requests to the official DeepSeek API.',
  );
  process.exitCode = 2;
} else {
  try {
    const contents = await readFile(new URL('../design/ds_config.txt', import.meta.url), 'utf8');
    const matches = [...contents.matchAll(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g)];
    if (matches.length !== 1)
      throw new Error('Expected one DeepSeek API Key in the ignore-listed local config.');
    const key = matches[0][0];
    const result = await checkProvider(
      {
        id: 'smoke',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        protocol: 'chat',
      },
      key,
      AbortSignal.timeout(57_000),
    );
    console.log(JSON.stringify({ model: 'deepseek-v4-flash', ...result }));
    if (!result.tools) process.exitCode = 1;
  } catch {
    console.error(
      'DeepSeek smoke test could not read the local configuration or complete the request. No credentials were printed.',
    );
    process.exitCode = 1;
  }
}
