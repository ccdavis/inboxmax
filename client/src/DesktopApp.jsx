// The desktop app (Tauri): a single local profile, so it opens straight
// into the inbox with no landing page, sign-in, or routing.
import { useEffect, useState } from 'react';
import * as api from './api';
import InboxPage from './components/InboxPage';
import Spinner from './components/Spinner';

export default function DesktopApp() {
  const [app, setApp] = useState(null);

  useEffect(() => {
    api.getSession()
      .then((session) => setApp(session.app))
      .catch(() => setApp({ can_save_passwords: false }));
  }, []);

  if (!app) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-canvas-subtle">
        <Spinner label="Starting Inbox Max" />
      </div>
    );
  }
  return <InboxPage canSavePasswords={app.can_save_passwords} />;
}
