import { DiagnosticFailure } from '../diagnostics/trace.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelProfile, Protocol } from '../../shared/contracts.js';
import {
  canDiscover,
  discoverCapabilities,
  fallbackCapabilities,
  isOfficialDeepSeek,
  savedCapabilities,
} from './provider-capabilities.js';

type Settings = Omit<ModelProfile, 'id' | 'capabilities'> & { id?: string; cipher?: string };
type Stored = ModelProfile & { cipher: string };
export function baseAddress(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 API 请求地址');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('API 请求地址必须是无凭据、查询或片段的 HTTP(S) 基地址');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
function view({ cipher: _, ...stored }: Stored): ModelProfile {
  const providerId = stored.providerId ?? (isOfficialDeepSeek(stored) ? 'deepseek' : 'custom');
  const profile = { ...stored, providerId };
  return { ...profile, capabilities: savedCapabilities(profile) };
}

export class ProfileStore {
  private stored: Stored[] = [];
  private chain = Promise.resolve();
  private path: string;
  constructor(
    private folder: string,
    private decrypt: (cipher: string, requestId?: string) => Promise<string>,
    private discover = discoverCapabilities,
  ) {
    this.path = join(folder, 'profiles.json');
  }
  async init() {
    await mkdir(this.folder, { recursive: true });
    try {
      const items: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        !Array.isArray(items) ||
        items.some(
          (item) =>
            !item ||
            typeof item.id !== 'string' ||
            typeof item.name !== 'string' ||
            typeof item.model !== 'string' ||
            typeof item.baseUrl !== 'string' ||
            typeof item.cipher !== 'string' ||
            (item.providerId !== undefined && !['deepseek', 'custom'].includes(item.providerId)) ||
            !['chat', 'responses', 'messages'].includes(item.protocol),
        )
      )
        throw new Error();
      this.stored = items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('模型配置文件无法读取');
    }
  }
  list() {
    return this.stored.map(view);
  }
  async resolve(id: string, requestId?: string) {
    const record = this.stored.find((profile) => profile.id === id);
    if (!record) throw new DiagnosticFailure('profile_missing', '请先选择一个已保存的模型配置');
    return { profile: view(record), key: await this.decrypt(record.cipher, requestId) };
  }
  save(input: Settings, requestId?: string): Promise<ModelProfile> {
    const next = this.chain.then(async () => {
      const prior = this.stored.find((profile) => profile.id === input.id),
        name = input.name?.trim(),
        model = input.model?.trim();
      if (!name || name.length > 100 || !model || model.length > 200)
        throw new Error('请填写有效的配置名称和模型 ID');
      const protocol = input.protocol;
      if (!(['chat', 'responses', 'messages'] satisfies Protocol[]).includes(protocol))
        throw new Error('请选择 API 协议');
      if (input.id && !prior) throw new Error('模型配置已不存在');
      const cipher = input.cipher || prior?.cipher;
      if (!cipher) throw new Error('请输入 API Key');
      const providerId = input.providerId ?? (prior ? view(prior).providerId : 'custom');
      if (providerId !== 'custom' && providerId !== 'deepseek') throw new Error('请选择有效的供应商');
      const profile: ModelProfile = {
        id: prior?.id ?? randomUUID(),
        name,
        model,
        baseUrl: baseAddress(input.baseUrl),
        protocol,
        providerId,
      };
      if (canDiscover(profile)) {
        if (!input.cipher && prior && new URL(prior.baseUrl).origin !== new URL(profile.baseUrl).origin)
          throw new Error('请求地址已切换到不同来源，请重新填写 API Key');
        const key = await this.decrypt(cipher, requestId);
        profile.capabilities = await this.discover(profile, key);
      } else {
        profile.capabilities = fallbackCapabilities(profile);
      }
      const records = [...this.stored.filter((row) => row.id !== profile.id), { ...profile, cipher }];
      const temp = this.path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(records, null, 2), { encoding: 'utf8', flag: 'wx' });
        await rename(temp, this.path);
      } finally {
        await unlink(temp).catch(() => undefined);
      }
      this.stored = records;
      return profile;
    });
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}
