import { useState, type FormEvent } from 'react';
import type { ModelProfile } from '../shared/contracts';
import { api } from './bridge';
import { ErrorText, Icon, errorMessage } from './ui';
export const protocols = {
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  messages: 'Anthropic Messages',
};
type CheckResult = { connection: boolean; tools: boolean; issue?: string };
export function Settings({ profiles, refresh }: { profiles: ModelProfile[]; refresh: () => void }) {
  const [active, setActive] = useState<string | null>(profiles[0]?.id ?? null),
    [status, setStatus] = useState('');
  const [error, setError] = useState(''),
    [result, setResult] = useState<CheckResult>(),
    [checking, setChecking] = useState(false),
    [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(false);
  const profile = profiles.find((p) => p.id === active);
  function select(id: string | null) {
    setActive(id);
    setStatus('');
    setError('');
    setResult(undefined);
    setReveal(false);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values = new FormData(e.currentTarget);
    setSaving(true);
    setError('');
    setStatus('');
    setResult(undefined);
    try {
      const saved = await api.request<ModelProfile>('profiles.save', {
        ...Object.fromEntries(values),
        id: profile?.id,
      });
      select(saved.id);
      setStatus('配置已保存');
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function check() {
    if (!profile) return;
    setChecking(true);
    setError('');
    setResult(undefined);
    try {
      setResult(await api.request<CheckResult>('profiles.check', { id: profile.id }));
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
        <button className="primary" disabled={checking || saving} onClick={() => select(null)}>
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
              className={`nav-item ${active === p.id ? 'selected' : ''}`}
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
          <h2>{profile ? profile.name : '新建模型配置'}</h2>
          <form className="form-grid" key={profile?.id ?? 'new'} onSubmit={submit}>
            <label>
              名称 <span className="required">*</span>
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={profile?.name}
                placeholder="例如：DeepSeek"
              />
            </label>
            <label>
              模型 ID <span className="required">*</span>
              <input
                name="model"
                required
                maxLength={200}
                defaultValue={profile?.model}
                placeholder="使用供应商提供的 ID"
              />
            </label>
            <div className="wide">
              <label>
                API Key {profile ? null : <span className="required">*</span>}
                <div className="key-field">
                  <input
                    aria-label="API Key"
                    name="apiKey"
                    type={reveal ? 'text' : 'password'}
                    required={!profile}
                    autoComplete="off"
                    maxLength={8192}
                    placeholder={profile ? '留空保留已保存的 Key' : '输入供应商 API Key'}
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
                defaultValue={profile?.baseUrl}
                placeholder="https://api.example.com/v1"
              />
              <small>填写基地址；会按协议追加请求路径，不要包含具体操作名。</small>
            </label>
            <details className="wide advanced">
              <summary>高级选项</summary>
              <label>
                上游协议
                <select name="protocol" defaultValue={profile?.protocol ?? 'chat'}>
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
              <button
                type="button"
                disabled={!profile || checking || saving}
                onClick={() => void check()}
              >
                {checking ? '正在测试…' : '测试连接与工具'}
              </button>
              <button className="primary" disabled={checking || saving}>
                <Icon name="check" size={15} />
                保存配置
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
