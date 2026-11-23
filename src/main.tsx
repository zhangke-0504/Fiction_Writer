import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import type { ModelProfile } from '../shared/contracts';
import { useRuntime } from './runtime';
import { api } from './bridge';
import { Settings } from './Settings';
import { Library } from './Library';
import { Workspace, type ActiveChapter, type Drafts } from './Workspace';
import { Harness } from './Harness';
import { Icon } from './ui';
import './styles.css';
function App() {
  const [bookId, setBook] = useState<string>(),
    [open, setOpen] = useState(false),
    [settings, setSettings] = useState(false);
  const [chapter, setChapter] = useState<ActiveChapter>(),
    [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const { view, refresh, error } = useRuntime();
  const drafts = useRef<Drafts>(new Map());
  useEffect(() => {
    api.diagnostic('ui.ready', {});
    const error = () => api.diagnostic('ui.error', { reason: 'exception' });
    const rejection = () => api.diagnostic('ui.error', { reason: 'unhandled_rejection' });
    window.addEventListener('error', error);
    window.addEventListener('unhandledrejection', rejection);
    return () => {
      window.removeEventListener('error', error);
      window.removeEventListener('unhandledrejection', rejection);
    };
  }, []);
  useEffect(() => {
    api.diagnostic('ui.section', {
      section: settings ? 'settings' : bookId ? 'book' : 'library',
      workspaceRef: settings ? undefined : bookId,
    });
  }, [settings, bookId]);
  useEffect(() => {
    if (open)
      api.diagnostic('ui.section', { section: 'harness', workspaceRef: settings ? undefined : bookId });
  }, [open, settings, bookId]);
  const preview = view.sessions.find((s) => s.run?.preview?.bookId === bookId)?.run?.preview;
  const loadProfiles = () => {
    void api.request<ModelProfile[]>('profiles.list').then(setProfiles, () => {});
  };
  useEffect(() => {
    loadProfiles();
    return api.subscribe((e) => {
      if (e.type === 'profiles-change' || e.type === 'backend-reset') loadProfiles();
    });
  }, []);
  const back = () => {
    setBook(undefined);
    setSettings(false);
  };
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && (event.code === 'KeyI' || event.key.toLowerCase() === 'i')) {
        event.preventDefault();
        if (!event.repeat) setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', toggle);
    return () => window.removeEventListener('keydown', toggle);
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <button className="brand text-button" onClick={back}>
          <span className="brand-icon">
            <Icon name="logo" size={19} />
          </span>
          <strong>Fiction Writer</strong>
        </button>
        <nav aria-label="主导航">
          <button className={!settings && !bookId ? 'active' : ''} onClick={back}>
            <Icon name="book" />
            书库
          </button>
          <button className={settings ? 'active' : ''} onClick={() => setSettings(true)}>
            <Icon name="sliders" />
            设置
          </button>
        </nav>
        <div className="topbar-end">
          <button
            className={open ? 'pressed' : ''}
            title="Ctrl+Alt+I"
            aria-pressed={open}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="chat" />
            Harness
          </button>
        </div>
      </header>
      <div className={`desktop-grid ${open ? 'with-harness' : ''}`}>
        <main>
          {settings ? (
            <Settings profiles={profiles} refresh={loadProfiles} />
          ) : bookId ? (
            <Workspace
              key={bookId}
              bookId={bookId}
              refresh={refresh}
              preview={preview}
              back={back}
              drafts={drafts.current}
              onChapter={setChapter}
            />
          ) : (
            <Library refresh={refresh} open={setBook} />
          )}
        </main>
        <Harness
          open={open}
          close={() => setOpen(false)}
          view={view}
          bookId={settings ? undefined : bookId}
          chapter={chapter}
          profiles={profiles}
          settings={() => setSettings(true)}
          backendError={error}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!, {
  onCaughtError: () => api.diagnostic('ui.error', { reason: 'react_error' }),
  onUncaughtError: () => api.diagnostic('ui.error', { reason: 'react_error' }),
  onRecoverableError: () => api.diagnostic('ui.error', { reason: 'react_error' }),
}).render(<App />);
