import { useState, type FormEvent } from 'react';
import type { ModelProfile, Protocol, ProviderId } from '../shared/contracts';
import { api } from './bridge';
import { ErrorText, Icon, errorMessage } from './ui';
export const protocols = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  messages: 'Anthropic Messages',
};
const presets: { id: ProviderId; name: string; baseUrl: string; protocol: Protocol }[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    protocol: 'messages',
  },
];
const tokenNumber = new Intl.NumberFormat('zh-CN');

type CheckResult = { connection: boolean; tools: boolean; issue?: string };
export function Settings({ profiles, refresh }: { profiles: ModelProfile[]; refresh: () => void }) {
  const [active, setActive] = useState<string | null>(profiles[0]?.id ?? null),
    [status, setStatus] = useState('');
  const [error, setError] = useState(''),
    [result, setResult] = useState<CheckResult>(),
    [checking, setChecking] = useState(false),
    [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [adding, setAdding] = useState<'pick' | ProviderId>();
  const [justSaved, setJustSaved] = useState<ModelProfile>();
  const [formRevision, setFormRevision] = useState(0);
  const selected = justSaved ?? profiles.find((p) => p.id === active) ?? profiles[0];
  const current = adding ?? (selected ? undefined : 'pick');
  const edited = current ? undefined : selected;
  const preset = presets.find((entry) => entry.id === current);
  const capabilities = edited?.capabilities;
  const disabled = checking || saving;
  function select(id: string | null, next?: 'pick' | ProviderId) {
    setActive(id);
    setAdding(next);
    setJustSaved(undefined);
    setStatus('');
    setError('');
    setResult(undefined);
    setReveal(false);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    const values = new FormData(e.currentTarget);
    setSaving(true);
    setError('');
    setStatus('');
    setResult(undefined);
    try {
      const saved = await api.request<ModelProfile>('profiles.save', {
        ...Object.fromEntries(values),
        id: edited?.id,
        providerId: edited?.providerId ?? preset?.id ?? 'custom',
      });
      select(saved.id);
      setJustSaved(saved);
      setFormRevision((revision) => revision + 1);
      setStatus('配置已保存');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function check() {
    if (!edited || disabled) return;
    setChecking(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await api.request<CheckResult>('profiles.check', { id: edited.id }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="settings-page page-container">
      <div className="page-heading">
        <div>
          <p className="eyebrow">FICTION WRITER / 设置</p>
          <h1>模型配置</h1>
          <p className="muted">连接你常用的模型，在 Harness 中随时切换。</p>
        </div>
        <button className="primary" disabled={checking || saving} onClick={() => select(null, 'pick')}>
          <Icon name="plus" />
          新建配置
        </button>
      </div>
      <div className="settings-layout surface">
        <aside aria-label="供应商配置" className="settings-nav">
          <p className="eyebrow">已保存配置</p>
          {profiles.map((p) => (
            <button
              key={p.id}
              disabled={checking || saving}
              className={`nav-item ${edited?.id === p.id ? 'selected' : ''}`}
              onClick={() => select(p.id)}
            >
              <span className="profile-icon">{Array.from(p.name)[0]?.toUpperCase()}</span>
              <span>
                <strong>{p.name}</strong>
                <small>{p.model}</small>
              </span>
            </button>
          ))}
          {!profiles.length && <p className="empty-mini">还没有模型配置</p>}
        </aside>
        <div className="settings-body">
          {current === 'pick' ? (
            <section aria-labelledby="provider-picker-heading">
              <h2 id="provider-picker-heading">选择供应商</h2>
              <button type="button" className="provider-choice" onClick={() => select(null, 'custom')}>
                <span className="profile-icon">
                  <Icon name="sliders" />
                </span>
                <span>
                  <strong>自定义配置</strong>
                  <small>手动填写请求地址和 API Key</small>
                </span>
                <Icon name="right" />
              </button>
              <h3 className="eyebrow provider-heading">模型厂商</h3>
              {presets.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="provider-choice"
                  onClick={() => select(null, entry.id)}
                >
                  <span className="profile-icon" aria-hidden="true">
                    {entry.name[0]}
                  </span>
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{new URL(entry.baseUrl).hostname}</small>
                  </span>
                  <Icon name="right" />
                </button>
              ))}
            </section>
          ) : (
            <>
              {current && (
                <button
                  type="button"
                  className="text-button provider-back"
                  disabled={disabled}
                  onClick={() => select(null, 'pick')}
                >
                  <Icon name="back" /> 返回供应商列表
                </button>
              )}
              <h2>{edited?.name ?? (preset ? `新建 ${preset.name} 配置` : '新建模型配置')}</h2>
              {capabilities && (
                <div className="profile-capabilities" aria-label="模型额度">
                  <span>
                    上下文窗口 <strong>{tokenNumber.format(capabilities.contextWindow)}</strong>
                  </span>
                  <span>
                    单次最大输出 <strong>{tokenNumber.format(capabilities.maxOutputTokens)}</strong>
                  </span>
                  <small>
                    {capabilities.source === 'provider'
                      ? '来源：供应商声明'
                      : capabilities.source === 'provider-fallback'
                        ? '额度未识别，使用 DeepSeek 兜底值'
                        : '额度未识别，使用通用兜底值'}
                  </small>
                </div>
              )}
              <form
                className="form-grid"
                key={`${edited?.id ?? current}:${formRevision}`}
                onSubmit={submit}
              >
                <label>
                  名称 <span className="required">*</span>
                  <input
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={edited?.name ?? preset?.name}
                    placeholder="例如：DeepSeek"
                  />
                </label>
                <label>
                  模型 ID <span className="required">*</span>
                  <input
                    name="model"
                    required
                    maxLength={200}
                    defaultValue={edited?.model}
                    placeholder="使用供应商提供的 ID"
                  />
                </label>
                <div className="wide">
                  <label>
                    API Key {edited ? null : <span className="required">*</span>}
                    <div className="key-field">
                      <input
                        aria-label="API Key"
                        name="apiKey"
                        type={reveal ? 'text' : 'password'}
                        required={!edited}
                        autoComplete="off"
                        maxLength={8192}
                        placeholder={edited ? '留空保留已保存的 Key' : '输入供应商 API Key'}
                      />
                      <button type="button" className="text-button" onClick={() => setReveal(!reveal)}>
                        {reveal ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </label>
                </div>
                <label className="wide">
                  API 请求地址 <span className="required">*</span>
                  <input
                    type="url"
                    name="baseUrl"
                    required
                    defaultValue={edited?.baseUrl ?? preset?.baseUrl}
                    placeholder="https://api.example.com/v1"
                  />
                  <small>填写基地址；会按协议追加请求路径，不要包含具体操作名。</small>
                </label>
                <details className="wide advanced">
                  <summary>高级选项</summary>
                  <label>
                    上游协议
                    <select
                      name="protocol"
                      defaultValue={edited?.protocol ?? preset?.protocol ?? 'chat'}
                    >
                      {Object.entries(protocols).map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
                <div className="wide">
                  <ErrorText text={error} />
                  {status && (
                    <p className="saved" role="status">
                      <Icon name="check" size={15} />
                      {status}
                    </p>
                  )}
                  {result && (
                    <p className={result.tools ? 'saved' : 'notice'} role="status">
                      {result.connection ? '已连接' : '连接未通过'} ·{' '}
                      {result.tools ? '流式工具往返通过' : '工具往返未通过'}
                      {result.issue ? ` · ${result.issue}` : ''}
                    </p>
                  )}
                </div>
                <div className="wide dialog-actions">
                  <button type="button" disabled={!edited || disabled} onClick={() => void check()}>
                    {checking ? '正在测试…' : '测试连接与工具'}
                  </button>
                  <button className="primary" disabled={checking || saving}>
                    <Icon name="check" size={15} />
                    {saving ? '正在保存配置…' : '保存配置'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
