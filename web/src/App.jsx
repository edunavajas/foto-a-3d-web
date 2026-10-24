import { useCallback, useEffect, useState } from 'react';
import Toast from './components/ui/toast/toast';
import LoginView from './components/LoginView.jsx';
import MainView from './components/MainView.jsx';

/** Fixed toast area at the bottom edge; each uiarc Toast manages its own exit. */
function Toaster({ toasts, onDismiss }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map(toast => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast
            title={toast.title}
            description={toast.description}
            open
            onOpenChange={open => { if (!open) onDismiss(toast.id); }}
          />
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState(null); // null = probing, 'login' or 'main'
  const [toasts, setToasts] = useState([]);

  // The static shell is public; 401 on a protected endpoint means show login.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/jobs/none')
      .then(response => { if (!cancelled) setView(response.status === 401 ? 'login' : 'main'); })
      .catch(() => { if (!cancelled) setView('login'); });
    return () => { cancelled = true; };
  }, []);

  const notify = useCallback((title, description) => {
    const id = crypto.randomUUID();
    setToasts(current => [...current.slice(-2), { id, title, description }]);
  }, []);

  const dismiss = useCallback(id => {
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      setView('login');
    }
  }

  if (view === null) {
    return <main className="flex min-h-dvh items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>Cargando…</main>;
  }

  return (
    <>
      {view === 'login'
        ? <LoginView onSuccess={() => setView('main')} />
        : (
          <MainView
            onLogout={logout}
            onExpired={() => setView('login')}
            notify={notify}
          />
        )}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
