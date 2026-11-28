import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import type { ModelProfile } from '../shared/contracts';
import { useRuntime } from './runtime';
import { api } from './bridge';
import { Settings } from './Settings';
import { Library, type LibraryPosition } from './Library';
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
  const [libraryPosition, setLibraryPosition] = useState<LibraryPosition>({
    query: '',
    start: 0,
    pageSize: 1,
  });
  const editorBook = settings ? undefined : bookId;
  const { view, ready, refresh, error } = useRuntime(editorBook);
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
    if (open && editorBook)
      api.diagnostic('ui.section', { section: 'harness', workspaceRef: editorBook });
  }, [open, editorBook]);
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
    setOpen(false);
    setBook(undefined);
    setSettings(false);
  };
  const showSettings = () => {
    setOpen(false);
    setSettings(true);
  };
  useEffect(() => {
    if (!editorBook) return;
    const toggle = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && (event.code === 'KeyI' || event.key.toLowerCase() === 'i')) {
        event.preventDefault();
        if (!event.repeat) setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', toggle);
    return () => window.removeEventListener('keydown', toggle);
  }, [editorBook]);
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
          <button className={settings ? 'active' : ''} onClick={showSettings}>
            <Icon name="sliders" />
            设置
          </button>
        </nav>
        <div className="topbar-end">
          {editorBook && (
            <button
              className={open ? 'pressed' : ''}
              title="Ctrl+Alt+I"
              aria-pressed={open}
              onClick={() => setOpen((value) => !value)}
            >
              <Icon name="chat" />
              AI
            </button>
          )}
        </div>
      </header>
      <div className={`desktop-grid ${open && editorBook ? 'with-harness' : ''}`}>
        <main
          className={settings ? 'scroll-region' : undefined}
          aria-label={settings ? '设置内容' : undefined}
          tabIndex={settings ? 0 : undefined}
        >
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
            <Library
              refresh={refresh}
              position={libraryPosition}
              setPosition={setLibraryPosition}
              open={(id) => {
                setOpen(false);
                setBook(id);
              }}
            />
          )}
        </main>
        {editorBook && (
          <Harness
            key={editorBook}
            open={open}
            close={() => setOpen(false)}
            view={view}
            ready={ready}
            bookId={editorBook}
            chapter={chapter}
            profiles={profiles}
            settings={showSettings}
            backendError={error}
          />
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!, {
  onCaughtError: () => api.diagnostic('ui.error', { reason: 'react_error' }),
  onUncaughtError: () => api.diagnostic('ui.error', { reason: 'react_error' }),
  onRecoverableError: () => api.diagnostic('ui.error', { reason: 'react_error' }),
}).render(<App />);
